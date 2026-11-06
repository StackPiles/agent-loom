import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { Approval, Room, Task } from '../src/shared/types.js';
import { createApp } from '../src/server/app.js';
import type { OperationRecord } from '../src/server/runtime/contract.js';

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

interface HeldRequest {
  marker: string;
  response: ServerResponse;
  ended: boolean;
  complete(): void;
}

interface RequestRecord extends HeldRequest {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  tool(name: string, args: Record<string, unknown>): string;
  tools(calls: Array<{ name: string; args: Record<string, unknown> }>): string[];
}

/** Held local SSE streams exercise real Pi task/tool lifetimes without a live model. */
async function fixture(t: TestContext, capacity = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-room-pause-'));
  const requests: RequestRecord[] = [];
  const toolRequests: HeldRequest[] = [];
  const imageRequests: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith('/held-tool/')) {
      const marker = request.url.slice('/held-tool/'.length);
      const record: HeldRequest = {
        marker,
        response,
        ended: false,
        complete() {
          assert.equal(record.ended, false, 'room pause must not abort an in-progress tool');
          record.ended = true;
          response.end(`finished-${marker}`);
        },
      };
      response.once('close', () => {
        record.ended = true;
      });
      toolRequests.push(record);
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('tool-started\n');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (request.url === '/v1/images/generations') {
      imageRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: [
            {
              b64_json:
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6cAAAAASUVORK5CYII=',
            },
          ],
        }),
      );
      return;
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: RequestRecord['messages'];
    };
    const latest = payload.messages.findLast(
      (message: { role: string }) => message.role === 'user',
    );
    const marker = [...JSON.stringify(latest?.content).matchAll(/PAUSE_[A-Z_]+/g)].at(-1)?.[0];
    assert.ok(marker);
    const requestIndex = requests.length;
    const send = (delta: object, finish: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: `${marker}-${requestIndex}`, object: 'chat.completion.chunk', created: 1, model: 'pause-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    const finish = (reason: string) => {
      send({}, reason);
      record.ended = true;
      response.end('data: [DONE]\n\n');
    };
    const record: RequestRecord = {
      marker,
      messages: payload.messages,
      response,
      ended: false,
      complete() {
        assert.equal(record.ended, false, 'the request must still be connected');
        send({ content: `completed-${marker}` });
        finish('stop');
      },
      tool(name, args) {
        return record.tools([{ name, args }])[0];
      },
      tools(calls) {
        assert.equal(record.ended, false);
        const ids = calls.map((_call, index) => `call_${requestIndex}_${index}`);
        send({
          tool_calls: calls.map(({ name, args }, index) => ({
            index,
            id: ids[index],
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          })),
        });
        finish('tool_calls');
        return ids;
      },
    };
    response.once('close', () => {
      record.ended = true;
    });
    requests.push(record);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    send({ role: 'assistant', content: `partial-${marker} ` });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let instance = await createApp({ dataDir: join(directory, 'data'), scheduler: false });
  t.after(async () => {
    await instance.app.close();
    for (const request of [...requests, ...toolRequests]) request.response.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const configured = await instance.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      model: { baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'pause-fixture' },
      inference: { maxConcurrentRequests: capacity },
      autoLearn: false,
    },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  return {
    get app() {
      return instance.app;
    },
    get controller() {
      return instance.controller;
    },
    get store() {
      return instance.store;
    },
    requests,
    toolRequests,
    imageRequests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    heldCommand(marker: string) {
      assert.match(marker, /^PAUSE_[A-Z_]+$/);
      return `node -e "fetch('http://127.0.0.1:${address.port}/held-tool/${marker}').then(r=>r.text()).then(console.log)"`;
    },
    async toolRequest(marker: string) {
      await until(() => toolRequests.some((item) => item.marker === marker), `tool ${marker}`);
      return toolRequests.find((item) => item.marker === marker)!;
    },
    waitingReason(task: Task) {
      return instance.controller
        .getSnapshot()
        .queue.waitingTasks?.find((item) => item.taskId === task.id)?.reason;
    },
    operations(task: Task) {
      return instance.store
        .list<OperationRecord>('operations')
        .filter((item) => item.taskId === task.id);
    },
    async room(name: string) {
      const response = await instance.app.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: { name, botIds: ['bot_aster', 'bot_nova'], parallelResponses: true },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Room>();
    },
    start(roomId: string, marker: string, botId = 'bot_aster') {
      return instance.controller.enqueueTask({ roomId, botId, prompt: marker });
    },
    async request(marker: string, count = 1) {
      await until(() => requests.filter((item) => item.marker === marker).length >= count, marker);
      return requests.filter((item) => item.marker === marker)[count - 1];
    },
    task(task: Task) {
      return instance.store.get<Task>('tasks', task.id)!;
    },
    async done(task: Task) {
      await until(
        () =>
          ['completed', 'failed', 'stopped'].includes(
            instance.store.get<Task>('tasks', task.id)!.status,
          ),
        `completion of ${task.prompt}`,
      );
      const result = instance.store.get<Task>('tasks', task.id)!;
      assert.equal(result.status, 'completed', result.error);
      return result;
    },
    async pause(room: Room) {
      const response = await instance.app.inject({
        method: 'POST',
        url: `/api/rooms/${room.id}/pause`,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<{ room: Room }>().room.paused, true);
    },
    async resume(room: Room) {
      const response = await instance.app.inject({
        method: 'POST',
        url: `/api/rooms/${room.id}/resume`,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<{ room: Room }>().room.paused, false);
    },
    async restart() {
      await instance.app.close();
      instance = await createApp({ dataDir: join(directory, 'data'), scheduler: false });
    },
  };
}

test(
  'room pause finishes current streams but holds returned tools, queued work and handoffs until resume',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t);
    const room = await f.room('Paused team');
    const other = await f.room('Independent team');
    const first = f.start(room.id, 'PAUSE_FIRST');
    const second = f.start(room.id, 'PAUSE_SECOND', 'bot_nova');
    const [a, b] = await Promise.all([f.request(first.prompt), f.request(second.prompt)]);
    const queued = f.start(room.id, 'PAUSE_QUEUED');
    await until(
      () =>
        f.controller.getSnapshot().queue.waitingTasks?.some((item) => item.taskId === queued.id) ===
        true,
      'queued task',
    );
    await f.pause(room);
    await f.pause(room);
    assert.equal(a.ended, false);
    assert.equal(b.ended, false);
    assert.equal(f.task(first).status, 'running');
    assert.equal(f.task(second).status, 'running');

    const callId = a.tool('send_message', { handle: 'nova', message: 'PAUSE_CHILD' });
    await until(
      () => f.waitingReason(first) === 'paused',
      'first stream reached its tool boundary',
    );
    b.complete();
    await f.done(second);
    assert.equal(f.task(first).completedAt, undefined, 'the tool continuation remains available');
    assert.equal(f.task(queued).status, 'queued');
    assert.equal(
      f.store.list<Task>('tasks').some((task) => task.parentTaskId === first.id),
      false,
      'the returned send_message tool has not created a handoff',
    );
    assert.deepEqual(
      f.controller.getSnapshot().queue.waitingTasks?.map((item) => item.reason),
      ['paused', 'paused'],
    );
    assert.equal(
      f.requests.length,
      2,
      'no next model request or queued task starts as current streams finish',
    );

    const independent = f.start(other.id, 'PAUSE_OTHER');
    (await f.request(independent.prompt)).complete();
    await f.done(independent);
    assert.equal(f.requests.filter((item) => item.marker === first.prompt).length, 1);
    await f.resume(room);
    const followup = await f.request(first.prompt, 2);
    const children = f.store.list<Task>('tasks').filter((task) => task.parentTaskId === first.id);
    assert.equal(children.length, 1, 'resume executes the deferred tool exactly once');
    const child = children[0];
    assert.equal(
      followup.messages.filter((message) => message.tool_call_id === callId).length,
      1,
      'the exact deferred tool result is supplied to the next model turn',
    );
    const c = await f.request(child.prompt);
    followup.complete();
    c.complete();
    await Promise.all([f.done(first), f.done(child)]);
    (await f.request(queued.prompt)).complete();
    await f.done(queued);
  },
);

