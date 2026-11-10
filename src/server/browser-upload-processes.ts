import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export type BrowserUploadProcessProof = {
  version: 1;
  token: string;
  mcpPid: number;
  browsers: Array<{ pid: number; exited: boolean }>;
};

const manifestName = 'chrome-processes.json';
const maximumManifestBytes = 32 * 1024;
const maximumGenerations = 128;
const ownershipError = () =>
  new Error('Could not persist Chrome process ownership for browser uploads.');
const validPid = (pid: unknown): pid is number =>
  typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff;
const validToken = (token: unknown): token is string =>
  typeof token === 'string' &&
  token.length > 0 &&
  token.length <= 256 &&
  !/[\x00-\x1f\x7f]/.test(token);

function validProof(value: unknown, token?: string): value is BrowserUploadProcessProof {
  if (!value || typeof value !== 'object') return false;
  const proof = value as Partial<BrowserUploadProcessProof>;
  return (
    proof.version === 1 &&
    validToken(proof.token) &&
    (token === undefined || proof.token === token) &&
    validPid(proof.mcpPid) &&
    Array.isArray(proof.browsers) &&
    proof.browsers.length <= maximumGenerations &&
    proof.browsers.every(
      (browser) => browser && validPid(browser.pid) && typeof browser.exited === 'boolean',
    )
  );
}

