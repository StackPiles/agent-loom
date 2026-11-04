import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export const UPDATE_ORIGIN = 'https://github.com/StackPiles/agent-loom.git';
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const JOURNAL_PHASES = new Set([
  'prepared',
  'snapshot',
  'switching',
  'installing',
  'building',
  'verifying',
  'committed',
  'rolled-back',
]);
const timestamp = () => new Date().toISOString();
const safeError = (error) => String(error?.message || error || 'Update failed.').slice(0, 600);

async function exitedWithin(exited, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise((done) => {
        timer = setTimeout(() => done(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function regular(path, directory = false) {
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  )
    throw new Error(`The update requires a regular ${directory ? 'directory' : 'file'}: ${path}`);
  return stat;
}

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: true });
  await regular(path, true);
  await chmod(path, 0o700).catch(() => {});
}

async function durableJson(path, value) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  let directory;
  try {
    directory = await open(dirname(path), constants.O_RDONLY);
    await directory.sync();
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    await directory?.close();
  }
}

async function readJson(path) {
  const stat = await regular(path);
  if (stat.size > 64 * 1024) throw new Error('The update metadata is too large.');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function durableCopy(source, destination) {
  await regular(source);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600).catch(() => {});
  const file = await open(destination, 'r+');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Execute argv directly. Command output is bounded and never included in API errors. */
export async function runCommand(command, args, options = {}) {
  const { cwd, env = process.env, timeout = 60_000, maxBytes = 2_000_000 } = options;
  return new Promise((complete, fail) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let bytes = 0;
    let failure;
    let stopping;
    const terminate = (reason) => {
      if (stopping) return;
      failure = reason;
      stopping = (async () => {
        if (!child.pid) return;
        if (process.platform === 'win32') {
          await new Promise((done) => {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
            });
            killer.once('error', done);
            killer.once('exit', done);
          });
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') child.kill('SIGKILL');
          }
        }
      })();
    };
    const collect = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) terminate(new Error('An update command exceeded its output limit.'));
      else output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(
      () => terminate(new Error('An update command exceeded its time limit.')),
      timeout,
    );
    child.once('error', (error) => {
      clearTimeout(timer);
      fail(
        new Error(`Could not start ${command === process.execPath ? 'Node.js' : 'Git'}.`, {
          cause: error,
        }),
      );
    });
    child.once('close', async (code) => {
      clearTimeout(timer);
      await stopping;
      if (failure) return fail(failure);
      complete({ code: code ?? 1, stdout: output });
    });
  });
}

