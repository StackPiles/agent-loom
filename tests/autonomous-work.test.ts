import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import type { NewTask } from '../src/server/runtime/contract.js';
import type { WakeupInput } from '../src/server/work.js';
import type { Bot, Room, Task } from '../src/shared/types.js';
import {
  DEFAULT_AUTONOMOUS_WAKEUP_POLICY,
  type WorkItem,
  type Wakeup,
} from '../src/shared/work.js';

const initial = Date.parse('2030-01-15T07:50:00.000Z');
const due = Date.parse('2030-01-15T08:00:00.000Z');
const reservation: WakeupInput = {
  operation: 'upsert',
  key: 'review-result',
  name: 'Review pending result',
  purpose: 'Finish the room’s requested review.',
  reason: 'The result arrives later.',
  prompt: 'Read result.txt and report the outcome.',
  schedule: {
    type: 'once',
    dateTime: '2030-01-15T08:00',
    timeZone: 'UTC',
    missedRunPolicy: 'run_once',
  },
  checkpoint: {
    summary: 'Waiting for input',
    completed: 'Initial inspection finished',
    nextStep: 'Read result.txt',
    references: ['result.txt'],
    doneWhen: 'The review is reported',
    uncertainActions: [],
  },
};

async function fixture(t: TestContext, enabled = true) {
  t.mock.timers.enable({ apis: ['Date'], now: initial });
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-autonomous-work-'));
  const started: string[] = [];
  const stopped: string[] = [];
  const runtimeFactory = () => ({
    start(task: Task) {
      started.push(task.id);
    },
    async stop(taskId: string) {
      stopped.push(taskId);
    },
    async shutdown() {},
    queueState: () => ({ active: 0, waiting: 0 }),
  });
  const f = await createApp({
    dataDir,
    scheduler: false,
    runtimeFactory,
  });
  let running = f;
  await f.app.ready();
  f.store.put('settings', { ...f.store.settings(), id: 'main', demoMode: true, maxHandoffs: null });
  if (enabled)
    f.store.patch<Room>('rooms', 'room_lounge', {
      autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room' },
    });
  t.after(async () => {
    await running.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  function task(patch: Partial<NewTask> = {}) {
    return f.controller.enqueueTask({
      roomId: 'room_lounge',
      botId: 'bot_aster',
      prompt: 'Continue the review',
      ...patch,
    });
  }
  function schedule(source = task(), patch: Partial<WakeupInput> = {}) {
    return { source, ...f.controller.manageWakeup(source.id, { ...reservation, ...patch }) };
  }
  return {
    ...f,
    dataDir,
    started,
    stopped,
    task,
    schedule,
    async restart() {
      await running.app.close();
      running = await createApp({ dataDir, scheduler: false, runtimeFactory });
      await running.app.ready();
      return running;
    },
    advance(time: number) {
      t.mock.timers.setTime(time);
    },
    work(id: string) {
      return f.store.get<WorkItem>('workItems', id)!;
    },
    wake(id: string) {
      return f.store.get<Wakeup>('wakeups', id)!;
    },
    tasks() {
      return f.store.list<Task>('tasks');
    },
    complete(id: string) {
      f.controller.updateTask(id, { status: 'completed', completedAt: new Date().toISOString() });
    },
  };
}

test('legacy rooms stay off, expose empty work state and validate owner policy changes', async (t) => {
  const f = await fixture(t, false);
  const snapshot = (await f.app.inject({ method: 'GET', url: '/api/state' })).json();
  assert.equal(
    snapshot.rooms.find((room: Room) => room.id === 'room_lounge').autonomousWakeups,
    undefined,
  );
  assert.deepEqual(snapshot.workItems, []);
  assert.deepEqual(snapshot.wakeups, []);
  assert.throws(() => f.schedule(), /disabled/);
  const invalid = await f.app.inject({
    method: 'PATCH',
    url: '/api/rooms/room_lounge',
    payload: {
      autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room', maxRunsPerHour: 0 },
    },
  });
  assert.equal(invalid.statusCode, 400);
  const valid = await f.app.inject({
    method: 'PATCH',
    url: '/api/rooms/room_lounge',
    payload: {
      autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'self' },
    },
  });
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.json().autonomousWakeups.mode, 'self');
  const created = f.schedule();
  assert.equal(created.work.createdByBotId, 'bot_aster');
});

