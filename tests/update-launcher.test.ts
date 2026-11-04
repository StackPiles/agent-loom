import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DataDirectoryLock } from '../src/server/data-directory.ts';
import {
  createUpdateLauncher,
  runCommand,
  spawnServer,
  UPDATE_ORIGIN,
} from '../scripts/update-launcher.mjs';

const helper = `export { DataDirectoryLock } from ${JSON.stringify(
  pathToFileURL(resolve('src/server/data-directory.ts')).href,
)};\n`;

async function git(cwd: string, args: string[]) {
  const result = await runCommand('git', args, { cwd });
  assert.equal(result.code, 0, result.stdout);
  return result.stdout.trim();
}

function dataValue(directory: string, value?: number) {
  const db = new DatabaseSync(join(directory, 'loom.sqlite'));
  try {
    if (value !== undefined) db.prepare('UPDATE test_value SET value=?').run(value);
    return (db.prepare('SELECT value FROM test_value').get() as { value: number }).value;
  } finally {
    db.close();
  }
}

async function fixture(t: test.TestContext, behavior: Record<string, unknown> = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'loom-updater-'));
  const root = join(temporary, 'installation with spaces');
  const upstream = join(temporary, 'upstream.git');
  const dataDir = join(root, '.loom');
  const npm = join(temporary, 'npm-cli.js');
  await mkdir(root);
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Loom updater fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, '.gitignore'), '.loom/\n.env\ndist/\nnode_modules/\n');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ version: '0.6.0', loomUpdateProtocol: 1 }),
  );
  await writeFile(join(root, 'source.txt'), 'previous source\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'Previous fixture version']);
  const previousSha = await git(root, ['rev-parse', 'HEAD']);
  await git(root, ['clone', '--bare', root, upstream]);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ version: '0.6.1', loomUpdateProtocol: 1 }),
  );
  await writeFile(join(root, 'source.txt'), 'updated source\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'Updated fixture version']);
  const targetSha = await git(root, ['rev-parse', 'HEAD']);
  await git(root, ['push', upstream, 'main']);
  await git(root, ['reset', '--hard', previousSha]);
  await git(root, ['remote', 'add', 'origin', UPDATE_ORIGIN]);
  await mkdir(dataDir);
  await mkdir(join(dataDir, 'workspace'));
  await writeFile(join(dataDir, 'workspace', 'user-file.txt'), 'Keep this user work.');
  await writeFile(join(dataDir, 'secret.key'), Buffer.alloc(32, 7));
  const database = new DatabaseSync(join(dataDir, 'loom.sqlite'));
  database.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE test_value(value INTEGER); INSERT INTO test_value VALUES(42);',
  );
  database.close();
  await writeFile(join(root, '.env'), 'LOOM_PORT=3210\n');
  await mkdir(join(root, 'dist', 'server'), { recursive: true });
  await writeFile(join(root, 'dist', 'server', 'data-directory.js'), helper);
  await writeFile(join(root, 'dist', 'version.txt'), 'previous build');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'version.txt'), 'previous dependencies');
  await writeFile(npm, '// This test never executes npm.\n');

  const messages: Record<string, unknown>[] = [];
  const commands: string[] = [];
  const servers: { verify: boolean; stopped: boolean; activated: boolean }[] = [];
  const failures: Error[] = [];
  const launchers: ReturnType<typeof createUpdateLauncher>[] = [];
  const options = {
    root,
    dataDir,
    env: { ...process.env, npm_execpath: npm },
    async run(program: string, args: string[], settings: Record<string, unknown>) {
      if (typeof behavior.beforeCommand === 'function') await behavior.beforeCommand(program, args);
      if (program === 'git') {
        // Fetch only from the isolated fixture. No test contacts a real upstream.
        return runCommand(
          program,
          args.map((arg) => (arg === UPDATE_ORIGIN ? upstream : arg)),
          settings,
        );
      }
      assert.equal(program, process.execPath);
      assert.equal(args[0], npm);
      commands.push(args.slice(1).join(' '));
      if (args[1] === 'ci') {
        await mkdir(join(root, 'node_modules'), { recursive: true });
        await writeFile(join(root, 'node_modules', 'version.txt'), 'updated dependencies');
        return { code: behavior.installFails ? 1 : 0, stdout: '' };
      }
      assert.deepEqual(args.slice(1), ['run', 'build']);
      await mkdir(join(root, 'dist', 'server'), { recursive: true });
      await writeFile(join(root, 'dist', 'server', 'data-directory.js'), helper);
      await writeFile(join(root, 'dist', 'version.txt'), 'updated build');
      return { code: behavior.buildFails ? 1 : 0, stdout: '' };
    },
    boot(input: { verify: boolean; commit: string; root: string; dataDir: string }) {
      const lease = new DataDirectoryLock(input.dataDir);
      const record = { verify: input.verify, stopped: false, activated: false };
      servers.push(record);
      let finish!: (value: { code: number }) => void;
      const exited = new Promise<{ code: number }>((done) => {
        finish = done;
      });
      const ready = Promise.resolve().then(async () => {
        if (input.verify) dataValue(input.dataDir, 99); // Simulate a startup migration.
        if (input.verify && behavior.bootFails) throw new Error('Fixture startup failed.');
        const pkg = JSON.parse(await readFile(join(input.root, 'package.json'), 'utf8'));
        return { type: 'loom:ready', version: pkg.version, commit: input.commit };
      });
      return {
        ready,
        exited,
        send(message: Record<string, unknown>) {
          messages.push(message);
          return true;
        },
        async stop() {
          if (record.stopped) return;
          record.stopped = true;
          lease.close();
          finish({ code: 0 });
        },
        async activate() {
          record.activated = true;
          const journal = JSON.parse(
            await readFile(join(input.root, '.git', 'loom-updates', 'journal.json'), 'utf8'),
          );
          assert.equal(
            journal.phase,
            'committed',
            'Commit must be durable before effects are enabled.',
          );
          dataValue(input.dataDir, 100);
          if (behavior.activateFails)
            throw new Error('Fixture activation acknowledgment was lost.');
        },
      };
    },
    onFatal(error: Error) {
      failures.push(error);
    },
  };
  const create = (overrides: Record<string, unknown> = {}) => {
    const launcher = createUpdateLauncher({ ...options, ...overrides });
    launchers.push(launcher);
    return launcher;
  };
  t.after(async () => {
    for (const launcher of launchers) await launcher.close();
    await rm(temporary, { recursive: true, force: true });
  });
  const input = {
    type: 'loom:update',
    requestId: 'request-1',
    id: 'update-1',
    targetSha,
    targetVersion: '0.6.1',
  };
  const status = async () =>
    JSON.parse(await readFile(join(root, '.git', 'loom-updates', 'status.json'), 'utf8'));
  return {
    root,
    dataDir,
    upstream,
    previousSha,
    targetSha,
    create,
    input,
    status,
    messages,
    commands,
    servers,
    failures,
  };
}