function within(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

/** The original implementation is copied before dist is moved, so recovery can acquire its lease. */
function defaultSnapshots() {
  return {
    async lock(journal, jobDir) {
      const helper = join(jobDir, 'data-directory.mjs');
      await regular(helper);
      const { DataDirectoryLock } = await import(pathToFileURL(helper).href);
      const lease = new DataDirectoryLock(journal.dataDir);
      return () => lease.close();
    },
    async backup(journal, jobDir) {
      const dbPath = join(journal.dataDir, 'loom.sqlite');
      await regular(dbPath);
      await regular(join(journal.dataDir, 'secret.key'));
      const database = new DatabaseSync(dbPath);
      try {
        database.exec(
          'PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT; PRAGMA wal_checkpoint(TRUNCATE);',
        );
      } finally {
        database.close();
      }
      await durableCopy(dbPath, join(jobDir, 'loom.sqlite'));
      await durableCopy(join(journal.dataDir, 'secret.key'), join(jobDir, 'secret.key'));
    },
    async restore(journal, jobDir) {
      // The owning data lease is held. No app has accepted work since this snapshot.
      for (const name of ['loom.sqlite', 'secret.key']) {
        const source = join(jobDir, name);
        const destination = join(journal.dataDir, name);
        await regular(source);
        if (await exists(destination)) await regular(destination);
        const temporary = `${destination}.update-${journal.id}.tmp`;
        await rm(temporary, { force: true });
        await durableCopy(source, temporary);
        await rename(temporary, destination);
      }
      for (const suffix of ['-wal', '-shm', '-journal']) {
        const path = join(journal.dataDir, `loom.sqlite${suffix}`);
        if (await exists(path)) {
          await regular(path);
          await rm(path);
        }
      }
    },
  };
}

/** A real server process, with graceful cross-platform shutdown over IPC. */
export function spawnServer(options) {
  const nonce = randomBytes(24).toString('hex');
  const env = {
    ...options.env,
    LOOM_DATA_DIR: options.dataDir,
    LOOM_UPDATE_SUPERVISOR: '1',
    LOOM_UPDATE_COMMIT: options.commit,
    LOOM_UPDATE_NONCE: nonce,
    LOOM_UPDATE_STATE_FILE: options.stateFile,
  };
  delete env.LOOM_UPDATE_VERIFY;
  if (options.verify) env.LOOM_UPDATE_VERIFY = '1';
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    cwd: options.root,
    env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  let resolveExit;
  const exited = new Promise((done) => {
    resolveExit = done;
  });
  let exitResult;
  const waiters = new Set();
  const waitFor = (type, timeout = 45_000) =>
    new Promise((done, fail) => {
      const waiter = { type, done, fail, timer: undefined };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        fail(new Error(`The server did not acknowledge ${type} in time.`));
      }, timeout);
      waiters.add(waiter);
      if (exitResult) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        fail(new Error('The server exited before it was ready.'));
      }
    });
  const ready = waitFor('loom:ready');
  // The caller awaits this promise, but it may first need to finish filesystem work.
  ready.catch(() => {});
  child.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'loom:ready' || message.type === 'loom:activated') {
      if (message.nonce !== nonce) return;
      for (const waiter of [...waiters]) {
        if (waiter.type !== message.type) continue;
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.done(message);
      }
    } else options.onMessage?.(message);
  });
  const finish = (result) => {
    if (exitResult) return;
    exitResult = result;
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.fail(new Error('The server exited before it was ready.'));
    }
    waiters.clear();
    resolveExit(result);
  };
  child.once('error', () => finish({ code: 1, signal: null }));
  child.once('exit', (code, signal) => finish({ code, signal }));
  const send = (message) => {
    if (!child.connected) return false;
    child.send(message, (error) => {
      if (error) options.onSendError?.(error);
    });
    return true;
  };
  return {
    ready,
    exited,
    send,
    async activate() {
      const activated = waitFor('loom:activated');
      if (!send({ type: 'loom:activate', nonce })) {
        activated.catch(() => {});
        throw new Error('The server IPC channel closed.');
      }
      await activated;
    },
    async stop() {
      if (exitResult) return;
      send({ type: 'loom:shutdown' });
      const graceful = await exitedWithin(exited, 30_000);
      if (graceful) return;
      child.kill('SIGKILL');
      if (!(await exitedWithin(exited, 5_000)))
        throw new Error('The server could not be stopped. Its files were not replaced.');
    },
  };
}

/**
 * Own one native installation. Adapters are test seams; production never accepts
 * a command, repository URL, filesystem path, or environment from the Web API.
 */