test('pausing before deferred admission holds user and learning tasks; individual cancellation remains available', async (t) => {
  const f = await fixture(t);
  const room = await f.room('Immediate pause');
  const first = f.start(room.id, 'PAUSE_BEFORE_START');
  f.controller.pauseRoom(room.id); // Before enqueueTask's start microtask can run.
  const learning = f.controller.enqueueTask({
    roomId: room.id,
    botId: 'bot_aster',
    prompt: 'PAUSE_LEARNING',
    parentTaskId: first.id,
    kind: 'learning',
  });
  const response = await f.app.inject({
    method: 'POST',
    url: `/api/rooms/${room.id}/messages`,
    payload: { body: 'PAUSE_MANUAL', botIds: ['bot_nova'] },
  });
  assert.equal(response.statusCode, 200, response.body);
  const manual = response.json<{ tasks: Task[] }>().tasks[0];
  assert.equal(f.requests.length, 0);
  for (const task of [first, learning, manual]) {
    assert.equal(f.task(task).status, 'queued');
    assert.equal(
      f.controller.getSnapshot().queue.waitingTasks?.find((item) => item.taskId === task.id)
        ?.reason,
      'paused',
    );
  }
  const stopped = await f.app.inject({ method: 'POST', url: `/api/tasks/${manual.id}/stop` });
  assert.equal(stopped.statusCode, 200, stopped.body);
  assert.equal(f.task(manual).status, 'stopped');
  assert.equal(f.store.get<Room>('rooms', room.id)?.paused, true);
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/rooms/missing/pause' })).statusCode,
    404,
  );
});

