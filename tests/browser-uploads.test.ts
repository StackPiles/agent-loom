import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  assertBrowserUploadLimits,
  assertBrowserUploadsCurrent,
  BROWSER_UPLOAD_LIMITS,
  browserUploadLimits,
  browserUploadReceipts,
  normalizeBrowserUploadPaths,
  prepareBrowserUploads,
  type BrowserUploadLimits,
  type PreparedBrowserUploads,
} from '../src/server/browser-uploads.js';
import type { BrowserSettings } from '../src/shared/types.js';

const MiB = 1024 * 1024;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'loom-browser-uploads-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, workspace };
}

test('prepares exact binary bytes and Japanese names with reviewable relative metadata', async (t) => {
  const f = await fixture(t);
  const binary = Buffer.from([0, 255, 1, 13, 10, 128]);
  const text = Buffer.from('承認後も同じ内容を添付する。\n', 'utf8');
  await mkdir(path.join(f.workspace, '資料'));
  await writeFile(path.join(f.workspace, '資料', '添付.bin'), binary);
  await writeFile(path.join(f.workspace, '報告.txt'), text);
  const uploads = await prepareBrowserUploads(f.workspace, ['資料\\添付.bin', './報告.txt']);
  assert.equal(uploads.root, await realpath(f.workspace));
  assert.deepEqual(
    uploads.files.map((file) => file.data),
    [binary, text],
  );
  const receipts = browserUploadReceipts(uploads);
  assert.deepEqual(receipts, [
    {
      path: '資料/添付.bin',
      name: '添付.bin',
      size: binary.length,
      sha256: createHash('sha256').update(binary).digest('hex'),
    },
    {
      path: '報告.txt',
      name: '報告.txt',
      size: text.length,
      sha256: createHash('sha256').update(text).digest('hex'),
    },
  ]);
  assert.equal(JSON.stringify(receipts).includes(f.workspace), false);
  assert.equal(JSON.stringify(receipts).includes('data'), false);
  receipts[0].name = 'changed review metadata';
  assert.equal(
    browserUploadReceipts(uploads)[0].name,
    '添付.bin',
    'receipts are independent copies',
  );
  await assertBrowserUploadsCurrent(uploads);
  assert.deepEqual(await readFile(path.join(f.workspace, '資料', '添付.bin')), binary);
});

test('requires a bounded list of nonempty portable workspace-relative paths', async () => {
  assert.deepEqual(BROWSER_UPLOAD_LIMITS, {
    maxFiles: 10,
    maxFileBytes: 256 * MiB,
    maxTotalBytes: 512 * MiB,
  });
  for (const paths of [
    null,
    {},
    [],
    [''],
    ['  '],
    [null],
    ['a\0.bin'],
    ['a\nbin'],
    ['a'.repeat(4001)],
  ])
    assert.throws(
      () => normalizeBrowserUploadPaths(paths as readonly string[]),
      /workspace-relative/,
    );
  assert.throws(
    () => normalizeBrowserUploadPaths(Array.from({ length: 11 }, (_, index) => `${index}.txt`)),
    /at most 10 files/,
  );
  for (const name of [
    '/tmp/secret.txt',
    '\\server\\share\\secret.txt',
    '\\\\server\\share\\secret.txt',
    '//server/share/secret.txt',
    'C:\\secret.txt',
    'C:/secret.txt',
    'C:secret.txt',
    'https://example.test/secret.txt',
    'file:///secret.txt',
    'data:text/plain,secret',
    '.env:stream',
    'folder/file.txt:stream',
  ])
    assert.throws(() => normalizeBrowserUploadPaths([name]), /workspace-relative/);
  for (const name of ['../secret.txt', '..\\secret.txt', 'folder/../../secret.txt'])
    assert.throws(() => normalizeBrowserUploadPaths([name]), /outside the configured workspace/);
  assert.deepEqual(normalizeBrowserUploadPaths(['./folder/../report.txt']), ['report.txt']);
});

