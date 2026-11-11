import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { createApp } from '../src/server/app.js';
import type { OperationRecord } from '../src/server/runtime/contract.js';
import { TASK_INPUT_CUSTOM_TYPE } from '../src/server/runtime/task-inputs.js';
import { TaskInputControl } from '../src/server/runtime/task-inputs.js';
import { ImageInputBudget } from '../src/server/runtime/image-budget.js';
import type {
  Approval,
  Message,
  Room,
  Task,
  TaskInput,
  TaskInputResult,
} from '../src/shared/types.js';

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

interface HeldRequest {
  marker: string;
  response: ServerResponse;
  ended: boolean;
  complete(text?: string): void;
}
interface ModelRequest extends HeldRequest {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  accept(): void;
  tools(calls: Array<{ name: string; args: Record<string, unknown> }>): void;
}

/** Real Pi + real local SSE; no user's model, browser, account or workspace. */
async function fixture(t: TestContext, capacity = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-task-steering-'));
  const dataDir = join(directory, 'data');
  const requests: ModelRequest[] = [];
  const toolRequests: HeldRequest[] = [];
  let holdNextModelResponse = false;
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith('/held-tool/')) {
      const record: HeldRequest = {
        marker: request.url.slice('/held-tool/'.length),
        response,
        ended: false,
        complete(text = 'original operation completed') {
          assert.equal(record.ended, false, 'steering must not abort a started external action');
          response.end(text);
          record.ended = true;
        },
      };
      response.once('close', () => {
        record.ended = true;
      });
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('operation-started\n');
      toolRequests.push(record);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
      messages: ModelRequest['messages'];
    };
    const marker = payload.messages
      .filter((message) => message.role === 'user')
      .flatMap((message) => [...JSON.stringify(message.content).matchAll(/SCENARIO_[A-Z_]+/g)])
      .at(-1)?.[0];
    assert.ok(marker);
    const index = requests.length;
    const send = (delta: object, finish: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: `${marker}-${index}`, object: 'chat.completion.chunk', created: 1, model: 'steering-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    const finish = (reason: string) => {
      send({}, reason);
      response.end('data: [DONE]\n\n');
      record.ended = true;
    };
    const record: ModelRequest = {
      marker,
      response,
      messages: payload.messages,
      ended: false,
      accept() {
        assert.equal(record.ended, false);
        assert.equal(response.headersSent, false);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        send({ role: 'assistant', content: `partial-${marker} ` });
      },
      complete(text = 'completed with the current instructions') {
        assert.equal(record.ended, false);
        send({ content: text });
        finish('stop');
      },
      tools(calls) {
        assert.equal(record.ended, false);
        send({
          tool_calls: calls.map(({ name, args }, toolIndex) => ({
            index: toolIndex,
            id: `call_${index}_${toolIndex}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          })),
        });
        finish('tool_calls');
      },
    };
    response.once('close', () => {
      record.ended = true;
    });
    if (holdNextModelResponse) holdNextModelResponse = false;
    else record.accept();
    requests.push(record);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let instance = await createApp({ dataDir, scheduler: false });
  t.after(async () => {
    await instance.app.close();
    for (const request of [...requests, ...toolRequests]) request.response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const settings = instance.store.settings();
  instance.store.put('settings', {
    ...settings,
    id: 'main',
    demoMode: false,
    autoLearn: false,
    inference: { maxConcurrentRequests: capacity },
    permissions: { ...settings.permissions, fileWrite: 'allow', shell: 'allow' },
    model: {
      ...settings.model,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: 'steering-fixture',
      responseTimeoutSeconds: 15,
      idleTimeoutSeconds: 15,
    },
  });
  const roomResponse = await instance.app.inject({
    method: 'POST',
    url: '/api/rooms',
    payload: {
      name: 'Steering fixture',
      botIds: ['bot_aster', 'bot_nova'],
      parallelResponses: true,
    },
  });
  assert.equal(roomResponse.statusCode, 200, roomResponse.body);
  const room = roomResponse.json<Room>();
  async function receipts(): Promise<Array<{ details?: { inputId?: string } }>> {
    const result: Array<{ details?: { inputId?: string } }> = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.name.endsWith('.jsonl'))
          for (const line of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) {
            const value = JSON.parse(line);
            if (value.type === 'custom_message' && value.customType === TASK_INPUT_CUSTOM_TYPE)
              result.push(value);
          }
      }
    };
    await walk(join(dataDir, 'sessions'));
    return result;
  }
  return {
    get app() {
      return instance.app;
    },
    get controller() {
      return instance.controller;
    },
    get runtime() {
      return instance.runtime;
    },
    get store() {
      return instance.store;
    },
    room,
    requests,
    toolRequests,
    receipts,
    holdNextResponse() {
      holdNextModelResponse = true;
    },
    start(marker: string, botId = 'bot_aster') {
      return instance.controller.enqueueTask({ roomId: room.id, botId, prompt: marker });
    },
    task(task: Task) {
      return instance.store.get<Task>('tasks', task.id)!;
    },
    waitingReason(task: Task) {
      return instance.controller
        .getSnapshot()
        .queue.waitingTasks?.find((item) => item.taskId === task.id)?.reason;
    },
    inputState(input: TaskInput) {
      return instance.controller
        .getSnapshot()
        .taskInputs!.find((candidate) => candidate.id === input.id)!;
    },
    async delivered(input: TaskInput) {
      await until(
        () =>
          instance.controller
            .getSnapshot()
            .taskInputs!.some(
              (candidate) => candidate.id === input.id && candidate.status === 'delivered',
            ),
        `input ${input.id} acknowledged after HTTP acceptance`,
      );
    },
    messages(task: Task) {
      return instance.store
        .list<Message>('messages')
        .filter((message) => message.taskId === task.id && message.authorType === 'bot');
    },
    operations(task: Task) {
      return instance.store
        .list<OperationRecord>('operations')
        .filter((operation) => operation.taskId === task.id);
    },
    async input(
      task: Task,
      body: string,
      mode: TaskInput['mode'] = 'boundary',
      extra: Record<string, unknown> = {},
    ) {
      const response = await instance.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/inputs`,
        payload: { requestId: randomUUID(), body, mode, ...extra },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<TaskInputResult>();
    },
    async request(task: Task, count = 1) {
      await until(
        () => requests.filter((request) => request.marker === task.prompt).length >= count,
        `model request ${count} for ${task.prompt}`,
      );
      return requests.filter((request) => request.marker === task.prompt)[count - 1];
    },
    async done(task: Task) {
      await until(
        () =>
          ['completed', 'failed', 'stopped', 'interrupted'].includes(
            instance.store.get<Task>('tasks', task.id)!.status,
          ),
        `task completion ${task.prompt}`,
      );
      const result = instance.store.get<Task>('tasks', task.id)!;
      assert.equal(result.status, 'completed', result.error);
      return result;
    },
    heldCommand(marker: string) {
      assert.match(marker, /^[a-z]+$/);
      return `node -e "fetch('http://127.0.0.1:${address.port}/held-tool/${marker}').then(r=>r.text()).then(console.log)"`;
    },
    async restart() {
      await instance.app.close();
      instance = await createApp({ dataDir, scheduler: false });
    },
  };
}

test('boundary instructions retain the task and prior response, and are delivered at the next request', async (t) => {
  const f = await fixture(t);
  const task = f.start('SCENARIO_BOUNDARY');
  const first = await f.request(task);
  const accepted = await f.input(task, 'Change the output to a comparison table.');
  assert.equal(first.ended, false);
  assert.equal(f.inputState(accepted.input).status, 'pending');
  first.complete('original segment');
  const second = await f.request(task, 2);
  assert.match(JSON.stringify(second.messages), /Change the output to a comparison table/);
  await f.delivered(accepted.input);
  assert.equal(
    f.store.list<Task>('tasks').filter((candidate) => candidate.kind === 'chat').length,
    1,
  );
  second.complete('revised segment');
  await f.done(task);
  assert.equal(f.messages(task).length, 2);
  assert.match(f.messages(task)[0].body, /original segment/);
  assert.match(f.messages(task)[1].body, /revised segment/);
  assert.equal(
    (await f.receipts()).filter((receipt) => receipt.details?.inputId === accepted.input.id).length,
    1,
  );
});

test('immediate input closes only the active conversation SSE stream and continues the same task', async (t) => {
  const f = await fixture(t);
  const task = f.start('SCENARIO_IMMEDIATE');
  const first = await f.request(task);
  await until(
    () => f.messages(task).some((message) => message.body.includes('partial-SCENARIO_IMMEDIATE')),
    'original response is streaming',
  );
  f.holdNextResponse();
  const accepted = await f.input(task, 'Use the corrected budget of 100 MB.', 'immediate');
  await until(() => first.ended, 'aborted original model transport');
  const second = await f.request(task, 2);
  assert.match(JSON.stringify(second.messages), /corrected budget of 100 MB/);
  assert.equal(f.inputState(accepted.input).status, 'pending');
  second.accept();
  await f.delivered(accepted.input);
  second.complete();
  const completed = await f.done(task);
  assert.equal(completed.id, task.id);
  assert.equal(completed.error, undefined);
  assert.match(f.messages(task)[0].body, /partial-SCENARIO_IMMEDIATE/);
});

test('a stale prepared transcript is withdrawn while waiting for capacity and remains pending until dispatch', async (t) => {
  const f = await fixture(t, 1);
  const blocker = f.start('SCENARIO_BLOCKER');
  const held = await f.request(blocker);
  const target = f.start('SCENARIO_WAITING', 'bot_nova');
  await until(() => f.task(target).status === 'waiting_model', 'queued model request');
  const accepted = await f.input(target, 'Include the newly arrived requirement.');
  await until(
    async () =>
      (await f.receipts()).some((receipt) => receipt.details?.inputId === accepted.input.id),
    'durable injected input',
  );
  assert.equal(f.inputState(accepted.input).status, 'pending');
  assert.equal(f.requests.filter((request) => request.marker === target.prompt).length, 0);
  held.complete();
  await f.done(blocker);
  const request = await f.request(target);
  assert.match(JSON.stringify(request.messages), /newly arrived requirement/);
  await f.delivered(accepted.input);
  request.complete();
  await f.done(target);
});

test('a started external tool finishes once while remaining stale tool calls are superseded', async (t) => {
  const f = await fixture(t);
  const task = f.start('SCENARIO_TOOL');
  const first = await f.request(task);
  const command = f.heldCommand('effect');
  first.tools([
    { name: 'run_command', args: { command } },
    { name: 'write_file', args: { path: 'stale.txt', content: 'must not be written' } },
  ]);
  await until(() => f.toolRequests.length === 1, 'external tool started');
  const accepted = await f.input(
    task,
    'Keep the completed result, but cancel the old file plan.',
    'immediate',
  );
  assert.equal(f.toolRequests[0].ended, false);
  assert.equal(f.inputState(accepted.input).status, 'pending');
  assert.equal(f.requests.length, 1);
  f.toolRequests[0].complete();
  const second = await f.request(task, 2);
  assert.match(JSON.stringify(second.messages), /cancel the old file plan/);
  await assert.rejects(readFile(join(task.workspacePath!, 'stale.txt')), { code: 'ENOENT' });
  assert.equal(
    f.operations(task).filter((operation) => operation.toolName === 'run_command')[0].status,
    'completed',
  );
  second.tools([{ name: 'run_command', args: { command } }]);
  const third = await f.request(task, 3);
  assert.match(JSON.stringify(third.messages), /already completed/);
  assert.equal(f.toolRequests.length, 1, 'the completed effect must not execute twice');
  third.complete();
  await f.done(task);
});

test('pending approvals are superseded without poisoning the operation receipt or approving the old plan', async (t) => {
  const f = await fixture(t);
  const settings = f.store.settings();
  f.store.put('settings', {
    ...settings,
    id: 'main',
    permissions: { ...settings.permissions, fileWrite: 'ask' },
  });
  const task = f.start('SCENARIO_APPROVAL');
  const first = await f.request(task);
  first.tools([{ name: 'write_file', args: { path: 'reviewed.txt', content: 'old content' } }]);
  await until(
    () =>
      f.store
        .list<Approval>('approvals')
        .some((approval) => approval.taskId === task.id && approval.status === 'pending'),
    'first approval',
  );
  const old = f.store
    .list<Approval>('approvals')
    .find((approval) => approval.taskId === task.id && approval.status === 'pending')!;
  await f.input(task, 'Write the revised content instead.');
  const second = await f.request(task, 2);
  assert.equal(f.store.get<Approval>('approvals', old.id)!.status, 'cancelled');
  assert.throws(() => f.controller.decideApproval(old.id, true), /no longer pending/);
  assert.equal(f.operations(task).length, 0);
  second.tools([
    { name: 'write_file', args: { path: 'reviewed.txt', content: 'revised content' } },
  ]);
  await until(
    () =>
      f.store
        .list<Approval>('approvals')
        .some((approval) => approval.taskId === task.id && approval.status === 'pending'),
    'revised approval',
  );
  const current = f.store
    .list<Approval>('approvals')
    .find((approval) => approval.taskId === task.id && approval.status === 'pending')!;
  f.controller.decideApproval(current.id, true);
  const third = await f.request(task, 3);
  assert.equal(
    await readFile(join(task.workspacePath!, 'reviewed.txt'), 'utf8'),
    'revised content',
  );
  third.complete();
  await f.done(task);
});

test('owner stop wins a simultaneous immediate input and preserves it for explicit resume', async (t) => {
  const f = await fixture(t);
  const task = f.start('SCENARIO_STOP');
  const first = await f.request(task);
  const original = f.runtime.notifyTaskInput!.bind(f.runtime);
  const mocked = t.mock.method(f.runtime, 'notifyTaskInput', (taskId: string) => {
    original(taskId);
    void f.controller.stop(taskId);
  });
  const accepted = await f.input(task, 'Resume later with this instruction.', 'immediate');
  await until(() => f.task(task).status === 'stopped', 'owner stop');
  mocked.mock.restore();
  await until(() => first.ended, 'stopped model transport closed');
  assert.equal(f.inputState(accepted.input).status, 'pending');
  assert.equal(f.requests.length, 1);
  f.controller.resume(task.id);
  const resumed = await f.request(task, 2);
  assert.match(JSON.stringify(resumed.messages), /Resume later with this instruction/);
  resumed.complete();
  await f.done(task);
});

test('an injected but undispatched input survives restart without duplicate session injection', async (t) => {
  const f = await fixture(t, 1);
  const blocker = f.start('SCENARIO_RESTART_BLOCKER');
  await f.request(blocker);
  const target = f.start('SCENARIO_RESTART_TARGET', 'bot_nova');
  await until(() => f.task(target).status === 'waiting_model', 'target model wait');
  const accepted = await f.input(target, 'Preserve exactly one durable copy of this instruction.');
  await until(
    async () =>
      (await f.receipts()).some((receipt) => receipt.details?.inputId === accepted.input.id),
    'persisted input before shutdown',
  );
  assert.equal(f.inputState(accepted.input).status, 'pending');
  await f.restart();
  assert.equal(f.task(target).status, 'interrupted');
  assert.equal(f.inputState(accepted.input).status, 'pending');
  f.controller.resume(target.id);
  const request = await f.request(target);
  assert.equal(
    (JSON.stringify(request.messages).match(/Preserve exactly one durable copy/g) ?? []).length,
    1,
  );
  assert.equal(
    (await f.receipts()).filter((receipt) => receipt.details?.inputId === accepted.input.id).length,
    1,
  );
  await f.delivered(accepted.input);
  request.complete();
  await f.done(target);
});

test('a paused room retains additional instructions until explicit room resume', async (t) => {
  const f = await fixture(t);
  const task = f.start('SCENARIO_PAUSED');
  const first = await f.request(task);
  f.controller.pauseRoom(f.room.id);
  const accepted = await f.input(task, 'Apply this after the room is resumed.', 'immediate');
  await until(() => first.ended, 'old generation cancelled while room remains paused');
  assert.equal(f.store.get<Room>('rooms', f.room.id)!.paused, true);
  assert.equal(f.inputState(accepted.input).status, 'pending');
  assert.equal(f.requests.length, 1);
  f.holdNextResponse();
  f.controller.resumeRoom(f.room.id);
  const second = await f.request(task, 2);
  assert.match(JSON.stringify(second.messages), /Apply this after the room is resumed/);
  assert.equal(f.inputState(accepted.input).status, 'pending');
  second.accept();
  await f.delivered(accepted.input);
  second.complete();
  await f.done(task);
});

test('an approval resolved just before steering still cannot issue the superseded operation', async (t) => {
  const f = await fixture(t);
  const settings = f.store.settings();
  f.store.put('settings', {
    ...settings,
    id: 'main',
    permissions: { ...settings.permissions, fileWrite: 'ask' },
  });
  const task = f.start('SCENARIO_APPROVAL_RACE');
  const first = await f.request(task);
  let approvalResolved = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.controller.requestApproval.bind(f.controller);
  t.mock.method(f.controller, 'requestApproval', async (...args: Parameters<typeof original>) => {
    const approved = await original(...args);
    approvalResolved = true;
    await held;
    return approved;
  });
  first.tools([{ name: 'write_file', args: { path: 'obsolete.txt', content: 'obsolete' } }]);
  await until(
    () => f.store.list<Approval>('approvals').some((approval) => approval.status === 'pending'),
    'approval to resolve',
  );
  const approval = f.store
    .list<Approval>('approvals')
    .find((approval) => approval.status === 'pending')!;
  f.controller.decideApproval(approval.id, true);
  await until(() => approvalResolved, 'resolved approval held before execution');
  await f.input(task, 'Do not create the previously approved file.');
  release();
  const second = await f.request(task, 2);
  await assert.rejects(readFile(join(task.workspacePath!, 'obsolete.txt')), { code: 'ENOENT' });
  assert.equal(f.operations(task).length, 0);
  assert.match(JSON.stringify(second.messages), /Do not create the previously approved file/);
  second.complete();
  await f.done(task);
});

const tinyPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6cAAAAASUVORK5CYII=';
const imageUrls = (request: ModelRequest): string[] =>
  request.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part: { type?: string; image_url?: { url?: string } }) =>
          part.type === 'image_url' && part.image_url?.url ? [part.image_url.url] : [],
        )
      : [],
  );

test('steering attachments reach the real Pi model request as pixels once, with stable image identifiers', async (t) => {
  const f = await fixture(t);
  const settings = f.store.settings();
  f.store.put('settings', {
    ...settings,
    id: 'main',
    model: { ...settings.model, imageInput: true },
  });
  const task = f.start('SCENARIO_IMAGES');
  const first = await f.request(task);
  const accepted = await f.input(
    task,
    'Use this visual reference for the existing task.',
    'boundary',
    {
      images: [{ filename: '追加の資料.png', mimeType: 'image/png', data: tinyPng }],
    },
  );
  first.complete();
  const second = await f.request(task, 2);
  assert.deepEqual(imageUrls(second), [`data:image/png;base64,${tinyPng}`]);
  assert.match(JSON.stringify(second.messages), new RegExp(accepted.input.inputImageIds![0]));
  await f.delivered(accepted.input);
  await f.input(task, 'Also include a short explanation.');
  second.complete();
  const third = await f.request(task, 3);
  assert.equal(
    imageUrls(third).length,
    1,
    'later instructions do not inject the same attachment twice',
  );
  third.complete();
  await f.done(task);
});

test('an exhausted shared image budget delivers the text with an explicit receipt reason and no pixels', async (t) => {
  const f = await fixture(t);
  const settings = f.store.settings();
  f.store.put('settings', {
    ...settings,
    id: 'main',
    model: { ...settings.model, imageInput: true },
  });
  const task = f.start('SCENARIO_IMAGE_BUDGET');
  const first = await f.request(task);
  t.mock.method(ImageInputBudget.prototype, 'tryReserve', () => false);
  const accepted = await f.input(
    task,
    'Retain this written instruction even if the image cannot be supplied.',
    'boundary',
    {
      images: [{ filename: 'budget.png', mimeType: 'image/png', data: tinyPng }],
    },
  );
  first.complete();
  const second = await f.request(task, 2);
  assert.deepEqual(imageUrls(second), []);
  assert.match(JSON.stringify(second.messages), /Retain this written instruction/);
  assert.match(JSON.stringify(second.messages), /Do not claim to have viewed these images/);
  await f.delivered(accepted.input);
  assert.match(f.inputState(accepted.input).reason ?? '', /image pixels could not be included/);
  second.complete();
  await f.done(task);
});

test('the input coordinator never aborts or acknowledges delivery through a compaction request', async (t) => {
  const f = await fixture(t);
  f.controller.pauseRoom(f.room.id);
  const task = f.start('SCENARIO_COMPACTION');
  const control = new TaskInputControl({
    host: f.controller,
    task,
    settings: f.store.settings(),
    signal: new AbortController().signal,
    operationKeys: new Set(),
  });
  const compaction = control.beginModelRequest(false);
  const accepted = await f.input(task, 'Apply after context summarization.', 'immediate');
  control.notify();
  assert.equal(
    compaction.signal.aborted,
    false,
    'summarization has its own uninterrupted lifetime',
  );
  compaction.dispatched();
  assert.equal(f.inputState(accepted.input).status, 'pending');
  assert.equal(control.takeModelSuperseded(), false);
  compaction.finish();
  const conversation = control.beginModelRequest(true);
  assert.equal(
    conversation.signal.aborted,
    true,
    'an unprepared stale conversation must be rebuilt',
  );
  assert.equal(control.takeModelSuperseded(), true);
  conversation.finish();
});

test('steering accepted at the final approval-entry checkpoint prevents a stale approval from being created', async (t) => {
  const f = await fixture(t);
  const settings = f.store.settings();
  f.store.put('settings', {
    ...settings,
    id: 'main',
    permissions: { ...settings.permissions, fileWrite: 'ask' },
  });
  const task = f.start('SCENARIO_APPROVAL_ENTRY');
  const first = await f.request(task);
  let parked = false;
  const update = f.controller.updateTask.bind(f.controller);
  t.mock.method(f.controller, 'updateTask', (...args: Parameters<typeof update>) => {
    const result = update(...args);
    if (!parked && args[0] === task.id && args[1].status === 'awaiting_approval') {
      parked = true;
      f.controller.pauseRoom(f.room.id);
    }
    return result;
  });
  first.tools([
    { name: 'write_file', args: { path: 'obsolete-approval.txt', content: 'obsolete' } },
  ]);
  await until(
    () => parked && f.waitingReason(task) === 'paused',
    'last checkpoint before approval creation',
  );
  assert.equal(f.store.list<Approval>('approvals').length, 0);
  const accepted = await f.input(task, 'Discard the unreviewed file proposal.');
  f.controller.resumeRoom(f.room.id);
  const second = await f.request(task, 2);
  assert.equal(
    f.store.list<Approval>('approvals').length,
    0,
    'the stale proposal cannot become an approval after the input was accepted',
  );
  assert.equal(f.operations(task).length, 0);
  await f.delivered(accepted.input);
  second.complete();
  await f.done(task);
});

test('disabling image input after injection records the actual dispatch omission', async (t) => {
  const f = await fixture(t, 1);
  const settings = f.store.settings();
  f.store.put('settings', {
    ...settings,
    id: 'main',
    model: { ...settings.model, imageInput: true },
  });
  const blocker = f.start('SCENARIO_IMAGE_BLOCKER');
  const held = await f.request(blocker);
  const target = f.start('SCENARIO_IMAGE_POLICY', 'bot_nova');
  await until(() => f.task(target).status === 'waiting_model', 'queued target model');
  const accepted = await f.input(
    target,
    'Keep this reference instruction after the policy change.',
    'boundary',
    {
      images: [{ filename: 'policy.png', mimeType: 'image/png', data: tinyPng }],
    },
  );
  await until(
    async () =>
      (await f.receipts()).some((receipt) => receipt.details?.inputId === accepted.input.id),
    'input image persisted before dispatch',
  );
  f.controller.pauseRoom(f.room.id);
  held.complete();
  await f.done(blocker);
  await until(() => f.waitingReason(target) === 'paused', 'target parked before policy edit');
  assert.equal(f.inputState(accepted.input).status, 'pending');
  const current = f.store.settings();
  f.store.put('settings', {
    ...current,
    id: 'main',
    model: { ...current.model, imageInput: false },
  });
  f.controller.resumeRoom(f.room.id);
  const request = await f.request(target);
  assert.deepEqual(imageUrls(request), []);
  assert.match(JSON.stringify(request.messages), /Keep this reference instruction/);
  await f.delivered(accepted.input);
  assert.match(f.inputState(accepted.input).reason ?? '', /conversation image input is disabled/);
  request.complete();
  await f.done(target);
});

test('pending inputs summarized before dispatch are restored once to the real request without charging images twice', async (t) => {
  const f = await fixture(t);
  const settings = f.store.settings();
  f.store.put('settings', {
    ...settings,
    id: 'main',
    model: { ...settings.model, imageInput: true },
  });
  const task = f.start('SCENARIO_INPUT_COMPACTED');
  const first = await f.request(task);
  const originalInject = TaskInputControl.prototype.inject;
  let session: AgentSession | undefined;
  let compacted = false;
  const compact = (current: AgentSession) => {
    const kept = current.sessionManager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'SCENARIO_INPUT_COMPACTED retained task checkpoint.' }],
      timestamp: Date.now(),
    });
    current.sessionManager.appendCompaction(
      'Older context was summarized; only the retained checkpoint remains.',
      kept,
      1000,
    );
  };
  t.mock.method(
    TaskInputControl.prototype,
    'inject',
    async function (this: TaskInputControl, current: AgentSession) {
      const result = await originalInject.call(this, current);
      if (result && !compacted) {
        session = current;
        compacted = true;
        compact(current);
      }
      return result;
    },
  );
  let reservations = 0;
  const reserve = ImageInputBudget.prototype.tryReserve;
  t.mock.method(
    ImageInputBudget.prototype,
    'tryReserve',
    function (this: ImageInputBudget, ...args: Parameters<typeof reserve>) {
      reservations++;
      return reserve.apply(this, args);
    },
  );
  const accepted = await f.input(task, 'Exact unsummarized owner requirement 52791.', 'boundary', {
    images: [{ filename: 'compact.png', mimeType: 'image/png', data: tinyPng }],
  });
  first.complete();
  const second = await f.request(task, 2);
  assert.ok(compacted);
  assert.equal(
    JSON.stringify(second.messages).match(/Exact unsummarized owner requirement 52791/g)?.length,
    1,
  );
  assert.deepEqual(imageUrls(second), [`data:image/png;base64,${tinyPng}`]);
  assert.equal(
    reservations,
    1,
    'restoring the durable image content does not consume the task budget again',
  );
  await f.delivered(accepted.input);
  second.tools([{ name: 'list_automations', args: {} }]);
  const third = await f.request(task, 3);
  assert.match(JSON.stringify(third.messages), /Exact unsummarized owner requirement 52791/);
  assert.equal(imageUrls(third).length, 1, 'the restored entry persists for subsequent tool turns');
  assert.ok(session);
  let laterCompacted = false;
  session.subscribe((event) => {
    if (event.type === 'tool_execution_end' && !laterCompacted) {
      laterCompacted = true;
      compact(session!);
    }
  });
  third.tools([{ name: 'list_automations', args: {} }]);
  const fourth = await f.request(task, 4);
  assert.ok(laterCompacted);
  assert.doesNotMatch(
    JSON.stringify(fourth.messages),
    /Exact unsummarized owner requirement 52791/,
    'already delivered history may be summarized normally',
  );
  assert.equal(
    (await f.receipts()).filter((receipt) => receipt.details?.inputId === accepted.input.id).length,
    2,
    'only the pre-delivery compaction required one restoration entry',
  );
  fourth.complete();
  await f.done(task);
});

