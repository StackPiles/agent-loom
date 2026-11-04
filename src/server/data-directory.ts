import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readlink, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

const RESERVED = '.loom-transfer';
const JOURNAL = 'restore.json';
const RESULT = 'restore-result.json';
const JOB_ID = /^[a-f0-9]{32}$/;
const IN_USE =
  'This data directory is already in use. Stop the other Agent Loom instance before starting another.';
const NEEDS_RECOVERY =
  'A data restore was interrupted. Restart Agent Loom to recover its data before opening it.';
const MAX_NAMES = 200_000;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const phases = [
  'backing-up',
  'installing',
  'installed',
  'discarding',
  'restoring',
  'committed',
] as const;

interface Journal {
  version: 1;
  jobId: string;
  phase: (typeof phases)[number];
  oldNames: string[];
  newNames: string[];
}

interface LeaseState {
  db?: DatabaseSync;
  root: string;
  rootIdentity: { dev: number; ino: number };
  controlIdentity: { dev: number; ino: number };
  ownerIdentity: { dev: number; ino: number };
  storeOpen: boolean;
  busy: boolean;
  installedJob?: string;
}
const leases = new WeakMap<DataDirectoryLock, LeaseState>();

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function regularDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('The data transfer directory must be a real directory.');
}

function sameFile(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function stateOf(lock: DataDirectoryLock): LeaseState {
  const state = leases.get(lock);
  if (!state?.db) throw new Error('The data directory lock is closed.');
  return state;
}

/**
 * The ownership database never moves with user data. Its OS-backed lock remains
 * held while the application closes, replaces its data, and opens a new Store.
 */
export class DataDirectoryLock {
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const root = realpathSync(this.dataDir);
    const control = join(root, RESERVED);
    try {
      mkdirSync(control, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
    regularDirectory(control);
    const owner = join(control, 'owner.sqlite');
    try {
      const descriptor = openSync(owner, 'wx', 0o600);
      closeSync(descriptor);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
    const ownerStat = lstatSync(owner);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.nlink !== 1)
      throw new Error('The data directory ownership file must be a regular private file.');
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(owner);
      db.exec(
        'PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE; ' +
          'PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; ' +
          'CREATE TABLE IF NOT EXISTS ownership(id INTEGER PRIMARY KEY CHECK(id=1), nonce TEXT NOT NULL);',
      );
      db.prepare('INSERT OR REPLACE INTO ownership(id,nonce) VALUES(1,?)').run(
        randomBytes(16).toString('hex'),
      );
      db.exec('COMMIT;');
      try {
        chmodSync(owner, 0o600);
      } catch {
        // Windows inherits directory ACLs.
      }
      leases.set(this, {
        db,
        root,
        rootIdentity: statSync(root),
        controlIdentity: lstatSync(control),
        ownerIdentity: lstatSync(owner),
        storeOpen: false,
        busy: false,
      });
    } catch (error) {
      db?.close();
      if (/locked|busy/i.test((error as Error).message)) throw new Error(IN_USE);
      throw error;
    }
  }

  assertOwner(dataDir: string): void {
    const state = stateOf(this);
    if (
      realpathSync(resolve(dataDir)) !== state.root ||
      !sameFile(statSync(state.root), state.rootIdentity)
    )
      throw new Error('The data directory lock belongs to a different directory.');
    const control = join(state.root, RESERVED);
    regularDirectory(control);
    const owner = lstatSync(join(control, 'owner.sqlite'));
    if (
      !sameFile(lstatSync(control), state.controlIdentity) ||
      !owner.isFile() ||
      owner.isSymbolicLink() ||
      owner.nlink !== 1 ||
      !sameFile(owner, state.ownerIdentity)
    )
      throw new Error('The data directory ownership files changed while Loom was running.');
  }

  close(): void {
    const state = leases.get(this);
    if (!state?.db) return;
    if (state.storeOpen || state.busy)
      throw new Error('Close the application before releasing its data directory lock.');
    state.db.close();
    state.db = undefined;
  }
}

/** @internal Keep a Store from opening during replacement, including one using the same lease. */
export function claimDataDirectoryStore(lock: DataDirectoryLock, dataDir: string): () => void {
  lock.assertOwner(dataDir);
  const state = stateOf(lock);
  if (state.storeOpen) throw new Error(IN_USE);
  if (state.busy) throw new Error('The data directory is being restored.');
  const journal = lstatSync(join(state.root, RESERVED, JOURNAL), { throwIfNoEntry: false });
  if (journal && !state.installedJob) throw new Error(NEEDS_RECOVERY);
  state.storeOpen = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.storeOpen = false;
  };
}

