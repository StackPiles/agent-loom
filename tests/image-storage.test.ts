import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import fs, { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import {
  createImageStorage,
  imageWithStorage,
  registerManagedImage,
  touchManagedImage,
} from '../src/server/image-storage.js';
import { isImageAssetDeleted, retainManagedImage } from '../src/server/image-assets.js';
import { createSessionImageStore } from '../src/server/runtime/session-images.js';
import { Store } from '../src/server/store.js';
import type { GeneratedImage, Message, Room, Task, WorkItem } from '../src/shared/types.js';
import type { ImageRetentionState } from '../src/shared/image-storage.js';

const DAY = 86_400_000;
const initialNow = Date.parse('2026-11-17T10:00:00.000Z');
const at = (days: number) => new Date(initialNow + days * DAY).toISOString();
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const diskKey = (value: string) => hash(value).slice(0, 24);

function png(value: number): Buffer {
  const chunk = (kind: string, data: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length);
    header.write(kind, 4, 'ascii');
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind), data])));
    return Buffer.concat([header, data, checksum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk(
      'IDAT',
      deflateSync(Buffer.from([0, value & 255, (100 + (value >>> 8)) & 255, 200, 255])),
    ),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function fixture(t: TestContext, options: { cleanupIntervalMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-image-retention-'));
  const store = new Store(directory);
  store.seed();
  let now = initialNow;
  let paused = false;
  let changes = 0;
  const storage = createImageStorage({
    store,
    now: () => now,
    isPaused: () => paused,
    onChanged: () => changes++,
    cleanupIntervalMs: options.cleanupIntervalMs ?? 20,
  });
  let sequence = 0;
  const image = (
    options: {
      bytes?: Buffer;
      retention?: Partial<ImageRetentionState> | false;
      source?: GeneratedImage['source'];
      asset?: boolean;
      roomId?: string;
      author?: 'user' | 'bot';
    } = {},
  ) => {
    const id = `img_${hash(`image-${++sequence}`)}`;
    const data = options.bytes ?? png(sequence);
    const contentHash = hash(data);
    const record: GeneratedImage = {
      id,
      type: 'image',
      mimeType: 'image/png',
      filename: `${id}.png`,
      byteLength: data.length,
      prompt: `Image ${sequence}`,
      model: 'fixture',
      createdAt: at(-100),
      source: options.source,
    };
    const filename = join(directory, 'generated-images', `${id}.png`);
    const asset = join(directory, 'sessions', 'assets', `${contentHash}.bin`);
    mkdirSync(join(filename, '..'), { recursive: true });
    writeFileSync(filename, data);
    if (options.asset !== false) {
      mkdirSync(join(asset, '..'), { recursive: true });
      if (!existsSync(asset)) writeFileSync(asset, data);
    }
    store.put('images', record);
    if (options.retention !== false)
      store.put('imageRetention', {
        id,
        initializedAt: at(-45),
        lastUsedAt: at(-40),
        protected: false,
        contentHash,
        ...options.retention,
      });
    store.put<Message>('messages', {
      id: `message_${sequence}`,
      roomId: options.roomId ?? 'room_lounge',
      authorType: options.author ?? 'bot',
      authorId: options.author === 'user' ? 'user' : 'bot_aster',
      body: 'An image',
      status: 'complete',
      createdAt: at(-100),
      attachments: [record],
    });
    return { record, id, filename, asset, hash: contentHash, data };
  };
  t.after(async () => {
    await storage.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store,
    storage,
    image,
    advance: (days: number) => {
      now += days * DAY;
    },
    pause: (value: boolean) => {
      paused = value;
    },
    changes: () => changes,
  };
}

function task(store: Store, input: Partial<Task> & { id: string }): Task {
  return store.put<Task>('tasks', {
    roomId: 'room_lounge',
    botId: 'bot_aster',
    rootTaskId: input.id,
    depth: 0,
    kind: 'chat',
    prompt: 'Continue the image task',
    output: '',
    status: 'running',
    createdAt: at(-45),
    updatedAt: at(-40),
    inputTokens: 0,
    outputTokens: 0,
    ...input,
  });
}

function work(store: Store, input: Partial<WorkItem> & { id: string }): WorkItem {
  return store.put<WorkItem>('workItems', {
    roomId: 'room_lounge',
    name: 'Image work',
    purpose: 'Finish an image',
    kind: 'task',
    status: 'paused',
    createdByBotId: 'bot_aster',
    sourceTaskId: 'source_task',
    scope: 'fixture',
    workspacePath: store.settings().workspacePath,
    checkpoint: {
      summary: '',
      completed: '',
      nextStep: '',
      references: [],
      doneWhen: '',
      uncertainActions: [],
    },
    revision: 1,
    createdAt: at(-45),
    updatedAt: at(-40),
    ...input,
  });
}

test('retention uses last deliberate use and adoption grace, not the creation date', async (t) => {
  const f = await fixture(t);
  const old = f.image();
  const recentlyUsed = f.image({ retention: { lastUsedAt: at(-2) } });
  const migrated = f.image({ retention: false });
  const kept = f.image({ retention: { protected: true } });
  const list = await f.storage.list();
  const byId = new Map(list.images.map((image) => [image.id, image]));
  assert.equal(byId.get(old.id)!.candidate, true);
  assert.ok(byId.get(recentlyUsed.id)!.blockedReasons.includes('recent'));
  assert.ok(byId.get(migrated.id)!.blockedReasons.includes('grace'));
  assert.ok(byId.get(kept.id)!.blockedReasons.includes('protected'));
  assert.equal(list.settings.autoCleanup, false);
  assert.equal(list.settings.unusedDays, 30);
  assert.equal(byId.get(recentlyUsed.id)!.eligibleAt, at(28));
  const before = f.store.get<ImageRetentionState>('imageRetention', old.id)!.lastUsedAt;
  await f.storage.list();
  assert.equal(
    f.store.get<ImageRetentionState>('imageRetention', old.id)!.lastUsedAt,
    before,
    'listing is not image use',
  );
});

test('legacy owner attachments start protected and an explicit unprotect survives reinitialization', async (t) => {
  const f = await fixture(t);
  const legacy = f.image({ retention: false, author: 'user' });
  const uploaded = f.image({ retention: false, source: 'uploaded' });
  await f.storage.initialize();
  assert.equal(imageWithStorage(f.store, legacy.record).storage!.protected, true);
  assert.equal(imageWithStorage(f.store, uploaded.record).storage!.protected, true);
  f.storage.setProtected(legacy.id, false);
  await f.storage.initialize();
  registerManagedImage(f.store, legacy.record, { uploaded: true });
  assert.equal(imageWithStorage(f.store, legacy.record).storage!.protected, false);
});

test('cleanup removes only current eligible originals, records tombstones, and preserves conversation text', async (t) => {
  const f = await fixture(t);
  const old = f.image();
  const fresh = f.image({ retention: { lastUsedAt: at(-1) } });
  const protectedImage = f.image({ retention: { protected: true } });
  const result = await f.storage.cleanup([old.id, fresh.id, protectedImage.id]);
  assert.equal(result.deletedImages, 1);
  assert.equal(result.freedBytes, old.data.length * 2);
  assert.equal(existsSync(old.filename), false);
  assert.equal(existsSync(old.asset), false);
  assert.equal(isImageAssetDeleted(f.directory, old.hash), true);
  assert.equal(existsSync(fresh.filename), true);
  assert.equal(existsSync(protectedImage.filename), true);
  assert.deepEqual(
    new Set(result.skipped.map((entry) => entry.id)),
    new Set([fresh.id, protectedImage.id]),
  );
  const message = f.store.get<Message>('messages', 'message_1')!;
  assert.equal(message.body, 'An image');
  assert.ok(message.attachments![0].storage!.deletedAt);
  assert.throws(() => f.storage.touch(old.id, 'open'), /removed/);
});

test('same-content aliases across rooms are retained together when one is protected or recently used', async (t) => {
  const f = await fixture(t);
  const bytes = png(99);
  const first = f.image({ bytes });
  const second = f.image({ bytes, roomId: 'other_room', retention: { protected: true } });
  const list = await f.storage.list();
  assert.ok(list.images.find((image) => image.id === first.id)!.blockedReasons.includes('shared'));
  assert.equal((await f.storage.cleanup([first.id, second.id])).deletedImages, 0);
  f.storage.setProtected(second.id, false);
  const partial = await f.storage.cleanup([first.id]);
  assert.equal(partial.deletedImages, 1);
  assert.equal(partial.freedBytes, bytes.length);
  assert.equal(existsSync(first.asset), true);
  assert.equal(isImageAssetDeleted(f.directory, first.hash), false);
  const removed = await f.storage.cleanup([second.id]);
  assert.equal(removed.deletedImages, 1);
  assert.equal(removed.freedBytes, bytes.length * 2);
  assert.equal(existsSync(first.filename), false);
  assert.equal(existsSync(second.filename), false);
});

test('queued, running, stopped and interrupted task image inputs remain available', async (t) => {
  const f = await fixture(t);
  const all = [
    'queued',
    'running',
    'waiting_model',
    'waiting_tool',
    'awaiting_approval',
    'stopped',
    'interrupted',
    'failed',
  ] as const;
  const images = all.map((status, index) => {
    const image = f.image();
    task(f.store, { id: `task_${index}`, status, inputImageIds: [image.id] });
    return image;
  });
  const result = await f.storage.cleanup(images.map((image) => image.id));
  assert.equal(result.deletedImages, 0);
  assert.ok(result.skipped.every((image) => image.reason === 'work'));
  assert.ok(images.every((image) => existsSync(image.filename)));
});

test('open work checkpoints and saved session hashes protect images after a task has settled', async (t) => {
  const f = await fixture(t);
  const referenced = f.image();
  const historical = f.image();
  work(f.store, {
    id: 'open_work',
    checkpoint: {
      summary: '',
      completed: '',
      nextStep: '',
      references: [referenced.id],
      doneWhen: '',
      uncertainActions: [],
    },
  });
  task(f.store, { id: 'source_task', status: 'completed', workId: 'open_work' });
  const session = join(
    f.directory,
    'sessions',
    diskKey('bot_aster'),
    diskKey('room_lounge'),
    'history.jsonl',
  );
  mkdirSync(join(session, '..'), { recursive: true });
  writeFileSync(
    session,
    JSON.stringify({
      type: 'message',
      message: {
        content: [
          {
            type: 'image',
            data: `loom-image:v1:sha256:${historical.hash}:${historical.data.length}`,
          },
        ],
      },
    }) + '\n',
  );
  assert.equal((await f.storage.cleanup([referenced.id, historical.id])).deletedImages, 0);
  f.store.patch<WorkItem>('workItems', 'open_work', { status: 'completed' });
  const result = await f.storage.cleanup([referenced.id, historical.id]);
  assert.equal(result.deletedImages, 2);
});

test('live read leases and unflushed session references prevent removal without extending retention', async (t) => {
  const f = await fixture(t);
  const first = f.image();
  const release = retainManagedImage(f.directory, { imageId: first.id, hash: first.hash });
  const before = f.store.get<ImageRetentionState>('imageRetention', first.id)!.lastUsedAt;
  assert.equal((await f.storage.cleanup([first.id])).deletedImages, 0);
  release();
  const session = createSessionImageStore(f.directory, { retainReferences: true });
  session.externalizeMessageImages({
    content: [
      {
        type: 'image',
        data: `loom-image:v1:sha256:${first.hash}:${first.data.length}`,
        mimeType: 'image/png',
      },
    ],
  });
  assert.equal((await f.storage.cleanup([first.id])).deletedImages, 0);
  assert.equal(f.store.get<ImageRetentionState>('imageRetention', first.id)!.lastUsedAt, before);
  session.release();
  assert.equal((await f.storage.cleanup([first.id])).deletedImages, 1);
});

test('fresh explicit use or protection after preview prevents cleanup and does not reset creation time', async (t) => {
  const f = await fixture(t);
  const first = f.image();
  const second = f.image();
  assert.equal((await f.storage.list({ filter: 'candidates' })).total, 2);
  f.storage.touch(first.id, 'open');
  f.storage.setProtected(second.id, true);
  const result = await f.storage.cleanup([first.id, second.id]);
  assert.equal(result.deletedImages, 0);
  assert.equal(f.store.get<ImageRetentionState>('imageRetention', first.id)!.lastUsedAt, at(0));
  assert.equal(f.store.get<GeneratedImage>('images', first.id)!.createdAt, at(-100));
});

test('unexpectedly missing or altered originals are excluded without creating an intentional-deletion marker', async (t) => {
  const f = await fixture(t);
  const missing = f.image();
  const changed = f.image();
  unlinkSync(missing.filename);
  writeFileSync(changed.filename, png(250));
  const result = await f.storage.cleanup([missing.id, changed.id]);
  assert.equal(result.deletedImages, 0);
  assert.equal(isImageAssetDeleted(f.directory, missing.hash), false);
  assert.equal(isImageAssetDeleted(f.directory, changed.hash), false);
  assert.equal(
    f.store.get<ImageRetentionState>('imageRetention', missing.id)!.deletedAt,
    undefined,
  );
});

test('saved avatars and surviving edits keep their source originals available', async (t) => {
  const f = await fixture(t);
  const avatar = f.image();
  const source = f.image();
  const edit = f.image({ retention: { protected: true } });
  f.store.patch('bots', 'bot_aster', { avatar: `image:${avatar.id}` });
  f.store.patch<GeneratedImage>('images', edit.id, {
    inputImages: [{ imageId: source.id, role: 'source', sha256: source.hash }],
  });
  const result = await f.storage.cleanup([avatar.id, source.id]);
  assert.equal(result.deletedImages, 0);
  assert.ok(
    result.skipped.some((entry) => entry.id === source.id && entry.reason === 'dependency'),
  );
});

test('consolidation keeps identical pixels, counts hard links once, and never records image use', async (t) => {
  const f = await fixture(t);
  const bytes = png(201);
  const first = f.image({ bytes });
  const second = f.image({ bytes });
  const before = await f.storage.list();
  const beforeUse = f.store.get<ImageRetentionState>('imageRetention', first.id)!.lastUsedAt;
  const result = await f.storage.deduplicate();
  assert.equal(result.consolidatedImages, 2);
  assert.equal(result.freedBytes, bytes.length * 2);
  assert.equal(lstatSync(first.filename).ino, lstatSync(first.asset).ino);
  assert.equal(lstatSync(second.filename).ino, lstatSync(first.asset).ino);
  assert.deepEqual(readFileSync(first.filename), bytes);
  const after = await f.storage.list();
  assert.equal(before.usage.totalBytes, bytes.length * 3);
  assert.equal(before.usage.duplicateBytes, bytes.length * 2);
  assert.equal(after.usage.totalBytes, bytes.length);
  assert.equal(after.usage.duplicateBytes, 0);
  assert.equal(f.store.get<ImageRetentionState>('imageRetention', first.id)!.lastUsedAt, beforeUse);
});

test('automatic cleanup is opt-in and waits while app maintenance is paused', async (t) => {
  const f = await fixture(t);
  const old = f.image();
  await f.storage.initialize();
  f.storage.start();
  await delay(45);
  assert.equal(existsSync(old.filename), true);
  f.storage.updateSettings({ autoCleanup: true });
  f.pause(true);
  await delay(45);
  assert.equal(existsSync(old.filename), true);
  f.pause(false);
  for (let attempt = 0; attempt < 30 && existsSync(old.filename); attempt++) await delay(20);
  assert.equal(existsSync(old.filename), false);
});

test('externally held hard links do not count as freed physical bytes', async (t) => {
  const f = await fixture(t);
  const old = f.image({ asset: false });
  const copy = join(f.directory, 'owner-kept-copy.png');
  linkSync(old.filename, copy);
  const result = await f.storage.cleanup([old.id]);
  assert.equal(result.deletedImages, 1);
  assert.equal(result.freedBytes, 0);
  assert.deepEqual(readFileSync(copy), old.data);
});

test('missing historical assets remain real missing-data errors rather than becoming intentional expiry', async (t) => {
  const f = await fixture(t);
  const old = f.image({ asset: false });
  const directory = join(f.directory, 'sessions', 'old_bot', 'old_room');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'history.jsonl'),
    JSON.stringify({
      type: 'message',
      message: {
        content: [{ type: 'image', data: `loom-image:v1:sha256:${old.hash}:${old.data.length}` }],
      },
    }) + '\n',
  );
  const result = await f.storage.cleanup([old.id]);
  assert.equal(result.deletedImages, 0);
  assert.equal(result.skipped[0].reason, 'missing');
  assert.equal(isImageAssetDeleted(f.directory, old.hash), false);
  assert.equal(existsSync(old.filename), true);
});

test('metadata adoption runs during maintenance without scanning pixels and refreshes attachment projections', async (t) => {
  const f = await fixture(t);
  const uploaded = f.image({ retention: false, source: 'uploaded' });
  unlinkSync(uploaded.filename);
  f.pause(true);
  await f.storage.initialize();
  const message = f.store.get<Message>('messages', 'message_1')!;
  assert.equal(message.attachments![0].storage!.protected, true);
  assert.equal(message.attachments![0].storage!.initializedAt, at(0));
  assert.throws(() => f.storage.list(), /paused/);
});

test('restart finishes a previously committed deletion even while new automatic expiry is disabled', async (t) => {
  const f = await fixture(t);
  const retired = f.image({ retention: { deletedAt: at(-1) } });
  const live = f.image();
  await f.storage.initialize();
  assert.equal(f.storage.getSettings().autoCleanup, false);
  assert.equal(existsSync(retired.filename), true, 'metadata startup does not delete image bytes');
  f.storage.start();
  for (let attempt = 0; attempt < 30 && existsSync(retired.filename); attempt++) await delay(20);
  assert.equal(existsSync(retired.filename), false);
  assert.equal(existsSync(retired.asset), false);
  assert.equal(isImageAssetDeleted(f.directory, retired.hash), true);
  assert.equal(existsSync(live.filename), true, 'unreviewed old images remain intact');
});

test('partial expiry of hard-linked aliases frees no pixels until the final eligible alias is removed', async (t) => {
  const f = await fixture(t);
  const bytes = png(234);
  const first = f.image({ bytes });
  const second = f.image({ bytes });
  unlinkSync(first.filename);
  unlinkSync(second.filename);
  linkSync(first.asset, first.filename);
  linkSync(first.asset, second.filename);
  const partial = await f.storage.cleanup([first.id]);
  assert.equal(partial.deletedImages, 1);
  assert.equal(partial.freedBytes, 0);
  assert.equal(isImageAssetDeleted(f.directory, first.hash), false);
  const final = await f.storage.cleanup([second.id]);
  assert.equal(final.deletedImages, 1);
  assert.equal(final.freedBytes, bytes.length);
  assert.equal(isImageAssetDeleted(f.directory, second.hash), true);
});

test('a reader admitted during cleanup integrity checks prevents the final unlink', async (t) => {
  const f = await fixture(t);
  const image = f.image();
  await f.storage.list();
  const entered = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  const originalOpen = fs.open;
  let intercept = true;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (intercept && args[0] === image.asset) {
      intercept = false;
      entered.resolve();
      await releaseRead.promise;
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  let releaseLease = () => {};
  try {
    const cleaning = f.storage.cleanup([image.id]);
    await entered.promise;
    releaseLease = retainManagedImage(f.directory, { imageId: image.id, hash: image.hash });
    releaseRead.resolve();
    const result = await cleaning;
    assert.equal(result.deletedImages, 0);
    assert.equal(result.skipped[0].reason, 'in_use');
    assert.equal(existsSync(image.filename), true);
    assert.equal(isImageAssetDeleted(f.directory, image.hash), false);
  } finally {
    releaseRead.resolve();
    releaseLease();
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('recording a content hash after an asynchronous scan does not overwrite concurrent explicit use', async (t) => {
  const f = await fixture(t);
  const image = f.image({ retention: { contentHash: undefined } });
  const entered = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  const originalOpen = fs.open;
  let intercept = true;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (intercept && args[0] === image.filename) {
      intercept = false;
      entered.resolve();
      await releaseRead.promise;
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    const listing = f.storage.list();
    await entered.promise;
    f.storage.touch(image.id, 'download');
    releaseRead.resolve();
    await listing;
    const state = f.store.get<ImageRetentionState>('imageRetention', image.id)!;
    assert.equal(state.contentHash, image.hash);
    assert.equal(state.lastUsedAt, at(0));
    assert.equal((await f.storage.cleanup([image.id])).deletedImages, 0);
  } finally {
    releaseRead.resolve();
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('startup projection skips fenced room messages so a failed room deletion remains recoverable', async (t) => {
  const f = await fixture(t);
  const image = f.image({ retention: false });
  f.store.patch<Room>('rooms', 'room_lounge', {
    deletion: { status: 'failed', startedAt: at(-1), error: 'retry cleanup' },
  });
  f.store.fenceRoomDeletion('room_lounge', [{ kind: 'messages', id: 'message_1' }]);
  await f.storage.initialize();
  assert.ok(imageWithStorage(f.store, image.record).storage);
  assert.equal(f.store.get<Message>('messages', 'message_1')!.attachments![0].storage, undefined);
});

test('manual cleanup removes edit results before imageId and hash-only source dependencies', async (t) => {
  const f = await fixture(t);
  const byId = f.image();
  const byHash = f.image();
  const result = f.image();
  f.store.patch<GeneratedImage>('images', result.id, {
    inputImages: [
      { imageId: byId.id, role: 'source', sha256: hash('legacy-receipt-hash') },
      { path: 'source.png', role: 'reference', sha256: byHash.hash },
    ],
  });
  const cleaned = await f.storage.cleanup([byId.id, byHash.id, result.id]);
  assert.equal(cleaned.deletedImages, 3);
  assert.deepEqual(cleaned.skipped, []);
  assert.equal(existsSync(byId.filename), false);
  assert.equal(existsSync(byHash.filename), false);
  assert.equal(existsSync(result.filename), false);
});

test('automatic batches start with edit results when 200 old source images precede them', async (t) => {
  const f = await fixture(t, { cleanupIntervalMs: 60_000 });
  const sources = Array.from({ length: 200 }, () => f.image());
  const results = Array.from({ length: 20 }, (_, resultIndex) => {
    const image = f.image();
    f.store.patch<GeneratedImage>('images', image.id, {
      inputImages: sources
        .slice(resultIndex * 10, resultIndex * 10 + 10)
        .map((source, index) =>
          index % 2 === 0
            ? {
                imageId: source.id,
                role: index === 0 ? 'source' : 'reference',
                sha256: hash(`legacy-receipt-${source.id}`),
              }
            : { path: `source-${index}.png`, role: 'reference', sha256: source.hash },
        ),
    });
    return image;
  });
  // Reproduce the batch starvation order independently of same-millisecond DB inserts.
  const reorder = f.store.db.prepare(
    "UPDATE objects SET created_at=? WHERE kind='images' AND id=?",
  );
  for (const image of sources) reorder.run(at(-100), image.id);
  for (const image of results) reorder.run(at(-90), image.id);
  const before = f.store.list<GeneratedImage>('images');
  assert.deepEqual(
    new Set(before.slice(0, 200).map((image) => image.id)),
    new Set(sources.map((image) => image.id)),
  );
  f.storage.updateSettings({ autoCleanup: true });
  f.storage.start();
  // This read queues behind precisely the first automatic cleanup run.
  const after = await f.storage.list();
  assert.ok(
    results.every((image) => !existsSync(image.filename)),
    'result images must retire before their source dependencies',
  );
  assert.equal(sources.filter((image) => existsSync(image.filename)).length, 20);
  assert.equal(after.lastCleanup!.deletedImages, 200);
  assert.equal(after.usage.candidateCount, 20);
});

test('cyclic edit receipts remain protected by final dependency checks', async (t) => {
  const f = await fixture(t);
  const first = f.image();
  const second = f.image();
  f.store.patch<GeneratedImage>('images', first.id, {
    inputImages: [{ imageId: second.id, role: 'source', sha256: second.hash }],
  });
  f.store.patch<GeneratedImage>('images', second.id, {
    inputImages: [{ imageId: first.id, role: 'source', sha256: first.hash }],
  });
  const result = await f.storage.cleanup([first.id, second.id]);
  assert.equal(result.deletedImages, 0);
  assert.equal(existsSync(first.filename), true);
  assert.equal(existsSync(second.filename), true);
});