test('resuming pending instructions in demo mode preserves them and reports the connected-model requirement', async (t) => {
  const f = await fixture(t);
  const task = f.start('SCENARIO_DEMO_RESUME');
  await f.request(task);
  const accepted = await f.input(
    task,
    'Preserve this instruction across a later configuration change.',
  );
  f.controller.stop(task.id);
  await until(() => f.task(task).status === 'stopped', 'owner stop');
  f.store.put('settings', { ...f.store.settings(), id: 'main', demoMode: true });
  f.controller.resume(task.id);
  await until(() => f.task(task).status === 'failed', 'demo continuation rejected');
  assert.match(f.task(task).error ?? '', /Disable demo mode and connect a conversation model/);
  assert.equal(f.inputState(accepted.input).status, 'pending');
  assert.equal(f.requests.length, 1);
});

test('partial compaction preserves the accepted order of all pending owner corrections across later tool turns', async (t) => {
  const f = await fixture(t);
  const task = f.start('SCENARIO_ORDERED_COMPACTION');
  const first = await f.request(task);
  const oldInput = await f.input(task, 'First correction: use the blue option.');
  const newInput = await f.input(task, 'Latest correction: replace blue with the green option.');
  const originalInject = TaskInputControl.prototype.inject;
  let compacted = false;
  let session: AgentSession | undefined;
  t.mock.method(
    TaskInputControl.prototype,
    'inject',
    async function (this: TaskInputControl, current: AgentSession) {
      const result = await originalInject.call(this, current);
      if (result && !compacted) {
        compacted = true;
        session = current;
        const retained = current.sessionManager
          .getBranch()
          .find(
            (entry) =>
              entry.type === 'custom_message' &&
              (entry.details as { inputId?: string } | undefined)?.inputId === newInput.input.id,
          );
        assert.ok(retained);
        current.sessionManager.appendCompaction(
          'SCENARIO_ORDERED_COMPACTION retained task summary.',
          retained.id,
          1000,
        );
      }
      return result;
    },
  );
  first.complete();
  const assertOrdered = (request: ModelRequest) => {
    const text = JSON.stringify(request.messages);
    assert.equal(text.match(/First correction: use the blue option/g)?.length, 1);
    assert.equal(text.match(/Latest correction: replace blue with the green option/g)?.length, 1);
    assert.ok(text.indexOf('First correction:') < text.indexOf('Latest correction:'));
  };
  const second = await f.request(task, 2);
  assertOrdered(second);
  await f.delivered(oldInput.input);
  await f.delivered(newInput.input);
  second.tools([{ name: 'list_automations', args: {} }]);
  const third = await f.request(task, 3);
  assertOrdered(third);
  assert.ok(session);
  const projectedIds = session.sessionManager
    .buildSessionProjection()
    .messages.flatMap((message) =>
      message.role === 'custom' && message.customType === TASK_INPUT_CUSTOM_TYPE
        ? [(message.details as { inputId: string }).inputId]
        : [],
    );
  assert.deepEqual(projectedIds, [oldInput.input.id, newInput.input.id]);
  third.complete();
  await f.done(task);
});
