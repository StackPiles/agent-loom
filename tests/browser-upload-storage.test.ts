import assert from 'node:assert/strict';
import fs, {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import {
  createBrowserUploadStorage,
  type BrowserUploadSession,
  type BrowserUploadStorage,
} from '../src/server/browser-upload-storage.js';
import type { BrowserUploadProcessProof } from '../src/server/browser-upload-processes.js';
import type { BrowserSettings } from '../src/shared/types.js';

const KiB = 1024;
const MiB = 1024 * KiB;
type ProcessState = 'alive' | 'dead' | 'unknown';
const exists = async (filename: string) => Boolean(await lstat(filename).catch(() => undefined));

async function fixture(t: TestContext, options: { initialize?: boolean; interval?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-upload-storage-'));
  const dataDir = join(directory, 'data');
  await mkdir(dataDir);
  const settings: Partial<BrowserSettings> = {
    uploadMaxFiles: 10,
    uploadMaxFileMiB: 1,
    uploadMaxTotalMiB: 1,
    uploadStorageMiB: 1,
  };
  const processes = new Map<number, ProcessState>();
  const storage = createBrowserUploadStorage({
    dataDir,
    getSettings: () => settings,
    cleanupIntervalMs: options.interval ?? 30_000,
    processAlive: (pid) => {
      const state = processes.get(pid) ?? 'alive';
      if (state === 'unknown')
        throw Object.assign(new Error('Access denied to a process'), { code: 'EPERM' });
      return state !== 'dead';
    },
  });
  t.after(async () => {
    await storage.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  if (options.initialize !== false) await storage.initialize();
  return {
    directory,
    dataDir,
    root: join(dataDir, 'browser-uploads'),
    settings,
    processes,
    storage,
  };
}

async function proof(
  session: BrowserUploadSession,
  browsers: BrowserUploadProcessProof['browsers'],
  mcpPid = 100,
) {
  await writeFile(
    join(session.root, 'chrome-processes.json'),
    JSON.stringify({
      version: 1,
      token: session.token,
      mcpPid,
      browsers,
    }),
  );
}

async function stage(storage: BrowserUploadStorage, session: BrowserUploadSession, bytes = 8) {
  const lease = await storage.beginUpload(session, bytes);
  const filename = join(lease.directory, 'document.bin');
  await writeFile(filename, Buffer.alloc(bytes, 42));
  await storage.markIssued(session);
  await lease.finish();
  return { filename, directory: lease.directory };
}

async function orphan(
  root: string,
  name: string,
  ownerPid: number,
  issued: boolean,
  mode: BrowserUploadSession['mode'] = 'dedicated',
) {
  const session: BrowserUploadSession = {
    root: join(root, `session-${name}`),
    token: 'a'.repeat(64),
    mode,
  };
  await mkdir(join(session.root, 'files-previous'), { recursive: true });
  await writeFile(
    join(session.root, 'session.json'),
    JSON.stringify({
      version: 1,
      token: session.token,
      ownerPid,
      ownerToken: 'b'.repeat(64),
      mode,
      issued,
    }),
  );
  await writeFile(join(session.root, 'files-previous', 'document.bin'), Buffer.alloc(8, 42));
  return session;
}

test('one shared storage budget serializes concurrent reservations without double-counting partially written copies', async (t) => {
  const f = await fixture(t);
  const a = await f.storage.createSession('dedicated');
  const b = await f.storage.createSession('existing');
  const admitted = await Promise.allSettled([
    f.storage.beginUpload(a, 700 * KiB),
    f.storage.beginUpload(b, 700 * KiB),
  ]);
  assert.equal(admitted[0].status, 'fulfilled');
  assert.equal(admitted[1].status, 'rejected');
  if (admitted[0].status !== 'fulfilled') throw admitted[0].reason;
  const first = admitted[0].value;
  await writeFile(join(first.directory, 'a.bin'), Buffer.alloc(300 * KiB));
  const second = await f.storage.beginUpload(b, 300 * KiB);
  await writeFile(join(first.directory, 'a.bin'), Buffer.alloc(700 * KiB));
  await writeFile(join(second.directory, 'b.bin'), Buffer.alloc(300 * KiB));
  await f.storage.markIssued(a);
  await f.storage.markIssued(b);
  await Promise.all([first.finish(), second.finish()]);
  const third = await f.storage.createSession('dedicated');
  await assert.rejects(f.storage.beginUpload(third, 25 * KiB), /1 MiB.*storage budget/);
  assert.equal((await lstat(join(first.directory, 'a.bin'))).size, 700 * KiB);
  assert.equal((await lstat(join(second.directory, 'b.bin'))).size, 300 * KiB);
});

test('reservations remain charged until finish even if a failed writer removes its directory', async (t) => {
  const f = await fixture(t);
  const a = await f.storage.createSession('dedicated');
  const b = await f.storage.createSession('dedicated');
  const lease = await f.storage.beginUpload(a, MiB);
  await rm(lease.directory, { recursive: true });
  await assert.rejects(f.storage.beginUpload(b, 1), /storage budget/);
  await lease.finish();
  const recovered = await f.storage.beginUpload(b, MiB);
  await recovered.finish();
});

test('a live storage reduction blocks issuance and finish removes only the new unissued batch', async (t) => {
  const f = await fixture(t);
  f.settings.uploadStorageMiB = 2;
  const session = await f.storage.createSession('dedicated');
  await proof(session, [{ pid: 101, exited: false }]);
  const previous = await stage(f.storage, session, 700 * KiB);
  const next = await f.storage.beginUpload(session, 700 * KiB);
  await writeFile(join(next.directory, 'next.bin'), Buffer.alloc(700 * KiB));
  f.settings.uploadStorageMiB = 1;
  await assert.rejects(f.storage.markIssued(session), /1 MiB.*storage budget/);
  await next.finish();
  assert.equal(await exists(next.directory), false);
  assert.equal((await lstat(previous.filename)).size, 700 * KiB);
  await f.storage.sweep();
  assert.equal(
    await exists(previous.filename),
    true,
    'the live Chrome may still read an earlier issued file',
  );
});

test('active sessions retain issued files until all Chrome generations end and never clean an in-flight batch', async (t) => {
  const f = await fixture(t);
  const session = await f.storage.createSession('dedicated');
  await proof(session, [{ pid: 101, exited: false }]);
  const old = await stage(f.storage, session);
  await f.storage.sweep();
  assert.equal(await exists(old.filename), true);
  await proof(session, [{ pid: 101, exited: true }]);
  await f.storage.sweep();
  assert.equal(await exists(old.directory), false);
  assert.equal(await exists(join(session.root, 'session.json')), true);
  assert.equal(await exists(join(session.root, 'chrome-processes.json')), true);

  const next = await f.storage.beginUpload(session, 8);
  await writeFile(join(next.directory, 'next.bin'), Buffer.alloc(8));
  await f.storage.sweep();
  assert.equal(
    await exists(next.directory),
    true,
    'old-generation proof cannot delete a new in-flight copy',
  );
  await f.storage.markIssued(session);
  await proof(session, [
    { pid: 101, exited: true },
    { pid: 102, exited: false },
  ]);
  await next.finish();
  assert.equal(await exists(next.directory), true);
  f.processes.set(102, 'dead');
  await f.storage.sweep();
  assert.equal(await exists(next.directory), false);
  assert.equal(
    await exists(session.root),
    true,
    'the active session can start another browser generation',
  );
});

test('proof inspection and copy collection finish before a concurrent upload can reserve its new batch', async (t) => {
  const f = await fixture(t);
  const session = await f.storage.createSession('dedicated');
  await proof(session, [{ pid: 101, exited: false }]);
  const previous = await stage(f.storage, session);
  await proof(session, [{ pid: 101, exited: true }]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = fs.open;
  let intercept = true;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (intercept && args[0] === join(session.root, 'chrome-processes.json')) {
      intercept = false;
      entered.resolve();
      await release.promise;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const sweeping = f.storage.sweep();
    await Promise.race([
      entered.promise,
      delay(5_000, undefined, { ref: false }).then(() => {
        throw new Error('The storage sweep did not inspect the Chrome process proof.');
      }),
    ]);
    let admitted = false;
    const pending = f.storage.beginUpload(session, 8).then((lease) => {
      admitted = true;
      return lease;
    });
    await delay(10);
    assert.equal(admitted, false);
    release.resolve();
    await sweeping;
    const next = await pending;
    assert.equal(await exists(previous.directory), false);
    await writeFile(join(next.directory, 'next.bin'), Buffer.alloc(8));
    await f.storage.sweep();
    assert.equal(await exists(next.directory), true);
    await next.finish();
  } finally {
    release.resolve();
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('startup collects only valid unissued orphans with a confirmed dead owner', async (t) => {
  const f = await fixture(t, { initialize: false });
  const dead = await orphan(f.root, 'dead', 201, false);
  const alive = await orphan(f.root, 'alive', 202, false);
  const unknown = await orphan(f.root, 'unknown', 203, false);
  f.processes.set(201, 'dead');
  f.processes.set(202, 'alive');
  f.processes.set(203, 'unknown');
  const legacy = join(f.root, 'session-legacy');
  await mkdir(legacy);
  await writeFile(join(legacy, 'unidentified.bin'), Buffer.alloc(MiB));
  const invalid = join(f.root, 'session-invalid');
  await mkdir(invalid);
  await writeFile(join(invalid, 'session.json'), '{invalid');
  await f.storage.initialize();
  assert.equal(await exists(dead.root), false);
  for (const root of [alive.root, unknown.root, legacy, invalid])
    assert.equal(await exists(root), true);
  const session = await f.storage.createSession('dedicated');
  await assert.rejects(f.storage.beginUpload(session, 1), /storage budget/);
  assert.equal((await lstat(join(legacy, 'unidentified.bin'))).size, MiB);
});

test('inactive issued copies require dead MCP and ended Chrome evidence while another live owner is protected', async (t) => {
  const f = await fixture(t);
  const cases: Array<{
    name: string;
    owner: ProcessState;
    mcp: ProcessState;
    chrome: ProcessState;
    exited?: boolean;
    evidence?: 'missing' | 'empty' | 'wrong-token';
    remove: boolean;
  }> = [
    {
      name: 'observed-exit',
      owner: 'dead',
      mcp: 'dead',
      chrome: 'alive',
      exited: true,
      remove: true,
    },
    { name: 'dead-pids', owner: 'dead', mcp: 'dead', chrome: 'dead', remove: true },
    { name: 'live-mcp', owner: 'dead', mcp: 'alive', chrome: 'dead', remove: false },
    { name: 'unknown-mcp', owner: 'dead', mcp: 'unknown', chrome: 'dead', remove: false },
    { name: 'live-chrome', owner: 'dead', mcp: 'dead', chrome: 'alive', remove: false },
    { name: 'unknown-chrome', owner: 'dead', mcp: 'dead', chrome: 'unknown', remove: false },
    { name: 'other-owner', owner: 'alive', mcp: 'dead', chrome: 'dead', remove: false },
    { name: 'unknown-owner', owner: 'unknown', mcp: 'dead', chrome: 'dead', remove: false },
    {
      name: 'missing-proof',
      owner: 'dead',
      mcp: 'dead',
      chrome: 'dead',
      evidence: 'missing',
      remove: false,
    },
    {
      name: 'empty-proof',
      owner: 'dead',
      mcp: 'dead',
      chrome: 'dead',
      evidence: 'empty',
      remove: false,
    },
    {
      name: 'wrong-token',
      owner: 'dead',
      mcp: 'dead',
      chrome: 'dead',
      evidence: 'wrong-token',
      remove: false,
    },
  ];
  const roots: Array<{ session: BrowserUploadSession; remove: boolean }> = [];
  for (const [index, entry] of cases.entries()) {
    const owner = 1000 + index * 3;
    const mcp = owner + 1;
    const chrome = owner + 2;
    const session = await orphan(
      f.root,
      entry.name,
      owner,
      true,
      index % 2 ? 'existing' : 'dedicated',
    );
    f.processes.set(owner, entry.owner);
    f.processes.set(mcp, entry.mcp);
    f.processes.set(chrome, entry.chrome);
    if (entry.evidence !== 'missing')
      await proof(
        entry.evidence === 'wrong-token' ? { ...session, token: 'c'.repeat(64) } : session,
        entry.evidence === 'empty' ? [] : [{ pid: chrome, exited: entry.exited ?? false }],
        mcp,
      );
    roots.push({ session, remove: entry.remove });
  }
  await f.storage.sweep();
  for (const { session, remove } of roots)
    assert.equal(await exists(session.root), !remove, session.root.split('session-').at(-1));
});

test('released Existing Chrome copies survive disconnect and are reclaimed after actual process exit', async (t) => {
  const f = await fixture(t);
  const session = await f.storage.createSession('existing');
  await proof(session, [{ pid: 301, exited: false }], 300);
  const uploaded = await stage(f.storage, session);
  f.processes.set(300, 'dead');
  await f.storage.releaseSession(session);
  assert.equal(await exists(uploaded.filename), true);
  f.processes.set(301, 'unknown');
  await f.storage.sweep();
  assert.equal(await exists(uploaded.filename), true);
  f.processes.set(301, 'dead');
  await f.storage.sweep();
  assert.equal(await exists(session.root), false);
  await f.storage.releaseSession(session);
});

test('unissued releases wait for in-flight cleanup and do not need an MCP exit proof', async (t) => {
  const f = await fixture(t);
  const session = await f.storage.createSession('dedicated');
  const lease = await f.storage.beginUpload(session, 8);
  await writeFile(join(lease.directory, 'unused.bin'), Buffer.alloc(8));
  await f.storage.releaseSession(session);
  assert.equal(await exists(lease.directory), true);
  await lease.finish();
  assert.equal(await exists(session.root), false);
  await lease.finish();
});

test('symlinks are never followed and unexpected data is retained while managed copies are collected', async (t) => {
  const f = await fixture(t);
  const outside = join(f.directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'unrelated.bin'), Buffer.alloc(2 * MiB, 9));
  await symlink(outside, join(f.root, 'session-linked'), 'junction');
  const session = await f.storage.createSession('dedicated');
  const uploaded = await stage(f.storage, session, 500 * KiB);
  await writeFile(join(session.root, 'owner-notes.txt'), 'Keep this unexpected file.');
  await proof(session, [{ pid: 401, exited: true }], 400);
  f.processes.set(400, 'dead');
  await f.storage.releaseSession(session);
  assert.equal(await exists(uploaded.directory), false);
  assert.equal(
    await readFile(join(session.root, 'owner-notes.txt'), 'utf8'),
    'Keep this unexpected file.',
  );
  assert.equal((await lstat(join(f.root, 'session-linked'))).isSymbolicLink(), true);
  assert.equal((await lstat(join(outside, 'unrelated.bin'))).size, 2 * MiB);

  const otherData = join(f.directory, 'other-data');
  await mkdir(otherData);
  await symlink(outside, join(otherData, 'browser-uploads'), 'junction');
  const redirected = createBrowserUploadStorage({
    dataDir: otherData,
    getSettings: () => f.settings,
  });
  await assert.rejects(redirected.initialize(), /directory changed/);
  await redirected.shutdown();
  assert.equal((await lstat(join(outside, 'unrelated.bin'))).size, 2 * MiB);
});

test('manifest write failures keep safe diagnostics and permit a later session retry', async (t) => {
  const f = await fixture(t);
  const original = fs.rename;
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    throw Object.assign(new Error(`Denied rename in ${f.root}`), { code: 'EACCES' });
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.storage.createSession('dedicated'), (error: Error) => {
      assert.match(error.message, /EACCES/);
      assert.ok(!error.message.includes(f.directory));
      return true;
    });
    assert.deepEqual(await readdir(f.root), []);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(fs.rename, original);
  const session = await f.storage.createSession('dedicated');
  const manifest = JSON.parse(await readFile(join(session.root, 'session.json'), 'utf8'));
  assert.equal(manifest.issued, false);
  assert.equal(manifest.ownerPid, process.pid);
  assert.equal(manifest.token, session.token);
  await f.storage.releaseSession(session);
  assert.equal(await exists(session.root), false);
});

test('failed deletion of an unissued batch retries without deleting older files used by a live Chrome', async (t) => {
  const f = await fixture(t);
  const session = await f.storage.createSession('dedicated');
  await proof(session, [{ pid: 101, exited: false }]);
  const previous = await stage(f.storage, session);
  const unused = await f.storage.beginUpload(session, 8);
  await writeFile(join(unused.directory, 'unused.bin'), Buffer.alloc(8));
  const original = fs.rm;
  const mocked = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === unused.directory) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await unused.finish();
    assert.equal(await exists(unused.directory), true);
    assert.equal(await exists(previous.filename), true);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  await f.storage.sweep();
  assert.equal(await exists(unused.directory), false);
  assert.equal(await exists(previous.filename), true);
});

test(
  'periodic cleanup observes process exit, stops at shutdown, and rejects invalid budgets without coercion',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t, { interval: 10 });
    const session = await f.storage.createSession('dedicated');
    await proof(session, [{ pid: 501, exited: false }]);
    const first = await stage(f.storage, session);
    f.processes.set(501, 'dead');
    const deadline = Date.now() + 5000;
    while (await exists(first.directory)) {
      assert.ok(Date.now() < deadline, 'periodic sweep observes the confirmed browser exit');
      await delay(10);
    }
    f.settings.uploadStorageMiB = 0;
    await assert.rejects(f.storage.beginUpload(session, 1), /uploadStorageMiB/);
    f.settings.uploadStorageMiB = 1;
    await proof(session, [{ pid: 502, exited: false }]);
    const second = await stage(f.storage, session);
    await f.storage.shutdown();
    f.processes.set(502, 'dead');
    await delay(40);
    assert.equal(await exists(second.filename), true);
    await assert.rejects(f.storage.beginUpload(session, 1), /shutting down/);
    await f.storage.sweep();
    assert.equal(await exists(second.directory), false);
  },
);
