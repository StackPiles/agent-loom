import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { Room, Task } from '../src/shared/types.js';
import { createApp } from '../src/server/app.js';
import { InferenceGate } from '../src/server/runtime/gate.js';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

test('inference capacity changes preserve active streams, FIFO admission and idempotent release', async () => {
  const gate = new InferenceGate(undefined, 2);
  assert.equal(gate.capacity, 2);
  for (const value of [0, 1.5, 17, NaN]) assert.throws(() => gate.setCapacity(value), RangeError);
  const a = await gate.acquire();
  const b = await gate.acquire();
  const order: string[] = [];
  const c = gate.acquire().then((release) => {
    order.push('c');
    return release;
  });
  const d = gate.acquire().then((release) => {
    order.push('d');
    return release;
  });
  gate.setCapacity(1);
  assert.deepEqual(gate.state, { active: 2, waiting: 2 });
  a();
  a();
  assert.deepEqual(gate.state, { active: 1, waiting: 2 });
  assert.deepEqual(order, []);
  gate.setCapacity(3);
  const [releaseC, releaseD] = await Promise.all([c, d]);
  assert.deepEqual(order, ['c', 'd']);
  assert.deepEqual(gate.state, { active: 3, waiting: 0 });
  b();
  releaseD();
  releaseC();
  assert.deepEqual(gate.state, { active: 0, waiting: 0 });
});

test('room turns do not block independent rooms and foreground requests precede background work', async () => {
  const gate = new InferenceGate(undefined, 2);
  const first = await gate.acquire(undefined, false, {
    taskId: 'first',
    roomId: 'one',
    serialRoom: true,
  });
  const cancelled = new AbortController();
  const removed = gate.acquire(cancelled.signal, false, {
    taskId: 'cancelled',
    roomId: 'one',
    serialRoom: true,
  });
  const rejection = assert.rejects(removed, { name: 'AbortError' });
  cancelled.abort();
  await rejection;
  const sameRoom = gate.acquire(undefined, false, {
    taskId: 'same-room',
    roomId: 'one',
    serialRoom: true,
  });
  const independent = await gate.acquire(undefined, true, { taskId: 'independent', roomId: 'two' });
  assert.deepEqual(gate.waitingRequests, [{ taskId: 'same-room', reason: 'room' }]);
  const background = gate.acquire(undefined, true, { taskId: 'background', roomId: 'three' });
  const foreground = gate.acquire(undefined, false, { taskId: 'foreground', roomId: 'four' });
  independent();
  const releaseForeground = await foreground;
  assert.deepEqual(gate.waitingRequests, [
    { taskId: 'same-room', reason: 'room' },
    { taskId: 'background', reason: 'inference' },
  ]);
  releaseForeground();
  const releaseBackground = await background;
  first();
  const releaseSameRoom = await sameRoom;
  assert.deepEqual(gate.state, { active: 2, waiting: 0 });
  releaseSameRoom();
  releaseBackground();
});

interface RequestRecord {
  marker: string;
  payload: { messages: Array<{ role: string; content?: unknown }> };
  response: ServerResponse;
  ended: boolean;
  complete(): void;
}

async function fixture(t: TestContext, capacity = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-concurrency-'));
  const requests: RequestRecord[] = [];
  let active = 0;
  let maximum = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const latest = payload.messages.findLast(
      (message: { role: string }) => message.role === 'user',
    );
    const marker = [...JSON.stringify(latest?.content).matchAll(/PAR_[A-Z_]+/g)].at(-1)?.[0];
    assert.ok(marker);
    active++;
    maximum = Math.max(active, maximum);
    const send = (delta: object, finish: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: marker, object: 'chat.completion.chunk', created: 1, model: 'parallel-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    const end = () => {
      if (record.ended) return;
      record.ended = true;
      active--;
    };
    const record: RequestRecord = {
      marker,
      payload,
      response,
      ended: false,
      complete: () => {
        if (record.ended) return;
        send({ content: `completed-${marker}` });
        send({}, 'stop');
        response.end('data: [DONE]\n\n');
        end();
      },
    };
    response.once('close', end);
    requests.push(record);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    send({ reasoning_content: `thinking-${marker}` });
    send({ content: `partial-${marker} ` });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const instance = await createApp({ dataDir: join(directory, 'data'), scheduler: false });
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
      model: { baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'parallel-fixture' },
      inference: { maxConcurrentRequests: capacity },
      autoLearn: false,
    },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  const room = async (name: string, parallelResponses = false) => {
    const result = await instance.app.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: { name, botIds: ['bot_aster', 'bot_nova'], parallelResponses },
    });
    assert.equal(result.statusCode, 200, result.body);
    return result.json<Room>();
  };
  const start = (roomId: string, marker: string, botId = 'bot_aster') =>
    instance.controller.enqueueTask({ roomId, botId, prompt: marker });
  const waitFor = async (marker: string) => {
    await until(() => requests.some((entry) => entry.marker === marker), `request ${marker}`);
    return requests.find((entry) => entry.marker === marker)!;
  };
  const waitDone = async (task: Task) => {
    await until(
      () =>
        ['completed', 'failed', 'stopped'].includes(
          instance.store.get<Task>('tasks', task.id)!.status,
        ),
      task.prompt,
    );
    const result = instance.store.get<Task>('tasks', task.id)!;
    assert.equal(result.status, 'completed', result.error);
  };
  return {
    ...instance,
    requests,
    room,
    start,
    waitFor,
    waitDone,
    getActive: () => active,
    getMaximum: () => maximum,
  };
}

