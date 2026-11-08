import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { Approval, Room, Task } from '../src/shared/types.js';
import { createApp } from '../src/server/app.js';
import type { OperationRecord } from '../src/server/runtime/contract.js';
import { taskInterruptionMessage } from '../src/shared/task-interruption.js';

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
  declaredTools: Array<{
    function: {
      name: string;
      parameters?: {
        properties?: Record<string, { type?: string; minimum?: number; maximum?: number }>;
        required?: string[];
      };
    };
  }>;
  tool(name: string, args: Record<string, unknown>): string;
  tools(calls: Array<{ name: string; args: Record<string, unknown> }>): string[];
}

/** Held local SSE streams exercise real Pi task/tool lifetimes without a live model. */
async function fixture(t: TestContext, capacity = 2, holdImages = false) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-room-pause-'));
  const requests: RequestRecord[] = [];
  const toolRequests: HeldRequest[] = [];
  const imageRequests: unknown[] = [];
  const imageHeaders: Array<{ authorization?: string }> = [];
  const imageResponses: HeldRequest[] = [];
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
      imageHeaders.push({ authorization: request.headers.authorization });
      response.writeHead(200, { 'content-type': 'application/json' });
      const record: HeldRequest = {
        marker: `image-${imageRequests.length}`,
        response,
        ended: false,
        complete() {
          assert.equal(record.ended, false, 'room pause must not abort an issued image request');
          record.ended = true;
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
        },
      };
      response.once('close', () => {
        record.ended = true;
      });
      imageResponses.push(record);
      if (!holdImages) record.complete();
      return;
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: RequestRecord['messages'];
      tools?: RequestRecord['declaredTools'];
    };
    // Vision adapters may append a user-role image block after the task prompt.
    const marker = payload.messages
      .filter((message) => message.role === 'user')
      .flatMap((message) => [...JSON.stringify(message.content).matchAll(/PAUSE_[A-Z_]+/g)])
      .at(-1)?.[0];
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
      declaredTools: payload.tools ?? [],
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
    for (const request of [...requests, ...toolRequests, ...imageResponses])
      request.response.destroy();
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
    imageHeaders,
    imageResponses,
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
    assert.equal(f.task(first).error, taskInterruptionMessage('owner_stop'));
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
      assert.equal(f.task(first).error, taskInterruptionMessage('owner_stop'));
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
        images: {
          enabled: true,
          baseUrl: f.baseUrl,
          modelId: 'pause-image-fixture',
          shareInferenceSlot: true,
        },
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

test(
  'paused image-input changes refresh an already queued model request and retain executable vision tools',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t, 1);
    const initialSettings = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { model: { imageInput: false } },
    });
    assert.equal(initialSettings.statusCode, 200, initialSettings.body);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6cAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(join(f.store.settings().workspacePath, 'paused-vision.png'), png);
    const room = await f.room('Mutable image input');
    const other = await f.room('Inference occupant');
    const occupant = f.start(other.id, 'PAUSE_VISION_OCCUPANT');
    const held = await f.request(occupant.prompt);
    const first = f.start(room.id, 'PAUSE_VISION_ENABLE');
    await until(() => f.waitingReason(first) === 'inference', 'captured text-only model request');
    const startedAt = f.task(first).startedAt;
    await f.pause(room);
    await until(() => f.waitingReason(first) === 'paused', 'text-only request parked');
    held.complete();
    await f.done(occupant);
    const enabled = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { model: { imageInput: true } },
    });
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.equal(f.waitingReason(first), 'paused');
    await f.resume(room);
    const visible = await f.request(first.prompt);
    assert.ok(visible.declaredTools.some((tool) => tool.function.name === 'view_image'));
    assert.match(JSON.stringify(visible.messages), /Image input is enabled/);
    assert.doesNotMatch(JSON.stringify(visible.messages), /Image input is disabled/);
    visible.tool('view_image', { path: 'paused-vision.png' });
    const pixels = await f.request(first.prompt, 2);
    assert.match(JSON.stringify(pixels.messages), /data:image\/png;base64,/);
    assert.match(JSON.stringify(pixels.messages), /Image loaded for visual inspection/);

    // Let another room take the next slot so this request is already built from
    // pixel-bearing history before disabling vision at its paused boundary.
    const secondOccupant = f.start(other.id, 'PAUSE_VISION_SECOND_OCCUPANT');
    await until(() => f.waitingReason(secondOccupant) === 'inference', 'next inference occupant');
    pixels.tool('room_context', {});
    const secondHeld = await f.request(secondOccupant.prompt);
    await until(() => f.waitingReason(first) === 'inference', 'pixel-bearing request queued');
    await f.pause(room);
    await until(() => f.waitingReason(first) === 'paused', 'pixel-bearing request parked');
    secondHeld.complete();
    await f.done(secondOccupant);
    const disabled = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { model: { imageInput: false } },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(f.waitingReason(first), 'paused');
    await f.resume(room);
    const hidden = await f.request(first.prompt, 3);
    assert.equal(
      hidden.declaredTools.some((tool) => tool.function.name === 'view_image'),
      false,
    );
    assert.match(JSON.stringify(hidden.messages), /Image input is disabled/);
    assert.doesNotMatch(JSON.stringify(hidden.messages), /data:image|image_url/);
    assert.equal(f.task(first).startedAt, startedAt, 'the held execution was never restarted');
    assert.deepEqual(f.operations(first), []);
    hidden.tool('view_image', { path: 'paused-vision.png' });
    const denied = await f.request(first.prompt, 4);
    assert.match(JSON.stringify(denied.messages), /Image input is disabled/);
    assert.doesNotMatch(JSON.stringify(denied.messages), /data:image|image_url/);
    denied.complete();
    await f.done(first);
  },
);

