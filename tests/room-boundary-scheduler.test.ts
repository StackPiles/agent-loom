import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { InferenceGate } from '../src/server/runtime/gate.js';
import { RoomTaskScheduler } from '../src/server/runtime/pause.js';

test('room pause drains the active action, then lends its worker until readmission is possible', async () => {
  const suspended: string[] = [];
  const scheduler = new RoomTaskScheduler({
    capacity: 1,
    onSuspend: (taskId) => suspended.push(taskId),
  });
  const signal = new AbortController().signal;
  assert.equal(scheduler.tryStart('first', 'paused-room'), true);
  assert.equal(await scheduler.checkpoint('first', signal), false);
  scheduler.setRoomPaused('paused-room', true);
  assert.equal(scheduler.activeCount, 1, 'an issued action retains its worker until it finishes');
  assert.equal(scheduler.isSuspended('first'), false);
  assert.deepEqual(suspended, []);

  let resumed = false;
  const first = scheduler.checkpoint('first', signal).then((parked) => {
    resumed = true;
    return parked;
  });
  assert.equal(scheduler.activeCount, 0);
  assert.equal(scheduler.isSuspended('first'), true);
  assert.deepEqual(suspended, ['first']);
  assert.deepEqual(scheduler.waitingTasks, [
    { taskId: 'first', roomId: 'paused-room', reason: 'paused' },
  ]);
  assert.equal(scheduler.tryStart('blocked', 'paused-room'), false);
  assert.equal(scheduler.tryStart('independent', 'other-room'), true);
  scheduler.setRoomPaused('paused-room', false);
  await nextTurn();
  assert.equal(resumed, false, 'resume must reacquire the worker borrowed by another room');
  assert.deepEqual(scheduler.waitingTasks, [
    { taskId: 'first', roomId: 'paused-room', reason: 'worker' },
  ]);
  scheduler.finish('independent');
  assert.equal(scheduler.activeCount, 1, 'reserve the worker before resolving its continuation');
  assert.equal(scheduler.tryStart('new-work', 'other-room'), false);
  assert.equal(await first, true);
  assert.equal(scheduler.isSuspended('first'), false);
  assert.deepEqual(scheduler.waitingTasks, []);
  scheduler.finish('first');
  scheduler.finish('first');
  assert.equal(scheduler.activeCount, 0);
});

test('many rooms resuming together never exceed the shared worker capacity', async () => {
  let maximum = 0;
  const scheduler = new RoomTaskScheduler({
    capacity: 16,
    changed: () => {
      maximum = Math.max(maximum, scheduler.activeCount);
      assert.ok(scheduler.activeCount >= 0 && scheduler.activeCount <= 16);
    },
  });
  const signal = new AbortController().signal;
  const resumed: number[] = [];
  const waits: Array<Promise<boolean>> = [];
  for (let i = 0; i < 32; i++) {
    assert.equal(scheduler.tryStart(`paused-${i}`, `room-${i}`), true);
    scheduler.setRoomPaused(`room-${i}`, true);
    waits.push(
      scheduler.checkpoint(`paused-${i}`, signal).then((parked) => {
        resumed.push(i);
        return parked;
      }),
    );
  }
  for (let i = 0; i < 16; i++) assert.equal(scheduler.tryStart(`active-${i}`, 'independent'), true);
  for (let i = 0; i < 32; i++) scheduler.setRoomPaused(`room-${i}`, false);
  await nextTurn();
  assert.deepEqual(resumed, []);
  assert.equal(scheduler.waitingTasks.length, 32);

  for (let i = 0; i < 16; i++) scheduler.finish(`active-${i}`);
  await nextTurn();
  assert.deepEqual(
    resumed,
    Array.from({ length: 16 }, (_, i) => i),
  );
  assert.equal(scheduler.activeCount, 16);
  assert.equal(scheduler.waitingTasks.length, 16);
  for (let i = 0; i < 16; i++) scheduler.finish(`paused-${i}`);
  assert.deepEqual(await Promise.all(waits), Array(32).fill(true));
  assert.equal(scheduler.activeCount, 16);
  assert.equal(maximum, 16);
  for (let i = 16; i < 32; i++) scheduler.finish(`paused-${i}`);
  assert.equal(scheduler.activeCount, 0);
  assert.deepEqual(scheduler.waitingTasks, []);
});

