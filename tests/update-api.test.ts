import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, type AppOptions } from '../src/server/app.js';
import { createManagedApp } from '../src/server/managed-app.js';
import { ApplicationUpdates } from '../src/server/updates.js';
import type { UpdateJob } from '../src/shared/updates.js';
import type { Task } from '../src/shared/types.js';

const CURRENT = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const TOKEN = 'test-only-update-api-token-long-enough';
const fakeRuntime = () => ({
  start() {},
  async stop() {},
  async shutdown() {},
  queueState: () => ({ active: 0, waiting: 0 }),
});

async function fixture(
  t: TestContext,
  options: {
    verification?: boolean;
    reject?: boolean;
    uncertain?: boolean;
    receipt?: Promise<void>;
    runtimeFactory?: AppOptions['runtimeFactory'];
    beforeVerification?: () => Promise<void>;
    checks?: 'passed' | 'pending' | 'failed';
  } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-update-api-'));
  let persisted: UpdateJob | undefined;
  const requests: UpdateJob[] = [];
  const proceeds: string[] = [];
  const updates = new ApplicationUpdates({
    version: '0.6.0',
    commit: CURRENT,
    supervised: true,
    inspect: async () => ({
      installation: { kind: 'managed-git', canUpdate: true },
      commit: CURRENT,
    }),
    readJob: async () => persisted,
    fetcher: (async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/commits/main')) {
        await options.beforeVerification?.();
        return Response.json({ sha: NEXT, commit: { committer: null } });
      }
      if (path.includes('/contents/'))
        return Response.json({
          encoding: 'base64',
          content: Buffer.from(
            JSON.stringify({ version: '0.6.1', loomUpdateProtocol: 1 }),
          ).toString('base64'),
        });
      return Response.json({
        workflow_runs: [
          {
            head_sha: NEXT,
            head_branch: 'main',
            event: 'push',
            status: options.checks === 'pending' ? 'in_progress' : 'completed',
            conclusion:
              options.checks === 'pending'
                ? null
                : options.checks === 'failed'
                  ? 'failure'
                  : 'success',
          },
        ],
      });
    }) as typeof fetch,
    requestInstall: async (job) => {
      requests.push(job);
      await options.receipt;
      if (options.reject || options.uncertain)
        throw Object.assign(new Error('Synthetic launcher failure.'), {
          statusCode: 409,
          uncertain: options.uncertain,
        });
      persisted = job;
    },
    proceed: (id) => {
      proceeds.push(id);
    },
  });
  const context = await createApp({
    dataDir,
    apiToken: TOKEN,
    scheduler: false,
    runtimeFactory: options.runtimeFactory ?? fakeRuntime,
    updates,
    updateVerification: options.verification,
  });
  t.after(async () => {
    await context.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const headers = { authorization: `Bearer ${TOKEN}` };
  const install = (requestId = randomUUID(), commit = NEXT) =>
    context.app.inject({
      method: 'POST',
      url: '/api/updates/install',
      headers,
      payload: { commit, requestId },
    });
  return { ...context, requests, proceeds, headers, install };
}

function startedTask(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  status: Task['status'],
): Task {
  const stamp = new Date().toISOString();
  return f.store.put('tasks', {
    id,
    roomId: 'room_lounge',
    botId: 'bot_aster',
    workspacePath: f.store.settings().workspacePath,
    prompt: 'Continue the saved task after the update.',
    output: 'Already completed work must survive.',
    rootTaskId: id,
    depth: 0,
    kind: 'chat' as const,
    status,
    inputTokens: 100,
    outputTokens: 20,
    createdAt: stamp,
    startedAt: stamp,
    updatedAt: stamp,
  });
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('update APIs retain authentication, same-origin, and strict input validation', async (t) => {
  const f = await fixture(t);
  for (const url of ['/api/updates', '/%61pi/updates'])
    assert.equal((await f.app.inject({ url })).statusCode, 401);
  const crossOrigin = await f.app.inject({
    method: 'POST',
    url: '/api/updates/install',
    headers: { ...f.headers, origin: 'https://untrusted.example' },
    payload: { commit: NEXT, requestId: randomUUID() },
  });
  assert.equal(crossOrigin.statusCode, 403);
  const arbitrary = await f.app.inject({
    method: 'POST',
    url: '/api/updates/install',
    headers: f.headers,
    payload: {
      commit: NEXT,
      requestId: randomUUID(),
      repository: 'https://untrusted.example',
      command: 'anything',
    },
  });
  assert.equal(arbitrary.statusCode, 400);
  assert.equal(f.requests.length, 0);
});

test('active tasks, all generation types, and in-flight mail block updates without stopping work', async (t) => {
  const f = await fixture(t);
  for (const [kind, status] of [
    ['tasks', 'queued'],
    ['tasks', 'awaiting_approval'],
    ['avatarGenerations', 'generating'],
    ['promptGenerations', 'queued'],
    ['imageTests', 'generating'],
    ['mailSends', 'sending'],
    ['mailDrafts', 'sending'],
  ]) {
    f.store.put(kind, { id: 'active', status });
    const response = await f.install();
    assert.equal(response.statusCode, 409, kind);
    assert.match(response.json().error, /Wait for running/);
    assert.equal(response.json().code, 'update_busy');
    assert.equal(f.controller.maintenance, false);
    assert.equal(f.store.get<{ status: string }>(kind, 'active')?.status, status);
    f.store.remove(kind, 'active');
  }
  assert.equal(f.requests.length, 0);
});

test('accepted updates pause API and direct task admission; retries return the same job', async (t) => {
  const f = await fixture(t);
  const stopped = startedTask(f, 'stopped-before-update', 'stopped');
  const requestId = randomUUID();
  const response = await f.install(requestId);
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().id, requestId);
  await delay(0);
  assert.deepEqual(f.proceeds, [requestId], 'proceed happens after the response is delivered');
  assert.equal(f.controller.maintenance, true);
  assert.equal((await f.app.inject({ url: '/api/state', headers: f.headers })).statusCode, 503);
  assert.equal((await f.app.inject({ url: '/api/updates', headers: f.headers })).statusCode, 200);
  assert.throws(
    () =>
      f.controller.enqueueTask({
        botId: 'bot_aster',
        roomId: 'room_lounge',
        prompt: 'must not run',
      }),
    /updating/,
  );
  assert.throws(
    () => f.avatarGenerations.start({ requestId: randomUUID(), prompt: 'must not run' }),
    /updating/,
  );
  assert.throws(() => f.controller.resume(stopped.id), /updating/);
  assert.equal(f.store.get<Task>('tasks', stopped.id)?.status, 'stopped');
  assert.equal((await f.install(requestId)).statusCode, 202);
  assert.equal(f.requests.length, 1);
  f.resumeAfterUpdate('wrong-job');
  assert.equal(f.controller.maintenance, true);
  f.resumeAfterUpdate(requestId);
  assert.equal(f.controller.maintenance, false);
  assert.equal((await f.app.inject({ url: '/api/state', headers: f.headers })).statusCode, 200);
  f.controller.closing = true;
  try {
    assert.throws(() => f.controller.resume(stopped.id), /shutting down/);
    assert.equal(f.store.get<Task>('tasks', stopped.id)?.status, 'stopped');
  } finally {
    f.controller.closing = false;
  }
});

test('an update accepts the persisted queue of a paused room without cancelling it', async (t) => {
  const f = await fixture(t);
  f.store.put('tasks', { id: 'held', roomId: 'room_lounge', status: 'queued' });
  assert.equal((await f.install()).statusCode, 409, 'a runnable queue still blocks updates');
  const paused = await f.app.inject({
    method: 'POST',
    url: '/api/rooms/room_lounge/pause',
    headers: f.headers,
  });
  assert.equal(paused.statusCode, 200);
  const response = await f.install();
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(f.store.get<{ status: string }>('tasks', 'held')?.status, 'queued');
  assert.equal(f.store.get<{ paused?: boolean }>('rooms', 'room_lounge')?.paused, true);
});

test('an update settles runtime-confirmed paused tasks under maintenance before contacting the launcher', async (t) => {
  const entered = latch();
  const finish = latch();
  const parked = new Set<string>();
  let preparations = 0;
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, {
    runtimeFactory: () => ({
      ...fakeRuntime(),
      isTaskSuspended: (id) => parked.has(id),
      async prepareForUpdate() {
        preparations++;
        assert.equal(f.controller.maintenance, true);
        entered.release();
        await finish.promise;
        for (const id of parked) f.store.patch<Task>('tasks', id, { status: 'queued' });
        parked.clear();
      },
    }),
  });
  const tasks = (['running', 'waiting_model', 'waiting_tool', 'awaiting_approval'] as const).map(
    (status) => startedTask(f, `parked-${status}`, status),
  );
  for (const task of tasks) parked.add(task.id);
  assert.equal(
    (await f.install()).statusCode,
    409,
    'runtime suspension alone cannot authorize updating a room that is not paused',
  );
  assert.equal(preparations, 0);
  f.controller.pauseRoom('room_lounge');
  const installing = f.install().then((response) => response);
  try {
    await Promise.race([
      entered.promise,
      installing.then(() => assert.fail('Update ended before asking the runtime to settle.')),
    ]);
    await delay(0);
    assert.equal(f.requests.length, 0, 'the launcher must wait for runtime settlement');
    assert.equal(f.controller.maintenance, true);
    assert.throws(() => f.controller.resumeRoom('room_lounge'), /updating/);
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/rooms/room_lounge/resume',
          headers: f.headers,
        })
      ).statusCode,
      503,
    );
  } finally {
    finish.release();
  }
  const response = await installing;
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(preparations, 1);
  assert.equal(f.requests.length, 1);
  for (const task of tasks)
    assert.deepEqual(f.store.get<Task>('tasks', task.id), { ...task, status: 'queued' });
  assert.equal(f.store.get<{ paused?: boolean }>('rooms', 'room_lounge')?.paused, true);
});

