import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { crc32 } from 'node:zlib';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import { id, now } from '../src/server/store.js';
import type { OperationRecord, RuntimeHost } from '../src/server/runtime/contract.js';
import { readGeneratedImage } from '../src/server/runtime/images.js';
import type { ChatImageUpload } from '../src/shared/image-inputs.js';
import {
  isNotificationReplyContext,
  isNotificationSender,
  resolveNotification,
} from '../src/shared/notifications.js';
import type {
  Bot,
  Message,
  Notification,
  NotificationReplyContext,
  NotificationReplyResult,
  Room,
  Task,
} from '../src/shared/types.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQcPj/HwAEQgJfMvKOtQAAAABJRU5ErkJggg==',
  'base64',
);
const upload: ChatImageUpload = {
  filename: '返信.png',
  mimeType: 'image/png',
  data: png.toString('base64'),
};

function pngWithComment(comment: string): Buffer {
  const data = Buffer.from('Comment\0' + comment);
  const tag = Buffer.from('tEXt');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([png.subarray(0, -12), length, tag, data, crc, png.subarray(-12)]);
}

async function fixture(
  t: TestContext,
  options: { apiToken?: string; onStart?: (task: Task, host: RuntimeHost) => void } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-notifications-api-'));
  const starts: Task[] = [];
  const open = () =>
    createApp({
      dataDir,
      apiToken: options.apiToken,
      scheduler: false,
      runtimeFactory: (host) => ({
        start(task) {
          starts.push(task);
          options.onStart?.(task, host);
        },
        async stop() {},
        async shutdown() {},
        queueState: () => ({ active: 0, waiting: 0 }),
      }),
    });
  let context = await open();
  context.store.put('settings', {
    ...context.store.settings(),
    id: 'main',
    demoMode: true,
    autoLearn: false,
  });
  t.after(async () => {
    await context.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    context.app.inject({
      method,
      url,
      payload: payload as object,
      headers: { host: 'localhost', ...headers },
    });
  const notice = (
    input: { botId?: string; title?: string; body?: string; direct?: boolean } = {},
  ) => {
    const botId = input.botId ?? 'bot_aster';
    const task = context.controller.enqueueTask({
      roomId: 'room_lounge',
      botId,
      prompt: 'Prepare a controlled notification.',
    });
    context.controller.updateTask(task.id, { status: 'completed', output: 'Source complete.' });
    const body = input.body ?? 'Which of these two approaches should I use?';
    const message =
      input.direct === false
        ? undefined
        : context.controller.addMessage({
            roomId: task.roomId,
            authorType: 'bot',
            authorId: botId,
            body,
            taskId: task.id,
            targetUser: true,
            status: 'complete',
          });
    const notification = context.controller.notify({
      title: input.title ?? 'A question for you',
      body: body.slice(0, 4_000),
      roomId: task.roomId,
      taskId: task.id,
      senderBotId: botId,
      ...(message ? { messageId: message.id } : {}),
    });
    return { notification, task, message };
  };
  return {
    call,
    notice,
    starts,
    dataDir,
    get app() {
      return context.app;
    },
    get store() {
      return context.store;
    },
    get controller() {
      return context.controller;
    },
    async restart() {
      await context.app.close();
      context = await open();
    },
    enableImages() {
      const settings = context.store.settings();
      context.store.put('settings', {
        ...settings,
        id: 'main',
        demoMode: false,
        model: {
          ...settings.model,
          baseUrl: 'http://127.0.0.1:1/v1',
          modelId: 'fixture-image-input',
          imageInput: true,
        },
      });
    },
    async files() {
      return readdir(join(dataDir, 'generated-images')).catch(() => []);
    },
    reply(
      notificationId: string,
      body = 'Use the second approach.',
      requestId = randomUUID(),
      images?: ChatImageUpload[],
    ) {
      return call('POST', `/api/notifications/${notificationId}/reply`, {
        body,
        requestId,
        ...(images ? { images } : {}),
      });
    },
  };
}

function rows(f: Awaited<ReturnType<typeof fixture>>) {
  return Object.fromEntries(
    ['tasks', 'messages', 'notifications', 'operations', 'rooms', 'images'].map((kind) => [
      kind,
      f.store.list(kind),
    ]),
  );
}

test('notifications retain sender snapshots and deduplicate only the same sender and source', async (t) => {
  const f = await fixture(t);
  const aster = f.notice({ direct: false });
  const nova = f.notice({ botId: 'bot_nova', direct: false });
  const secondTask = f.notice({ direct: false });
  const input = {
    title: aster.notification.title,
    body: aster.notification.body,
    roomId: aster.task.roomId,
    taskId: aster.task.id,
    senderBotId: aster.task.botId,
  };
  assert.equal(f.controller.notify(input).id, aster.notification.id);
  assert.equal(
    new Set([aster.notification.id, nova.notification.id, secondTask.notification.id]).size,
    3,
  );
  const system = f.controller.notify({ ...input, senderBotId: undefined });
  assert.deepEqual(system.sender, { kind: 'system' });
  assert.notEqual(system.id, aster.notification.id);
  assert.ok(!Object.hasOwn(aster.notification, 'senderBotId'));
  assert.deepEqual(aster.notification.sender, {
    kind: 'bot',
    botId: 'bot_aster',
    name: 'Aster',
    handle: 'aster',
  });

  const messages = [1, 2].map(() =>
    f.controller.addMessage({
      roomId: aster.task.roomId,
      authorType: 'bot',
      authorId: 'bot_aster',
      body: input.body,
      taskId: aster.task.id,
      targetUser: true,
      status: 'complete',
    }),
  );
  const linked = messages.map((message) =>
    f.controller.notify({ ...input, messageId: message.id }),
  );
  assert.notEqual(linked[0].id, linked[1].id);
  assert.notEqual(linked[0].id, aster.notification.id);
  f.store.patch<Bot>('bots', 'bot_aster', { name: 'Renamed coordinator', handle: 'coordinator' });
  let resolved = resolveNotification(aster.notification, f.controller.getSnapshot());
  assert.equal(resolved.sender.kind, 'bot');
  assert.equal(resolved.sender.kind === 'bot' && resolved.sender.name, 'Aster');
  assert.equal(resolved.bot?.name, 'Renamed coordinator');
  assert.equal(resolved.canReply, true);
  const reply = await f.reply(aster.notification.id, 'Reply to the same bot after renaming.');
  assert.equal(reply.statusCode, 200, reply.body);
  const accepted = reply.json<NotificationReplyResult>();
  assert.equal(accepted.tasks[0].botId, 'bot_aster');
  assert.deepEqual(accepted.message.targetBotIds, ['bot_aster']);
  assert.equal(accepted.tasks[0].notificationReply?.senderName, 'Aster');
  assert.equal(accepted.tasks[0].notificationReply?.senderHandle, 'aster');
  f.store.remove('bots', 'bot_aster');
  resolved = resolveNotification(aster.notification, f.controller.getSnapshot());
  assert.equal(resolved.replyBlocked, 'bot_missing');
  assert.equal(resolved.sender.kind === 'bot' && resolved.sender.name, 'Aster');
});

test('notification creation rejects forged task, room and user-message provenance', async (t) => {
  const f = await fixture(t);
  const { notification, task, message } = f.notice();
  const base = {
    title: 'Another notification',
    body: 'A controlled body',
    roomId: task.roomId,
    taskId: task.id,
    senderBotId: task.botId,
    messageId: message!.id,
  };
  for (const patch of [
    { roomId: undefined },
    { taskId: undefined },
    { taskId: 'missing-task' },
    { senderBotId: 'bot_nova' },
    { roomId: 'another-room' },
    { messageId: 'missing-message' },
  ])
    assert.throws(() => f.controller.notify({ ...base, ...patch }));
  for (const patch of [
    { authorType: 'user' as const },
    { authorId: 'bot_nova' },
    { roomId: 'another-room' },
    { taskId: 'another-task' },
    { targetUser: false },
    { targetBotIds: ['bot_nova'] },
  ]) {
    f.store.put('messages', { ...message!, ...patch });
    assert.throws(() => f.controller.notify(base), /user-directed/);
  }
  assert.deepEqual(f.store.list('notifications'), [notification]);
});

test('older notifications resolve only a consistent linked task and retain unknown identities', async (t) => {
  const f = await fixture(t);
  const { notification, task } = f.notice({ direct: false });
  const legacy = f.store.patch<Notification>('notifications', notification.id, {
    sender: undefined,
  });
  const storedBefore = f.store.get('notifications', notification.id);
  const resolved = resolveNotification(legacy, f.controller.getSnapshot());
  assert.equal(resolved.senderBasis, 'task');
  assert.equal(resolved.sender.kind === 'bot' && resolved.sender.botId, task.botId);
  assert.equal(resolved.canReply, true);
  assert.deepEqual(f.store.get('notifications', notification.id), storedBefore);
  const unknown = {
    ...legacy,
    taskId: undefined,
    title: 'Message from @aster',
    body: '@nova replied.',
  };
  assert.equal(
    resolveNotification(unknown, f.controller.getSnapshot()).replyBlocked,
    'unknown_sender',
  );
  assert.equal(
    resolveNotification({ ...legacy, roomId: 'another-room' }, f.controller.getSnapshot())
      .replyBlocked,
    'source_mismatch',
  );
  f.store.remove('bots', task.botId);
  const removed = resolveNotification(legacy, f.controller.getSnapshot());
  assert.equal(removed.replyBlocked, 'bot_missing');
  assert.deepEqual(removed.sender, { kind: 'bot', botId: task.botId, name: '', handle: '' });
});

test('a direct notification reply targets only its sender and commits context before runtime admission', async (t) => {
  const requestId = randomUUID();
  const observed: Array<{
    task: Task;
    message?: Message;
    notification?: Notification;
    receipt?: OperationRecord;
  }> = [];
  const f = await fixture(t, {
    onStart(task, host) {
      const snapshot = host.getSnapshot();
      const notificationId = task.notificationReply?.notificationId;
      observed.push({
        task,
        message: snapshot.messages.find(
          (message) => message.notificationReply?.notificationId === notificationId,
        ),
        notification: snapshot.notifications.find((item) => item.id === notificationId),
        receipt: host.getOperation(`notification-reply:${notificationId}:${requestId}`),
      });
      host.updateTask(task.id, { status: 'completed', output: 'Accepted the explicit reply.' });
    },
  });
  const original = `The full original question.\n${'検証済みの背景。'.repeat(800)}\nPlease choose one.`;
  const { notification, task: sourceTask, message: sourceMessage } = f.notice({ body: original });
  f.store.patch<Room>('rooms', sourceTask.roomId, { botIds: ['bot_nova', 'bot_aster'] });
  const originalTask = f.store.get<Task>('tasks', sourceTask.id);
  const body = '@all @nova are quoted here; please use approach two.';
  const response = await f.reply(notification.id, `  ${body}\n`, requestId);
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json<NotificationReplyResult>();
  assert.equal(result.duplicate, false);
  assert.equal(result.notification.read, true);
  assert.equal(result.tasks.length, 1);
  assert.deepEqual(result.message.targetBotIds, ['bot_aster']);
  assert.equal(result.message.body, body);
  const task = f.store.get<Task>('tasks', result.tasks[0].id)!;
  assert.equal(task.prompt, body);
  assert.equal(task.botId, 'bot_aster');
  assert.equal(task.kind, 'chat');
  assert.equal(task.parentTaskId, undefined);
  assert.equal(task.rootTaskId, task.id);
  assert.equal(task.depth, 0);
  assert.equal(task.status, 'completed', 'a synchronous runtime can finish after commit');
  assert.deepEqual(task.notificationReply, result.message.notificationReply);
  assert.equal(task.notificationReply?.body, original);
  assert.ok(task.notificationReply!.body.length > notification.body.length);
  assert.equal(task.notificationReply?.messageId, sourceMessage!.id);
  assert.equal(task.notificationReply?.taskId, sourceTask.id);
  assert.equal(task.notificationReply?.title, notification.title);
  assert.deepEqual(f.store.get('tasks', sourceTask.id), originalTask);
  assert.deepEqual(f.store.get('messages', sourceMessage!.id), sourceMessage);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].message?.id, result.message.id);
  assert.equal(observed[0].notification?.read, true);
  assert.equal(observed[0].receipt?.status, 'completed');
});