function validName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    name.toLowerCase() !== RESERVED &&
    !/[\\/\0:]/.test(name)
  );
}

function validNames(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_NAMES &&
    value.every(validName) &&
    new Set(value).size === value.length
  );
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Windows cannot open/fsync directories. File contents and journal files
    // are still flushed before rename; never mask actual I/O failures on POSIX.
    if (
      process.platform !== 'win32' ||
      !['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].some((code) => hasCode(error, code))
    )
      throw error;
  } finally {
    await handle?.close();
  }
}

async function directory(path: string, create = false): Promise<void> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('The data transfer directory must be a real directory.');
}

function paths(lock: DataDirectoryLock, jobId: string) {
  const control = join(stateOf(lock).root, RESERVED);
  return {
    control,
    jobs: join(control, 'jobs'),
    job: join(control, 'jobs', jobId),
    staged: join(control, 'jobs', jobId, 'data'),
    rejected: join(control, 'jobs', jobId, 'rejected'),
    backups: join(control, 'backups'),
    backup: join(control, 'backups', jobId),
    journal: join(control, JOURNAL),
    result: join(control, 'jobs', jobId, RESULT),
  };
}

async function readJournal(lock: DataDirectoryLock): Promise<Journal | undefined> {
  const filename = join(stateOf(lock).root, RESERVED, JOURNAL);
  let stat;
  try {
    stat = await lstat(filename);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOURNAL_BYTES)
    throw new Error('The data restore journal is invalid. The existing data was not opened.');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let value: unknown;
  try {
    if (!sameFile(await handle.stat(), stat)) throw new Error('The data restore journal changed.');
    value = JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
  const journal = value as Partial<Journal> | null;
  if (
    !journal ||
    journal.version !== 1 ||
    typeof journal.jobId !== 'string' ||
    !JOB_ID.test(journal.jobId) ||
    !phases.includes(journal.phase as Journal['phase']) ||
    !validNames(journal.oldNames) ||
    !validNames(journal.newNames)
  )
    throw new Error('The data restore journal is invalid. The existing data was not opened.');
  return journal as Journal;
}

async function atomicJson(directory: string, filename: string, value: unknown): Promise<void> {
  const contents = JSON.stringify(value) + '\n';
  const temporary = join(directory, 'restore-' + randomBytes(16).toString('hex') + '.tmp');
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filename);
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!hasCode(error, 'ENOENT')) throw error;
    });
  }
}

async function writeJournal(lock: DataDirectoryLock, journal: Journal): Promise<void> {
  lock.assertOwner(lock.dataDir);
  if (Buffer.byteLength(JSON.stringify(journal)) + 1 > MAX_JOURNAL_BYTES)
    throw new Error('The data directory contains too many names to restore safely.');
  const p = paths(lock, journal.jobId);
  await atomicJson(p.control, p.journal, journal);
}

async function writeResult(
  lock: DataDirectoryLock,
  jobId: string,
  status: 'committed' | 'rolled-back',
): Promise<void> {
  lock.assertOwner(lock.dataDir);
  const p = paths(lock, jobId);
  await directory(p.jobs, true);
  await syncDirectory(p.control);
  await directory(p.job, true);
  await syncDirectory(p.jobs);
  await atomicJson(p.job, p.result, { version: 1, status });
}

