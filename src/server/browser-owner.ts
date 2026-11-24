import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The owner lives across MCP reconnects, but never across its Loom parent's death. */
export interface BrowserOwner {
  readonly pid: number;
  readonly wsEndpoint: string;
  readonly exited: Promise<void>;
  close(): Promise<void>;
}
export interface BrowserOwnerOptions {
  profileDir: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onExit(): void;
  /** Register cleanup ownership before startup can fail or be cancelled. */
  onOwnership?: (owner: Pick<BrowserOwner, 'close' | 'exited'>) => void;
}
export type BrowserOwnerFactory = (options: BrowserOwnerOptions) => Promise<BrowserOwner>;

export function isOwnedBrowserEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string') return false;
  try {
    const value = new URL(endpoint);
    return (
      value.protocol === 'ws:' &&
      value.hostname === '127.0.0.1' &&
      Number(value.port) > 0 &&
      !value.username &&
      !value.password &&
      !value.search &&
      !value.hash &&
      /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(value.pathname)
    );
  } catch {
    return false;
  }
}

export async function withinBrowserLifetime<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Fixed helper, private IPC, exact child-reported endpoint; no port/PID discovery. */
export async function startBrowserOwner(
  options: BrowserOwnerOptions,
  dependencies: {
    spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
    isProcessAlive?: (pid: number) => boolean;
    startupTimeoutMs?: number;
    closeTimeoutMs?: number;
  } = {},
): Promise<BrowserOwner> {
  options.signal.throwIfAborted();
  const require = createRequire(import.meta.url);
  const source = import.meta.url.endsWith('.ts');
  const entrypoint = fileURLToPath(
    new URL(
      source ? './browser-owner-launcher.ts' : './browser-owner-launcher.js',
      import.meta.url,
    ),
  );
  const child: ChildProcess = (dependencies.spawn ?? spawn)(
    process.execPath,
    [...(source ? ['--import', pathToFileURL(require.resolve('tsx')).href] : []), entrypoint],
    {
      env: { ...options.env, LOOM_BROWSER_OWNER_PROFILE: options.profileDir },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      shell: false,
      windowsHide: true,
    },
  );
  let published = false;
  let ended = false;
  let resolveOwnerExited!: () => void;
  const ownerExited = new Promise<void>((resolve) => (resolveOwnerExited = resolve));
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => (resolveExited = resolve));
  let chromeEnded = false;
  const childPids = new Set<number>();
  const confirmEnded = () => {
    if (chromeEnded) return true;
    if (!ended || !childPids.size) return false;
    for (const pid of childPids) {
      try {
        if (
          dependencies.isProcessAlive
            ? dependencies.isProcessAlive(pid)
            : (process.kill(pid, 0), true)
        )
          return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
      }
    }
    chromeEnded = true;
    resolveExited();
    return true;
  };
  let rejectReady!: (error: Error) => void;
  let resolveReady!: (value: { pid: number; wsEndpoint: string }) => void;
  const ready = new Promise<{ pid: number; wsEndpoint: string }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const end = () => {
    if (ended) return;
    ended = true;
    resolveOwnerExited();
    confirmEnded();
    rejectReady(new Error('The dedicated Chrome owner exited before connection was ready.'));
    if (published) options.onExit();
  };
  child.once('exit', end);
  child.once('error', () => {
    rejectReady(new Error('Could not start the dedicated Chrome owner.'));
    if (!child.pid) end();
  });
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const value = message as Record<string, unknown>;
    if (value.type === 'spawned' && Number.isSafeInteger(value.pid) && (value.pid as number) > 0)
      childPids.add(value.pid as number);
    if (value.type === 'closed') {
      chromeEnded = true;
      resolveExited();
    }
    if (
      value.type === 'ready' &&
      Number.isSafeInteger(value.pid) &&
      (value.pid as number) > 0 &&
      isOwnedBrowserEndpoint(value.wsEndpoint)
    ) {
      childPids.add(value.pid as number);
      resolveReady({ pid: value.pid as number, wsEndpoint: value.wsEndpoint });
    } else if (value.type === 'error' && typeof value.message === 'string')
      rejectReady(new Error(value.message.slice(0, 1000)));
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    if (ended && confirmEnded()) return Promise.resolve();
    return (closing ??= (async () => {
      if (!ended && child.connected) child.send({ type: 'close' }, () => {});
      // Do not kill the guardian: it alone owns the exact Chrome child and must
      // finish graceful/forced shutdown before its exit proves profile release.
      await withinBrowserLifetime(
        ownerExited,
        dependencies.closeTimeoutMs ?? 10_000,
        'Chrome has not confirmed its exit. Its profile and upload files remain in use.',
      );
      if (!confirmEnded())
        throw new Error(
          'The Chrome owner stopped without confirming Chrome exit. Its profile and upload files remain in use.',
        );
    })());
  };
  const aborted = () => {
    rejectReady(new Error('Chrome startup was cancelled.'));
    void close().catch(() => {});
  };
  options.signal.addEventListener('abort', aborted, { once: true });
  if (options.signal.aborted) aborted();
  try {
    options.onOwnership?.({ close, exited });
    const value = await withinBrowserLifetime(
      ready,
      dependencies.startupTimeoutMs ?? 30_000,
      'Starting dedicated Chrome timed out.',
    );
    options.signal.throwIfAborted();
    if (ended) throw new Error('Dedicated Chrome exited during startup.');
    published = true;
    return { ...value, exited, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    options.signal.removeEventListener('abort', aborted);
  }
}