test('notification-only and legacy-task replies quote the notice and preserve a paused room', async (t) => {
  const f = await fixture(t);
  const { notification, task } = f.notice({ direct: false });
  f.store.patch<Notification>('notifications', notification.id, { sender: undefined });
  f.controller.pauseRoom(task.roomId);
  const response = await f.reply(notification.id);
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json<NotificationReplyResult>();
  assert.equal(result.tasks[0].notificationReply?.body, notification.body);
  assert.equal(result.tasks[0].notificationReply?.messageId, undefined);
  assert.equal(result.tasks[0].notificationReply?.senderName, 'Aster');
  assert.equal(result.tasks[0].status, 'queued');
  assert.equal(f.store.get<Room>('rooms', task.roomId)?.paused, true);
  assert.equal(f.store.get<Task>('tasks', task.id)?.status, 'completed');
});

test('concurrent identical replies and a repeated response receipt enqueue only once', async (t) => {
  const f = await fixture(t);
  const { notification } = f.notice();
  const requestId = randomUUID();
  const body = 'The same accepted reply.';
  const responses = await Promise.all([
    f.reply(notification.id, body, requestId),
    f.reply(notification.id, body, requestId),
  ]);
  for (const response of responses) assert.equal(response.statusCode, 200, response.body);
  const results = responses.map((response) => response.json<NotificationReplyResult>());
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true]);
  assert.equal(results[0].message.id, results[1].message.id);
  assert.equal(results[0].tasks[0].id, results[1].tasks[0].id);
  const upper = (
    await f.reply(notification.id, body, requestId.toUpperCase())
  ).json<NotificationReplyResult>();
  assert.equal(upper.duplicate, true);
  assert.equal(upper.message.id, results[0].message.id);
  const before = rows(f);
  assert.equal((await f.reply(notification.id, 'A different reply.', requestId)).statusCode, 409);
  assert.deepEqual(rows(f), before);
  assert.equal(f.starts.length, 1);
  assert.equal(
    f.store.list<Message>('messages').filter((message) => message.authorType === 'user').length,
    1,
  );
});