test('updater waits for response completion, updates a fixture, and activates only after durable commit', async (t) => {
  const f = await fixture(t);
  const launcher = f.create();
  await launcher.start();
  await launcher.request(f.input);
  assert.equal(f.messages.at(-1)?.type, 'loom:update:accepted');
  assert.equal(f.servers[0].stopped, false);
  assert.equal(await git(f.root, ['rev-parse', 'HEAD']), f.previousSha);
  assert.equal(launcher.proceed('wrong-job'), false);
  assert.equal(launcher.proceed(f.input.id), true);
  assert.equal(launcher.proceed(f.input.id), false);
  await launcher.settled();
  assert.equal((await f.status()).phase, 'succeeded');
  assert.equal(await git(f.root, ['rev-parse', 'HEAD']), f.targetSha);
  assert.equal(f.servers[0].stopped, true);
  assert.equal(f.servers[1].verify, true);
  assert.equal(f.servers[1].activated, true);
  assert.equal(dataValue(f.dataDir), 100);
  assert.equal(await readFile(join(f.root, '.env'), 'utf8'), 'LOOM_PORT=3210\n');
  assert.equal(
    await readFile(join(f.dataDir, 'workspace', 'user-file.txt'), 'utf8'),
    'Keep this user work.',
  );
  assert.equal(await readFile(join(f.root, 'dist', 'version.txt'), 'utf8'), 'updated build');
  assert.deepEqual(f.commands, ['ci --include=dev --no-audit --no-fund', 'run build']);
  assert.deepEqual(f.failures, []);
});

