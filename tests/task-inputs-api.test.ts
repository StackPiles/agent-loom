import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import type { RuntimeHost } from '../src/server/runtime/contract.js';
import { readGeneratedImage } from '../src/server/runtime/images.js';
import type { StoredTaskInput } from '../src/server/task-inputs.js';
import {
  TASK_INPUT_BODY_LIMIT,
  TASK_INPUT_PENDING_LIMIT,
  TASK_INPUT_TOTAL_LIMIT,
  TaskInputSupersededError,
  type TaskInputResult,
} from '../src/shared/task-inputs.js';
import type { Approval, Bot, Message, Room, Task, TaskStatus } from '../src/shared/types.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQcPj/HwAEQgJfMvKOtQAAAABJRU5ErkJggg==',
  'base64',
);
const upload = { filename: '追加の画面.png', mimeType: 'image/png', data: png.toString('base64') };

async function fixture(
  t: TestContext,
  options: { apiToken?: string; onNotify?: (taskId: string, host: RuntimeHost) => void } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-task-inputs-'));
  const starts: string[] = [];
  const notifications: string[] = [];
  const open = () =>
    createApp({
      dataDir,
      apiToken: options.apiToken,
      scheduler: false,
      runtimeFactory: (host) => ({
        start(task) {
          starts.push(task.id);
        },
        notifyTaskInput(taskId) {
          notifications.push(taskId);
          options.onNotify?.(taskId, host);
        },
        async stop(taskId) {
          host.updateTask(taskId, { status: 'stopped' });
        },
        async shutdown() {},
        queueState: () => ({ active: 0, waiting: 0 }),
      }),
    });
  let context = await open();
  context.store.put('settings', {
    ...context.store.settings(),
    id: 'main',
    demoMode: false,
    autoLearn: false,
    model: {
      ...context.store.settings().model,
      baseUrl: 'http://127.0.0.1:1/v1',
      modelId: 'fixture-conversation-model',
      imageInput: true,
    },
  });
  t.after(async () => {
    await context.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const call = (
    method: 'GET' | 'POST',
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
  return {
    dataDir,
    starts,
    notifications,
    call,
    get store() {
      return context.store;
    },
    get controller() {
      return context.controller;
    },
    task(input: { botId?: string; kind?: Task['kind']; parentTaskId?: string } = {}) {
      const task = context.controller.enqueueTask({
        roomId: 'room_lounge',
        botId: 'bot_aster',
        prompt: 'The immutable original owner request.',
        ...input,
      });
      return context.store.get<Task>('tasks', task.id)!;
    },
    input(
      taskId: string,
      payload: Record<string, unknown> = {},
      headers: Record<string, string> = {},
    ) {
      return call(
        'POST',
        `/api/tasks/${taskId}/inputs`,
        {
          requestId: randomUUID(),
          body: 'Please include the new requirement.',
          ...payload,
        },
        headers,
      );
    },
    async files() {
      return readdir(join(dataDir, 'generated-images')).catch(() => []);
    },
    async restart() {
      await context.app.close();
      context = await open();
    },
  };
}

test('additional instructions retain one task and commit the owner receipt before notification', async (t) => {
  const observed: Array<{ task: Task | undefined; inputs: unknown[]; messages: Message[] }> = [];
  const f = await fixture(t, {
    onNotify(taskId, host) {
      const snapshot = host.getSnapshot();
      observed.push({
        task: snapshot.tasks.find((task) => task.id === taskId),
        inputs: snapshot.taskInputs ?? [],
        messages: snapshot.messages,
      });
    },
  });
  const task = f.task();
  const response = await f.input(task.id, {
    body: '  @all @nova are literal text; revise this task.\n',
  });
  assert.equal(response.statusCode, 200, response.body);
  const first = response.json<TaskInputResult>();
  assert.equal(first.duplicate, false);
  assert.equal(first.input.mode, 'boundary');
  assert.equal(first.input.status, 'pending');
  assert.equal(first.input.sequence, 1);
  assert.equal(first.input.body, '@all @nova are literal text; revise this task.');
  assert.equal(first.input.messageId, first.message.id);
  assert.equal(first.message.taskInputId, first.input.id);
  assert.equal(first.message.taskId, task.id);
  assert.deepEqual(first.message.targetBotIds, [task.botId]);
  assert.deepEqual(f.store.get('tasks', task.id), task);
  assert.equal(f.store.list('tasks').length, 1);
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0].task, task);
  assert.deepEqual(observed[0].inputs, [first.input]);
  assert.deepEqual(observed[0].messages, [first.message]);
  const second = await f.input(task.id, { mode: 'immediate' });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json<TaskInputResult>().input.sequence, 2);
  assert.equal(second.json<TaskInputResult>().input.mode, 'immediate');
  assert.deepEqual(f.starts, [task.id]);
  assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes('requestFingerprint'));

  const normal = await f.call('POST', '/api/rooms/room_lounge/messages', {
    body: '@aster A separate request.',
  });
  assert.equal(normal.statusCode, 200, normal.body);
  const newTask = normal.json<{ tasks: Task[]; message: Message }>();
  assert.equal(newTask.tasks.length, 1);
  assert.notEqual(newTask.tasks[0].id, task.id);
  assert.equal(newTask.message.taskInputId, undefined);
});

