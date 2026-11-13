import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import { validateChatImages } from '../src/server/chat-images.js';
import type { ChatImageUpload } from '../src/shared/image-inputs.js';
import type { Message } from '../src/shared/types.js';

const MIB = 1024 * 1024;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQcPj/HwAEQgJfMvKOtQAAAABJRU5ErkJggg==',
  'base64',
);

/** A valid tiny raster with a large ancillary chunk and exactly the requested byte length. */
function imageUpload(byteLength: number): ChatImageUpload {
  const comment = Buffer.alloc(byteLength - png.length - 12, 0x78);
  comment.write('Comment\0');
  const tag = Buffer.from('tEXt');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(comment.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(comment, crc32(tag)));
  const image = Buffer.concat([png.subarray(0, -12), length, tag, comment, crc, png.subarray(-12)]);
  assert.equal(image.length, byteLength);
  return { filename: 'capacity.png', mimeType: 'image/png', data: image.toString('base64') };
}

type UploadRoute = 'chat' | 'notification' | 'task';

async function fixture(t: TestContext, route: UploadRoute = 'chat') {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-image-upload-limits-'));
  const f = await createApp({
    dataDir,
    scheduler: false,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  t.after(async () => {
    await f.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    demoMode: false,
    autoLearn: false,
    model: {
      ...f.store.settings().model,
      baseUrl: 'http://127.0.0.1:1/v1',
      modelId: 'fixture-image-model',
      imageInput: true,
    },
  });
  let url = '/api/rooms/room_lounge/messages';
  if (route !== 'chat') {
    const task = f.controller.enqueueTask({
      roomId: 'room_lounge',
      botId: 'bot_aster',
      prompt: 'Controlled upload test',
    });
    if (route === 'task') url = `/api/tasks/${task.id}/inputs`;
    else {
      f.controller.updateTask(task.id, { status: 'completed', output: 'Question sent.' });
      const message = f.controller.addMessage({
        roomId: task.roomId,
        authorType: 'bot',
        authorId: task.botId,
        body: 'Please attach a reference.',
        taskId: task.id,
        targetUser: true,
        status: 'complete',
      });
      const notification = f.controller.notify({
        title: 'Reference needed',
        body: message.body,
        roomId: task.roomId,
        taskId: task.id,
        senderBotId: task.botId,
        messageId: message.id,
      });
      url = `/api/notifications/${notification.id}/reply`;
    }
  }
  return {
    ...f,
    dataDir,
    setLimits(maxImageMiB: number, maxTotalMiB: number) {
      const settings = f.store.settings();
      f.store.put('settings', {
        ...settings,
        id: 'main',
        images: { ...settings.images!, maxImageMiB, maxTotalMiB },
      });
    },
    post(images: ChatImageUpload[], requestId = randomUUID()) {
      return f.app.inject({
        method: 'POST',
        url,
        headers: { host: 'localhost' },
        payload: { body: 'Read these images', images, ...(route === 'chat' ? {} : { requestId }) },
      });
    },
    files: () => readdir(join(dataDir, 'generated-images')).catch(() => []),
  };
}

test('upgraded defaults admit an image above 20 MiB and lowering the limit preserves its download', async (t) => {
  const f = await fixture(t);
  const upload = imageUpload(21 * MIB);
  const response = await f.post([upload]);
  assert.equal(response.statusCode, 200, response.body);
  const image = response.json<{ message: Message }>().message.attachments![0];
  assert.equal(image.byteLength, 21 * MIB);
  f.setLimits(1, 1);
  const download = await f.app.inject({
    method: 'GET',
    url: `/api/images/${image.id}?download=1`,
    headers: { host: 'localhost' },
  });
  assert.equal(download.statusCode, 200);
  assert.equal(download.rawPayload.length, 21 * MIB);
  assert.equal(download.rawPayload.toString('base64'), upload.data);
  const rejected = await f.post([upload]);
  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.json().error, /1 MiB per-image limit/);
  assert.equal((await f.files()).length, 1);
});

for (const route of ['chat', 'notification', 'task'] as const) {
  test(`${route} uploads apply changed per-image and total settings without restart`, async (t) => {
    const f = await fixture(t, route);
    f.setLimits(1, 2);
    const tooLarge = imageUpload(MIB + 1);
    const rejected = await f.post([tooLarge]);
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.match(rejected.json().error, /1 MiB per-image limit/);
    assert.deepEqual(await f.files(), []);

    const exact = await f.post([imageUpload(MIB)]);
    assert.equal(exact.statusCode, 200, exact.body);
    f.setLimits(2, 2);
    const requestId = randomUUID();
    const accepted = await f.post([tooLarge], requestId);
    assert.equal(accepted.statusCode, 200, accepted.body);

    f.setLimits(1, 1);
    const exactTotal = await f.post([imageUpload(MIB / 2), imageUpload(MIB / 2)]);
    assert.equal(exactTotal.statusCode, 200, exactTotal.body);
    const filesBefore = await f.files();
    const totalRejected = await f.post([imageUpload(MIB / 2), imageUpload(MIB / 2 + 1)]);
    assert.equal(totalRejected.statusCode, 400, totalRejected.body);
    assert.match(totalRejected.json().error, /1 MiB total message limit/);
    assert.deepEqual(await f.files(), filesBefore);

    if (route !== 'chat') {
      const retry = await f.post([tooLarge], requestId);
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(
        retry.json().duplicate,
        true,
        'accepted receipts survive a later limit reduction',
      );
    }
  });

  test(`${route} uploads recheck reduced limits after file I/O and clean rejected files`, async (t) => {
    const f = await fixture(t, route);
    f.setLimits(2, 2);
    const original = f.controller.validateTarget.bind(f.controller);
    let changed = false;
    t.mock.method(f.controller, 'validateTarget', (roomId: string, botId: string) => {
      const result = original(roomId, botId);
      if (!changed) {
        changed = true;
        queueMicrotask(() => f.setLimits(1, 1));
      }
      return result;
    });
    const messagesBefore = f.store.list('messages').length;
    const response = await f.post([imageUpload(MIB + 1)]);
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().error, /1 MiB per-image limit/);
    assert.equal(f.store.list('messages').length, messagesBefore);
    assert.equal(f.store.list('images').length, 0);
    assert.deepEqual(await f.files(), []);
  });
}

test('oversized combined inputs are rejected before allocating decoded buffers', (t) => {
  const uploads = [imageUpload(MIB / 2), imageUpload(MIB / 2 + 1)];
  const original = Buffer.from;
  let decoded = 0;
  t.mock.method(Buffer, 'from', (...args: Parameters<typeof Buffer.from>) => {
    if (args[1] === 'base64') decoded++;
    return Reflect.apply(original, Buffer, args);
  });
  assert.throws(
    () => validateChatImages(uploads, { maxImageMiB: 1, maxTotalMiB: 1 }),
    /1 MiB total message limit/,
  );
  assert.equal(decoded, 0);
});
