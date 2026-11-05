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
