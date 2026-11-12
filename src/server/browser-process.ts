import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type OwnedChromeProcess = Pick<
  ChildProcess,
  'pid' | 'exitCode' | 'signalCode' | 'stderr' | 'once' | 'on' | 'off' | 'kill'
>;
type ChromeSession = {
  send(method: string, params?: object, options?: { timeout: number }): Promise<unknown>;
  detach(): Promise<void>;
};
export type ChromeControlConnection = {
  target(): { createCDPSession(): Promise<ChromeSession> };
  close(): Promise<void>;
  disconnect(): Promise<void>;
};
export interface DedicatedChrome {
  process: OwnedChromeProcess;
  wsEndpoint: string;
  /** Resolves only when the child exits, including a failed spawn. */
  exited: Promise<void>;
  /** A failed close never authorizes profile reuse or upload-file deletion. */
  close(): Promise<void>;
}
export type DedicatedChromeProcess = DedicatedChrome;
export interface DedicatedChromeOptions {
  profileDir: string;
  /** The same narrow desktop/locale environment used for the MCP process. */
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onExit?: () => void;
}

/** Injectable OS boundaries allow deterministic lifecycle tests without a desktop. */
export interface DedicatedChromeDependencies {
  executablePath(): Promise<string>;
  reservePort(): Promise<number>;
  spawn(executable: string, args: string[], options: SpawnOptions): OwnedChromeProcess;
  connect(endpoint: string): Promise<ChromeControlConnection>;
  startupTimeoutMs: number;
  closeTimeoutMs: number;
}

class DedicatedChromeError extends Error {}

/** Only our fixed diagnostics may cross the private process boundary. */
export function dedicatedBrowserErrorMessage(error: unknown): string {
  return error instanceof DedicatedChromeError
    ? error.message
    : 'Could not start dedicated Chrome. Check that stable Chrome is installed and Loom is running in a desktop session.';
}

const activeProfiles = new Map<string, symbol>();
let puppeteerPromise:
  | Promise<{
      executablePath(channel: string): Promise<string>;
      connect(options: object): Promise<ChromeControlConnection>;
    }>
  | undefined;

function installedPuppeteer() {
  return (puppeteerPromise ??= (async () => {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve('chrome-devtools-mcp/package.json');
    const installed = await import(
      pathToFileURL(join(dirname(packagePath), 'build', 'src', 'third_party', 'index.js')).href
    );
    return installed.puppeteer;
  })());
}

async function reservePort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string' || address.port === 0)
      throw new DedicatedChromeError('Could not reserve a local Chrome debugging port.');
    return address.port;
  } finally {
    // Chrome receives this explicit nonzero port, never --remote-debugging-port=0.
    // A race after release is handled by the spawned child's exact endpoint and
    // PID checks; an unrelated listener is never adopted.
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const defaults: DedicatedChromeDependencies = {
  executablePath: async () => (await installedPuppeteer()).executablePath('chrome'),
  reservePort,
  spawn: (executable, args, options) => spawn(executable, args, options),
  connect: async (endpoint) =>
    (await installedPuppeteer()).connect({
      browserWSEndpoint: endpoint,
      defaultViewport: null,
      protocolTimeout: 5_000,
      // This connection only verifies ownership and closes the owned browser.
      // Do not attach to pages or alter their network/viewport configuration.
      targetFilter: (target: { type(): string }) => target.type() === 'browser',
    }),
  startupTimeoutMs: 20_000,
  closeTimeoutMs: 1_500,
};

function within<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (value: T | undefined, failed: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (failed) reject(error);
      else resolve(value as T);
    };
    const aborted = () =>
      finish(
        undefined,
        true,
        signal?.reason ?? new DedicatedChromeError('Chrome startup was cancelled.'),
      );
    const timer = setTimeout(
      () => finish(undefined, true, new DedicatedChromeError(message)),
      Math.max(1, timeoutMs),
    );
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    operation.then(
      (value) => finish(value, false),
      (error: unknown) => finish(undefined, true, error),
    );
  });
}

class PortCollision extends DedicatedChromeError {}