test(
  'the default upload policy accepts an actual 100 MiB binary file with exact bytes',
  // Includes large-file setup and hashing under the parallel suite. The same
  // Windows fixture has completed in 11 s and exceeded 30 s on hosted runners.
  { timeout: 120_000 },
  async (t) => {
    let phase = 'fixture';
    let phaseStarted = performance.now();
    const timings: string[] = [];
    const checkpoint = (next: string) => {
      const now = performance.now();
      timings.push(`${phase}=${Math.round(now - phaseStarted)} ms`);
      phase = next;
      phaseStarted = now;
    };
    t.after(() => {
      const progress = phase === 'complete' ? 'verified' : `stopped during ${phase}`;
      const pending =
        phase === 'complete' ? [] : [`${phase}=${Math.round(performance.now() - phaseStarted)} ms`];
      t.diagnostic(`100 MiB upload ${progress}: ${[...timings, ...pending].join(', ')}`);
    });
    const f = await fixture(t);
    const size = 100 * MiB;
    const first = Buffer.from([0, 255, 7, 128]);
    const last = Buffer.from([13, 10, 0, 254]);
    const handle = await open(path.join(f.workspace, 'large.bin'), 'w');
    try {
      await handle.truncate(size);
      await handle.write(first, 0, first.length, 0);
      await handle.write(last, 0, last.length, size - last.length);
    } finally {
      await handle.close();
    }
    checkpoint('expected hash');
    const expected = createHash('sha256').update(first);
    const zeros = Buffer.alloc(64 * 1024);
    for (let left = size - first.length - last.length; left > 0; left -= zeros.length)
      expected.update(zeros.subarray(0, Math.min(left, zeros.length)));
    expected.update(last);
    checkpoint('reader');
    const uploads = await prepareBrowserUploads(f.workspace, ['large.bin'], t.signal);
    checkpoint('assertions');
    assert.equal(uploads.files[0].size, size);
    assert.equal(uploads.files[0].data.length, size);
    assert.deepEqual(uploads.files[0].data.subarray(0, first.length), first);
    assert.deepEqual(uploads.files[0].data.subarray(-last.length), last);
    assert.equal(uploads.files[0].sha256, expected.digest('hex'));
    checkpoint('complete');
  },
);

test('configured byte and count boundaries are exact and remain pinned when no new policy is supplied', async (t) => {
  const f = await fixture(t);
  const limits = { maxFiles: 2, maxFileBytes: 4, maxTotalBytes: 6 };
  await writeFile(path.join(f.workspace, 'a.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(f.workspace, 'b.bin'), Buffer.from([4, 5]));
  await writeFile(path.join(f.workspace, 'c.bin'), Buffer.from([6, 7, 8]));
  await writeFile(path.join(f.workspace, 'large.bin'), Buffer.alloc(5));
  const uploads = await prepareBrowserUploads(f.workspace, ['a.bin', 'b.bin'], undefined, limits);
  assert.deepEqual(
    uploads.files.map((file) => file.size),
    [4, 2],
  );
  assertBrowserUploadLimits(uploads, limits);
  await assertBrowserUploadsCurrent(uploads);
  await assert.rejects(
    prepareBrowserUploads(f.workspace, ['large.bin'], undefined, limits),
    /4 bytes.*per-file/,
  );
  await assert.rejects(
    prepareBrowserUploads(f.workspace, ['a.bin', 'c.bin'], undefined, limits),
    /combined 6 bytes/,
  );
  await assert.rejects(
    prepareBrowserUploads(f.workspace, ['a.bin', 'b.bin', 'c.bin'], undefined, limits),
    /at most 2 files/,
  );
  const names = Array.from({ length: 11 }, (_, index) => `small-${index}.bin`);
  await Promise.all(
    names.map((name) => writeFile(path.join(f.workspace, name), Buffer.from([42]))),
  );
  const raised = await prepareBrowserUploads(f.workspace, names, undefined, {
    maxFiles: 11,
    maxFileBytes: 1,
    maxTotalBytes: 11,
  });
  await assertBrowserUploadsCurrent(raised);
  assert.equal(
    raised.files.length,
    11,
    'rechecking without new settings keeps the approved count policy',
  );
  await assert.rejects(
    assertBrowserUploadsCurrent(raised, undefined, BROWSER_UPLOAD_LIMITS),
    /at most 10 files/,
  );
});

test('lowered live limits reject approved metadata before reading changed or missing sources', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'a.bin'), Buffer.alloc(4, 1));
  await writeFile(path.join(f.workspace, 'b.bin'), Buffer.alloc(2, 2));
  const limits = { maxFiles: 2, maxFileBytes: 4, maxTotalBytes: 6 };
  const uploads = await prepareBrowserUploads(f.workspace, ['a.bin', 'b.bin'], undefined, limits);
  await rm(path.join(f.workspace, 'a.bin'));
  for (const [current, error] of [
    [{ ...limits, maxFiles: 1 }, /at most 1 file/],
    [{ ...limits, maxFileBytes: 3 }, /3 bytes.*per-file/],
    [{ ...limits, maxTotalBytes: 5 }, /combined 5 bytes/],
  ] as const) {
    assert.throws(() => assertBrowserUploadLimits(uploads, current), error);
    await assert.rejects(assertBrowserUploadsCurrent(uploads, undefined, current), error);
  }
  await assert.rejects(assertBrowserUploadsCurrent(uploads), /does not exist|disappeared/);
  assert.equal(
    uploads.files[0].data.length,
    4,
    'a rejected live policy does not rewrite approved bytes',
  );
});