test('idempotent concurrent image retries return one receipt, message and immutable image file', async (t) => {
  const f = await fixture(t);
  const task = f.task();
  const payload = { requestId: randomUUID(), body: '', images: [upload] };
  const responses = await Promise.all([f.input(task.id, payload), f.input(task.id, payload)]);
  for (const response of responses) assert.equal(response.statusCode, 200, response.body);
  const results = responses.map((response) => response.json<TaskInputResult>());
  assert.deepEqual(results[0].input, results[1].input);
  assert.deepEqual(results[0].message, results[1].message);
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true]);
  const accepted = results[0];
  assert.equal(f.store.list('taskInputs').length, 1);
  assert.equal(f.store.list('messages').length, 1);
  assert.equal(f.store.list('images').length, 1);
  assert.equal((await f.files()).length, 1);
  const image = accepted.message.attachments![0];
  assert.deepEqual(accepted.input.inputImageIds, [image.id]);
  assert.deepEqual(await readGeneratedImage(f.dataDir, image), png);
  assert.equal(image.source, 'uploaded');
  assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes(upload.data));
  f.controller.markTaskInputsDelivered(task.id, [accepted.input.id]);
  f.controller.updateTask(task.id, { status: 'completed' });
  const retry = await f.input(task.id, payload);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json<TaskInputResult>().duplicate, true);
  assert.equal(retry.json<TaskInputResult>().input.status, 'delivered');
  assert.equal((await f.files()).length, 1);
  const differentTask = f.task({ botId: 'bot_nova' });
  for (const change of [
    { body: 'Changed body.' },
    { mode: 'immediate' },
    { images: [{ ...upload, filename: 'different.png' }] },
    { images: [] },
  ]) {
    const changed = await f.input(task.id, { ...payload, ...change });
    assert.equal(changed.statusCode, change.images?.length === 0 ? 400 : 409, changed.body);
  }
  assert.equal((await f.input(differentTask.id, payload)).statusCode, 409);
  assert.equal(f.store.list('taskInputs').length, 1);
});

test('steering requires owner authentication, an active target and unchanged room membership', async (t) => {
  const f = await fixture(t, { apiToken: 'fixture-owner-token' });
  const auth = { authorization: 'Bearer fixture-owner-token' };
  const task = f.task();
  assert.equal((await f.input(task.id)).statusCode, 401);
  assert.equal((await f.input('missing-task', {}, auth)).statusCode, 404);
  for (const status of ['completed', 'failed', 'stopped', 'interrupted'] as TaskStatus[]) {
    f.store.patch<Task>('tasks', task.id, { status });
    assert.equal((await f.input(task.id, {}, auth)).statusCode, 409);
  }
  f.store.patch<Task>('tasks', task.id, { status: 'queued', kind: 'learning' });
  assert.equal((await f.input(task.id, {}, auth)).statusCode, 409);
  f.store.patch<Task>('tasks', task.id, { kind: 'chat' });
  const room = f.store.get<Room>('rooms', task.roomId)!;
  const bot = f.store.get<Bot>('bots', task.botId)!;
  for (const patch of [{ archived: true }, { botIds: ['bot_nova'] }]) {
    f.store.put('rooms', { ...room, ...patch });
    assert.equal((await f.input(task.id, {}, auth)).statusCode, 409);
  }
  f.store.put('rooms', room);
  f.store.put('bots', { ...bot, enabled: false });
  assert.equal((await f.input(task.id, {}, auth)).statusCode, 409);
  f.store.put('bots', bot);
  f.store.patch<Room>('rooms', room.id, { workspacePath: join(f.dataDir, 'other-workspace') });
  assert.equal((await f.input(task.id, {}, auth)).statusCode, 409);
  f.store.put('rooms', room);
  f.controller.maintenance = true;
  assert.equal((await f.input(task.id, {}, auth)).statusCode, 503);
  f.controller.maintenance = false;
  assert.equal(f.store.list('taskInputs').length, 0);
  assert.equal(f.store.list('messages').length, 0);
  assert.deepEqual(f.notifications, []);
  assert.equal((await f.input(task.id, {}, auth)).statusCode, 200);
});

