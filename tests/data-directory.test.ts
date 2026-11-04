import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  DataDirectoryLock,
  beginDataReplacement,
  readDataReplacementResult,
  recoverDataDirectory,
} from '../src/server/data-directory.js';
import { Store } from '../src/server/store.js';

const RESERVED = '.loom-transfer';
const oldData = {
  'loom.sqlite': 'old database fixture',
  'secret.key': 'o'.repeat(32),
  'old-only.txt': 'old generation only',
  'workspace/shared.txt': 'old workspace',
  'workspace/old.txt': 'old file',
};
const newData = {
  'loom.sqlite': 'new database fixture',
  'secret.key': 'n'.repeat(32),
  'new-only.txt': 'new generation only',
  'workspace/shared.txt': 'new workspace',
  'workspace/new.txt': 'new file',
};

async function files(root: string, content: Record<string, string>) {
  for (const [name, value] of Object.entries(content)) {
    const segments = name.split('/');
    await mkdir(join(root, ...segments.slice(0, -1)), { recursive: true, mode: 0o700 });
    await writeFile(join(root, name), value, { mode: 0o600 });
  }
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string, prefix: string) {
    for (const name of (await readdir(path)).sort()) {
      if (!prefix && name === RESERVED) continue;
      const relative = prefix ? prefix + '/' + name : name;
      const filename = join(path, name);
      const info = await lstat(filename);
      if (info.isDirectory()) await visit(filename, relative);
      else result[relative] = await readFile(filename, 'utf8');
    }
  }
  await visit(root, '');
  return result;
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function fixture(t: TestContext, seed = true) {
  const temporary = await mkdtemp(join(tmpdir(), 'loom-directory-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'data');
  const jobId = randomBytes(16).toString('hex');
  const stage = join(root, RESERVED, 'jobs', jobId, 'data');
  await mkdir(stage, { recursive: true, mode: 0o700 });
  if (seed) {
    await files(root, oldData);
    await files(stage, newData);
  }
  return { temporary, root, jobId, stage, journal: join(root, RESERVED, 'restore.json') };
}

// These are real, abrupt child-process exits around filesystem operations,
// rather than a mocked Store or a hand-constructed approximation of a journal.
const childSource = [
  "import assert from 'node:assert/strict';",
  "import fs from 'node:fs/promises';",
  "import { syncBuiltinESMExports } from 'node:module';",
  "import { writeSync } from 'node:fs';",
  "import { join } from 'node:path';",
  'const [mode, root, jobId, cutText] = process.argv.slice(1);',
  'const cut = Number(cutText);',
  'let armed = false, count = 0;',
  "const journal = join(root, '.loom-transfer', 'restore.json');",
  "for (const name of ['rename', 'unlink']) {",
  '  const original = fs[name];',
  '  fs[name] = async (...args) => {',
  "    if (name === 'rename' && (String(args[0]) === root || String(args[1]) === root))",
  "      throw new Error('The mounted data root must never be renamed.');",
  "    const selected = name === 'rename' || String(args[0]) === journal;",
  "    if (armed && name === 'rename' && String(args[1]).endsWith('restore-result.json') && mode.startsWith('fail-result-')) {",
  '      armed = false;',
  "      throw new Error('Injected result persistence failure.');",
  '    }',
  "    if (armed && selected && mode === 'fail-begin' && count + 1 === cut) {",
  '      count++; armed = false;',
  "      throw new Error('Injected filesystem failure.');",
  '    }',
  '    const value = await original(...args);',
  '    if (armed && selected) {',
  '      count++;',
  "      if (mode.startsWith('crash-') && count === cut) {",
  "        writeSync(1, 'crash:' + count + '\\n');",
  "        process.kill(process.pid, 'SIGKILL');",
  '      }',
  '    }',
  '    return value;',
  '  };',
  '}',
  'syncBuiltinESMExports();',
  'const { DataDirectoryLock, beginDataReplacement, recoverDataDirectory } = await import(' +
    JSON.stringify(new URL('../src/server/data-directory.ts', import.meta.url).href) +
    ');',
  "if (mode === 'probe') {",
  '  const { Store } = await import(' +
    JSON.stringify(new URL('../src/server/store.ts', import.meta.url).href) +
    ');',
  '  assert.throws(() => new Store(root), /already in use/);',
  "  console.log('locked'); process.exit(0);",
  '}',
  'const lock = new DataDirectoryLock(root);',
  "const staged = join(root, '.loom-transfer', 'jobs', jobId, 'data');",
  "if (mode.endsWith('begin')) {",
  '  armed = true;',
  '  try { await beginDataReplacement(lock, staged, jobId); }',
  '  catch (error) {',
  "    if (mode !== 'fail-begin') throw error;",
  '    assert.match(error.message, /Injected filesystem failure/);',
  '    console.log(JSON.stringify({ count, failed: true }));',
  '    lock.close(); process.exit(0);',
  '  }',
  "} else if (mode.endsWith('recover')) {",
  '  armed = true;',
  '  await recoverDataDirectory(lock);',
  '} else {',
  '  const replacement = await beginDataReplacement(lock, staged, jobId);',
  '  armed = true;',
  '  try {',
  "    if (mode.endsWith('rollback')) await replacement.rollback();",
  '    else await replacement.commit();',
  '  } catch (error) {',
  "    if (mode !== 'fail-result-rollback') throw error;",
  '    assert.match(error.message, /Injected result persistence failure/);',
  '  }',
  '}',
  'console.log(JSON.stringify({ count }));',
  'lock.close();',
].join('\n');

async function child(mode: string, f: Awaited<ReturnType<typeof fixture>>, cut = 0) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }>(
    (resolve, reject) => {
      const processChild = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          childSource,
          mode,
          f.root,
          f.jobId,
          String(cut),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } },
      );
      let stdout = '';
      let stderr = '';
      processChild.stdout.on('data', (data) => (stdout += data));
      processChild.stderr.on('data', (data) => (stderr += data));
      const timeout = setTimeout(() => {
        processChild.kill('SIGKILL');
        reject(new Error('The data-directory test child did not finish.'));
      }, 20_000);
      processChild.on('error', reject);
      processChild.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (
          code !== 0 &&
          signal !== 'SIGKILL' &&
          !(mode.startsWith('crash-') && stdout.trim() === 'crash:' + cut)
        )
          reject(new Error('Data-directory child failed: ' + stderr));
        else resolve({ code, signal, stdout });
      });
    },
  );
}