test('notification image replies keep the original quote, sender and pixels with image-only paused work', async (t) => {
  const observed: Array<{ task: Task; message?: Message; imageCount: number }> = [];
  const f = await fixture(t, {
    onStart(task, host) {
      observed.push({
        task,
        message: host
          .getSnapshot()
          .messages.find((message) =>
            message.attachments?.some((image) => task.inputImageIds?.includes(image.id)),
          ),
        imageCount: f.store.list('images').length,
      });
    },
  });
  f.enableImages();
  const original = 'Please inspect the screenshot before choosing the next action.';
  const { notification, task: source } = f.notice({ body: original });
  const response = await f.reply(
    notification.id,
    '@all @nova are quoted; this image is for the notifying bot.',
    randomUUID(),
    [upload],
  );
  assert.equal(response.statusCode, 200, response.body);
  const accepted = response.json<NotificationReplyResult>();
  const image = accepted.message.attachments![0];
  assert.deepEqual(accepted.message.targetBotIds, [source.botId]);
  assert.equal(accepted.tasks.length, 1);
  assert.deepEqual(accepted.tasks[0].inputImageIds, [image.id]);
  assert.equal(accepted.tasks[0].notificationReply?.body, original);
  assert.deepEqual(accepted.message.notificationReply, accepted.tasks[0].notificationReply);
  assert.deepEqual(await readGeneratedImage(f.dataDir, image), png);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].message?.id, accepted.message.id);
  assert.equal(observed[0].imageCount, 1, 'runtime admission observes committed image metadata');
  assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes(upload.data));
  assert.ok(!JSON.stringify(f.store.list('operations')).includes(upload.data));

  f.controller.pauseRoom(source.roomId);
  const imageOnly = await f.reply(notification.id, '  ', randomUUID(), [upload]);
  assert.equal(imageOnly.statusCode, 200, imageOnly.body);
  const paused = imageOnly.json<NotificationReplyResult>();
  assert.equal(paused.message.body, '');
  assert.match(paused.tasks[0].prompt, /examine the attached images/);
  assert.deepEqual(paused.tasks[0].inputImageIds, [paused.message.attachments![0].id]);
  assert.equal(paused.tasks[0].notificationReply?.body, original);
  assert.equal(f.store.get<Task>('tasks', paused.tasks[0].id)?.status, 'queued');
  assert.equal(f.store.get<Room>('rooms', source.roomId)?.paused, true);
});