test('strict input validation rejects forged scope, demo execution and invalid images before admission', async (t) => {
  const f = await fixture(t);
  const task = f.task();
  for (const patch of [
    { requestId: 'not-a-uuid' },
    { body: ' '.repeat(3) },
    { body: 42 },
    { body: 'x'.repeat(TASK_INPUT_BODY_LIMIT + 1) },
    { mode: 'interrupt_tool' },
    { roomId: 'room_other' },
    { botId: 'bot_nova' },
    { status: 'delivered' },
    { inputImageIds: [`img_${'a'.repeat(64)}`] },
    { images: [{ ...upload, id: `img_${'a'.repeat(64)}` }] },
    { images: [{ ...upload, data: 'AAAA' }] },
    { images: [{ ...upload, mimeType: 'image/jpeg' }] },
    { images: Array.from({ length: 11 }, () => upload) },
  ]) {
    const response = await f.input(task.id, patch);
    assert.equal(response.statusCode, 400, response.body);
  }
  const settings = f.store.settings();
  f.store.put('settings', { ...settings, id: 'main', demoMode: true });
  const demo = await f.input(task.id);
  assert.equal(demo.statusCode, 409);
  assert.match(demo.json().error, /connected conversation model/);
  f.store.put('settings', { ...settings, id: 'main', model: { ...settings.model, modelId: '' } });
  assert.equal((await f.input(task.id)).statusCode, 409);
  f.store.put('settings', {
    ...settings,
    id: 'main',
    model: { ...settings.model, imageInput: false },
  });
  assert.equal((await f.input(task.id, { images: [upload] })).statusCode, 400);
  assert.equal(f.store.list('taskInputs').length, 0);
  assert.equal(f.store.list('messages').length, 0);
  assert.equal(f.store.list('images').length, 0);
  assert.deepEqual(await f.files(), []);
});

test('paused rooms and stop/restart retain pending receipts without admitting new execution', async (t) => {
  const f = await fixture(t);
  const task = f.task();
  f.controller.pauseRoom(task.roomId);
  const payload = { requestId: randomUUID(), body: 'Apply this after explicitly resuming.' };
  const first = await f.input(task.id, payload);
  assert.equal(first.statusCode, 200, first.body);
  const input = first.json<TaskInputResult>().input;
  assert.equal(f.store.get<Room>('rooms', task.roomId)!.paused, true);
  assert.equal(f.store.get<Task>('tasks', task.id)!.status, 'queued');
  await f.controller.stop(task.id);
  assert.equal(f.store.get<Task>('tasks', task.id)!.status, 'stopped');
  assert.equal(f.store.get<StoredTaskInput>('taskInputs', input.id)!.status, 'pending');
  const startsBefore = f.starts.length;
  await f.restart();
  assert.equal(f.starts.length, startsBefore);
  assert.equal(f.store.get<StoredTaskInput>('taskInputs', input.id)!.status, 'pending');
  const retry = await f.input(task.id, payload);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json<TaskInputResult>().duplicate, true);
  assert.equal(f.starts.length, startsBefore);
  f.controller.resume(task.id);
  await setImmediate();
  assert.equal(f.store.get<Room>('rooms', task.roomId)!.paused, true);
  assert.equal(f.store.get<Task>('tasks', task.id)!.status, 'queued');
  assert.equal(f.store.get<StoredTaskInput>('taskInputs', input.id)!.status, 'pending');
});