test('a stable lease blocks a second process before it can create the key or user database', async (t) => {
  const f = await fixture(t, false);
  const lock = new DataDirectoryLock(f.root);
  try {
    assert.throws(() => new DataDirectoryLock(f.root), /already in use/);
    assert.throws(() => new Store(f.root), /already in use/);
    assert.equal((await child('probe', f)).stdout.trim(), 'locked');
    assert.equal(await exists(join(f.root, 'secret.key')), false);
    assert.equal(await exists(join(f.root, 'loom.sqlite')), false);
  } finally {
    lock.close();
    lock.close();
  }
  const reopened = new Store(f.root);
  reopened.close();
  reopened.close();
});

test('a manager-owned lease survives Store close and guards same-lease misuse', async (t) => {
  const f = await fixture(t, false);
  const lock = new DataDirectoryLock(f.root);
  let store: Store | undefined;
  try {
    const other = join(f.temporary, 'other');
    await mkdir(other);
    assert.throws(() => new Store(other, lock), /different directory/);
    assert.equal(await exists(join(other, 'secret.key')), false);
    store = new Store(f.root, lock);
    store.put('test', { id: 'original', value: 42 });
    assert.throws(() => new Store(f.root, lock), /already in use/);
    assert.throws(() => lock.close(), /Close the application/);
    await assert.rejects(beginDataReplacement(lock, f.stage, f.jobId), /Close the application/);
    store.close();
    assert.throws(() => new Store(f.root), /already in use/);
    store = new Store(f.root, lock);
    assert.equal(store.get<{ value: number }>('test', 'original')?.value, 42);
  } finally {
    store?.close();
    lock.close();
  }
  const after = new Store(f.root);
  assert.equal(after.get<{ value: number }>('test', 'original')?.value, 42);
  after.close();
  assert.throws(() => lock.assertOwner(f.root), /closed/);
});