test('image reply retries preserve exactly one attachment and reject changed pixels or metadata after restart', async (t) => {
  const f = await fixture(t);
  f.enableImages();
  const { notification } = f.notice();
  const requestId = randomUUID();
  const body = 'Inspect this exact image.';
  const responses = await Promise.all([
    f.reply(notification.id, body, requestId, [upload]),
    f.reply(notification.id, body, requestId, [upload]),
  ]);
  for (const response of responses) assert.equal(response.statusCode, 200, response.body);
  const results = responses.map((response) => response.json<NotificationReplyResult>());
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true]);
  assert.equal(results[0].message.id, results[1].message.id);
  assert.deepEqual(results[0].message.attachments, results[1].message.attachments);
  assert.equal(f.store.list('images').length, 1);
  assert.equal((await f.files()).length, 1);
  assert.equal(f.starts.length, 1);
  const before = rows(f);
  for (const images of [
    [],
    [{ ...upload, filename: 'different.png' }],
    [{ ...upload, data: pngWithComment('changed pixels request').toString('base64') }],
    [upload, upload],
  ]) {
    const changed = await f.reply(notification.id, body, requestId, images);
    assert.equal(changed.statusCode, 409, changed.body);
    assert.deepEqual(rows(f), before);
    assert.equal((await f.files()).length, 1);
  }
  f.store.patch<Bot>('bots', 'bot_aster', { enabled: false });
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    model: { ...f.store.settings().model, imageInput: false },
  });
  await f.restart();
  const retry = await f.reply(notification.id, body, requestId.toUpperCase(), [upload]);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json<NotificationReplyResult>().duplicate, true);
  assert.equal(retry.json<NotificationReplyResult>().message.id, results[0].message.id);
  assert.equal((await f.files()).length, 1);
  assert.equal(f.starts.length, 1);
});

