import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import { markImageAssetDeleted } from '../src/server/image-assets.js';
import type { ImageRetentionState, ImageStorageOverview } from '../src/shared/image-storage.js';
import type { GeneratedImage, Message } from '../src/shared/types.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQcPj/HwAEQgJfMvKOtQAAAABJRU5ErkJggg==',
  'base64',
);
const old = '2020-01-01T00:00:00.000Z';
type Retention = ImageRetentionState & { id: string };
const idleRuntime = () => ({
  start() {},
  async stop() {},
  async shutdown() {},
  queueState: () => ({ active: 0, waiting: 0 }),
});

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-image-storage-api-'));
  const apiToken = 'image-storage-fixture-token';
  const options = { dataDir, apiToken, scheduler: false, runtimeFactory: idleRuntime };
  let current = await createApp(options);
  t.after(async () => {
    await current.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const headers = { host: 'localhost', authorization: `Bearer ${apiToken}` };
  const image: GeneratedImage = {
    id: `img_${'a'.repeat(64)}`,
    type: 'image',
    mimeType: 'image/png',
    filename: 'fixture.png',
    byteLength: png.length,
    model: 'fixture',
    prompt: 'A stored fixture image.',
    source: 'generated',
    createdAt: old,
  };
  // A pre-feature original has no publication lease. All data is disposable.
  await mkdir(join(dataDir, 'generated-images'), { recursive: true });
  await writeFile(join(dataDir, 'generated-images', `${image.id}.png`), png);
  const message = current.controller.addMessage({
    roomId: 'room_lounge',
    authorType: 'bot',
    authorId: 'bot_aster',
    body: 'The original context remains after image cleanup.',
    status: 'complete',
    attachments: [image],
  });
  const expire = () => {
    const state = current.store.get<Retention>('imageRetention', image.id)!;
    current.store.put('imageRetention', { ...state, initializedAt: old, lastUsedAt: old });
  };
  return {
    get current() {
      return current;
    },
    dataDir,
    image,
    hash: createHash('sha256').update(png).digest('hex'),
    message,
    headers,
    expire,
    async restart() {
      await current.app.close();
      current = await createApp(options);
    },
    get(url: string) {
      return current.app.inject({ method: 'GET', url, headers });
    },
    post(url: string, payload: object) {
      return current.app.inject({ method: 'POST', url, headers, payload });
    },
  };
}

test('storage routes inherit authentication and origin checks and reject unreviewed cleanup requests', async (t) => {
  const f = await fixture(t);
  const unauthenticated = await f.current.app.inject({
    method: 'GET',
    url: '/api/image-storage',
    headers: { host: 'localhost' },
  });
  assert.equal(unauthenticated.statusCode, 401);
  const crossOrigin = await f.current.app.inject({
    method: 'PATCH',
    url: '/api/image-storage/settings',
    headers: { ...f.headers, origin: 'https://untrusted.example' },
    payload: { autoCleanup: true },
  });
  assert.equal(crossOrigin.statusCode, 403);
  for (const payload of [{}, { imageIds: [] }, { imageIds: ['../outside.png'] }, { all: true }])
    assert.equal((await f.post('/api/image-storage/cleanup', payload)).statusCode, 400);
  assert.equal(
    (await f.post(`/api/images/${f.image.id}/use`, { reason: 'thumbnail' })).statusCode,
    400,
  );
  const invalidPolicy = await f.current.app.inject({
    method: 'PATCH',
    url: '/api/image-storage/settings',
    headers: f.headers,
    payload: { unusedDays: 0 },
  });
  assert.equal(invalidPolicy.statusCode, 400);
  const overview = (await f.get('/api/image-storage')).json<ImageStorageOverview>();
  assert.deepEqual(overview.settings, { autoCleanup: false, unusedDays: 30 });
});

test('thumbnail reads preserve the unused window while explicit open and download postpone cleanup', async (t) => {
  const f = await fixture(t);
  f.expire();
  let overview = (await f.get('/api/image-storage?filter=candidates')).json<ImageStorageOverview>();
  assert.equal(overview.total, 1);
  const thumbnail = await f.get(`/api/images/${f.image.id}`);
  assert.equal(thumbnail.statusCode, 200);
  assert.deepEqual(thumbnail.rawPayload, png);
  assert.equal(f.current.store.get<Retention>('imageRetention', f.image.id)!.lastUsedAt, old);
  const download = await f.get(`/api/images/${f.image.id}?download=1`);
  assert.equal(download.statusCode, 200);
  assert.match(String(download.headers['content-disposition']), /^attachment;/);
  assert.notEqual(f.current.store.get<Retention>('imageRetention', f.image.id)!.lastUsedAt, old);
  overview = (await f.get('/api/image-storage?filter=candidates')).json<ImageStorageOverview>();
  assert.equal(overview.total, 0);
  const skipped = await f.post('/api/image-storage/cleanup', { imageIds: [f.image.id] });
  assert.equal(skipped.statusCode, 200, skipped.body);
  assert.equal(skipped.json().deletedImages, 0);
  assert.equal(skipped.json().skipped[0].reason, 'recent');
  f.expire();
  assert.equal((await f.post(`/api/images/${f.image.id}/use`, { reason: 'open' })).statusCode, 200);
  assert.notEqual(f.current.store.get<Retention>('imageRetention', f.image.id)!.lastUsedAt, old);
});

test('protection choices and last use survive stale attachment updates and a server restart', async (t) => {
  const f = await fixture(t);
  f.expire();
  const keep = await f.post('/api/image-storage/protection', {
    imageIds: [f.image.id],
    protected: true,
  });
  assert.equal(keep.statusCode, 200, keep.body);
  assert.equal(keep.json().updated, 1);
  f.current.controller.updateMessage(f.message.id, { attachments: [f.image] });
  const attachment = f.current.store.get<Message>('messages', f.message.id)!.attachments![0];
  assert.equal(attachment.storage?.protected, true);
  assert.equal(attachment.storage?.lastUsedAt, old);
  await f.restart();
  const state = f.current.store.get<Retention>('imageRetention', f.image.id)!;
  assert.equal(state.protected, true);
  assert.equal(state.lastUsedAt, old);
  const blocked = await f.post('/api/image-storage/cleanup', { imageIds: [f.image.id] });
  assert.equal(blocked.json().deletedImages, 0);
  assert.equal(blocked.json().skipped[0].reason, 'protected');
  const unkeep = await f.post('/api/image-storage/protection', {
    imageIds: [f.image.id],
    protected: false,
  });
  assert.equal(unkeep.statusCode, 200);
  await f.restart();
  assert.equal(f.current.store.get<Retention>('imageRetention', f.image.id)!.protected, false);
});

test('reviewed cleanup preserves message context and tombstones across restart with a distinct expired-image response', async (t) => {
  const f = await fixture(t);
  f.expire();
  const result = await f.post('/api/image-storage/cleanup', { imageIds: [f.image.id] });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().deletedImages, 1);
  assert.equal(result.json().freedBytes, png.length);
  const message = f.current.store.get<Message>('messages', f.message.id)!;
  assert.equal(message.body, f.message.body);
  assert.ok(message.attachments![0].storage?.deletedAt);
  await f.restart();
  const expired = await f.get(`/api/images/${f.image.id}`);
  assert.equal(expired.statusCode, 410, expired.body);
  assert.equal(expired.json().code, 'image_retired');
  assert.equal((await f.post(`/api/images/${f.image.id}/use`, { reason: 'open' })).statusCode, 410);
  assert.throws(
    () =>
      f.current.controller.enqueueTask({
        roomId: 'room_lounge',
        botId: 'bot_aster',
        prompt: 'Use the old image',
        inputImageIds: [f.image.id],
      }),
    (error: unknown) => (error as { statusCode: number }).statusCode === 410,
  );
  const overview = (await f.get('/api/image-storage?filter=deleted')).json<ImageStorageOverview>();
  assert.equal(overview.total, 1);
  assert.equal(overview.usage.totalBytes, 0);
});