test('Store constructor failures release owned leases and preserve a supplied lease', async (t) => {
  const f = await fixture(t, false);
  await writeFile(join(f.root, 'secret.key'), 'invalid');
  assert.throws(() => new Store(f.root), /Invalid encryption key/);
  const lock = new DataDirectoryLock(f.root);
  try {
    assert.throws(() => new Store(f.root, lock), /Invalid encryption key/);
    assert.throws(() => new DataDirectoryLock(f.root), /already in use/);
    await writeFile(join(f.root, 'secret.key'), Buffer.alloc(32, 1));
    const store = new Store(f.root, lock);
    store.close();
  } finally {
    lock.close();
  }
});

test('a schema initialization error closes both database handles', async (t) => {
  const f = await fixture(t, false);
  const filename = join(f.root, 'loom.sqlite');
  const invalid = new DatabaseSync(filename);
  invalid.exec('CREATE TABLE objects(unrelated TEXT)');
  invalid.close();
  assert.throws(() => new Store(f.root), /column/);
  const lock = new DataDirectoryLock(f.root);
  const probe = new DatabaseSync(filename);
  try {
    probe.exec('PRAGMA busy_timeout=1; BEGIN EXCLUSIVE; ROLLBACK;');
  } finally {
    probe.close();
    lock.close();
  }
});

test('replacement keeps the mounted root and ownership file, retains a complete backup, and commits once', async (t) => {
  const f = await fixture(t);
  const lock = new DataDirectoryLock(f.root);
  try {
    const rootBefore = await stat(f.root);
    const ownerPath = join(f.root, RESERVED, 'owner.sqlite');
    const ownerBefore = await stat(ownerPath);
    const replacement = await beginDataReplacement(lock, f.stage, f.jobId);
    assert.deepEqual(await snapshot(f.root), newData);
    assert.deepEqual(await snapshot(replacement.backupPath), oldData);
    assert.equal((await stat(f.root)).ino, rootBefore.ino);
    assert.equal((await stat(ownerPath)).ino, ownerBefore.ino);
    assert.equal((await child('probe', f)).stdout.trim(), 'locked');
    await replacement.commit();
    await replacement.commit();
    assert.equal(await exists(f.journal), false);
    assert.deepEqual(await snapshot(replacement.backupPath), oldData);
    assert.deepEqual(await readDataReplacementResult(lock, f.jobId), {
      status: 'committed',
      backupPath: replacement.backupPath,
    });
    await assert.rejects(replacement.rollback(), /committed/);
  } finally {
    lock.close();
  }
});

test('rollback restores all old entries and preserves files created by failed startup separately', async (t) => {
  const f = await fixture(t);
  const lock = new DataDirectoryLock(f.root);
  try {
    const replacement = await beginDataReplacement(lock, f.stage, f.jobId);
    await files(f.root, {
      'startup-only.txt': 'created after import',
      'loom.sqlite-wal': 'new WAL',
    });
    await replacement.rollback();
    await replacement.rollback();
    assert.deepEqual(await snapshot(f.root), oldData);
    assert.equal(await exists(f.journal), false);
    assert.deepEqual(await readDataReplacementResult(lock, f.jobId), { status: 'rolled-back' });
    assert.equal(
      await readFile(
        join(f.root, RESERVED, 'jobs', f.jobId, 'rejected', 'startup-only.txt'),
        'utf8',
      ),
      'created after import',
    );
    await assert.rejects(replacement.commit(), /rolled back/);
  } finally {
    lock.close();
  }
});

test('an uncommitted generation cannot be opened by a fresh Store before recovery', async (t) => {
  const f = await fixture(t);
  let lock = new DataDirectoryLock(f.root);
  await beginDataReplacement(lock, f.stage, f.jobId);
  lock.close();
  assert.throws(() => new Store(f.root), /restore was interrupted/);
  lock = new DataDirectoryLock(f.root);
  try {
    await recoverDataDirectory(lock);
    await recoverDataDirectory(lock);
    assert.deepEqual(await snapshot(f.root), oldData);
    assert.equal(await exists(f.journal), false);
  } finally {
    lock.close();
  }
});

