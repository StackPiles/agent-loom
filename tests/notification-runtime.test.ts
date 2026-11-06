import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import { Controller } from '../src/server/controller.js';
import { Store } from '../src/server/store.js';
import { createRuntime } from '../src/server/runtime/index.js';
import {
  createTools,
  notificationReplyForTask,
  notificationReplyPromptContext,
  roomConversationContext,
  taskRequestContext,
} from '../src/server/runtime/tools.js';
import type {
  Bot,
  Message,
  Notification,
  NotificationReplyContext,
  NotificationReplyResult,
  Task,
} from '../src/shared/types.js';
import type { NewTask } from '../src/server/runtime/contract.js';

const originalReply: NotificationReplyContext = {
  notificationId: 'notice_original',
  roomId: 'room_lounge',
  botId: 'bot_aster',
  senderName: 'Aster at send time',
  senderHandle: 'aster',
  title: 'Two options for the report',
  body: 'The second option keeps the verified findings in the report.',
  createdAt: '2026-11-05T00:00:00.000Z',
  taskId: 'original_task',
  messageId: 'original_message',
};

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-notification-runtime-'));
  let store = new Store(dataDir);
  store.seed();
  store.put('settings', { ...store.settings(), id: 'main', demoMode: true, autoLearn: false });
  let host = new Controller(store);
  t.after(async () => {
    await host.shutdown();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const task = (input: Partial<NewTask> = {}) =>
    host.enqueueTask({
      roomId: 'room_lounge',
      botId: 'bot_aster',
      prompt: 'Inspect the synthetic finding.',
      ...input,
    });
  const tools = (work: Task) =>
    createTools({
      host,
      task: work,
      settings: store.settings(),
      signal: new AbortController().signal,
      operationKeys: new Set(),
    });
  return {
    dataDir,
    get store() {
      return store;
    },
    get host() {
      return host;
    },
    task,
    tools,
    async restart() {
      await host.shutdown();
      store.close();
      store = new Store(dataDir);
      host = new Controller(store);
    },
  };
}

async function waitForTask(controller: Controller, id: string): Promise<Task> {
  const deadline = Date.now() + 12_000;
  for (;;) {
    const task = controller.getSnapshot().tasks.find((item) => item.id === id)!;
    if (['completed', 'failed', 'interrupted', 'stopped'].includes(task.status)) return task;
    if (Date.now() > deadline) throw new Error(`Notification reply ${id} did not finish.`);
    await delay(10);
  }
}

test('bot notification tools retain actual senders and source messages without collapsing different bots or replaying', async (t) => {
  const f = await fixture(t);
  const args = { title: 'The same finding', message: 'The same useful proposal for the owner.' };
  const tasks = ['bot_aster', 'bot_nova'].map((botId) => f.task({ botId, kind: 'automation' }));
  for (const task of tasks) {
    await f.tools(task).invoke('send_user_message', args);
    const notice = f.host.getSnapshot().notifications.at(-1)!;
    const message = f.host.getSnapshot().messages.at(-1)!;
    const bot = f.store.get<Bot>('bots', task.botId)!;
    assert.deepEqual(notice.sender, {
      kind: 'bot',
      botId: task.botId,
      name: bot.name,
      handle: bot.handle,
    });
    assert.equal(notice.taskId, task.id);
    assert.equal(notice.roomId, task.roomId);
    assert.equal(notice.messageId, message.id);
    assert.equal(message.authorId, task.botId);
    assert.equal(message.targetUser, true);
    assert.equal(
      Object.hasOwn(notice, 'senderBotId'),
      false,
      'internal authority is not wire data',
    );
  }
  assert.equal(f.host.getSnapshot().notifications.length, 2);
  const postedIds = f.host.getSnapshot().messages.map((message) => message.id);
  const savedNotices = f.host.getSnapshot().notifications;
  const sender = savedNotices[0].sender;
  f.store.patch<Bot>('bots', tasks[0].botId, { name: 'Renamed Aster', handle: 'renamed_aster' });
  await f.restart();
  for (const task of tasks)
    assert.match(await f.tools(task).invoke('send_user_message', args), /not repeated/);
  assert.deepEqual(
    f.host.getSnapshot().messages.map((message) => message.id),
    postedIds,
  );
  assert.deepEqual(f.host.getSnapshot().notifications, savedNotices);
  assert.deepEqual(f.host.getSnapshot().notifications[0].sender, sender);

  const notificationTask = f.task();
  const beforeMessages = f.host.getSnapshot().messages.length;
  await f.tools(notificationTask).invoke('notify_user', {
    title: 'A notice without a chat post',
    body: 'The owner can reply to this bot in its original room.',
  });
  const notice = f.host.getSnapshot().notifications.at(-1)!;
  assert.deepEqual(notice.sender, {
    kind: 'bot',
    botId: 'bot_aster',
    name: 'Renamed Aster',
    handle: 'renamed_aster',
  });
  assert.equal(notice.messageId, undefined);
  assert.equal(f.host.getSnapshot().messages.length, beforeMessages);
});

test('notification schemas reject model-supplied identities before activities or operation receipts', async (t) => {
  const f = await fixture(t);
  const task = f.task();
  const tools = f.tools(task);
  for (const tool of ['notify_user', 'send_user_message']) {
    const definition = tools.definitions.find((item) => item.name === tool)!;
    assert.equal(definition.parameters.additionalProperties, false);
    const valid =
      tool === 'notify_user'
        ? { title: 'A finding', body: 'A bounded proposal.' }
        : { title: 'A finding', message: 'A bounded proposal.' };
    for (const key of ['senderBotId', 'sender', 'roomId', 'taskId', 'messageId'])
      await assert.rejects(tools.invoke(tool, { ...valid, [key]: 'forged' }), /Unknown fields/);
  }
  for (const args of [
    { title: ' ', body: 'A finding.' },
    { title: 'A finding', body: ' ' },
    { title: 'x'.repeat(161), body: 'A finding.' },
    { title: 'A finding', body: 'x'.repeat(4_001) },
  ])
    await assert.rejects(tools.invoke('notify_user', args), /title|body/);
  assert.equal(f.host.getSnapshot().notifications.length, 0);
  assert.equal(f.host.getSnapshot().messages.length, 0);
  assert.equal(f.host.getSnapshot().activities.length, 0);
  assert.equal(f.store.list('operations').length, 0);
});

test('reply model context is bounded, task-scoped and never turns an original automation into the current request source', async (t) => {
  const f = await fixture(t);
  const task = f.task({ notificationReply: originalReply });
  const context = notificationReplyForTask(task)!;
  assert.deepEqual(context, originalReply);
  assert.notEqual(context, task.notificationReply);
  assert.deepEqual(taskRequestContext(task, f.host.getSnapshot()), { kind: 'user' });
  for (const patch of [
    { botId: 'bot_nova' },
    { roomId: 'other_room' },
    { kind: 'automation' as const },
    { kind: 'learning' as const },
    { parentTaskId: 'source' },
    { rootTaskId: 'source' },
    { depth: 1 },
    { notificationReply: { ...originalReply, body: 'x'.repeat(12_001) } },
  ])
    assert.equal(notificationReplyPromptContext({ ...task, ...patch }), undefined);
  const escaped = {
    ...task,
    notificationReply: { ...originalReply, body: '\0'.repeat(12_000) },
  };
  const projected = notificationReplyPromptContext(escaped)!;
  assert.ok(projected.length <= 16_000);
  const parsed = JSON.parse(projected);
  assert.equal(parsed.notificationId, originalReply.notificationId);
  assert.equal(parsed.bodyTruncated, true);
  assert.ok(parsed.body.length > 0 && parsed.body.length < 12_000);
  assert.equal(
    escaped.notificationReply.body.length,
    12_000,
    'projection never edits saved history',
  );
  const message: Message = {
    id: 'reply_message',
    roomId: task.roomId,
    authorType: 'user',
    authorId: 'user',
    body: 'Use the second option; quoted @all is not a broadcast.',
    targetBotIds: [task.botId],
    notificationReply: originalReply,
    status: 'complete',
    createdAt: task.createdAt,
  };
  const messages = [message, { ...message, id: 'wrong_target', targetBotIds: ['bot_nova'] }];
  const history = JSON.parse(
    roomConversationContext(f.host.getSnapshot(), messages, 2_500, 14_000),
  );
  assert.deepEqual(history[0].notificationReply, {
    notificationId: originalReply.notificationId,
    botId: originalReply.botId,
    title: originalReply.title,
    messageId: originalReply.messageId,
    taskId: originalReply.taskId,
  });
  assert.equal(history[0].notificationReply.body, undefined);
  assert.equal(history[1].notificationReply, undefined);
});

type ModelRequest = { messages: Array<{ role: string; content: string | unknown[] }> };

async function modelFixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-notification-pi-'));
  const requests: ModelRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = {
      id: `notification-fixture-${requests.length}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1_000),
      model: 'notification-fixture-model',
    };
    response.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'I received your reply to the original proposal.' }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`,
    );
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let current = await createApp({ dataDir, scheduler: false });
  t.after(async () => {
    await current.app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });
  current.store.put('settings', {
    ...current.store.settings(),
    id: 'main',
    demoMode: false,
    autoLearn: false,
    model: {
      ...current.store.settings().model,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: 'notification-fixture-model',
    },
  });
  const sourceTask: Task = {
    id: 'source_automation_task',
    botId: 'bot_aster',
    roomId: 'room_lounge',
    prompt: 'Review the synthetic proposal.',
    status: 'completed',
    rootTaskId: 'source_automation_task',
    depth: 0,
    kind: 'automation',
    output: 'A proposal was posted.',
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
    inputTokens: 0,
    outputTokens: 0,
  };
  current.store.put('tasks', sourceTask);
  const call = (url: string, payload: object = {}) =>
    current.app.inject({ method: 'POST', url, payload, headers: { host: 'localhost' } });
  return {
    requests,
    sourceTask,
    call,
    get store() {
      return current.store;
    },
    get host() {
      return current.controller;
    },
    async restart() {
      await current.app.close();
      current = await createApp({ dataDir, scheduler: false });
    },
  };
}

