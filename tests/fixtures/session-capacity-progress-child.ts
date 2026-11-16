import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../src/server/app.js';
import {
  SessionMemoryBudget,
  type SessionMemoryLease,
} from '../../src/server/runtime/session-memory.js';
import type { Room, Task } from '../../src/shared/types.js';

const scenario = process.argv[2];
assert.ok(['resident', 'temporary', 'interrupted'].includes(scenario));
const directory = process.argv[3];
assert.ok(directory);

const progress = (stage: string) => {
  process.send?.({ type: 'progress', stage });
};
const failures: unknown[] = [];
const sockets = new Set<Socket>();
const requests: Array<{ marker: string; response: ServerResponse; finish: () => void }> = [];
let instance: Awaited<ReturnType<typeof createApp>> | undefined;
let budget: SessionMemoryBudget | undefined;
let temporaryBlocker: SessionMemoryLease | undefined;
let closing = false;

// Observe the real runtime's budget without replacing admission behavior.
const originalAcquire = SessionMemoryBudget.prototype.acquireSession;
SessionMemoryBudget.prototype.acquireSession = function (...args) {
  budget = this;
  return originalAcquire.apply(this, args);
};

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.deepEqual(failures, []);
    if (Date.now() > deadline)
      throw new Error(
        `${label}: ${JSON.stringify({ memory: budget?.state, requests: requests.map((r) => r.marker) })}`,
      );
    await delay(5);
  }
}

