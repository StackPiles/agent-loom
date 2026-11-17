import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  activeManagedImages,
  consolidateManagedImageAlias,
  isImageAssetDeleted,
  markImageAssetDeleted,
  persistManagedImageAsset,
  readManagedImageAsset,
  retainManagedImage,
} from '../src/server/image-assets.js';

const pixels = Buffer.from('immutable original image pixels');
const hash = createHash('sha256').update(pixels).digest('hex');
const imageId = (key: string) => `img_${createHash('sha256').update(key).digest('hex')}`;
const alias = (key: string) => `${imageId(key)}.png`;
const deletedAt = '2026-11-17T00:00:00.000Z';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'loom-image-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('session originals and generated aliases share exact bytes without replacing existing images', async (t) => {
  const directory = await fixture(t);
  const stored = persistManagedImageAsset(directory, pixels, alias('one'));
  const second = persistManagedImageAsset(directory, pixels, alias('two'));
  assert.equal(stored.hash, hash);
  assert.equal(second.assetPath, stored.assetPath);
  assert.deepEqual(readManagedImageAsset(directory, hash, pixels.length), pixels);
  const original = await stat(stored.assetPath);
  for (const key of ['one', 'two']) {
    const filename = path.join(directory, 'generated-images', alias(key));
    assert.deepEqual(await readFile(filename), pixels);
    const linked = await stat(filename);
    assert.equal(linked.dev, original.dev);
    assert.equal(linked.ino, original.ino);
  }
  assert.throws(() => persistManagedImageAsset(directory, pixels, alias('one')), {
    code: 'EEXIST',
  });
  assert.deepEqual(await readFile(path.join(directory, 'generated-images', alias('one'))), pixels);
  assert.deepEqual(await readdir(path.join(directory, 'sessions', 'assets')), [`${hash}.bin`]);
});