for (const paused of [false, true]) {
  test(
    `immediate task stop cancels deferred admission in a ${paused ? 'paused' : 'running'} room`,
    { timeout: 25_000 },
    async (t) => {
      const f = await fixture(t);
      const room = await f.room('Cancel before admission');
      if (paused) await f.pause(room);
      const task = f.start(room.id, 'PAUSE_CANCELLED');
      const stopping = f.controller.stop(task.id);
      assert.equal(f.task(task).status, 'stopped', 'stop intent is persisted before yielding');
      await stopping;
      assert.equal(f.task(task).startedAt, undefined);
      assert.ok(f.task(task).completedAt);
      assert.equal(
        f.controller.getSnapshot().queue.waitingTasks?.some((item) => item.taskId === task.id),
        false,
      );

      await f.resume(room);
      const following = f.start(room.id, 'PAUSE_FOLLOWING');
      (await f.request(following.prompt)).complete();
      await f.done(following);
      assert.equal(f.task(task).status, 'stopped', 'room resume does not revive a cancelled task');
      assert.equal(f.task(task).startedAt, undefined);
      assert.equal(
        f.requests.some((request) => request.marker === task.prompt),
        false,
      );
      assert.equal(
        f.store.list<{ taskId?: string }>('messages').some((message) => message.taskId === task.id),
        false,
      );

      f.controller.resume(task.id);
      (await f.request(task.prompt)).complete();
      await f.done(task);
      assert.equal(f.requests.filter((request) => request.marker === task.prompt).length, 1);
    },
  );
}

test(
  'room pause and unstarted queue survive shutdown and restart without running before explicit resume',
  { timeout: 25_000 },
  async (t) => {
    const f = await fixture(t);
    const room = await f.room('Persisted pause');
    await f.pause(room);
    const task = f.start(room.id, 'PAUSE_RESTART');
    await until(
      () =>
        f.controller.getSnapshot().queue.waitingTasks?.some((item) => item.taskId === task.id) ===
        true,
      'persisted queued task',
    );
    await f.restart();
    assert.equal(f.store.get<Room>('rooms', room.id)?.paused, true);
    assert.equal(f.task(task).status, 'queued');
    assert.equal(f.requests.length, 0);
    assert.equal(
      f.controller.getSnapshot().queue.waitingTasks?.find((item) => item.taskId === task.id)
        ?.reason,
      'paused',
    );
    await f.resume(room);
    (await f.request(task.prompt)).complete();
    await f.done(task);
  },
);

test(
  'started inference waiters park without occupying capacity needed by another room',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t, 1);
    const room = await f.room('Park model waiters');
    const other = await f.room('Independent inference');
    const first = f.start(room.id, 'PAUSE_ACTIVE_MODEL');
    const a = await f.request(first.prompt);
    const second = f.start(room.id, 'PAUSE_MODEL_WAITER', 'bot_nova');
    await until(() => f.waitingReason(second) === 'inference', 'started inference waiter');
    await f.pause(room);
    await until(() => f.waitingReason(second) === 'paused', 'model waiter parked');
    assert.equal(a.ended, false, 'the current model stream is allowed to finish');
    a.complete();
    await f.done(first);
    const independent = f.start(other.id, 'PAUSE_INDEPENDENT_MODEL');
    (await f.request(independent.prompt)).complete();
    await f.done(independent);
    assert.equal(
      f.requests.some((item) => item.marker === second.prompt),
      false,
    );
    assert.equal(f.task(second).completedAt, undefined);
    assert.equal(f.waitingReason(second), 'paused');
    assert.equal(f.controller.getSnapshot().queue.active, 0);
    await f.resume(room);
    (await f.request(second.prompt)).complete();
    await f.done(second);
    assert.equal(f.requests.filter((item) => item.marker === second.prompt).length, 1);
  },
);