test('upload policy conversion preserves operator values and rejects invalid configuration without coercion', () => {
  assert.deepEqual(browserUploadLimits(), BROWSER_UPLOAD_LIMITS);
  assert.deepEqual(
    browserUploadLimits({ uploadMaxFiles: 21, uploadMaxFileMiB: 600, uploadMaxTotalMiB: 1200 }),
    {
      maxFiles: 21,
      maxFileBytes: 600 * MiB,
      maxTotalBytes: 1200 * MiB,
    },
  );
  for (const settings of [
    null,
    [],
    { uploadMaxFiles: 0 },
    { uploadMaxFiles: 101 },
    { uploadMaxFiles: 1.5 },
    { uploadMaxFiles: '12' },
    { uploadMaxFileMiB: 0 },
    { uploadMaxFileMiB: 1025 },
    { uploadMaxFileMiB: null },
    { uploadMaxTotalMiB: 2049 },
    { uploadStorageMiB: 32769 },
    { uploadMaxFileMiB: 2, uploadMaxTotalMiB: 1 },
    { uploadMaxFileMiB: 1, uploadMaxTotalMiB: 3, uploadStorageMiB: 2 },
  ])
    assert.throws(
      () => browserUploadLimits(settings as Partial<BrowserSettings>),
      Error,
      JSON.stringify(settings),
    );
  for (const limits of [
    null,
    { ...BROWSER_UPLOAD_LIMITS, maxFiles: 0 },
    { ...BROWSER_UPLOAD_LIMITS, maxFiles: 101 },
    { ...BROWSER_UPLOAD_LIMITS, maxFileBytes: 0 },
    { ...BROWSER_UPLOAD_LIMITS, maxFileBytes: 1.5 },
    { ...BROWSER_UPLOAD_LIMITS, maxFileBytes: 1024 * MiB + 1 },
    { ...BROWSER_UPLOAD_LIMITS, maxTotalBytes: Number.NaN },
    { ...BROWSER_UPLOAD_LIMITS, maxTotalBytes: 2048 * MiB + 1 },
    { maxFiles: 1, maxFileBytes: 3, maxTotalBytes: 2 },
  ])
    assert.throws(
      () => normalizeBrowserUploadPaths(['a.bin'], limits as BrowserUploadLimits),
      /limit/i,
    );
});