test('concurrent different image content with one reply ID accepts only one request and removes the other copy', async (t) => {
  const f = await fixture(t);
  f.enableImages();
  const { notification } = f.notice();
  const requestId = randomUUID();
  const images = [upload, { ...upload, data: pngWithComment('second image').toString('base64') }];
  const responses = await Promise.all(
    images.map((image) => f.reply(notification.id, 'Read this.', requestId, [image])),
  );
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
  const winner = responses.findIndex((response) => response.statusCode === 200);
  const accepted = responses[winner].json<NotificationReplyResult>();
  assert.deepEqual(
    await readGeneratedImage(f.dataDir, accepted.message.attachments![0]),
    Buffer.from(images[winner].data, 'base64'),
  );
  assert.equal(f.starts.length, 1);
  assert.equal(f.store.list('images').length, 1);
  assert.equal((await f.files()).length, 1);
});

test('text reply receipts from older versions still replay but cannot accept newly added images', async (t) => {
  const f = await fixture(t);
  f.enableImages();
  const { notification } = f.notice();
  const requestId = randomUUID();
  const response = await f.reply(notification.id, 'A saved text reply.', requestId);
  assert.equal(response.statusCode, 200, response.body);
  const key = `notification-reply:${notification.id}:${requestId}`;
  const receipt = f.store.get<OperationRecord & { id: string }>('operations', key)!;
  const { requestFingerprint: _fingerprint, ...legacyArgs } = receipt.args;
  f.store.put('operations', { ...receipt, args: legacyArgs });
  const retry = await f.reply(notification.id, 'A saved text reply.', requestId);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json<NotificationReplyResult>().duplicate, true);
  assert.equal(
    (await f.reply(notification.id, 'A saved text reply.', requestId, [upload])).statusCode,
    409,
  );
  assert.equal(f.starts.length, 1);
  assert.deepEqual(await f.files(), []);
});

test('an accepted reply is not replayed after restart or sender availability changes', async (t) => {
  const f = await fixture(t);
  const { notification } = f.notice();
  const requestId = randomUUID();
  const first = (
    await f.reply(notification.id, 'Persist this reply.', requestId)
  ).json<NotificationReplyResult>();
  assert.equal(f.starts.length, 1);
  f.store.patch<Bot>('bots', 'bot_aster', { enabled: false });
  f.store.patch<Room>('rooms', 'room_lounge', { archived: true });
  await f.restart();
  const before = rows(f);
  const response = await f.reply(notification.id, 'Persist this reply.', requestId);
  assert.equal(response.statusCode, 200, response.body);
  const replay = response.json<NotificationReplyResult>();
  assert.equal(replay.duplicate, true);
  assert.equal(replay.message.id, first.message.id);
  assert.equal(replay.tasks[0].id, first.tasks[0].id);
  assert.equal(replay.tasks[0].status, 'interrupted');
  assert.deepEqual(replay.tasks[0].notificationReply, first.tasks[0].notificationReply);
  assert.deepEqual(rows(f), before);
  assert.equal(f.starts.length, 1);
});

test('incomplete or damaged reply receipts never admit another task', async (t) => {
  const f = await fixture(t);
  const { notification } = f.notice();
  const requestId = randomUUID();
  const first = (
    await f.reply(notification.id, 'Only once.', requestId)
  ).json<NotificationReplyResult>();
  const key = `notification-reply:${notification.id}:${requestId}`;
  const receipt = f.store.get<OperationRecord & { id: string }>('operations', key)!;
  for (const patch of [
    { status: 'started' as const },
    { result: 'not JSON' },
    { result: 'null' },
  ]) {
    f.store.put('operations', { ...receipt, ...patch });
    const before = rows(f);
    assert.equal((await f.reply(notification.id, 'Only once.', requestId)).statusCode, 409);
    assert.deepEqual(rows(f), before);
  }
  f.store.put('operations', receipt);
  f.store.remove('tasks', first.tasks[0].id);
  const before = rows(f);
  assert.equal((await f.reply(notification.id, 'Only once.', requestId)).statusCode, 409);
  assert.deepEqual(rows(f), before);
  assert.equal(f.starts.length, 1);
});