test('readmission skips paused rooms and prioritizes foreground work before background waits', async () => {
  const scheduler = new RoomTaskScheduler({ capacity: 1 });
  const signal = new AbortController().signal;
  const order: string[] = [];
  const waits = new Map<string, Promise<boolean>>();
  for (const taskId of ['blocked', 'background', 'foreground']) {
    assert.equal(scheduler.tryStart(taskId, taskId, taskId === 'background'), true);
    scheduler.setRoomPaused(taskId, true);
    waits.set(
      taskId,
      scheduler.checkpoint(taskId, signal).then((parked) => {
        order.push(taskId);
        return parked;
      }),
    );
  }
  assert.equal(scheduler.tryStart('busy', 'independent'), true);
  scheduler.setRoomPaused('background', false);
  scheduler.setRoomPaused('foreground', false);
  scheduler.finish('busy');
  await waits.get('foreground');
  assert.deepEqual(order, ['foreground']);
  scheduler.finish('foreground');
  await waits.get('background');
  assert.deepEqual(order, ['foreground', 'background']);
  scheduler.finish('background');
  assert.equal(scheduler.activeCount, 0);
  assert.deepEqual(scheduler.waitingTasks, [
    { taskId: 'blocked', roomId: 'blocked', reason: 'paused' },
  ]);
  scheduler.setRoomPaused('blocked', false);
  await waits.get('blocked');
  scheduler.finish('blocked');
});

test('concurrent approval and tool checkpoints share one suspended task and one resumed worker', async () => {
  const suspended: string[] = [];
  const scheduler = new RoomTaskScheduler({
    capacity: 1,
    onSuspend: (taskId) => suspended.push(taskId),
  });
  const signal = new AbortController().signal;
  assert.equal(scheduler.tryStart('approval', 'room'), true);
  scheduler.setRoomPaused('room', true);
  const observed = scheduler.checkpoint('approval', signal);
  const tool = scheduler.checkpoint('approval', signal);
  const auxiliaryAbort = new AbortController();
  const auxiliary = scheduler.checkpoint('approval', auxiliaryAbort.signal);
  const rejected = assert.rejects(auxiliary, { name: 'AbortError' });
  auxiliaryAbort.abort();
  await rejected;
  assert.equal(scheduler.activeCount, 0);
  assert.deepEqual(suspended, ['approval']);
  assert.equal(scheduler.waitingTasks.length, 1);
  scheduler.setRoomPaused('room', false);
  assert.deepEqual(await Promise.all([observed, tool]), [true, true]);
  assert.equal(scheduler.activeCount, 1);
  assert.equal(scheduler.tryStart('overflow', 'room'), false);
  assert.deepEqual(scheduler.waitingTasks, []);
  scheduler.finish('approval');
  assert.equal(scheduler.activeCount, 0);
});

test('task cancellation and shutdown remove every pending checkpoint without later readmission', async () => {
  const scheduler = new RoomTaskScheduler({ capacity: 2 });
  const controller = new AbortController();
  assert.equal(scheduler.tryStart('cancelled', 'room'), true);
  assert.equal(scheduler.tryStart('shutdown', 'room'), true);
  scheduler.setRoomPaused('room', true);
  const cancelled = scheduler.checkpoint('cancelled', controller.signal);
  const another = scheduler.checkpoint('cancelled', controller.signal);
  const shutdown = scheduler.checkpoint('shutdown', new AbortController().signal);
  const rejections = [cancelled, another, shutdown].map((wait) =>
    assert.rejects(wait, { name: 'AbortError' }),
  );
  controller.abort();
  scheduler.finish('cancelled');
  scheduler.finish('shutdown');
  await Promise.all(rejections);
  assert.deepEqual(scheduler.waitingTasks, []);
  scheduler.setRoomPaused('room', false);
  await nextTurn();
  assert.equal(scheduler.activeCount, 0);
  assert.equal(scheduler.isSuspended('cancelled'), false);
  assert.equal(scheduler.tryStart('fresh', 'room'), true);
  scheduler.finish('fresh');
});

test('resume followed immediately by pause reparks all concurrent continuations once', async () => {
  const suspended: string[] = [];
  const scheduler = new RoomTaskScheduler({
    capacity: 1,
    onSuspend: (taskId) => suspended.push(taskId),
  });
  const signal = new AbortController().signal;
  scheduler.tryStart('task', 'room');
  scheduler.setRoomPaused('room', true);
  let completed = 0;
  const waits = Array.from({ length: 2 }, () =>
    scheduler.checkpoint('task', signal).then((parked) => {
      completed++;
      return parked;
    }),
  );
  scheduler.setRoomPaused('room', false);
  assert.equal(scheduler.activeCount, 1);
  scheduler.setRoomPaused('room', true);
  await nextTurn();
  assert.equal(completed, 0);
  assert.equal(scheduler.activeCount, 0);
  assert.equal(scheduler.waitingTasks.length, 1);
  assert.deepEqual(suspended, ['task', 'task']);
  scheduler.setRoomPaused('room', false);
  assert.deepEqual(await Promise.all(waits), [true, true]);
  scheduler.finish('task');
});