test(
  'a paused image request switches from shared to parallel without failing or replacing its receipt',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t, 1);
    const configured = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        permissions: { network: 'allow' },
        images: {
          enabled: true,
          baseUrl: f.baseUrl,
          modelId: 'pause-image-fixture',
          shareInferenceSlot: true,
        },
      },
    });
    assert.equal(configured.statusCode, 200, configured.body);
    const room = await f.room('Share image capacity');
    const other = await f.room('Inference occupant');
    const first = f.start(room.id, 'PAUSE_IMAGE_PARALLEL');
    const initial = await f.request(first.prompt);
    const occupant = f.start(other.id, 'PAUSE_IMAGE_SHARED_OCCUPANT');
    await until(() => f.waitingReason(occupant) === 'inference', 'queued inference occupant');
    initial.tool('generate_image', { prompt: 'A simple blue square.' });
    const held = await f.request(occupant.prompt);
    await until(
      () =>
        f.operations(first)[0]?.status === 'started' && f.task(first).status === 'waiting_model',
      'image waiting for shared capacity',
    );
    const operation = f.operations(first)[0];
    await f.pause(room);
    await until(() => f.waitingReason(first) === 'paused', 'shared image request parked');
    held.complete();
    await f.done(occupant);
    const changed = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { images: { shareInferenceSlot: false } },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.deepEqual(
      f.operations(first)[0],
      operation,
      'saving settings leaves its receipt pending',
    );
    const parallelOccupant = f.start(other.id, 'PAUSE_IMAGE_PARALLEL_OCCUPANT');
    const parallelHeld = await f.request(parallelOccupant.prompt);
    await f.resume(room);
    await until(() => f.operations(first)[0]?.status === 'completed', 'parallel image completion');
    assert.equal(
      parallelHeld.ended,
      false,
      'image generation may finish while the LLM is occupied',
    );
    assert.equal(f.imageRequests.length, 1);
    assert.equal(f.operations(first).length, 1);
    assert.equal(f.operations(first)[0].key, operation.key);
    assert.deepEqual(f.operations(first)[0].args, operation.args);
    parallelHeld.complete();
    await f.done(parallelOccupant);
    (await f.request(first.prompt, 2)).complete();
    await f.done(first);
  },
);