test('paused room labels and displayed wait states cannot authorize updates while work is draining', async (t) => {
  for (const runtimeState of ['unknown', 'draining', 'incomplete'] as const) {
    let preparations = 0;
    let stops = 0;
    const f = await fixture(t, {
      runtimeFactory: () => ({
        ...fakeRuntime(),
        ...(runtimeState === 'unknown'
          ? {}
          : { isTaskSuspended: () => runtimeState === 'incomplete' }),
        queueState: () => ({
          active: 0,
          waiting: 1,
          waitingTasks: [{ taskId: 'still-running', reason: 'paused' as const }],
        }),
        async stop() {
          stops++;
        },
        ...(runtimeState === 'incomplete'
          ? {}
          : {
              async prepareForUpdate() {
                preparations++;
              },
            }),
      }),
    });
    f.controller.pauseRoom('room_lounge');
    for (const status of [
      'running',
      'waiting_model',
      'waiting_tool',
      'awaiting_approval',
    ] as const) {
      const task = startedTask(f, 'still-running', status);
      const response = await f.install();
      assert.equal(response.statusCode, 409, `${runtimeState}: ${status}`);
      assert.equal(response.json().code, 'update_busy');
      assert.deepEqual(f.store.get<Task>('tasks', task.id), task);
      assert.equal(f.controller.maintenance, false);
    }
    assert.equal(preparations, 0);
    assert.equal(stops, 0, 'requesting an update must not interrupt draining work');
    assert.equal(f.requests.length, 0);
  }
});