test(
  'approving a pending tool in a paused room does not execute it before room resume',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t, 1);
    const room = await f.room('Hold approved work');
    const other = await f.room('Independent work');
    const first = f.start(room.id, 'PAUSE_APPROVAL');
    const a = await f.request(first.prompt);
    a.tool('write_file', { path: 'approved.txt', content: 'Written after room resume.' });
    await until(
      () =>
        f.store
          .list<Approval>('approvals')
          .some((item) => item.taskId === first.id && item.status === 'pending'),
      'approval requested before pause',
    );
    const approval = f.store.list<Approval>('approvals').find((item) => item.taskId === first.id)!;
    await f.pause(room);
    await until(() => f.waitingReason(first) === 'paused', 'approval waiter releases its worker');
    assert.equal(f.store.get<Approval>('approvals', approval.id)?.status, 'pending');
    const approved = await f.app.inject({
      method: 'POST',
      url: `/api/approvals/${approval.id}`,
      payload: { decision: 'approve' },
    });
    assert.equal(approved.statusCode, 200, approved.body);
    const independent = f.start(other.id, 'PAUSE_APPROVAL_OTHER');
    (await f.request(independent.prompt)).complete();
    await f.done(independent);
    assert.equal(f.store.get<Approval>('approvals', approval.id)?.status, 'approved');
    await assert.rejects(readFile(join(f.task(first).workspacePath!, 'approved.txt')), {
      code: 'ENOENT',
    });
    assert.equal(f.operations(first).length, 0, 'no side effect starts while paused');
    assert.equal(f.requests.filter((item) => item.marker === first.prompt).length, 1);
    await f.resume(room);
    const followup = await f.request(first.prompt, 2);
    assert.equal(
      await readFile(join(f.task(first).workspacePath!, 'approved.txt'), 'utf8'),
      'Written after room resume.',
    );
    assert.equal(
      f.store.list<Approval>('approvals').filter((item) => item.taskId === first.id).length,
      1,
    );
    followup.complete();
    await f.done(first);
    assert.equal(f.operations(first).length, 1);
    assert.equal(f.operations(first)[0].status, 'completed');
  },
);

for (const secondTool of [false, true]) {
  test(
    `an in-progress tool finishes before pausing the ${secondTool ? 'next tool in the same response' : 'next model turn'}, and resume keeps its exact result`,
    { timeout: 35_000 },
    async (t) => {
      const f = await fixture(t, 1);
      const configured = await f.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { permissions: { shell: 'allow', fileWrite: 'allow', network: 'allow' } },
      });
      assert.equal(configured.statusCode, 200, configured.body);
      const room = await f.room('Pause between actions');
      const other = await f.room('Other actions');
      const first = f.start(room.id, 'PAUSE_HELD_TOOL');
      const a = await f.request(first.prompt);
      const commandArgs = { command: f.heldCommand(first.prompt), timeoutSeconds: 20 };
      const calls = a.tools([
        { name: 'run_command', args: commandArgs },
        ...(secondTool
          ? [
              {
                name: 'write_file',
                args: { path: 'next-tool.txt', content: 'The deferred second tool.' },
              },
            ]
          : []),
      ]);
      const held = await f.toolRequest(first.prompt);
      assert.equal(f.operations(first)[0]?.status, 'started');
      await f.pause(room);
      assert.equal(held.ended, false);
      assert.notEqual(f.waitingReason(first), 'paused', 'current tool must finish before parking');
      held.complete();
      await until(() => f.waitingReason(first) === 'paused', 'tool finished at the next boundary');
      const completed = f.operations(first);
      assert.equal(completed.length, 1, 'the second action has not started');
      assert.equal(completed[0].toolName, 'run_command');
      assert.equal(completed[0].status, 'completed');
      assert.match(completed[0].result || '', /finished-PAUSE_HELD_TOOL/);
      await assert.rejects(readFile(join(f.task(first).workspacePath!, 'next-tool.txt')), {
        code: 'ENOENT',
      });
      const independent = f.start(other.id, 'PAUSE_TOOL_OTHER');
      (await f.request(independent.prompt)).complete();
      await f.done(independent);
      assert.equal(f.requests.filter((item) => item.marker === first.prompt).length, 1);
      assert.equal(f.toolRequests.length, 1, 'the command has made one request');
      assert.equal(f.task(first).completedAt, undefined);
      await f.resume(room);
      const followup = await f.request(first.prompt, 2);
      const result = followup.messages.filter((message) => message.tool_call_id === calls[0]);
      assert.equal(result.length, 1, 'Pi retains the completed tool result exactly once');
      assert.match(JSON.stringify(result[0].content), /finished-PAUSE_HELD_TOOL/);
      if (secondTool) {
        assert.equal(
          await readFile(join(f.task(first).workspacePath!, 'next-tool.txt'), 'utf8'),
          'The deferred second tool.',
        );
        assert.equal(
          followup.messages.filter((message) => message.tool_call_id === calls[1]).length,
          1,
        );
      }
      followup.complete();
      await f.done(first);
      assert.equal(f.toolRequests.length, 1, 'resume never repeats the finished command');
      assert.deepEqual(
        f.operations(first).find((item) => item.toolName === 'run_command'),
        completed[0],
        'resume does not replace or replay the completed operation receipt',
      );
      assert.equal(f.operations(first).length, secondTool ? 2 : 1);
    },
  );
}