test('restart marks active work interrupted while leaving its instruction receipt pending', async (t) => {
  const f = await fixture(t);
  const task = f.task();
  f.controller.updateTask(task.id, { status: 'waiting_model' });
  const response = await f.input(task.id);
  const input = response.json<TaskInputResult>().input;
  await f.restart();
  assert.equal(f.store.get<Task>('tasks', task.id)!.status, 'interrupted');
  assert.equal(f.store.get<StoredTaskInput>('taskInputs', input.id)!.status, 'pending');
  assert.equal(f.controller.getSnapshot().taskInputs![0].id, input.id);
});

test('target completion during attachment I/O rejects the input and removes its saved copy', async (t) => {
  const f = await fixture(t);
  const task = f.task();
  const validateTarget = f.controller.validateTarget.bind(f.controller);
  let checked = false;
  t.mock.method(f.controller, 'validateTarget', (roomId: string, botId: string) => {
    const target = validateTarget(roomId, botId);
    if (!checked) {
      checked = true;
      queueMicrotask(() => f.controller.updateTask(task.id, { status: 'completed' }));
    }
    return target;
  });
  const response = await f.input(task.id, { images: [upload] });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(f.store.list('taskInputs').length, 0);
  assert.equal(f.store.list('messages').length, 0);
  assert.equal(f.store.list('images').length, 0);
  assert.deepEqual(await f.files(), []);
  assert.deepEqual(f.notifications, []);
});

test('receipt persistence failure rolls back the owner message and image metadata and cleans image files', async (t) => {
  const f = await fixture(t);
  const task = f.task();
  const put = f.store.put.bind(f.store);
  t.mock.method(f.store, 'put', (kind: string, record: { id: string }) => {
    if (kind === 'taskInputs') throw new Error('Synthetic receipt write failure.');
    return put(kind, record);
  });
  const response = await f.input(task.id, { images: [upload] });
  assert.equal(response.statusCode, 500, response.body);
  assert.deepEqual(f.store.get('tasks', task.id), task);
  assert.equal(f.store.list('taskInputs').length, 0);
  assert.equal(f.store.list('messages').length, 0);
  assert.equal(f.store.list('images').length, 0);
  assert.deepEqual(await f.files(), []);
  assert.deepEqual(f.notifications, []);
});

test('delivery acknowledges only this task atomically, and retains optional attachment delivery detail', async (t) => {
  const f = await fixture(t);
  const task = f.task();
  const other = f.task({ botId: 'bot_nova' });
  const first = (await f.input(task.id)).json<TaskInputResult>().input;
  const second = (await f.input(task.id)).json<TaskInputResult>().input;
  const wrongTask = (await f.input(other.id)).json<TaskInputResult>().input;
  assert.throws(
    () => f.controller.markTaskInputsDelivered(task.id, [first.id, wrongTask.id]),
    /Only accepted/,
  );
  assert.equal(f.store.get<StoredTaskInput>('taskInputs', first.id)!.status, 'pending');
  const patch = f.store.patch.bind(f.store);
  const failing = t.mock.method(f.store, 'patch', (kind: string, id: string, value: object) => {
    if (kind === 'taskInputs' && id === second.id)
      throw new Error('Synthetic second delivery failure.');
    return patch(kind, id, value);
  });
  assert.throws(
    () => f.controller.markTaskInputsDelivered(task.id, [first.id, second.id]),
    /second delivery failure/,
  );
  assert.equal(f.store.get<StoredTaskInput>('taskInputs', first.id)!.status, 'pending');
  failing.mock.restore();
  f.controller.markTaskInputsDelivered(
    task.id,
    [first.id, second.id],
    'Text delivered; pixels unavailable.',
  );
  const delivered = f.store.get<StoredTaskInput>('taskInputs', first.id)!;
  assert.equal(delivered.status, 'delivered');
  assert.ok(delivered.deliveredAt);
  assert.equal(delivered.reason, 'Text delivered; pixels unavailable.');
  f.controller.markTaskInputsDelivered(
    task.id,
    [first.id, first.id],
    'A retry must not replace the receipt.',
  );
  assert.deepEqual(f.store.get('taskInputs', first.id), delivered);
  assert.equal(f.store.get<StoredTaskInput>('taskInputs', wrongTask.id)!.status, 'pending');
});

