import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { createManagedApp } from '../src/server/managed-app.js';
import { ApplicationUpdates } from '../src/server/updates.js';
import type { UpdateJob } from '../src/shared/updates.js';

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
      if (path.endsWith('/commits/main'))
        return Response.json({ sha: NEXT, commit: { committer: null } });
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
            status: 'completed',
            conclusion: 'success',
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
    runtimeFactory: fakeRuntime,
    updates,
    updateVerification: options.verification,
  });
  t.after(async () => {
    await context.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const headers = { authorization: `Bearer ${TOKEN}` };
  const install = (requestId = randomUUID()) =>
    context.app.inject({
      method: 'POST',
      url: '/api/updates/install',
      headers,
      payload: { commit: NEXT, requestId },
    });
  return { ...context, requests, proceeds, headers, install };
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
    assert.equal(f.controller.maintenance, false);
    assert.equal(f.store.get<{ status: string }>(kind, 'active')?.status, status);
    f.store.remove(kind, 'active');
  }
  assert.equal(f.requests.length, 0);
});

test('accepted updates pause API and direct task admission; retries return the same job', async (t) => {
  const f = await fixture(t);
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
  assert.equal((await f.install(requestId)).statusCode, 202);
  assert.equal(f.requests.length, 1);
  f.resumeAfterUpdate('wrong-job');
  assert.equal(f.controller.maintenance, true);
  f.resumeAfterUpdate(requestId);
  assert.equal(f.controller.maintenance, false);
  assert.equal((await f.app.inject({ url: '/api/state', headers: f.headers })).statusCode, 200);
});

test('a definitive launcher rejection releases admission; an uncertain receipt does not', async (t) => {
  for (const uncertain of [false, true]) {
    const f = await fixture(t, { reject: true, uncertain });
    assert.equal((await f.install()).statusCode, 409);
    assert.equal(f.controller.maintenance, uncertain);
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