for (const failure of ['installFails', 'buildFails', 'bootFails']) {
  test(`updater restores the exact previous source, artifacts and data after ${failure}`, async (t) => {
    const f = await fixture(t, { [failure]: true });
    const launcher = f.create();
    await launcher.start();
    await launcher.request(f.input);
    launcher.proceed(f.input.id);
    await launcher.settled();
    const status = await f.status();
    assert.equal(status.phase, 'failed');
    assert.equal(status.rolledBack, true);
    assert.equal(await git(f.root, ['rev-parse', 'HEAD']), f.previousSha);
    assert.equal(await readFile(join(f.root, 'dist', 'version.txt'), 'utf8'), 'previous build');
    assert.equal(
      await readFile(join(f.root, 'node_modules', 'version.txt'), 'utf8'),
      'previous dependencies',
    );
    assert.equal(dataValue(f.dataDir), 42);
    assert.deepEqual(await readFile(join(f.dataDir, 'secret.key')), Buffer.alloc(32, 7));
    assert.equal(f.servers.at(-1)?.stopped, false);
    assert.equal(f.servers.at(-1)?.verify, false);
    assert.deepEqual(f.failures, []);
  });
}

test('updater never rolls data back after activation becomes possible', async (t) => {
  const f = await fixture(t, { activateFails: true });
  const launcher = f.create();
  await launcher.start();
  await launcher.request(f.input);
  launcher.proceed(f.input.id);
  await launcher.settled();
  assert.equal((await f.status()).phase, 'failed');
  assert.equal((await f.status()).rolledBack, false);
  assert.equal(dataValue(f.dataDir), 100);
  assert.equal(await git(f.root, ['rev-parse', 'HEAD']), f.targetSha);
  assert.equal(f.failures.length, 1);
});

test('a successful update receipt does not block later manual source updates and normal startup', async (t) => {
  const f = await fixture(t);
  const first = f.create();
  await first.start();
  await first.request(f.input);
  first.proceed(f.input.id);
  await first.settled();
  await first.close();
  await writeFile(join(f.root, 'source.txt'), 'A later manually installed version.');
  await git(f.root, ['add', 'source.txt']);
  await git(f.root, ['commit', '-m', 'Later manual update']);
  const manualSha = await git(f.root, ['rev-parse', 'HEAD']);
  const second = f.create();
  await second.start();
  assert.equal(await git(f.root, ['rev-parse', 'HEAD']), manualSha);
  assert.equal(dataValue(f.dataDir), 100);
  assert.equal(f.servers.at(-1)?.stopped, false);
  assert.equal((await f.status()).phase, 'succeeded');
});

test('finished update history permits moving the installation without restoring its old snapshot', async (t) => {
  const f = await fixture(t);
  const first = f.create();
  await first.start();
  await first.request(f.input);
  first.proceed(f.input.id);
  await first.settled();
  await first.close();
  const movedRoot = join(dirname(f.root), 'moved installation');
  await rename(f.root, movedRoot);
  const movedData = join(movedRoot, '.loom');
  const second = f.create({ root: movedRoot, dataDir: movedData });
  await second.start();
  assert.equal(dataValue(movedData), 100);
  assert.equal(await git(movedRoot, ['rev-parse', 'HEAD']), f.targetSha);
  assert.equal(f.servers.at(-1)?.stopped, false);
});

