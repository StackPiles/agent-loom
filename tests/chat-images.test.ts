import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import { readGeneratedImage } from '../src/server/runtime/images.js';
import { chatImageInput } from '../src/server/runtime/chat-image-input.js';
import {
  ImageInputBudget,
  IMAGE_INPUT_TASK_MAX_BYTES,
} from '../src/server/runtime/image-budget.js';
import { createTools } from '../src/server/runtime/tools.js';
import type { ToolContext } from '../src/server/runtime/contract.js';
import type { Message, Room, Task } from '../src/shared/types.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQcPj/HwAEQgJfMvKOtQAAAABJRU5ErkJggg==',
  'base64',
);
const upload = { filename: '画面.png', mimeType: 'image/png', data: png.toString('base64') };

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-chat-images-'));
  const started: string[] = [];
  const f = await createApp({
    dataDir,
    scheduler: false,
    runtimeFactory: () => ({
      start(task) {
        started.push(task.id);
      },
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
    model: {
      ...f.store.settings().model,
      baseUrl: 'http://127.0.0.1:1/v1',
      modelId: 'fixture-image-input',
      imageInput: true,
    },
  });
  return {
    ...f,
    dataDir,
    started,
    post(payload: object, roomId = 'room_lounge') {
      return f.app.inject({
        method: 'POST',
        url: `/api/rooms/${roomId}/messages`,
        headers: { host: 'localhost' },
        payload,
      });
    },
    async files() {
      return readdir(join(dataDir, 'generated-images')).catch(() => []);
    },
  };
}

test('chat images save once, stay attached to the owner message, and reach every selected task by stable IDs', async (t) => {
  const f = await fixture(t);
  const response = await f.post({
    body: '@all この画像を説明して',
    images: [{ ...upload, filename: 'C:\\fakepath\\画面.png' }],
  });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json<{ message: Message; tasks: Task[] }>();
  const image = result.message.attachments![0];
  assert.equal(image.source, 'uploaded');
  assert.equal(image.filename, '画面.png');
  assert.equal(image.prompt, '');
  assert.equal(result.message.authorType, 'user');
  assert.equal(result.tasks.length, 2);
  for (const task of result.tasks) assert.deepEqual(task.inputImageIds, [image.id]);
  assert.equal((await f.files()).length, 1);
  assert.deepEqual(await readGeneratedImage(f.dataDir, image), png);
  assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes(upload.data));
  const display = await f.app.inject({
    method: 'GET',
    url: `/api/images/${image.id}`,
    headers: { host: 'localhost' },
  });
  assert.equal(display.statusCode, 200);
  assert.equal(display.headers['content-type'], 'image/png');
  assert.deepEqual(display.rawPayload, png);
  assert.match(
    String(display.headers['content-disposition']),
    /filename\*=UTF-8''%E7%94%BB%E9%9D%A2\.png/,
  );
  assert.equal(f.store.list('operations').length, 0, 'attaching is not an image-model request');
});

test('an image-only message gets an inspection prompt; an empty message is rejected', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post({ body: '  ' })).statusCode, 400);
  const response = await f.post({ body: '', images: [upload] });
  assert.equal(response.statusCode, 200, response.body);
  const { message, tasks } = response.json<{ message: Message; tasks: Task[] }>();
  assert.equal(message.body, '');
  assert.match(tasks[0].prompt, /examine the attached images/);
  assert.deepEqual(tasks[0].inputImageIds, [message.attachments![0].id]);
});

test('chat uploads use a dedicated body limit while other API routes retain their small limit', async (t) => {
  const f = await fixture(t);
  const comment = Buffer.from('Comment\0' + 'x'.repeat(600_000));
  const tag = Buffer.from('tEXt');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(comment.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, comment])));
  const image = Buffer.concat([png.subarray(0, -12), length, tag, comment, crc, png.subarray(-12)]);
  const response = await f.post({
    body: 'Read this larger attachment',
    images: [{ ...upload, data: image.toString('base64') }],
  });
  assert.equal(response.statusCode, 200, response.body);
  const saved = response.json<{ message: Message }>().message.attachments![0];
  assert.deepEqual(await readGeneratedImage(f.dataDir, saved), image);
  const unrelated = await f.app.inject({
    method: 'POST',
    url: '/api/bots',
    headers: { host: 'localhost' },
    payload: { name: 'x'.repeat(600_000) },
  });
  assert.equal(unrelated.statusCode, 413);
});