async function removeJournal(lock: DataDirectoryLock): Promise<void> {
  const control = join(stateOf(lock).root, RESERVED);
  await unlink(join(control, JOURNAL));
  await syncDirectory(control);
}

async function topLevel(path: string, excludeControl = false): Promise<string[]> {
  const names = (await readdir(path)).filter((name) => !excludeControl || name !== RESERVED);
  if (!validNames(names)) throw new Error('The data directory contains an unsupported file name.');
  return names.sort();
}

async function validateStageLink(path: string, stagedRoot: string): Promise<void> {
  const name = relative(stagedRoot, path);
  if (/^(?:secret\.key|loom\.sqlite(?:-(?:wal|shm|journal))?)$/i.test(name))
    throw new Error('The staged database and encryption key must not be links.');
  const target = await readlink(path);
  if (isAbsolute(target) || /^[\\/]|^[a-z]:/i.test(target))
    throw new Error('Staged links must be relative and stay inside the staged data.');
  const destination = relative(stagedRoot, resolve(dirname(path), target));
  if (destination === '..' || destination.startsWith('..' + sep) || isAbsolute(destination))
    throw new Error('Staged links must stay inside the staged data.');
  // Inspect the original components before normalizing "..": traversing a
  // linked directory and then ".." can escape even if the lexical path is local.
  let current = dirname(path);
  const components = target.split(process.platform === 'win32' ? /[\\/]/ : '/');
  for (let i = 0; i < components.length; i++) {
    const component = components[i];
    if (!component || component === '.') continue;
    current = component === '..' ? dirname(current) : join(current, component);
    const local = relative(stagedRoot, current);
    if (local === '..' || local.startsWith('..' + sep) || isAbsolute(local))
      throw new Error('Staged links must stay inside the staged data.');
    const info = await lstat(current);
    if (
      info.isSymbolicLink() ||
      (i < components.length - 1 && !info.isDirectory()) ||
      (i === components.length - 1 && !info.isFile() && !info.isDirectory())
    )
      throw new Error('Staged links must point directly to a regular file or directory.');
  }
}

/** Flush complete stage files; the validated archive can include internal, single-hop links. */
async function flushStage(path: string, device: number, stagedRoot = path): Promise<void> {
  const stat = await lstat(path);
  if (stat.dev !== device) throw new Error('Staged data must not cross filesystem boundaries.');
  if (stat.isSymbolicLink()) {
    await validateStageLink(path, stagedRoot);
    return;
  }
  if (stat.isDirectory()) {
    for (const name of await readdir(path)) await flushStage(join(path, name), device, stagedRoot);
    await syncDirectory(path);
  } else if (stat.isFile() && stat.nlink === 1) {
    // Windows FlushFileBuffers requires a writable handle. Preserve the
    // archive's read-only attribute after flushing the private staged copy.
    const writable = process.platform === 'win32';
    const temporaryWrite = writable && !(stat.mode & 0o200);
    if (temporaryWrite) await chmod(path, (stat.mode & 0o777) | 0o200);
    let handle;
    try {
      handle = await open(
        path,
        (writable ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0),
      );
      if (!sameFile(await handle.stat(), stat)) throw new Error('A staged data file changed.');
      await handle.sync();
    } finally {
      await handle?.close();
      if (temporaryWrite) await chmod(path, stat.mode & 0o777);
    }
  } else throw new Error('Staged data must contain only regular files and directories.');
}

async function move(source: string, target: string, sourceParent: string, targetParent: string) {
  if (await present(target)) throw new Error('A data restore target already exists.');
  await rename(source, target);
  // Make the retained copy durable before flushing removal of its old name.
  await syncDirectory(targetParent);
  await syncDirectory(sourceParent);
}