/** Invalid, missing, or concurrently replaced evidence can never authorize cleanup. */
export async function readBrowserUploadProcesses(
  root: string,
  token: string,
): Promise<BrowserUploadProcessProof | undefined> {
  try {
    if (!validToken(token)) return;
    const directory = await lstat(root);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return;
    const filename = join(root, manifestName);
    const before = await lstat(filename, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(maximumManifestBytes)
    )
      return;
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const sameFile = (stat: typeof before) =>
        stat.isFile() &&
        stat.nlink === 1n &&
        stat.dev === before.dev &&
        stat.ino === before.ino &&
        stat.size === before.size &&
        stat.mtimeNs === before.mtimeNs &&
        stat.ctimeNs === before.ctimeNs;
      if (!sameFile(await handle.stat({ bigint: true }))) return;
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (
        length !== Number(before.size) ||
        !sameFile(await handle.stat({ bigint: true })) ||
        !sameFile(await lstat(filename, { bigint: true }))
      )
        return;
      const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
      if (validProof(value, token)) return value;
    } finally {
      await handle.close();
    }
  } catch {
    // A failed read is absence of proof, not proof that Chrome has exited.
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** The caller separately guards the owning Loom/MCP process and in-flight operations. */
export function browserUploadProcessesEnded(
  proof: BrowserUploadProcessProof | undefined,
  isProcessAlive: (pid: number) => boolean = processAlive,
): boolean {
  if (!validProof(proof) || !proof.browsers.length) return false;
  try {
    return proof.browsers.every(
      (browser) => browser.exited || isProcessAlive(browser.pid) === false,
    );
  } catch {
    return false;
  }
}

async function writeProof(root: string, proof: BrowserUploadProcessProof): Promise<void> {
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw ownershipError();
  const filename = join(root, manifestName);
  try {
    const existing = await lstat(filename);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
      throw ownershipError();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(root, `.chrome-processes-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(proof) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    const current = await lstat(root);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== directory.dev ||
      current.ino !== directory.ino
    )
      throw ownershipError();
    await rename(temporary, filename);
    // Windows does not support opening a directory for fsync through this API.
    if (process.platform !== 'win32') {
      const directoryHandle = await open(root, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

type BrowserProcess = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'once'>;
type BrowserSession = {
  send(method: string, params?: object, options?: { timeout: number }): Promise<unknown>;
  detach(): Promise<void>;
};
export type BrowserUploadTrackedBrowser = {
  process(): BrowserProcess | null;
  target?(): { createCDPSession(): Promise<BrowserSession> };
};
export type BrowserUploadProcessManager = {
  ensureBrowser(...args: unknown[]): Promise<BrowserUploadTrackedBrowser>;
  close(...args: unknown[]): Promise<unknown>;
};
type TrackerOptions = {
  mcpPid?: number;
  /** Allows bounded fault-injection tests without running Chrome. */
  writeProof?: (root: string, proof: BrowserUploadProcessProof) => Promise<void>;
};

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Chrome process lookup timed out.')), 3000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function attachedBrowserPid(
  browser: BrowserUploadTrackedBrowser,
): Promise<number | undefined> {
  if (!browser.target) return;
  const connecting = Promise.resolve().then(() => browser.target!().createCDPSession());
  let session: BrowserSession | undefined;
  try {
    session = await bounded(connecting);
    const result = await bounded(
      session.send('SystemInfo.getProcessInfo', undefined, { timeout: 3000 }),
    );
    const info = result as { processInfo?: Array<{ type?: unknown; id?: unknown }> } | null;
    if (!Array.isArray(info?.processInfo)) return;
    const browsers = info.processInfo.filter((entry) => entry?.type === 'browser');
    if (browsers.length === 1 && validPid(browsers[0].id)) return browsers[0].id;
  } catch {
    // Existing Chrome may not expose this command. Unknown ownership must persist.
  } finally {
    if (session) await bounded(session.detach()).catch(() => {});
    else void connecting.then((lateSession) => lateSession.detach()).catch(() => {});
  }
}

/**
 * Instrument the pinned MCP manager or its prototype before its first use.
 * No package files are modified; ensureBrowser remains the tool's launch barrier.
 */
export function installBrowserUploadProcessTracker(
  manager: BrowserUploadProcessManager,
  root: string,
  token: string,
  options: TrackerOptions = {},
): { flush(): Promise<void> } {
  const mcpPid = options.mcpPid ?? process.pid;
  if (
    !validToken(token) ||
    !validPid(mcpPid) ||
    typeof manager.ensureBrowser !== 'function' ||
    typeof manager.close !== 'function'
  )
    throw ownershipError();
  const persist = options.writeProof ?? writeProof;
  const generations: BrowserUploadProcessProof['browsers'] = [];
  const observed = new WeakMap<BrowserUploadTrackedBrowser, Promise<void>>();
  let unidentified = false;
  let pending = Promise.resolve();
  let failure: Error | undefined;

  function save(): Promise<void> {
    const proof: BrowserUploadProcessProof = {
      version: 1,
      token,
      mcpPid,
      // An unidentified generation must not disappear behind older exited PIDs.
      browsers: unidentified ? [] : generations.map((entry) => ({ ...entry })),
    };
    const write = pending.then(async () => {
      if (failure) throw failure;
      await persist(root, proof);
    });
    pending = write.catch(() => {
      failure ??= ownershipError();
    });
    return write.catch(() => {
      throw failure ?? ownershipError();
    });
  }

  async function flush(): Promise<void> {
    let last: Promise<void>;
    do {
      last = pending;
      await last;
    } while (last !== pending);
    if (failure) throw failure;
  }

  async function register(browser: BrowserUploadTrackedBrowser): Promise<void> {
    const child = browser.process();
    const pid = child?.pid ?? (await attachedBrowserPid(browser));
    if (!validPid(pid)) {
      unidentified = true;
      await save();
      return;
    }
    if (generations.length >= maximumGenerations) {
      for (let index = generations.length - 1; index >= 0; --index)
        if (generations[index].exited) generations.splice(index, 1);
    }
    if (generations.length >= maximumGenerations)
      throw new Error('Too many unclosed Chrome generations to track browser uploads safely.');
    // Keep separate records even if the OS reuses a PID from an exited generation.
    const entry = { pid, exited: false };
    generations.push(entry);
    if (child) {
      const ended = () => {
        if (entry.exited) return;
        entry.exited = true;
        void save().catch(() => {});
      };
      child.once('exit', ended);
      child.once('close', ended);
      if (typeof child.exitCode === 'number' || typeof child.signalCode === 'string') ended();
    }
    await save();
  }

  const originalEnsure = manager.ensureBrowser;
  manager.ensureBrowser = async function (...args) {
    if (failure) throw failure;
    const browser = await originalEnsure.apply(this, args);
    let registering = observed.get(browser);
    if (!registering) {
      registering = Promise.resolve().then(() => register(browser));
      observed.set(browser, registering);
    }
    await registering;
    await flush();
    return browser;
  };
  const originalClose = manager.close;
  manager.close = async function (...args) {
    try {
      return await originalClose.apply(this, args);
    } finally {
      await flush();
    }
  };
  void save().catch(() => {});
  return { flush };
}