test('a new instruction supersedes only the target task approval and ordinary denial remains distinct', async (t) => {
  const f = await fixture(t);
  const task = f.task();
  const other = f.task({ botId: 'bot_nova' });
  const approval = (target: Task) =>
    f.controller.requestApproval(
      {
        taskId: target.id,
        roomId: target.roomId,
        botId: target.botId,
        toolName: 'write_file',
        summary: 'Write the old proposal.',
        args: { path: 'proposal.txt' },
      },
      new AbortController().signal,
    );
  const revised = approval(task).then(
    () => {
      throw new Error('A superseded approval must not resolve as a normal decision.');
    },
    (error: unknown) => error,
  );
  const denied = approval(other);
  const before = f.store.list<Approval>('approvals');
  const targetApproval = before.find((item) => item.taskId === task.id)!;
  const otherApproval = before.find((item) => item.taskId === other.id)!;
  const response = await f.input(task.id);
  assert.equal(response.statusCode, 200, response.body);
  assert.ok((await revised) instanceof TaskInputSupersededError);
  const cancelled = f.store.get<Approval>('approvals', targetApproval.id)!;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancellationReason, 'superseded');
  assert.ok(cancelled.decidedAt);
  assert.throws(() => f.controller.decideApproval(targetApproval.id, true), /no longer pending/);
  assert.equal(f.store.get<Approval>('approvals', otherApproval.id)!.status, 'pending');
  f.controller.decideApproval(otherApproval.id, false);
  assert.equal(await denied, false);
  assert.equal(f.store.get<Approval>('approvals', otherApproval.id)!.status, 'denied');
  assert.equal(f.store.get<Approval>('approvals', otherApproval.id)!.cancellationReason, undefined);
});

test('pending and lifetime limits reject new instructions without dropping prior receipts', async (t) => {
  const f = await fixture(t);
  const task = f.task();
  for (let sequence = 0; sequence < TASK_INPUT_PENDING_LIMIT; sequence++) {
    const response = await f.input(task.id);
    assert.equal(response.statusCode, 200, response.body);
  }
  const full = await f.input(task.id);
  assert.equal(full.statusCode, 429, full.body);
  const receipts = f.store.list<StoredTaskInput>('taskInputs');
  f.controller.markTaskInputsDelivered(
    task.id,
    receipts.map((input) => input.id),
  );
  const template = f.store.get<StoredTaskInput>('taskInputs', receipts[0].id)!;
  for (
    let sequence = TASK_INPUT_PENDING_LIMIT + 1;
    sequence <= TASK_INPUT_TOTAL_LIMIT;
    sequence++
  ) {
    const requestId = randomUUID();
    f.store.put('taskInputs', {
      ...template,
      id: 'taskinput_' + requestId.replaceAll('-', ''),
      requestId,
      sequence,
    });
  }
  const lifetime = await f.input(task.id);
  assert.equal(lifetime.statusCode, 429, lifetime.body);
  assert.equal(f.store.list('taskInputs').length, TASK_INPUT_TOTAL_LIMIT);
  assert.equal(f.store.list('messages').length, TASK_INPUT_PENDING_LIMIT);
});

test('a failed approval-state write leaves a committed input and retryable approval callback', async (t) => {
  const f = await fixture(t);
  const task = f.task();
  const decision = f.controller
    .requestApproval(
      {
        taskId: task.id,
        roomId: task.roomId,
        botId: task.botId,
        toolName: 'write_file',
        summary: 'Review the old operation.',
        args: { path: 'proposal.txt' },
      },
      new AbortController().signal,
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  const approval = f.store.list<Approval>('approvals')[0];
  const patch = f.store.patch.bind(f.store);
  let fail = true;
  t.mock.method(f.store, 'patch', (kind: string, id: string, value: object) => {
    if (kind === 'approvals' && fail) {
      fail = false;
      throw new Error('Synthetic approval persistence failure.');
    }
    return patch(kind, id, value);
  });
  const payload = { requestId: randomUUID(), body: 'Revise the operation before proceeding.' };
  assert.equal((await f.input(task.id, payload)).statusCode, 500);
  assert.equal(f.store.list('taskInputs').length, 1);
  assert.equal(f.store.get<Approval>('approvals', approval.id)!.status, 'pending');
  const retry = await f.input(task.id, payload);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json<TaskInputResult>().duplicate, true);
  assert.ok((await decision) instanceof TaskInputSupersededError);
  assert.equal(f.store.get<Approval>('approvals', approval.id)!.status, 'cancelled');
  assert.equal(f.store.list('messages').length, 1);
});