test('a new Store opens before commit and reopens afterwards without losing receipts or secrets', async (t) => {
  const f = await fixture(t, false);
  const source = new Store(join(f.temporary, 'source'));
  source.seed();
  source.put('mailSends', { id: 'fake-send', status: 'unknown', draftId: 'fake-draft' });
  source.put('operations', {
    id: 'fake-op',
    key: 'fake-op',
    status: 'completed',
    result: 'fixture',
  });
  source.remember('fixture-dedup');
  source.setSecret('fixture', 'not-a-real-credential');
  source.close();
  for (const name of await readdir(source.dataDir))
    if (name !== RESERVED)
      await cp(join(source.dataDir, name), join(f.stage, name), { recursive: true });
  const lock = new DataDirectoryLock(f.root);
  let store: Store | undefined;
  try {
    store = new Store(f.root, lock);
    store.seed();
    store.put('test', { id: 'old' });
    store.close();
    const replacement = await beginDataReplacement(lock, f.stage, f.jobId);
    store = new Store(f.root, lock);
    assert.equal(store.secret('fixture'), 'not-a-real-credential');
    assert.equal(store.get<{ status: string }>('mailSends', 'fake-send')?.status, 'unknown');
    assert.equal(store.get<{ status: string }>('operations', 'fake-op')?.status, 'completed');
    assert.equal(store.remember('fixture-dedup'), false);
    await assert.rejects(replacement.rollback(), /Close the application/);
    await replacement.commit();
    store.close();
    store = new Store(f.root, lock);
    assert.equal(store.secret('fixture'), 'not-a-real-credential');
    assert.equal(store.get('test', 'old'), undefined);
    const backup = new DatabaseSync(join(replacement.backupPath, 'loom.sqlite'), {
      readOnly: true,
    });
    assert.ok(backup.prepare("SELECT id FROM objects WHERE kind='test' AND id='old'").get());
    backup.close();
  } finally {
    store?.close();
    lock.close();
  }
});

test('only an unused, strict job ID and its exact managed stage are accepted', async (t) => {
  const f = await fixture(t);
  const lock = new DataDirectoryLock(f.root);
  try {
    await assert.rejects(beginDataReplacement(lock, f.stage, '../escape'), /job ID/);
    await assert.rejects(
      beginDataReplacement(lock, f.root, f.jobId),
      /belong to this data transfer job/,
    );
    const outside = join(f.temporary, 'external-workspace');
    await files(outside, { 'keep.txt': 'untouched external workspace' });
    await assert.rejects(
      beginDataReplacement(lock, outside, f.jobId),
      /belong to this data transfer job/,
    );
    assert.deepEqual(await snapshot(f.root), oldData);
    assert.deepEqual(await snapshot(outside), { 'keep.txt': 'untouched external workspace' });
    const replacement = await beginDataReplacement(lock, f.stage, f.jobId);
    await replacement.commit();
    await files(f.stage, newData);
    await assert.rejects(beginDataReplacement(lock, f.stage, f.jobId), /exist/i);
    assert.deepEqual(await snapshot(replacement.backupPath), oldData);
  } finally {
    lock.close();
  }
});

test(
  'staged links and metadata symlinks are rejected without modifying their targets',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const outside = join(f.temporary, 'outside');
    await files(outside, { 'keep.txt': 'outside file' });
    const lock = new DataDirectoryLock(f.root);
    try {
      await symlink(outside, join(f.stage, 'escape'), 'dir');
      await assert.rejects(beginDataReplacement(lock, f.stage, f.jobId), /links/);
      await rm(join(f.stage, 'escape'));
      await link(join(outside, 'keep.txt'), join(f.stage, 'linked'));
      await assert.rejects(beginDataReplacement(lock, f.stage, f.jobId), /regular files/);
      assert.deepEqual(await snapshot(f.root), oldData);
      assert.deepEqual(await snapshot(outside), { 'keep.txt': 'outside file' });
    } finally {
      lock.close();
    }
    const redirected = join(f.temporary, 'redirected');
    await mkdir(redirected);
    await symlink(outside, join(redirected, RESERVED), 'dir');
    assert.throws(() => new DataDirectoryLock(redirected), /real directory/);
    assert.equal(await exists(join(outside, 'owner.sqlite')), false);
  },
);