test(
  'a paused parallel image request honors newly shared capacity when the image queue resumes',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t, 1, true);
    const configured = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        permissions: { network: 'allow' },
        images: {
          enabled: true,
          baseUrl: f.baseUrl,
          modelId: 'pause-image-fixture',
          shareInferenceSlot: false,
        },
      },
    });
    assert.equal(configured.statusCode, 200, configured.body);
    const blockerRoom = await f.room('Image queue occupant');
    const room = await f.room('Image queue wait');
    const other = await f.room('Inference occupant');
    const blocker = f.start(blockerRoom.id, 'PAUSE_IMAGE_QUEUE_OCCUPANT');
    (await f.request(blocker.prompt)).tool('generate_image', { prompt: 'A red square.' });
    await until(() => f.imageRequests.length === 1, 'issued image request');
    const first = f.start(room.id, 'PAUSE_IMAGE_RESHARE');
    (await f.request(first.prompt)).tool('generate_image', { prompt: 'A blue square.' });
    await until(() => f.operations(first)[0]?.status === 'started', 'image queued behind occupant');
    const operation = f.operations(first)[0];
    await f.pause(room);
    await until(() => f.waitingReason(first) === 'paused', 'parallel image request parked');
    await f.pause(blockerRoom);
    f.imageResponses[0].complete();
    await until(() => f.waitingReason(blocker) === 'paused', 'completed image continuation parked');
    const completed = f.operations(blocker)[0];
    assert.equal(completed.status, 'completed');
    const changed = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { images: { shareInferenceSlot: true } },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.deepEqual(f.operations(first)[0], operation);
    assert.deepEqual(f.operations(blocker)[0], completed);
    const occupant = f.start(other.id, 'PAUSE_IMAGE_RESHARE_OCCUPANT');
    const held = await f.request(occupant.prompt);
    await f.resume(room);
    await until(() => f.waitingReason(first) === 'inference', 'image now obeys shared capacity');
    assert.equal(f.imageRequests.length, 1, 'the queued image must wait for the language model');
    held.complete();
    await f.done(occupant);
    await until(() => f.imageResponses.length === 2, 'newly shared image admitted');
    f.imageResponses[1].complete();
    (await f.request(first.prompt, 2)).complete();
    await f.done(first);
    assert.equal(f.operations(first).length, 1);
    assert.equal(f.operations(first)[0].key, operation.key);
    assert.equal(f.operations(first)[0].status, 'completed');
    await f.controller.stop(blocker.id);
    assert.equal(f.task(blocker).status, 'stopped');
    assert.deepEqual(
      f.operations(blocker)[0],
      completed,
      'an explicit stop preserves the saved image',
    );
    assert.equal(f.imageRequests.length, 2);
  },
);

test(
  'a not-yet-started image tool uses all settings saved at its paused boundary',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t);
    const room = await f.room('Enable images while paused');
    const task = f.start(room.id, 'PAUSE_ENABLE_IMAGE_CONFIG');
    const initial = await f.request(task.prompt);
    await f.pause(room);
    initial.tool('generate_image', { prompt: 'A green circle.' });
    await until(() => f.waitingReason(task) === 'paused', 'image tool has not begun');
    assert.deepEqual(f.operations(task), []);
    const configured = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        permissions: { network: 'allow' },
        images: {
          enabled: true,
          baseUrl: f.baseUrl,
          modelId: 'enabled-while-paused',
          apiKey: 'newly-enabled-image-key',
          size: '1536x1024',
          responseFormat: 'b64_json',
          timeoutSeconds: 149,
          shareInferenceSlot: false,
        },
      },
    });
    assert.equal(configured.statusCode, 200, configured.body);
    assert.equal(f.imageRequests.length, 0);
    await f.resume(room);
    const followup = await f.request(task.prompt, 2);
    assert.deepEqual(f.imageRequests, [
      {
        model: 'enabled-while-paused',
        prompt: 'A green circle.',
        n: 1,
        size: '1536x1024',
        response_format: 'b64_json',
      },
    ]);
    assert.equal(f.imageHeaders[0].authorization, 'Bearer newly-enabled-image-key');
    assert.equal(f.operations(task)[0].status, 'completed');
    followup.complete();
    await f.done(task);
  },
);

