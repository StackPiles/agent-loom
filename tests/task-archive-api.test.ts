import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import type { Approval, Room, Task } from '../src/shared/types.js';
import { DEFAULT_AUTONOMOUS_WAKEUP_POLICY, type WorkItem } from '../src/shared/work.js';

const initial = Date.parse('2030-01-15T08:00:00.000Z');
const executionTime = '2030-01-14T08:00:00.000Z';
const token = 'task-history-test-token';

async function fixture(t: TestContext, apiToken?: string) {
  t.mock.timers.enable({ apis: ['Date'], now: initial });
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-task-history-'));
  const starts: string[] = [];
  const stops: string[] = [];
  const open = () =>
    createApp({
      dataDir,
      apiToken,
      scheduler: false,
      runtimeFactory: () => ({
        start(task) {
          starts.push(task.id);
        },
        async stop(taskId) {
          stops.push(taskId);
        },
        async shutdown() {},
        queueState: () => ({ active: 0, waiting: 0 }),
      }),
    });
  let context = await open();
  context.store.put('settings', {
    ...context.store.settings(),
    id: 'main',
    demoMode: true,
    autoLearn: false,
  });
  t.after(async () => {
    await context.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const call = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    context.app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      headers: { host: 'localhost', ...headers },
    });
  let sequence = 0;
  return {
    starts,
    stops,
    call,
    get store() {
      return context.store;
    },
    get controller() {
      return context.controller;
    },
    addTask(status: Task['status'] = 'failed', patch: Partial<Task> = {}) {
      const taskId = 'task_history_' + ++sequence;
      return context.store.put<Task>('tasks', {
        id: taskId,
        roomId: 'room_lounge',
        botId: 'bot_aster',
        prompt: 'The original task instruction.',
        workspacePath: context.store.settings().workspacePath,
        status,
        rootTaskId: taskId,
        depth: 0,
        kind: 'chat',
        output: 'The retained partial result.',
        error: 'The original recorded error.',
        createdAt: executionTime,
        updatedAt: executionTime,
        startedAt: executionTime,
        completedAt: executionTime,
        inputTokens: 17,
        outputTokens: 23,
        ...patch,
      });
    },
    archive(taskIds: string[], archived = true, roomId = 'room_lounge') {
      return call('/api/tasks/archive', { roomId, taskIds, archived });
    },
    async restart(beforeOpen?: (store: Store) => void) {
      await context.app.close();
      if (beforeOpen) {
        const stored = new Store(dataDir);
        try {
          beforeOpen(stored);
        } finally {
          stored.close();
        }
      }
      context = await open();
    },
  };
}

function approval(task: Task, status: Approval['status']): Approval {
  return {
    id: 'approval_' + task.id,
    taskId: task.id,
    roomId: task.roomId,
    botId: task.botId,
    toolName: 'write_file',
    summary: 'Write the reviewed result.',
    target: 'result.txt',
    args: { path: 'result.txt' },
    status,
    createdAt: executionTime,
  };
}

test('single and bulk history changes are idempotent and preserve every execution field', async (t) => {
  const f = await fixture(t);
  const originals = (['failed', 'stopped', 'interrupted', 'completed'] as const).map((status) =>
    f.addTask(status),
  );
  const first = await f.archive([originals[0].id, originals[0].id]);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json<Task[]>().length, 1, 'duplicate IDs identify one saved task');
  const firstArchivedAt = first.json<Task[]>()[0].archivedAt;
  assert.equal(firstArchivedAt, new Date(initial).toISOString());

  t.mock.timers.setTime(initial + 1000);
  const bulk = await f.archive(originals.map((task) => task.id));
  assert.equal(bulk.statusCode, 200, bulk.body);
  const archived = bulk.json<Task[]>();
  assert.equal(archived[0].archivedAt, firstArchivedAt);
  assert.equal(archived[1].archivedAt, new Date(initial + 1000).toISOString());
  for (const [index, task] of archived.entries()) {
    const { archivedAt, ...execution } = task;
    assert.ok(archivedAt);
    assert.deepEqual(execution, originals[index]);
  }
  t.mock.timers.setTime(initial + 2000);
  assert.deepEqual((await f.archive(originals.map((task) => task.id))).json(), archived);
  const restored = await f.archive(
    originals.map((task) => task.id),
    false,
  );
  assert.equal(restored.statusCode, 200, restored.body);
  assert.deepEqual(restored.json(), originals);
  assert.deepEqual(
    (
      await f.archive(
        originals.map((task) => task.id),
        false,
      )
    ).json(),
    originals,
  );
  assert.deepEqual(f.store.list('tasks'), originals);
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.stops, []);
});

