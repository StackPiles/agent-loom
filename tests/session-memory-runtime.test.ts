import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
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
    if (Date.now() > deadline)
      throw new Error(
        `Timed out after ${Date.now() - started}ms: ${label}` +
          (diagnostics ? `\n${JSON.stringify(diagnostics(), null, 2)}` : ''),
      );
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
  const server = createServer(async (request, response) => {
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
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const dataDir = join(directory, 'data');
  const instance = await createApp({ dataDir, scheduler: false });
  t.after(async () => {
    await instance.app.close();
    for (const request of requests) request.response.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { force: true, recursive: true });
    if (oldLoaded === undefined) delete process.env.LOOM_SESSION_MAX_LOADED;
    else process.env.LOOM_SESSION_MAX_LOADED = oldLoaded;
    if (oldTotal === undefined) delete process.env.LOOM_SESSION_MEMORY_MB;
    else process.env.LOOM_SESSION_MEMORY_MB = oldTotal;
  });
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
    async room(name: string) {
      const result = await instance.app.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: { name, botIds: ['bot_aster'] },
      });
      assert.equal(result.statusCode, 200, result.body);
      return result.json<Room>();
    },
    start(room: Room, marker: string) {
      return instance.controller.enqueueTask({
        roomId: room.id,
        botId: 'bot_aster',
        prompt: marker,
      });
    },
    task(task: Task) {
      return instance.store.get<Task>('tasks', task.id)!;
    },
    reason(task: Task) {
      return instance.controller
        .runtime!.queueState()
        .waitingTasks?.find((item) => item.taskId === task.id)?.reason;
    },
    async request(marker: string, number = 1) {
      await until(() => requests.filter((item) => item.marker === marker).length >= number, marker);
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

test(
  'runtime admission counts independent memory waiters toward its own queue bound',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    const room = await f.room('Queue holder');
    const first = f.start(room, 'MEMORY_QUEUEHOLDER');
    await f.request(first.prompt);
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
    const waiting = rooms
      .slice(0, 200)
      .map((candidate) => startPersisted(candidate, 'MEMORY_WAITING'));
    const diagnostics = () => {
      const tasks = waiting.map(f.task);
      const queue = f.runtime.queueState();
      return {
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
    await until(
      () =>
        waiting.every((task) => f.task(task).status === 'running') &&
        f.runtime.queueState().waiting === 200,
      'two hundred independent tasks wait after lending their workers',
      // This is a real 200-task initialization stress fixture. Windows runners
      // need headroom while other test files share their CPU and filesystem.
      90_000,
      diagnostics,
    );
    const overflow = startPersisted(rooms[200], 'MEMORY_OVERFLOW');
    await until(() => f.task(overflow).status === 'failed', 'memory waiter queue limit');
    assert.match(f.task(overflow).error!, /queue is full \(200 waiting tasks\)/);
    assert.deepEqual(await f.histories(rooms[200]), []);
    assert.equal(f.requests.length, 1);
    await f.controller.stop(waiting[0].id);
    const replacement = startPersisted(rooms[200], 'MEMORY_REPLACEMENT');
    await until(
      () => f.task(replacement).status === 'running' && f.runtime.queueState().waiting === 200,
      'cancelling a memory waiter frees one queue position',
      30_000,
      diagnostics,
    );
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