test('resuming a paused room during update verification is rechecked before any task is settled', async (t) => {
  const entered = latch();
  const finish = latch();
  let suspended = false;
  let preparations = 0;
  const f = await fixture(t, {
    beforeVerification: async () => {
      entered.release();
      await finish.promise;
    },
    runtimeFactory: () => ({
      ...fakeRuntime(),
      setRoomPaused(_id, paused) {
        suspended = paused;
      },
      isTaskSuspended: () => suspended,
      async prepareForUpdate() {
        preparations++;
      },
    }),
  });
  const task = startedTask(f, 'resume-during-verification', 'waiting_model');
  f.controller.pauseRoom('room_lounge');
  const installing = f.install().then((response) => response);
  try {
    await Promise.race([
      entered.promise,
      installing.then(() => assert.fail('Update did not enter verification.')),
    ]);
    assert.equal(f.controller.maintenance, false);
    f.controller.resumeRoom('room_lounge');
  } finally {
    finish.release();
  }
  const response = await installing;
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'update_busy');
  assert.equal(preparations, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.controller.maintenance, false);
  assert.deepEqual(f.store.get<Task>('tasks', task.id), task);
});

test('invalid update targets and unfinished or failed CI leave paused tasks and approvals untouched', async (t) => {
  for (const scenario of ['target', 'pending', 'failed'] as const) {
    let preparations = 0;
    let stops = 0;
    const f = await fixture(t, {
      checks: scenario === 'target' ? 'passed' : scenario,
      runtimeFactory: () => ({
        ...fakeRuntime(),
        isTaskSuspended: () => true,
        async prepareForUpdate() {
          preparations++;
        },
        async stop() {
          stops++;
        },
      }),
    });
    const task = startedTask(f, 'waiting-for-approval', 'awaiting_approval');
    const approval = { id: 'pending-approval', taskId: task.id, status: 'pending' };
    f.store.put('approvals', approval);
    f.controller.pauseRoom('room_lounge');
    const response = await f.install(randomUUID(), scenario === 'target' ? 'c'.repeat(40) : NEXT);
    assert.equal(response.statusCode, 409, scenario);
    assert.match(response.json().error, scenario === 'target' ? /target changed/ : /CI checks/);
    assert.equal(f.controller.maintenance, false);
    assert.equal(preparations, 0);
    assert.equal(stops, 0);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.store.get<Task>('tasks', task.id), task);
    assert.deepEqual(f.store.get('approvals', approval.id), approval);
  }
});