test('bulk validation rejects active tasks, pending approvals, missing records and other rooms without partial changes', async (t) => {
  const f = await fixture(t);
  const settled = f.addTask();
  for (const status of [
    'queued',
    'running',
    'waiting_model',
    'waiting_tool',
    'awaiting_approval',
  ] as const) {
    const active = f.addTask(status);
    const before = f.store.list('tasks');
    const response = await f.archive([settled.id, active.id]);
    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(f.store.list('tasks'), before);
    const restore = await f.archive([settled.id, active.id], false);
    assert.equal(restore.statusCode, 409, restore.body);
    assert.deepEqual(f.store.list('tasks'), before);
  }
  const pending = f.addTask('stopped');
  f.store.put('approvals', approval(pending, 'pending'));
  const pendingBefore = f.store.get('approvals', 'approval_' + pending.id);
  assert.equal((await f.archive([settled.id, pending.id])).statusCode, 409);
  assert.equal(f.store.get<Task>('tasks', settled.id)?.archivedAt, undefined);
  assert.equal(f.store.get<Task>('tasks', pending.id)?.archivedAt, undefined);
  assert.deepEqual(f.store.get('approvals', 'approval_' + pending.id), pendingBefore);

  const room = f.store.get<Room>('rooms', 'room_lounge')!;
  f.store.put('rooms', { ...room, id: 'other_room', name: 'Other room' });
  const other = f.addTask('failed', { roomId: 'other_room' });
  const before = f.store.list('tasks');
  assert.equal((await f.archive([settled.id, other.id])).statusCode, 409);
  assert.equal((await f.archive([settled.id, 'missing_task'])).statusCode, 404);
  assert.equal((await f.archive([settled.id], true, 'missing_room')).statusCode, 404);
  assert.deepEqual(f.store.list('tasks'), before);
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.stops, []);
});

test('a database write failure rolls back the entire history batch', async (t) => {
  const f = await fixture(t);
  const first = f.addTask();
  const second = f.addTask('stopped', { id: 'task_write_failure' });
  const before = f.store.list('tasks');
  f.store.db.exec(
    "CREATE TEMP TRIGGER fail_task_history BEFORE UPDATE ON objects WHEN NEW.kind='tasks' AND NEW.id='task_write_failure' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;",
  );
  const response = await f.archive([first.id, second.id]);
  assert.equal(response.statusCode, 500, response.body);
  assert.deepEqual(f.store.list('tasks'), before);
  assert.deepEqual(f.starts, []);
});

test('archiving and restoring reviewed failures survives restart without reblocking work or changing reservations and receipts', async (t) => {
  const f = await fixture(t);
  f.store.patch<Room>('rooms', 'room_lounge', {
    autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room' },
  });
  const source = f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Review the result when it arrives.',
  });
  const { work } = f.controller.manageWakeup(source.id, {
    operation: 'upsert',
    key: 'next-review',
    name: 'Review the result',
    purpose: 'Complete the assigned review.',
    reason: 'The result arrives later.',
    prompt: 'Inspect the result before acting.',
    checkpoint: {
      summary: 'Waiting for the result.',
      completed: 'Initial inspection is complete.',
      nextStep: 'Review the result.',
      references: [],
      doneWhen: 'The result has been reviewed.',
      uncertainActions: [],
    },
    schedule: {
      type: 'once',
      dateTime: '2099-01-01T09:00',
      timeZone: 'UTC',
      missedRunPolicy: 'run_once',
    },
  });
  f.controller.updateTask(source.id, {
    status: 'failed',
    error: 'The recorded failure before owner review.',
    completedAt: new Date(initial).toISOString(),
  });
  t.mock.timers.setTime(initial + 1000);
  f.controller.work.resume(work.id);
  f.store.put('approvals', approval(source, 'approved'));
  f.store.put('operations', {
    id: 'operation_history',
    key: 'operation_history',
    taskId: source.id,
    toolName: 'write_file',
    args: { path: 'result.txt' },
    status: 'completed',
    result: 'Already written.',
  });
  const execution = f.store.get<Task>('tasks', source.id)!;
  const related = () => ({
    works: f.store.list('workItems'),
    wakeups: f.store.list('wakeups'),
    approvals: f.store.list('approvals'),
    operations: f.store.list('operations'),
  });
  const before = related();
  t.mock.timers.setTime(initial + 2000);
  const response = await f.archive([source.id]);
  assert.equal(response.statusCode, 200, response.body);
  const archived = f.store.get<Task>('tasks', source.id)!;
  assert.equal(archived.updatedAt, execution.updatedAt);
  assert.ok(archived.archivedAt! > f.store.get<WorkItem>('workItems', work.id)!.reviewedAt!);
  assert.deepEqual(related(), before);
  await f.restart();
  assert.deepEqual(f.store.get('tasks', source.id), archived);
  assert.deepEqual(related(), before);
  assert.equal(f.store.get<WorkItem>('workItems', work.id)!.status, 'active');

  t.mock.timers.setTime(initial + 3000);
  assert.equal((await f.archive([source.id], false)).statusCode, 200);
  assert.deepEqual(f.store.get('tasks', source.id), execution);
  await f.restart();
  assert.deepEqual(f.store.get('tasks', source.id), execution);
  assert.deepEqual(related(), before);
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.stops, []);
});

