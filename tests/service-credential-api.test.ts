import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import { saveServiceAccount } from '../src/server/service-accounts.js';
import type { ServiceAccountInput } from '../src/shared/service-accounts.js';

const secret = ' \tfixture-service-secret-\"<>&\nexact whitespace ';
const token = 'fixture-service-owner-api-token';
const input = (patch: Partial<ServiceAccountInput> = {}): ServiceAccountInput => ({
  name: 'Synthetic service',
  url: 'https://service.example/login',
  login: 'bot@example.test',
  botId: 'bot_aster',
  mailAccountId: null,
  status: 'active',
  notes: '',
  credential: secret,
  ...patch,
});

async function fixture(t: TestContext, apiToken?: string) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-service-credential-api-'));
  const instance = await createApp({
    dataDir,
    scheduler: false,
    apiToken,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  t.after(async () => {
    await instance.app.close();
    await rm(dataDir, { force: true, recursive: true });
  });
  const account = saveServiceAccount(instance.store, input());
  const url = `/api/service-accounts/${account.id}/credential`;
  const call = (
    path = url,
    payload: unknown = { expectedRevision: account.revision },
    headers: Record<string, string> = {},
    method: 'GET' | 'POST' = 'POST',
  ) =>
    instance.app.inject({
      method,
      url: path,
      ...(method === 'POST' ? { payload: payload as object } : {}),
      headers: { host: 'localhost', ...headers },
    });
  return { ...instance, account, url, call };
}

test('saved credentials require existing authentication and same-origin protection', async (t) => {
  const { call, account, url } = await fixture(t, token);
  const body = { expectedRevision: account.revision };
  for (const headers of [{}, { authorization: 'Bearer wrong-token' }]) {
    const response = await call(url, body, headers);
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body.includes('fixture-service-secret'), false);
  }
  const rejected = await call(url, body, {
    authorization: `Bearer ${token}`,
    origin: 'https://untrusted.example',
  });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.body.includes('fixture-service-secret'), false);
  const login = await call('/api/auth', { token }, { origin: 'http://localhost' });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const allowed = await call(url, body, { cookie, origin: 'http://localhost' });
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.equal(allowed.headers['cache-control'], 'no-store');
  assert.deepEqual(allowed.json(), {
    accountId: account.id,
    revision: account.revision,
    credential: secret,
  });
  assert.equal((await call(url, undefined, { cookie }, 'GET')).statusCode, 404);
});

test('explicit reads leave public records, snapshots, events and encrypted storage unchanged', async (t) => {
  const { call, store, controller, account } = await fixture(t);
  const before = store.db.prepare('SELECT key,value FROM secrets').all();
  const eventCount = store.db.prepare('SELECT count(*) AS count FROM events').get();
  const response = await call();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().credential, secret);
  for (const path of [
    '/api/state',
    '/api/service-accounts',
    `/api/service-accounts/${account.id}`,
  ]) {
    const result = await call(path, undefined, {}, 'GET');
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.includes('fixture-service-secret'), false);
  }
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('fixture-service-secret'), false);
  assert.deepEqual(store.db.prepare('SELECT key,value FROM secrets').all(), before);
  assert.deepEqual(store.db.prepare('SELECT count(*) AS count FROM events').get(), eventCount);
  assert.equal(
    JSON.stringify(store.list('serviceAccounts')).includes('fixture-service-secret'),
    false,
  );
  assert.equal(store.secret(`service.${account.id}.credential`), secret);
  const event = new Promise<unknown>((resolve) => controller.events.once('snapshot', resolve));
  controller.changed();
  // Keep the event loop alive while the controller's intentionally unref'd timer runs.
  const keepAlive = setTimeout(() => {}, 2_000);
  try {
    assert.equal(JSON.stringify(await event).includes('fixture-service-secret'), false);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('credential reads reject missing revisions, changed identities, cleared and deleted records', async (t) => {
  const { call, store, account, url } = await fixture(t);
  for (const invalid of [{}, { expectedRevision: 0 }, { expectedRevision: 1, extra: true }])
    assert.equal((await call(url, invalid)).statusCode, 400);
  const updated = saveServiceAccount(
    store,
    input({
      login: 'changed@example.test',
      credential: undefined,
      expectedRevision: account.revision,
    }),
    account.id,
  );
  const stale = await call();
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.includes('fixture-service-secret'), false);
  const missing = await call(url, { expectedRevision: updated.revision });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.headers['cache-control'], 'no-store');
  store.remove('serviceAccounts', account.id);
  assert.equal((await call(url, { expectedRevision: updated.revision })).statusCode, 404);
});

test('credential read failures never forward storage diagnostics to the API', async (t) => {
  const { call, store } = await fixture(t);
  t.mock.method(store, 'secret', () => {
    throw new Error(secret);
  });
  const failed = await call();
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.headers['cache-control'], 'no-store');
  assert.equal(failed.body.includes('fixture-service-secret'), false);
});