test('retains workspace secret-file and symlink escape boundaries', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.workspace, '.ssh'));
  await mkdir(path.join(f.workspace, '.git'));
  for (const name of [
    '.env',
    '.env.local',
    'credentials.json',
    'private.pem',
    '.ssh/key',
    '.git/config',
  ]) {
    await writeFile(path.join(f.workspace, name), 'private');
    await assert.rejects(prepareBrowserUploads(f.workspace, [name]), /Credential files/);
  }
  const outside = path.join(f.directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'document.txt'), 'outside');
  await symlink(outside, path.join(f.workspace, 'escape'), 'junction');
  await assert.rejects(
    prepareBrowserUploads(f.workspace, ['escape/document.txt']),
    /symlink outside/,
  );
  const documents = path.join(f.workspace, 'documents');
  await mkdir(documents);
  await writeFile(path.join(documents, 'document.txt'), 'inside');
  await symlink(documents, path.join(f.workspace, 'alias'), 'junction');
  const uploads = await prepareBrowserUploads(f.workspace, ['alias/document.txt']);
  assert.equal(uploads.files[0].path, 'alias/document.txt');
  assert.equal(uploads.files[0].data.toString(), 'inside');
  await assertBrowserUploadsCurrent(uploads);
  if (process.platform !== 'win32') {
    await symlink('.env', path.join(f.workspace, 'private-alias.txt'));
    await assert.rejects(
      prepareBrowserUploads(f.workspace, ['private-alias.txt']),
      /Credential files/,
    );
  }
});

test('rejects duplicate normalized paths, canonical aliases, and hard links', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.workspace, 'documents'));
  await writeFile(path.join(f.workspace, 'documents', 'report.txt'), 'report');
  await assert.rejects(
    prepareBrowserUploads(f.workspace, ['documents/report.txt', './documents\\report.txt']),
    /Duplicate browser upload file path/,
  );
  await symlink(path.join(f.workspace, 'documents'), path.join(f.workspace, 'alias'), 'junction');
  await assert.rejects(
    prepareBrowserUploads(f.workspace, ['documents/report.txt', 'alias/report.txt']),
    /Duplicate browser upload file/,
  );
  await link(
    path.join(f.workspace, 'documents', 'report.txt'),
    path.join(f.workspace, 'linked.txt'),
  );
  await assert.rejects(
    prepareBrowserUploads(f.workspace, ['documents/report.txt', 'linked.txt']),
    /Duplicate browser upload file/,
  );
});

test('rejects missing, empty, directory and oversized inputs before reading file bytes', async (t) => {
  const f = await fixture(t);
  const limits = { maxFiles: 3, maxFileBytes: 4, maxTotalBytes: 8 };
  await assert.rejects(prepareBrowserUploads(f.workspace, ['missing.txt']), /does not exist/);
  await writeFile(path.join(f.workspace, 'empty.txt'), '');
  await assert.rejects(prepareBrowserUploads(f.workspace, ['empty.txt']), /empty \(0 bytes\)/);
  await mkdir(path.join(f.workspace, 'folder'));
  await assert.rejects(prepareBrowserUploads(f.workspace, ['folder']), /regular file/);
  await assert.rejects(prepareBrowserUploads(f.workspace, ['.']), /regular file/);
  for (const [name, size] of [
    ['huge.bin', limits.maxFileBytes + 1],
    ['large-a.bin', limits.maxFileBytes],
    ['large-b.bin', limits.maxFileBytes],
    ['extra.bin', 1],
  ] as const) {
    const handle = await open(path.join(f.workspace, name), 'w');
    await handle.truncate(size);
    await handle.close();
  }
  const originalOpen = fs.open;
  const opened: string[] = [];
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    opened.push(String(args[0]));
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      prepareBrowserUploads(f.workspace, ['huge.bin'], undefined, limits),
      /4 bytes/,
    );
    await assert.rejects(
      prepareBrowserUploads(
        f.workspace,
        ['large-a.bin', 'large-b.bin', 'extra.bin'],
        undefined,
        limits,
      ),
      /combined 8 bytes/,
    );
    assert.deepEqual(
      opened,
      [],
      'all input sizes are checked before allocating or reading contents',
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('rejects same-size writes and deleted sources while retaining the originally inspected bytes', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.workspace, 'report.txt');
  await writeFile(filename, 'approved');
  const before = await fs.stat(filename);
  const uploads = await prepareBrowserUploads(f.workspace, ['report.txt']);
  await writeFile(filename, 'replaced');
  await utimes(filename, before.atime, before.mtime);
  await assert.rejects(assertBrowserUploadsCurrent(uploads), /changed/);
  assert.equal(uploads.files[0].data.toString(), 'approved');
  const replaced = await prepareBrowserUploads(f.workspace, ['report.txt']);
  await rm(filename);
  await assert.rejects(assertBrowserUploadsCurrent(replaced), /does not exist|disappeared/);
});

