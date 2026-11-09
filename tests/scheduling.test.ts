import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { createTools } from '../src/server/runtime/tools.js';
import type { ToolContext } from '../src/server/runtime/contract.js';
import type { WakeupInput } from '../src/server/work.js';
import { DEFAULT_AUTONOMOUS_WAKEUP_POLICY } from '../src/shared/work.js';
import {
  PRIORITY_WINDOW_MS,
  isSchedulingGrant,
  isTaskScheduling,
  type TaskSchedulingSnapshot,
} from '../src/shared/scheduling.js';
import type { Bot, Room, Task, WorkItem } from '../src/shared/types.js';

async function fixture(t: TestContext, apiToken?: string) {
  const initial = Date.parse('2026-11-09T00:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: initial });
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-scheduling-'));
  let refreshes = 0;
  const options = {
    dataDir,
    apiToken,
    scheduler: false,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
      refreshScheduling() {
        refreshes++;
      },
    }),
  };
  let current = await createApp(options);
  await current.app.ready();
  current.store.put('settings', { ...current.store.settings(), id: 'main', demoMode: true });
  current.store.patch<Room>('rooms', 'room_lounge', {
    autonomousWakeups: {
      ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY,
      mode: 'room',
      maxRunsPerHour: 100,
    },
  });
  current.controller.changed();
  t.after(async () => {
    await current.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const task = (input: Partial<Task> = {}) =>
    current.controller.enqueueTask({
      roomId: input.roomId ?? 'room_lounge',
      botId: input.botId ?? 'bot_aster',
      prompt: 'Continue the authorized work.',
      kind: input.kind,
      parentTaskId: input.parentTaskId,
      workId: input.workId,
      workRunId: input.workRunId,
    });
  const registry = (target: Task) => {
    const context: ToolContext = {
      host: current.controller,
      task: target,
      settings: current.store.settings(),
      signal: new AbortController().signal,
      operationKeys: new Set(),
    };
    return createTools(context);
  };
  return {
    ...current,
    task,
    registry,
    refreshes: () => refreshes,
    advance: (ms: number) => t.mock.timers.setTime(Date.now() + ms),
    async restart() {
      await current.app.close();
      current = await createApp(options);
      await current.app.ready();
      return current;
    },
  };
}

function wake(key: string, workId?: string): WakeupInput {
  return {
    operation: 'upsert',
    key,
    ...(workId
      ? { workId }
      : {
          name: 'Finish the review',
          purpose: 'Review the result when it becomes available.',
          checkpoint: {
            summary: 'Waiting for the result.',
            completed: 'Inspected the available inputs.',
            nextStep: 'Review the final result.',
            references: [],
            doneWhen: 'The final result has been reviewed.',
            uncertainActions: [],
          },
        }),
    reason: 'Review the next input.',
    prompt: 'Read and review the final result.',
    schedule: {
      type: 'once',
      dateTime: '2099-06-15T09:00',
      timeZone: 'Asia/Tokyo',
      missedRunPolicy: 'run_once',
    },
  };
}

test('bot requests share one window across handoffs; owner upgrade spends the same allowance', async (t) => {
  const f = await fixture(t);
  const root = f.task();
  const first = f.controller.requestTaskPriority(root.id, {
    reason: 'An input expires soon.',
    deadlineAt: '2026-11-09T09:02:00+09:00',
  });
  assert.equal(first.grant?.source, 'bot');
  assert.equal(first.grant?.remainingRequests, 1);
  assert.equal(first.grant?.deadlineAt, '2026-11-09T00:02:00.000Z');
  const refreshes = f.refreshes();
  assert.equal(f.controller.consumeTaskPriority(root.id, first.grant!.id), true);
  assert.equal(f.refreshes(), refreshes, 'admission does not recursively refresh the runtime');
  assert.equal(f.controller.consumeTaskPriority(root.id, first.grant!.id), false);
  const child = f.task({ parentTaskId: root.id, botId: 'bot_nova' });
  const repeated = f.controller.requestTaskPriority(child.id, { reason: 'A different reason.' });
  assert.equal(repeated.groupId, root.id);
  assert.equal(repeated.grant?.id, first.grant?.id);
  assert.equal(repeated.grant?.remainingRequests, 0);
  assert.equal(repeated.grant?.expiresAt, first.grant?.expiresAt);
  const upgraded = f.controller.prioritizeTask(child.id, { reason: 'Owner deadline.' });
  assert.equal(upgraded.grant?.source, 'owner');
  assert.equal(upgraded.grant?.grantedRequests, 3);
  assert.equal(upgraded.grant?.remainingRequests, 2);
  assert.equal(upgraded.grant?.id, first.grant?.id);
  assert.equal(upgraded.grant?.expiresAt, first.grant?.expiresAt);
  assert.equal(f.controller.consumeTaskPriority(child.id, upgraded.grant!.id), true);
  assert.equal(f.controller.prioritizeTask(root.id).grant?.remainingRequests, 1);
  assert.equal(f.controller.getTaskScheduling(child.id).grant?.remainingRequests, 1);
});

test('revocation keeps attribution and cooldown; expired grants renew without restoring old IDs', async (t) => {
  const f = await fixture(t);
  const task = f.task();
  const first = f.controller.requestTaskPriority(task.id, { reason: 'Expiring input.' });
  const revoked = f.controller.revokeTaskPriority(task.id);
  assert.equal(revoked.grant?.source, 'bot');
  assert.equal(revoked.grant?.grantedRequests, 1);
  assert.equal(revoked.grant?.remainingRequests, 0);
  assert.equal(revoked.grant?.expiresAt, first.grant?.expiresAt);
  assert.ok(revoked.grant?.revokedAt);
  assert.deepEqual(f.controller.prioritizeTask(task.id), revoked);
  assert.deepEqual(f.controller.requestTaskPriority(task.id, { reason: 'Again.' }), revoked);
  f.advance(PRIORITY_WINDOW_MS);
  assert.equal(f.controller.getTaskScheduling(task.id).grant, undefined);
  const renewed = f.controller.prioritizeTask(task.id);
  assert.notEqual(renewed.grant?.id, first.grant?.id);
  assert.equal(renewed.grant?.remainingRequests, 3);
  assert.equal(f.controller.consumeTaskPriority(task.id, first.grant!.id), false);
});

test('consumed preference survives restart and explicit task recovery', async (t) => {
  const f = await fixture(t);
  const task = f.task();
  const initial = f.controller.prioritizeTask(task.id);
  assert.equal(f.controller.consumeTaskPriority(task.id, initial.grant!.id), true);
  const restarted = await f.restart();
  assert.equal(restarted.controller.getTaskScheduling(task.id).grant?.remainingRequests, 2);
  assert.equal(restarted.controller.consumeTaskPriority(task.id, initial.grant!.id), false);
  restarted.controller.resume(task.id);
  const resumed = restarted.controller.prioritizeTask(task.id);
  assert.equal(resumed.grant?.id, initial.grant?.id);
  assert.equal(resumed.grant?.remainingRequests, 2);
  assert.equal(restarted.controller.consumeTaskPriority(task.id, initial.grant!.id), true);
  assert.equal(restarted.controller.getTaskScheduling(task.id).grant?.remainingRequests, 1);
});

test('binding a child to Work and scheduling a continuation cannot refill its root grant', async (t) => {
  const f = await fixture(t);
  const root = f.task();
  const child = f.task({ parentTaskId: root.id });
  const sibling = f.task({ parentTaskId: root.id });
  const initial = f.controller.prioritizeTask(root.id);
  f.controller.consumeTaskPriority(root.id, initial.grant!.id);
  f.controller.consumeTaskPriority(child.id, initial.grant!.id);
  const bound = f.controller.manageWakeup(child.id, wake('child-review'));
  assert.equal(f.controller.getTaskScheduling(child.id).groupId, bound.work.id);
  assert.equal(f.controller.getTaskScheduling(child.id).grant?.remainingRequests, 1);
  assert.equal(f.controller.getTaskScheduling(sibling.id).groupId, root.id);
  assert.equal(f.controller.consumeTaskPriority(child.id, initial.grant!.id), true);
  assert.equal(f.controller.getTaskScheduling(root.id).grant?.remainingRequests, 0);
  const continuation = f.task({
    kind: 'automation',
    workId: bound.work.id,
    workRunId: bound.wakeup.workRunId,
  });
  assert.equal(
    f.controller.requestTaskPriority(continuation.id, { reason: 'Continue.' }).grant
      ?.remainingRequests,
    0,
  );
  const saved = f.store.get<Task>('tasks', child.id)!.scheduling!;
  assert.equal(saved.grantRedirect?.grantId, initial.grant?.id);
  assert.equal(isTaskScheduling(saved), true);
  f.advance(PRIORITY_WINDOW_MS);
  const renewedRoot = f.controller.prioritizeTask(root.id);
  assert.equal(renewedRoot.grant?.remainingRequests, 3);
  assert.equal(f.controller.getTaskScheduling(child.id).grant, undefined);
  const ownWork = f.controller.requestTaskPriority(child.id, {
    reason: 'This work has its own deadline.',
  });
  assert.notEqual(ownWork.grant?.id, renewedRoot.grant?.id);
  assert.equal(ownWork.grant?.remainingRequests, 1);
});

test('a previously bound sibling Work does not inherit a future ancestor grant in the same millisecond', async (t) => {
  const f = await fixture(t);
  const root = f.task();
  const left = f.task({ parentTaskId: root.id });
  const right = f.task({ parentTaskId: root.id });
  const leftWork = f.controller.manageWakeup(left.id, wake('left'));
  const rightWork = f.controller.manageWakeup(right.id, wake('right'));
  const priority = f.controller.prioritizeTask(root.id);
  assert.equal(priority.grant?.requestedAt, leftWork.work.createdAt);
  assert.equal(priority.grant?.requestedAt, rightWork.work.createdAt);
  assert.equal(f.controller.getTaskScheduling(left.id).grant, undefined);
  assert.equal(f.controller.getTaskScheduling(right.id).grant, undefined);
});

test('moving a child that holds the grant leaves its original root and siblings on the same consumed allowance', async (t) => {
  const f = await fixture(t);
  const root = f.task();
  const child = f.task({ parentTaskId: root.id });
  const sibling = f.task({ parentTaskId: root.id });
  const grant = f.controller.requestTaskPriority(child.id, { reason: 'An expiring input.' }).grant!;
  assert.equal(f.controller.consumeTaskPriority(child.id, grant.id), true);
  const work = f.controller.manageWakeup(child.id, wake('moving-holder')).work;
  assert.equal(f.controller.getTaskScheduling(child.id).groupId, work.id);
  const rootRequest = f.controller.requestTaskPriority(root.id, { reason: 'Another reason.' });
  assert.equal(rootRequest.grant?.id, grant.id);
  assert.equal(rootRequest.grant?.remainingRequests, 0);
  assert.equal(f.controller.getTaskScheduling(sibling.id).grant?.id, grant.id);
  const upgraded = f.controller.prioritizeTask(sibling.id).grant!;
  assert.equal(upgraded.remainingRequests, 2);
  assert.equal(f.controller.getTaskScheduling(child.id).grant?.remainingRequests, 2);
  assert.equal(f.controller.consumeTaskPriority(root.id, grant.id), true);
  assert.equal(f.controller.getTaskScheduling(child.id).grant?.remainingRequests, 1);
  f.advance(PRIORITY_WINDOW_MS);
  const newRoot = f.controller.prioritizeTask(root.id).grant!;
  assert.notEqual(newRoot.id, grant.id);
  assert.equal(f.controller.getTaskScheduling(child.id).grant, undefined);
});

test('a failed grant-link write rolls back the Work identity and preserves the consumed root allowance', async (t) => {
  const f = await fixture(t);
  const root = f.task();
  const child = f.task({ parentTaskId: root.id });
  const grant = f.controller.prioritizeTask(root.id).grant!;
  f.controller.consumeTaskPriority(root.id, grant.id);
  const originalPut = f.store.put.bind(f.store);
  const write = t.mock.method(f.store, 'put', (kind, value) => {
    if (kind === 'tasks' && (value as Task).scheduling?.grantRedirect)
      throw new Error('Synthetic grant-link write failure.');
    return originalPut(kind, value);
  });
  assert.throws(
    () => f.controller.manageWakeup(child.id, wake('rollback')),
    /grant-link write failure/,
  );
  write.mock.restore();
  assert.equal(f.store.list('workItems').length, 0);
  assert.equal(f.store.list('wakeups').length, 0);
  assert.equal(f.store.get<Task>('tasks', child.id)?.workId, undefined);
  assert.equal(f.store.get<Task>('tasks', child.id)?.scheduling, undefined);
  assert.equal(f.controller.getTaskScheduling(child.id).groupId, root.id);
  assert.equal(f.controller.getTaskScheduling(child.id).grant?.remainingRequests, 2);
  const work = f.controller.manageWakeup(child.id, wake('retry')).work;
  assert.equal(f.controller.getTaskScheduling(child.id).groupId, work.id);
  assert.equal(f.controller.getTaskScheduling(child.id).grant?.remainingRequests, 2);
});

test('independently spent grants merging into Work combine consumption and flatten aliases', async (t) => {
  const f = await fixture(t);
  const first = f.task();
  const second = f.task();
  const firstGrant = f.controller.prioritizeTask(first.id);
  f.controller.consumeTaskPriority(first.id, firstGrant.grant!.id);
  f.advance(60_000);
  const secondGrant = f.controller.requestTaskPriority(second.id, {
    reason: 'Another input expires.',
  });
  f.controller.consumeTaskPriority(second.id, secondGrant.grant!.id);
  const work = f.controller.manageWakeup(first.id, wake('first')).work;
  f.controller.manageWakeup(second.id, wake('second', work.id));
  const merged = f.controller.getTaskScheduling(second.id);
  assert.equal(merged.groupId, work.id);
  assert.equal(merged.grant?.grantedRequests, 3);
  assert.equal(
    merged.grant?.remainingRequests,
    1,
    'spent 1 + 1 is deducted from the owner total of 3',
  );
  assert.equal(merged.grant?.expiresAt, firstGrant.grant?.expiresAt);
  assert.equal(f.controller.consumeTaskPriority(second.id, merged.grant!.id), true);
  assert.equal(f.controller.getTaskScheduling(first.id).grant?.remainingRequests, 0);
  assert.equal(f.controller.prioritizeTask(second.id).grant?.remainingRequests, 0);
  const tombstone = f.store.get<Task>('tasks', second.id)!.scheduling!;
  assert.equal(tombstone.grant?.id, secondGrant.grant?.id);
  assert.equal(tombstone.grant?.remainingRequests, 0);
  assert.equal(tombstone.grant?.expiresAt, merged.grant?.expiresAt);
  assert.equal(tombstone.grantRedirect?.grantId, merged.grant?.id);
  f.advance(PRIORITY_WINDOW_MS - 60_000);
  const renewed = f.controller.prioritizeTask(second.id);
  assert.notEqual(renewed.grant?.id, merged.grant?.id);
  assert.equal(renewed.grant?.remainingRequests, 3);
  assert.equal(f.controller.getTaskScheduling(first.id).grant?.id, renewed.grant?.id);
});

test('broken and cyclic grant redirects fail closed without restoring a retired balance', async (t) => {
  const f = await fixture(t);
  const first = f.task();
  const second = f.task();
  const a = f.controller.requestTaskPriority(first.id, { reason: 'First.' }).grant!;
  const b = f.controller.requestTaskPriority(second.id, { reason: 'Second.' }).grant!;
  f.store.patch<Task>('tasks', first.id, {
    scheduling: { grant: a, grantRedirect: { taskId: second.id, grantId: b.id } },
  });
  f.store.patch<Task>('tasks', second.id, {
    scheduling: { grant: b, grantRedirect: { taskId: first.id, grantId: a.id } },
  });
  f.controller.changed();
  assert.equal(f.controller.getTaskScheduling(first.id).grant?.remainingRequests, 0);
  assert.equal(f.controller.getTaskScheduling(first.id).grantUnavailable, true);
  assert.equal(f.controller.consumeTaskPriority(first.id, a.id), false);
  assert.equal(f.controller.prioritizeTask(first.id).grant?.remainingRequests, 0);
  f.store.patch<Task>('tasks', second.id, { scheduling: undefined });
  f.controller.changed();
  assert.equal(f.controller.getTaskScheduling(first.id).grant?.remainingRequests, 0);
  assert.equal(
    f.controller.requestTaskPriority(first.id, { reason: 'Again.' }).grant?.remainingRequests,
    0,
  );
});

for (const count of [2, 3])
  test(`${count} spent bot grants retain merged consumption before an owner upgrade`, async (t) => {
    const f = await fixture(t);
    const tasks = Array.from({ length: count }, () => f.task());
    for (const task of tasks) {
      const grant = f.controller.requestTaskPriority(task.id, {
        reason: 'An expiring input.',
      }).grant!;
      assert.equal(f.controller.consumeTaskPriority(task.id, grant.id), true);
    }
    const work = f.controller.manageWakeup(tasks[0].id, wake('root')).work;
    for (let index = 1; index < tasks.length; index++) {
      f.controller.manageWakeup(tasks[index].id, wake(`join-${index}`, work.id));
      const merged = f.controller.getTaskScheduling(tasks[index].id).grant!;
      assert.equal(merged.grantedRequests, 1);
      assert.equal(merged.remainingRequests, 0);
      assert.equal(merged.consumedRequests, index + 1);
    }
    const upgraded = f.controller.prioritizeTask(tasks.at(-1)!.id).grant!;
    assert.equal(upgraded.grantedRequests, 3);
    assert.equal(upgraded.consumedRequests, count);
    assert.equal(upgraded.remainingRequests, 3 - count);
    assert.equal(f.controller.prioritizeTask(tasks[0].id).grant?.remainingRequests, 3 - count);
  });

test('priority API preserves owner authority and cannot resume paused, stopped or blocked work', async (t) => {
  const token = 'test-priority-api-token-long-enough';
  const f = await fixture(t, token);
  const task = f.task();
  const request = (
    method: 'POST' | 'DELETE',
    target = task.id,
    payload?: unknown,
    authorized = true,
  ) =>
    f.app.inject({
      method,
      url: `/api/tasks/${target}/priority`,
      payload: payload as object,
      headers: { host: 'localhost', ...(authorized ? { authorization: `Bearer ${token}` } : {}) },
    });
  assert.equal((await request('POST', task.id, {}, false)).statusCode, 401);
  assert.equal(
    (await request('POST', task.id, { source: 'bot', remainingRequests: 100 })).statusCode,
    400,
  );
  const granted = await request('POST', task.id, {});
  assert.equal(granted.statusCode, 200);
  assert.equal(granted.json<TaskSchedulingSnapshot>().grant?.source, 'owner');
  assert.equal(granted.json<TaskSchedulingSnapshot>().grant?.remainingRequests, 3);
  const learning = f.task({ kind: 'learning' });
  assert.equal((await request('POST', learning.id, {})).statusCode, 200);
  assert.equal(
    f.registry(learning).definitions.some((tool) => tool.name === 'request_priority'),
    false,
  );
  f.controller.pauseRoom(task.roomId);
  assert.equal((await request('POST', task.id, {})).statusCode, 409);
  assert.equal(f.store.get<Room>('rooms', task.roomId)?.paused, true);
  f.controller.resumeRoom(task.roomId);
  assert.equal((await request('DELETE')).statusCode, 200);
  await f.controller.stop(task.id);
  assert.equal((await request('POST', task.id, {})).statusCode, 409);
  assert.equal(f.store.get<Task>('tasks', task.id)?.status, 'stopped');
  const bound = f.task();
  const work = f.controller.manageWakeup(bound.id, wake('blocked')).work;
  f.store.patch<WorkItem>('workItems', work.id, { status: 'blocked' });
  f.controller.changed();
  assert.equal((await request('POST', bound.id, {})).statusCode, 409);
  assert.equal(f.store.get<WorkItem>('workItems', work.id)?.status, 'blocked');
});

test('request_priority tool is scoped to its actor and revalidates current authority', async (t) => {
  const f = await fixture(t);
  const task = f.task();
  const other = f.task();
  const registry = f.registry(task);
  const before = f.store.list('activities').length;
  await assert.rejects(
    registry.invoke('request_priority', { reason: 'Urgent.', taskId: other.id }),
    /Unrecognized/,
  );
  await assert.rejects(
    registry.invoke('request_priority', { reason: 'Urgent.', source: 'owner' }),
    /Unrecognized/,
  );
  await assert.rejects(
    registry.invoke('request_priority', { reason: 'Urgent.', deadlineAt: '2026-11-09T09:00:00' }),
    /datetime|Invalid/,
  );
  assert.equal(f.store.list('activities').length, before);
  const grant = JSON.parse(
    await registry.invoke('request_priority', { reason: 'The input expires soon.' }),
  ) as TaskSchedulingSnapshot;
  assert.equal(grant.groupId, task.id);
  assert.equal(grant.grant?.source, 'bot');
  assert.equal(grant.grant?.remainingRequests, 1);
  assert.equal(f.controller.getTaskScheduling(other.id).grant, undefined);
  f.store.patch<Bot>('bots', task.botId, { enabled: false });
  f.controller.changed();
  await assert.rejects(registry.invoke('request_priority', { reason: 'Again.' }), /enabled bot/);
  assert.equal(f.controller.consumeTaskPriority(task.id, grant.grant!.id), false);
  assert.equal(f.controller.getTaskScheduling(task.id).grant?.remainingRequests, 1);
});

test('scheduling validation rejects malformed authority and inflated or incomplete grants', async (t) => {
  const f = await fixture(t);
  const grant = f.controller.requestTaskPriority(f.task().id, { reason: 'A deadline.' }).grant!;
  assert.equal(isSchedulingGrant(grant), true);
  for (const invalid of [
    { ...grant, source: ['bot'] },
    { ...grant, remainingRequests: 2 },
    { ...grant, grantedRequests: 3 },
    { ...grant, consumedRequests: -1 },
    { ...grant, consumedRequests: 1 },
    { ...grant, expiresAt: new Date(Date.parse(grant.expiresAt) + 1).toISOString() },
    { ...grant, revokedAt: grant.requestedAt },
    { ...grant, authority: 'owner' },
  ])
    assert.equal(isSchedulingGrant(invalid), false);
  assert.equal(isTaskScheduling({ grantRedirect: { taskId: 'task', grantId: grant.id } }), false);
  assert.equal(
    isTaskScheduling({ grant, grantRedirect: { taskId: '', grantId: grant.id } }),
    false,
  );
});