test('rolled-back history permits choosing a different data directory and leaves both databases alone', async (t) => {
  const f = await fixture(t, { buildFails: true });
  const first = f.create();
  await first.start();
  await first.request(f.input);
  first.proceed(f.input.id);
  await first.settled();
  await first.close();
  const otherData = join(dirname(f.root), 'other data');
  await mkdir(otherData);
  await copyFile(join(f.dataDir, 'loom.sqlite'), join(otherData, 'loom.sqlite'));
  await writeFile(join(otherData, 'secret.key'), Buffer.alloc(32, 9));
  dataValue(otherData, 777);
  const second = f.create({ dataDir: otherData });
  await second.start();
  assert.equal(dataValue(otherData), 777);
  assert.equal(dataValue(f.dataDir), 42);
  assert.deepEqual(await readFile(join(otherData, 'secret.key')), Buffer.alloc(32, 9));
});

test('updater rejects dirty source and a nonofficial origin without stopping the server', async (t) => {
  const f = await fixture(t);
  const launcher = f.create();
  await launcher.start();
  await writeFile(join(f.root, 'source.txt'), 'User edits that must survive.');
  await launcher.request(f.input);
  assert.equal(f.messages.at(-1)?.type, 'loom:update:rejected');
  assert.match(String(f.messages.at(-1)?.error), /local changes/);
  assert.equal(f.servers[0].stopped, false);
  await git(f.root, ['checkout', '--', 'source.txt']);
  await git(f.root, ['remote', 'set-url', 'origin', 'https://example.invalid/fork.git']);
  await launcher.request(f.input);
  assert.match(String(f.messages.at(-1)?.error), /official/);
  assert.equal(f.servers[0].stopped, false);
  assert.equal(f.commands.length, 0);
});

test('updater refuses diverged history and notifies the live server to leave maintenance', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'local.txt'), 'Local committed change.');
  await git(f.root, ['add', 'local.txt']);
  await git(f.root, ['commit', '-m', 'Local divergence']);
  const localSha = await git(f.root, ['rev-parse', 'HEAD']);
  const launcher = f.create();
  await launcher.start();
  await launcher.request(f.input);
  launcher.proceed(f.input.id);
  await launcher.settled();
  assert.match((await f.status()).error, /diverged/);
  assert.equal(f.messages.at(-1)?.type, 'loom:update:finished');
  assert.equal(f.servers[0].stopped, false);
  assert.equal(await git(f.root, ['rev-parse', 'HEAD']), localSha);
  assert.equal(f.commands.length, 0);
});

test('updater rejects a changed upstream target before stopping or installing', async (t) => {
  const f = await fixture(t);
  const launcher = f.create();
  await launcher.start();
  await launcher.request({ ...f.input, targetSha: 'a'.repeat(40) });
  launcher.proceed(f.input.id);
  await launcher.settled();
  assert.match((await f.status()).error, /available update changed/);
  assert.equal(f.servers[0].stopped, false);
  assert.equal(f.commands.length, 0);
});

async function interruptedFixture(t: test.TestContext, committed = false) {
  const f = await fixture(t);
  const first = f.create();
  await first.start();
  await first.request(f.input);
  await first.close();
  const base = join(f.root, '.git', 'loom-updates');
  const directory = join(base, f.input.id);
  await copyFile(join(f.dataDir, 'loom.sqlite'), join(directory, 'loom.sqlite'));
  await copyFile(join(f.dataDir, 'secret.key'), join(directory, 'secret.key'));
  await rename(join(f.root, 'dist'), join(directory, 'previous-dist'));
  await rename(join(f.root, 'node_modules'), join(directory, 'previous-node_modules'));
  await git(f.root, ['reset', '--hard', f.targetSha]);
  await mkdir(join(f.root, 'dist', 'server'), { recursive: true });
  await writeFile(join(f.root, 'dist', 'server', 'data-directory.js'), helper);
  await writeFile(join(f.root, 'dist', 'version.txt'), 'updated build');
  await mkdir(join(f.root, 'node_modules'));
  await writeFile(join(f.root, 'node_modules', 'version.txt'), 'updated dependencies');
  dataValue(f.dataDir, 88);
  const journal = JSON.parse(await readFile(join(base, 'journal.json'), 'utf8'));
  journal.phase = committed ? 'committed' : 'verifying';
  journal.snapshotReady = true;
  await writeFile(join(base, 'journal.json'), JSON.stringify(journal));
  return f;
}

