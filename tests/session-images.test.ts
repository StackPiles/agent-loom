import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SessionManager, buildSessionProjection } from '@earendil-works/pi-coding-agent';
import type { Message } from '@earendil-works/pi-ai';
import { isImageAssetDeleted, markImageAssetDeleted } from '../src/server/image-assets.js';
import {
  createSessionImageStore,
  retainedSessionImageHashes,
} from '../src/server/runtime/session-images.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQcPj/HwAEQgJfMvKOtQAAAABJRU5ErkJggg==',
  'base64',
);
const timestamp = '2026-01-01T00:00:00.000Z';
const image = (data = png.toString('base64')) => ({
  type: 'image' as const,
  data,
  mimeType: 'image/png',
});
const header = (cwd: string) => ({
  type: 'session',
  version: 3,
  id: 'fixture-session',
  timestamp,
  cwd,
});
const entry = (id: string, parentId: string | null, data = png.toString('base64')) => ({
  type: 'message',
  id,
  parentId,
  timestamp,
  message: {
    role: 'toolResult',
    toolCallId: `call-${id}`,
    toolName: 'view_image',
    content: [image(data)],
    isError: false,
    timestamp: 1,
  },
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'loom-session-images-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessions = path.join(directory, 'sessions', 'bot', 'room');
  const cwd = path.join(directory, 'workspace');
  await mkdir(sessions, { recursive: true });
  await mkdir(cwd);
  return { directory, sessions, cwd, store: createSessionImageStore(directory) };
}

test('new image messages keep lightweight shared state and hydrate exactly for the provider', async (t) => {
  const f = await fixture(t);
  const part = image();
  const message: Message = {
    role: 'user',
    content: [{ type: 'text', text: 'inspect' }, part],
    timestamp: 1,
  };
  const agentState = [message];
  f.store.externalizeMessageImages(message);
  assert.match(part.data, /^loom-image:v1:sha256:[a-f0-9]{64}:[1-9][0-9]*$/);
  assert.equal((agentState[0].content as (typeof part)[])[1].data, part.data);
  assert.equal(JSON.stringify(message).includes(png.toString('base64')), false);
  assert.equal(f.store.estimateImageBytes([message]), png.length);
  const hydrated = await f.store.hydrateMessages([message]);
  assert.equal((hydrated[0].content as (typeof part)[])[1].data, png.toString('base64'));
  assert.notEqual(hydrated[0], message);
  assert.match(part.data, /^loom-image:/, 'hydration must not refill the retained message');
  const second: Message = { role: 'user', content: [image()], timestamp: 2 };
  f.store.externalizeMessageImages(second);
  assert.equal((await readdir(path.join(f.directory, 'sessions', 'assets'))).length, 1);
});

test('filesystems without hard links publish complete assets and preserve colliding files', async (t) => {
  const f = await fixture(t);
  let beforeFailure: ((destination: fs.PathLike) => void) | undefined;
  const mocked = t.mock.method(fs, 'linkSync', (_source, destination) => {
    const interfere = beforeFailure;
    beforeFailure = undefined;
    interfere?.(destination);
    throw Object.assign(new Error('Hard links are unsupported.'), { code: 'ENOTSUP' });
  });
  syncBuiltinESMExports();
  try {
    const message: Message = { role: 'user', content: [image()], timestamp: 1 };
    f.store.externalizeMessageImages(message);
    const hydrated = await f.store.hydrateMessages([message]);
    assert.equal(
      (hydrated[0].content as ReturnType<typeof image>[])[0].data,
      png.toString('base64'),
    );

    const legacyData = Buffer.from('legacy image bytes').toString('base64');
    const filename = path.join(f.sessions, 'legacy.jsonl');
    const source = [header(f.cwd), entry('legacy', null, legacyData)]
      .map((value) => JSON.stringify(value))
      .join('\n');
    await writeFile(filename, source);
    const prepared = await f.store.prepareSessionHistory({
      sessionDirectory: f.sessions,
      cwd: f.cwd,
    });
    assert.equal(prepared.migrated, true);
    assert.ok(prepared.backupPath);
    assert.equal(await readFile(prepared.backupPath, 'utf8'), source);
    const saved = JSON.parse((await readFile(filename, 'utf8')).split('\n')[1]);
    const replayed = await f.store.hydrateMessages([saved.message] as Message[]);
    assert.equal((replayed[0].content as ReturnType<typeof image>[])[0].data, legacyData);

    const collisionData = Buffer.from('different pixels').toString('base64');
    const collision = image(collisionData);
    beforeFailure = (destination) => fs.writeFileSync(destination, Buffer.alloc(16));
    assert.throws(
      () => f.store.externalizeMessageImages({ content: [collision] }),
      /integrity check/,
    );
    assert.equal(collision.data, collisionData, 'a failed publication retains the original pixels');

    if (process.platform !== 'win32') {
      const outside = path.join(f.directory, 'outside-image');
      await writeFile(outside, png);
      const linked = image(Buffer.from('linked image bytes').toString('base64'));
      beforeFailure = (destination) => fs.symlinkSync(outside, destination);
      assert.throws(() => f.store.externalizeMessageImages({ content: [linked] }), /unsafe link/);
      assert.deepEqual(await readFile(outside), png);
    }
    assert.equal(
      (await readdir(path.join(f.directory, 'sessions', 'assets'))).some((name) =>
        name.endsWith('.tmp'),
      ),
      false,
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('Windows backup flushing uses a writable handle and preserves a read-only original on denial', async (t) => {
  const writable = await fixture(t);
  const readonly = await fixture(t);
  const source = (cwd: string) =>
    [header(cwd), entry('image', null)].map((value) => JSON.stringify(value)).join('\n');
  const writableFile = path.join(writable.sessions, 'conversation.jsonl');
  const readonlyFile = path.join(readonly.sessions, 'conversation.jsonl');
  await writeFile(writableFile, source(writable.cwd));
  await writeFile(readonlyFile, source(readonly.cwd));
  await chmod(readonlyFile, 0o444);
  const readonlyMode = (await stat(readonlyFile)).mode;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalOpen = fs.openSync;
  const originalSync = fs.fsyncSync;
  const backupHandles = new Map<number, fs.OpenMode>();
  let denyBackup = false;
  let flushedBackups = 0;
  const mockedOpen = t.mock.method(fs, 'openSync', (filename, flags, mode) => {
    const backup = String(filename).endsWith('.bak');
    if (backup && denyBackup)
      throw Object.assign(new Error('Read-only backup cannot be opened for writing.'), {
        code: 'EACCES',
      });
    const fd = originalOpen(filename, flags, mode);
    if (backup) backupHandles.set(fd, flags);
    return fd;
  });
  const mockedSync = t.mock.method(fs, 'fsyncSync', (fd) => {
    const flags = backupHandles.get(fd);
    if (flags !== undefined) {
      const canWrite =
        typeof flags === 'number'
          ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR))
          : /[wa+]/.test(flags);
      if (!canWrite)
        throw Object.assign(new Error('Windows FlushFileBuffers requires write access.'), {
          code: 'EPERM',
        });
      backupHandles.delete(fd);
      flushedBackups++;
    }
    originalSync(fd);
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  syncBuiltinESMExports();
  try {
    const prepared = await writable.store.prepareSessionHistory({
      sessionDirectory: writable.sessions,
      cwd: writable.cwd,
    });
    assert.equal(prepared.migrated, true);
    assert.equal(flushedBackups, 1);
    assert.ok(prepared.backupPath);
    assert.equal(await readFile(prepared.backupPath, 'utf8'), source(writable.cwd));

    denyBackup = true;
    await assert.rejects(
      readonly.store.prepareSessionHistory({
        sessionDirectory: readonly.sessions,
        cwd: readonly.cwd,
      }),
      { code: 'EACCES' },
    );
    assert.equal(await readFile(readonlyFile, 'utf8'), source(readonly.cwd));
    assert.equal((await stat(readonlyFile)).mode, readonlyMode);
    const files = await readdir(readonly.sessions);
    const backup = files.find((name) => name.endsWith('.bak'));
    assert.ok(backup);
    assert.equal(
      await readFile(path.join(readonly.sessions, backup), 'utf8'),
      source(readonly.cwd),
    );
    assert.equal(
      files.some((name) => name.endsWith('.tmp')),
      false,
    );
  } finally {
    Object.defineProperty(process, 'platform', platform);
    mockedOpen.mock.restore();
    mockedSync.mock.restore();
    syncBuiltinESMExports();
    await chmod(readonlyFile, 0o600);
  }
});

test('old large history migrates atomically with an exact backup and real Pi continuation', async (t) => {
  const f = await fixture(t);
  const data = Buffer.alloc(2 * 1024 * 1024, 13).toString('base64');
  const unknown = {
    type: 'future_entry',
    id: 'future',
    parentId: 'old-image',
    timestamp,
    extra: { nested: [1, 'preserved'] },
  };
  const keep = {
    type: 'message',
    id: 'kept-text',
    parentId: 'future',
    timestamp,
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Continue this work.' }],
      timestamp: 1,
    },
  };
  const compact = {
    type: 'compaction',
    id: 'compact',
    parentId: 'kept-text',
    timestamp,
    summary: 'Prior image inspected.',
    firstKeptEntryId: 'kept-text',
    tokensBefore: 12345,
    details: { provenance: ['old-image'] },
  };
  const current = entry('new-image', 'compact');
  const source =
    [header(f.cwd), entry('old-image', null, data), unknown, keep, compact, current]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n';
  const filename = path.join(f.sessions, 'conversation.jsonl');
  await writeFile(filename, source);
  await utimes(filename, 1767225600.654321, 1767225600.123456);
  const prior = await stat(filename);
  const prepared = await f.store.prepareSessionHistory({
    sessionDirectory: f.sessions,
    cwd: f.cwd,
  });
  assert.equal(prepared.sessionPath, await realpath(filename));
  assert.equal(prepared.migrated, true);
  assert.ok(prepared.backupPath);
  assert.equal(await readFile(prepared.backupPath, 'utf8'), source);
  const migrated = await stat(filename);
  assert.ok(
    Math.abs(migrated.atimeMs - prior.atimeMs) < 0.01,
    'preserve sub-millisecond access time',
  );
  assert.ok(
    Math.abs(migrated.mtimeMs - prior.mtimeMs) < 0.01,
    'preserve sub-millisecond modification time',
  );
  const saved = await readFile(filename, 'utf8');
  assert.ok(saved.length < 4000);
  assert.equal(saved.includes(data), false);
  const rows = saved
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(rows[2], unknown);
  assert.deepEqual(rows[4], compact);
  assert.equal(rows[1].message.toolCallId, 'call-old-image');
  assert.equal(prepared.residentBytes, Buffer.byteLength(saved));
  assert.equal(prepared.imageBytes, 2 * 1024 * 1024 + png.length);
  const manager = SessionManager.open(filename, f.sessions);
  assert.equal(manager.getEntries().length, 5);
  assert.equal(JSON.stringify(manager.getEntries()).includes(data), false);
  const projected = buildSessionProjection(manager.getEntries()).messages;
  const projectedImages = projected.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image') : [],
  );
  assert.equal(
    projectedImages.length,
    1,
    'the old summarized image remains outside active context',
  );
  assert.match(projectedImages[0].data, /^loom-image:/);
  const hydrated = await f.store.hydrateMessages(projected as Message[]);
  assert.equal(
    hydrated.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image') : [],
    )[0].data,
    png.toString('base64'),
  );
  const again = await f.store.prepareSessionHistory({ sessionDirectory: f.sessions, cwd: f.cwd });
  assert.equal(again.migrated, false);
  assert.equal((await readdir(f.sessions)).filter((name) => name.endsWith('.bak')).length, 1);
});

test('latest session selection respects cwd and simultaneous migrations keep one original backup', async (t) => {
  const f = await fixture(t);
  const otherCwd = path.join(f.directory, 'another-workspace');
  const older = path.join(f.sessions, 'older.jsonl');
  const selected = path.join(f.sessions, 'selected.jsonl');
  const different = path.join(f.sessions, 'other-cwd.jsonl');
  for (const [filename, cwd, age] of [
    [older, f.cwd, 1],
    [selected, f.cwd, 2],
    [different, otherCwd, 3],
  ] as const) {
    await writeFile(
      filename,
      [header(cwd), entry('image', null)].map((value) => JSON.stringify(value)).join('\n') + '\n',
    );
    await utimes(filename, age, age);
  }
  const otherStore = createSessionImageStore(f.directory);
  const inspected = await otherStore.inspectSessionHistory({
    sessionDirectory: f.sessions,
    cwd: f.cwd,
  });
  const canonicalSelected = await realpath(selected);
  assert.equal(inspected.sessionPath, canonicalSelected);
  assert.equal(inspected.sourceBytes, (await stat(selected)).size);
  assert.ok(
    (await readFile(selected, 'utf8')).includes(png.toString('base64')),
    'inspection does not migrate or parse full histories',
  );
  const canonicalSessionDirectory = await realpath(f.sessions);
  const results = await Promise.all([
    f.store.prepareSessionHistory({ sessionDirectory: f.sessions, cwd: f.cwd }),
    otherStore.prepareSessionHistory({ sessionDirectory: canonicalSessionDirectory, cwd: f.cwd }),
  ]);
  assert.deepEqual(
    results.map((result) => result.sessionPath),
    [canonicalSelected, canonicalSelected],
  );
  assert.equal(results.filter((result) => result.migrated).length, 1);
  assert.equal((await readdir(f.sessions)).filter((name) => name.endsWith('.bak')).length, 1);
  assert.ok((await readFile(older, 'utf8')).includes(png.toString('base64')));
  assert.ok((await readFile(different, 'utf8')).includes(png.toString('base64')));
});

test(
  'multiple image histories stay lightweight under a bounded heap while active pixels replay',
  { timeout: 30_000 },
  () => {
    const child = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=64',
        '--max-semi-space-size=4',
        '--expose-gc',
        '--import',
        'tsx',
        fileURLToPath(new URL('./session-images-memory-fixture.mjs', import.meta.url)),
      ],
      { encoding: 'utf8', timeout: 25_000, env: { ...process.env, LOOM_TEST_HISTORY_MIB: '8' } },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout);
    assert.equal(result.preparations.length, 2);
    for (const prepared of result.preparations) {
      assert.ok(prepared.originalBytes > 8 * 1024 * 1024);
      assert.ok(prepared.residentBytes < 16 * 1024);
      assert.equal(prepared.activeImageHashMatches, true);
    }
  },
);

