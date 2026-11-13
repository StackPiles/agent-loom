import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createApp } from '../src/server/app.js';
import type { OperationRecord } from '../src/server/runtime/contract.js';
import type { Activity, Approval, Bot, Message, Room, Task } from '../src/shared/types.js';
import { DEFAULT_AUTONOMOUS_WAKEUP_POLICY, type WorkItem } from '../src/shared/work.js';
import {
  classifyTaskInterruption,
  RUNTIME_SHUTDOWN_REASONS,
  taskInterruptionMessage,
} from '../src/shared/task-interruption.js';

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

interface RequestRecord {
  marker: string;
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  response: ServerResponse;
  ended: boolean;
  progress(text: string): void;
  complete(): void;
  tool(name: string, args: Record<string, unknown>): void;
}

/** Real Pi sessions against held local SSE responses; no external model or account is used. */
async function fixture(t: TestContext, idleTimeoutSeconds = 10) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-cancellation-'));
  const requests: RequestRecord[] = [];
  let active = 0;
  let maximum = 0;
  let onRequest: (request: RequestRecord) => void = () => {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: RequestRecord['messages'];
    };
    const marker = payload.messages
      .filter((message) => message.role === 'user')
      .flatMap((message) => [...JSON.stringify(message.content).matchAll(/CANCEL_[A-Z_]+/g)])
      .at(-1)?.[0];
    assert.ok(marker);
    const requestIndex = requests.length;
    active++;
    maximum = Math.max(maximum, active);
    const send = (delta: object, finish: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: marker, object: 'chat.completion.chunk', created: 1, model: 'cancellation-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    const ended = () => {
      if (record.ended) return;
      record.ended = true;
      active--;
    };
    const finish = (reason: string) => {
      send({}, reason);
      response.end('data: [DONE]\n\n');
      ended();
    };
    const record: RequestRecord = {
      marker,
      messages: payload.messages,
      response,
      ended: false,
      progress(text) {
        if (!record.ended) send({ content: text });
      },
      complete() {
        if (record.ended) return;
        send({ content: `finished-${marker}` });
        finish('stop');
      },
      tool(name, args) {
        assert.equal(record.ended, false);
        send({
          tool_calls: [
            {
              index: 0,
              id: `call-${requestIndex}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
        finish('tool_calls');
      },
    };
    response.once('close', ended);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    send({ role: 'assistant', content: `partial-${marker} ` });
    requests.push(record);
    onRequest(record);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const dataDir = join(directory, 'data');
  let instance = await createApp({ dataDir, scheduler: false });
  t.after(async () => {
    await instance.app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const settings = instance.store.settings();
  // Public settings require integer seconds; short local fixture budgets keep
  // the actual timeout/queue/cancellation pipeline deterministic and fast.
  instance.store.put('settings', {
    ...settings,
    id: 'main',
    autoLearn: false,
    inference: { maxConcurrentRequests: 2 },
    permissions: { ...settings.permissions, fileWrite: 'allow' },
    model: {
      ...settings.model,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: 'cancellation-fixture',
      responseTimeoutSeconds: 10,
      idleTimeoutSeconds,
    },
  });
  const original = instance.store.get<Bot>('bots', 'bot_aster')!;
  const botIds = ['bot_aster', 'bot_nova', 'bot_three', 'bot_four', 'bot_five'];
  for (const [index, id] of botIds.entries())
    if (index >= 2)
      instance.store.put<Bot>('bots', {
        ...original,
        id,
        name: `Fixture ${index + 1}`,
        handle: `fixture_${index + 1}`,
      });
  const created = await instance.app.inject({
    method: 'POST',
    url: '/api/rooms',
    payload: { name: 'Cancellation fixture', botIds, parallelResponses: true },
  });
  assert.equal(created.statusCode, 200, created.body);
  const room = created.json<Room>();
  return {
    get app() {
      return instance.app;
    },
    get controller() {
      return instance.controller;
    },
    get runtime() {
      return instance.runtime;
    },
    get store() {
      return instance.store;
    },
    botIds,
    room,
    requests,
    maximum: () => maximum,
    onRequest(handler: typeof onRequest) {
      onRequest = handler;
    },
    start(marker: string, bot = 0, parentTaskId?: string, roomId = room.id) {
      return instance.controller.enqueueTask({
        roomId,
        botId: botIds[bot],
        prompt: marker,
        ...(parentTaskId ? { parentTaskId } : {}),
      });
    },
    task(task: Task) {
      return instance.store.get<Task>('tasks', task.id)!;
    },
    bindWork(task: Task) {
      instance.store.patch<Room>('rooms', task.roomId, {
        autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'self' },
      });
      return instance.controller.manageWakeup(task.id, {
        operation: 'upsert',
        key: 'update-cancellation',
        name: 'Retain cancelled work',
        purpose: 'Continue only after explicit recovery of interrupted work.',
        reason: 'Inspect the saved progress later.',
        prompt: 'Inspect the saved progress and continue the current work.',
        schedule: {
          type: 'once',
          dateTime: '2099-06-15T09:00',
          timeZone: 'UTC',
          missedRunPolicy: 'run_once',
        },
        checkpoint: {
          summary: 'The current task is in progress.',
          completed: '',
          nextStep: 'Continue the current task.',
          references: [],
          doneWhen: 'The current work is finished.',
          uncertainActions: [],
        },
      }).work;
    },
    work(work: WorkItem) {
      return instance.store.get<WorkItem>('workItems', work.id)!;
    },
    message(task: Task) {
      return instance.store.list<Message>('messages').findLast((item) => item.taskId === task.id)!;
    },
    operations(task: Task) {
      return instance.store
        .list<OperationRecord>('operations')
        .filter((item) => item.taskId === task.id);
    },
    async request(task: Task, count = 1) {
      await until(
        () => requests.filter((item) => item.marker === task.prompt).length >= count,
        `request ${task.prompt}`,
      );
      return requests.filter((item) => item.marker === task.prompt)[count - 1];
    },
    async restart() {
      await instance.app.close();
      instance = await createApp({ dataDir, scheduler: false });
    },
  };
}

test('interruption classification accepts only complete known messages and preserves legacy uncertainty', () => {
  for (const reason of [...RUNTIME_SHUTDOWN_REASONS, 'owner_stop', 'unexpected'] as const) {
    const message = taskInterruptionMessage(reason);
    assert.equal(classifyTaskInterruption(message), reason);
    assert.equal(classifyTaskInterruption(`${message} extra provider details`), 'unknown');
    assert.equal(classifyTaskInterruption(message.slice(0, -1)), 'unknown');
  }
  assert.equal(classifyTaskInterruption(taskInterruptionMessage('owner_stop', true)), 'owner_stop');
  for (const legacy of [
    'Stopped. You can resume explicitly; completed side effects will not be replayed automatically.',
    'Stopped before execution.',
    'Request timed out.',
    undefined,
    {},
  ])
    assert.equal(classifyTaskInterruption(legacy), 'unknown');
});

test(
  'one timeout among five bots at capacity two does not stop siblings or descendant tasks',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, 1);
    f.onRequest((request) => {
      if (['CANCEL_CHILD', 'CANCEL_SIBLING', 'CANCEL_DESCENDANT'].includes(request.marker))
        request.complete();
    });
    // Session setup can outlast the one-second idle budget on slower hosts.
    // Keep both active requests alive until all three waiters are established.
    let keepParentAlive = true;
    const progress = setInterval(() => {
      for (const request of f.requests)
        if (
          request.marker === 'CANCEL_INDEPENDENT' ||
          (keepParentAlive && request.marker === 'CANCEL_TIMEOUT')
        )
          request.progress('.');
    }, 100);
    t.after(() => clearInterval(progress));
    const parent = f.start('CANCEL_TIMEOUT');
    const independent = f.start('CANCEL_INDEPENDENT', 1);
    const [stalled, live] = await Promise.all([f.request(parent), f.request(independent)]);
    const child = f.start('CANCEL_CHILD', 2, parent.id);
    const sibling = f.start('CANCEL_SIBLING', 3, parent.id);
    const descendant = f.start('CANCEL_DESCENDANT', 4, child.id);
    await until(() => f.runtime.queueState().modelWaiting === 3, 'three queued model requests');
    assert.equal(f.requests.length, 2);
    keepParentAlive = false;
    await until(() => f.task(parent).status === 'failed', 'parent model timeout');
    await until(
      () => [child, sibling, descendant].every((task) => f.task(task).status === 'completed'),
      'descendants still finish',
    );
    assert.equal(f.task(independent).status, 'running');
    assert.equal(live.ended, false);
    assert.equal(stalled.ended, true);
    assert.match(f.task(parent).error!, /stopped producing output/);
    assert.equal(classifyTaskInterruption(f.task(parent).error), 'unknown');
    assert.match(f.message(parent).body, /partial-CANCEL_TIMEOUT/);
    assert.equal(f.message(parent).status, 'error');
    live.complete();
    await until(() => f.task(independent).status === 'completed', 'independent bot completed');
    assert.equal(f.maximum(), 2);
    for (const task of [parent, independent, child, sibling, descendant])
      assert.equal(f.requests.filter((request) => request.marker === task.prompt).length, 1);
    assert.equal(f.runtime.queueState().active, 0);
    assert.equal(f.runtime.queueState().waiting, 0);
  },
);

for (const reason of RUNTIME_SHUTDOWN_REASONS) {
  test(
    `shutdown records ${reason} without claiming that the user stopped work`,
    { timeout: 20_000 },
    async (t) => {
      const f = await fixture(t);
      const running = f.start('CANCEL_RUNNING');
      await f.request(running);
      await until(
        () => f.message(running)?.body.includes('partial-CANCEL_RUNNING'),
        'partial output',
      );
      const queued = f.start('CANCEL_QUEUED');
      await until(() => f.runtime.queueState().sessionWaiting === 1, 'same-session queue');
      await f.controller.shutdown(reason);
      for (const task of [running, queued]) {
        assert.equal(f.task(task).status, 'interrupted');
        assert.equal(f.task(task).error, taskInterruptionMessage(reason));
        assert.ok(f.task(task).completedAt);
      }
      assert.match(f.message(running).body, /partial-CANCEL_RUNNING/);
      assert.equal(f.message(running).status, 'error');
      assert.ok(
        f.store
          .list<Activity>('activities')
          .some(
            (activity) =>
              activity.taskId === running.id &&
              activity.title === 'Task interrupted' &&
              activity.detail === taskInterruptionMessage(reason),
          ),
      );
      assert.equal(f.requests.length, 1, 'a shutdown must not dispatch the waiting task');
      assert.equal(f.runtime.queueState().active, 0);
      assert.equal(f.runtime.queueState().waiting, 0);
    },
  );
}

test('shutdown settles tasks before deferred admission while preserving an unstarted paused queue', async (t) => {
  const f = await fixture(t);
  const pausedRoom: Room = { ...f.room, id: 'room_paused_admission', paused: true };
  f.store.put('rooms', pausedRoom);
  f.runtime.setRoomPaused!(pausedRoom.id, true);
  const pending = f.start('CANCEL_BEFORE_ADMISSION');
  const held = f.start('CANCEL_BEFORE_PAUSED_ADMISSION', 1, undefined, pausedRoom.id);
  await f.controller.shutdown('supervisor_disconnect');
  assert.equal(f.task(pending).status, 'interrupted');
  assert.equal(f.task(pending).error, taskInterruptionMessage('supervisor_disconnect'));
  assert.equal(f.task(pending).startedAt, undefined);
  assert.equal(f.task(held).status, 'queued');
  assert.equal(f.requests.length, 0);
  await f.restart();
  assert.equal(f.task(pending).status, 'interrupted');
  assert.equal(f.task(pending).error, taskInterruptionMessage('supervisor_disconnect'));
  assert.equal(f.task(held).status, 'queued');
  assert.equal(f.requests.length, 0);
});

for (const explicitStop of [false, true]) {
  test(
    `shutdown settles live and completed update checkpoints${explicitStop ? ' while preserving an explicit stop' : ''}`,
    { timeout: 25_000 },
    async (t) => {
      const f = await fixture(t);
      const settings = f.store.settings();
      f.store.put('settings', {
        ...settings,
        id: 'main',
        permissions: { ...settings.permissions, fileWrite: 'ask' },
      });
      const completedCheckpoint = f.start('CANCEL_UPDATE_COMPLETED');
      const liveCheckpoint = f.start('CANCEL_UPDATE_LIVE', 1);
      const [first, second] = await Promise.all([
        f.request(completedCheckpoint),
        f.request(liveCheckpoint),
      ]);
      const checkpointWork = f.bindWork(completedCheckpoint);
      const liveWork = f.bindWork(liveCheckpoint);
      let releaseApproval!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseApproval = resolve;
      });
      const requestApproval = f.controller.requestApproval.bind(f.controller);
      t.mock.method(
        f.controller,
        'requestApproval',
        async (...args: Parameters<typeof requestApproval>) => {
          const result = await requestApproval(...args);
          if (args[0].taskId === liveCheckpoint.id) await released;
          return result;
        },
      );
      second.tool('write_file', { path: 'never-live.txt', content: 'Never approved.' });
      await until(
        () =>
          f.store
            .list<Approval>('approvals')
            .some(
              (approval) => approval.taskId === liveCheckpoint.id && approval.status === 'pending',
            ),
        'pending approval',
      );
      f.controller.pauseRoom(f.room.id);
      first.tool('write_file', { path: 'never-completed.txt', content: 'Never approved.' });
      await until(
        () =>
          [completedCheckpoint, liveCheckpoint].every((task) =>
            f.runtime.isTaskSuspended!(task.id),
          ),
        'both update checkpoints',
      );
      const held = f.start('CANCEL_UPDATE_QUEUE', 2);
      await until(
        () =>
          f.runtime
            .queueState()
            .waitingTasks?.some(
              (waiter) => waiter.taskId === held.id && waiter.reason === 'paused',
            ) === true,
        'unstarted paused queue',
      );
      let cleaned = false;
      const releaseTask = f.controller.browser!.releaseTask.bind(f.controller.browser!);
      t.mock.method(f.controller.browser!, 'releaseTask', (taskId: string) => {
        releaseTask(taskId);
        if (taskId === completedCheckpoint.id && f.task(completedCheckpoint).status === 'stopped')
          queueMicrotask(() => {
            cleaned = true;
          });
      });
      f.controller.maintenance = true;
      const preparing = f.runtime.prepareForUpdate!().then(
        () => undefined,
        (error: unknown) => error,
      );
      let shuttingDown: Promise<void> | undefined;
      try {
        await until(() => cleaned, 'first checkpoint cleanup');
        assert.equal(f.task(completedCheckpoint).status, 'stopped');
        assert.equal(f.task(completedCheckpoint).error, undefined);
        assert.equal(f.work(checkpointWork).status, 'active');
        assert.equal(f.work(liveWork).status, 'active');
        if (explicitStop) await f.controller.stop(completedCheckpoint.id);
        shuttingDown = f.controller.shutdown('process_sigterm');
      } finally {
        releaseApproval();
      }
      await shuttingDown;
      assert.equal(((await preparing) as { code?: string })?.code, 'update_busy');
      assert.equal(f.task(completedCheckpoint).status, explicitStop ? 'stopped' : 'interrupted');
      assert.equal(
        f.task(completedCheckpoint).error,
        taskInterruptionMessage(explicitStop ? 'owner_stop' : 'process_sigterm'),
      );
      assert.equal(f.task(liveCheckpoint).status, 'interrupted');
      assert.equal(f.task(liveCheckpoint).error, taskInterruptionMessage('process_sigterm'));
      for (const work of [checkpointWork, liveWork]) {
        assert.equal(f.work(work).status, 'blocked');
        assert.equal(f.work(work).reviewedAt, undefined);
        assert.deepEqual(f.work(work).checkpoint, work.checkpoint);
      }
      assert.equal(f.task(held).status, 'queued');
      assert.equal(
        f.store.list<Approval>('approvals').some((approval) => approval.status === 'pending'),
        false,
      );
      await f.restart();
      assert.equal(f.task(completedCheckpoint).status, explicitStop ? 'stopped' : 'interrupted');
      assert.equal(f.task(liveCheckpoint).status, 'interrupted');
      assert.equal(f.task(held).status, 'queued');
      for (const work of [checkpointWork, liveWork]) assert.equal(f.work(work).status, 'blocked');
      assert.equal(
        f.requests.length,
        2,
        'shutdown and restart do not recover interrupted checkpoints',
      );
      f.controller.resumeRoom(f.room.id);
      for (const task of [completedCheckpoint, liveCheckpoint])
        assert.throws(() => f.controller.resume(task.id), /Review and resume this task’s work/);
      (await f.request(held)).complete();
      await until(() => f.task(held).status === 'completed', 'explicitly resumed paused queue');
      for (const filename of ['never-live.txt', 'never-completed.txt'])
        await assert.rejects(readFile(join(f.task(completedCheckpoint).workspacePath!, filename)), {
          code: 'ENOENT',
        });
    },
  );
}

test(
  'failed update checkpoint cleanup blocks linked work and keeps its task interrupted after restart',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const task = f.start('CANCEL_UPDATE_CLEANUP');
    const request = await f.request(task);
    const work = f.bindWork(task);
    f.controller.pauseRoom(f.room.id);
    request.tool('write_file', {
      path: 'never-after-failed-cleanup.txt',
      content: 'This requires explicit recovery.',
    });
    await until(() => f.runtime.isTaskSuspended!(task.id), 'update checkpoint before cleanup');
    let failedCleanup = false;
    const releaseTask = f.controller.browser!.releaseTask.bind(f.controller.browser!);
    t.mock.method(f.controller.browser!, 'releaseTask', (taskId: string) => {
      releaseTask(taskId);
      if (!failedCleanup && taskId === task.id && f.task(task).status === 'stopped') {
        failedCleanup = true;
        throw new Error('Fixture checkpoint cleanup failure.');
      }
    });
    f.controller.maintenance = true;
    await assert.rejects(f.runtime.prepareForUpdate!(), {
      code: 'update_busy',
      statusCode: 409,
    });
    assert.equal(failedCleanup, true);
    assert.equal(f.task(task).status, 'interrupted');
    assert.equal(f.task(task).error, taskInterruptionMessage('application_update'));
    assert.equal(f.work(work).status, 'blocked');
    assert.equal(f.work(work).reviewedAt, undefined);
    assert.deepEqual(f.work(work).checkpoint, work.checkpoint);
    assert.equal(f.requests.length, 1);
    f.controller.maintenance = false;
    f.controller.resumeRoom(f.room.id);
    assert.throws(() => f.controller.resume(task.id), /Review and resume this task’s work/);
    await f.restart();
    assert.equal(f.task(task).status, 'interrupted');
    assert.equal(f.work(work).status, 'blocked');
    assert.equal(f.requests.length, 1, 'failed checkpoint recovery cannot start another request');
    await assert.rejects(
      readFile(join(f.task(task).workspacePath!, 'never-after-failed-cleanup.txt')),
      { code: 'ENOENT' },
    );
  },
);

test(
  'a failed partial update requeue interrupts both saved and unsaved work continuations',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const tasks = [f.start('CANCEL_REQUEUE_FIRST'), f.start('CANCEL_REQUEUE_SECOND', 1)];
    const requests = await Promise.all(tasks.map((task) => f.request(task)));
    const works = tasks.map((task) => f.bindWork(task));
    f.controller.pauseRoom(f.room.id);
    for (const [index, request] of requests.entries())
      request.tool('write_file', {
        path: `never-after-requeue-${index}.txt`,
        content: 'This requires explicit recovery.',
      });
    await until(
      () => tasks.every((task) => f.runtime.isTaskSuspended!(task.id)),
      'both update checkpoints before requeue',
    );
    const updateTask = f.controller.updateTask.bind(f.controller);
    let requeued = 0;
    let savedBeforeFailure: string | undefined;
    t.mock.method(f.controller, 'updateTask', (...args: Parameters<typeof updateTask>) => {
      const [taskId, patch] = args;
      if (patch.status === 'queued' && tasks.some((task) => task.id === taskId)) {
        requeued++;
        if (requeued === 2) {
          assert.equal(f.store.get<Task>('tasks', savedBeforeFailure!)?.status, 'queued');
          throw new Error('Fixture requeue persistence failure.');
        }
        savedBeforeFailure = taskId;
      }
      return updateTask(...args);
    });
    f.controller.maintenance = true;
    await assert.rejects(f.runtime.prepareForUpdate!(), /Fixture requeue persistence failure/);
    assert.equal(requeued, 2);
    for (const task of tasks) {
      assert.equal(f.task(task).status, 'interrupted');
      assert.equal(f.task(task).error, taskInterruptionMessage('application_update'));
    }
    for (const work of works) {
      assert.equal(f.work(work).status, 'blocked');
      assert.equal(f.work(work).reviewedAt, undefined);
    }
    f.controller.maintenance = false;
    f.controller.resumeRoom(f.room.id);
    for (const task of tasks)
      assert.throws(() => f.controller.resume(task.id), /Review and resume this task’s work/);
    f.controller.pauseRoom(f.room.id);
    await f.restart();
    for (const task of tasks) assert.equal(f.task(task).status, 'interrupted');
    for (const work of works) assert.equal(f.work(work).status, 'blocked');
    assert.equal(f.requests.length, 2, 'neither continuation is dispatched after a partial save');
    for (const index of tasks.keys())
      await assert.rejects(
        readFile(join(f.task(tasks[index]).workspacePath!, `never-after-requeue-${index}.txt`)),
        { code: 'ENOENT' },
      );
  },
);

test(
  'shutdown preserves completed receipts and the paused queue across restart without replay',
  { timeout: 25_000 },
  async (t) => {
    const f = await fixture(t);
    const task = f.start('CANCEL_RECEIPT');
    const args = { path: 'receipt.txt', content: 'Completed before shutdown.' };
    (await f.request(task)).tool('write_file', args);
    await f.request(task, 2);
    await until(() => f.operations(task)[0]?.status === 'completed', 'completed file receipt');
    const receipt = f.operations(task)[0];
    const filename = join(f.task(task).workspacePath!, args.path);
    assert.equal(await readFile(filename, 'utf8'), args.content);
    const pausedRoom: Room = { ...f.room, id: 'room_paused_fixture', paused: true };
    f.store.put('rooms', pausedRoom);
    f.runtime.setRoomPaused!(pausedRoom.id, true);
    const held = f.start('CANCEL_HELD', 1, undefined, pausedRoom.id);
    await until(
      () =>
        f.runtime
          .queueState()
          .waitingTasks?.some(
            (waiter) => waiter.taskId === held.id && waiter.reason === 'paused',
          ) === true,
      'paused queue',
    );
    await f.controller.shutdown('data_export');
    assert.equal(f.task(task).status, 'interrupted');
    assert.equal(f.task(held).status, 'queued');
    assert.deepEqual(f.operations(task), [receipt]);
    await f.restart();
    await delay(30);
    assert.equal(f.task(task).status, 'interrupted');
    assert.equal(f.task(held).status, 'queued');
    assert.equal(f.requests.length, 2, 'restarting does not replay or resume any task');
    assert.deepEqual(f.operations(task), [receipt]);
    await writeFile(filename, 'Owner edit after interruption.');
    f.controller.resume(task.id);
    (await f.request(task, 3)).tool('write_file', args);
    (await f.request(task, 4)).complete();
    await until(() => f.task(task).status === 'completed', 'explicitly resumed task');
    assert.equal(await readFile(filename, 'utf8'), 'Owner edit after interruption.');
    assert.deepEqual(f.operations(task), [receipt], 'completed side effects are not replayed');
    assert.equal(f.task(held).status, 'queued');
    f.controller.resumeRoom(pausedRoom.id);
    (await f.request(held)).complete();
    await until(() => f.task(held).status === 'completed', 'explicitly resumed room');
  },
);

for (const first of ['owner', 'shutdown'] as const) {
  test(
    `explicit stop wins when ${first} starts the cancellation race`,
    { timeout: 20_000 },
    async (t) => {
      const f = await fixture(t);
      const ownerStopped = f.start('CANCEL_OWNER');
      const interrupted = f.start('CANCEL_TEAMMATE', 1, ownerStopped.id);
      await Promise.all([f.request(ownerStopped), f.request(interrupted)]);
      await until(
        () => f.message(ownerStopped)?.body.includes('partial-CANCEL_OWNER'),
        'owner partial output',
      );
      const stop = () => f.controller.stop(ownerStopped.id);
      const shutdown = () => f.controller.shutdown('process_sigterm');
      const earlier = first === 'owner' ? stop() : shutdown();
      const later = first === 'owner' ? shutdown() : stop();
      await Promise.all([earlier, later]);
      assert.equal(f.task(ownerStopped).status, 'stopped');
      assert.equal(f.task(ownerStopped).error, taskInterruptionMessage('owner_stop'));
      assert.match(f.message(ownerStopped).body, /partial-CANCEL_OWNER/);
      assert.equal(f.task(interrupted).status, 'interrupted');
      assert.equal(f.task(interrupted).error, taskInterruptionMessage('process_sigterm'));
      assert.equal(f.requests.length, 2);
    },
  );
}

test(
  'an unexpected SDK cancellation is interrupted with a fixed cause and no provider error disclosure',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    let calls = 0;
    let suppliedSignal: AbortSignal | undefined;
    t.mock.method(
      ModelRuntime.prototype,
      'streamSimple',
      (...args: Parameters<ModelRuntime['streamSimple']>) => {
        const [model, , options] = args;
        calls++;
        suppliedSignal = options?.signal;
        const stream = createAssistantMessageEventStream();
        const partial: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: 'Preserved SDK partial.' }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: 'aborted',
          errorMessage: 'Provider detail https://fixture.invalid/private?token=do-not-copy',
          timestamp: 1,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        queueMicrotask(() => {
          stream.push({ type: 'start', partial });
          stream.push({
            type: 'text_delta',
            contentIndex: 0,
            delta: 'Preserved SDK partial.',
            partial,
          });
          stream.push({ type: 'error', reason: 'aborted', error: partial });
          stream.end(partial);
        });
        return stream;
      },
    );
    const task = f.start('CANCEL_UNEXPECTED');
    await until(() => f.task(task).status === 'interrupted', 'unexpected cancellation');
    assert.equal(calls, 1);
    assert.equal(suppliedSignal?.aborted, false, 'neither owner nor runtime cancelled the request');
    assert.equal(f.task(task).error, taskInterruptionMessage('unexpected'));
    assert.equal(f.message(task).body, 'Preserved SDK partial.');
    assert.equal(f.message(task).status, 'error');
    assert.equal(f.requests.length, 0);
    assert.doesNotMatch(
      JSON.stringify(f.store.list<Activity>('activities')),
      /fixture\.invalid|do-not-copy/,
    );
    assert.equal(f.runtime.queueState().active, 0);
  },
);