test('next npm start recovers an interrupted uncommitted update before booting', async (t) => {
  const f = await interruptedFixture(t);
  const launcher = f.create();
  await launcher.start();
  assert.equal(await git(f.root, ['rev-parse', 'HEAD']), f.previousSha);
  assert.equal(dataValue(f.dataDir), 42);
  assert.equal(await readFile(join(f.root, 'dist', 'version.txt'), 'utf8'), 'previous build');
  assert.equal((await f.status()).rolledBack, true);
  assert.equal(f.servers.at(-1)?.verify, false);
});

test('recovery refuses unexpected source edits and retains both generations', async (t) => {
  const f = await interruptedFixture(t);
  await writeFile(join(f.root, 'source.txt'), 'Unexpected local edits.');
  const launcher = f.create();
  await assert.rejects(launcher.start(), /local changes/);
  assert.equal(await readFile(join(f.root, 'source.txt'), 'utf8'), 'Unexpected local edits.');
  assert.equal(dataValue(f.dataDir), 88);
  assert.equal(
    await readFile(
      join(f.root, '.git', 'loom-updates', f.input.id, 'previous-dist', 'version.txt'),
      'utf8',
    ),
    'previous build',
  );
});

test('recovery respects another running process data lock', async (t) => {
  const f = await interruptedFixture(t);
  const lease = new DataDirectoryLock(f.dataDir);
  try {
    const launcher = f.create();
    await assert.rejects(launcher.start(), /already in use/);
    assert.equal(dataValue(f.dataDir), 88);
    assert.equal(await git(f.root, ['rev-parse', 'HEAD']), f.targetSha);
  } finally {
    lease.close();
  }
});

test('recovery refuses to restore a backup into a replaced data directory', async (t) => {
  const f = await interruptedFixture(t);
  const previousData = `${f.dataDir}-previous`;
  await rename(f.dataDir, previousData);
  await mkdir(f.dataDir);
  await copyFile(join(previousData, 'loom.sqlite'), join(f.dataDir, 'loom.sqlite'));
  await copyFile(join(previousData, 'secret.key'), join(f.dataDir, 'secret.key'));
  const launcher = f.create();
  await assert.rejects(launcher.start(), /replaced or moved/);
  assert.equal(dataValue(f.dataDir), 88);
  assert.equal(await git(f.root, ['rev-parse', 'HEAD']), f.targetSha);
});

test('committed crash recovery continues the new version without restoring old data', async (t) => {
  const f = await interruptedFixture(t, true);
  const launcher = f.create();
  await launcher.start();
  assert.equal(await git(f.root, ['rev-parse', 'HEAD']), f.targetSha);
  assert.equal(dataValue(f.dataDir), 88);
  assert.equal((await f.status()).phase, 'succeeded');
  assert.equal((await f.status()).error, undefined);
  assert.equal((await f.status()).rolledBack, undefined);
  assert.equal(await readFile(join(f.root, 'dist', 'version.txt'), 'utf8'), 'updated build');
});

test('two native launchers cannot mutate one installation concurrently', async (t) => {
  const f = await fixture(t);
  const first = f.create();
  await first.start();
  const second = f.create();
  await assert.rejects(second.start(), /locked|busy/);
  assert.equal(f.servers.length, 1);
});

test('recovery reconstructs status if a crash interrupted the journal/status pair', async (t) => {
  const f = await interruptedFixture(t);
  await rm(join(f.root, '.git', 'loom-updates', 'status.json'));
  const launcher = f.create();
  await launcher.start();
  assert.equal((await f.status()).id, f.input.id);
  assert.equal((await f.status()).rolledBack, true);
  assert.equal(dataValue(f.dataDir), 42);
});

test('a terminal rollback journal repairs an unfinished status receipt without another data restore', async (t) => {
  const f = await fixture(t, { buildFails: true });
  const first = f.create();
  await first.start();
  await first.request(f.input);
  first.proceed(f.input.id);
  await first.settled();
  await first.close();
  const status = await f.status();
  status.phase = 'building';
  delete status.rolledBack;
  await writeFile(join(f.root, '.git', 'loom-updates', 'status.json'), JSON.stringify(status));
  dataValue(f.dataDir, 123); // Work made after recovery must never be rolled back a second time.
  const second = f.create();
  await second.start();
  assert.equal((await f.status()).phase, 'failed');
  assert.equal((await f.status()).rolledBack, true);
  assert.equal(dataValue(f.dataDir), 123);
});