test('failure midway preserves every original byte and safely retries after repair', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.sessions, 'broken.jsonl');
  const rows = [header(f.cwd), entry('valid', null), entry('broken', 'valid', 'not-base64')];
  const source = rows.map((value) => JSON.stringify(value)).join('\n') + '\n';
  await writeFile(filename, source);
  await assert.rejects(
    f.store.prepareSessionHistory({ sessionDirectory: f.sessions, cwd: f.cwd }),
    /invalid image data/,
  );
  assert.equal(await readFile(filename, 'utf8'), source);
  assert.equal(
    (await readdir(f.sessions)).some((name) => name.endsWith('.tmp')),
    false,
  );
  const oversized = [header(f.cwd), entry('large', null, Buffer.alloc(8000).toString('base64'))]
    .map((value) => JSON.stringify(value))
    .join('\n');
  await writeFile(filename, oversized);
  await assert.rejects(
    f.store.prepareSessionHistory({
      sessionDirectory: f.sessions,
      cwd: f.cwd,
      maxRecordBytes: 4096,
    }),
    /too large to migrate safely/,
  );
  assert.equal(await readFile(filename, 'utf8'), oversized);
  const prepared = await f.store.prepareSessionHistory({
    sessionDirectory: f.sessions,
    cwd: f.cwd,
  });
  assert.equal(prepared.migrated, true);
});

