import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/server/controller.js';
import { Store } from '../src/server/store.js';
import type { NewTask } from '../src/server/runtime/contract.js';
import type { WakeupInput } from '../src/server/work.js';
import type { Bot, Room, Task } from '../src/shared/types.js';
import {
  DEFAULT_AUTONOMOUS_WAKEUP_POLICY,
  type Wakeup,
  type WorkItem,
} from '../src/shared/work.js';

const checkpoint = {
  summary: 'The input is expected later.',
  completed: 'Inspected the current input.',
  nextStep: 'Review the new input and report the result.',
  references: ['result.txt'],
  doneWhen: 'The requested review is complete.',
  uncertainActions: [],
};

async function fixture(t: TestContext, mode: 'self' | 'room' = 'room') {
  const directory = await mkdtemp(join(tmpdir(), 'loom-work-review-'));
  const store = new Store(directory);
  store.seed();
  store.put('settings', { ...store.settings(), id: 'main', demoMode: true, maxHandoffs: null });
  store.patch<Room>('rooms', 'room_lounge', {
    autonomousWakeups: {
      ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY,
      mode,
      maxRunsPerHour: 100,
    },
  });
  let controller = new Controller(store);
  t.after(async () => {
    await controller.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const start = (patch: Partial<NewTask> = {}) =>
    controller.enqueueTask({
      roomId: 'room_lounge',
      botId: 'bot_aster',
      prompt: 'Review the current project when the next input arrives.',
      ...patch,
    });
  const reserve = (task: Task, patch: Partial<WakeupInput> = {}) =>
    controller.work.manageWakeup(task.id, {
      operation: 'upsert',
      key: 'review-input',
      name: 'Review the next input',
      purpose: 'Finish the assigned project review.',
      reason: 'The next input arrives later.',
      prompt: 'Inspect result.txt and finish the review.',
      checkpoint,
      schedule: {
        type: 'once',
        dateTime: '2099-06-15T09:00',
        timeZone: 'UTC',
        missedRunPolicy: 'run_once',
      },
      ...patch,
    });
  return {
    store,
    get controller() {
      return controller;
    },
    start,
    reserve,
    async restart() {
      await controller.shutdown();
      controller = new Controller(store);
      return controller;
    },
  };
}

test('a bot cannot downgrade an owner cancellation and then recreate that reservation', async (t) => {
  const f = await fixture(t);
  const caller = f.start();
  const { work, wakeup } = f.reserve(caller);
  const ownerCancelled = f.controller.work.cancelWakeup(wakeup.id);
  const botCancelled = f.controller.work.manageWakeup(caller.id, {
    operation: 'cancel',
    workId: work.id,
    wakeupId: wakeup.id,
    baseRevision: ownerCancelled.revision,
  });
  assert.equal(botCancelled.wakeup.cancelledBy, 'owner');
  assert.throws(
    () =>
      f.controller.work.manageWakeup(caller.id, {
        operation: 'upsert',
        wakeupId: wakeup.id,
        baseRevision: botCancelled.wakeup.revision,
      }),
    /owner cancelled/,
  );
  assert.throws(
    () =>
      f.controller.work.manageWakeup(caller.id, {
        operation: 'upsert',
        workId: work.id,
        key: wakeup.key,
        baseRevision: botCancelled.wakeup.revision,
      }),
    /owner cancelled/,
  );
  assert.equal(f.store.list<Wakeup>('wakeups').length, 1);
});

test('a delegated bot binds only its own subtree and the parent can establish independent work later', async (t) => {
  const f = await fixture(t, 'self');
  const parent = f.start();
  const delegated = f.start({ parentTaskId: parent.id, botId: 'bot_nova' });
  const sibling = f.start({ parentTaskId: parent.id });
  const grandchild = f.start({ parentTaskId: delegated.id });
  const own = f.reserve(delegated);
  assert.equal(f.store.get<Task>('tasks', parent.id)?.workId, undefined);
  assert.equal(f.store.get<Task>('tasks', sibling.id)?.workId, undefined);
  assert.equal(f.store.get<Task>('tasks', grandchild.id)?.workId, own.work.id);

  const coordinator = f.reserve(parent, { name: 'Coordinate the project' });
  assert.notEqual(coordinator.work.id, own.work.id);
  assert.equal(f.store.get<Task>('tasks', parent.id)?.workId, coordinator.work.id);
  assert.equal(f.store.get<Task>('tasks', sibling.id)?.workId, coordinator.work.id);
  assert.equal(f.store.get<Task>('tasks', delegated.id)?.workId, own.work.id);
  assert.equal(f.store.get<Task>('tasks', grandchild.id)?.workId, own.work.id);
  const later = f.start({ parentTaskId: delegated.id });
  assert.equal(later.workId, own.work.id, 'future descendants inherit their immediate parent');
  assert.equal(later.workRunId, parent.id, 'branching never resets the originating occurrence');
});

test('separate sibling work items and unbound ancestors share the finite occurrence admission budget', async (t) => {
  const f = await fixture(t);
  const parent = f.start();
  const first = f.start({ parentTaskId: parent.id, botId: 'bot_nova' });
  const second = f.start({ parentTaskId: parent.id });
  const one = f.reserve(first);
  const two = f.reserve(second);
  assert.equal(f.store.get<Task>('tasks', parent.id)?.workId, undefined);
  f.start({ parentTaskId: parent.id, kind: 'learning' });
  f.store.put('settings', { ...f.store.settings(), id: 'main', maxHandoffs: 2 });
  for (const work of [one.work, two.work]) {
    assert.throws(
      () =>
        f.start({
          kind: 'automation',
          workId: work.id,
          workRunId: parent.id,
        }),
      /work occurrence reached its task and handoff limit/,
    );
  }
  assert.equal(f.store.list<Task>('tasks').filter((task) => task.kind !== 'learning').length, 3);
});

test('explicit task recovery preserves its identity and succeeds at both admission limits', async (t) => {
  const f = await fixture(t);
  const caller = f.start();
  const { work } = f.reserve(caller);
  f.store.put('settings', { ...f.store.settings(), id: 'main', maxHandoffs: 0 });
  const room = f.store.get<Room>('rooms', caller.roomId)!;
  f.store.patch<Room>('rooms', room.id, {
    autonomousWakeups: { ...room.autonomousWakeups!, maxRunsPerHour: 1 },
  });
  await f.controller.stop(caller.id);
  assert.equal(f.store.get<WorkItem>('workItems', work.id)?.status, 'blocked');
  f.controller.work.resume(work.id);
  const resumed = f.controller.resume(caller.id);
  assert.equal(resumed.id, caller.id);
  assert.equal(resumed.workId, work.id);
  assert.equal(resumed.workRunId, caller.rootTaskId);
  assert.equal(f.store.list<Task>('tasks').length, 1, 'recovery adds no new occurrence');
  assert.throws(
    () =>
      f.start({
        kind: 'automation',
        workId: work.id,
        workRunId: resumed.workRunId,
      }),
    /work occurrence reached/,
  );
  f.store.put('settings', { ...f.store.settings(), id: 'main', maxHandoffs: null });
  assert.throws(
    () =>
      f.start({
        kind: 'automation',
        workId: work.id,
        workRunId: resumed.workRunId,
      }),
    /hourly autonomous execution limit/,
  );
});

test('owner resume rejects unavailable creators and incompatible pending wakes before changing state', async (t) => {
  const f = await fixture(t);
  const caller = f.start();
  const { work, wakeup } = f.reserve(caller, { botHandle: 'nova' });
  await f.controller.work.changeStatus(work.id, 'paused');
  f.store.patch<Bot>('bots', 'bot_aster', { enabled: false });
  assert.throws(() => f.controller.work.resume(work.id), /creator.*membership/);
  assert.equal(f.store.get<WorkItem>('workItems', work.id)?.status, 'paused');
  assert.equal(f.store.get<WorkItem>('workItems', work.id)?.reviewedAt, undefined);

  f.store.patch<Bot>('bots', 'bot_aster', { enabled: true });
  f.store.patch<Bot>('bots', 'bot_nova', { enabled: false });
  assert.throws(() => f.controller.work.resume(work.id), /enabled author and target/);
  f.store.patch<Bot>('bots', 'bot_nova', { enabled: true });
  const room = f.store.get<Room>('rooms', 'room_lounge')!;
  f.store.patch<Room>('rooms', room.id, { botIds: ['bot_aster'] });
  assert.throws(() => f.controller.work.resume(work.id), /enabled author and target/);
  f.store.patch<Room>('rooms', room.id, {
    botIds: room.botIds,
    autonomousWakeups: { ...room.autonomousWakeups!, mode: 'self' },
  });
  assert.throws(() => f.controller.work.resume(work.id), /self-only wake-up policy/);
  assert.equal(f.store.get<WorkItem>('workItems', work.id)?.status, 'paused');
  f.controller.work.cancelWakeup(wakeup.id);
  assert.equal(
    f.controller.work.resume(work.id).status,
    'active',
    'the owner can remove the incompatible reservation and resume the remaining work',
  );
});

test('startup honors an owner review of a failed source while a later failure blocks work again', async (t) => {
  const f = await fixture(t);
  const caller = f.start();
  const { work } = f.reserve(caller);
  f.controller.updateTask(caller.id, { status: 'failed', error: 'Review the previous attempt.' });
  f.store.patch<Task>('tasks', caller.id, {
    updatedAt: new Date(Date.now() - 10_000).toISOString(),
  });
  const reviewed = f.controller.work.resume(work.id);
  await f.restart();
  assert.equal(
    f.store.get<Task>('tasks', caller.id)?.status,
    'failed',
    'review does not rerun the old task',
  );
  assert.equal(f.store.get<WorkItem>('workItems', work.id)?.status, 'active');
  const laterFailure = f.store.patch<Task>('tasks', caller.id, {
    updatedAt: new Date(Date.parse(reviewed.reviewedAt!) + 1).toISOString(),
  });
  f.controller.work.taskSettled(laterFailure);
  assert.equal(f.store.get<WorkItem>('workItems', work.id)?.status, 'blocked');
});

test('a resumed task failing under the same frozen clock blocks its work again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00Z') });
  const f = await fixture(t);
  const caller = f.start();
  const { work } = f.reserve(caller);
  f.controller.updateTask(caller.id, { status: 'failed', error: 'First failure.' });
  const reviewed = f.controller.work.resume(work.id);
  f.controller.resume(caller.id);
  f.controller.updateTask(caller.id, {
    status: 'failed',
    error: 'The reviewed task failed again.',
  });
  assert.equal(f.store.get<Task>('tasks', caller.id)?.updatedAt, reviewed.reviewedAt);
  assert.equal(f.store.get<WorkItem>('workItems', work.id)?.status, 'blocked');
});

