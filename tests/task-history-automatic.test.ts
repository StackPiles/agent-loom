import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/server/controller.js';
import type { OperationRecord } from '../src/server/runtime/contract.js';
import { Store } from '../src/server/store.js';
import { reconcileAutomaticTaskHistory } from '../src/server/task-history.js';
import type { Approval, Room, Snapshot, Task, WorkItem } from '../src/shared/types.js';

const executionTime = '2030-01-14T08:00:00.000Z';
const reviewTime = '2030-01-14T09:00:00.000Z';
const initial = Date.parse('2030-01-15T08:00:00.000Z');

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: initial });
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-auto-history-'));
  let store = new Store(dataDir);
  store.seed();
  let controller = new Controller(store);
  const starts: string[] = [];
  const stops: string[] = [];
  const attachRuntime = () => {
    controller.runtime = {
      start: (task) => {
        starts.push(task.id);
      },
      stop: async (taskId) => {
        stops.push(taskId);
      },
      shutdown: async () => {},
      queueState: () => ({ active: 0, waiting: 0 }),
    };
  };
  attachRuntime();
  t.after(async () => {
    await controller.shutdown();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let sequence = 0;
  return {
    starts,
    stops,
    get store() {
      return store;
    },
    get controller() {
      return controller;
    },
    addWork(patch: Partial<WorkItem> = {}) {
      const workId = 'work_history_' + ++sequence;
      return store.put<WorkItem>('workItems', {
        id: workId,
        roomId: 'room_lounge',
        name: 'Review the completed delivery',
        purpose: 'Complete the assigned review.',
        kind: 'task',
        status: 'completed',
        createdByBotId: 'bot_aster',
        sourceTaskId: 'source_' + workId,
        scope: 'The assigned review.',
        workspacePath: store.settings().workspacePath,
        checkpoint: {
          summary: 'The assigned work is complete.',
          completed: 'The owner has accepted the result.',
          nextStep: 'No further action.',
          references: [],
          doneWhen: 'The result has been reviewed.',
          pendingChecks: ['A later optional check does not make the delivery uncertain.'],
          uncertainActions: [],
        },
        revision: 2,
        createdAt: executionTime,
        updatedAt: executionTime,
        ...patch,
      });
    },
    addTask(work?: WorkItem, patch: Partial<Task> = {}) {
      const taskId = 'task_history_' + ++sequence;
      return store.put<Task>('tasks', {
        id: taskId,
        roomId: work?.roomId ?? 'room_lounge',
        botId: 'bot_aster',
        prompt: 'The original instruction.',
        workspacePath: store.settings().workspacePath,
        status: 'failed',
        rootTaskId: taskId,
        depth: 0,
        kind: 'chat',
        ...(work ? { workId: work.id } : {}),
        output: 'The retained partial answer.',
        error: 'The original failure.',
        createdAt: executionTime,
        updatedAt: executionTime,
        startedAt: executionTime,
        completedAt: executionTime,
        inputTokens: 17,
        outputTokens: 23,
        ...patch,
      });
    },
    async flush(change?: () => unknown): Promise<Snapshot> {
      const next = new Promise<Snapshot>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No snapshot event.')), 2000);
        controller.events.once('snapshot', (snapshot: Snapshot) => {
          clearTimeout(timeout);
          resolve(snapshot);
        });
      });
      change?.();
      controller.changed();
      return next;
    },
    async restart(beforeOpen?: (store: Store) => void) {
      await controller.shutdown();
      store.close();
      store = new Store(dataDir);
      beforeOpen?.(store);
      controller = new Controller(store);
      attachRuntime();
    },
  };
}

function execution(task: Task) {
  const {
    archivedAt: _archivedAt,
    archiveReason: _archiveReason,
    keepVisible: _keepVisible,
    ...rest
  } = task;
  return rest;
}

function operation(task: Task, patch: Partial<OperationRecord> = {}): OperationRecord {
  return {
    key: 'effect_' + task.id,
    taskId: task.id,
    toolName: 'browser_click',
    args: { element: 'Submit' },
    status: 'completed',
    result: 'The action completed.',
    updatedAt: executionTime,
    ...patch,
  };
}

function approval(task: Task): Approval {
  return {
    id: 'approval_' + task.id,
    taskId: task.id,
    roomId: task.roomId,
    botId: task.botId,
    toolName: 'write_file',
    summary: 'Write the result.',
    target: 'result.txt',
    args: { path: 'result.txt' },
    status: 'pending',
    createdAt: executionTime,
  };
}