test('missing, corrupted and path-like references fail instead of sending fabricated pixels', async (t) => {
  const f = await fixture(t);
  const message: Message = { role: 'user', content: [image()], timestamp: 1 };
  f.store.externalizeMessageImages(message);
  const hash = createHash('sha256').update(png).digest('hex');
  const filename = path.join(f.directory, 'sessions', 'assets', `${hash}.bin`);
  await writeFile(filename, Buffer.alloc(png.length));
  await assert.rejects(f.store.hydrateMessages([message]), /integrity check/);
  await rm(filename);
  await assert.rejects(f.store.hydrateMessages([message]), /image is missing/);
  const invalid: Message = {
    role: 'user',
    content: [image('loom-image:v1:sha256:../../outside:123')],
    timestamp: 1,
  };
  await assert.rejects(f.store.hydrateMessages([invalid]), /invalid image reference/);
  assert.throws(() => f.store.estimateImageBytes([invalid]), /invalid image reference/);
});

test('managed image references survive copying the Loom data to another location', async (t) => {
  const f = await fixture(t);
  const message: Message = { role: 'user', content: [image()], timestamp: 1 };
  f.store.externalizeMessageImages(message);
  const destination = await mkdtemp(path.join(tmpdir(), 'loom-session-images-moved-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  await cp(path.join(f.directory, 'sessions'), path.join(destination, 'sessions'), {
    recursive: true,
  });
  const relocated = createSessionImageStore(destination);
  const hydrated = await relocated.hydrateMessages([message]);
  assert.equal((hydrated[0].content as ReturnType<typeof image>[])[0].data, png.toString('base64'));
  assert.equal(JSON.stringify(message).includes(f.directory), false);
});