function startupError(stderr: string): Error | undefined {
  if (
    /Address already in use|Cannot start http server for devtools|ERR_ADDRESS_IN_USE/i.test(stderr)
  )
    return new PortCollision('The local Chrome debugging port was occupied during startup.');
  if (
    /ProcessSingleton|profile.*(?:in use|already running)|user data directory is already in use/i.test(
      stderr,
    )
  )
    return new DedicatedChromeError(
      'This dedicated Chrome profile is already in use. Close its Chrome window before reconnecting.',
    );
  if (
    /Running as root without --no-sandbox|No usable sandbox|sandbox.*(?:failed|not supported)/i.test(
      stderr,
    )
  )
    return new DedicatedChromeError(
      'Chrome could not start with its sandbox. Run Loom as a desktop user with a working Chrome sandbox.',
    );
  if (
    /Missing X server|cannot open display|ozone.*failed|platform failed to initialize/i.test(stderr)
  )
    return new DedicatedChromeError(
      'Chrome could not open a desktop window. Start Loom in a desktop session with Chrome installed.',
    );
}

function observeEndpoint(child: OwnedChromeProcess, port: number) {
  let buffered = '';
  let settle!: (endpoint: string) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const data = (chunk: Buffer | string) => {
    buffered = (buffered + chunk.toString()).slice(-16_384);
    const classified = startupError(buffered);
    if (classified) return fail(classified);
    const match = /DevTools listening on (ws:\/\/[^\s]+)\r?\n/.exec(buffered);
    if (!match) return;
    try {
      const endpoint = new URL(match[1]);
      if (
        endpoint.hostname !== '127.0.0.1' ||
        endpoint.port !== String(port) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint.pathname)
      )
        throw new Error();
      settle(endpoint.href);
    } catch {
      fail(new DedicatedChromeError('Chrome reported an unexpected debugging endpoint.'));
    }
  };
  const error = (failure: NodeJS.ErrnoException) => {
    fail(
      new DedicatedChromeError(
        failure.code === 'ENOENT'
          ? 'Stable Google Chrome is not installed in its standard location.'
          : 'Could not start the dedicated Chrome process.',
      ),
    );
  };
  const exit = () =>
    fail(
      startupError(buffered) ??
        new DedicatedChromeError('Chrome exited before its debugging connection was ready.'),
    );
  child.stderr?.on('data', data);
  child.once('error', error);
  child.once('exit', exit);
  return {
    promise,
    cleanup() {
      child.stderr?.off('data', data);
      child.off('error', error);
      child.off('exit', exit);
      // Drain Chrome diagnostics without relaying profile paths or page data.
      child.stderr?.resume();
    },
  };
}

/**
 * Start the installed normal Chrome, then attach only to that exact process.
 * The caller (the MCP wrapper) owns shutdown on stdio EOF and termination.
 */