const unavailableCases: Array<{
  name: string;
  change(
    f: Awaited<ReturnType<typeof fixture>>,
    source: ReturnType<Awaited<ReturnType<typeof fixture>>['notice']>,
  ): void;
}> = [
  {
    name: 'explicit system sender even with a task link',
    change(f, { notification }) {
      f.store.patch<Notification>('notifications', notification.id, { sender: { kind: 'system' } });
    },
  },
  {
    name: 'unknown legacy sender despite names and mentions in text',
    change(f, { notification }) {
      f.store.patch<Notification>('notifications', notification.id, {
        sender: undefined,
        taskId: undefined,
        title: 'Message from @aster',
        body: 'Aster and @nova are mentioned, but no sender was recorded.',
      });
    },
  },
  {
    name: 'deleted sender',
    change(f) {
      f.store.remove('bots', 'bot_aster');
    },
  },
  {
    name: 'disabled sender',
    change(f) {
      f.store.patch<Bot>('bots', 'bot_aster', { enabled: false });
    },
  },
  {
    name: 'deleted room',
    change(f) {
      f.store.remove('rooms', 'room_lounge');
    },
  },
  {
    name: 'archived room',
    change(f) {
      f.store.patch<Room>('rooms', 'room_lounge', { archived: true });
    },
  },
  {
    name: 'sender removed from the room',
    change(f) {
      f.store.patch<Room>('rooms', 'room_lounge', { botIds: ['bot_nova'] });
    },
  },
  {
    name: 'conflicting source task owner',
    change(f, { task }) {
      f.store.patch<Task>('tasks', task.id, { botId: 'bot_nova' });
    },
  },
  {
    name: 'conflicting source message room',
    change(f, { message }) {
      f.store.patch<Message>('messages', message!.id, { roomId: 'another-room' });
    },
  },
  {
    name: 'conflicting source message author',
    change(f, { message }) {
      f.store.patch<Message>('messages', message!.id, { authorId: 'bot_nova' });
    },
  },
];

for (const item of unavailableCases)
  test(`a notification reply rejects ${item.name} without changing read state or work`, async (t) => {
    const f = await fixture(t);
    const source = f.notice();
    item.change(f, source);
    const before = rows(f);
    const response = await f.reply(source.notification.id);
    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(rows(f), before);
    assert.equal(f.starts.length, 0);
    assert.equal(f.store.get<Notification>('notifications', source.notification.id)?.read, false);
  });

test('saved sender identity allows a reply when historical source records were removed', async (t) => {
  const f = await fixture(t);
  const { notification, task, message } = f.notice();
  f.store.remove('tasks', task.id);
  f.store.remove('messages', message!.id);
  const response = await f.reply(notification.id);
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json<NotificationReplyResult>();
  assert.equal(result.tasks[0].notificationReply?.body, notification.body);
  assert.equal(result.tasks[0].notificationReply?.messageId, message!.id);
  assert.equal(result.tasks[0].notificationReply?.taskId, task.id);
  assert.equal(result.tasks[0].botId, task.botId);
});

test('reply requests validate bounded text and a stable request ID and reject client-selected routing', async (t) => {
  const f = await fixture(t);
  const { notification } = f.notice();
  const requestId = randomUUID();
  const url = `/api/notifications/${notification.id}/reply`;
  const before = rows(f);
  for (const payload of [
    { body: 'Missing request ID.' },
    { body: 'Invalid request ID.', requestId: 'invalid' },
    { body: '', requestId },
    { body: ' \n ', requestId },
    { body: 'a'.repeat(32_001), requestId },
    { body: 'Choose another bot.', requestId, botIds: ['bot_nova'] },
    { body: 'Choose another room.', requestId, roomId: 'another-room' },
    { body: 'Forge the sender.', requestId, senderBotId: 'bot_nova' },
    { body: 'Forge context.', requestId, notificationReply: {} },
  ]) {
    assert.equal((await f.call('POST', url, payload)).statusCode, 400);
    assert.deepEqual(rows(f), before);
  }
  const exact = await f.reply(notification.id, 'a'.repeat(32_000), requestId);
  assert.equal(exact.statusCode, 200, exact.body);
  assert.equal(exact.json<NotificationReplyResult>().message.body.length, 32_000);
  assert.equal((await f.reply('missing-notification')).statusCode, 404);
});