export function createUpdateLauncher(options) {
  const root = resolve(options.root);
  const dataDir = resolve(options.dataDir);
  const base = join(root, '.git', 'loom-updates');
  const stateFile = join(base, 'status.json');
  const journalFile = join(base, 'journal.json');
  const env = { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };
  const run = options.run ?? runCommand;
  const boot = options.boot ?? spawnServer;
  const snapshots = options.snapshots ?? defaultSnapshots();
  let installationLease;
  let current;
  let currentCommit;
  let active;
  let stopped = false;
  let transition = false;
  let journal;
  let job;
  let dataLease;
  let starting;
  let closing;

  async function command(program, args, settings = {}) {
    const result = await run(program, args, { cwd: root, env, ...settings });
    if (result.code !== 0) {
      const error = new Error(settings.label || 'An update command failed.');
      error.exitCode = result.code;
      throw error;
    }
    return result.stdout.trim();
  }
  const git = (args, settings) => command('git', args, settings);
  const jobDir = () => join(base, journal.id);
  const saveJournal = () => durableJson(journalFile, journal);
  async function status(phase, extra = {}) {
    job = { ...job, phase, ...extra, updatedAt: timestamp() };
    await durableJson(stateFile, job);
  }
  async function phase(value) {
    journal.phase = value;
    await saveJournal();
  }

  async function inspectCheckout(expected) {
    await regular(join(root, '.git'), true);
    if ((await realpath(await git(['rev-parse', '--show-toplevel']))) !== (await realpath(root)))
      throw new Error('Web updates require the root of a standalone Git clone.');
    if ((await git(['symbolic-ref', '--short', 'HEAD'])) !== 'main')
      throw new Error('Switch to the main branch before updating from Loom.');
    const origin = await git(['remote', 'get-url', '--all', 'origin']);
    if (
      ![
        UPDATE_ORIGIN,
        'https://github.com/StackPiles/agent-loom',
        'git@github.com:StackPiles/agent-loom.git',
        'ssh://git@github.com/StackPiles/agent-loom.git',
      ].includes(origin)
    )
      throw new Error('Web updates require the official StackPiles/agent-loom origin.');
    if (await git(['status', '--porcelain=v1', '--untracked-files=all']))
      throw new Error('The source has local changes. Commit or move them before updating.');
    if (/^[a-zS]/m.test(await git(['ls-files', '-v'])))
      throw new Error('Remove assume-unchanged or skip-worktree flags before updating.');
    const head = await git(['rev-parse', 'HEAD']);
    if (!SHA.test(head) || (expected && head !== expected))
      throw new Error('The installed source changed. Restart Loom before updating.');
    return head;
  }

  async function fetchTarget() {
    await git(['fetch', '--no-tags', '--no-recurse-submodules', UPDATE_ORIGIN, 'refs/heads/main'], {
      timeout: 120_000,
      label: 'Could not download the official update. Check the network connection and try again.',
    });
    if ((await git(['rev-parse', 'FETCH_HEAD'])) !== journal.targetSha)
      throw new Error('The available update changed. Check for updates again.');
    await git(['merge-base', '--is-ancestor', journal.previousSha, journal.targetSha], {
      label: 'The local main branch diverged from the official update. Update it manually.',
    });
    const pkg = JSON.parse(await git(['show', `${journal.targetSha}:package.json`]));
    if (pkg.loomUpdateProtocol !== 1 || pkg.version !== journal.targetVersion)
      throw new Error('This version needs a manual update or a newer updater.');
    const tracked = (await git(['ls-tree', '-r', '--name-only', journal.targetSha])).split('\n');
    for (const name of tracked) {
      if (
        (/^\.env(?:$|[./])/.test(name) && name !== '.env.example') ||
        /^(?:\.loom|node_modules|dist)(?:\/|$)/.test(name) ||
        within(dataDir, resolve(root, name)) ||
        within(resolve(root, name), dataDir)
      )
        throw new Error('The update would overlap local settings or application data.');
    }
    await inspectCheckout(journal.previousSha);
  }

  function notify(message) {
    current?.send(message);
  }
  async function startServer(commit, verify = false) {
    const server = boot({
      root,
      dataDir,
      stateFile,
      env,
      commit,
      verify,
      onMessage(message) {
        if (current !== server) return;
        if (message.type === 'loom:update') void request(message);
        if (message.type === 'loom:update:proceed') proceed(message.id);
      },
    });
    current = server;
    currentCommit = commit;
    server.exited.then((result) => {
      if (current === server && !transition && !stopped) {
        if (active?.waiting) void cancelWaiting('The server disconnected before the update began.');
        options.onExit?.(result);
      }
    });
    const ready = await server.ready;
    if (ready.commit !== commit || (verify && ready.version !== journal.targetVersion))
      throw new Error('The restarted server did not report the expected version and commit.');
    return server;
  }

  async function releaseData() {
    if (!dataLease) return;
    const close = dataLease;
    dataLease = undefined;
    await close();
  }

  async function lockData() {
    const unchanged = async () => {
      const actual = await realpath(dataDir);
      await regular(actual, true);
      const identity = await lstat(actual, { bigint: true });
      if (
        actual !== journal.dataRealPath ||
        String(identity.dev) !== journal.dataDevice ||
        String(identity.ino) !== journal.dataInode
      )
        throw new Error(
          'The application data directory was replaced or moved. Recovery files were retained.',
        );
    };
    await unchanged();
    const release = await snapshots.lock(journal, jobDir());
    try {
      await unchanged();
      return release;
    } catch (error) {
      await release();
      throw error;
    }
  }

  async function rollback() {
    if (journal.phase === 'committed')
      throw new Error('The new version was committed. Automatic data rollback is no longer safe.');
    if (current) {
      await current.stop();
      current = undefined;
    }
    dataLease ??= await lockData();
    const head = await inspectCheckout();
    if (![journal.previousSha, journal.targetSha].includes(head))
      throw new Error('The source changed outside this update. Recovery files were retained.');
    if (head !== journal.previousSha)
      await git(['reset', '--keep', journal.previousSha], {
        label: 'The source could not be safely restored. Recovery files were retained.',
      });
    for (const [live, backup] of [
      ['dist', 'previous-dist'],
      ['node_modules', 'previous-node_modules'],
    ]) {
      const saved = join(jobDir(), backup);
      if (!(await exists(saved))) continue;
      await regular(saved, true);
      const destination = join(root, live);
      if (await exists(destination)) {
        await regular(destination, true);
        await rm(destination, { recursive: true });
      }
      await rename(saved, destination);
    }
    if (journal.snapshotReady) await snapshots.restore(journal, jobDir());
    await phase('rolled-back');
    await releaseData();
  }

  async function execute() {
    transition = true;
    let stoppedOld = false;
    try {
      await fetchTarget();
      await status('stopping');
      stoppedOld = true;
      await current.stop();
      current = undefined;
      dataLease = await lockData();
      await snapshots.backup(journal, jobDir());
      journal.snapshotReady = true;
      await phase('snapshot');
      await inspectCheckout(journal.previousSha);
      await phase('switching');
      for (const [live, backup] of [
        ['dist', 'previous-dist'],
        ['node_modules', 'previous-node_modules'],
      ]) {
        await regular(join(root, live), true);
        await rename(join(root, live), join(jobDir(), backup));
      }
      await phase('installing');
      await status('installing');
      await git(
        [
          '-c',
          `core.hooksPath=${join(jobDir(), 'hooks')}`,
          'merge',
          '--ff-only',
          '--no-edit',
          journal.targetSha,
        ],
        {
          label: 'The update could not be applied without overwriting source changes.',
        },
      );
      await command(
        process.execPath,
        [env.npm_execpath, 'ci', '--include=dev', '--no-audit', '--no-fund'],
        {
          timeout: 600_000,
          label:
            'Installing the update dependencies failed. The previous version will be restored.',
        },
      );
      await phase('building');
      await status('building');
      await command(process.execPath, [env.npm_execpath, 'run', 'build'], {
        timeout: 600_000,
        label: 'Building the update failed. The previous version will be restored.',
      });
      await inspectCheckout(journal.targetSha);
      await phase('verifying');
      await status('verifying');
      await releaseData();
      const server = await startServer(journal.targetSha, true);
      // This is the point of no return for data. Persist it before allowing effects.
      await phase('committed');
      await server.activate();
      await status('succeeded', { error: undefined, rolledBack: undefined });
    } catch (error) {
      const message = safeError(error);
      if (journal.phase === 'committed') {
        await status('failed', {
          error: `${message} The new version was committed; data was not rolled back.`,
          rolledBack: false,
        });
        options.onFatal?.(
          new Error('The committed update needs a restart. Data was not rolled back.'),
        );
      } else if (stoppedOld) {
        try {
          await rollback();
          await startServer(journal.previousSha);
          await status('failed', { error: message, rolledBack: true });
        } catch (recoveryError) {
          await releaseData();
          await status('failed', {
            error: `${message} Automatic recovery could not finish. Recovery files were retained.`,
            rolledBack: false,
          });
          options.onFatal?.(new Error(safeError(recoveryError)));
        }
      } else {
        await phase('rolled-back');
        await status('failed', { error: message, rolledBack: true });
        notify({ type: 'loom:update:finished', id: journal.id, succeeded: false, error: message });
      }
    } finally {
      await releaseData();
      transition = false;
      active = undefined;
    }
  }

  async function cancelWaiting(message) {
    if (!active?.waiting) return;
    clearTimeout(active.timer);
    active.waiting = false;
    await phase('rolled-back');
    await status('failed', { error: message, rolledBack: true });
    notify({ type: 'loom:update:finished', id: journal.id, succeeded: false, error: message });
    active = undefined;
  }

  async function request(input) {
    const reject = (error) =>
      notify({
        type: 'loom:update:rejected',
        requestId: input?.requestId,
        error: safeError(error),
      });
    if (stopped || active) return reject(new Error('Another update is already in progress.'));
    if (
      !input ||
      !['id', 'requestId', 'targetSha', 'targetVersion'].every(
        (key) => typeof input[key] === 'string',
      ) ||
      !ID.test(input.id) ||
      !ID.test(input.requestId) ||
      !SHA.test(input.targetSha) ||
      !VERSION.test(input.targetVersion) ||
      input.targetVersion.length > 80
    )
      return reject(new Error('The update request is invalid.'));
    active = { waiting: false, id: input.id };
    let prepared;
    active.preparation = new Promise((done) => {
      prepared = done;
    });
    try {
      const previousSha = await inspectCheckout(currentCommit);
      if (stopped) throw new Error('Loom is stopping. The update was not started.');
      if (previousSha === input.targetSha) throw new Error('This update is already installed.');
      if (
        !isAbsolute(env.npm_execpath || '') ||
        !/npm-cli\.(?:c?js|mjs)$/.test(env.npm_execpath || '')
      )
        throw new Error('Start Loom with npm start to enable Web updates.');
      await regular(env.npm_execpath);
      const actualRoot = await realpath(root);
      const dataRealPath = await realpath(dataDir);
      await regular(dataRealPath, true);
      const dataIdentity = await lstat(dataRealPath, { bigint: true });
      if (
        within(dataRealPath, actualRoot) ||
        within(join(actualRoot, '.git'), dataRealPath) ||
        within(join(actualRoot, 'dist'), dataRealPath) ||
        within(join(actualRoot, 'node_modules'), dataRealPath)
      )
        throw new Error('The data directory overlaps files needed by the updater.');
      const directory = join(base, input.id);
      if (await exists(directory))
        throw new Error('This update request was already used. Check for updates again.');
      await privateDirectory(directory);
      await privateDirectory(join(directory, 'hooks'));
      await durableCopy(
        join(root, 'dist', 'server', 'data-directory.js'),
        join(directory, 'data-directory.mjs'),
      );
      journal = {
        format: 1,
        id: input.id,
        root,
        dataDir,
        dataRealPath,
        dataDevice: String(dataIdentity.dev),
        dataInode: String(dataIdentity.ino),
        previousSha,
        targetSha: input.targetSha,
        targetVersion: input.targetVersion,
        startedAt: timestamp(),
        phase: 'prepared',
        snapshotReady: false,
      };
      job = {
        id: input.id,
        phase: 'preparing',
        targetSha: input.targetSha,
        targetVersion: input.targetVersion,
        previousSha,
        startedAt: journal.startedAt,
        updatedAt: timestamp(),
      };
      await saveJournal();
      await status('preparing');
      if (stopped) throw new Error('Loom is stopping. The update was not started.');
      active.waiting = true;
      active.timer = setTimeout(() => {
        void cancelWaiting('The update was not started. Try again from Settings.');
      }, options.proceedTimeout ?? 30_000);
      notify({ type: 'loom:update:accepted', requestId: input.requestId, id: input.id });
    } catch (error) {
      active = undefined;
      reject(error);
    } finally {
      prepared();
    }
  }

  function proceed(id) {
    if (stopped || !active?.waiting || active.id !== id) return false;
    clearTimeout(active.timer);
    active.waiting = false;
    active.promise = execute();
    active.promise.catch((error) => options.onFatal?.(error));
    return true;
  }

  async function recover() {
    if (!(await exists(journalFile))) return;
    journal = await readJson(journalFile);
    if (
      journal.format !== 1 ||
      typeof journal.id !== 'string' ||
      !ID.test(journal.id) ||
      !SHA.test(journal.previousSha) ||
      !SHA.test(journal.targetSha) ||
      !VERSION.test(journal.targetVersion) ||
      !JOURNAL_PHASES.has(journal.phase) ||
      typeof journal.snapshotReady !== 'boolean'
    )
      throw new Error(
        'The update journal does not match this installation. Recovery files were retained.',
      );
    // The journal is authoritative. A crash can occur between the two durable writes.
    job = await readJson(stateFile).catch(() => undefined);
    if (
      job?.id !== journal.id ||
      job?.previousSha !== journal.previousSha ||
      job?.targetSha !== journal.targetSha ||
      job?.targetVersion !== journal.targetVersion
    )
      job = {
        id: journal.id,
        phase: 'preparing',
        previousSha: journal.previousSha,
        targetSha: journal.targetSha,
        targetVersion: journal.targetVersion,
        startedAt: journal.startedAt || timestamp(),
        updatedAt: timestamp(),
      };
    if (journal.phase === 'rolled-back') {
      // A crash after the terminal journal write must not leave a permanently
      // active UI receipt. No data restoration remains, even if paths changed.
      if (job.phase !== 'failed' || job.rolledBack !== true)
        await status('failed', {
          error: 'An interrupted update was rolled back. The installed version will be started.',
          rolledBack: true,
        });
      return;
    }
    // Finished history can survive moving the installation or choosing a new
    // data directory. It must never restore an old snapshot into the new one.
    if (journal.phase === 'committed' && job.phase === 'succeeded') return;
    if (
      journal.root !== root ||
      journal.dataDir !== dataDir ||
      typeof journal.dataRealPath !== 'string' ||
      !isAbsolute(journal.dataRealPath) ||
      typeof journal.dataDevice !== 'string' ||
      !/^\d{1,30}$/.test(journal.dataDevice) ||
      typeof journal.dataInode !== 'string' ||
      !/^\d{1,30}$/.test(journal.dataInode)
    )
      throw new Error(
        'The update journal does not match this installation. Recovery files were retained.',
      );
    await regular(jobDir(), true);
    if (journal.phase === 'committed') {
      // A finished receipt must not prevent later manual updates or development.
      // Only an interrupted commit still needs the exact expected checkout.
      await inspectCheckout(journal.targetSha);
      return;
    }
    transition = true;
    try {
      if (journal.phase !== 'prepared') await rollback();
      else await phase('rolled-back');
      await status('failed', {
        error: 'An interrupted update was recovered. The previous version is running.',
        rolledBack: true,
      });
    } finally {
      await releaseData();
      transition = false;
    }
  }

  async function initialize() {
    if (stopped) throw new Error('The launcher has already stopped.');
    await regular(join(root, '.git'), true);
    await privateDirectory(base);
    const lockPath = join(base, 'supervisor.sqlite');
    if (await exists(lockPath)) await regular(lockPath);
    installationLease = new DatabaseSync(lockPath);
    try {
      installationLease.exec(
        'PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY); INSERT OR REPLACE INTO owner VALUES(1); COMMIT;',
      );
      await chmod(lockPath, 0o600).catch(() => {});
      await recover();
      if (stopped) return;
      const commit = await git(['rev-parse', 'HEAD']);
      if (!SHA.test(commit)) throw new Error('Could not identify the installed commit.');
      if (stopped) return;
      transition = true;
      const server = await startServer(commit);
      if (journal?.phase === 'committed' && job?.phase !== 'succeeded')
        await status('succeeded', { error: undefined, rolledBack: undefined });
      transition = false;
      return server;
    } catch (error) {
      await current?.stop().catch(() => {});
      installationLease.close();
      installationLease = undefined;
      transition = false;
      throw error;
    }
  }

  return {
    stateFile,
    request,
    proceed,
    get busy() {
      return Boolean(active);
    },
    async settled() {
      await active?.promise;
    },
    start() {
      starting ??= initialize();
      return starting;
    },
    close() {
      closing ??= (async () => {
        stopped = true;
        await active?.preparation;
        if (active?.waiting) await cancelWaiting('Loom stopped before the update began.');
        // An in-progress filesystem transaction finishes before releasing ownership.
        await active?.promise;
        await current?.stop();
        await starting?.catch(() => {});
        await releaseData();
        installationLease?.close();
        installationLease = undefined;
      })();
      return closing;
    },
  };
}
