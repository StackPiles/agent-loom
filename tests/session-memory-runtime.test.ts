import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createApp } from '../src/server/app.js';
import { RoomTaskScheduler } from '../src/server/runtime/pause.js';
import { SessionMemoryBudget } from '../src/server/runtime/session-memory.js';
import type { Room, Task, TaskInput, TaskInputResult } from '../src/shared/types.js';
import { DEFAULT_AUTONOMOUS_WAKEUP_POLICY, type WorkItem } from '../src/shared/work.js';

async function until(
  check: () => boolean,
  label: string,
  timeoutMs = 10_000,
  diagnostics?: () => unknown,
) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      const message =
        `Timed out after ${Date.now() - started}ms: ${label}` +
        (diagnostics ? `\n${JSON.stringify(diagnostics(), null, 2)}` : '');
      // The spec reporter may defer an Error until every test process exits.
      // Emit this evidence before cleanup so a leaked handle cannot hide it.
      process.stderr.write(`[session-memory-runtime] ${message}\n`);
      throw new Error(message);
    }
    await delay(10);
  }
}

interface HeldRequest {
  marker: string;
  response: ServerResponse;
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  finish(tool?: boolean, content?: string): void;
  finishTools(
    calls: Array<{ name: string; args: Record<string, unknown> }>,
    content?: string,
  ): void;
}