test('reply admission respects model setup, maintenance, shutdown and queue capacity', async (t) => {
  const f = await fixture(t);
  const { notification, task } = f.notice();
  const settings = f.store.settings();
  f.store.put('settings', {
    ...settings,
    id: 'main',
    demoMode: false,
    model: { ...settings.model, baseUrl: '', modelId: '' },
  });
  let before = rows(f);
  assert.equal((await f.reply(notification.id)).statusCode, 409);
  assert.deepEqual(rows(f), before);
  f.store.put('settings', { ...settings, id: 'main' });
  f.controller.maintenance = true;
  assert.equal((await f.reply(notification.id)).statusCode, 503);
  assert.deepEqual(rows(f), before);
  f.controller.maintenance = false;
  f.controller.closing = true;
  assert.equal((await f.reply(notification.id)).statusCode, 503);
  assert.deepEqual(rows(f), before);
  f.controller.closing = false;
  for (let index = 0; index < 200; index++) {
    const taskId = `queued-${index}`;
    f.store.put('tasks', {
      ...task,
      id: taskId,
      rootTaskId: taskId,
      status: 'queued',
    });
  }
  before = rows(f);
  assert.equal((await f.reply(notification.id)).statusCode, 429);
  assert.deepEqual(rows(f), before);
});