test('rejects replacement by another inode even when its name and bytes match', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.workspace, 'report.txt');
  await writeFile(filename, 'same bytes');
  await writeFile(path.join(f.workspace, 'replacement.txt'), 'same bytes');
  const uploads = await prepareBrowserUploads(f.workspace, ['report.txt']);
  await rename(filename, path.join(f.workspace, 'old.txt'));
  await rename(path.join(f.workspace, 'replacement.txt'), filename);
  await assert.rejects(assertBrowserUploadsCurrent(uploads), /changed/);
});

test('rejects changed symlink destinations and replaced canonical ancestor directories', async (t) => {
  const f = await fixture(t);
  for (const folder of ['one', 'two']) {
    await mkdir(path.join(f.workspace, folder));
    await writeFile(path.join(f.workspace, folder, 'report.txt'), 'same bytes');
  }
  const alias = path.join(f.workspace, 'alias');
  await symlink(path.join(f.workspace, 'one'), alias, 'junction');
  const uploads = await prepareBrowserUploads(f.workspace, ['alias/report.txt']);
  await rm(alias);
  await symlink(path.join(f.workspace, 'two'), alias, 'junction');
  await assert.rejects(assertBrowserUploadsCurrent(uploads), /changed/);
  const direct = await prepareBrowserUploads(f.workspace, ['one/report.txt']);
  await rename(path.join(f.workspace, 'one'), path.join(f.workspace, 'original'));
  await mkdir(path.join(f.workspace, 'one'));
  // Preserve the file inode so the directory checks, rather than just the file
  // identity, must reject this replacement.
  await rename(
    path.join(f.workspace, 'original', 'report.txt'),
    path.join(f.workspace, 'one', 'report.txt'),
  );
  await assert.rejects(assertBrowserUploadsCurrent(direct), /changed/);
});

test('pins both the original workspace path and its canonical directory identity', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'report.txt'), 'same bytes');
  const entry = path.join(f.directory, 'current-workspace');
  await symlink(f.workspace, entry, 'junction');
  const uploads = await prepareBrowserUploads(entry, ['report.txt']);
  const other = path.join(f.directory, 'other-workspace');
  await mkdir(other);
  await writeFile(path.join(other, 'report.txt'), 'same bytes');
  await rm(entry);
  await symlink(other, entry, 'junction');
  await assert.rejects(assertBrowserUploadsCurrent(uploads), /changed/);
  const direct = await prepareBrowserUploads(f.workspace, ['report.txt']);
  await rename(f.workspace, path.join(f.directory, 'old-workspace'));
  await mkdir(f.workspace);
  await rename(
    path.join(f.directory, 'old-workspace', 'report.txt'),
    path.join(f.workspace, 'report.txt'),
  );
  await assert.rejects(assertBrowserUploadsCurrent(direct), /changed/);
  const deleted = await prepareBrowserUploads(f.workspace, ['report.txt']);
  await rm(f.workspace, { recursive: true });
  await assert.rejects(assertBrowserUploadsCurrent(deleted), /does not exist|disappeared/);
  await assert.rejects(
    fs.stat(f.workspace),
    { code: 'ENOENT' },
    'validation never recreates a removed workspace',
  );
});