async function rollbackJournal(lock: DataDirectoryLock, journal: Journal): Promise<void> {
  const root = stateOf(lock).root;
  const p = paths(lock, journal.jobId);
  if (journal.phase === 'committed') {
    await writeResult(lock, journal.jobId, 'committed');
    await removeJournal(lock);
    return;
  }
  await directory(p.jobs);
  await directory(p.job);
  await directory(p.backups);
  await directory(p.backup);
  if (journal.phase === 'backing-up') {
    // No new data can be installed before the entire backup is durable.
    journal = { ...journal, phase: 'restoring' };
    await writeJournal(lock, journal);
  } else if (journal.phase === 'installing' || journal.phase === 'installed') {
    journal = { ...journal, phase: 'discarding' };
    await writeJournal(lock, journal);
  }
  if (journal.phase === 'discarding') {
    await directory(p.rejected, true);
    await syncDirectory(p.job);
    // Include files created by a failed new app startup (such as SQLite WAL).
    // Preserve them separately instead of deleting an uncertain generation.
    for (const name of await topLevel(root, true))
      await move(join(root, name), join(p.rejected, name), root, p.rejected);
    journal = { ...journal, phase: 'restoring' };
    await writeJournal(lock, journal);
  }
  if (journal.phase !== 'restoring')
    throw new Error('The data restore journal has an invalid phase.');
  for (const name of journal.oldNames) {
    const backup = join(p.backup, name);
    const target = join(root, name);
    if (await present(backup)) await move(backup, target, p.backup, root);
    else if (!(await present(target)))
      throw new Error('A backup entry is missing. The data restore remains stopped for recovery.');
  }
  if ((await topLevel(p.backup)).length)
    throw new Error('The backup contains unexpected entries. The data restore remains stopped.');
  if (JSON.stringify(await topLevel(root, true)) !== JSON.stringify([...journal.oldNames].sort()))
    throw new Error('The data directory has unexpected entries. The data restore remains stopped.');
  await writeResult(lock, journal.jobId, 'rolled-back');
  await removeJournal(lock);
}

async function exclusive<T>(
  lock: DataDirectoryLock,
  allowStore: boolean,
  operation: (state: LeaseState) => Promise<T>,
): Promise<T> {
  lock.assertOwner(lock.dataDir);
  const state = stateOf(lock);
  if (state.busy || (!allowStore && state.storeOpen))
    throw new Error('Close the application before replacing its data directory.');
  state.busy = true;
  try {
    return await operation(state);
  } finally {
    state.busy = false;
  }
}

/** Run before opening a Store. An uncommitted replacement always restores the previous generation. */
export async function recoverDataDirectory(lock: DataDirectoryLock): Promise<void> {
  await exclusive(lock, false, async (state) => {
    state.installedJob = undefined;
    const journal = await readJournal(lock);
    if (journal) await rollbackJournal(lock, journal);
  });
}

export interface DataReplacementResult {
  status: 'committed' | 'rolled-back';
  backupPath?: string;
}

