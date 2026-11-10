import { randomBytes } from 'node:crypto';
import { constants, type BigIntStats, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { browserUploadSettings, browserUploadSettingsError } from '../shared/browser.js';
import type { BrowserSettings } from '../shared/types.js';
import {
  browserUploadProcessesEnded,
  readBrowserUploadProcesses,
} from './browser-upload-processes.js';
import { abortError, throwIfAborted } from './runtime/gate.js';

export type BrowserUploadSession = {
  root: string;
  token: string;
  mode: 'existing' | 'dedicated';
};

export interface BrowserUploadStorage {
  initialize(): Promise<void>;
  createSession(mode: BrowserUploadSession['mode']): Promise<BrowserUploadSession>;
  beginUpload(
    session: BrowserUploadSession,
    bytes: number,
    signal?: AbortSignal,
  ): Promise<{
    directory: string;
    finish(): Promise<void>;
  }>;
  markIssued(session: BrowserUploadSession): Promise<void>;
  releaseSession(session: BrowserUploadSession): Promise<void>;
  sweep(): Promise<void>;
  shutdown(): Promise<void>;
}

type Manifest = {
  version: 1;
  token: string;
  ownerPid: number;
  ownerToken: string;
  mode: BrowserUploadSession['mode'];
  issued: boolean;
};
type Identity = Pick<Stats, 'dev' | 'ino'>;
type SessionState = {
  session: BrowserUploadSession;
  identity: Identity;
  active: boolean;
  lease?: UploadLease;
};
type UploadLease = { directory: string; identity: Identity; bytes: number; issued: boolean };
class StorageError extends Error {}

const MiB = 1024 * 1024;
const manifestName = 'session.json';
const proofName = 'chrome-processes.json';
const maximumManifestBytes = 4096;
const sameFile = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const codeIs = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const validToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validPid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;

function validManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<Manifest>;
  return (
    Object.keys(value).length === 6 &&
    item.version === 1 &&
    validToken(item.token) &&
    validPid(item.ownerPid) &&
    validToken(item.ownerToken) &&
    (item.mode === 'existing' || item.mode === 'dedicated') &&
    typeof item.issued === 'boolean'
  );
}

async function readManifest(root: string): Promise<Manifest | undefined> {
  try {
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
    const unchanged = (stat: BigIntStats) =>
      stat.isFile() &&
      stat.nlink === 1n &&
      stat.dev === before.dev &&
      stat.ino === before.ino &&
      stat.size === before.size &&
      stat.mtimeNs === before.mtimeNs &&
      stat.ctimeNs === before.ctimeNs;
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!unchanged(await handle.stat({ bigint: true }))) return;
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (
        length !== Number(before.size) ||
        !unchanged(await handle.stat({ bigint: true })) ||
        !unchanged(await lstat(filename, { bigint: true }))
      )
        return;
      const value: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'));
      if (validManifest(value)) return value;
    } finally {
      await handle.close();
    }
  } catch {
    // Missing or unreadable metadata is not authority to remove a directory.
  }
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (codeIs(error, 'ESRCH')) return false;
    throw error;
  }
}