test('one-time wake-up admits an ordinary task atomically and carries work/run identity through a teammate handoff', async (t) => {
  const f = await fixture(t);
  const { source, work, wakeup } = f.schedule(f.task({ kind: 'automation' }), {
    botHandle: 'nova',
  });
  f.advance(due);
  f.controller.work.tick();
  assert.equal(f.tasks().length, 1, 'an unfinished source must hold its continuation');
  f.complete(source.id);
  f.controller.work.tick();
  const dispatched = f.wake(wakeup.id);
  assert.equal(dispatched.status, 'dispatched');
  assert.equal(dispatched.nextRunAt, undefined);
  const next = f.store.get<Task>('tasks', dispatched.lastTaskId!)!;
  assert.equal(next.botId, 'bot_nova');
  assert.equal(next.kind, 'automation');
  assert.equal(next.workId, work.id);
  assert.equal(next.workRunId, source.rootTaskId);
  assert.equal(next.wakeupId, wakeup.id);
  assert.match(next.prompt, /Waiting for input/);
  assert.match(next.prompt, /not a new user authorization/);
  const child = f.task({ parentTaskId: next.id, botId: 'bot_aster' });
  assert.equal(child.workId, work.id);
  assert.equal(child.workRunId, next.workRunId);
  f.controller.work.tick();
  assert.equal(f.tasks().length, 3, 'the consumed reservation cannot admit twice');
});

test('pending checks survive a legacy checkpoint update and database restart before a teammate wakes', async (t) => {
  const f = await fixture(t);
  const { source, work, wakeup } = f.schedule(undefined, { botHandle: 'nova' });
  const pendingChecks = ['Read the review status later.', 'Confirm the teammate ledger update.'];
  const saved = await f.controller.manageWork(source.id, {
    operation: 'update',
    workId: work.id,
    baseRevision: work.revision,
    checkpoint: { ...reservation.checkpoint!, pendingChecks },
  });
  const legacyUpdate = await f.controller.manageWork(source.id, {
    operation: 'update',
    workId: work.id,
    baseRevision: saved.revision,
    checkpoint: { ...reservation.checkpoint!, completed: 'The initial submission is verified.' },
  });
  assert.deepEqual(legacyUpdate.checkpoint.pendingChecks, pendingChecks);
  f.complete(source.id);

  const reopened = await f.restart();
  assert.deepEqual(reopened.store.get<WorkItem>('workItems', work.id), legacyUpdate);
  assert.equal(reopened.store.get<Wakeup>('wakeups', wakeup.id)?.status, 'scheduled');
  const snapshot = (await reopened.app.inject({ method: 'GET', url: '/api/state' })).json();
  assert.deepEqual(
    snapshot.workItems.find((item: WorkItem) => item.id === work.id).checkpoint.pendingChecks,
    pendingChecks,
  );
  f.advance(due);
  reopened.controller.work.tick();
  const dispatched = reopened.store.get<Wakeup>('wakeups', wakeup.id)!;
  assert.equal(dispatched.status, 'dispatched');
  const next = reopened.store.get<Task>('tasks', dispatched.lastTaskId!)!;
  assert.equal(next.botId, 'bot_nova');
  assert.equal(next.workId, work.id);
  for (const check of pendingChecks) assert.ok(next.prompt.includes(check));
  assert.equal(reopened.store.list('approvals').length, 0);
  assert.equal(reopened.store.get<WorkItem>('workItems', work.id)?.status, 'active');
});