test('notification images validate model support, bytes and untrusted metadata without changing the notice', async (t) => {
  const f = await fixture(t);
  const { notification } = f.notice();
  const before = rows(f);
  const disabled = await f.reply(notification.id, 'Inspect this.', randomUUID(), [upload]);
  assert.equal(disabled.statusCode, 400, disabled.body);
  assert.match(disabled.json().error, /Enable image input/);
  f.enableImages();
  for (const images of [
    [{ ...upload, data: 'AAAA' }],
    [{ ...upload, mimeType: 'image/jpeg' }],
    [{ ...upload, data: 'data:image/png;base64,' + upload.data }],
    [{ ...upload, id: `img_${'a'.repeat(64)}` }],
    Array.from({ length: 11 }, () => upload),
  ]) {
    const response = await f.call('POST', `/api/notifications/${notification.id}/reply`, {
      body: 'Read the image.',
      requestId: randomUUID(),
      images,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(rows(f), before);
    assert.deepEqual(await f.files(), []);
  }
  assert.equal(f.starts.length, 0);
});

test('notification image replies use the image body limit without increasing unrelated endpoint limits', async (t) => {
  const f = await fixture(t);
  f.enableImages();
  const { notification } = f.notice();
  const larger = pngWithComment('x'.repeat(600_000));
  const response = await f.reply(notification.id, 'Read the screenshot.', randomUUID(), [
    { ...upload, data: larger.toString('base64') },
  ]);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    await readGeneratedImage(
      f.dataDir,
      response.json<NotificationReplyResult>().message.attachments![0],
    ),
    larger,
  );
  assert.equal((await f.call('POST', '/api/bots', { name: 'x'.repeat(600_000) })).statusCode, 413);
});

const imageAdmissionRaces: Array<{
  name: string;
  status: number;
  change(
    f: Awaited<ReturnType<typeof fixture>>,
    source: ReturnType<Awaited<ReturnType<typeof fixture>>['notice']>,
  ): void;
}> = [
  {
    name: 'image input disabled',
    status: 400,
    change(f) {
      f.store.put('settings', {
        ...f.store.settings(),
        id: 'main',
        model: { ...f.store.settings().model, imageInput: false },
      });
    },
  },
  {
    name: 'sender removed',
    status: 409,
    change(f, source) {
      f.store.remove('bots', source.task.botId);
    },
  },
  {
    name: 'original quote changed',
    status: 409,
    change(f, source) {
      f.store.patch<Message>('messages', source.message!.id, { body: 'A different question.' });
    },
  },
  {
    name: 'workspace changed',
    status: 409,
    change(f, source) {
      f.store.patch<Room>('rooms', source.task.roomId, {
        workspacePath: join(f.dataDir, 'other-workspace'),
      });
    },
  },
  {
    name: 'maintenance started',
    status: 503,
    change(f) {
      f.controller.maintenance = true;
    },
  },
];

for (const race of imageAdmissionRaces)
  test(`notification attachment I/O rechecks ${race.name} and removes staged files`, async (t) => {
    const f = await fixture(t);
    f.enableImages();
    const source = f.notice();
    const validateTarget = f.controller.validateTarget.bind(f.controller);
    let checked = false;
    let afterChange: ReturnType<typeof rows> | undefined;
    t.mock.method(f.controller, 'validateTarget', (roomId: string, botId: string) => {
      const target = validateTarget(roomId, botId);
      if (!checked) {
        checked = true;
        queueMicrotask(() => {
          race.change(f, source);
          afterChange = rows(f);
        });
      }
      return target;
    });
    const response = await f.reply(source.notification.id, 'Read this image.', randomUUID(), [
      upload,
    ]);
    assert.equal(response.statusCode, race.status, response.body);
    assert.ok(afterChange, 'the changed state occurs during attachment I/O');
    assert.deepEqual(rows(f), afterChange);
    assert.deepEqual(await f.files(), []);
    assert.equal(f.starts.length, 0);
    assert.equal(f.store.get<Notification>('notifications', source.notification.id)?.read, false);
  });

test('notification replies use the existing authentication and same-origin write guards', async (t) => {
  const token = 'notification-test-owner-token';
  const f = await fixture(t, { apiToken: token });
  f.enableImages();
  const { notification } = f.notice();
  const url = `/api/notifications/${notification.id}/reply`;
  const payload = { body: 'An authenticated reply.', requestId: randomUUID(), images: [upload] };
  const before = rows(f);
  assert.equal((await f.call('POST', url, payload)).statusCode, 401);
  assert.equal(
    (
      await f.call('POST', url, payload, {
        authorization: `Bearer ${token}`,
        origin: 'https://unrelated.example',
      })
    ).statusCode,
    403,
  );
  assert.deepEqual(rows(f), before);
  assert.equal(
    (
      await f.call('POST', url, payload, {
        authorization: `Bearer ${token}`,
        origin: 'http://localhost',
      })
    ).statusCode,
    200,
  );
});

for (const failedKind of ['tasks', 'messages', 'images', 'rooms', 'notifications', 'operations'])
  test(`reply persistence rolls back a failure after writing ${failedKind} and never starts partial work`, async (t) => {
    const f = await fixture(t);
    f.enableImages();
    const { notification } = f.notice();
    await setImmediate();
    const before = rows(f);
    const original = f.store.put.bind(f.store);
    let fail = true;
    f.store.put = ((kind, value) => {
      const result = original(kind, value);
      if (fail && kind === failedKind) {
        fail = false;
        throw new Error(`Controlled failure after ${kind} persistence.`);
      }
      return result;
    }) as typeof f.store.put;
    const requestId = randomUUID();
    const response = await f.reply(notification.id, 'This must be atomic.', requestId, [upload]);
    assert.equal(response.statusCode, 500, response.body);
    await setImmediate();
    assert.deepEqual(rows(f), before);
    assert.deepEqual(await f.files(), []);
    assert.equal(f.starts.length, 0);
    f.store.put = original;
    const retried = await f.reply(notification.id, 'This must be atomic.', requestId, [upload]);
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(retried.json<NotificationReplyResult>().duplicate, false);
    assert.equal(f.starts.length, 1);
    assert.equal((await f.files()).length, 1);
  });

test('reply context guards reject malformed metadata while preserving valid original values', () => {
  const valid: NotificationReplyContext = {
    notificationId: id('notice'),
    roomId: 'room_lounge',
    botId: 'bot_aster',
    senderName: 'Aster',
    senderHandle: 'aster',
    title: 'A prior question',
    body: 'The original text is quoted as data.',
    createdAt: now(),
  };
  assert.equal(isNotificationReplyContext(valid), true);
  assert.equal(
    isNotificationReplyContext({ ...valid, messageId: 'historical', taskId: 'source' }),
    true,
  );
  for (const patch of [
    { notificationId: '' },
    { roomId: 'x'.repeat(1_025) },
    { botId: 123 },
    { senderName: ' ' },
    { senderHandle: '@aster' },
    { title: 'x'.repeat(161) },
    { body: 'x'.repeat(12_001) },
    { createdAt: 'not-a-date' },
    { messageId: null },
    { taskId: '' },
    { permissions: 'allow' },
  ])
    assert.equal(isNotificationReplyContext({ ...valid, ...patch }), false, JSON.stringify(patch));
  assert.equal(isNotificationSender({ kind: 'system' }), true);
  assert.equal(isNotificationSender({ kind: 'system', botId: 'bot_aster' }), false);
  assert.equal(
    isNotificationSender({ kind: 'bot', botId: 'bot_aster', name: 'Aster', handle: 'aster' }),
    true,
  );
  assert.equal(
    isNotificationSender({
      kind: 'bot',
      botId: 'bot_aster',
      name: 'Aster',
      handle: 'aster',
      roomId: 'forged',
    }),
    false,
  );
});