for (const permission of ['allow', 'ask'] as const) {
  test(
    `Pi rejects invalid image steps before normalization with ${permission} permission`,
    { timeout: 35_000 },
    async (t) => {
      const f = await fixture(t);
      const configured = await f.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: {
          permissions: { network: 'allow' },
          images: {
            enabled: true,
            baseUrl: f.baseUrl,
            modelId: 'strict-image-steps',
            steps: 40,
            stepsParameter: 'sd_cpp_extra_args',
            permission,
          },
        },
      });
      assert.equal(configured.statusCode, 200, configured.body);
      const room = await f.room('Strict image steps');
      const task = f.start(room.id, `PAUSE_IMAGE_INVALID_STEPS_${permission.toUpperCase()}`);
      const initial = await f.request(task.prompt);
      const callIds = initial.tools(
        [null, '17', true, 1.5, 0, 1001].map((steps, index) => ({
          name: 'generate_image',
          args: { prompt: `A blue square, example ${index}.`, steps },
        })),
      );
      await until(
        () =>
          f.requests.filter((request) => request.marker === task.prompt).length === 2 ||
          f.imageRequests.length > 0 ||
          f.store.list<Approval>('approvals').length > 0,
        'invalid image arguments rejected before approval or dispatch',
      );
      assert.deepEqual(f.imageRequests, [], 'Invalid counts must never reach the image server');
      assert.deepEqual(f.store.list<Approval>('approvals'), []);
      assert.deepEqual(f.operations(task), []);
      const followup = await f.request(task.prompt, 2);
      for (const callId of callIds) {
        const result = followup.messages.find(
          (message) => message.role === 'tool' && message.tool_call_id === callId,
        );
        assert.ok(result, 'Each invalid call returns an error to the model');
        assert.match(
          JSON.stringify(result.content),
          /Image sampling steps must be an integer from 1 to 1000\. Omit steps/,
        );
      }
      assert.equal(f.store.settings().images!.steps, 40);
      followup.complete();
      await f.done(task);
    },
  );
}

