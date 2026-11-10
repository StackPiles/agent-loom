import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { createTools, operationKey } from '../src/server/runtime/tools.js';
import type { OperationRecord, ToolContext } from '../src/server/runtime/contract.js';
import type { Approval, Bot, Room, Task } from '../src/shared/types.js';
import {
  DEFAULT_AUTONOMOUS_WAKEUP_POLICY,
  type AutonomousWakeupPolicy,
  type Wakeup,
  type WorkItem,
} from '../src/shared/work.js';

const calendarCreate = {
  operation: 'create',
  kind: 'schedule',
  name: 'Morning review',
  prompt: 'Review the project result and report the verified outcome.',
  schedule: {
    type: 'once',
    dateTime: '2099-06-15T09:00',
    timeZone: 'Asia/Tokyo',
    missedRunPolicy: 'run_once',
  },
};
const canonicalCreate = {
  operation: 'upsert',
  key: 'review-result',
  name: 'Review the project result',
  purpose: 'Finish the review when the result is ready.',
  reason: 'The result will be ready tomorrow.',
  prompt: calendarCreate.prompt,
  schedule: calendarCreate.schedule,
  checkpoint: {
    summary: 'Waiting for the result.',
    completed: '',
    nextStep: 'Read and review the result.',
    references: ['result.txt'],
    doneWhen: 'The verified review has been reported.',
    uncertainActions: [],
  },
};
type ReservationResult = { work: WorkItem; wakeup: Wakeup; note: string };

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-automation-wakeups-'));
  const f = await createApp({
    dataDir,
    scheduler: false,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  await f.app.ready();
  f.store.put('settings', { ...f.store.settings(), id: 'main', demoMode: true });
  function policy(patch: Partial<AutonomousWakeupPolicy>) {
    const room = f.store.get<Room>('rooms', 'room_lounge')!;
    return f.store.patch<Room>('rooms', room.id, {
      autonomousWakeups: {
        ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY,
        ...room.autonomousWakeups,
        ...patch,
      },
    });
  }
  policy({ mode: 'self' });
  t.after(async () => {
    await f.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  function forTask(task: Task, waitForRoom?: ToolContext['waitForRoom']) {
    const abort = new AbortController();
    const context: ToolContext = {
      host: f.controller,
      task,
      settings: f.store.settings(),
      signal: abort.signal,
      operationKeys: new Set(),
      waitForRoom,
    };
    return { task, abort, context, registry: createTools(context) };
  }
  function tools(waitForRoom?: ToolContext['waitForRoom']) {
    return forTask(
      f.controller.enqueueTask({
        roomId: 'room_lounge',
        botId: 'bot_aster',
        prompt: 'Schedule the requested project review.',
      }),
      waitForRoom,
    );
  }
  function noOwnerRulesOrApprovals() {
    assert.equal(f.store.list('automations').length, 0);
    assert.equal(f.store.list('approvals').length, 0);
  }
  return { ...f, policy, tools, forTask, noOwnerRulesOrApprovals };
}

function pauseAtEffect(t: TestContext) {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  let boundaries = 0;
  t.after(() => release());
  return {
    entered,
    release,
    async waitForRoom() {
      // The registry checks once, then sideEffect checks before issuing its write.
      if (++boundaries !== 2) return;
      enter();
      await held;
    },
  };
}

test('calendar creation saves a Work-backed reservation without approval and replays across task recovery', async (t) => {
  const f = await fixture(t);
  const runtime = f.tools();
  const args = { ...calendarCreate, prompt: 'x'.repeat(16_000) };
  const result = JSON.parse(
    await runtime.registry.invoke('manage_automation', args),
  ) as ReservationResult;
  f.noOwnerRulesOrApprovals();
  assert.equal(result.work.kind, 'task');
  assert.equal(result.work.status, 'active');
  assert.equal(result.work.createdByBotId, runtime.task.botId);
  assert.equal(result.work.sourceTaskId, runtime.task.id);
  assert.equal(result.wakeup.workId, result.work.id);
  assert.equal(result.wakeup.botId, runtime.task.botId);
  assert.equal(result.wakeup.createdByBotId, runtime.task.botId);
  assert.equal(result.wakeup.prompt, args.prompt, 'execution instructions are not truncated');
  assert.deepEqual(result.wakeup.schedule, args.schedule);
  assert.equal(result.wakeup.nextRunAt, '2099-06-15T00:00:00.000Z');
  assert.equal(result.wakeup.status, 'scheduled');
  assert.equal(
    result.wakeup.key,
    'automation-' + operationKey(runtime.task.id, 'manage_automation', args),
  );
  assert.deepEqual(result.work.checkpoint.uncertainActions, []);
  assert.ok(result.work.checkpoint.doneWhen);
  assert.ok(result.work.checkpoint.nextStep.length <= 4_000);
  assert.ok(result.work.purpose.length <= 4_000);
  assert.match(result.note, /list_wakeups/);
  assert.match(result.note, /manage_wakeup/);
  assert.equal('automationId' in result, false);
  const task = f.store.get<Task>('tasks', runtime.task.id)!;
  assert.equal(task.workId, result.work.id);
  assert.ok(task.workRunId);
  assert.notEqual(task.status, 'awaiting_approval');
  assert.match(await runtime.registry.invoke('manage_automation', args), /already completed/);
  assert.match(
    await f.forTask(task).registry.invoke('manage_automation', args),
    /already completed/,
  );
  assert.equal(f.store.list('workItems').length, 1);
  assert.equal(f.store.list('wakeups').length, 1);
  assert.equal(
    f.controller.getOperation(operationKey(task.id, 'manage_automation', args))?.status,
    'completed',
  );
});

test('daily and weekly compatibility reservations are standing work and normalize replay identity', async (t) => {
  const f = await fixture(t);
  t.mock.method(Date, 'now', () => Date.parse('2099-06-14T00:00:00Z'));
  for (const type of ['daily', 'weekly'] as const) {
    const runtime = f.tools();
    const args = {
      ...calendarCreate,
      schedule: {
        type,
        time: '18:00',
        timeZone: 'Asia/Tokyo',
        missedRunPolicy: 'skip',
        ...(type === 'weekly' ? { weekdays: [5, 1, 3, 1] } : {}),
      },
    };
    const result = JSON.parse(
      await runtime.registry.invoke('manage_automation', args),
    ) as ReservationResult;
    assert.equal(result.work.kind, 'standing');
    assert.equal(result.wakeup.schedule.type, type);
    assert.equal(result.wakeup.schedule.missedRunPolicy, 'skip');
    if (result.wakeup.schedule.type === 'weekly')
      assert.deepEqual(result.wakeup.schedule.weekdays, [1, 3, 5]);
    assert.match(
      await runtime.registry.invoke('manage_automation', {
        ...args,
        schedule: result.wakeup.schedule,
      }),
      /already completed/,
    );
  }
  assert.equal(f.store.list('workItems').length, 2);
  assert.equal(f.store.list('wakeups').length, 2);
  f.noOwnerRulesOrApprovals();
});

test('legacy completed and uncertain calendar receipts are respected before new compatibility validation', async (t) => {
  const f = await fixture(t);
  f.policy({ mode: 'off' });
  for (const status of ['completed', 'started', 'failed'] as const) {
    const runtime = f.tools();
    const args = { ...calendarCreate, enabled: false, prompt: 'x'.repeat(16_001) };
    const key = operationKey(runtime.task.id, 'manage_automation', args);
    const result = JSON.stringify({ id: 'legacy-owner-rule', enabled: false });
    const receipt: OperationRecord = {
      key,
      taskId: runtime.task.id,
      toolName: 'manage_automation',
      args,
      status,
      result: status === 'completed' ? result : undefined,
      updatedAt: new Date().toISOString(),
    };
    f.controller.saveOperation(receipt);
    const saved = f.controller.getOperation(key)!;
    if (status === 'completed') {
      const restored = await runtime.registry.invoke('manage_automation', args);
      assert.match(restored, /already completed/);
      assert.ok(restored.endsWith(result));
    } else {
      await assert.rejects(
        runtime.registry.invoke('manage_automation', args),
        /uncertain or failed outcome/,
      );
    }
    assert.deepEqual(f.controller.getOperation(key), saved);
  }
  assert.equal(f.store.list('workItems').length, 0);
  assert.equal(f.store.list('wakeups').length, 0);
  f.noOwnerRulesOrApprovals();
});

test('room policy controls calendar creation without falling back to owner approval', async (t) => {
  const f = await fixture(t);
  const beforePolicy = f.tools();
  f.policy({ mode: 'off' });
  await assert.rejects(
    beforePolicy.registry.invoke('manage_automation', calendarCreate),
    /disabled/,
  );
  f.policy({ mode: 'self' });
  await assert.rejects(
    f.tools().registry.invoke('manage_automation', { ...calendarCreate, botHandle: '@nova' }),
    /only.*creator|own wake-ups/,
  );
  f.policy({ mode: 'room' });
  const made = JSON.parse(
    await f.tools().registry.invoke('manage_automation', { ...calendarCreate, botHandle: '@nova' }),
  ) as ReservationResult;
  assert.equal(made.wakeup.botId, 'bot_nova');
  assert.equal(made.work.createdByBotId, 'bot_aster');
  f.store.patch<Bot>('bots', 'bot_nova', { enabled: false });
  await assert.rejects(
    f.tools().registry.invoke('manage_automation', { ...calendarCreate, botHandle: '@nova' }),
    /enabled/,
  );
  f.store.patch<Bot>('bots', 'bot_nova', { enabled: true });
  f.store.patch<Room>('rooms', 'room_lounge', { botIds: ['bot_aster'] });
  await assert.rejects(
    f.tools().registry.invoke('manage_automation', { ...calendarCreate, botHandle: '@nova' }),
    /belongs to this room/,
  );
  assert.equal(f.store.list('workItems').length, 1);
  assert.equal(f.store.list('wakeups').length, 1);
  f.noOwnerRulesOrApprovals();
});

test('a runtime without Work scheduling rejects calendar creation without an approval fallback', async (t) => {
  const f = await fixture(t);
  Object.defineProperty(f.controller, 'manageWakeup', { value: undefined });
  const runtime = f.tools();
  await assert.rejects(
    runtime.registry.invoke('manage_automation', calendarCreate),
    /wake-up scheduling is not available/,
  );
  assert.equal(
    f.controller.getOperation(operationKey(runtime.task.id, 'manage_automation', calendarCreate)),
    undefined,
  );
  assert.equal(f.store.list('workItems').length, 0);
  assert.equal(f.store.list('wakeups').length, 0);
  f.noOwnerRulesOrApprovals();
});

test('calendar creation shares the minimum lead time and pending limits of manage_wakeup', async (t) => {
  const f = await fixture(t);
  t.mock.method(Date, 'now', () => Date.parse('2099-06-14T00:00:00Z'));
  f.policy({ minIntervalMinutes: 5, maxPendingWakeups: 1 });
  await assert.rejects(
    f.tools().registry.invoke('manage_automation', {
      ...calendarCreate,
      schedule: { ...calendarCreate.schedule, dateTime: '2099-06-14T09:03' },
    }),
    /at least 5 minute/,
  );
  await f.tools().registry.invoke('manage_wakeup', canonicalCreate);
  await assert.rejects(
    f.tools().registry.invoke('manage_automation', calendarCreate),
    /pending wake-up limit/,
  );
  assert.equal(f.store.list('workItems').length, 1);
  assert.equal(f.store.list('wakeups').length, 1);
  f.noOwnerRulesOrApprovals();
});

test('disabled drafts, oversized prompts and invalid calendars fail without claiming an effect', async (t) => {
  const f = await fixture(t);
  t.mock.method(Date, 'now', () => Date.parse('2099-06-14T00:00:00Z'));
  for (const [patch, message] of [
    [{ enabled: false }, /disabled.*draft|active reservation/],
    [{ prompt: 'x'.repeat(16_001) }, /16000/],
    [{ automationId: 'existing-rule' }, /Do not supply an automationId/],
    [{ schedule: undefined }, /schedule/],
    [{ schedule: { ...calendarCreate.schedule, dateTime: '2099-06-13T09:00' } }, /future/],
    [
      { schedule: { type: 'once', dateTime: '2099-06-15T09:00', missedRunPolicy: 'run_once' } },
      /time zone|timeZone/,
    ],
  ] as Array<[Record<string, unknown>, RegExp]>) {
    const runtime = f.tools();
    const args = { ...calendarCreate, ...patch };
    await assert.rejects(runtime.registry.invoke('manage_automation', args), message);
    assert.equal(
      f.controller.getOperation(operationKey(runtime.task.id, 'manage_automation', args)),
      undefined,
    );
  }
  assert.equal(f.store.list('workItems').length, 0);
  assert.equal(f.store.list('wakeups').length, 0);
  f.noOwnerRulesOrApprovals();
});

test(
  'policy and future time are rechecked after waiting at the effect boundary',
  { timeout: 35_000 },
  async (t) => {
    for (const change of ['policy', 'time'] as const) {
      await t.test(change, async (t) => {
        const f = await fixture(t);
        let current = Date.parse('2099-06-14T00:00:00Z');
        t.mock.method(Date, 'now', () => current);
        const gate = pauseAtEffect(t);
        const runtime = f.tools(gate.waitForRoom);
        const pending = runtime.registry.invoke('manage_automation', calendarCreate);
        const rejected = assert.rejects(pending, change === 'policy' ? /disabled/ : /future/);
        await gate.entered;
        if (change === 'policy') f.policy({ mode: 'off' });
        else current = Date.parse('2099-06-15T00:00:01Z');
        gate.release();
        await rejected;
        assert.equal(f.store.list('workItems').length, 0);
        assert.equal(f.store.list('wakeups').length, 0);
        f.noOwnerRulesOrApprovals();
      });
    }
  },
);

test(
  'a Work binding made while calendar creation waits is reused without replacing its checkpoint',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t);
    const gate = pauseAtEffect(t);
    const runtime = f.tools(gate.waitForRoom);
    const pending = runtime.registry.invoke('manage_automation', calendarCreate);
    await gate.entered;
    const original = JSON.parse(
      await runtime.registry.invoke('manage_wakeup', canonicalCreate),
    ) as ReservationResult;
    assert.equal(runtime.task.workId, undefined, 'the captured task can still be unbound');
    gate.release();
    const result = JSON.parse(await pending) as ReservationResult;
    assert.equal(result.work.id, original.work.id);
    assert.equal(result.work.name, canonicalCreate.name);
    assert.equal(result.work.purpose, canonicalCreate.purpose);
    assert.deepEqual(result.work.checkpoint, canonicalCreate.checkpoint);
    assert.equal(f.store.list('workItems').length, 1);
    assert.equal(f.store.list('wakeups').length, 2);
    f.noOwnerRulesOrApprovals();
  },
);

test('compatibility reservations remain editable through wake tools and respect owner cancellation and work stops', async (t) => {
  const f = await fixture(t);
  const runtime = f.tools();
  const made = JSON.parse(
    await runtime.registry.invoke('manage_automation', calendarCreate),
  ) as ReservationResult;
  const listing = JSON.parse(
    await runtime.registry.invoke('list_wakeups', { workId: made.work.id }),
  );
  assert.deepEqual(listing.workItems, [made.work]);
  assert.deepEqual(listing.wakeups, [made.wakeup]);
  const changed = JSON.parse(
    await runtime.registry.invoke('manage_wakeup', {
      operation: 'upsert',
      workId: made.work.id,
      wakeupId: made.wakeup.id,
      baseRevision: made.wakeup.revision,
      schedule: { ...calendarCreate.schedule, dateTime: '2099-06-16T09:00' },
    }),
  ) as ReservationResult;
  assert.equal(changed.wakeup.id, made.wakeup.id);
  assert.equal(changed.wakeup.nextRunAt, '2099-06-16T00:00:00.000Z');
  const cancelled = f.controller.work.cancelWakeup(made.wakeup.id, 'owner');
  await assert.rejects(
    runtime.registry.invoke('manage_wakeup', {
      operation: 'upsert',
      workId: made.work.id,
      wakeupId: made.wakeup.id,
      baseRevision: cancelled.revision,
      schedule: { ...calendarCreate.schedule, dateTime: '2099-06-17T09:00' },
    }),
    /owner cancelled/,
  );
  const paused = await f.app.inject({
    method: 'POST',
    url: '/api/work-items/' + made.work.id + '/pause',
  });
  assert.equal(paused.statusCode, 200, paused.body);
  await assert.rejects(
    runtime.registry.invoke('manage_automation', {
      ...calendarCreate,
      name: 'Another reservation',
    }),
    /paused|stopped/,
  );
  assert.equal(f.store.list('wakeups').length, 1);
  assert.equal(f.store.get<Wakeup>('wakeups', made.wakeup.id)?.status, 'cancelled');
  f.noOwnerRulesOrApprovals();
});

test('minute intervals keep the ordinary automation approval path even in an autonomous room', async (t) => {
  const f = await fixture(t);
  const runtime = f.tools();
  const pending = runtime.registry.invoke('manage_automation', {
    operation: 'create',
    kind: 'interval',
    name: 'Interval review',
    prompt: calendarCreate.prompt,
    intervalMinutes: 30,
  });
  const approval = f.store.list<Approval>('approvals').find((item) => item.status === 'pending');
  assert.ok(approval);
  assert.equal(f.store.list('automations').length, 0);
  assert.equal(f.store.list('workItems').length, 0);
  assert.equal(f.store.list('wakeups').length, 0);
  f.controller.decideApproval(approval.id, true);
  const result = JSON.parse(await pending);
  assert.equal(result.kind, 'interval');
  assert.equal(result.intervalMinutes, 30);
  assert.equal(f.store.list('automations').length, 1);
});