async function fixture(
  t: TestContext,
  totalMiB?: string,
  loadedSessions = '1',
  aliasDataRoot = false,
) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-session-memory-'));
  const oldLoaded = process.env.LOOM_SESSION_MAX_LOADED;
  const oldTotal = process.env.LOOM_SESSION_MEMORY_MB;
  process.env.LOOM_SESSION_MAX_LOADED = loadedSessions;
  if (totalMiB) process.env.LOOM_SESSION_MEMORY_MB = totalMiB;
  const requests: HeldRequest[] = [];
  const failures: unknown[] = [];
  const connections = new Set<Socket>();
  let instance: Awaited<ReturnType<typeof createApp>> | undefined;
  let closing = false;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const marker = JSON.stringify(payload.messages)
        .match(/MEMORY_[A-Z]+/g)
        ?.at(-1);
      assert.ok(marker);
      const index = requests.length;
      const send = (delta: unknown, finish_reason: string | null = null) => {
        response.write(
          `data: ${JSON.stringify({ id: `memory-${index}`, object: 'chat.completion.chunk', created: 1, model: 'memory-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      send({ role: 'assistant', content: '' });
      requests.push({
        marker,
        response,
        messages: payload.messages,
        finish(tool = false, content?: string) {
          if (content) send({ content });
          send(
            tool
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${index}`,
                      type: 'function',
                      function: { name: 'room_context', arguments: '{}' },
                    },
                  ],
                }
              : { content: `Finished ${marker}.` },
          );
          send({}, tool ? 'tool_calls' : 'stop');
          response.end('data: [DONE]\n\n');
        },
        finishTools(calls, content) {
          if (content) send({ content });
          send({
            tool_calls: calls.map((call, position) => ({
              index: position,
              id: `call-${index}-${position}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          });
          send({}, 'tool_calls');
          response.end('data: [DONE]\n\n');
        },
      });
    })().catch((error) => {
      if (!closing) failures.push(error);
      response.destroy(error as Error);
    });
  });
  server.on('connection', (connection) => {
    connections.add(connection);
    connection.once('close', () => connections.delete(connection));
    if (closing) connection.destroy();
  });
  let cleaned = false;
  const close = async () => {
    if (cleaned) return;
    cleaned = true;
    closing = true;
    const errors = [...failures];
    try {
      const stopping = instance
        ? [
            // Close admission even if Fastify cleanup itself rejects.
            Promise.resolve().then(() => instance!.controller.shutdown()),
            Promise.resolve().then(() => instance!.app.close()),
          ]
        : [];
      const httpClosed = new Promise<void>((resolve, reject) => {
        if (!server.listening) resolve();
        else server.close((error) => (error ? reject(error) : resolve()));
      });
      for (const request of requests) request.response.destroy();
      server.closeAllConnections();
      // Track raw connections too, including a request that has not reached
      // the async handler or a connection accepted just as cleanup started.
      for (const connection of connections) connection.destroy();
      for (const result of await Promise.allSettled([...stopping, httpClosed]))
        if (result.status === 'rejected') errors.push(result.reason);
    } finally {
      try {
        instance?.store.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await rm(directory, { force: true, recursive: true, maxRetries: 3 });
      } catch (error) {
        errors.push(error);
      } finally {
        if (oldLoaded === undefined) delete process.env.LOOM_SESSION_MAX_LOADED;
        else process.env.LOOM_SESSION_MAX_LOADED = oldLoaded;
        if (oldTotal === undefined) delete process.env.LOOM_SESSION_MEMORY_MB;
        else process.env.LOOM_SESSION_MEMORY_MB = oldTotal;
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Memory fixture cleanup failed.');
  };
  // Register before listening or initializing the app: either can fail while
  // the test still owns the temporary directory and environment overrides.
  t.after(async () => {
    try {
      await close();
    } catch (error) {
      process.stderr.write(`[session-memory-runtime] Cleanup failed: ${String(error)}\n`);
      throw error;
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const dataDir = join(directory, 'data');
  if (aliasDataRoot) {
    const target = join(directory, 'data-canonical');
    await mkdir(target);
    await symlink(target, dataDir, process.platform === 'win32' ? 'junction' : 'dir');
  }
  instance = await createApp({ dataDir, scheduler: false });
  const settings = await instance.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      model: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'memory-fixture',
        // These fixtures exercise resident bytes independently of token compaction.
        contextWindow: 2 ** 21,
        maxOutputTokens: 8192,
      },
      inference: { maxConcurrentRequests: 2 },
      autoLearn: false,
    },
  });
  assert.equal(settings.statusCode, 200, settings.body);
  return {
    ...instance,
    requests,
    dataDir,
    close,
    modelServerListening: () => server.listening,
    modelConnectionCount: () => connections.size,
    async room(name: string) {
      const result = await instance!.app.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: { name, botIds: ['bot_aster'] },
      });
      assert.equal(result.statusCode, 200, result.body);
      return result.json<Room>();
    },
    start(room: Room, marker: string) {
      return instance!.controller.enqueueTask({
        roomId: room.id,
        botId: 'bot_aster',
        prompt: marker,
      });
    },
    task(task: Task) {
      return instance!.store.get<Task>('tasks', task.id)!;
    },
    reason(task: Task) {
      return instance!.controller
        .runtime!.queueState()
        .waitingTasks?.find((item) => item.taskId === task.id)?.reason;
    },
    async request(marker: string, number = 1) {
      await until(
        () => {
          assert.deepEqual(failures, []);
          const task = instance!.store.list<Task>('tasks').find((item) => item.prompt === marker);
          assert.ok(!task || task.status !== 'failed', task?.error);
          return requests.filter((item) => item.marker === marker).length >= number;
        },
        marker,
        10_000,
        () => ({
          requests: requests.map((item) => item.marker),
          tasks: instance!.store.list<Task>('tasks').map((task) => ({
            prompt: task.prompt,
            status: task.status,
            error: task.error,
          })),
          queue: instance!.controller.runtime!.queueState(),
        }),
      );
      return requests.filter((item) => item.marker === marker)[number - 1];
    },
    async histories(room: Room) {
      const key = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
      try {
        return (await readdir(join(dataDir, 'sessions', key('bot_aster'), key(room.id)))).filter(
          (name) => name.endsWith('.jsonl'),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}

test(
  'real Pi history waits before loading, paused holders can resume, and cancelled waiters never start',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const one = await f.room('Loaded');
    const two = await f.room('Waiting');
    const three = await f.room('Cancelled');
    const first = f.start(one, 'MEMORY_FIRST');
    const held = await f.request(first.prompt);
    const second = f.start(two, 'MEMORY_SECOND');
    const cancelled = f.start(three, 'MEMORY_CANCELLED');
    await until(
      () => f.reason(second) === 'memory' && f.reason(cancelled) === 'memory',
      'memory admission wait',
    );
    assert.deepEqual(await f.histories(two), [], 'no Pi transcript was opened before admission');
    assert.deepEqual(await f.histories(three), []);
    await f.controller.runtime!.stop(cancelled.id);
    assert.equal(f.task(cancelled).status, 'stopped');
    f.controller.pauseRoom(one.id);
    held.finish(true);
    await until(() => f.reason(first) === 'paused', 'loaded continuation parked');
    assert.equal(f.requests.length, 1);
    assert.deepEqual(await f.histories(two), [], 'paused history still owns its reservation');
    f.controller.resumeRoom(one.id);
    (await f.request(first.prompt, 2)).finish();
    await until(() => f.task(first).status === 'completed', 'first task completed');
    (await f.request(second.prompt)).finish();
    await until(() => f.task(second).status === 'completed', 'second admitted after release');
    assert.equal(
      f.requests.some((item) => item.marker === cancelled.prompt),
      false,
    );
    assert.equal(f.controller.runtime!.queueState().waiting, 0);
  },
);

test(
  'update preparation releases retained memory and preserves unadmitted paused tasks for resume',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const one = await f.room('Loaded update');
    const two = await f.room('Unloaded update');
    const first = f.start(one, 'MEMORY_UPDATE');
    const held = await f.request(first.prompt);
    const second = f.start(two, 'MEMORY_AFTER');
    await until(() => f.reason(second) === 'memory', 'second waits without a session');
    f.controller.pauseRoom(one.id);
    f.controller.pauseRoom(two.id);
    held.finish(true);
    await until(
      () => f.reason(first) === 'paused' && f.reason(second) === 'paused',
      'both safe paused boundaries',
    );
    f.controller.maintenance = true;
    await f.controller.runtime!.prepareForUpdate!();
    assert.equal(f.task(first).status, 'queued');
    assert.equal(f.task(second).status, 'queued');
    assert.deepEqual(await f.histories(two), []);
    f.controller.maintenance = false;
    f.controller.resumeRoom(one.id);
    (await f.request(first.prompt, 2)).finish();
    await until(() => f.task(first).status === 'completed', 'resumed existing conversation');
    f.controller.resumeRoom(two.id);
    (await f.request(second.prompt)).finish();
    await until(
      () => f.task(second).status === 'completed',
      'resumed previously unloaded conversation',
    );
    assert.equal(f.controller.runtime!.queueState().waiting, 0);
  },
);

test('a preparing conversation returns granted memory before waiting for a busy worker', async (t) => {
  const f = await fixture(t, '96');
  const acquire = SessionMemoryBudget.prototype.acquireTemporary;
  const checkpoint = RoomTaskScheduler.prototype.checkpoint;
  let held = 0;
  let contended = false;
  let checked = false;
  let workers: RoomTaskScheduler | undefined;
  let occupied = false;
  const blockers: string[] = [];
  t.after(() => {
    for (const id of blockers) workers?.finish(id);
  });
  t.mock.method(
    SessionMemoryBudget.prototype,
    'acquireTemporary',
    function (this: SessionMemoryBudget, ...args: Parameters<typeof acquire>) {
      if (!contended) {
        contended = true;
        // A real temporary-pool waiter lends its worker. Free the blocker only
        // after that waiter has entered the queue, as a completing request would.
        void acquire
          .call(this, this.temporaryLimitBytes)
          .then((blocker) => queueMicrotask(() => blocker.release()));
      }
      return acquire.apply(this, args).then((lease) => {
        held++;
        if (!occupied) {
          occupied = true;
          assert.ok(workers);
          // The preparing task has lent its worker while memory was full.
          // Fill the workers before its memory grant continuation can run.
          for (let index = 0; index < workers.capacity; index++) {
            const id = `preparation-holder-${index}`;
            assert.equal(workers.tryStart(id, 'busy-worker-room'), true);
            blockers.push(id);
          }
        }
        let released = false;
        return {
          resize: lease.resize,
          release() {
            if (released) return;
            released = true;
            held--;
            lease.release();
          },
        };
      });
    },
  );
  t.mock.method(
    RoomTaskScheduler.prototype,
    'checkpoint',
    function (this: RoomTaskScheduler, ...args: Parameters<typeof checkpoint>) {
      workers = this;
      if (this.isSuspended(args[0])) {
        checked = true;
        assert.equal(held, 0, 'worker admission must not hold the temporary request allowance');
        assert.equal(this.activeCount, this.capacity);
        // Releasing memory must precede the actual asynchronous worker wait.
        setImmediate(() => {
          for (const id of blockers) this.finish(id);
        });
      }
      return checkpoint.apply(this, args);
    },
  );
  const room = await f.room('Preparation handoff');
  const task = f.start(room, 'MEMORY_HANDOFF');
  (await f.request(task.prompt)).finish();
  await until(() => f.task(task).status === 'completed', 'preparation resumes after contention');
  assert.equal(checked, true);
  assert.equal(held, 0);
});

test('fixture cleanup closes held model connections even when application close rejects', async (t) => {
  const previousLoaded = process.env.LOOM_SESSION_MAX_LOADED;
  const previousTotal = process.env.LOOM_SESSION_MEMORY_MB;
  const f = await fixture(t, '96');
  const room = await f.room('Cleanup failure');
  const task = f.start(room, 'MEMORY_CLEANUP');
  await f.request(task.prompt);
  assert.equal(f.modelConnectionCount(), 1);
  const appClose = f.app.close.bind(f.app);
  const failure = new Error('Synthetic application-close failure after shutdown.');
  t.mock.method(f.app, 'close', async () => {
    await appClose();
    throw failure;
  });
  await assert.rejects(
    f.close(),
    (error: unknown) => error instanceof AggregateError && error.errors.includes(failure),
  );
  assert.equal(f.modelServerListening(), false);
  assert.equal(f.modelConnectionCount(), 0);
  assert.equal(process.env.LOOM_SESSION_MAX_LOADED, previousLoaded);
  assert.equal(process.env.LOOM_SESSION_MEMORY_MB, previousTotal);
  await assert.rejects(readdir(f.dataDir), { code: 'ENOENT' });
});

test(
  'runtime admission counts independent memory waiters toward its own queue bound',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    let observedBudget: SessionMemoryBudget | undefined;
    const acquireSession = SessionMemoryBudget.prototype.acquireSession;
    t.mock.method(
      SessionMemoryBudget.prototype,
      'acquireSession',
      function (this: SessionMemoryBudget, ...args: Parameters<typeof acquireSession>) {
        observedBudget = this;
        return acquireSession.apply(this, args);
      },
    );
    const room = await f.room('Queue holder');
    const first = f.start(room, 'MEMORY_QUEUEHOLDER');
    await f.request(first.prompt);
    assert.ok(observedBudget);
    const budget = observedBudget;
    const rooms = Array.from({ length: 201 }, (_, index) => ({
      ...room,
      id: `memory-queue-room-${index}`,
      name: `Memory queue ${index}`,
    }));
    for (const candidate of rooms) f.store.put('rooms', candidate);
    f.controller.changed();
    // Normal enqueue/resume already has a separate controller-wide active-task
    // bound. Exercise the runtime contract used to start durable tasks directly.
    let sequence = 0;
    const startPersisted = (candidate: Room, prompt: string): Task => {
      const id = `memory-queue-task-${sequence++}`;
      const now = new Date().toISOString();
      const task: Task = {
        id,
        roomId: candidate.id,
        botId: first.botId,
        prompt,
        workspacePath: first.workspacePath,
        status: 'queued',
        rootTaskId: id,
        depth: 0,
        kind: 'chat',
        output: '',
        createdAt: now,
        updatedAt: now,
        inputTokens: 0,
        outputTokens: 0,
      };
      f.store.put('tasks', task);
      f.runtime.start(task);
      return task;
    };
    const waiting: Task[] = [];
    const diagnostics = (watchedTasks = waiting) => {
      const tasks = watchedTasks.map(f.task);
      const queue = f.runtime.queueState();
      const holder = f.task(first);
      return {
        expectedMemoryWaiters: waiting.length,
        memory: budget.state,
        holder: { status: holder.status, error: holder.error },
        requestCount: f.requests.length,
        statuses: tasks.reduce<Record<string, number>>((counts, task) => {
          counts[task.status] = (counts[task.status] ?? 0) + 1;
          return counts;
        }, {}),
        queue: {
          active: queue.active,
          waiting: queue.waiting,
          modelWaiting: queue.modelWaiting,
          sessionWaiting: queue.sessionWaiting,
        },
        failures: tasks
          .filter((task) => ['failed', 'interrupted', 'stopped'].includes(task.status))
          .slice(0, 5)
          .map(({ id, status, error }) => ({ id, status, error })),
      };
    };
    const admissionDeadline = Date.now() + 90_000;
    for (let offset = 0; offset < 200; offset += 16) {
      waiting.push(
        ...rooms
          .slice(offset, Math.min(offset + 16, 200))
          .map((candidate) => startPersisted(candidate, 'MEMORY_WAITING')),
      );
      // Keep the real worker/admission path, but avoid a large unrelated
      // scheduling backlog. Poll the in-memory pool instead of preparing 200
      // SQLite queries and a full scheduling snapshot every ten milliseconds.
      await until(
        () => budget.state.resident.waiting === waiting.length,
        `${waiting.length} independent tasks reach memory admission`,
        Math.max(1, admissionDeadline - Date.now()),
        diagnostics,
      );
    }
    assert.equal(budget.state.resident.waiting, 200);
    assert.ok(waiting.every((task) => f.task(task).status === 'running'));
    assert.equal(f.runtime.queueState().waiting, 200);
    const overflow = startPersisted(rooms[200], 'MEMORY_OVERFLOW');
    await until(() => f.task(overflow).status === 'failed', 'memory waiter queue limit');
    assert.match(f.task(overflow).error!, /queue is full \(200 waiting tasks\)/);
    assert.deepEqual(await f.histories(rooms[200]), []);
    assert.equal(f.requests.length, 1);
    await f.controller.stop(waiting[0].id);
    const replacement = startPersisted(rooms[200], 'MEMORY_REPLACEMENT');
    await until(
      () => budget.state.resident.waiting === 200,
      'cancelling a memory waiter frees one queue position',
      30_000,
      () => diagnostics([...waiting, replacement]),
    );
    assert.equal(f.task(replacement).status, 'running');
    assert.equal(f.runtime.queueState().waiting, 200);
    assert.deepEqual(await f.histories(rooms[200]), []);
    assert.equal(f.requests.length, 1);
  },
);

test(
  'a too-small configured memory allowance fails clearly instead of waiting forever',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t, '3');
    const room = await f.room('Too small');
    const task = f.start(room, 'MEMORY_SMALL');
    await until(() => f.task(task).status === 'failed', 'explicit allowance failure');
    assert.match(f.task(task).error!, /above its .* memory allowance/);
    assert.match(f.task(task).error!, /LOOM_SESSION_MEMORY_MB/);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await f.histories(room), []);
    assert.equal(f.controller.runtime!.queueState().waiting, 0);
  },
);

test(
  'history growth fails at the next safe boundary and returns its reservation to another room',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, '60');
    const room = await f.room('Growing history');
    const other = await f.room('After growth failure');
    const task = f.start(room, 'MEMORY_GROWTH');
    (await f.request(task.prompt)).finish(true, 'x'.repeat(2 * 1024 * 1024));
    await until(() => f.task(task).status === 'failed', 'history growth limit');
    assert.match(f.task(task).error!, /memory allowance/);
    assert.equal(f.requests.length, 1, 'an over-budget history is not sent again');
    assert.equal((await f.histories(room)).length, 1, 'the completed response is still persisted');
    const next = f.start(other, 'MEMORY_NEXT');
    (await f.request(next.prompt)).finish();
    await until(() => f.task(next).status === 'completed', 'released memory admits a new room');
    assert.equal(f.controller.runtime!.queueState().waiting, 0);
  },
);

test(
  'shared history pressure preserves a complete tool batch and resumes the same work without another prompt',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, '99', '2');
    let budget: SessionMemoryBudget | undefined;
    const acquire = SessionMemoryBudget.prototype.acquireSession;
    t.mock.method(
      SessionMemoryBudget.prototype,
      'acquireSession',
      function (this: SessionMemoryBudget, ...args: Parameters<typeof acquire>) {
        budget = this;
        return acquire.apply(this, args);
      },
    );
    const room = await f.room('Growing work');
    const other = await f.room('Concurrent holder');
    f.store.patch<Room>('rooms', room.id, {
      autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room' },
    });
    const first = f.start(room, 'MEMORY_RESUMECONTENT');
    const firstRequest = await f.request(first.prompt);
    const holder = f.start(other, 'MEMORY_OTHERHOLDER');
    const held = await f.request(holder.prompt);
    const reserved = f.controller.work.manageWakeup(first.id, {
      operation: 'upsert',
      key: 'review',
      name: 'Review recorded results',
      purpose: 'Preserve one work across a resource wait.',
      reason: 'Review saved results later.',
      prompt: 'Inspect the recorded results.',
      checkpoint: {
        summary: 'Two notices must be saved once.',
        completed: 'Ready to save notices.',
        nextStep: 'Save both notices, then finish.',
        references: [],
        doneWhen: 'Both notices are saved.',
        pendingChecks: [],
        uncertainActions: [],
      },
      schedule: {
        type: 'once',
        dateTime: '2099-06-15T09:00',
        timeZone: 'UTC',
        missedRunPolicy: 'run_once',
      },
    });
    const workRunId = f.task(first).workRunId;
    firstRequest.finishTools(
      [
        { name: 'send_user_message', args: { message: 'Capacity result one.' } },
        { name: 'send_user_message', args: { message: 'Capacity result two.' } },
      ],
      'r'.repeat(256 * 1024),
    );
    await until(() => f.reason(first) === 'memory', 'checkpointed work waits for shared memory');
    assert.ok(budget);
    assert.equal(budget.state.resident.count, 1, 'the waiting task released its retained history');
    assert.equal(
      budget.state.temporary.bytes,
      0,
      'the settled batch returned its spill reservation',
    );
    assert.equal(f.store.get<WorkItem>('workItems', reserved.work.id)!.status, 'active');
    assert.equal(f.task(first).workRunId, workRunId);
    const notices = () =>
      f.store
        .list<{ taskId?: string; targetUser?: boolean; body: string }>('messages')
        .filter((message) => message.taskId === first.id && message.targetUser);
    assert.deepEqual(
      notices().map((message) => message.body),
      ['Capacity result one.', 'Capacity result two.'],
    );
    held.finish();
    await until(() => f.task(holder).status === 'completed', 'other history released');
    const resumed = await f.request(first.prompt, 2);
    assert.equal(
      resumed.messages.filter(
        (message) =>
          message.role === 'user' && JSON.stringify(message.content).includes(first.prompt),
      ).length,
      1,
      'memory recovery does not append another prompt',
    );
    assert.equal(resumed.messages.filter((message) => message.role === 'tool').length, 2);
    assert.ok(JSON.stringify(resumed.messages).includes('r'.repeat(256 * 1024)));
    resumed.finish();
    await until(() => f.task(first).status === 'completed', 'same work completed');
    assert.equal(notices().length, 2, 'neither completed operation is repeated');
    assert.equal(f.store.get<WorkItem>('workItems', reserved.work.id)!.status, 'active');
    assert.equal(f.task(first).workRunId, workRunId);
    assert.equal(f.requests.length, 3);
    assert.deepEqual(budget.state, {
      resident: { bytes: 0, count: 0, waiting: 0 },
      temporary: { bytes: 0, count: 0, waiting: 0 },
    });
  },
);

test(
  'a new history under an aliased data root can unload and resume after memory pressure',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, '99', '2', true);
    assert.notEqual(await realpath(f.dataDir), f.dataDir);
    const room = await f.room('Aliased memory history');
    const other = await f.room('Aliased holder');
    const task = f.start(room, 'MEMORY_ALIASED');
    const first = await f.request(task.prompt);
    const holder = f.start(other, 'MEMORY_ALIASHELD');
    const held = await f.request(holder.prompt);
    first.finish(true, 'a'.repeat(256 * 1024));
    await until(() => f.reason(task) === 'memory', 'aliased history checkpointed');
    held.finish();
    const resumed = await f.request(task.prompt, 2);
    assert.ok(JSON.stringify(resumed.messages).includes('a'.repeat(256 * 1024)));
    assert.equal(resumed.messages.filter((message) => message.role === 'tool').length, 1);
    assert.equal(
      resumed.messages.filter(
        (message) =>
          message.role === 'user' && JSON.stringify(message.content).includes(task.prompt),
      ).length,
      1,
    );
    resumed.finish();
    await until(() => f.task(task).status === 'completed', 'aliased history resumed');
    assert.equal(f.requests.length, 3);
    assert.equal((await f.histories(room)).length, 1);
  },
);

test(
  'a completed final answer can release its bounded growth reservation without failing the task',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t, '60');
    const room = await f.room('Completed answer');
    const task = f.start(room, 'MEMORY_FINALANSWER');
    (await f.request(task.prompt)).finish(false, 'v'.repeat(2 * 1024 * 1024));
    await until(
      () => f.task(task).status === 'completed',
      'final answer completed without restart',
    );
    assert.equal(f.requests.length, 1);
    assert.equal(f.task(task).error, undefined);
    assert.equal((await f.histories(room)).length, 1);
    assert.equal(f.runtime.queueState().waiting, 0);
  },
);

for (const action of ['pause', 'stop'] as const) {
  test(
    `${action} remains effective while an unloaded conversation waits to resume`,
    { timeout: 20_000 },
    async (t) => {
      const f = await fixture(t, '99', '2');
      const room = await f.room(`Memory ${action}`);
      const other = await f.room('Memory holder');
      const task = f.start(room, 'MEMORY_WAITCONTROL');
      const first = await f.request(task.prompt);
      const holder = f.start(other, 'MEMORY_WAITHELD');
      const held = await f.request(holder.prompt);
      first.finish(true, 'q'.repeat(256 * 1024));
      await until(() => f.reason(task) === 'memory', 'unloaded memory continuation');
      if (action === 'pause') {
        f.controller.pauseRoom(room.id);
        await until(() => f.reason(task) === 'paused', 'memory continuation paused');
      } else {
        await f.controller.stop(task.id);
        assert.equal(f.task(task).status, 'stopped');
      }
      held.finish();
      await until(() => f.task(holder).status === 'completed', 'holder completed');
      assert.equal(f.requests.filter((request) => request.marker === task.prompt).length, 1);
      if (action === 'pause') {
        f.controller.resumeRoom(room.id);
        (await f.request(task.prompt, 2)).finish();
        await until(() => f.task(task).status === 'completed', 'paused continuation resumed');
      } else {
        assert.equal(f.task(task).status, 'stopped');
      }
      assert.equal(f.runtime.queueState().waiting, 0);
    },
  );
}

test(
  'a large old record is archived before admission while the exact saved summary and recent context survive',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t, '60');
    const room = await f.room('Old context archive');
    const key = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
    const directory = join(f.dataDir, 'sessions', key('bot_aster'), key(room.id));
    const manager = SessionManager.create(f.store.settings().workspacePath, directory);
    manager.appendMessage({
      role: 'user',
      content: 'Old complete source. '.repeat(110_000),
      timestamp: 1,
    });
    const kept = manager.appendMessage({
      role: 'user',
      content: 'Exact retained reference: A17 = 4321.',
      timestamp: 2,
    });
    manager.appendCompaction(
      'Verified historical summary with unchanged factual detail.',
      kept,
      1_000_000,
    );
    const path = manager.getSessionFile()!;
    const original = await readFile(path);
    assert.ok(original.byteLength > 2 * 1024 * 1024);
    const task = f.start(room, 'MEMORY_ARCHIVEDSTART');
    const request = await f.request(task.prompt);
    const sent = JSON.stringify(request.messages);
    assert.ok(sent.includes('Verified historical summary with unchanged factual detail.'));
    assert.ok(sent.includes('Exact retained reference: A17 = 4321.'));
    assert.equal(sent.includes('Old complete source. '), false);
    const archives = (await readdir(directory)).filter((name) => name.includes('.history-v1-'));
    assert.equal(archives.length, 1);
    assert.deepEqual(await readFile(join(directory, archives[0])), original);
    request.finish();
    await until(() => f.task(task).status === 'completed', 'archived history completed');
    assert.equal(f.requests.length, 1);
  },
);

test(
  'update preparation preserves an unloaded memory checkpoint and its completed tool receipt',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, '99', '2');
    let budget: SessionMemoryBudget | undefined;
    const acquire = SessionMemoryBudget.prototype.acquireSession;
    t.mock.method(
      SessionMemoryBudget.prototype,
      'acquireSession',
      function (this: SessionMemoryBudget, ...args: Parameters<typeof acquire>) {
        budget = this;
        return acquire.apply(this, args);
      },
    );
    const room = await f.room('Memory update checkpoint');
    const other = await f.room('Memory update holder');
    const task = f.start(room, 'MEMORY_UPDATEUNLOADED');
    const first = await f.request(task.prompt);
    const holder = f.start(other, 'MEMORY_UPDATEHOLDER');
    const held = await f.request(holder.prompt);
    first.finishTools(
      [{ name: 'send_user_message', args: { message: 'Saved before the application update.' } }],
      'p'.repeat(256 * 1024),
    );
    await until(() => f.reason(task) === 'memory', 'conversation unloaded before update');
    const histories = await f.histories(room);
    assert.equal(histories.length, 1);
    f.controller.pauseRoom(room.id);
    f.controller.pauseRoom(other.id);
    held.finish(true);
    await until(
      () => f.reason(task) === 'paused' && f.reason(holder) === 'paused',
      'both conversations paused for update',
    );
    f.controller.maintenance = true;
    await f.runtime.prepareForUpdate!();
    assert.equal(f.task(task).status, 'queued');
    assert.equal(f.task(holder).status, 'queued');
    assert.deepEqual(await f.histories(room), histories);
    assert.ok(budget);
    assert.deepEqual(budget.state, {
      resident: { bytes: 0, count: 0, waiting: 0 },
      temporary: { bytes: 0, count: 0, waiting: 0 },
    });
    f.controller.maintenance = false;
    f.controller.resumeRoom(room.id);
    const resumed = await f.request(task.prompt, 2);
    assert.ok(JSON.stringify(resumed.messages).includes('p'.repeat(256 * 1024)));
    assert.equal(resumed.messages.filter((message) => message.role === 'tool').length, 1);
    resumed.finish();
    await until(() => f.task(task).status === 'completed', 'unloaded update checkpoint resumed');
    assert.equal(
      f.store
        .list<{ taskId?: string; targetUser?: boolean }>('messages')
        .filter((message) => message.taskId === task.id && message.targetUser).length,
      1,
      'the saved operation is not repeated after the update checkpoint',
    );
    f.controller.resumeRoom(other.id);
    (await f.request(holder.prompt, 2)).finish();
    await until(() => f.task(holder).status === 'completed', 'update holder resumed');
    assert.equal(f.runtime.queueState().waiting, 0);
  },
);

test(
  'owner instructions arriving during memory wait are injected before the next model request',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, '99', '2');
    const room = await f.room('Memory owner steering');
    const other = await f.room('Memory owner holder');
    const task = f.start(room, 'MEMORY_STEERINGWAIT');
    const first = await f.request(task.prompt);
    const holder = f.start(other, 'MEMORY_STEERINGHELD');
    const held = await f.request(holder.prompt);
    first.finish(true, 'w'.repeat(256 * 1024));
    await until(() => f.reason(task) === 'memory', 'conversation unloaded before owner input');
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/inputs`,
      payload: {
        requestId: randomUUID(),
        body: 'Keep reference A17. Use the corrected value 9988 in the final answer.',
        mode: 'immediate',
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const added = response.json<TaskInputResult>();
    assert.equal(f.store.get<TaskInput>('taskInputs', added.input.id)!.status, 'pending');
    held.finish();
    const resumed = await f.request(task.prompt, 2);
    assert.ok(JSON.stringify(resumed.messages).includes('Use the corrected value 9988'));
    assert.equal(
      resumed.messages.filter((message) => message.role === 'tool').length,
      1,
      'the preceding tool result remains in context',
    );
    resumed.finish();
    await until(
      () => f.task(task).status === 'completed',
      'same task finishes with owner correction',
    );
    assert.equal(f.store.get<TaskInput>('taskInputs', added.input.id)!.status, 'delivered');
    assert.equal(f.requests.length, 3, 'no stale model request is sent after the owner correction');
  },
);