test(
  'an individually stopped continuation never executes its deferred tool when the room resumes',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t, 1);
    const configured = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { permissions: { fileWrite: 'allow' } },
    });
    assert.equal(configured.statusCode, 200, configured.body);
    const room = await f.room('Cancel suspended work');
    const first = f.start(room.id, 'PAUSE_CANCEL_CONTINUATION');
    const a = await f.request(first.prompt);
    await f.pause(room);
    a.tool('write_file', { path: 'cancelled.txt', content: 'This must never be written.' });
    await until(() => f.waitingReason(first) === 'paused', 'deferred tool parked');
    const stopped = await f.app.inject({ method: 'POST', url: `/api/tasks/${first.id}/stop` });
    assert.equal(stopped.statusCode, 200, stopped.body);
    assert.equal(f.task(first).status, 'stopped');
    assert.equal(f.waitingReason(first), undefined);
    await f.resume(room);
    const following = f.start(room.id, 'PAUSE_AFTER_CANCEL');
    (await f.request(following.prompt)).complete();
    await f.done(following);
    assert.equal(f.task(first).status, 'stopped');
    assert.equal(f.operations(first).length, 0);
    assert.equal(f.requests.filter((item) => item.marker === first.prompt).length, 1);
    await assert.rejects(readFile(join(f.task(first).workspacePath!, 'cancelled.txt')), {
      code: 'ENOENT',
    });
  },
);