test('intentionally retired references become text and consume no image budget after a restart or move', async (t) => {
  const f = await fixture(t);
  f.store = createSessionImageStore(f.directory, { retainReferences: true });
  t.after(() => f.store.release());
  const message: Message = { role: 'user', content: [image()], timestamp: 1 };
  f.store.externalizeMessageImages(message);
  const hash = createHash('sha256').update(png).digest('hex');
  assert.equal(retainedSessionImageHashes(f.directory).has(hash), true);
  markImageAssetDeleted(f.directory, hash, timestamp);
  await rm(path.join(f.directory, 'sessions', 'assets', `${hash}.bin`));
  assert.equal(retainedSessionImageHashes(f.directory).has(hash), false);
  assert.equal(f.store.estimateImageBytes([message]), 0);
  const projected = f.store.withoutRetiredImages([message]);
  const hydrated = await f.store.hydrateMessages([message]);
  assert.deepEqual(projected, hydrated);
  const part = (projected[0].content as Array<{ type: string; text: string }>)[0];
  assert.equal(part.type, 'text');
  assert.match(part.text, /intentionally removed/);
  assert.match(part.text, /original to be attached again/);
  assert.equal('data' in part, false);
  assert.equal(
    (message.content as ReturnType<typeof image>[])[0].type,
    'image',
    'projection preserves durable history',
  );

  const destination = await mkdtemp(path.join(tmpdir(), 'loom-retired-images-moved-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  await cp(path.join(f.directory, 'sessions'), path.join(destination, 'sessions'), {
    recursive: true,
  });
  f.store.release();
  const restarted = createSessionImageStore(destination, { retainReferences: true });
  t.after(() => restarted.release());
  assert.deepEqual(await restarted.hydrateMessages([message]), projected);
  assert.equal(restarted.estimateImageBytes([message]), 0);
  assert.equal(retainedSessionImageHashes(destination).has(hash), false);
});