for (const [waiting, override] of [
  ['queue', false],
  ['approval', false],
  ['queue', true],
  ['approval', true],
] as const) {
  test(
    `an image already waiting for ${waiting}${override ? ' with per-call steps' : ''} retains its reviewed configuration and key while the next call uses saved changes`,
    { timeout: 35_000 },
    async (t) => {
      const f = await fixture(t, 1);
      const nextProvider = await fixture(t);
      const deadlines: number[] = [];
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
        deadlines.push(milliseconds);
        return timeout(milliseconds);
      });
      const oldKey = waiting === 'queue' ? 'retained-original-image-key' : '';
      const newKey = 'saved-replacement-image-key';
      const configured = await f.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: {
          permissions: { network: 'allow' },
          images: {
            enabled: true,
            baseUrl: f.baseUrl,
            modelId: 'original-image-model',
            apiKey: oldKey,
            size: '1024x1536',
            steps: 40,
            stepsParameter: 'sd_cpp_extra_args',
            responseFormat: 'auto',
            timeoutSeconds: 73,
            shareInferenceSlot: waiting === 'queue',
            permission: waiting === 'approval' ? 'ask' : 'allow',
          },
        },
      });
      assert.equal(configured.statusCode, 200, configured.body);
      const room = await f.room('Pinned image request');
      const task = f.start(room.id, `PAUSE_IMAGE_PIN_${waiting.toUpperCase()}`);
      const initial = await f.request(task.prompt);
      if (override) {
        const imageTool = initial.declaredTools.find(
          (tool) => tool.function.name === 'generate_image',
        );
        const parameters = imageTool?.function.parameters;
        const stepSchema = parameters?.properties?.steps;
        assert.ok(stepSchema, 'The actual model request declares a per-call steps argument');
        assert.equal(stepSchema.type, 'integer');
        assert.equal(stepSchema.minimum, 1);
        assert.equal(stepSchema.maximum, 1000);
        assert.equal(parameters?.required?.includes('steps') ?? false, false);
      }
      let occupant: Task | undefined;
      let held: RequestRecord | undefined;
      if (waiting === 'queue') {
        const other = await f.room('Image configuration text occupant');
        occupant = f.start(other.id, 'PAUSE_IMAGE_CONFIG_OCCUPANT');
        await until(() => f.waitingReason(occupant!) === 'inference', 'queued text occupant');
      }
      const originalSteps = override ? 12 : 40;
      const nextSteps = override ? 7 : 20;
      const args = {
        prompt: 'A blue square with a white border.',
        ...(override ? { steps: originalSteps } : {}),
      };
      initial.tool('generate_image', args);
      if (occupant) {
        held = await f.request(occupant.prompt);
        await until(
          () =>
            f.operations(task)[0]?.status === 'started' && f.task(task).status === 'waiting_model',
          'prepared image waiting for capacity',
        );
      } else {
        await until(
          () => f.store.list<Approval>('approvals').some((item) => item.status === 'pending'),
          'review of the original image request',
        );
      }
      assert.equal(
        f.store.settings().images!.steps,
        40,
        'Per-call options do not change the saved default',
      );
      const originalApproval = f.store.list<Approval>('approvals')[0];
      const pendingOperations = structuredClone(f.operations(task));
      await f.pause(room);
      await until(() => f.waitingReason(task) === 'paused', 'prepared image request parked');
      if (held && occupant) {
        held.complete();
        await f.done(occupant);
      }
      const changed = await f.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: {
          images: {
            baseUrl: nextProvider.baseUrl,
            modelId: 'replacement-image-model',
            apiKey: newKey,
            size: '2048x2048',
            steps: 20,
            stepsParameter: 'num_inference_steps',
            responseFormat: 'b64_json',
            timeoutSeconds: 149,
            shareInferenceSlot: false,
          },
        },
      });
      assert.equal(changed.statusCode, 200, changed.body);
      assert.deepEqual(f.operations(task), pendingOperations);
      assert.equal(f.imageRequests.length, 0);
      assert.equal(nextProvider.imageRequests.length, 0);
      if (originalApproval) {
        assert.deepEqual(f.store.get<Approval>('approvals', originalApproval.id), originalApproval);
        assert.equal(originalApproval.target, `${f.baseUrl}/images/generations`);
        assert.equal(originalApproval.args.model, 'original-image-model');
        assert.equal(originalApproval.args.size, '1024x1536');
        assert.equal(originalApproval.args.prompt, args.prompt);
        assert.equal(originalApproval.args.steps, originalSteps);
        assert.equal(originalApproval.args.stepsParameter, 'sd_cpp_extra_args');
        assert.match(originalApproval.summary, new RegExp(`${originalSteps} sampling steps`));
        f.controller.decideApproval(originalApproval.id, true);
      }
      await f.resume(room);
      const followup = await f.request(task.prompt, 2);
      assert.deepEqual(f.imageRequests, [
        {
          model: 'original-image-model',
          prompt: `${args.prompt}<sd_cpp_extra_args>{"sample_params":{"sample_steps":${originalSteps}}}</sd_cpp_extra_args>`,
          n: 1,
          size: '1024x1536',
        },
      ]);
      assert.equal(
        f.imageHeaders[0].authorization,
        oldKey ? `Bearer ${oldKey}` : undefined,
        'a newly saved key must never be sent to the previously reviewed origin',
      );
      assert.equal(nextProvider.imageRequests.length, 0);
      assert.ok(deadlines.includes(73_000), 'the prepared image retains its own deadline');
      assert.equal(deadlines.includes(149_000), false);
      const completed = structuredClone(f.operations(task)[0]);
      assert.equal(completed.status, 'completed');
      assert.equal(completed.args.endpoint, `${f.baseUrl}/images/generations`);
      assert.equal(completed.args.prompt, args.prompt);
      assert.equal(completed.args.steps, originalSteps);
      assert.equal(completed.args.stepsParameter, 'sd_cpp_extra_args');
      if (waiting === 'queue') assert.equal(completed.key, pendingOperations[0].key);

      assert.equal(
        f.store.settings().images!.steps,
        20,
        'The retained request does not restore the old saved default',
      );
      const nextArgs = { prompt: args.prompt, ...(override ? { steps: nextSteps } : {}) };
      followup.tool('generate_image', nextArgs);
      if (waiting === 'approval') {
        await until(
          () => f.store.list<Approval>('approvals').some((item) => item.status === 'pending'),
          'review of the next image request',
        );
        const approval = f.store
          .list<Approval>('approvals')
          .find((item) => item.status === 'pending')!;
        assert.notEqual(approval.id, originalApproval!.id);
        assert.equal(approval.target, `${nextProvider.baseUrl}/images/generations`);
        assert.equal(approval.args.model, 'replacement-image-model');
        assert.equal(approval.args.size, '2048x2048');
        assert.equal(approval.args.steps, nextSteps);
        assert.equal(approval.args.stepsParameter, 'num_inference_steps');
        assert.match(approval.summary, new RegExp(`${nextSteps} sampling steps`));
        f.controller.decideApproval(approval.id, true);
      }
      let final = await f.request(task.prompt, 3);
      assert.deepEqual(nextProvider.imageRequests, [
        {
          model: 'replacement-image-model',
          prompt: args.prompt,
          n: 1,
          size: '2048x2048',
          response_format: 'b64_json',
          num_inference_steps: nextSteps,
        },
      ]);
      assert.equal(nextProvider.imageHeaders[0].authorization, `Bearer ${newKey}`);
      assert.ok(deadlines.includes(149_000), 'new calls receive the saved deadline');
      assert.equal(f.imageRequests.length, 1, 'the original generation is never repeated');
      assert.deepEqual(f.operations(task)[0], completed);
      assert.equal(f.operations(task).length, 2);
      assert.equal(
        f.store.settings().images!.steps,
        20,
        'The next override does not alter the saved default',
      );
      assert.equal(f.store.settings().images!.stepsParameter, 'num_inference_steps');
      if (override) {
        const receipts = structuredClone(f.operations(task));
        final.tool('generate_image', nextArgs);
        final = await f.request(task.prompt, 4);
        assert.equal(
          nextProvider.imageRequests.length,
          1,
          'Repeating the completed override reuses its receipt',
        );
        assert.equal(f.imageRequests.length, 1);
        assert.deepEqual(f.operations(task), receipts);
        assert.equal(
          f.store.list<Approval>('approvals').filter((item) => item.status === 'pending').length,
          0,
        );
      }
      const persisted = JSON.stringify({
        operations: f.operations(task),
        approvals: f.store.list('approvals'),
        activities: f.store.list('activities'),
        messages: f.controller.getSnapshot().messages,
      });
      for (const key of [oldKey, newKey].filter(Boolean))
        assert.equal(persisted.includes(key), false, 'request credentials stay out of records');
      final.complete();
      await f.done(task);
    },
  );
}

