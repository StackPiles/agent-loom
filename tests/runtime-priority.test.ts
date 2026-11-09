import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { InferenceGate, type TaskPriority } from '../src/server/runtime/gate.js';
import { RoomTaskScheduler } from '../src/server/runtime/pause.js';

test('inference prioritizes chat, then automation, then learning without interrupting issued work', async () => {
  const gate = new InferenceGate();
  const releaseActive = await gate.acquire(undefined, 'automation');
  const order: string[] = [];
  const queued = new Map<string, Promise<() => void>>();
  for (const [id, priority] of [
    ['learning', 'learning'],
    ['auto-one', 'automation'],
    ['chat-one', 'chat'],
    ['auto-two', 'automation'],
    ['chat-two', 'chat'],
  ] as const)
    queued.set(
      id,
      gate.acquire(undefined, priority).then((release) => {
        order.push(id);
        return release;
      }),
    );
  await nextTurn();
  assert.deepEqual(order, [], 'priority does not preempt a request already using a slot');
  releaseActive();
  for (const id of ['chat-one', 'chat-two', 'auto-one', 'auto-two', 'learning']) {
    const release = await queued.get(id)!;
    assert.equal(order.at(-1), id);
    release();
  }
  assert.deepEqual(order, ['chat-one', 'chat-two', 'auto-one', 'auto-two', 'learning']);
  assert.deepEqual(gate.state, { active: 0, waiting: 0 });
});

test('background inference can use all model slots and blocked chat rooms do not waste capacity', async () => {
  const gate = new InferenceGate(undefined, 2);
  const first = await gate.acquire(undefined, 'automation', { roomId: 'busy', serialRoom: true });
  const other = await gate.acquire(undefined, 'automation', { roomId: 'other' });
  assert.equal(gate.state.active, 2, 'there is no fixed model-slot reservation');
  const chat = gate.acquire(undefined, 'chat', { roomId: 'busy', serialRoom: true });
  const automation = gate.acquire(undefined, 'automation', { roomId: 'independent' });
  other();
  const next = await automation;
  assert.equal(gate.state.active, 2);
  first();
  const user = await chat;
  next();
  user();
  assert.deepEqual(gate.state, { active: 0, waiting: 0 });
});

test('background workers leave a user worker available and release their allowance on pause', async () => {
  const scheduler = new RoomTaskScheduler({ capacity: 3 });
  assert.equal(scheduler.tryStart('first', 'one', 'automation'), true);
  assert.equal(scheduler.tryStart('second', 'two', 'learning'), true);
  assert.equal(scheduler.tryStart('extra', 'three', 'automation'), false);
  assert.equal(scheduler.tryStart('user', 'user-room', 'chat'), true);
  assert.equal(scheduler.activeCount, 3);
  scheduler.setRoomPaused('two', true);
  const paused = scheduler.checkpoint('second', new AbortController().signal);
  assert.equal(scheduler.activeCount, 2);
  assert.equal(scheduler.tryStart('extra', 'three', 'automation'), true);
  scheduler.setRoomPaused('two', false);
  scheduler.finish('user');
  await nextTurn();
  assert.equal(scheduler.isSuspended('second'), true, 'learning cannot occupy the user reserve');
  scheduler.finish('extra');
  assert.equal(await paused, true);
  scheduler.finish('second');
  scheduler.finish('first');
  assert.equal(scheduler.activeCount, 0);
});

test('ready user tasks outrank suspended automation and automation outranks suspended learning', async () => {
  let pending: TaskPriority | undefined;
  const scheduler = new RoomTaskScheduler({ capacity: 1, pendingPriority: () => pending });
  const signal = new AbortController().signal;
  const order: string[] = [];
  const waits = new Map<string, Promise<boolean>>();
  for (const priority of ['learning', 'automation'] as const) {
    assert.equal(scheduler.tryStart(priority, priority, priority), true);
    scheduler.setRoomPaused(priority, true);
    waits.set(
      priority,
      scheduler.checkpoint(priority, signal).then((parked) => {
        order.push(priority);
        return parked;
      }),
    );
  }
  pending = 'chat';
  scheduler.setRoomPaused('learning', false);
  scheduler.setRoomPaused('automation', false);
  await nextTurn();
  assert.deepEqual(order, [], 'a resumed background task cannot jump an unstarted user task');
  assert.equal(scheduler.tryStart('user', 'user', 'chat'), true);
  pending = undefined;
  scheduler.finish('user');
  await waits.get('automation');
  assert.deepEqual(order, ['automation']);
  scheduler.finish('automation');
  await waits.get('learning');
  assert.deepEqual(order, ['automation', 'learning']);
  scheduler.finish('learning');
});

test('background work lends a saturated worker only at its next safe boundary and can be cancelled there', async () => {
  let pending: TaskPriority | undefined;
  const scheduler = new RoomTaskScheduler({ capacity: 2, pendingPriority: () => pending });
  assert.equal(scheduler.tryStart('auto', 'background', 'automation'), true);
  assert.equal(scheduler.tryStart('user-one', 'one', 'chat'), true);
  pending = 'chat';
  assert.equal(scheduler.activeCount, 2, 'the in-flight operation is not interrupted');
  const controller = new AbortController();
  const parked = scheduler.checkpoint('auto', controller.signal);
  const rejection = assert.rejects(parked, { name: 'AbortError' });
  assert.equal(scheduler.activeCount, 1);
  assert.equal(scheduler.tryStart('user-two', 'two', 'chat'), true);
  pending = undefined;
  controller.abort();
  await rejection;
  scheduler.finish('auto');
  scheduler.finish('user-one');
  scheduler.finish('user-two');
  scheduler.refresh();
  assert.equal(scheduler.activeCount, 0);
  assert.deepEqual(scheduler.waitingTasks, []);
});