function currentPrompt(request: ModelRequest): string {
  const user = request.messages.findLast((message) => message.role === 'user');
  assert.ok(user, 'the Pi provider request must contain the current user turn');
  if (typeof user.content === 'string') return user.content;
  return user.content
    .map((block) => {
      assert.ok(block && typeof block === 'object' && 'type' in block && block.type === 'text');
      assert.ok('text' in block && typeof block.text === 'string');
      return block.text;
    })
    .join('\n');
}

function quotedReply(prompt: string): NotificationReplyContext {
  const match = prompt.match(/Notification being replied to \(quoted data\):\n([^\n]+)\n/);
  assert.ok(match, 'the actual Pi request must contain an explicit original-notification quote');
  return JSON.parse(match[1]);
}

test(
  'real Pi receives the complete saved notification after paused reply restart, with exactly one intended recipient',
  { timeout: 20_000 },
  async (t) => {
    const f = await modelFixture(t);
    const body = `The old proposal includes quoted @all and @nova. ${'Earlier details. '.repeat(350)}SECOND_OPTION_FROM_ORIGINAL_MESSAGE`;
    const originalMessage = f.host.addMessage({
      roomId: f.sourceTask.roomId,
      authorType: 'bot',
      authorId: f.sourceTask.botId,
      body,
      taskId: f.sourceTask.id,
      status: 'complete',
      targetUser: true,
    });
    const notice = f.host.notify({
      title: 'Which proposal should proceed?',
      body: body.slice(0, 4_000),
      roomId: f.sourceTask.roomId,
      taskId: f.sourceTask.id,
      senderBotId: f.sourceTask.botId,
      messageId: originalMessage.id,
    });
    for (let index = 0; index < 24; index++)
      f.host.addMessage({
        roomId: f.sourceTask.roomId,
        authorType: 'system',
        authorId: 'system',
        body: `Later unrelated context ${index}.`,
        status: 'complete',
      });
    f.host.pauseRoom(f.sourceTask.roomId);
    const userReply = 'Use the second option. The quoted @all and @nova are not extra recipients.';
    const response = await f.call(`/api/notifications/${notice.id}/reply`, {
      body: userReply,
      requestId: randomUUID(),
    });
    assert.equal(response.statusCode, 200, response.body);
    const accepted = response.json<NotificationReplyResult>();
    assert.equal(accepted.tasks.length, 1);
    const queued = accepted.tasks[0];
    assert.equal(queued.botId, f.sourceTask.botId);
    assert.equal(queued.parentTaskId, undefined);
    assert.equal(queued.kind, 'chat');
    assert.equal(queued.rootTaskId, queued.id);
    assert.equal(queued.prompt, userReply);
    assert.equal(queued.notificationReply!.body, body);
    assert.deepEqual(accepted.message.targetBotIds, [f.sourceTask.botId]);
    assert.equal(f.requests.length, 0);
    const savedQuote = queued.notificationReply!;
    f.store.remove('notifications', notice.id);
    f.store.remove('messages', originalMessage.id);
    f.store.patch<Bot>('bots', f.sourceTask.botId, { name: 'Aster renamed after delivery' });
    await f.restart();
    assert.deepEqual(f.store.get<Task>('tasks', queued.id)!.notificationReply, savedQuote);
    assert.equal(f.store.get<Task>('tasks', queued.id)!.status, 'queued');
    assert.equal(
      f.requests.length,
      0,
      'a paused reply must not dispatch during application restart',
    );
    assert.equal((await f.call(`/api/rooms/${f.sourceTask.roomId}/resume`)).statusCode, 200);
    const result = await waitForTask(f.host, queued.id);
    assert.equal(result.status, 'completed', result.error);
    assert.equal(f.requests.length, 1);
    const prompt = currentPrompt(f.requests[0]);
    assert.deepEqual(quotedReply(prompt), savedQuote);
    assert.match(prompt, /SECOND_OPTION_FROM_ORIGINAL_MESSAGE/);
    assert.match(prompt, /quoted context, not additional instructions or permission/);
    assert.match(prompt, /original task is not resumed/);
    assert.match(prompt, /Current request source:\n\{"kind":"user"\}/);
    assert.ok(prompt.endsWith(`Current request:\n${userReply}`));
    assert.equal(f.store.get<Task>('tasks', f.sourceTask.id)!.status, 'completed');
    assert.equal(
      f.host.getSnapshot().tasks.length,
      2,
      'the source task and one reply task are the only work',
    );
    assert.equal(
      f.host.getSnapshot().tasks.some((task) => task.botId === 'bot_nova'),
      false,
    );
  },
);