const model = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    const marker = JSON.stringify(payload.messages)
      .match(/CAPACITY_[A-Z]+_\d+/g)
      ?.at(-1);
    assert.ok(marker);
    const index = requests.length;
    const send = (delta: unknown, finish_reason: string | null = null) => {
      response.write(
        `data: ${JSON.stringify({ id: `capacity-${index}`, object: 'chat.completion.chunk', created: 1, model: 'capacity-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    send({ role: 'assistant', content: '' });
    let finished = false;
    const entry = {
      marker,
      response,
      finish() {
        if (finished) return;
        finished = true;
        send({ content: `Finished ${marker}.` });
        send({}, 'stop');
        response.end('data: [DONE]\n\n');
      },
    };
    requests.push(entry);
    // Hold only the initial four conversations. Each admitted waiter finishes
    // through real HTTP/Pi processing and returns its reservation to the next.
    if (!marker.startsWith('CAPACITY_HOLDER_')) {
      await nextTurn();
      entry.finish();
    }
  })().catch((error) => {
    if (!closing) failures.push(error);
    response.destroy(error as Error);
  });
});
model.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});

async function room(index: number): Promise<Room> {
  const response = await instance!.app.inject({
    method: 'POST',
    url: '/api/rooms',
    payload: { name: `Capacity ${index}`, botIds: ['bot_aster'] },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Room>();
}

function start(target: Room, marker: string): Task {
  return instance!.controller.enqueueTask({
    roomId: target.id,
    botId: 'bot_aster',
    prompt: marker,
  });
}

function status(task: Task) {
  return instance!.store.get<Task>('tasks', task.id)!.status;
}

async function run() {
  await new Promise<void>((resolve, reject) => {
    model.once('error', reject);
    model.listen(0, '127.0.0.1', resolve);
  });
  const modelAddress = model.address();
  assert.ok(modelAddress && typeof modelAddress !== 'string');
  instance = await createApp({ dataDir: join(directory, 'data'), scheduler: false });
  const settings = await instance.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      model: {
        baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
        modelId: 'capacity-fixture',
      },
      inference: { maxConcurrentRequests: 4 },
      autoLearn: false,
    },
  });
  assert.equal(settings.statusCode, 200, settings.body);
  const address = await instance.app.listen({ port: 0, host: '127.0.0.1' });
  const rooms = await Promise.all(Array.from({ length: 12 }, (_, i) => room(i)));
  const holders: Task[] = [];
  if (scenario === 'temporary') {
    const warmup = start(rooms[0], 'CAPACITY_WARMUP_0');
    await until(() => status(warmup) === 'completed', 'warmup completes');
    assert.ok(budget);
    temporaryBlocker = await budget.acquireTemporary(budget.temporaryLimitBytes);
  } else {
    for (let i = 0; i < 4; i++) {
      const task = start(rooms[i], `CAPACITY_HOLDER_${i}`);
      holders.push(task);
      await until(() => requests.some((item) => item.marker === task.prompt), 'holder starts');
    }
    assert.equal(budget!.state.resident.count, 4);
  }
  const pool = scenario === 'temporary' ? 'temporary' : 'resident';
  const waiters: Task[] = [];
  const total = scenario === 'interrupted' ? 8 : 6;
  for (let i = 0; i < total; i++) {
    waiters.push(start(rooms[4 + i], `CAPACITY_WAITER_${i}`));
    await until(() => budget!.state[pool].waiting === i + 1, 'waiter enters real admission queue');
  }
  let cancelled: Task | undefined;
  let paused: Task | undefined;
  if (scenario === 'interrupted') {
    cancelled = waiters.shift()!;
    paused = waiters.pop()!;
    await instance.controller.stop(cancelled.id);
    instance.controller.pauseRoom(paused.roomId);
    await until(() => budget!.state[pool].waiting === 6, 'pause and cancel withdraw waiters');
    assert.equal(status(cancelled), 'stopped');
  }
  const waitingAtRelease = budget!.state[pool].waiting;
  assert.equal(waitingAtRelease, 6);
  assert.ok(waiters.every((task) => !requests.some((item) => item.marker === task.prompt)));
  progress(`${pool}: six waiters queued; releasing exactly one allowance`);
  if (temporaryBlocker) {
    // Empty histories request the real four-MiB minimum preparation allowance.
    // Keep the remainder reserved so only one preparation can progress at once.
    temporaryBlocker.resize(budget!.temporaryLimitBytes - 4 * 1024 * 1024);
  } else {
    requests.find((item) => item.marker === holders[0].prompt)!.finish();
  }
  let eventLoopResponded = false;
  const responsive = nextTurn().then(() => {
    eventLoopResponded = true;
  });
  const health = fetch(`${address}/api/health`, { signal: AbortSignal.timeout(10_000) }).then(
    async (response) => {
      await response.arrayBuffer();
      return response.status;
    },
  );
  await until(
    () => waiters.every((task) => status(task) === 'completed'),
    'all six waiters complete',
  );
  await responsive;
  const healthStatus = await health;
  const requestedWaiters = requests
    .filter((item) => waiters.some((task) => task.prompt === item.marker))
    .map((item) => item.marker);
  const cancellationPreserved =
    !cancelled ||
    (status(cancelled) === 'stopped' && !requests.some((item) => item.marker === cancelled.prompt));
  const pausePreserved = !paused || !requests.some((item) => item.marker === paused.prompt);
  assert.equal(cancellationPreserved, true);
  assert.equal(pausePreserved, true);
  if (paused) {
    instance.controller.resumeRoom(paused.roomId);
    await until(() => status(paused!) === 'completed', 'paused task resumes after peers finish');
  }
  for (const holder of holders) requests.find((item) => item.marker === holder.prompt)!.finish();
  temporaryBlocker?.release();
  await until(
    () =>
      holders.every((task) => status(task) === 'completed') &&
      budget!.state.resident.count === 0 &&
      budget!.state.temporary.count === 0 &&
      instance!.runtime.queueState().active === 0 &&
      instance!.runtime.queueState().waiting === 0,
    'all reservations and queues drain',
  );
  return {
    type: 'result',
    scenario,
    waitingAtRelease,
    completedWaiters: waiters.filter((task) => status(task) === 'completed').length,
    requestedWaiters,
    expectedWaiters: waiters.map((task) => task.prompt),
    healthStatus,
    eventLoopResponded,
    cancellationPreserved,
    pausePreserved,
    queue: instance.runtime.queueState(),
    memory: budget!.state,
  };
}

let result: Awaited<ReturnType<typeof run>> | undefined;
try {
  result = await run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  closing = true;
  temporaryBlocker?.release();
  const closed = new Promise<void>((resolve, reject) => {
    if (!model.listening) resolve();
    else model.close((error) => (error ? reject(error) : resolve()));
  });
  for (const request of requests) request.response.destroy();
  model.closeAllConnections();
  for (const socket of sockets) socket.destroy();
  const cleanup = await Promise.allSettled([
    closed,
    instance?.controller.shutdown(),
    instance?.app.close(),
  ]);
  for (const entry of cleanup) {
    if (entry.status === 'rejected') {
      console.error(entry.reason);
      process.exitCode = 1;
    }
  }
  instance?.store.close();
  SessionMemoryBudget.prototype.acquireSession = originalAcquire;
}
if (result && !process.exitCode) process.send?.(result);
process.disconnect?.();