for (const restart of [false, true]) {
  test(
    `update preparation recovers a paused multi-tool task ${restart ? 'after restart' : 'after updater rejection'} ahead of later queued work without repeating completed actions`,
    { timeout: 35_000 },
    async (t) => {
      const f = await fixture(t, 1);
      const configured = await f.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { permissions: { shell: 'allow', fileWrite: 'allow', network: 'allow' } },
      });
      assert.equal(configured.statusCode, 200, configured.body);
      const room = await f.room('Update a paused continuation');
      const first = f.start(room.id, 'PAUSE_UPDATE_MULTI');
      const initial = await f.request(first.prompt);
      const following = f.start(room.id, 'PAUSE_UPDATE_FOLLOWING');
      const commandArgs = { command: f.heldCommand(first.prompt), timeoutSeconds: 20 };
      const writeArgs = { path: 'after-update.txt', content: 'The pending action after update.' };
      const calls = initial.tools([
        { name: 'run_command', args: commandArgs },
        { name: 'write_file', args: writeArgs },
      ]);
      const held = await f.toolRequest(first.prompt);
      await f.pause(room);
      assert.equal(f.controller.runtime!.isTaskSuspended!(first.id), false);
      f.controller.maintenance = true;
      await assert.rejects(f.controller.runtime!.prepareForUpdate!(), {
        code: 'update_busy',
        statusCode: 409,
      });
      assert.equal(held.ended, false, 'an update refusal must not abort the current tool');
      held.complete();
      await until(() => f.waitingReason(first) === 'paused', 'completed tool checkpoint');
      assert.equal(f.controller.runtime!.isTaskSuspended!(first.id), true);
      const receipt = f.operations(first)[0];
      assert.equal(receipt.status, 'completed');

      await f.controller.runtime!.prepareForUpdate!();
      assert.equal(f.task(first).status, 'queued');
      assert.equal(f.task(first).error, undefined);
      assert.equal(f.task(first).completedAt, undefined);
      assert.ok(
        f.task(first).startedAt,
        'the recovery task retains its previous execution identity',
      );
      assert.equal(f.task(following).status, 'queued');
      assert.equal(f.waitingReason(first), 'paused');
      assert.equal(f.controller.runtime!.isTaskSuspended!(first.id), false);
      assert.equal(f.store.get<Room>('rooms', room.id)?.paused, true);
      assert.deepEqual(f.operations(first)[0], receipt);
      assert.equal(f.requests.length, 1);
      await assert.rejects(readFile(join(f.task(first).workspacePath!, writeArgs.path)), {
        code: 'ENOENT',
      });
      assert.ok(
        f.store
          .list<{ taskId: string; title: string; status: string }>('activities')
          .some(
            (activity) =>
              activity.taskId === first.id &&
              activity.title === 'Paused for application update' &&
              activity.status === 'success',
          ),
      );
      if (restart) await f.restart();
      else {
        // A definite launcher rejection leaves the same runtime usable. A
        // second update preparation must not duplicate the held task.
        await f.controller.runtime!.prepareForUpdate!();
        f.controller.maintenance = false;
      }
      assert.equal(f.task(first).status, 'queued');
      assert.equal(f.store.get<Room>('rooms', room.id)?.paused, true);
      assert.equal(f.requests.length, 1, 'updating must not resume the paused room');
      await f.resume(room);
      const recovered = await f.request(first.prompt, 2);
      assert.equal(
        f.requests.some((request) => request.marker === following.prompt),
        false,
        'the started continuation runs before its later queued request',
      );
      assert.match(
        JSON.stringify(recovered.messages.at(-1)?.content),
        /resuming from saved conversation/,
      );
      const completed = recovered.messages.filter((message) => message.tool_call_id === calls[0]);
      assert.equal(completed.length, 1);
      assert.match(JSON.stringify(completed[0].content), /finished-PAUSE_UPDATE_MULTI/);
      recovered.tools([
        { name: 'run_command', args: commandArgs },
        { name: 'write_file', args: writeArgs },
      ]);
      const result = await f.request(first.prompt, 3);
      assert.equal(
        await readFile(join(f.task(first).workspacePath!, writeArgs.path), 'utf8'),
        writeArgs.content,
      );
      assert.equal(f.toolRequests.length, 1, 'recovery never repeats the completed command');
      assert.deepEqual(
        f.operations(first).find((operation) => operation.toolName === 'run_command'),
        receipt,
      );
      assert.equal(f.operations(first).length, 2);
      result.complete();
      await f.done(first);
      (await f.request(following.prompt)).complete();
      await f.done(following);
    },
  );
}

test(
  'update preparation refuses a draining model before cancelling any already parked teammate',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t);
    const configured = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { permissions: { fileWrite: 'allow' } },
    });
    assert.equal(configured.statusCode, 200, configured.body);
    const room = await f.room('One parked and one draining bot');
    const parked = f.start(room.id, 'PAUSE_UPDATE_PARKED');
    const draining = f.start(room.id, 'PAUSE_UPDATE_DRAINING', 'bot_nova');
    const [a, b] = await Promise.all([f.request(parked.prompt), f.request(draining.prompt)]);
    await f.pause(room);
    a.tool('write_file', { path: 'after-refusal.txt', content: 'The live continuation survived.' });
    await until(() => f.waitingReason(parked) === 'paused', 'one bot parked');
    f.controller.maintenance = true;
    await assert.rejects(f.controller.runtime!.prepareForUpdate!(), {
      code: 'update_busy',
      statusCode: 409,
    });
    assert.equal(b.ended, false);
    assert.equal(f.controller.runtime!.isTaskSuspended!(parked.id), true);
    assert.equal(f.task(parked).completedAt, undefined);
    assert.equal(f.task(draining).status, 'running');
    f.controller.maintenance = false;
    b.complete();
    await f.done(draining);
    await f.resume(room);
    const followup = await f.request(parked.prompt, 2);
    assert.equal(
      await readFile(join(f.task(parked).workspacePath!, 'after-refusal.txt'), 'utf8'),
      'The live continuation survived.',
    );
    followup.complete();
    await f.done(parked);
  },
);