test('legacy inline history cannot resurrect retired originals, while a new attachment can restore them', async (t) => {
  const f = await fixture(t);
  const hash = createHash('sha256').update(png).digest('hex');
  const reference = `loom-image:v1:sha256:${hash}:${png.length}`;
  const filename = path.join(f.sessions, 'retired.jsonl');
  const source = [header(f.cwd), entry('raw', null), entry('reference', 'raw', reference)]
    .map((value) => JSON.stringify(value))
    .join('\n');
  await writeFile(filename, source);
  markImageAssetDeleted(f.directory, hash, timestamp);
  const prepared = await f.store.prepareSessionHistory({
    sessionDirectory: f.sessions,
    cwd: f.cwd,
  });
  assert.equal(prepared.imageBytes, 0);
  assert.equal(prepared.migrated, true);
  assert.ok(prepared.backupPath);
  assert.equal(await readFile(prepared.backupPath, 'utf8'), source);
  assert.equal(fs.existsSync(path.join(f.directory, 'sessions', 'assets', `${hash}.bin`)), false);
  assert.equal(isImageAssetDeleted(f.directory, hash), true);
  const messages = (await readFile(filename, 'utf8'))
    .split('\n')
    .slice(1)
    .map((line) => JSON.parse(line).message as Message);
  assert.equal(messages.length, 2);
  assert.equal(
    messages.every(
      (message) => Array.isArray(message.content) && message.content[0].type === 'text',
    ),
    true,
  );
  assert.deepEqual(await f.store.hydrateMessages(messages), messages);
  assert.equal(
    (await f.store.prepareSessionHistory({ sessionDirectory: f.sessions, cwd: f.cwd })).migrated,
    false,
  );

  const newAttachment: Message = { role: 'user', content: [image()], timestamp: 2 };
  f.store.externalizeMessageImages(newAttachment);
  assert.equal(isImageAssetDeleted(f.directory, hash), false);
  assert.equal(f.store.estimateImageBytes([newAttachment]), png.length);
  assert.equal((newAttachment.content as ReturnType<typeof image>[])[0].data, reference);
  const hydrated = await f.store.hydrateMessages([newAttachment]);
  assert.equal((hydrated[0].content as ReturnType<typeof image>[])[0].data, png.toString('base64'));
});