test('startup files old terminal tasks only for exactly matching closed work and preserves execution and related records', async (t) => {
  const f = await fixture(t);
  const completedWork = f.addWork();
  const cancelledWork = f.addWork({ status: 'cancelled' });
  const eligible = (['completed', 'failed', 'stopped', 'interrupted'] as const).map((status) =>
    f.addTask(completedWork, { status }),
  );
  eligible.push(f.addTask(cancelledWork));
  const visible = [
    f.addTask(),
    f.addTask(completedWork, { workId: 'missing_work' }),
    f.addTask(completedWork, { roomId: 'another_room' }),
    f.addTask(completedWork, { keepVisible: true }),
    ...(['active', 'paused', 'blocked'] as const).map((status) =>
      f.addTask(f.addWork({ status }), { status: 'completed' }),
    ),
  ];
  const manual = f.addTask(completedWork, { archivedAt: executionTime });
  f.store.put('operations', { ...operation(eligible[0]), id: operation(eligible[0]).key });
  f.store.put('wakeups', {
    id: 'wake_history',
    workId: completedWork.id,
    roomId: completedWork.roomId,
    status: 'cancelled',
    cancelledBy: 'owner',
    updatedAt: executionTime,
  });
  f.store.put('approvals', { ...approval(eligible[0]), status: 'approved' });
  const related = () =>
    ['workItems', 'wakeups', 'approvals', 'operations'].map((kind) => f.store.list(kind));
  const before = related();
  await f.restart();
  for (const task of eligible) {
    const saved = f.store.get<Task>('tasks', task.id)!;
    assert.equal(saved.archivedAt, new Date(initial).toISOString());
    assert.equal(
      saved.archiveReason,
      task.workId === cancelledWork.id ? 'work_cancelled' : 'work_completed',
    );
    assert.deepEqual(execution(saved), task);
  }
  for (const task of [...visible, manual]) assert.deepEqual(f.store.get('tasks', task.id), task);
  assert.deepEqual(related(), before);
  await f.restart();
  assert.deepEqual(related(), before);
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.stops, []);
});

test('automatic eligibility protects approvals, checkpoint uncertainty, and unresolved effects throughout the same work', async (t) => {
  const f = await fixture(t);
  const cases: {
    name: string;
    effect: Partial<OperationRecord>;
    reviewedAt?: string;
    eligible: boolean;
  }[] = [
    { name: 'completed', effect: { status: 'completed' }, eligible: true },
    {
      name: 'in flight despite review',
      effect: { status: 'started' },
      reviewedAt: reviewTime,
      eligible: false,
    },
    { name: 'failed without review', effect: { status: 'failed' }, eligible: false },
    {
      name: 'failure reviewed earlier',
      effect: { status: 'failed' },
      reviewedAt: '2030-01-13T08:00:00.000Z',
      eligible: false,
    },
    {
      name: 'failure explicitly reviewed',
      effect: { status: 'failed' },
      reviewedAt: reviewTime,
      eligible: true,
    },
    {
      name: 'invalid failure timestamp',
      effect: { status: 'failed', updatedAt: 'invalid' },
      reviewedAt: reviewTime,
      eligible: false,
    },
    {
      name: 'invalid review timestamp',
      effect: { status: 'failed' },
      reviewedAt: 'invalid',
      eligible: false,
    },
    {
      name: 'mail needs its own review',
      effect: { status: 'completed', uncertainty: { kind: 'mail', draftId: 'unknown' } },
      reviewedAt: reviewTime,
      eligible: false,
    },
    {
      name: 'mail explicitly reviewed',
      effect: {
        status: 'failed',
        uncertainty: { kind: 'mail', draftId: 'unknown', reviewedAt: reviewTime },
      },
      eligible: true,
    },
    {
      name: 'mail review survives later failure receipt',
      effect: {
        status: 'failed',
        updatedAt: reviewTime,
        uncertainty: { kind: 'mail', draftId: 'unknown', reviewedAt: executionTime },
      },
      eligible: true,
    },
    {
      name: 'mail review survives later completion receipt',
      effect: {
        status: 'completed',
        updatedAt: reviewTime,
        uncertainty: { kind: 'mail', draftId: 'unknown', reviewedAt: executionTime },
      },
      eligible: true,
    },
    {
      name: 'invalid mail review',
      effect: {
        status: 'completed',
        uncertainty: { kind: 'mail', draftId: 'unknown', reviewedAt: 'invalid' },
      },
      reviewedAt: reviewTime,
      eligible: false,
    },
    {
      name: 'started mail remains in flight after review',
      effect: {
        status: 'started',
        uncertainty: { kind: 'mail', draftId: 'unknown', reviewedAt: reviewTime },
      },
      reviewedAt: reviewTime,
      eligible: false,
    },
  ];
  const groups = cases.map((item) => {
    const work = f.addWork({ reviewedAt: item.reviewedAt });
    const source = f.addTask(work);
    const sibling = f.addTask(work, { status: 'completed' });
    const effect = operation(source, item.effect);
    f.store.put('operations', { ...effect, id: effect.key });
    return { ...item, source, sibling };
  });
  const uncertain = f.addWork();
  f.store.patch<WorkItem>('workItems', uncertain.id, {
    checkpoint: { ...uncertain.checkpoint, uncertainActions: ['The submit outcome is unknown.'] },
  });
  const checkpointTask = f.addTask(uncertain);
  const pending = f.addTask(f.addWork());
  f.store.put('approvals', approval(pending));
  const active = (
    ['queued', 'running', 'waiting_model', 'waiting_tool', 'awaiting_approval'] as const
  ).map((status) => f.addTask(f.addWork(), { status }));
  const before = [...active, checkpointTask, pending];
  assert.equal(reconcileAutomaticTaskHistory(f.store), true);
  for (const group of groups)
    for (const task of [group.source, group.sibling])
      assert.equal(
        Boolean(f.store.get<Task>('tasks', task.id)?.archivedAt),
        group.eligible,
        group.name,
      );
  for (const task of before) assert.deepEqual(f.store.get('tasks', task.id), task);
  assert.equal(f.store.get<Approval>('approvals', approval(pending).id)?.status, 'pending');
});

