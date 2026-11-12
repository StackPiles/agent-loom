import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  dedicatedBrowserErrorMessage,
  startDedicatedChrome,
  type DedicatedChromeProcess,
} from './browser-process.js';
import { installBrowserInputAdapter, type BrowserInputLocator } from './browser-input.js';
import { bufferBrowserPeerInput } from './browser-peer-input.js';
import {
  installBrowserUploadProcessTracker,
  type BrowserUploadProcessManager,
} from './browser-upload-processes.js';

// The parent supplies a fixed installed entrypoint, narrow environment and
// private paths. None of these values are selected by a model or a web page.
const entrypoint = process.argv[2];
const root = process.env.LOOM_BROWSER_UPLOAD_ROOT;
const token = process.env.LOOM_BROWSER_UPLOAD_TOKEN;
const profileDir = process.env.LOOM_BROWSER_DEDICATED_PROFILE;
const credentialChannel = process.env.LOOM_BROWSER_CREDENTIAL_CHANNEL;
delete process.env.LOOM_BROWSER_UPLOAD_ROOT;
delete process.env.LOOM_BROWSER_UPLOAD_TOKEN;
delete process.env.LOOM_BROWSER_DEDICATED_PROFILE;
delete process.env.LOOM_BROWSER_CREDENTIAL_CHANNEL;
if (!entrypoint || Boolean(root) !== Boolean(token))
  throw new Error('The Chrome lifecycle launcher is missing its private configuration.');

const require = createRequire(import.meta.url);
const packagePath = require.resolve('chrome-devtools-mcp/package.json');
const sourceRoot = join(dirname(packagePath), 'build', 'src');
if (resolve(entrypoint) !== join(sourceRoot, 'bin', 'chrome-devtools-mcp.js'))
  throw new Error('The Chrome upload lifecycle launcher requires the installed MCP entrypoint.');
const args = process.argv.slice(3);
const lifetime = new AbortController();
let owned: DedicatedChromeProcess | undefined;
let starting: Promise<DedicatedChromeProcess> | undefined;
let tracker: ReturnType<typeof installBrowserUploadProcessTracker> | undefined;
let closingOwned: Promise<void> | undefined;
let shuttingDown: Promise<void> | undefined;

const closeOwned = () =>
  (closingOwned ??= Promise.resolve().then(async () => {
    await starting?.catch(() => {});
    await owned?.close();
  }));

// Register before Chrome startup, so a cancelled MCP handshake cannot leave a
// late Chrome behind. The installed CLI also calls BrowserManager.close; that
// hook below waits for the same idempotent close before it exits.
function shutdown(code: number): Promise<void> {
  if (shuttingDown) return shuttingDown;
  lifetime.abort();
  shuttingDown = (async () => {
    try {
      await closeOwned();
      await tracker?.flush();
    } finally {
      process.exit(code);
    }
  })();
  return shuttingDown;
}
const startupInput = bufferBrowserPeerInput(process.stdin, {
  onEof: () => void shutdown(0),
  onOverflow: () => void shutdown(1),
});
for (const event of ['end', 'close'] as const) process.stdin.on(event, () => void shutdown(0));
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
  process.on(signal, () => void shutdown(0));
process.once('exit', () => {
  // A synchronous backstop for an upstream fatal exit; never target a process
  // discovered from a port or a stale PID file. Unconfirmed upload copies stay.
  startupInput.dispose();
  if (owned && owned.process.exitCode === null && owned.process.signalCode === null) {
    try {
      owned.process.kill('SIGKILL');
    } catch {
      // Unknown termination remains conservative in the upload process proof.
    }
  }
});

if (profileDir) {
  starting = startDedicatedChrome({
    profileDir,
    env: process.env,
    signal: lifetime.signal,
    onExit: () => {
      if (!closingOwned) void shutdown(1);
    },
  });
  try {
    owned = await starting;
  } catch (error) {
    if (!lifetime.signal.aborted)
      process.stderr.write(
        'LOOM_BROWSER_ERROR ' + JSON.stringify(dedicatedBrowserErrorMessage(error)) + '\n',
      );
    throw new Error(dedicatedBrowserErrorMessage(error));
  }
  lifetime.signal.throwIfAborted();
  args.push('--ws-endpoint=' + owned.wsEndpoint);
}
process.argv = [process.argv[0], entrypoint, ...args];
const { BrowserManager } = (await import(
  pathToFileURL(join(sourceRoot, 'BrowserManager.js')).href
)) as {
  BrowserManager: { prototype: BrowserUploadProcessManager };
};
const { Locator } = (await import(
  pathToFileURL(join(sourceRoot, 'third_party', 'index.js')).href
)) as {
  Locator: { prototype: BrowserInputLocator };
};
installBrowserInputAdapter(Locator.prototype, credentialChannel);
if (owned) {
  const originalClose = BrowserManager.prototype.close;
  BrowserManager.prototype.close = async function (...parameters) {
    try {
      return await originalClose.apply(this, parameters);
    } finally {
      await closeOwned();
    }
  };
}
if (root && token) {
  tracker = installBrowserUploadProcessTracker(BrowserManager.prototype, root, token, {
    ...(owned ? { ownedProcess: owned.process } : {}),
  });
  await tracker.flush();
}
startupInput.replay();
await import(pathToFileURL(entrypoint).href);
startupInput.resume();