/** A durable outcome survives a crash before the UI job record can be updated. */
export async function readDataReplacementResult(
  lock: DataDirectoryLock,
  jobId: string,
): Promise<DataReplacementResult | undefined> {
  return exclusive(lock, true, async () => {
    if (!JOB_ID.test(jobId)) throw new Error('The data transfer job ID is invalid.');
    const p = paths(lock, jobId);
    try {
      await directory(p.jobs);
      await directory(p.job);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return;
      throw error;
    }
    let info;
    try {
      info = await lstat(p.result);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096)
      throw new Error('The data restore result is invalid.');
    const handle = await open(p.result, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let value: unknown;
    try {
      if (!sameFile(await handle.stat(), info)) throw new Error('The data restore result changed.');
      value = JSON.parse(await handle.readFile('utf8'));
    } finally {
      await handle.close();
    }
    const result = value as { version?: unknown; status?: unknown } | null;
    if (
      !result ||
      result.version !== 1 ||
      (result.status !== 'committed' && result.status !== 'rolled-back')
    )
      throw new Error('The data restore result is invalid.');
    return {
      status: result.status,
      ...(result.status === 'committed' ? { backupPath: p.backup } : {}),
    };
  });
}

export interface DataReplacement {
  readonly backupPath: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Replace only root entries; the root itself may be a Docker volume mountpoint.
 * The caller closes the app first, opens the new app, then commits on success.
 */
export async function beginDataReplacement(
  lock: DataDirectoryLock,
  stagedDir: string,
  jobId: string,
): Promise<DataReplacement> {
  return exclusive(lock, false, async (state) => {
    if (!JOB_ID.test(jobId)) throw new Error('The data transfer job ID is invalid.');
    if (state.installedJob || (await readJournal(lock))) throw new Error(NEEDS_RECOVERY);
    const p = paths(lock, jobId);
    // Do not accept an arbitrary directory, even one on the same filesystem.
    const requested = resolve(stagedDir);
    const expected = join(resolve(lock.dataDir), RESERVED, 'jobs', jobId, 'data');
    if (requested !== expected && requested !== p.staged)
      throw new Error('The staged data must belong to this data transfer job.');
    for (const path of [p.jobs, p.job, p.staged]) await directory(path);
    await flushStage(p.staged, state.rootIdentity.dev);
    const oldNames = await topLevel(state.root, true);
    const newNames = await topLevel(p.staged);
    if (await present(p.rejected)) throw new Error('This data transfer job was already used.');
    await directory(p.backups, true);
    await syncDirectory(p.control);
    await mkdir(p.backup, { mode: 0o700 }); // A job ID can never overwrite an older backup.
    await syncDirectory(p.backups);
    const initial: Journal = { version: 1, jobId, phase: 'backing-up', oldNames, newNames };
    try {
      await writeJournal(lock, initial);
      for (const name of oldNames)
        await move(join(state.root, name), join(p.backup, name), state.root, p.backup);
      await writeJournal(lock, { ...initial, phase: 'installing' });
      for (const name of newNames)
        await move(join(p.staged, name), join(state.root, name), p.staged, state.root);
      await writeJournal(lock, { ...initial, phase: 'installed' });
      state.installedJob = jobId;
    } catch (error) {
      state.installedJob = undefined;
      try {
        const journal = await readJournal(lock);
        if (journal) await rollbackJournal(lock, journal);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          'Data replacement failed and requires recovery. Restart Loom before using its data.',
        );
      }
      throw error;
    }
    let outcome: 'pending' | 'committed' | 'rolled-back' = 'pending';
    return {
      backupPath: p.backup,
      async commit() {
        if (outcome === 'committed') return;
        if (outcome !== 'pending')
          throw new Error('This data replacement was already rolled back.');
        await exclusive(lock, true, async () => {
          const journal = await readJournal(lock);
          if (journal?.jobId !== jobId || journal.phase !== 'installed')
            throw new Error('This data replacement is no longer awaiting confirmation.');
          await writeJournal(lock, { ...journal, phase: 'committed' });
          outcome = 'committed';
          state.installedJob = undefined;
          // The durable committed marker is sufficient if cleanup is interrupted.
          // Startup will finish the result record before deleting the journal.
          try {
            await writeResult(lock, jobId, 'committed');
            await removeJournal(lock);
          } catch {
            // The data is committed. Leave its authoritative journal for recovery.
          }
        });
      },
      async rollback() {
        if (outcome === 'rolled-back') return;
        if (outcome !== 'pending')
          throw new Error('A committed data replacement cannot be rolled back.');
        await exclusive(lock, false, async () => {
          state.installedJob = undefined;
          const journal = await readJournal(lock);
          if (journal?.jobId !== jobId || journal.phase === 'committed')
            throw new Error('This data replacement is no longer awaiting confirmation.');
          await rollbackJournal(lock, journal);
          outcome = 'rolled-back';
        });
      },
    };
  });
}