test('explicit task resume clears history only after the existing recovery guards succeed', async (t) => {
  const f = await fixture(t);
  const task = f.addTask('stopped', { workspacePath: join(f.store.dataDir, 'old-workspace') });
  await f.archive([task.id]);
  const archived = f.store.get<Task>('tasks', task.id)!;
  const rejected = await f.call('/api/tasks/' + task.id + '/resume', {});
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.deepEqual(f.store.get('tasks', task.id), archived);

  f.store.patch<Task>('tasks', task.id, { workspacePath: f.store.settings().workspacePath });
  const resumed = await f.call('/api/tasks/' + task.id + '/resume', {});
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(resumed.json<Task>().id, task.id);
  assert.equal(resumed.json<Task>().status, 'queued');
  assert.equal(resumed.json<Task>().archivedAt, undefined);
  await setImmediate();
  assert.deepEqual(f.starts, [task.id]);
  assert.equal(f.store.list('tasks').length, 1);
});

test('startup makes inconsistent active history visible while retaining paused queued work', async (t) => {
  const f = await fixture(t);
  const held = f.addTask('stopped');
  const running = f.addTask('failed');
  await f.restart((store) => {
    store.patch<Room>('rooms', 'room_lounge', { paused: true });
    store.patch<Task>('tasks', held.id, { status: 'queued', archivedAt: executionTime });
    store.patch<Task>('tasks', running.id, { status: 'running', archivedAt: executionTime });
  });
  const heldAfter = f.store.get<Task>('tasks', held.id)!;
  assert.equal(heldAfter.status, 'queued');
  assert.equal(heldAfter.archivedAt, undefined);
  assert.equal(heldAfter.updatedAt, held.updatedAt);
  const interrupted = f.store.get<Task>('tasks', running.id)!;
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.archivedAt, undefined);
  assert.match(interrupted.error!, /Server restarted/);
  assert.deepEqual(f.starts, []);
});

test('history API retains authentication, origin, strict input and maintenance guards', async (t) => {
  const f = await fixture(t, token);
  const task = f.addTask();
  const payload = { roomId: task.roomId, taskIds: [task.id], archived: true };
  const headers = { authorization: 'Bearer ' + token };
  const call = (body: unknown = payload, extraHeaders: Record<string, string> = headers) =>
    f.call('/api/tasks/archive', body, extraHeaders);
  assert.equal((await call(payload, {})).statusCode, 401);
  assert.equal(
    (await call(payload, { ...headers, origin: 'https://untrusted.example' })).statusCode,
    403,
  );
  for (const invalid of [
    {},
    { ...payload, taskIds: [] },
    { ...payload, taskIds: Array.from({ length: 201 }, () => task.id) },
    { ...payload, taskIds: [1] },
    { ...payload, roomId: '' },
    { ...payload, archived: 'true' },
    { ...payload, unexpected: true },
  ])
    assert.equal((await call(invalid)).statusCode, 400);
  f.controller.maintenance = true;
  assert.equal((await call()).statusCode, 503);
  f.controller.maintenance = false;
  f.controller.closing = true;
  assert.equal((await call()).statusCode, 503);
  f.controller.closing = false;
  assert.deepEqual(f.store.get('tasks', task.id), task);
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.stops, []);
});