test('runtime settlement failure releases update admission while retaining the durable paused queue', async (t) => {
  let suspended = true;
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, {
    runtimeFactory: () => ({
      ...fakeRuntime(),
      isTaskSuspended: () => suspended,
      async prepareForUpdate() {
        assert.equal(f.controller.maintenance, true);
        f.store.patch<Task>('tasks', 'settlement-fails', { status: 'queued' });
        suspended = false;
        throw Object.assign(new Error('Synthetic paused-session settlement failure.'), {
          statusCode: 409,
        });
      },
    }),
  });
  const task = startedTask(f, 'settlement-fails', 'waiting_tool');
  f.controller.pauseRoom('room_lounge');
  const response = await f.install();
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(f.controller.maintenance, false);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.store.get<Task>('tasks', task.id), { ...task, status: 'queued' });
  assert.equal(f.store.get<{ paused?: boolean }>('rooms', 'room_lounge')?.paused, true);
  assert.equal((await f.app.inject({ url: '/api/state', headers: f.headers })).statusCode, 200);
});

test('work that is no longer suspended after runtime preparation cannot reach the launcher', async (t) => {
  let suspended = true;
  let preparations = 0;
  const f = await fixture(t, {
    runtimeFactory: () => ({
      ...fakeRuntime(),
      isTaskSuspended: () => suspended,
      async prepareForUpdate() {
        preparations++;
        suspended = false;
      },
    }),
  });
  const task = startedTask(f, 'changed-during-preparation', 'waiting_tool');
  f.controller.pauseRoom('room_lounge');
  const response = await f.install();
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'update_busy');
  assert.equal(preparations, 1);
  assert.equal(f.requests.length, 0);
  assert.equal(f.controller.maintenance, false);
  assert.deepEqual(f.store.get<Task>('tasks', task.id), task);
});

test('a definitive launcher rejection releases admission; an uncertain receipt does not', async (t) => {
  for (const uncertain of [false, true]) {
    let suspended = true;
    let f!: Awaited<ReturnType<typeof fixture>>;
    f = await fixture(t, {
      reject: true,
      uncertain,
      runtimeFactory: () => ({
        ...fakeRuntime(),
        isTaskSuspended: () => suspended,
        async prepareForUpdate() {
          f.store.patch<Task>('tasks', 'prepared-before-rejection', { status: 'queued' });
          suspended = false;
        },
      }),
    });
    const task = startedTask(f, 'prepared-before-rejection', 'waiting_model');
    f.controller.pauseRoom('room_lounge');
    assert.equal((await f.install()).statusCode, 409);
    assert.equal(f.controller.maintenance, uncertain);
    assert.deepEqual(f.store.get<Task>('tasks', task.id), { ...task, status: 'queued' });
    assert.equal(f.store.get<{ paused?: boolean }>('rooms', 'room_lounge')?.paused, true);
    assert.equal(f.requests.length, 1);
    assert.equal(f.proceeds.length, 0);
  }
});