test('an accepted update without proceed can be cancelled without stopping or changing the app', async (t) => {
  const f = await fixture(t);
  const launcher = f.create();
  await launcher.start();
  await launcher.request(f.input);
  await launcher.request({ ...f.input, requestId: 'request-2', id: 'update-2' });
  assert.equal(f.messages.at(-1)?.type, 'loom:update:rejected');
  assert.equal(f.servers[0].stopped, false);
  await launcher.close();
  assert.equal((await f.status()).phase, 'failed');
  assert.equal(f.commands.length, 0);
  assert.equal(await git(f.root, ['rev-parse', 'HEAD']), f.previousSha);
});

test('shutdown waits for update preflight and prevents a late accepted job', async (t) => {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((done) => {
    entered = done;
  });
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  const f = await fixture(t, {
    async beforeCommand(program: string, args: string[]) {
      if (program === 'git' && args[0] === 'status') {
        entered();
        await barrier;
      }
    },
  });
  const launcher = f.create();
  await launcher.start();
  const preparing = launcher.request(f.input);
  await reached;
  const stopping = launcher.close();
  try {
    const competing = f.create();
    await assert.rejects(competing.start(), /locked|busy/);
    assert.equal(
      f.messages.some((message) => message.type === 'loom:update:accepted'),
      false,
    );
  } finally {
    release();
  }
  await preparing;
  await stopping;
  assert.equal(f.messages.at(-1)?.type, 'loom:update:rejected');
  assert.equal(launcher.busy, false);
  assert.equal(f.commands.length, 0);
  assert.equal(f.servers[0].stopped, true);
  assert.equal(await git(f.root, ['rev-parse', 'HEAD']), f.previousSha);
});

test('shutdown joins a delayed startup before releasing ownership and never spawns a late server', async (t) => {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((done) => {
    entered = done;
  });
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  const f = await fixture(t, {
    async beforeCommand(program: string, args: string[]) {
      if (program === 'git' && args.join(' ') === 'rev-parse HEAD') {
        entered();
        await barrier;
      }
    },
  });
  const launcher = f.create();
  const starting = launcher.start();
  await reached;
  const stopping = launcher.close();
  try {
    const competing = f.create();
    await assert.rejects(competing.start(), /locked|busy/);
    assert.equal(f.servers.length, 0);
  } finally {
    release();
  }
  await starting;
  await stopping;
  assert.equal(f.servers.length, 0);
  const next = f.create();
  await next.start();
  await launcher.close();
  assert.equal(f.servers.length, 1);
  assert.equal(f.servers[0].stopped, false);
});

test('the real server process adapter verifies nonce IPC and shuts down gracefully', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'loom-process-fixture-'));
  await mkdir(join(temporary, 'dist', 'server'), { recursive: true });
  await writeFile(
    join(temporary, 'dist', 'server', 'index.js'),
    `
    process.send({ type: 'loom:ready', version: '0.6.1', commit: process.env.LOOM_UPDATE_COMMIT, nonce: process.env.LOOM_UPDATE_NONCE });
    process.on('message', (message) => {
      if (message.type === 'loom:shutdown') process.exit(0);
      if (message.type === 'loom:activate' && message.nonce === process.env.LOOM_UPDATE_NONCE)
        process.send({ type: 'loom:activated', nonce: message.nonce });
    });
  `,
  );
  const server = spawnServer({
    root: temporary,
    dataDir: join(temporary, 'data'),
    stateFile: join(temporary, 'status.json'),
    env: process.env,
    verify: true,
    commit: 'a'.repeat(40),
  });
  t.after(async () => {
    await server.stop();
    await rm(temporary, { recursive: true, force: true });
  });
  assert.equal((await server.ready).commit, 'a'.repeat(40));
  await server.activate();
  await server.stop();
  assert.deepEqual(await server.exited, { code: 0, signal: null });
});