test('a missing original is never silently relabelled as intentional retention cleanup', async (t) => {
  const f = await fixture(t);
  await rm(join(f.dataDir, 'generated-images', `${f.image.id}.png`));
  const missing = await f.get(`/api/images/${f.image.id}`);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, undefined);
  assert.equal(f.current.store.get<Retention>('imageRetention', f.image.id)!.deletedAt, undefined);
  // A durable tombstone distinguishes explicit expiry from accidental data loss.
  const state = f.current.store.get<Retention>('imageRetention', f.image.id)!;
  markImageAssetDeleted(f.dataDir, f.hash, old);
  f.current.store.put('imageRetention', { ...state, deletedAt: old });
  const retired = await f.get(`/api/images/${f.image.id}`);
  assert.equal(retired.statusCode, 410);
});

test('adopting an avatar counts as explicit use and an expired avatar cannot be adopted from stale metadata', async (t) => {
  const f = await fixture(t);
  f.expire();
  const adopted = await f.current.app.inject({
    method: 'PATCH',
    url: '/api/bots/bot_aster',
    headers: f.headers,
    payload: { avatar: `image:${f.image.id}` },
  });
  assert.equal(adopted.statusCode, 200, adopted.body);
  assert.notEqual(f.current.store.get<Retention>('imageRetention', f.image.id)!.lastUsedAt, old);
  // A current avatar remains a dependency after its last-use timer expires.
  f.expire();
  assert.equal(
    (await f.get('/api/image-storage?filter=candidates')).json<ImageStorageOverview>().total,
    0,
  );
  f.current.store.patch('bots', 'bot_aster', { avatar: '🧵' });
  const cleaned = await f.post('/api/image-storage/cleanup', { imageIds: [f.image.id] });
  assert.equal(cleaned.json().deletedImages, 1, cleaned.body);
  const stale = await f.current.app.inject({
    method: 'PATCH',
    url: '/api/bots/bot_aster',
    headers: f.headers,
    payload: { avatar: `image:${f.image.id}` },
  });
  assert.equal(stale.statusCode, 410, stale.body);
});