test(
  'disabling image generation while paused blocks a previously prepared request before dispatch',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t, 1);
    const configured = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        permissions: { network: 'allow' },
        images: {
          enabled: true,
          baseUrl: f.baseUrl,
          modelId: 'disabled-before-dispatch',
          shareInferenceSlot: true,
        },
      },
    });
    assert.equal(configured.statusCode, 200, configured.body);
    const room = await f.room('Disable queued image');
    const other = await f.room('Hold shared capacity');
    const task = f.start(room.id, 'PAUSE_DISABLE_IMAGE');
    const initial = await f.request(task.prompt);
    const occupant = f.start(other.id, 'PAUSE_DISABLE_IMAGE_OCCUPANT');
    await until(() => f.waitingReason(occupant) === 'inference', 'queued text occupant');
    initial.tool('generate_image', { prompt: 'A yellow circle.' });
    const held = await f.request(occupant.prompt);
    await until(
      () => f.operations(task)[0]?.status === 'started' && f.task(task).status === 'waiting_model',
      'prepared image request',
    );
    await f.pause(room);
    await until(() => f.waitingReason(task) === 'paused', 'image queue fully paused');
    held.complete();
    await f.done(occupant);
    const disabled = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { images: { enabled: false } },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    await f.resume(room);
    const followup = await f.request(task.prompt, 2);
    assert.equal(f.imageRequests.length, 0);
    assert.match(JSON.stringify(followup.messages), /Image generation is disabled in Settings/);
    assert.equal(f.operations(task)[0].status, 'failed');
    assert.match(f.operations(task)[0].result!, /This request was not sent/);
    followup.complete();
    await f.done(task);
  },
);