test(
  'real Pi streams overlap when enabled, remain task-owned, and cancellation frees a queued generation',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t, 2);
    const one = await f.room('Parallel room', true);
    const two = await f.room('Independent room');
    const a = f.start(one.id, 'PAR_A');
    const b = f.start(two.id, 'PAR_B');
    await Promise.all([f.waitFor('PAR_A'), f.waitFor('PAR_B')]);
    assert.equal(f.getMaximum(), 2);
    assert.equal(f.controller.getSnapshot().queue.active, 2);
    const c = f.start(one.id, 'PAR_C', 'bot_nova');
    const d = f.start(one.id, 'PAR_D');
    await until(
      () =>
        f.controller
          .getSnapshot()
          .queue.waitingTasks?.some(
            (item) => item.taskId === c.id && item.reason === 'inference',
          ) === true,
      'capacity waiter',
    );
    assert.ok(
      f.controller
        .getSnapshot()
        .queue.waitingTasks?.some((item) => item.taskId === d.id && item.reason === 'session'),
    );
    assert.equal(f.controller.getSnapshot().queue.waiting, 2);
    await until(
      () =>
        f.controller
          .getSnapshot()
          .messages.some(
            (message) => message.taskId === a.id && message.reasoning?.includes('PAR_A'),
          ),
      'first reasoning delivered',
    );
    await f.controller.stop(a.id);
    const cRequest = await f.waitFor('PAR_C');
    assert.equal(f.store.get<Task>('tasks', a.id)?.status, 'stopped');
    assert.equal(
      f.requests.some((entry) => entry.marker === 'PAR_D'),
      false,
    );
    await f.controller.stop(b.id);
    const dRequest = await f.waitFor('PAR_D');
    assert.ok(f.getMaximum() <= 2);
    // A stopped, incomplete response must not be quoted into another bot's prompt.
    assert.equal(JSON.stringify(cRequest.payload.messages).includes('partial-PAR_A'), false);
    cRequest.complete();
    dRequest.complete();
    await Promise.all([f.waitDone(c), f.waitDone(d)]);
    for (const [task, marker] of [
      [c, 'PAR_C'],
      [d, 'PAR_D'],
    ] as const) {
      const message = f.controller.getSnapshot().messages.find((item) => item.taskId === task.id)!;
      assert.equal(message.body, `partial-${marker} completed-${marker}`);
      assert.equal(message.reasoning, `thinking-${marker}`);
      assert.equal(message.reasoningStatus, 'complete');
    }
    assert.equal(f.controller.getSnapshot().queue.waiting, 0);
  },
);

test(
  'room-local sequential generation leaves capacity for other rooms and protects live policy changes',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t, 2);
    const one = await f.room('Sequential room');
    const two = await f.room('Other room');
    const a = f.start(one.id, 'PAR_FIRST');
    const first = await f.waitFor('PAR_FIRST');
    const b = f.start(one.id, 'PAR_SECOND', 'bot_nova');
    await until(
      () =>
        f.controller
          .getSnapshot()
          .queue.waitingTasks?.some((item) => item.taskId === b.id && item.reason === 'room') ===
        true,
      'room waiter',
    );
    const c = f.start(two.id, 'PAR_OTHER');
    const other = await f.waitFor('PAR_OTHER');
    assert.equal(f.getActive(), 2);
    assert.equal(
      f.requests.some((entry) => entry.marker === 'PAR_SECOND'),
      false,
    );
    const rejected = await f.app.inject({
      method: 'PATCH',
      url: `/api/rooms/${one.id}`,
      payload: { parallelResponses: true },
    });
    assert.equal(rejected.statusCode, 409, rejected.body);
    first.complete();
    const second = await f.waitFor('PAR_SECOND');
    assert.equal(f.getActive(), 2);
    second.complete();
    other.complete();
    await Promise.all([f.waitDone(a), f.waitDone(b), f.waitDone(c)]);
  },
);

test(
  'default serial inference can increase live and a lower limit drains active streams without cancelling them',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t);
    const one = await f.room('One', true);
    const two = await f.room('Two', true);
    const a = f.start(one.id, 'PAR_ONE');
    const first = await f.waitFor('PAR_ONE');
    const b = f.start(two.id, 'PAR_TWO');
    await until(() => f.controller.getSnapshot().queue.modelWaiting === 1, 'default serial queue');
    assert.equal(f.controller.getSnapshot().queue.capacity, 1);
    assert.equal(f.getMaximum(), 1);
    const resize = async (capacity: number) => {
      const response = await f.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { inference: { maxConcurrentRequests: capacity } },
      });
      assert.equal(response.statusCode, 200, response.body);
    };
    await resize(2);
    const second = await f.waitFor('PAR_TWO');
    assert.equal(f.getActive(), 2);
    await resize(1);
    assert.equal(f.controller.getSnapshot().queue.capacity, 1);
    assert.equal(f.controller.getSnapshot().queue.active, 2);
    const c = f.start(one.id, 'PAR_THREE', 'bot_nova');
    await until(
      () => f.controller.getSnapshot().queue.modelWaiting === 1,
      'lowered capacity queue',
    );
    first.complete();
    await f.waitDone(a);
    assert.equal(
      f.requests.some((entry) => entry.marker === 'PAR_THREE'),
      false,
    );
    second.complete();
    const third = await f.waitFor('PAR_THREE');
    third.complete();
    await Promise.all([f.waitDone(b), f.waitDone(c)]);
    assert.equal(f.getMaximum(), 2);
  },
);
