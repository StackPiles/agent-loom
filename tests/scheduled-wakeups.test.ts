import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createScheduler } from '../src/server/scheduler.js';
import type { Automation, AutomationSchedule, Notification, Task } from '../src/shared/types.js';
import type { NewTask } from '../src/server/runtime/contract.js';

const reserved = '2026-11-02T09:00:00.000Z';
const once = (policy: 'run_once' | 'skip' = 'run_once'): AutomationSchedule => ({
  type: 'once',
  dateTime: '2026-11-02T09:00',
  timeZone: 'UTC',
  missedRunPolicy: policy,
});
const daily = (policy: 'run_once' | 'skip' = 'run_once'): AutomationSchedule => ({
  type: 'daily',
  time: '09:00',
  timeZone: 'UTC',
  missedRunPolicy: policy,
});

function fixture(t: TestContext, initial = '2026-11-02T09:00:05Z') {
  const directory = mkdtempSync(join(tmpdir(), 'loom-wakeups-'));
  let store = new Store(directory);
  store.seed();
  let time = Date.parse(initial);
  let attempts = 0;
  let failure: 'before' | 'after' | undefined;
  const notifications: Notification[] = [];
  const enqueueTask = (input: NewTask): Task => {
    attempts++;
    if (failure === 'before') throw new Error('Model is not configured.');
    const task: Task = {
      id: `task_${attempts}`,
      roomId: input.roomId,
      botId: input.botId,
      prompt: input.prompt,
      status: 'queued',
      rootTaskId: `task_${attempts}`,
      depth: 0,
      kind: 'automation',
      output: '',
      inputTokens: 0,
      outputTokens: 0,
      createdAt: new Date(time).toISOString(),
      updatedAt: new Date(time).toISOString(),
    };
    store.put('tasks', task);
    if (failure === 'after') throw new Error('Admission failed after persisting its task.');
    return task;
  };
  function makeScheduler() {
    return createScheduler(
      {
        store,
        enqueueTask,
        changed() {},
        notify(input) {
          const item: Notification = {
            ...input,
            id: `notice_${notifications.length}`,
            read: false,
            createdAt: new Date(time).toISOString(),
          };
          notifications.push(item);
          return item;
        },
      },
      { clock: () => time },
    );
  }
  let scheduler = makeScheduler();
  t.after(async () => {
    await scheduler.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    get scheduler() {
      return scheduler;
    },
    get attempts() {
      return attempts;
    },
    notifications,
    setFailure(value?: 'before' | 'after') {
      failure = value;
    },
    setTime(value: string) {
      time = Date.parse(value);
    },
    advance(ms: number) {
      time += ms;
    },
    add(schedule: AutomationSchedule, patch: Partial<Automation> = {}) {
      return store.put<Automation>('automations', {
        id: 'wake',
        name: 'Reserved check',
        kind: 'schedule',
        enabled: true,
        roomId: 'room_lounge',
        botId: 'bot_aster',
        prompt: 'Report the result.',
        intervalMinutes: 60,
        sourceUrl: '',
        schedule,
        createdAt: '2026-11-01T10:00:00.000Z',
        nextRunAt: reserved,
        ...patch,
      });
    },
    rule() {
      return store.get<Automation>('automations', 'wake')!;
    },
    tasks() {
      return store.list<Task>('tasks');
    },
    async cycle() {
      scheduler.start();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await scheduler.stop();
    },
    async restart() {
      await scheduler.stop();
      store.close();
      store = new Store(directory);
      scheduler = makeScheduler();
    },
  };
}

test('one-time wake-up is dispatched once and consumption survives a database reopen', async (t) => {
  const f = fixture(t);
  f.add(once());
  await f.cycle();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.rule().enabled, false);
  assert.equal(f.rule().scheduleStatus, 'fired');
  assert.equal(f.rule().nextRunAt, undefined);
  assert.equal(f.rule().lastRunAt, '2026-11-02T09:00:05.000Z');
  assert.match(f.tasks()[0].prompt, /2026-11-02T09:00:00.000Z/);
  await f.restart();
  f.advance(86_400_000);
  await f.cycle();
  assert.equal(f.tasks().length, 1);
  await f.restart();
  await assert.rejects(f.scheduler.run('wake'), /one-time wake-up has finished/);
  assert.equal(
    f.rule().lastError,
    undefined,
    'an explicit duplicate action is not a new automation failure',
  );
});

test('late recurring wake-ups coalesce to one task and retain local weekday clock times', async (t) => {
  const f = fixture(t, '2026-11-16T12:34:00Z');
  f.add(
    {
      type: 'weekly',
      time: '09:00',
      weekdays: [1, 3, 5],
      timeZone: 'Asia/Tokyo',
      missedRunPolicy: 'run_once',
    },
    {
      nextRunAt: '2026-11-02T00:00:00.000Z',
    },
  );
  await f.cycle();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.rule().nextRunAt, '2026-11-18T00:00:00.000Z');
  await f.restart();
  await f.cycle();
  assert.equal(f.tasks().length, 1, 'missed dates are not replayed one by one');
});

