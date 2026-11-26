import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { RoomTaskScheduler } from '../src/server/runtime/pause.js';
import {
  SessionMemoryBudget,
  SessionMemoryPressureError,
  estimateSessionImageWorkingBytes,
  estimateSessionResidentBytes,
  sessionMemoryLimits,
} from '../src/server/runtime/session-memory.js';

test('loaded sessions have independent count/byte bounds and FIFO prevents large-history starvation', async () => {
  const budget = new SessionMemoryBudget({ maxBytes: 300, maxSessions: 2 });
  const first = await budget.acquireSession(60);
  const second = await budget.acquireSession(30);
  const order: string[] = [];
  const large = budget.acquireSession(40).then((lease) => {
    order.push('large');
    return lease;
  });
  const small = budget.acquireSession(10).then((lease) => {
    order.push('small');
    return lease;
  });
  await nextTurn();
  assert.deepEqual(order, [], 'the small newcomer must not steal the remaining bytes');
  second.release();
  const larger = await large;
  assert.deepEqual(order, ['large']);
  assert.equal(budget.state.resident.bytes, 100);
  first.release();
  const smaller = await small;
  assert.deepEqual(order, ['large', 'small']);
  larger.release();
  smaller.release();
  smaller.release();
  assert.deepEqual(budget.state.resident, { bytes: 0, count: 0, waiting: 0 });
});

test('a full resident partition cannot consume the headroom required to hydrate and finish', async () => {
  const budget = new SessionMemoryBudget({ maxBytes: 300, maxSessions: 1 });
  const session = await budget.acquireSession(100);
  const image = await budget.acquireTemporary(200);
  assert.equal(budget.state.resident.bytes + budget.state.temporary.bytes, 300);
  const controller = new AbortController();
  const waiting = budget.acquireTemporary(1, { signal: controller.signal, taskId: 'image-waiter' });
  const stopped = assert.rejects(waiting, { name: 'AbortError' });
  controller.abort();
  await stopped;
  image.release();
  session.release();
  assert.deepEqual(budget.waitingTaskIds, []);
});

test('oversized single requests fail without entering the queue and growth never waits while holding memory', async () => {
  const budget = new SessionMemoryBudget({ maxBytes: 300, maxSessions: 3 });
  await assert.rejects(budget.acquireSession(101), /above its .* memory allowance/);
  await assert.rejects(budget.acquireTemporary(201), /LOOM_SESSION_MEMORY_MB/);
  const first = await budget.acquireSession(60);
  const second = await budget.acquireSession(30);
  assert.throws(
    () => first.resize(80),
    (error) =>
      error instanceof SessionMemoryPressureError &&
      error.kind === 'shared' &&
      error.requestedBytes === 80 &&
      error.availableBytes === 70,
  );
  assert.equal(budget.state.resident.bytes, 90, 'a failed resize does not corrupt accounting');
  second.release();
  first.resize(80);
  assert.equal(budget.state.resident.bytes, 80);
  assert.throws(() => first.resize(101), /above its/);
  first.release();
  assert.equal(budget.state.resident.bytes, 0);
  assert.equal(budget.state.resident.waiting, 0);
});

test('a completed batch can reserve temporary growth immediately without stealing a queued grant', async () => {
  const budget = new SessionMemoryBudget({ maxBytes: 300, maxSessions: 2 });
  const holder = await budget.acquireTemporary(150);
  const growth = budget.tryAcquireTemporary(20);
  assert.ok(growth);
  assert.equal(budget.state.temporary.bytes, 170);
  growth.resize(30);
  assert.equal(budget.state.temporary.bytes, 180);
  assert.equal(budget.tryAcquireTemporary(21), undefined);
  const pending = budget.acquireTemporary(60);
  assert.equal(budget.tryAcquireTemporary(1), undefined, 'a small spill cannot overtake FIFO');
  growth.release();
  holder.release();
  (await pending).release();
  assert.deepEqual(budget.state.temporary, { bytes: 0, count: 0, waiting: 0 });
});

test('withdrawing a paused capacity waiter admits the next room without leaving a ghost reservation', async () => {
  const budget = new SessionMemoryBudget({ maxBytes: 300, maxSessions: 1 });
  const held = await budget.acquireSession(60);
  const pause = new AbortController();
  let lent = false;
  const paused = budget.acquireSession(50, {
    taskId: 'paused',
    signal: pause.signal,
    onWait: () => {
      lent = true;
    },
  });
  const rejected = assert.rejects(paused, { name: 'AbortError' });
  const next = budget.acquireSession(40, { taskId: 'next' });
  assert.equal(lent, true);
  pause.abort();
  await rejected;
  assert.deepEqual(budget.waitingTaskIds, ['next']);
  held.release();
  (await next).release();
  assert.deepEqual(budget.state.resident, { bytes: 0, count: 0, waiting: 0 });
});

test('paused sessions retain memory while unadmitted waiters lend workers so holders can resume', async () => {
  const budget = new SessionMemoryBudget({ maxBytes: 300, maxSessions: 1 });
  const workers = new RoomTaskScheduler({ capacity: 1 });
  const signal = new AbortController().signal;
  assert.equal(workers.tryStart('holder', 'first-room'), true);
  const held = await budget.acquireSession(60);
  workers.setRoomPaused('first-room', true);
  const resumed = workers.checkpoint('holder', signal);
  assert.equal(workers.tryStart('waiting', 'second-room'), true);
  const pending = budget.acquireSession(60, {
    taskId: 'waiting',
    onWait: () => workers.lend('waiting'),
  });
  assert.equal(budget.state.resident.count, 1);
  assert.equal(workers.activeCount, 0);
  workers.setRoomPaused('first-room', false);
  await resumed;
  assert.equal(workers.activeCount, 1, 'the loaded holder can reacquire a worker');
  held.release();
  workers.finish('holder');
  const next = await pending;
  await workers.checkpoint('waiting', signal);
  next.release();
  workers.finish('waiting');
  assert.equal(budget.state.resident.count, 0);
  assert.equal(workers.activeCount, 0);
});

test('environment limits are bounded and estimated working memory includes base64 and request copies', () => {
  const mib = 1024 * 1024;
  const limits = sessionMemoryLimits({}, 4096 * mib);
  assert.equal(limits.maxBytes, 1536 * mib);
  assert.equal(limits.maxSessions, 4);
  assert.equal(sessionMemoryLimits({}, 512 * mib).maxBytes, 256 * mib);
  assert.deepEqual(
    sessionMemoryLimits({ LOOM_SESSION_MEMORY_MB: '192', LOOM_SESSION_MAX_LOADED: '2' }),
    {
      maxBytes: 192 * mib,
      maxSessions: 2,
    },
  );
  assert.throws(() => sessionMemoryLimits({ LOOM_SESSION_MEMORY_MB: '0' }), /whole number/);
  assert.equal(sessionMemoryLimits({ LOOM_SESSION_MAX_LOADED: '64' }).maxSessions, 64);
  assert.throws(() => sessionMemoryLimits({ LOOM_SESSION_MAX_LOADED: '99' }), /whole number/);
  assert.equal(estimateSessionResidentBytes(1024), 16 * mib + 4096);
  assert.equal(estimateSessionImageWorkingBytes(256 * mib), 1024 * mib);
  assert.throws(() => estimateSessionImageWorkingBytes(Number.MAX_SAFE_INTEGER), /too large/);
});