test('migration preserves custom image context, unknown records, and malformed raw lines', async (t) => {
  const f = await fixture(t);
  const custom = {
    type: 'custom_message',
    id: 'custom',
    parentId: null,
    timestamp,
    customType: 'extension',
    content: [image()],
    display: true,
    details: { preserve: true },
  };
  const edit = {
    type: 'context_edit',
    id: 'edit',
    parentId: 'custom',
    timestamp,
    targetId: 'custom',
    replacement: { content: [image()] },
  };
  const filename = path.join(f.sessions, 'custom.jsonl');
  const malformed = '{this is not valid json}\r\n';
  await writeFile(
    filename,
    JSON.stringify(header(f.cwd)) +
      '\n' +
      malformed +
      JSON.stringify(custom) +
      '\n' +
      JSON.stringify(edit),
  );
  await f.store.prepareSessionHistory({ sessionDirectory: f.sessions, cwd: f.cwd });
  const saved = await readFile(filename, 'utf8');
  assert.ok(saved.includes(malformed));
  const rows = saved.split('\n');
  const newCustom = JSON.parse(rows[2]);
  const newEdit = JSON.parse(rows[3]);
  assert.deepEqual(newCustom.details, custom.details);
  assert.equal(newEdit.targetId, 'custom');
  assert.match(newCustom.content[0].data, /^loom-image:/);
  assert.match(newEdit.replacement.content[0].data, /^loom-image:/);
});

test('storage boundaries reject symlinks and already-aborted migration leaves the source intact', async (t) => {
  const f = await fixture(t);
  const source = [header(f.cwd), entry('image', null)]
    .map((value) => JSON.stringify(value))
    .join('\n');
  const filename = path.join(f.sessions, 'original.jsonl');
  await writeFile(filename, source);
  await assert.rejects(
    f.store.prepareSessionHistory({
      sessionDirectory: f.sessions,
      cwd: f.cwd,
      signal: AbortSignal.abort(new Error('cancelled')),
    }),
    /cancelled/,
  );
  assert.equal(await readFile(filename, 'utf8'), source);
  const external = path.join(f.directory, 'external');
  await mkdir(external);
  await assert.rejects(
    f.store.prepareSessionHistory({ sessionDirectory: external, cwd: f.cwd }),
    /session directory is invalid/,
  );
  if (process.platform === 'win32') return; // Creating a symlink may require an elevated Windows token.
  await symlink(external, path.join(f.directory, 'sessions', 'assets'));
  assert.throws(() => f.store.externalizeMessageImages({ content: [image()] }), /unsafe link/);
  assert.deepEqual(await readdir(external), []);
});

test('a selected data-root alias remains usable without allowing descendant links', async (t) => {
  if (process.platform === 'win32') return;
  const f = await fixture(t);
  const aliasParent = await mkdtemp(path.join(tmpdir(), 'loom-session-root-alias-'));
  t.after(() => rm(aliasParent, { recursive: true, force: true }));
  const alias = path.join(aliasParent, 'data');
  await symlink(f.directory, alias);
  const viaAlias = createSessionImageStore(alias);
  const source = [header(f.cwd), entry('image', null)]
    .map((value) => JSON.stringify(value))
    .join('\n');
  await writeFile(path.join(f.sessions, 'alias.jsonl'), source);
  const prepared = await viaAlias.prepareSessionHistory({
    sessionDirectory: path.join(alias, 'sessions', 'bot', 'room'),
    cwd: f.cwd,
  });
  assert.equal(prepared.migrated, true);
  const manager = SessionManager.open(prepared.sessionPath!, f.sessions);
  const hydrated = await viaAlias.hydrateMessages(
    buildSessionProjection(manager.getEntries()).messages as Message[],
  );
  const parts = hydrated.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image') : [],
  );
  assert.equal(parts[0].data, png.toString('base64'));
});