test('work completion and task settlement trigger cleanup without changing the execution or reservations themselves', async (t) => {
  const f = await fixture(t);
  const work = f.addWork({ status: 'active' });
  const old = f.addTask(work, { status: 'completed' });
  const finishing = f.addTask(work, { status: 'running' });
  await f.controller.work.changeStatus(work.id, 'completed', finishing.id);
  const afterClose = f.store.get('workItems', work.id);
  await f.flush();
  assert.equal(f.store.get<Task>('tasks', old.id)?.archiveReason, 'work_completed');
  assert.equal(f.store.get<Task>('tasks', finishing.id)?.archivedAt, undefined);
  f.controller.updateTask(finishing.id, {
    status: 'completed',
    completedAt: new Date(initial).toISOString(),
  });
  const finished = f.store.get<Task>('tasks', finishing.id)!;
  await f.flush();
  assert.equal(f.store.get<Task>('tasks', finishing.id)?.archiveReason, 'work_completed');
  assert.deepEqual(execution(f.store.get<Task>('tasks', finishing.id)!), finished);
  assert.deepEqual(execution(f.store.get<Task>('tasks', old.id)!), old);
  assert.deepEqual(f.store.get('workItems', work.id), afterClose);
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.stops, []);
});

test('late mail uncertainty restores automatic cards including siblings but leaves manual history intact', async (t) => {
  const f = await fixture(t);
  const work = f.addWork({ reviewedAt: reviewTime });
  const task = f.addTask(work);
  const sibling = f.addTask(work, { status: 'completed' });
  const manual = f.addTask(work, { archivedAt: executionTime });
  const effect = operation(task, {
    toolName: 'send_mail',
    args: { draftId: 'draft_late_unknown', expectedRevision: 1 },
  });
  await f.flush(() => f.controller.saveOperation(effect));
  assert.equal(f.store.get<Task>('tasks', task.id)?.archiveReason, 'work_completed');
  assert.equal(f.store.get<Task>('tasks', sibling.id)?.archiveReason, 'work_completed');
  f.store.put('mailDrafts', {
    id: 'draft_late_unknown',
    status: 'unknown',
    botId: task.botId,
    revision: 1,
  });
  const workBefore = f.store.get('workItems', work.id);
  await f.flush(() =>
    f.controller.recordUncertainWorkMail(task.id, effect.key, 'draft_late_unknown'),
  );
  assert.deepEqual(f.store.get('tasks', task.id), task);
  assert.deepEqual(f.store.get('tasks', sibling.id), sibling);
  assert.deepEqual(f.store.get('tasks', manual.id), manual);
  assert.deepEqual(f.store.get('workItems', work.id), workBefore);
  assert.deepEqual(f.controller.getOperation(effect.key)?.uncertainty, {
    kind: 'mail',
    draftId: 'draft_late_unknown',
  });
  await f.restart();
  assert.deepEqual(f.store.get('tasks', task.id), task);
  assert.deepEqual(f.store.get('tasks', sibling.id), sibling);
  assert.deepEqual(f.store.get('tasks', manual.id), manual);
});

