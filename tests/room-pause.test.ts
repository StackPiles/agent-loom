import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { Approval, Room, Task } from '../src/shared/types.js';
import { createApp } from '../src/server/app.js';

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

interface RequestRecord {
  marker: string;
  response: ServerResponse;
  ended: boolean;
  complete(): void;
  tool(name: string, args: Record<string, unknown>): void;
}

/** Held local SSE streams exercise real Pi task/tool lifetimes without a live model. */
async function fixture(t: TestContext, capacity = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-room-pause-'));
  const requests: RequestRecord[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const latest = payload.messages.findLast(
      (message: { role: string }) => message.role === 'user',
    );
    const marker = [...JSON.stringify(latest?.content).matchAll(/PAUSE_[A-Z_]+/g)].at(-1)?.[0];
    assert.ok(marker);
    const send = (delta: object, finish: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: `${marker}-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'pause-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    const finish = (reason: string) => {
      send({}, reason);
      record.ended = true;
      response.end('data: [DONE]\n\n');
    };
    const record: RequestRecord = {
      marker,
      response,
      ended: false,
      complete() {
        assert.equal(record.ended, false, 'the request must still be connected');
        send({ content: `completed-${marker}` });
        finish('stop');
      },
      tool(name, args) {
        assert.equal(record.ended, false);
        send({
          tool_calls: [
            {
              index: 0,
              id: `call_${requests.length}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
        finish('tool_calls');
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
    for (const request of requests) request.response.destroy();
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
  'room pause lets all started tasks finish and holds queued work and later handoffs until resume',
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

    a.tool('send_message', { handle: 'nova', message: 'PAUSE_CHILD' });
    const followup = await f.request(first.prompt, 2);
    await until(
      () => f.store.list<Task>('tasks').some((task) => task.parentTaskId === first.id),
      'handoff saved while pausing',
    );
    const child = f.store.list<Task>('tasks').find((task) => task.parentTaskId === first.id)!;
    assert.equal(child.status, 'queued');
    followup.complete();
    await f.done(first);
    b.complete();
    await f.done(second);
    assert.equal(f.task(queued).status, 'queued');
    assert.equal(f.task(child).status, 'queued');
    assert.deepEqual(
      f.controller.getSnapshot().queue.waitingTasks?.map((item) => item.reason),
      ['paused', 'paused'],
    );
    assert.equal(
      f.requests.length,
      3,
      'no queued child or next task starts as active work finishes',
    );

    const independent = f.start(other.id, 'PAUSE_OTHER');
    (await f.request(independent.prompt)).complete();
    await f.done(independent);
    await f.resume(room);
    const [q, c] = await Promise.all([f.request(queued.prompt), f.request(child.prompt)]);
    q.complete();
    c.complete();
    await Promise.all([f.done(queued), f.done(child)]);
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
  'already-started inference waiters and pending approvals remain able to finish while the room pauses',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t, 1);
    const room = await f.room('Finish approved work');
    const first = f.start(room.id, 'PAUSE_APPROVAL');
    const a = await f.request(first.prompt);
    const second = f.start(room.id, 'PAUSE_WAITER', 'bot_nova');
    await until(() => f.task(second).status === 'waiting_model', 'started inference waiter');
    await f.pause(room);
    a.tool('write_file', { path: 'approved.txt', content: 'Finished after pausing.' });
    const b = await f.request(second.prompt);
    await until(
      () =>
        f.store
          .list<Approval>('approvals')
          .some((item) => item.taskId === first.id && item.status === 'pending'),
      'approval remains actionable',
    );
    const approval = f.store.list<Approval>('approvals').find((item) => item.taskId === first.id)!;
    assert.equal(approval.status, 'pending');
    b.complete();
    await f.done(second);
    const approved = await f.app.inject({
      method: 'POST',
      url: `/api/approvals/${approval.id}`,
      payload: { decision: 'approve' },
    });
    assert.equal(approved.statusCode, 200, approved.body);
    (await f.request(first.prompt, 2)).complete();
    await f.done(first);
    assert.equal(
      await readFile(join(f.task(first).workspacePath!, 'approved.txt'), 'utf8'),
      'Finished after pausing.',
    );
    assert.equal(f.store.get<Room>('rooms', room.id)?.paused, true);
    assert.equal(f.store.get<Approval>('approvals', approval.id)?.status, 'approved');
  },
);
