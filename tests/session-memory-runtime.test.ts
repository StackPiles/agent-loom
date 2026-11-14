import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import { RoomTaskScheduler } from '../src/server/runtime/pause.js';
import { SessionMemoryBudget } from '../src/server/runtime/session-memory.js';
import type { Room, Task } from '../src/shared/types.js';

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
  finish(tool?: boolean, content?: string): void;
}

async function fixture(t: TestContext, totalMiB?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-session-memory-'));
  const oldLoaded = process.env.LOOM_SESSION_MAX_LOADED;
  const oldTotal = process.env.LOOM_SESSION_MEMORY_MB;
  process.env.LOOM_SESSION_MAX_LOADED = '1';
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
  instance = await createApp({ dataDir, scheduler: false });
  const settings = await instance.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      model: { baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'memory-fixture' },
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
      await until(() => {
        assert.deepEqual(failures, []);
        return requests.filter((item) => item.marker === marker).length >= number;
      }, marker);
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
      () => f.reason(second) === 'worker' && f.reason(cancelled) === 'worker',
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
    await until(() => f.reason(second) === 'worker', 'second waits without a session');
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

test('a preparing conversation returns granted memory before reacquiring its lent worker', async (t) => {
  const f = await fixture(t, '96');
  const acquire = SessionMemoryBudget.prototype.acquireTemporary;
  const checkpoint = RoomTaskScheduler.prototype.checkpoint;
  let held = 0;
  let contended = false;
  let checked = false;
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
      if (this.isSuspended(args[0])) {
        checked = true;
        assert.equal(held, 0, 'worker admission must not hold the temporary request allowance');
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