test('different work keys in one room cannot bypass minimum scheduled dispatch spacing', async (t) => {
  const f = await fixture(t);
  const sources = [f.start(), f.start({ botId: 'bot_nova' })];
  const reservations = sources.map((source) => f.reserve(source));
  for (let i = 0; i < sources.length; i++) {
    f.controller.updateTask(sources[i].id, { status: 'completed' });
    f.store.patch<Wakeup>('wakeups', reservations[i].wakeup.id, {
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
  }
  f.controller.work.tick();
  const dispatched = f.store.list<Wakeup>('wakeups').find((wake) => wake.status === 'dispatched')!;
  assert.ok(dispatched);
  assert.equal(f.store.list<Task>('tasks').filter((task) => task.kind === 'automation').length, 1);
  f.controller.updateTask(dispatched.lastTaskId!, { status: 'completed' });
  f.controller.work.cancelWakeup(dispatched.id);
  f.controller.work.tick();
  assert.equal(
    f.store.list<Task>('tasks').filter((task) => task.kind === 'automation').length,
    1,
    'finishing or cancelling the prior reservation does not reset the room interval',
  );
  const minimum = f.store.get<Room>('rooms', 'room_lounge')!.autonomousWakeups!.minIntervalMinutes;
  t.mock.method(Date, 'now', () => Date.parse(dispatched.lastRunAt!) + minimum * 60_000);
  f.controller.work.tick();
  assert.equal(f.store.list<Task>('tasks').filter((task) => task.kind === 'automation').length, 2);
});

test('existing wake and checkpoint mutations require their own current revisions', async (t) => {
  const f = await fixture(t);
  const caller = f.start();
  const { work, wakeup } = f.reserve(caller);
  const changedWake: WakeupInput = {
    operation: 'upsert',
    workId: work.id,
    key: wakeup.key,
    reason: 'The input arrives later than expected.',
  };
  assert.throws(() => f.controller.work.manageWakeup(caller.id, changedWake), /baseRevision/);
  assert.throws(
    () =>
      f.controller.work.manageWakeup(caller.id, {
        ...changedWake,
        baseRevision: wakeup.revision + 1,
      }),
    /record changed/,
  );
  const changed = f.controller.work.manageWakeup(caller.id, {
    ...changedWake,
    baseRevision: wakeup.revision,
  });
  assert.equal(changed.wakeup.reason, changedWake.reason);
  assert.equal(changed.work.revision, work.revision);
  assert.throws(
    () =>
      f.controller.work.manageWakeup(caller.id, {
        operation: 'upsert',
        wakeupId: wakeup.id,
        baseRevision: changed.wakeup.revision,
        checkpoint: { ...checkpoint, summary: 'An attempted unversioned checkpoint.' },
      }),
    /only for new work/,
  );
  await assert.rejects(
    f.controller.work.manageWork(caller.id, {
      operation: 'update',
      workId: work.id,
      checkpoint,
    }),
    /baseRevision/,
  );
  const current = await f.controller.work.manageWork(caller.id, {
    operation: 'update',
    workId: work.id,
    baseRevision: work.revision,
    checkpoint: { ...checkpoint, summary: 'A verified checkpoint update.' },
  });
  await assert.rejects(
    f.controller.work.manageWork(caller.id, {
      operation: 'update',
      workId: work.id,
      baseRevision: work.revision,
      checkpoint,
    }),
    /record changed/,
  );
  assert.equal(
    f.store.get<WorkItem>('workItems', work.id)?.checkpoint.summary,
    current.checkpoint.summary,
  );
});