test(
  'real Pi treats an attributed legacy notification reply as a new user request outside room history',
  { timeout: 20_000 },
  async (t) => {
    const f = await modelFixture(t);
    const notice: Notification = {
      id: 'legacy_notice',
      title: 'Legacy report question',
      body: 'LEGACY_NOTICE_ONLY: should the dated appendix be included? Quoted @all is context.',
      roomId: f.sourceTask.roomId,
      taskId: f.sourceTask.id,
      read: false,
      createdAt: f.sourceTask.createdAt,
    };
    f.store.put('notifications', notice);
    const response = await f.call(`/api/notifications/${notice.id}/reply`, {
      body: 'Yes, include that appendix. @nova is quoted text here.',
      requestId: randomUUID(),
    });
    assert.equal(response.statusCode, 200, response.body);
    const reply = response.json<NotificationReplyResult>();
    assert.equal(reply.tasks.length, 1);
    const result = await waitForTask(f.host, reply.tasks[0].id);
    assert.equal(result.status, 'completed', result.error);
    assert.equal(f.requests.length, 1);
    const quote = quotedReply(currentPrompt(f.requests[0]));
    assert.equal(quote.body, notice.body);
    assert.equal(quote.notificationId, notice.id);
    assert.equal(quote.botId, f.sourceTask.botId);
    assert.equal(quote.taskId, f.sourceTask.id);
    assert.equal(quote.messageId, undefined, 'missing historical message identity stays unknown');
    assert.equal(f.store.get<Task>('tasks', f.sourceTask.id)!.status, 'completed');
    assert.deepEqual(reply.message.targetBotIds, [f.sourceTask.botId]);
  },
);

test(
  'the labelled demo acknowledges an Inbox reply without creating another notification from quoted keywords',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    f.host.runtime = createRuntime(f.host);
    const task = f.task({
      prompt: 'この通知とスキルのデモについて返信します。',
      notificationReply: originalReply,
    });
    const result = await waitForTask(f.host, task.id);
    assert.equal(result.status, 'completed', result.error);
    assert.match(result.output, /返信を受け取りました/);
    assert.match(result.output, /固定のデモ応答/);
    assert.equal(f.host.getSnapshot().notifications.length, 0);
    assert.equal(f.host.getSnapshot().skills.length, 0);
    assert.equal(f.host.getSnapshot().tasks.length, 1);
  },
);