/** Managed upload copies only; these checks are not an OS sandbox against same-user code. */
export function createBrowserUploadStorage(options: {
  dataDir: string;
  getSettings: () => Partial<BrowserSettings> | undefined;
  cleanupIntervalMs?: number;
  processAlive?: (pid: number) => boolean;
}): BrowserUploadStorage {
  const ownerToken = randomBytes(32).toString('hex');
  const isProcessAlive = options.processAlive ?? defaultProcessAlive;
  const records = new WeakMap<BrowserUploadSession, SessionState>();
  const active = new Map<string, SessionState>();
  const released = new Map<string, SessionState>();
  const reservations = new Map<string, UploadLease>();
  const unissuedCleanup = new Map<string, { state: SessionState; lease: UploadLease }>();
  let dataRoot = '';
  let root = '';
  let dataIdentity: Identity;
  let rootIdentity: Identity;
  let initialized = false;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping = false;
  let queue: Promise<void> = Promise.resolve();

  function locked<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = queue.then(async () => {
      try {
        return await operation();
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (error instanceof StorageError || (error as Error)?.name === 'AbortError') throw error;
        const code = (error as NodeJS.ErrnoException)?.code;
        const detail =
          typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? ` (${code})` : '';
        throw new StorageError(
          `Chrome upload storage could not be read or updated${detail}. Check local disk access and try again.`,
        );
      }
    });
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  function assertOpen() {
    if (closed) throw new StorageError('Chrome upload storage is shutting down.');
  }

  async function directory(filename: string, expected?: Identity): Promise<Stats> {
    const stat = await lstat(filename);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(filename)) !== filename ||
      (expected && !sameFile(stat, expected))
    )
      throw new StorageError(
        'The private Chrome upload storage directory changed. Reconnect Chrome after checking local storage.',
      );
    return stat;
  }

  async function assertRoot() {
    if ((await realpath(resolve(options.dataDir))) !== dataRoot)
      throw new StorageError(
        'The Chrome upload data directory changed. Reconnect Chrome after checking local storage.',
      );
    await directory(dataRoot, dataIdentity);
    await directory(root, rootIdentity);
  }

  function ended(pid: number): boolean {
    try {
      return validPid(pid) && isProcessAlive(pid) === false;
    } catch {
      return false;
    }
  }

  function stateFor(session: BrowserUploadSession, requireActive = true): SessionState {
    const state = records.get(session);
    if (!state || (requireActive && !state.active))
      throw new StorageError('This Chrome upload session is no longer active. Reconnect Chrome.');
    return state;
  }

  async function ownManifest(state: SessionState): Promise<Manifest> {
    await assertRoot();
    await directory(state.session.root, state.identity);
    const manifest = await readManifest(state.session.root);
    if (
      !manifest ||
      manifest.token !== state.session.token ||
      manifest.ownerPid !== process.pid ||
      manifest.ownerToken !== ownerToken ||
      manifest.mode !== state.session.mode
    )
      throw new StorageError(
        'The Chrome upload session metadata changed. Reconnect Chrome after checking local storage.',
      );
    return manifest;
  }

  async function writeManifest(state: SessionState, manifest: Manifest): Promise<void> {
    await assertRoot();
    await directory(state.session.root, state.identity);
    const temporary = join(state.session.root, `.session-${randomBytes(16).toString('hex')}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(manifest) + '\n', 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await directory(state.session.root, state.identity);
      await rename(temporary, join(state.session.root, manifestName));
      if (process.platform !== 'win32') {
        const parent = await open(
          state.session.root,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!codeIs(error, 'ENOENT')) throw error;
      });
    }
  }

  async function removeBatch(
    state: Pick<SessionState, 'session' | 'identity'>,
    batch: string,
    expected?: Identity,
  ): Promise<boolean> {
    try {
      await assertRoot();
      await directory(state.session.root, state.identity);
      if (dirname(batch) !== state.session.root || !basename(batch).startsWith('files-'))
        return false;
      await directory(batch, expected);
      // fs.rm removes descendant links themselves; it does not follow their targets.
      await rm(batch, { recursive: true, force: true, maxRetries: 1 });
      return true;
    } catch (error) {
      return codeIs(error, 'ENOENT');
    }
  }

  async function removeCopies(state: Pick<SessionState, 'session' | 'identity'>): Promise<boolean> {
    let complete = true;
    for (const name of await readdir(state.session.root))
      if (name.startsWith('files-') && !(await removeBatch(state, join(state.session.root, name))))
        complete = false;
    return complete;
  }

  async function removeSession(state: Pick<SessionState, 'session' | 'identity'>): Promise<void> {
    if (!(await removeCopies(state))) return;
    await directory(state.session.root, state.identity);
    // Preserve unexpected files, directories and links instead of deleting data that
    // was not created as an upload copy or one of this service's control records.
    for (const name of await readdir(state.session.root)) {
      if (name !== manifestName && name !== proofName) return;
      const stat = await lstat(join(state.session.root, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024)
        return;
    }
    await assertRoot();
    await directory(state.session.root, state.identity);
    try {
      await rm(state.session.root, { recursive: true, force: true, maxRetries: 1 });
      released.delete(state.session.root);
    } catch {
      /* Failed deletion retains the directory for the next safe sweep. */
    }
  }

  async function sweepUnlocked(): Promise<void> {
    await assertRoot();
    for (const [batch, cleanup] of unissuedCleanup) {
      if (cleanup.state.lease) continue;
      if (await removeBatch(cleanup.state, batch, cleanup.lease.identity))
        unissuedCleanup.delete(batch);
    }
    for (const name of await readdir(root)) {
      if (!name.startsWith('session-')) continue;
      const sessionRoot = join(root, name);
      const held = active.get(sessionRoot) ?? released.get(sessionRoot);
      if (held?.lease) continue;
      let identity: Stats;
      try {
        identity = await directory(sessionRoot);
      } catch {
        continue;
      }
      const manifest = await readManifest(sessionRoot);
      if (!manifest) continue;
      if (
        held &&
        (!sameFile(identity, held.identity) ||
          manifest.token !== held.session.token ||
          manifest.ownerPid !== process.pid ||
          manifest.ownerToken !== ownerToken)
      )
        continue;
      const state = held ?? {
        session: { root: sessionRoot, token: manifest.token, mode: manifest.mode },
        identity,
      };
      const proof = manifest.issued
        ? await readBrowserUploadProcesses(sessionRoot, manifest.token)
        : undefined;
      if (active.has(sessionRoot)) {
        if (manifest.issued && browserUploadProcessesEnded(proof, isProcessAlive))
          await removeCopies(state);
        continue;
      }
      const oursReleased = Boolean(held && !held.active && released.has(sessionRoot));
      if (!oursReleased && !ended(manifest.ownerPid)) continue;
      if (
        !manifest.issued ||
        (proof && ended(proof.mcpPid) && browserUploadProcessesEnded(proof, isProcessAlive))
      )
        await removeSession(state);
    }
  }

  async function usage(): Promise<number> {
    await assertRoot();
    let entries = 0;
    const seenReservations = new Set<string>();
    async function walk(
      filename: string,
      depth: number,
      omitted = new Set<string>(),
    ): Promise<number> {
      if (++entries > 200_000 || depth > 64)
        throw new StorageError(
          'Chrome upload storage contains too many entries to inspect safely. Check its retained copies before uploading more files.',
        );
      let stat: Stats;
      const reserved = reservations.get(filename)?.bytes ?? 0;
      if (reserved) seenReservations.add(filename);
      try {
        stat = await lstat(filename);
      } catch (error) {
        if (codeIs(error, 'ENOENT')) return reserved;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return Math.max(stat.size, reserved);
      await directory(filename, stat);
      let bytes = 0;
      for (const name of await readdir(filename)) {
        if (omitted.has(name)) continue;
        bytes += await walk(join(filename, name), depth + 1);
        if (!Number.isSafeInteger(bytes))
          throw new StorageError('Chrome upload storage exceeds the supported accounting range.');
      }
      await directory(filename, stat);
      return Math.max(bytes, reserved);
    }
    let total = 0;
    for (const name of await readdir(root)) {
      const filename = join(root, name);
      const omitted = new Set<string>();
      if (name.startsWith('session-')) {
        const stat = await lstat(filename).catch(() => undefined);
        if (stat?.isDirectory() && !stat.isSymbolicLink()) {
          await directory(filename, stat);
          const manifest = await readManifest(filename);
          if (manifest) {
            omitted.add(manifestName);
            if (await readBrowserUploadProcesses(filename, manifest.token)) omitted.add(proofName);
          }
        }
      }
      total += await walk(filename, 0, omitted);
      if (!Number.isSafeInteger(total))
        throw new StorageError('Chrome upload storage exceeds the supported accounting range.');
    }
    for (const [directory, reservation] of reservations)
      if (!seenReservations.has(directory)) total += reservation.bytes;
    await assertRoot();
    return total;
  }

  async function requireBudget(additionalBytes: number): Promise<void> {
    const settings = options.getSettings();
    const invalid = browserUploadSettingsError(settings);
    if (invalid) throw new StorageError(invalid);
    const limitMiB = browserUploadSettings(settings).uploadStorageMiB;
    if ((await usage()) + additionalBytes > limitMiB * MiB)
      throw new StorageError(
        `Chrome upload copies would exceed the configured ${limitMiB} MiB temporary storage budget. Close the browsers using retained copies, or increase the storage limit. Active copies were not removed.`,
      );
  }

  async function initializeUnlocked(): Promise<void> {
    assertOpen();
    if (initialized) return;
    const intervalMs = options.cleanupIntervalMs ?? 30_000;
    if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 0x7fffffff)
      throw new StorageError('The Chrome upload cleanup interval is invalid.');
    await mkdir(resolve(options.dataDir), { recursive: true, mode: 0o700 });
    dataRoot = await realpath(resolve(options.dataDir));
    dataIdentity = await directory(dataRoot);
    root = join(dataRoot, 'browser-uploads');
    await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
      if (!codeIs(error, 'EEXIST')) throw error;
    });
    rootIdentity = await directory(root);
    await sweepUnlocked();
    initialized = true;
    timer = setInterval(() => {
      if (sweeping || closed) return;
      sweeping = true;
      void storage
        .sweep()
        .catch(() => {})
        .finally(() => {
          sweeping = false;
        });
    }, intervalMs);
    timer.unref();
  }

  const storage: BrowserUploadStorage = {
    initialize: () => locked(initializeUnlocked),
    createSession: (mode) =>
      locked(async () => {
        await initializeUnlocked();
        if (mode !== 'existing' && mode !== 'dedicated')
          throw new StorageError('The Chrome upload session mode is invalid.');
        await assertRoot();
        const sessionRoot = await mkdtemp(join(root, 'session-'));
        const identity = await directory(sessionRoot);
        const session = Object.freeze({
          root: sessionRoot,
          token: randomBytes(32).toString('hex'),
          mode,
        });
        const state: SessionState = { session, identity, active: true };
        try {
          await writeManifest(state, {
            version: 1,
            token: session.token,
            ownerPid: process.pid,
            ownerToken,
            mode,
            issued: false,
          });
          assertOpen();
        } catch (error) {
          await removeSession(state).catch(() => {});
          throw error;
        }
        records.set(session, state);
        active.set(sessionRoot, state);
        return session;
      }),
    beginUpload: (session, bytes, signal) =>
      locked(async () => {
        assertOpen();
        throwIfAborted(signal);
        const state = stateFor(session);
        if (!Number.isSafeInteger(bytes) || bytes < 1)
          throw new StorageError(
            'The Chrome upload byte reservation must be a positive safe integer.',
          );
        if (state.lease)
          throw new StorageError(
            'A Chrome upload is already in progress for this browser session.',
          );
        await ownManifest(state);
        await sweepUnlocked();
        await requireBudget(bytes);
        throwIfAborted(signal);
        assertOpen();
        const batch = await mkdtemp(join(session.root, 'files-'));
        const identity = await directory(batch);
        const lease: UploadLease = { directory: batch, identity, bytes, issued: false };
        try {
          throwIfAborted(signal);
          assertOpen();
        } catch (error) {
          unissuedCleanup.set(batch, { state, lease });
          await sweepUnlocked();
          throw error;
        }
        state.lease = lease;
        reservations.set(batch, lease);
        let finished: Promise<void> | undefined;
        return {
          directory: batch,
          finish: () =>
            (finished ??= locked(async () => {
              state.lease = undefined;
              reservations.delete(batch);
              if (!lease.issued) unissuedCleanup.set(batch, { state, lease });
              await sweepUnlocked();
            })),
        };
      }, signal),
    markIssued: (session) =>
      locked(async () => {
        assertOpen();
        const state = stateFor(session);
        if (!state.lease) throw new StorageError('No Chrome upload is waiting to be issued.');
        const manifest = await ownManifest(state);
        await sweepUnlocked();
        await requireBudget(0);
        assertOpen();
        if (!manifest.issued) await writeManifest(state, { ...manifest, issued: true });
        state.lease.issued = true;
      }),
    releaseSession: (session) =>
      locked(async () => {
        const state = stateFor(session, false);
        if (!state.active) {
          await sweepUnlocked();
          return;
        }
        state.active = false;
        active.delete(session.root);
        released.set(session.root, state);
        await sweepUnlocked();
      }),
    sweep: () =>
      locked(async () => {
        if (initialized) await sweepUnlocked();
        else if (!closed) await initializeUnlocked();
      }),
    shutdown: () => {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      return locked(async () => {
        if (initialized) await sweepUnlocked();
      });
    },
  };
  return storage;
}