test('room pause signals cancel only capacity waits and are renewed on resume', () => {
  const scheduler = new RoomTaskScheduler({ pausedRooms: ['initially-paused'] });
  assert.equal(scheduler.pauseSignal('initially-paused').aborted, true);
  assert.equal(scheduler.tryStart('blocked', 'initially-paused'), false);
  const first = scheduler.pauseSignal('one');
  const independent = scheduler.pauseSignal('two');
  scheduler.setRoomPaused('one', false);
  assert.equal(scheduler.pauseSignal('one'), first, 'idempotent resume retains the live signal');
  scheduler.setRoomPaused('one', true);
  assert.equal(first.aborted, true);
  assert.equal(independent.aborted, false);
  assert.equal(scheduler.isRoomPaused('one'), true);
  scheduler.setRoomPaused('one', true);
  assert.equal(scheduler.pauseSignal('one'), first);
  scheduler.setRoomPaused('one', false);
  const next = scheduler.pauseSignal('one');
  assert.notEqual(next, first);
  assert.equal(next.aborted, false);
  assert.equal(first.aborted, true);
  scheduler.setRoomPaused('initially-paused', false);
  assert.equal(scheduler.pauseSignal('initially-paused').aborted, false);
});

/** Model the caller's capacity-only pause signal and post-grant recheck contract. */
async function acquireAtBoundary(
  scheduler: RoomTaskScheduler,
  gate: InferenceGate,
  taskId: string,
  roomId: string,
  signal: AbortSignal,
): Promise<() => void> {
  while (true) {
    await scheduler.checkpoint(taskId, signal);
    const pause = scheduler.pauseSignal(roomId);
    try {
      const release = await gate.acquire(AbortSignal.any([signal, pause]));
      if (scheduler.isRoomPaused(roomId)) {
        release();
        continue;
      }
      return release;
    } catch (error) {
      if (signal.aborted || !pause.aborted) throw error;
    }
  }
}

test('pausing an inference-capacity waiter removes it without aborting the task or holding a slot', async () => {
  const scheduler = new RoomTaskScheduler({ capacity: 2 });
  const gate = new InferenceGate(undefined, 1);
  const controller = new AbortController();
  const occupied = await gate.acquire();
  scheduler.tryStart('waiting', 'room');
  const request = acquireAtBoundary(scheduler, gate, 'waiting', 'room', controller.signal);
  await nextTurn();
  assert.deepEqual(gate.state, { active: 1, waiting: 1 });
  scheduler.setRoomPaused('room', true);
  await nextTurn();
  assert.equal(controller.signal.aborted, false);
  assert.deepEqual(gate.state, { active: 1, waiting: 0 });
  assert.equal(scheduler.activeCount, 0);
  occupied();
  const independent = await gate.acquire();
  scheduler.setRoomPaused('room', false);
  await nextTurn();
  assert.deepEqual(gate.state, { active: 1, waiting: 1 });
  independent();
  const release = await request;
  assert.deepEqual(gate.state, { active: 1, waiting: 0 });
  scheduler.setRoomPaused('room', true);
  assert.deepEqual(gate.state, { active: 1, waiting: 0 }, 'an already-issued operation may finish');
  release();
  scheduler.finish('waiting');
  assert.deepEqual(gate.state, { active: 0, waiting: 0 });
});

test('a pause racing a granted capacity slot releases that slot before parking', async () => {
  const scheduler = new RoomTaskScheduler({ capacity: 1 });
  const gate = new InferenceGate(() => {
    if (gate.state.active === 1) scheduler.setRoomPaused('room', true);
  });
  const controller = new AbortController();
  scheduler.tryStart('task', 'room');
  const request = acquireAtBoundary(scheduler, gate, 'task', 'room', controller.signal);
  await nextTurn();
  assert.deepEqual(gate.state, { active: 0, waiting: 0 });
  assert.equal(scheduler.activeCount, 0);
  assert.deepEqual(scheduler.waitingTasks, [{ taskId: 'task', roomId: 'room', reason: 'paused' }]);
  const rejected = assert.rejects(request, { name: 'AbortError' });
  controller.abort();
  await rejected;
  scheduler.finish('task');
});

test('invalid capacity, duplicate admissions, and pre-aborted checkpoints cannot leak workers', async () => {
  for (const capacity of [0, 1.5, 17, NaN])
    assert.throws(() => new RoomTaskScheduler({ capacity }), RangeError);
  const scheduler = new RoomTaskScheduler({ capacity: 1 });
  assert.equal(scheduler.tryStart('task', 'room'), true);
  assert.equal(scheduler.tryStart('task', 'other-room'), false);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scheduler.checkpoint('task', controller.signal), { name: 'AbortError' });
  assert.equal(
    scheduler.activeCount,
    1,
    'the owning run releases its active worker on finalization',
  );
  scheduler.finish('task');
  assert.equal(scheduler.activeCount, 0);
  await assert.rejects(
    scheduler.checkpoint('missing', new AbortController().signal),
    /no worker registration/,
  );
});