test('copy fallback preserves originals and unsupported deduplication creates no extra canonical copy', async (t) => {
  const directory = await fixture(t);
  const existing = await fixture(t);
  await mkdir(path.join(existing, 'generated-images'));
  await writeFile(path.join(existing, 'generated-images', alias('legacy')), pixels);
  const mocked = t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('Hard links are unsupported.'), { code: 'ENOTSUP' });
  });
  syncBuiltinESMExports();
  try {
    const saved = persistManagedImageAsset(directory, pixels, alias('fallback'));
    assert.deepEqual(readManagedImageAsset(directory, saved.hash, pixels.length), pixels);
    assert.deepEqual(
      await readFile(path.join(directory, 'generated-images', alias('fallback'))),
      pixels,
    );
    assert.throws(() => persistManagedImageAsset(directory, pixels, alias('fallback')), {
      code: 'EEXIST',
    });
    const result = consolidateManagedImageAlias(existing, alias('legacy'), pixels);
    assert.equal(result.linked, false);
    assert.equal(fs.existsSync(result.assetPath), false);
    assert.deepEqual(await readdir(path.join(existing, 'sessions', 'assets')), []);
    assert.deepEqual(
      await readFile(path.join(existing, 'generated-images', alias('legacy'))),
      pixels,
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('existing copies consolidate only after verifying their exact content', async (t) => {
  const directory = await fixture(t);
  await mkdir(path.join(directory, 'generated-images'));
  for (const key of ['legacy-one', 'legacy-two'])
    await writeFile(path.join(directory, 'generated-images', alias(key)), pixels);
  const first = consolidateManagedImageAlias(directory, alias('legacy-one'), pixels);
  const second = consolidateManagedImageAlias(directory, alias('legacy-two'), pixels);
  assert.equal(first.linked, true);
  assert.equal(second.linked, true);
  const original = await stat(first.assetPath);
  for (const key of ['legacy-one', 'legacy-two']) {
    const filename = path.join(directory, 'generated-images', alias(key));
    assert.deepEqual(await readFile(filename), pixels);
    assert.equal((await stat(filename)).ino, original.ino);
  }
  assert.equal(consolidateManagedImageAlias(directory, alias('legacy-one'), pixels).linked, false);
  const changed = Buffer.from(pixels);
  changed[0] ^= 1;
  await writeFile(path.join(directory, 'generated-images', alias('changed')), changed);
  assert.throws(
    () => consolidateManagedImageAlias(directory, alias('changed'), pixels),
    /integrity check/,
  );
  assert.deepEqual(
    await readFile(path.join(directory, 'generated-images', alias('changed'))),
    changed,
  );
});

test('retirement is durable before deletion and only a verified new save restores the original', async (t) => {
  const directory = await fixture(t);
  const saved = persistManagedImageAsset(directory, pixels, alias('retired'));
  markImageAssetDeleted(directory, hash, deletedAt);
  const marker = path.join(directory, 'sessions', 'assets-retired', `${hash}.json`);
  assert.ok((await stat(marker)).size <= 1024);
  await rm(saved.assetPath);
  await rm(path.join(directory, 'generated-images', alias('retired')));
  assert.equal(isImageAssetDeleted(directory, hash), true);
  assert.throws(() => readManagedImageAsset(directory, hash, pixels.length), /image is missing/);
  assert.throws(
    () =>
      persistManagedImageAsset(
        directory,
        pixels,
        alias('cancelled'),
        AbortSignal.abort(new Error('cancelled')),
      ),
    /cancelled/,
  );
  assert.equal(isImageAssetDeleted(directory, hash), true);
  persistManagedImageAsset(directory, pixels, alias('reattached'));
  assert.equal(isImageAssetDeleted(directory, hash), false);
  assert.deepEqual(readManagedImageAsset(directory, hash, pixels.length), pixels);

  markImageAssetDeleted(directory, hash, deletedAt);
  await writeFile(marker, '{invalid marker');
  assert.throws(() => isImageAssetDeleted(directory, hash), /marker is invalid/);
  assert.throws(() => persistManagedImageAsset(directory, pixels), /marker is invalid/);
  assert.deepEqual(
    await readFile(saved.assetPath),
    pixels,
    'an invalid marker never damages pixels',
  );
});

test('reader leases precede I/O and recent publication protects the catalog registration gap', async (t) => {
  const directory = await fixture(t);
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const id = imageId('lease');
  const release = retainManagedImage(directory, { imageId: id, hash });
  const secondRelease = retainManagedImage(directory, { imageId: id });
  assert.deepEqual(activeManagedImages(directory), {
    imageIds: new Set([id]),
    hashes: new Set([hash]),
  });
  release();
  release();
  assert.deepEqual(activeManagedImages(directory), { imageIds: new Set([id]), hashes: new Set() });
  secondRelease();
  persistManagedImageAsset(directory, pixels, alias('published'));
  assert.equal(activeManagedImages(directory).hashes.has(hash), true);
  now += 5 * 60 * 1000 + 1;
  assert.deepEqual(activeManagedImages(directory), { imageIds: new Set(), hashes: new Set() });
});

test('managed paths never follow descendant symlinks or accept path-like identities', async (t) => {
  const directory = await fixture(t);
  assert.throws(() => persistManagedImageAsset(directory, pixels, '../outside.png'), /alias/);
  assert.throws(() => markImageAssetDeleted(directory, '../outside', deletedAt), /hash/);
  assert.throws(() => retainManagedImage(directory, { imageId: '../outside' }), /identity/);
  if (process.platform === 'win32') return;
  const outside = await fixture(t);
  await mkdir(path.join(directory, 'sessions'));
  await symlink(outside, path.join(directory, 'sessions', 'assets-retired'));
  assert.throws(() => markImageAssetDeleted(directory, hash, deletedAt), /unsafe link/);
  assert.deepEqual(await readdir(outside), []);
  await symlink(outside, path.join(directory, 'sessions', 'assets'));
  assert.throws(() => persistManagedImageAsset(directory, pixels), /unsafe link/);
  assert.deepEqual(await readdir(outside), []);
});