test('manual restore persists across reevaluation and restart without starting or reopening anything', async (t) => {
  const f = await fixture(t);
  const work = f.addWork();
  const task = f.addTask(work);
  await f.restart();
  assert.equal(f.store.get<Task>('tasks', task.id)?.archiveReason, 'work_completed');
  f.controller.archiveTasks({ roomId: task.roomId, taskIds: [task.id], archived: false });
  const restored = f.store.get<Task>('tasks', task.id)!;
  assert.deepEqual(restored, { ...task, keepVisible: true });
  await f.flush(() => f.controller.saveOperation(operation(task)));
  assert.deepEqual(f.store.get('tasks', task.id), restored);
  const workBefore = f.store.get('workItems', work.id);
  await f.restart();
  assert.deepEqual(f.store.get('tasks', task.id), restored);
  assert.deepEqual(f.store.get('workItems', work.id), workBefore);
  assert.throws(() => f.controller.resume(task.id), /Review and resume this task’s work/);
  assert.deepEqual(f.store.get('tasks', task.id), restored);
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.stops, []);
});

test('mail review acknowledgment survives later receipt writes but never carries over to a new operation', async (t) => {
  const f = await fixture(t);
  const task = f.addTask(f.addWork());
  const effect = operation(task, { toolName: 'send_mail', status: 'failed' });
  const uncertainty = { kind: 'mail' as const, draftId: 'reviewed_draft', reviewedAt: reviewTime };
  await f.flush(() => f.controller.saveOperation({ ...effect, uncertainty }));
  const archivedAt = f.store.get<Task>('tasks', task.id)?.archivedAt;
  assert.ok(archivedAt);
  for (const status of ['completed', 'failed'] as const) {
    await f.flush(() =>
      f.controller.saveOperation({ ...effect, status, updatedAt: new Date(initial).toISOString() }),
    );
    assert.deepEqual(f.controller.getOperation(effect.key)?.uncertainty, uncertainty);
    assert.equal(f.store.get<Task>('tasks', task.id)?.archivedAt, archivedAt);
    assert.equal(f.store.get<Task>('tasks', task.id)?.archiveReason, 'work_completed');
  }
  await f.flush(() =>
    f.controller.saveOperation({
      ...effect,
      key: 'new_mail_effect',
      status: 'completed',
      uncertainty: { kind: 'mail', draftId: 'new_unknown_draft' },
      updatedAt: new Date(initial).toISOString(),
    }),
  );
  assert.deepEqual(f.store.get('tasks', task.id), task);
  assert.deepEqual(f.controller.getOperation(effect.key)?.uncertainty, uncertainty);
});

test('automatic metadata is removed when task, work, scope, or approval eligibility changes', async (t) => {
  const f = await fixture(t);
  const mutations: ((task: Task, work: WorkItem) => void)[] = [
    (task) => f.store.patch<Task>('tasks', task.id, { status: 'running' }),
    (task) => f.store.patch<Task>('tasks', task.id, { roomId: 'another_room' }),
    (_, work) => f.store.remove('workItems', work.id),
    (_, work) => f.store.patch<WorkItem>('workItems', work.id, { status: 'paused' }),
    (_, work) =>
      f.store.patch<WorkItem>('workItems', work.id, {
        checkpoint: { ...work.checkpoint, uncertainActions: ['Uncertain result'] },
      }),
    (task) => f.store.put('approvals', approval(task)),
    (task) => f.store.patch<Task>('tasks', task.id, { keepVisible: true }),
  ];
  for (const mutate of mutations) {
    const work = f.addWork();
    const task = f.addTask(work);
    reconcileAutomaticTaskHistory(f.store);
    assert.equal(f.store.get<Task>('tasks', task.id)?.archiveReason, 'work_completed');
    mutate(task, work);
    const executionBefore = execution(f.store.get<Task>('tasks', task.id)!);
    reconcileAutomaticTaskHistory(f.store);
    const saved = f.store.get<Task>('tasks', task.id)!;
    assert.equal(saved.archivedAt, undefined);
    assert.equal(saved.archiveReason, undefined);
    assert.deepEqual(execution(saved), executionBefore);
  }
});