test('concurrent update requests cannot release or duplicate another request’s reservation', async (t) => {
  let acknowledge!: () => void;
  const receipt = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const f = await fixture(t, { receipt });
  const requestId = randomUUID();
  const first = f.install(requestId).then((response) => response);
  const deadline = Date.now() + 5_000;
  while (!f.requests.length) {
    if (Date.now() > deadline) throw new Error('The first request did not reach its receipt.');
    await delay(5);
  }
  try {
    assert.equal(f.controller.maintenance, true);
    assert.equal((await f.install()).statusCode, 409);
    assert.equal((await f.install(requestId)).statusCode, 409);
    assert.equal(
      f.controller.maintenance,
      true,
      'a losing request cannot resume the owner’s scheduler',
    );
    assert.equal(f.requests.length, 1);
  } finally {
    acknowledge();
  }
  assert.equal((await first).statusCode, 202);
  assert.equal((await f.install(requestId)).statusCode, 202);
  assert.equal(f.requests.length, 1);
});

test('verification startup serves health and update status but cannot run work before activation', async (t) => {
  const f = await fixture(t, { verification: true });
  assert.equal((await f.app.inject({ url: '/api/health' })).json().updating, true);
  assert.equal((await f.app.inject({ url: '/api/updates', headers: f.headers })).statusCode, 200);
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/hooks/anything', payload: {} })).statusCode,
    503,
  );
  assert.equal((await f.app.inject({ url: '/api/state', headers: f.headers })).statusCode, 503);
  f.resumeAfterUpdate();
  assert.equal(
    f.controller.maintenance,
    true,
    'failed-update recovery cannot activate an unverified generation',
  );
  f.activateUpdate();
  assert.equal(f.controller.maintenance, false);
  assert.equal((await f.app.inject({ url: '/api/state', headers: f.headers })).statusCode, 200);
});

test('a request that entered before the update gate blocks shutdown until its handler finishes', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.app.post('/api/test-delayed-operation', async () => {
    await waiting;
    return { ok: true };
  });
  const response = f.app
    .inject({ method: 'POST', url: '/api/test-delayed-operation', headers: f.headers })
    .then((value) => value);
  await delay(10);
  try {
    assert.equal((await f.install()).statusCode, 409);
    assert.equal(f.requests.length, 0);
  } finally {
    release();
    await response;
  }
  assert.equal((await f.install()).statusCode, 202);
});

test('disconnecting an HTTP caller cannot hide its still-running handler from the update gate', async (t) => {
  const f = await fixture(t);
  let release!: () => void, enter!: () => void, aborted!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const disconnected = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  f.app.addHook('onRequestAbort', async (request) => {
    if (request.url === '/api/test-held') aborted();
  });
  f.app.get('/api/test-held', async () => {
    enter();
    await held;
    return { ok: true };
  });
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const request = httpRequest(`${address}/api/test-held`, { headers: f.headers });
  request.on('error', () => {});
  request.end();
  await entered;
  request.destroy();
  await disconnected;
  try {
    const response = await f.install();
    assert.equal(response.statusCode, 409);
    assert.equal(f.requests.length, 0);
  } finally {
    release();
  }
  await delay(10);
  assert.equal((await f.install()).statusCode, 202);
});

test('activation survives an in-process data export and does not re-enter verification mode', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-update-export-'));
  const managed = await createManagedApp({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    apiToken: TOKEN,
    scheduler: false,
    runtimeFactory: fakeRuntime,
    updateVerification: true,
  });
  t.after(async () => {
    await managed.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  assert.equal(managed.current?.controller.maintenance, true);
  managed.activateUpdate();
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const response = await fetch(`${managed.address}/api/data-transfer/export`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ password: 'synthetic-update-export-password' }),
  });
  assert.equal(response.status, 202);
  const job = (await response.json()) as { id: string };
  const deadline = Date.now() + 15_000;
  for (;;) {
    const state = await managed.dataTransfer.get(job.id);
    if (state.status === 'ready') break;
    assert.notEqual(state.status, 'failed', state.error);
    if (Date.now() > deadline) throw new Error('The export did not finish.');
    await delay(20);
  }
  assert.equal(managed.current?.controller.maintenance, false);
  assert.equal((await fetch(`${managed.address}/api/state`, { headers })).status, 200);
});