export async function startDedicatedChrome(
  options: DedicatedChromeOptions,
  overrides: Partial<DedicatedChromeDependencies> = {},
): Promise<DedicatedChrome> {
  options.signal?.throwIfAborted();
  const dependencies = { ...defaults, ...overrides };
  await mkdir(options.profileDir, { recursive: true, mode: 0o700 });
  const profile = await realpath(options.profileDir);
  if (activeProfiles.has(profile))
    throw new DedicatedChromeError(
      'This dedicated Chrome profile is already in use. Close its Chrome window before reconnecting.',
    );
  const owner = Symbol('dedicated Chrome profile');
  activeProfiles.set(profile, owner);
  let startupFinished = false;
  let currentChildAlive = false;
  const releaseProfile = () => {
    if (activeProfiles.get(profile) === owner) activeProfiles.delete(profile);
  };
  const deadline = Date.now() + dependencies.startupTimeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    let executable: string;
    try {
      executable = await within(
        dependencies.executablePath(),
        remaining(),
        'Finding stable Chrome timed out.',
        options.signal,
      );
    } catch (error) {
      if (options.signal?.aborted || error instanceof DedicatedChromeError) throw error;
      throw new DedicatedChromeError(
        'Could not find installed stable Google Chrome. Install Chrome in its standard location.',
      );
    }
    for (let attempt = 0; attempt < 3; ++attempt) {
      options.signal?.throwIfAborted();
      const port = await within(
        dependencies.reservePort(),
        remaining(),
        'Reserving a local Chrome debugging port timed out.',
        options.signal,
      );
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65535)
        throw new DedicatedChromeError('Could not reserve a local Chrome debugging port.');
      options.signal?.throwIfAborted();
      const args = [
        '--user-data-dir=' + profile,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=' + port,
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-crash-restore-bubble',
        '--disable-backgrounding-occluded-windows',
        'about:blank',
      ];
      const child = dependencies.spawn(executable, args, {
        env: options.env,
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: false,
        detached: false,
        windowsHide: false,
      });
      currentChildAlive = true;
      let published = false;
      let ended = false;
      let resolveExited!: () => void;
      const exited = new Promise<void>((resolve) => {
        resolveExited = resolve;
      });
      const end = () => {
        if (ended) return;
        ended = true;
        currentChildAlive = false;
        if (startupFinished) releaseProfile();
        resolveExited();
        if (published) options.onExit?.();
      };
      child.once('exit', end);
      child.once('error', () => {
        if (!child.pid) end();
      });
      const endpoint = observeEndpoint(child, port);
      let control: ChromeControlConnection | undefined;
      let verified = false;
      let closing: Promise<void> | undefined;
      const alive = () => !ended && child.exitCode === null && child.signalCode === null;
      const close = () =>
        (closing ??= (async () => {
          const closeDeadline = Date.now() + dependencies.closeTimeoutMs;
          const slice = Math.max(1, Math.floor(dependencies.closeTimeoutMs / 3));
          if (alive() && control && verified)
            await within(
              Promise.all([control.close(), exited]),
              slice,
              'Chrome graceful shutdown timed out.',
            ).catch(() => {});
          if (alive()) {
            try {
              child.kill('SIGTERM');
            } catch {
              // A failed signal is not evidence that the process exited.
            }
            await within(exited, slice, 'Chrome shutdown timed out.').catch(() => {});
          }
          if (alive()) {
            try {
              child.kill('SIGKILL');
            } catch {
              // Keep profile ownership if termination cannot be confirmed.
            }
            await within(exited, slice, 'Chrome termination timed out.').catch(() => {});
          }
          if (control)
            await within(
              control.disconnect(),
              Math.max(1, closeDeadline - Date.now()),
              'Disconnecting Chrome timed out.',
            ).catch(() => {});
          if (!ended)
            throw new DedicatedChromeError(
              'Chrome has not confirmed its exit. Its profile and upload files remain in use.',
            );
        })());
      try {
        const wsEndpoint = await within(
          endpoint.promise,
          remaining(),
          'Chrome did not open its debugging connection in time.',
          options.signal,
        );
        if (!Number.isSafeInteger(child.pid) || !child.pid || !alive())
          throw new DedicatedChromeError(
            'Chrome exited before its debugging connection was ready.',
          );
        const connecting = dependencies.connect(wsEndpoint);
        connecting.then(
          (late) => {
            if (closing) void late.disconnect().catch(() => {});
          },
          () => {},
        );
        control = await within(
          connecting,
          remaining(),
          'Connecting to dedicated Chrome timed out.',
          options.signal,
        );
        const session = await within(
          control.target().createCDPSession(),
          remaining(),
          'Checking Chrome process ownership timed out.',
          options.signal,
        );
        try {
          const result = await within(
            session.send('SystemInfo.getProcessInfo', undefined, {
              timeout: Math.min(3_000, remaining()),
            }),
            remaining(),
            'Checking Chrome process ownership timed out.',
            options.signal,
          );
          const processInfo = (
            result as { processInfo?: Array<{ type?: string; id?: number }> } | null
          )?.processInfo;
          const browsers = Array.isArray(processInfo)
            ? processInfo.filter((item) => item?.type === 'browser')
            : [];
          if (browsers.length !== 1 || browsers[0].id !== child.pid || !alive())
            throw new DedicatedChromeError(
              'The Chrome debugging endpoint does not belong to the process Loom started.',
            );
          verified = true;
        } finally {
          await within(
            session.detach(),
            Math.min(500, remaining()),
            'Closing Chrome ownership check timed out.',
          ).catch(() => {});
        }
        options.signal?.throwIfAborted();
        if (!alive())
          throw new DedicatedChromeError(
            'Chrome exited before its debugging connection was ready.',
          );
        published = true;
        return { process: child, wsEndpoint, exited, close };
      } catch (error) {
        await close();
        if (!(error instanceof PortCollision) || attempt === 2 || Date.now() >= deadline) {
          if (options.signal?.aborted || error instanceof DedicatedChromeError) throw error;
          throw new DedicatedChromeError(
            'Could not establish a verified connection to dedicated Chrome. Reconnect in browser settings.',
          );
        }
      } finally {
        endpoint.cleanup();
      }
    }
    throw new DedicatedChromeError('Could not start dedicated Chrome.');
  } finally {
    startupFinished = true;
    if (!currentChildAlive) releaseProfile();
  }
}