test('invalid journals fail closed without opening or changing the user database', async (t) => {
  const f = await fixture(t);
  const lock = new DataDirectoryLock(f.root);
  try {
    await writeFile(
      f.journal,
      JSON.stringify({
        version: 1,
        jobId: f.jobId,
        phase: 'restoring',
        oldNames: ['../escape'],
        newNames: [],
      }),
    );
    await assert.rejects(recoverDataDirectory(lock), /journal is invalid/);
    assert.throws(() => new Store(f.root, lock), /restore was interrupted/);
    assert.deepEqual(await snapshot(f.root), oldData);
  } finally {
    lock.close();
  }
});

test(
  'internal single-hop links survive replacement while critical, chained and dangling links are rejected',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const lock = new DataDirectoryLock(f.root);
    try {
      await symlink('workspace/shared.txt', join(f.stage, 'shortcut'), 'file');
      await symlink('../new-only.txt', join(f.stage, 'workspace', 'link'), 'file');
      await symlink('shortcut', join(f.stage, 'chain'), 'file');
      await assert.rejects(beginDataReplacement(lock, f.stage, f.jobId), /point directly/);
      await rm(join(f.stage, 'chain'));
      await symlink('workspace', join(f.stage, 'alias'), 'dir');
      await symlink('alias/../new-only.txt', join(f.stage, 'through-parent'), 'file');
      await assert.rejects(beginDataReplacement(lock, f.stage, f.jobId), /point directly/);
      await rm(join(f.stage, 'through-parent'));
      await rm(join(f.stage, 'alias'));
      await symlink('missing-file', join(f.stage, 'dangling'), 'file');
      await assert.rejects(beginDataReplacement(lock, f.stage, f.jobId), /ENOENT/);
      await rm(join(f.stage, 'dangling'));
      await rm(join(f.stage, 'secret.key'));
      await symlink('new-only.txt', join(f.stage, 'secret.key'), 'file');
      await assert.rejects(beginDataReplacement(lock, f.stage, f.jobId), /encryption key/);
      await rm(join(f.stage, 'secret.key'));
      await writeFile(join(f.stage, 'secret.key'), newData['secret.key']);
      const replacement = await beginDataReplacement(lock, f.stage, f.jobId);
      assert.equal(await readlink(join(f.root, 'shortcut')), 'workspace/shared.txt');
      assert.equal(await readFile(join(f.root, 'shortcut'), 'utf8'), 'new workspace');
      assert.equal(
        await readFile(join(f.root, 'workspace', 'link'), 'utf8'),
        'new generation only',
      );
      await replacement.rollback();
      assert.deepEqual(await snapshot(f.root), oldData);
    } finally {
      lock.close();
    }
  },
);

test('every interrupted replacement filesystem boundary recovers the complete old generation', async (t) => {
  const countFixture = await fixture(t);
  const count = JSON.parse((await child('count-begin', countFixture)).stdout).count as number;
  assert.ok(count >= 8);
  for (let cut = 1; cut <= count; cut++) {
    await t.test('abrupt exit after replacement operation ' + cut, async (subtest) => {
      const f = await fixture(subtest);
      const result = await child('crash-begin', f, cut);
      assert.equal(result.stdout.trim(), 'crash:' + cut);
      assert.ok(result.signal === 'SIGKILL' || (process.platform === 'win32' && result.code !== 0));
      const lock = new DataDirectoryLock(f.root);
      try {
        await recoverDataDirectory(lock);
        assert.deepEqual(await snapshot(f.root), oldData);
        assert.equal(await exists(f.journal), false);
        assert.deepEqual(await readDataReplacementResult(lock, f.jobId), { status: 'rolled-back' });
      } finally {
        lock.close();
      }
    });
  }
});