test('rejects forged preparations, changed review metadata, and mutated retained bytes', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'report.txt'), 'approved');
  const uploads = await prepareBrowserUploads(f.workspace, ['report.txt']);
  await assert.rejects(
    assertBrowserUploadsCurrent({ ...uploads }),
    /must be prepared by the workspace upload reader/,
  );
  for (const mutate of [
    (value: PreparedBrowserUploads) => {
      value.root = f.directory;
    },
    (value: PreparedBrowserUploads) => {
      value.files[0].path = 'other.txt';
    },
    (value: PreparedBrowserUploads) => {
      value.files[0].name = 'other.txt';
    },
    (value: PreparedBrowserUploads) => {
      value.files[0].size++;
    },
    (value: PreparedBrowserUploads) => {
      value.files[0].sha256 = '0'.repeat(64);
    },
    (value: PreparedBrowserUploads) => {
      value.files.push(value.files[0]);
    },
    (value: PreparedBrowserUploads) => {
      value.files[0].data = Buffer.alloc(0);
    },
  ]) {
    const value = await prepareBrowserUploads(f.workspace, ['report.txt']);
    mutate(value);
    await assert.rejects(assertBrowserUploadsCurrent(value), /metadata changed/);
  }
  uploads.files[0].data[0] ^= 1;
  await assert.rejects(assertBrowserUploadsCurrent(uploads), /bytes changed/);
});

test('file replacement between checking and opening cannot return unrelated bytes', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.workspace, 'report.txt');
  await writeFile(filename, 'approved');
  await writeFile(path.join(f.workspace, 'replacement.txt'), 'replaced');
  const target = await realpath(filename);
  const originalOpen = fs.open;
  let replaced = false;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === target && !replaced) {
      replaced = true;
      await rename(filename, path.join(f.workspace, 'previous.txt'));
      await rename(path.join(f.workspace, 'replacement.txt'), filename);
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareBrowserUploads(f.workspace, ['report.txt']), /changed/);
    assert.equal(replaced, true);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('a growing file remains bounded and cancellation closes the reader between chunks', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.workspace, 'changing.bin');
  const original = Buffer.alloc(128 * 1024, 42);
  await writeFile(filename, original);
  const target = await realpath(filename);
  const originalOpen = fs.open;
  const abort = new AbortController();
  let mode: 'grow' | 'abort' = 'grow';
  let returnedBytes = 0;
  let closed = 0;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === target) {
      const originalRead = handle.read.bind(handle);
      const originalClose = handle.close.bind(handle);
      let changed = false;
      t.mock.method(handle, 'close', async () => {
        closed++;
        return originalClose();
      });
      t.mock.method(
        handle,
        'read',
        async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await originalRead(buffer, offset, length, position);
          returnedBytes += result.bytesRead;
          if (!changed) {
            changed = true;
            if (mode === 'grow') await appendFile(filename, Buffer.alloc(256 * 1024));
            else abort.abort();
          }
          return result;
        },
      );
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareBrowserUploads(f.workspace, ['changing.bin']), /changed/);
    assert.ok(returnedBytes <= original.length + 1, 'growth cannot enlarge the bounded read');
    assert.equal(closed, 1);
    await writeFile(filename, original);
    returnedBytes = 0;
    mode = 'abort';
    await assert.rejects(
      prepareBrowserUploads(f.workspace, ['changing.bin'], abort.signal),
      /Task stopped/,
    );
    assert.ok(returnedBytes <= 64 * 1024, 'abort is checked between chunks');
    assert.equal(closed, 2);
    await assert.rejects(
      prepareBrowserUploads(f.workspace, ['changing.bin'], abort.signal),
      /Task stopped/,
    );
    assert.equal(closed, 2, 'an already cancelled call never opens a source');
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('rejects a retained-byte change made during the asynchronous approval recheck', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.workspace, 'report.txt');
  await writeFile(filename, 'approved');
  const uploads = await prepareBrowserUploads(f.workspace, ['report.txt']);
  const target = await realpath(filename);
  const originalOpen = fs.open;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === target) uploads.files[0].data[0] ^= 1;
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(assertBrowserUploadsCurrent(uploads), /bytes changed/);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