test(
  'a paused pending approval is cancelled for update and requested anew after restart',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t, 1);
    const room = await f.room('Approval checkpoint');
    const first = f.start(room.id, 'PAUSE_UPDATE_APPROVAL');
    const args = {
      path: 'approved-after-update.txt',
      content: 'Only a new approval can write this.',
    };
    (await f.request(first.prompt)).tool('write_file', args);
    await until(
      () =>
        f.store
          .list<Approval>('approvals')
          .some((approval) => approval.taskId === first.id && approval.status === 'pending'),
      'initial approval',
    );
    const approval = f.store.list<Approval>('approvals').find((item) => item.taskId === first.id)!;
    await f.pause(room);
    await until(() => f.waitingReason(first) === 'paused', 'approval parked');
    f.controller.maintenance = true;
    await f.controller.runtime!.prepareForUpdate!();
    assert.equal(f.store.get<Approval>('approvals', approval.id)?.status, 'cancelled');
    assert.equal(f.task(first).status, 'queued');
    assert.equal(f.operations(first).length, 0);
    await f.restart();
    assert.equal(f.requests.length, 1);
    await f.resume(room);
    (await f.request(first.prompt, 2)).tool('write_file', args);
    await until(
      () =>
        f.store
          .list<Approval>('approvals')
          .some((item) => item.taskId === first.id && item.status === 'pending'),
      'new approval',
    );
    const renewed = f.store
      .list<Approval>('approvals')
      .find((item) => item.taskId === first.id && item.status === 'pending')!;
    assert.notEqual(renewed.id, approval.id);
    await assert.rejects(readFile(join(f.task(first).workspacePath!, args.path)), {
      code: 'ENOENT',
    });
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/approvals/${approval.id}`,
          payload: { decision: 'approve' },
        })
      ).statusCode,
      409,
    );
    const accepted = await f.app.inject({
      method: 'POST',
      url: `/api/approvals/${renewed.id}`,
      payload: { decision: 'approve' },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const followup = await f.request(first.prompt, 3);
    assert.equal(
      await readFile(join(f.task(first).workspacePath!, args.path), 'utf8'),
      args.content,
    );
    followup.complete();
    await f.done(first);
    assert.equal(f.operations(first).length, 1);
  },
);

test(
  'an explicit task stop during update preparation prevents that task from being requeued',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t, 1);
    const room = await f.room('Stop wins over update recovery');
    const first = f.start(room.id, 'PAUSE_UPDATE_CANCEL');
    const request = await f.request(first.prompt);
    await f.pause(room);
    request.tool('write_file', {
      path: 'never-after-update.txt',
      content: 'Cancelled by the owner.',
    });
    await until(() => f.waitingReason(first) === 'paused', 'task parked before update');
    f.controller.maintenance = true;
    const preparing = f.controller.runtime!.prepareForUpdate!();
    const stopping = f.controller.stop(first.id);
    await Promise.all([preparing, stopping]);
    assert.equal(f.task(first).status, 'stopped');
    assert.equal(f.waitingReason(first), undefined);
    f.controller.maintenance = false;
    await f.resume(room);
    const following = f.start(room.id, 'PAUSE_UPDATE_CANCEL_FOLLOWING');
    (await f.request(following.prompt)).complete();
    await f.done(following);
    assert.equal(f.requests.filter((item) => item.marker === first.prompt).length, 1);
    assert.equal(f.operations(first).length, 0);
    await assert.rejects(readFile(join(f.task(first).workspacePath!, 'never-after-update.txt')), {
      code: 'ENOENT',
    });
  },
);

test(
  'an explicit stop after task cleanup wins while another paused task is still settling for update',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t);
    const room = await f.room('Stop a checkpoint after its worker has exited');
    const first = f.start(room.id, 'PAUSE_UPDATE_SETTLED_STOP');
    const second = f.start(room.id, 'PAUSE_UPDATE_HELD_CLEANUP', 'bot_nova');
    const [a, b] = await Promise.all([f.request(first.prompt), f.request(second.prompt)]);
    let releaseApproval!: () => void;
    const approvalReleased = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    // Hold only cancellation cleanup after the real controller has cancelled
    // the second approval. Both jobs still use real Pi task/tool lifetimes.
    const requestApproval = f.controller.requestApproval.bind(f.controller);
    t.mock.method(
      f.controller,
      'requestApproval',
      async (...args: Parameters<typeof requestApproval>) => {
        const result = await requestApproval(...args);
        if (args[0].taskId === second.id) await approvalReleased;
        return result;
      },
    );
    const secondArgs = { path: 'second-after-update.txt', content: 'After explicit resume.' };
    b.tool('write_file', secondArgs);
    await until(
      () =>
        f.store
          .list<Approval>('approvals')
          .some((item) => item.taskId === second.id && item.status === 'pending'),
      'second task approval',
    );
    await f.pause(room);
    a.tool('write_file', { path: 'never-after-cleanup.txt', content: 'Owner cancelled this.' });
    await until(
      () => f.waitingReason(first) === 'paused' && f.waitingReason(second) === 'paused',
      'both update checkpoints',
    );
    let firstCleaned!: () => void;
    const firstCleanup = new Promise<void>((resolve) => {
      firstCleaned = resolve;
    });
    const releaseTask = f.controller.browser!.releaseTask.bind(f.controller.browser!);
    t.mock.method(f.controller.browser!, 'releaseTask', (taskId: string) => {
      releaseTask(taskId);
      if (taskId === first.id && f.task(first).status === 'stopped')
        // run().finally removes the running job synchronously after this hook.
        queueMicrotask(firstCleaned);
    });
    f.controller.maintenance = true;
    let prepared = false;
    const preparing = f.controller.runtime!.prepareForUpdate!().then(() => {
      prepared = true;
    });
    try {
      await firstCleanup;
      assert.equal(prepared, false, 'the second task keeps preparation open');
      assert.equal(f.task(first).status, 'stopped');
      assert.equal(f.waitingReason(first), undefined, 'the first worker has exited');
      assert.equal(f.controller.runtime!.isTaskSuspended!(first.id), false);
      await f.controller.stop(first.id);
      assert.equal(prepared, false, 'stopping the settled task does not wait for its teammate');
    } finally {
      releaseApproval();
    }
    await preparing;
    assert.equal(f.task(first).status, 'stopped');
    assert.equal(f.task(second).status, 'queued');
    f.controller.maintenance = false;
    await f.resume(room);
    (await f.request(second.prompt, 2)).complete();
    await f.done(second);
    assert.equal(f.task(first).status, 'stopped');
    assert.equal(f.requests.filter((item) => item.marker === first.prompt).length, 1);
    assert.equal(f.operations(first).length, 0);
    await assert.rejects(readFile(join(f.task(first).workspacePath!, 'never-after-cleanup.txt')), {
      code: 'ENOENT',
    });
  },
);

test(
  'update recovery retains a failed image-operation journal instead of assuming a parked request was never dispatched',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t, 1);
    const configured = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        permissions: { network: 'allow' },
        images: { enabled: true, baseUrl: f.baseUrl, modelId: 'pause-image-fixture' },
      },
    });
    assert.equal(configured.statusCode, 200, configured.body);
    const room = await f.room('Queued image checkpoint');
    const other = await f.room('Inference occupant');
    const first = f.start(room.id, 'PAUSE_UPDATE_IMAGE');
    const initial = await f.request(first.prompt);
    const occupant = f.start(other.id, 'PAUSE_UPDATE_IMAGE_OCCUPANT');
    await until(
      () => f.waitingReason(occupant) === 'inference',
      'second model waiting for capacity',
    );
    const args = { prompt: 'A simple blue square.' };
    initial.tool('generate_image', args);
    const held = await f.request(occupant.prompt);
    await until(
      () =>
        f.operations(first)[0]?.status === 'started' && f.task(first).status === 'waiting_model',
      'image operation waiting locally',
    );
    assert.equal(f.imageRequests.length, 0);
    await f.pause(room);
    await until(() => f.waitingReason(first) === 'paused', 'image wait parked');
    held.complete();
    await f.done(occupant);
    f.controller.maintenance = true;
    await f.controller.runtime!.prepareForUpdate!();
    const failure = f.operations(first)[0];
    assert.equal(failure.status, 'failed');
    assert.equal(f.imageRequests.length, 0);
    await f.restart();
    await f.resume(room);
    (await f.request(first.prompt, 2)).tool('generate_image', args);
    const followup = await f.request(first.prompt, 3);
    assert.match(JSON.stringify(followup.messages), /uncertain or failed prior outcome/);
    assert.deepEqual(f.operations(first)[0], failure);
    assert.equal(
      f.imageRequests.length,
      0,
      'recovery must not reset the journal to permit another POST',
    );
    followup.complete();
    await f.done(first);
  },
);