test('an I/O failure at every replacement boundary rolls back before returning an error', async (t) => {
  const countFixture = await fixture(t);
  const count = JSON.parse((await child('count-begin', countFixture)).stdout).count as number;
  for (let cut = 1; cut <= count; cut++) {
    await t.test('failure before replacement operation ' + cut, async (subtest) => {
      const f = await fixture(subtest);
      const result = await child('fail-begin', f, cut);
      assert.equal(JSON.parse(result.stdout).failed, true);
      assert.deepEqual(await snapshot(f.root), oldData);
      assert.equal(await exists(f.journal), false);
    });
  }
});

test('rollback itself remains recoverable after every interrupted filesystem boundary', async (t) => {
  const countFixture = await fixture(t);
  const count = JSON.parse((await child('count-rollback', countFixture)).stdout).count as number;
  assert.ok(count >= 8);
  for (let cut = 1; cut <= count; cut++) {
    await t.test('abrupt exit after rollback operation ' + cut, async (subtest) => {
      const f = await fixture(subtest);
      const result = await child('crash-rollback', f, cut);
      assert.equal(result.stdout.trim(), 'crash:' + cut);
      assert.ok(result.signal === 'SIGKILL' || (process.platform === 'win32' && result.code !== 0));
      const lock = new DataDirectoryLock(f.root);
      try {
        await recoverDataDirectory(lock);
        await recoverDataDirectory(lock);
        assert.deepEqual(await snapshot(f.root), oldData);
        assert.deepEqual(await readDataReplacementResult(lock, f.jobId), { status: 'rolled-back' });
      } finally {
        lock.close();
      }
    });
  }
});

test('a durable commit keeps the new generation and old backup after an abrupt exit', async (t) => {
  const countFixture = await fixture(t);
  const count = JSON.parse((await child('count-commit', countFixture)).stdout).count as number;
  assert.equal(count, 3);
  for (let cut = 1; cut <= count; cut++) {
    await t.test('abrupt exit after commit operation ' + cut, async (subtest) => {
      const f = await fixture(subtest);
      const result = await child('crash-commit', f, cut);
      assert.equal(result.stdout.trim(), 'crash:' + cut);
      assert.ok(result.signal === 'SIGKILL' || (process.platform === 'win32' && result.code !== 0));
      const lock = new DataDirectoryLock(f.root);
      try {
        await recoverDataDirectory(lock);
        assert.deepEqual(await snapshot(f.root), newData);
        assert.deepEqual(await snapshot(join(f.root, RESERVED, 'backups', f.jobId)), oldData);
        assert.equal(await exists(f.journal), false);
        assert.deepEqual(await readDataReplacementResult(lock, f.jobId), {
          status: 'committed',
          backupPath: join(f.root, RESERVED, 'backups', f.jobId),
        });
      } finally {
        lock.close();
      }
    });
  }
});

test('a failed commit result write retains the committed journal until startup repairs the result', async (t) => {
  const f = await fixture(t);
  await child('fail-result-commit', f);
  assert.equal(JSON.parse(await readFile(f.journal, 'utf8')).phase, 'committed');
  assert.deepEqual(await snapshot(f.root), newData);
  const lock = new DataDirectoryLock(f.root);
  try {
    assert.equal(await readDataReplacementResult(lock, f.jobId), undefined);
    await recoverDataDirectory(lock);
    assert.deepEqual(await readDataReplacementResult(lock, f.jobId), {
      status: 'committed',
      backupPath: join(f.root, RESERVED, 'backups', f.jobId),
    });
    assert.equal(await exists(f.journal), false);
    assert.deepEqual(await snapshot(f.root), newData);
  } finally {
    lock.close();
  }
});

test('a failed rollback result write retains a recoverable journal after restoring the old data', async (t) => {
  const f = await fixture(t);
  await child('fail-result-rollback', f);
  assert.equal(JSON.parse(await readFile(f.journal, 'utf8')).phase, 'restoring');
  assert.deepEqual(await snapshot(f.root), oldData);
  const lock = new DataDirectoryLock(f.root);
  try {
    assert.equal(await readDataReplacementResult(lock, f.jobId), undefined);
    await recoverDataDirectory(lock);
    assert.deepEqual(await readDataReplacementResult(lock, f.jobId), { status: 'rolled-back' });
    assert.equal(await exists(f.journal), false);
    assert.deepEqual(await snapshot(f.root), oldData);
  } finally {
    lock.close();
  }
});