test('initial owner pixels and later view_image calls consume the same per-execution budget', async (t) => {
  const f = await fixture(t);
  const response = await f.post({ body: 'Read', images: [upload] });
  const { tasks, message } = response.json<{ tasks: Task[]; message: Message }>();
  const budget = new ImageInputBudget();
  assert.equal(budget.tryReserve(IMAGE_INPUT_TASK_MAX_BYTES - png.length), true);
  const context: ToolContext = {
    host: f.controller,
    task: tasks[0],
    settings: f.store.settings(),
    signal: new AbortController().signal,
    operationKeys: new Set(),
    imageInputBudget: budget,
  };
  const input = await chatImageInput(context, []);
  assert.equal(input.images?.length, 1);
  assert.equal(budget.remainingBytes, 0);
  await assert.rejects(
    createTools(context).invoke('view_image', { imageId: message.attachments![0].id }),
    /80 MiB image-input budget/,
  );
});

test('disabled vision, invalid bytes and spoofed image metadata never leave partial uploads or tasks', async (t) => {
  const f = await fixture(t);
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    model: { ...f.store.settings().model, imageInput: false },
  });
  const disabled = await f.post({ body: 'Read it', images: [upload] });
  assert.equal(disabled.statusCode, 400);
  assert.match(disabled.json().error, /Enable image input/);
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    model: { ...f.store.settings().model, imageInput: true },
  });
  for (const images of [
    [upload, { ...upload, data: 'data:image/png;base64,' + upload.data }],
    [upload, { ...upload, data: 'AAAA' }],
    [{ ...upload, mimeType: 'image/jpeg' }],
    [{ ...upload, data: upload.data.replace(/=$/, 'A') }],
    [{ ...upload, id: `img_${'a'.repeat(64)}` }],
    Array.from({ length: 11 }, () => upload),
  ]) {
    const response = await f.post({ body: 'Read it', images });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(f.store.list('messages').length, 0);
    assert.equal(f.store.list('tasks').length, 0);
    assert.deepEqual(await f.files(), []);
  }
});

test('a failed multi-bot admission rolls back the complete message and removes newly saved image files', async (t) => {
  const f = await fixture(t);
  const original = f.controller.enqueueTask;
  let admitted = 0;
  t.mock.method(f.controller, 'enqueueTask', (input) => {
    if (++admitted === 2) throw new Error('Synthetic second recipient failure.');
    return original(input);
  });
  const response = await f.post({ body: '@all Read this image.', images: [upload] });
  assert.equal(response.statusCode, 500);
  assert.equal(f.store.list('messages').length, 0);
  assert.equal(f.store.list('tasks').length, 0);
  assert.equal(f.store.list('images').length, 0);
  assert.deepEqual(await f.files(), []);
  assert.deepEqual(f.started, [], 'rolled-back queued tasks cannot start in their microtask');
});

test('task image references cannot cross room boundaries', async (t) => {
  const f = await fixture(t);
  const response = await f.post({ body: 'Read', images: [upload] });
  const imageId = response.json<{ message: Message }>().message.attachments![0].id;
  f.store.put('rooms', {
    ...f.store.get<Room>('rooms', 'room_lounge')!,
    id: 'room_other',
    name: 'Other room',
  });
  assert.throws(
    () =>
      f.controller.enqueueTask({
        roomId: 'room_other',
        botId: 'bot_aster',
        prompt: 'Read',
        inputImageIds: [imageId],
      }),
    /attachments from this room/,
  );
  assert.throws(
    () =>
      f.controller.enqueueTask({
        roomId: 'room_lounge',
        botId: 'bot_aster',
        prompt: 'Read',
        inputImageIds: [imageId, imageId],
      }),
    /attachments from this room/,
  );
});