test('approval lifecycle restores automatic visibility until the current approval is resolved', async (t) => {
  const f = await fixture(t);
  const task = f.addTask(f.addWork());
  await f.restart();
  const abort = new AbortController();
  let decision: Promise<boolean> | undefined;
  await f.flush(() => {
    const { id: _id, status: _status, createdAt: _createdAt, ...input } = approval(task);
    decision = f.controller.requestApproval(input, abort.signal);
  });
  assert.equal(f.store.get<Task>('tasks', task.id)?.archivedAt, undefined);
  assert.equal(f.store.list<Approval>('approvals')[0].status, 'pending');
  await f.flush(() => abort.abort());
  assert.equal(await decision, false);
  assert.equal(f.store.get<Task>('tasks', task.id)?.archiveReason, 'work_completed');
  assert.equal(f.store.list<Approval>('approvals')[0].status, 'cancelled');
});

test('restart uses recovered state while in-flight effects remain visible and a paused queue stays active', async (t) => {
  const f = await fixture(t);
  const clean = f.addTask(f.addWork());
  const uncertain = f.addTask(f.addWork({ reviewedAt: reviewTime }));
  const held = f.addTask(f.addWork());
  f.store.put('approvals', approval(clean));
  const effect = operation(uncertain, {
    status: 'started',
    toolName: 'send_mail',
    args: { draftId: 'sending' },
  });
  f.store.put('operations', { ...effect, id: effect.key });
  await f.restart((store) => {
    store.patch<Room>('rooms', 'room_lounge', { paused: true });
    store.patch<Task>('tasks', clean.id, { status: 'running' });
    store.patch<Task>('tasks', uncertain.id, { status: 'waiting_tool' });
    store.patch<Task>('tasks', held.id, {
      status: 'queued',
      archivedAt: executionTime,
      archiveReason: 'work_completed',
    });
  });
  assert.equal(f.store.get<Task>('tasks', clean.id)?.status, 'interrupted');
  assert.equal(f.store.get<Task>('tasks', clean.id)?.archiveReason, 'work_completed');
  assert.equal(f.store.get<Approval>('approvals', approval(clean).id)?.status, 'cancelled');
  assert.equal(f.store.get<Task>('tasks', uncertain.id)?.status, 'interrupted');
  assert.equal(f.store.get<Task>('tasks', uncertain.id)?.archivedAt, undefined);
  assert.equal(f.store.get<Task>('tasks', held.id)?.status, 'queued');
  assert.equal(f.store.get<Task>('tasks', held.id)?.archivedAt, undefined);
  assert.equal(f.store.get<Task>('tasks', held.id)?.archiveReason, undefined);
  assert.deepEqual(f.starts, []);
});

test('snapshot reads stay pure and stream-only updates avoid automatic history scans', async (t) => {
  const f = await fixture(t);
  const task = f.addTask(f.addWork());
  const count = () => f.store.db.prepare('SELECT total_changes() AS count').get();
  const before = count();
  assert.equal(
    f.controller.getSnapshot().tasks.find((item) => item.id === task.id)?.archivedAt,
    undefined,
  );
  assert.deepEqual(count(), before);
  const list = t.mock.method(f.store, 'list');
  await f.flush();
  assert.equal(
    list.mock.calls.filter((call) => call.arguments[0] === 'tasks').length,
    1,
    'only the emitted snapshot reads tasks',
  );
  assert.equal(f.store.get<Task>('tasks', task.id)?.archivedAt, undefined);
  await f.flush(() => f.controller.saveOperation(operation(task)));
  assert.equal(f.store.get<Task>('tasks', task.id)?.archiveReason, 'work_completed');
});

test('automatic batches roll back completely and a failed cleanup cannot escape the snapshot timer', async (t) => {
  const f = await fixture(t);
  const work = f.addWork();
  const first = f.addTask(work);
  const second = f.addTask(work, { id: 'task_auto_write_failure' });
  const before = f.store.list('tasks');
  f.store.db.exec(
    "CREATE TEMP TRIGGER fail_auto_history BEFORE UPDATE ON objects WHEN NEW.kind='tasks' AND NEW.id='task_auto_write_failure' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;",
  );
  assert.throws(() => reconcileAutomaticTaskHistory(f.store), /fixture write failure/);
  assert.deepEqual(f.store.list('tasks'), before);
  const snapshot = await f.flush(() => f.controller.saveOperation(operation(first)));
  assert.deepEqual(snapshot.tasks, before);
  assert.deepEqual(f.store.list('tasks'), before);
  f.store.db.exec('DROP TRIGGER fail_auto_history');
  await f.flush();
  for (const task of [first, second]) {
    const saved = f.store.get<Task>('tasks', task.id)!;
    assert.equal(saved.archiveReason, 'work_completed');
    assert.deepEqual(execution(saved), task);
  }
});
