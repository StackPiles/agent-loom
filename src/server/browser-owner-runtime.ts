import {
  dedicatedBrowserErrorMessage,
  startDedicatedChrome,
  type OwnedChromeProcess,
} from './browser-process.js';

type OwnerHost = {
  readonly connected: boolean;
  on(event: string, callback: (...args: unknown[]) => void): unknown;
  once(event: string, callback: (...args: unknown[]) => void): unknown;
  send(message: object): unknown;
  exit(code: number): unknown;
};

/** Separate from the executable so parent-loss/startup races are testable. */
export async function runBrowserOwner(options: {
  profileDir: string;
  env: NodeJS.ProcessEnv;
  host: OwnerHost;
  startChrome?: typeof startDedicatedChrome;
}): Promise<void> {
  const { host } = options;
  const lifetime = new AbortController();
  let owned: Awaited<ReturnType<typeof startDedicatedChrome>> | undefined;
  let child: OwnedChromeProcess | undefined;
  let starting: Promise<Awaited<ReturnType<typeof startDedicatedChrome>>> | undefined;
  let shuttingDown: Promise<void> | undefined;
  function shutdown(code: number): Promise<void> {
    if (shuttingDown) return shuttingDown;
    lifetime.abort();
    shuttingDown = (async () => {
      try {
        await starting?.catch(() => {});
        await owned?.close();
        if (child && child.exitCode === null && child.signalCode === null && !owned)
          throw new Error('Chrome startup ended without a confirmed exit.');
        if (host.connected) await host.send({ type: 'closed' });
        host.exit(code);
      } catch {
        // Never claim exit while Chrome is unconfirmed. Keeping the owner alive
        // also keeps its exact ChildProcess handle; no later PID discovery.
        if (owned) await owned.exited;
        else if (child && child.exitCode === null && child.signalCode === null)
          await new Promise<void>((resolve) => child!.once('exit', resolve));
        if (host.connected) await Promise.resolve(host.send({ type: 'closed' })).catch(() => {});
        host.exit(1);
      }
    })();
    return shuttingDown;
  }
  host.on('disconnect', () => void shutdown(0));
  host.on('message', (message) => {
    if (message && typeof message === 'object' && (message as { type?: string }).type === 'close')
      void shutdown(0);
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) host.on(signal, () => void shutdown(0));
  host.once('exit', () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* Only our exact child is touched. */
      }
    }
  });
  starting = (options.startChrome ?? startDedicatedChrome)({
    profileDir: options.profileDir,
    env: options.env,
    signal: lifetime.signal,
    onSpawn: (spawned) => {
      child = spawned;
      if (host.connected)
        void Promise.resolve(host.send({ type: 'spawned', pid: spawned.pid })).catch(() =>
          shutdown(1),
        );
    },
    onExit: () => void shutdown(1),
  });
  try {
    owned = await starting;
    lifetime.signal.throwIfAborted();
    await host.send({ type: 'ready', pid: owned.process.pid, wsEndpoint: owned.wsEndpoint });
  } catch (error) {
    if (host.connected)
      await Promise.resolve(
        host.send({ type: 'error', message: dedicatedBrowserErrorMessage(error) }),
      ).catch(() => {});
    await shutdown(1);
  }
}