test('skip policy permits ordinary polling delay but finishes one-time wake-ups at the one-minute boundary', async (t) => {
  const f = fixture(t, '2026-11-02T09:00:59.999Z');
  f.add(once('skip'));
  await f.cycle();
  assert.equal(f.tasks().length, 1, 'normal polling delay does not discard a reservation');
  f.add(once('skip'), { id: 'wake_missed' });
  f.setTime('2026-11-02T09:01:00.000Z');
  await f.cycle();
  const missed = f.store.get<Automation>('automations', 'wake_missed')!;
  assert.equal(missed.scheduleStatus, 'missed');
  assert.equal(missed.enabled, false);
  assert.equal(missed.lastRunAt, undefined);
  assert.equal(missed.nextRunAt, undefined);
  assert.equal(f.tasks().length, 1);
  assert.equal(f.notifications.length, 1);
  await f.restart();
  await assert.rejects(f.scheduler.run('wake_missed'), /one-time wake-up has finished/);
});

test('skip advances a late daily occurrence without enqueuing or shifting the next clock time', async (t) => {
  const f = fixture(t, '2026-11-05T12:34:00Z');
  f.add(daily('skip'));
  await f.cycle();
  assert.equal(f.tasks().length, 0);
  assert.equal(f.rule().nextRunAt, '2026-11-06T09:00:00.000Z');
  assert.equal(f.rule().enabled, true);
  f.setTime('2026-11-06T09:00:05Z');
  await f.cycle();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.rule().nextRunAt, '2026-11-07T09:00:00.000Z');
});

test('busy run-once recovery retains a single due occurrence until the previous task settles', async (t) => {
  const f = fixture(t, '2026-11-01T08:00:00Z');
  f.add(daily(), { nextRunAt: '2026-11-01T09:00:00.000Z' });
  await f.scheduler.run('wake');
  const first = f.tasks()[0];
  f.setTime('2026-11-02T12:00:00Z');
  await f.cycle();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.rule().nextRunAt, '2026-11-01T09:00:00.000Z');
  f.advance(86_400_000);
  await f.cycle();
  assert.equal(f.tasks().length, 1);
  f.store.patch<Task>('tasks', first.id, { status: 'completed' });
  await f.cycle();
  assert.equal(f.tasks().length, 2);
  assert.equal(f.rule().nextRunAt, '2026-11-04T09:00:00.000Z');
});

test('calendar admission failures back off across restart without consuming the original reservation', async (t) => {
  const f = fixture(t);
  f.add(once());
  f.setFailure('before');
  await f.cycle();
  assert.equal(f.attempts, 1);
  assert.equal(f.rule().enabled, true);
  assert.equal(f.rule().scheduleStatus, undefined);
  assert.equal(f.rule().nextRunAt, reserved);
  assert.equal(f.rule().lastRunAt, undefined);
  assert.equal(f.notifications.length, 1);
  f.advance(10_000);
  await f.cycle();
  assert.equal(f.attempts, 1);
  await f.restart();
  f.advance(10_000);
  await f.cycle();
  assert.equal(f.attempts, 1, 'backoff is persisted rather than reset by restart');
  f.advance(40_000);
  await f.cycle();
  assert.equal(f.attempts, 2);
  assert.equal(f.notifications.length, 1, 'the same error is not repeatedly notified');
  f.setFailure();
  f.advance(60_000);
  await f.cycle();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.rule().scheduleStatus, 'fired');
  assert.equal(f.rule().lastError, undefined);
});

test('calendar task admission and reservation consumption roll back together', async (t) => {
  const f = fixture(t);
  f.add(once());
  f.setFailure('after');
  await f.cycle();
  assert.equal(f.tasks().length, 0, 'a partially persisted task is rolled back');
  assert.equal(
    f.store.get<{ lastTaskId?: string }>('automationState', 'wake')?.lastTaskId,
    undefined,
  );
  assert.equal(f.rule().enabled, true);
  assert.equal(f.rule().nextRunAt, reserved);
  f.setFailure();
  f.advance(60_000);
  await f.cycle();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.rule().scheduleStatus, 'fired');
});

test('manual one-time wake-ups consume their reservation and disabled repeating rules stay disabled', async (t) => {
  const f = fixture(t, '2026-11-02T08:00:00Z');
  f.add(once(), { enabled: false, nextRunAt: undefined });
  await f.scheduler.run('wake');
  assert.equal(f.rule().enabled, false);
  assert.equal(f.rule().scheduleStatus, 'fired');
  assert.equal(f.rule().nextRunAt, undefined);
  assert.equal(f.tasks().length, 1);
  await assert.rejects(f.scheduler.run('wake'), /one-time wake-up has finished/);
  f.add(daily(), { id: 'daily_disabled', enabled: false, nextRunAt: undefined });
  await f.scheduler.run('daily_disabled');
  const disabled = f.store.get<Automation>('automations', 'daily_disabled')!;
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.nextRunAt, undefined);
  assert.equal(f.tasks().length, 2);
});

test('busy skip rules drop the overdue occurrence and folded local times are not dispatched twice', async (t) => {
  const f = fixture(t, '2026-11-01T05:30:05Z');
  f.add(
    { type: 'daily', time: '01:30', timeZone: 'America/New_York', missedRunPolicy: 'skip' },
    {
      nextRunAt: '2026-11-01T05:30:00.000Z',
    },
  );
  await f.cycle();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.rule().nextRunAt, '2026-11-02T06:30:00.000Z');
  f.setTime('2026-11-01T06:30:05Z');
  await f.cycle();
  assert.equal(f.tasks().length, 1, 'the second 01:30 in a DST fold is not another occurrence');
  f.setTime('2026-11-02T06:31:00Z');
  await f.cycle();
  assert.equal(
    f.tasks().length,
    1,
    'an active prior task does not cause a late skipped occurrence to queue',
  );
  assert.equal(f.rule().nextRunAt, '2026-11-03T06:30:00.000Z');
});