test('owner resume preserves pending checks omitted by older clients and honors an explicit empty list', async (t) => {
  const f = await fixture(t);
  const pendingChecks = ['Inspect the publication date on the next wake.'];
  const { source, work, wakeup } = f.schedule(undefined, {
    checkpoint: { ...reservation.checkpoint!, pendingChecks },
  });
  f.complete(source.id);
  await f.controller.work.changeStatus(work.id, 'paused');
  const legacyResume = await f.app.inject({
    method: 'POST',
    url: `/api/work-items/${work.id}/resume`,
    payload: { checkpoint: reservation.checkpoint },
  });
  assert.equal(legacyResume.statusCode, 200, legacyResume.body);
  assert.deepEqual(legacyResume.json().checkpoint.pendingChecks, pendingChecks);
  assert.equal(f.wake(wakeup.id).status, 'scheduled');

  await f.controller.work.changeStatus(work.id, 'paused');
  const cleared = await f.app.inject({
    method: 'POST',
    url: `/api/work-items/${work.id}/resume`,
    payload: { checkpoint: { ...reservation.checkpoint, pendingChecks: [] } },
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.deepEqual(cleared.json().checkpoint.pendingChecks, []);
  assert.equal(cleared.json().status, 'active');
});

test('recurring work uses a fresh occurrence only at each calendar dispatch and coalesces missed days', async (t) => {
  const f = await fixture(t);
  const { source, wakeup } = f.schedule(undefined, {
    workKind: 'standing',
    schedule: { type: 'daily', time: '08:00', timeZone: 'UTC', missedRunPolicy: 'run_once' },
  });
  f.complete(source.id);
  f.advance(due);
  f.controller.work.tick();
  const first = f.store.get<Task>('tasks', f.wake(wakeup.id).lastTaskId!)!;
  assert.notEqual(first.workRunId, source.rootTaskId);
  f.complete(first.id);
  f.advance(Date.parse('2030-01-18T08:00:05.000Z'));
  f.controller.work.tick();
  const second = f.store.get<Task>('tasks', f.wake(wakeup.id).lastTaskId!)!;
  assert.notEqual(second.workRunId, first.workRunId);
  assert.equal(f.tasks().length, 3, 'missed days must not become a catch-up backlog');
  assert.equal(f.wake(wakeup.id).nextRunAt, '2030-01-19T08:00:00.000Z');
});

test('due reservations are admitted by reserved time before creation order', async (t) => {
  const f = await fixture(t);
  const later = f.schedule(undefined, {
    schedule: { ...reservation.schedule!, dateTime: '2030-01-15T08:10' },
  });
  f.advance(initial + 1);
  const earlier = f.schedule();
  f.complete(later.source.id);
  f.complete(earlier.source.id);

  f.advance(due + 10 * 60_000);
  f.controller.work.tick();
  assert.equal(
    f.wake(earlier.wakeup.id).status,
    'dispatched',
    'an older reserved occurrence must not lose the room slot to an earlier-created record',
  );
  assert.equal(f.wake(later.wakeup.id).status, 'scheduled');
  assert.equal(f.wake(later.wakeup.id).nextRunAt, '2030-01-15T08:10:00.000Z');

  f.complete(f.wake(earlier.wakeup.id).lastTaskId!);
  f.advance(due + 15 * 60_000);
  f.controller.work.tick();
  assert.equal(f.wake(later.wakeup.id).status, 'dispatched');
  assert.equal(f.tasks().filter((task) => task.kind === 'automation').length, 2);
});

test('a recurring reservation cannot keep starving an older unserved occurrence', async (t) => {
  const f = await fixture(t);
  const recurring = f.schedule(undefined, {
    workKind: 'standing',
    schedule: { type: 'daily', time: '08:00', timeZone: 'UTC', missedRunPolicy: 'run_once' },
  });
  f.advance(initial + 1);
  const once = f.schedule();
  f.complete(recurring.source.id);
  f.complete(once.source.id);
  // Changing a room's interval after reservations exist is supported. With one
  // slot each day, creation order would let this daily record monopolize it.
  f.store.patch<Room>('rooms', 'room_lounge', {
    autonomousWakeups: {
      ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY,
      mode: 'room',
      minIntervalMinutes: 1440,
    },
  });

  f.advance(due);
  f.controller.work.tick();
  const firstRun = f.wake(recurring.wakeup.id).lastTaskId;
  assert.ok(firstRun, 'creation order is a deterministic tie-break for equal reserved times');
  assert.equal(f.wake(once.wakeup.id).status, 'scheduled');
  f.complete(firstRun);

  f.advance(due + 86_400_000);
  f.controller.work.tick();
  assert.equal(
    f.wake(once.wakeup.id).status,
    'dispatched',
    "yesterday's unserved occurrence must run before the recurring reservation's next day",
  );
  assert.equal(f.wake(recurring.wakeup.id).lastTaskId, firstRun);
  assert.equal(f.wake(recurring.wakeup.id).nextRunAt, '2030-01-16T08:00:00.000Z');
  f.complete(f.wake(once.wakeup.id).lastTaskId!);

  f.advance(due + 2 * 86_400_000);
  f.controller.work.tick();
  assert.notEqual(f.wake(recurring.wakeup.id).lastTaskId, firstRun);
  assert.equal(f.wake(recurring.wakeup.id).nextRunAt, '2030-01-18T08:00:00.000Z');
  assert.equal(f.tasks().filter((task) => task.kind === 'automation').length, 3);
});

test('equal reserved and creation times keep a stable reservation order across room slots', async (t) => {
  const f = await fixture(t);
  const reservations = [f.schedule(), f.schedule(), f.schedule()];
  for (const item of reservations) f.complete(item.source.id);
  const expected = reservations.map((item) => item.wakeup.id).sort();

  for (const [index, wakeupId] of expected.entries()) {
    f.advance(due + index * DEFAULT_AUTONOMOUS_WAKEUP_POLICY.minIntervalMinutes * 60_000);
    f.controller.work.tick();
    const dispatched = f.wake(wakeupId);
    assert.equal(dispatched.status, 'dispatched');
    assert.equal(dispatched.lastRunAt, new Date(Date.now()).toISOString());
    assert.equal(
      f.tasks().filter((task) => task.kind === 'automation').length,
      index + 1,
      'stable tie-breaking must still respect room dispatch spacing',
    );
    f.complete(dispatched.lastTaskId!);
  }
});

test('held earlier occurrences do not prevent eligible work in their room or another room', async (t) => {
  const f = await fixture(t);
  const busy = f.schedule();
  const blocked = f.schedule();
  const retrying = f.schedule();
  f.complete(blocked.source.id);
  f.complete(retrying.source.id);
  f.store.patch<WorkItem>('workItems', blocked.work.id, { status: 'blocked' });
  f.store.patch<Wakeup>('wakeups', retrying.wakeup.id, {
    retryAfter: new Date(due + 6 * 60_000).toISOString(),
  });
  const schedule = { ...reservation.schedule!, dateTime: '2030-01-15T08:05' };
  const eligible = f.schedule(undefined, { schedule });
  f.complete(eligible.source.id);
  f.store.put<Room>('rooms', {
    ...f.store.get<Room>('rooms', 'room_lounge')!,
    id: 'room_other',
    name: 'Independent room',
  });
  const other = f.schedule(f.task({ roomId: 'room_other' }), { schedule });
  f.complete(other.source.id);

  f.advance(due + 5 * 60_000);
  f.controller.work.tick();
  for (const held of [busy, blocked, retrying])
    assert.equal(f.wake(held.wakeup.id).status, 'scheduled');
  for (const ready of [eligible, other]) assert.equal(f.wake(ready.wakeup.id).status, 'dispatched');
  assert.equal(f.tasks().filter((task) => task.kind === 'automation').length, 2);
});

test('a missed one-time reservation is visible as missed without inventing a task', async (t) => {
  const f = await fixture(t);
  const { source, wakeup, work } = f.schedule(undefined, {
    schedule: { ...reservation.schedule!, missedRunPolicy: 'skip' },
  });
  f.complete(source.id);
  f.advance(due + 60_000);
  f.controller.work.tick();
  assert.equal(f.wake(wakeup.id).status, 'missed');
  assert.equal(f.wake(wakeup.id).nextRunAt, undefined);
  assert.equal(f.tasks().length, 1);
  assert.equal(f.work(work.id).status, 'active');
});

test('room hourly admission budget holds due reservations until the rolling window frees capacity', async (t) => {
  const f = await fixture(t);
  f.store.patch<Room>('rooms', 'room_lounge', {
    autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room', maxRunsPerHour: 1 },
  });
  const { source, work, wakeup } = f.schedule();
  f.complete(source.id);
  f.advance(due);
  f.controller.work.tick();
  assert.equal(f.work(work.id).status, 'active');
  assert.equal(f.wake(wakeup.id).status, 'scheduled');
  assert.equal(f.wake(wakeup.id).nextRunAt, new Date(due).toISOString());
  assert.match(f.wake(wakeup.id).lastError!, /hourly/);
  assert.equal(f.tasks().length, 1);
  f.advance(initial + 3_600_001);
  f.controller.work.tick();
  assert.equal(f.tasks().length, 2);
  assert.equal(f.wake(wakeup.id).status, 'dispatched');
});

test('an admission failure after persistence rolls back both task and reservation consumption', async (t) => {
  const f = await fixture(t);
  const { source, work, wakeup } = f.schedule();
  f.complete(source.id);
  f.advance(due);
  const enqueue = f.controller.enqueueTask;
  const mock = t.mock.method(f.controller, 'enqueueTask', (input: NewTask) => {
    enqueue(input);
    throw new Error('Fixture admission failed after its task write');
  });
  f.controller.work.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.tasks().length, 1);
  assert.equal(f.wake(wakeup.id).status, 'scheduled');
  assert.equal(f.wake(wakeup.id).lastTaskId, undefined);
  assert.equal(f.work(work.id).status, 'blocked');
  assert.equal(f.started.filter((id) => id !== source.id).length, 0);
  mock.mock.restore();
  assert.equal(
    (await f.app.inject({ method: 'POST', url: `/api/work-items/${work.id}/resume` })).statusCode,
    200,
  );
  f.advance(due + 60_000);
  f.controller.work.tick();
  assert.equal(f.tasks().length, 2);
  assert.equal(f.wake(wakeup.id).status, 'dispatched');
});

test('owner pause stops associated tasks, holds reservations, and resumes only after explicit review', async (t) => {
  const f = await fixture(t);
  const { source, work, wakeup } = f.schedule();
  const child = f.task({ parentTaskId: source.id, botId: 'bot_nova' });
  const pause = await f.app.inject({ method: 'POST', url: `/api/work-items/${work.id}/pause` });
  assert.equal(pause.statusCode, 200);
  assert.equal(pause.json().status, 'paused');
  assert.equal(f.store.get<Task>('tasks', source.id)!.status, 'stopped');
  assert.equal(f.store.get<Task>('tasks', child.id)!.status, 'stopped');
  assert.equal(f.wake(wakeup.id).status, 'scheduled');
  f.advance(due);
  f.controller.work.tick();
  assert.equal(f.tasks().length, 2);
  assert.equal(
    (await f.app.inject({ method: 'POST', url: `/api/work-items/${work.id}/resume` })).statusCode,
    200,
  );
  assert.equal(f.tasks().length, 2, 'resuming work does not silently retry failed/stopped tasks');
  f.controller.work.tick();
  assert.equal(f.tasks().length, 3);
});

test('owner stop revokes every reservation and descendant while ordinary manual chat remains available', async (t) => {
  const f = await fixture(t);
  const { source, work, wakeup } = f.schedule();
  const second = f.controller.manageWakeup(source.id, {
    operation: 'upsert',
    key: 'second',
    botHandle: 'nova',
    reason: 'A teammate follows up',
    prompt: 'Inspect the review',
    schedule: reservation.schedule,
  });
  const child = f.task({ parentTaskId: source.id, botId: 'bot_nova' });
  const stop = await f.app.inject({ method: 'POST', url: `/api/work-items/${work.id}/stop` });
  assert.equal(stop.statusCode, 200);
  assert.equal(stop.json().status, 'cancelled');
  for (const wake of [wakeup, second.wakeup]) assert.equal(f.wake(wake.id).status, 'cancelled');
  for (const task of [source, child])
    assert.equal(f.store.get<Task>('tasks', task.id)!.status, 'stopped');
  assert.equal(
    (await f.app.inject({ method: 'POST', url: `/api/work-items/${work.id}/resume` })).statusCode,
    409,
  );
  assert.throws(() => f.task({ parentTaskId: child.id }), /cancelled/);
  assert.equal(f.task().workId, undefined);
  f.advance(due);
  f.controller.work.tick();
  assert.equal(f.tasks().length, 3);
});

test('room opt-out and room-to-self narrowing pause existing work without automatic revival', async (t) => {
  const f = await fixture(t);
  const { source, work, wakeup } = f.schedule(undefined, { botHandle: 'nova' });
  const narrow = await f.app.inject({
    method: 'PATCH',
    url: '/api/rooms/room_lounge',
    payload: {
      autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'self' },
    },
  });
  assert.equal(narrow.statusCode, 200);
  assert.equal(f.work(work.id).status, 'paused');
  assert.equal(f.store.get<Task>('tasks', source.id)!.status, 'stopped');
  for (const mode of ['off', 'room']) {
    const response = await f.app.inject({
      method: 'PATCH',
      url: '/api/rooms/room_lounge',
      payload: {
        autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode },
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(f.work(work.id).status, 'paused');
  }
  f.advance(due);
  f.controller.work.tick();
  assert.equal(f.wake(wakeup.id).status, 'scheduled');
  assert.equal(f.tasks().length, 1);
});

test('disabling a reserved teammate pauses its work until the owner explicitly resumes it', async (t) => {
  const f = await fixture(t);
  const { source, work } = f.schedule(undefined, { botHandle: 'nova' });
  f.complete(source.id);
  const disabled = await f.app.inject({
    method: 'PATCH',
    url: '/api/bots/bot_nova',
    payload: { enabled: false },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(f.work(work.id).status, 'paused');
  assert.equal(f.store.get<Bot>('bots', 'bot_nova')!.enabled, false);
  assert.equal(
    (await f.app.inject({ method: 'PATCH', url: '/api/bots/bot_nova', payload: { enabled: true } }))
      .statusCode,
    200,
  );
  f.advance(due);
  f.controller.work.tick();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.work(work.id).status, 'paused');
});

test('workspace changes preserve pinned work and require restoring its original workspace for recovery', async (t) => {
  const f = await fixture(t);
  const { source, work } = f.schedule();
  f.complete(source.id);
  const changed = await f.app.inject({
    method: 'PATCH',
    url: '/api/rooms/room_lounge',
    payload: {
      workspacePath: join(f.dataDir, 'alternate-workspace'),
    },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(f.work(work.id).status, 'paused');
  assert.equal(f.work(work.id).workspacePath, work.workspacePath);
  const resume = await f.app.inject({ method: 'POST', url: `/api/work-items/${work.id}/resume` });
  assert.equal(resume.statusCode, 409);
  assert.match(resume.json().error, /original workspace/);
});
