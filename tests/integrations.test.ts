import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app.js';
import { createScheduler } from '../src/server/scheduler.js';
import type { Runtime } from '../src/server/runtime/contract.js';
import type { Automation, Task } from '../src/shared/types.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'loom-integrations-'));
  const runtimeFactory = (): Runtime => ({
    start() {},
    async stop() {},
    async shutdown() {},
    queueState() {
      return { active: 0, waiting: 0 };
    },
  });
  try {
    const instance = await createApp({ dataDir: directory, scheduler: false, runtimeFactory });
    await instance.app.ready();
    t.after(async () => {
      await instance.app.close();
      rmSync(directory, { recursive: true, force: true });
    });
    return { ...instance, directory };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function modelEndpoint(t: TestContext) {
  const authorization: string[] = [];
  const server = createServer((request, response) => {
    authorization.push(request.headers.authorization || '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'synthetic-model' }] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    authorization,
  };
}

test('model credentials stay with their origin while explicit replacement and clearing work', async (t) => {
  const f = await fixture(t);
  const initial = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      model: {
        baseUrl: 'http://example.test:1234/v1',
        modelId: 'synthetic-model',
        apiKey: 'synthetic-original-key',
      },
      search: { apiKey: 'synthetic-search-key' },
    },
  });
  assert.equal(initial.statusCode, 200);

  const sameOrigin = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      model: { baseUrl: 'http://EXAMPLE.test:1234/another/v1/', modelId: 'another-model' },
    },
  });
  assert.equal(sameOrigin.statusCode, 200);
  assert.equal(f.store.secret('model.apiKey'), 'synthetic-original-key');
  assert.equal(sameOrigin.json().model.apiKeyConfigured, true);
  assert.equal(sameOrigin.body.includes('synthetic-original-key'), false);

  const changedOrigin = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      model: { baseUrl: 'http://example.test:5678/v1' },
    },
  });
  assert.equal(changedOrigin.statusCode, 200);
  assert.equal(f.store.secret('model.apiKey'), '');
  assert.equal(changedOrigin.json().model.apiKeyConfigured, false);
  assert.equal(f.store.secret('search.apiKey'), 'synthetic-search-key');

  const explicit = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      model: {
        baseUrl: 'https://new-provider.example.test/v1',
        apiKey: 'synthetic-replacement-key',
      },
    },
  });
  assert.equal(explicit.statusCode, 200);
  assert.equal(f.store.secret('model.apiKey'), 'synthetic-replacement-key');

  const cleared = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { model: { apiKey: '' } },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(f.store.secret('model.apiKey'), '');
  assert.equal(cleared.json().model.apiKeyConfigured, false);
});

test('model discovery forwards a saved key only to the saved origin and does not mutate it', async (t) => {
  const f = await fixture(t);
  const first = await modelEndpoint(t);
  const second = await modelEndpoint(t);
  assert.equal(
    (
      await f.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: {
          model: {
            baseUrl: first.baseUrl,
            modelId: 'synthetic-model',
            apiKey: 'synthetic-provider-key',
          },
        },
      })
    ).statusCode,
    200,
  );

  const sameOrigin = await f.app.inject({
    method: 'POST',
    url: '/api/settings/test',
    payload: { baseUrl: first.baseUrl },
  });
  assert.equal(sameOrigin.json().ok, true);
  assert.deepEqual(first.authorization, ['Bearer synthetic-provider-key']);

  const differentOrigin = await f.app.inject({
    method: 'POST',
    url: '/api/settings/test',
    payload: { baseUrl: second.baseUrl },
  });
  assert.equal(differentOrigin.json().ok, true);
  assert.deepEqual(second.authorization, ['']);

  const explicit = await f.app.inject({
    method: 'POST',
    url: '/api/settings/test',
    payload: { baseUrl: second.baseUrl, apiKey: 'synthetic-test-only-key' },
  });
  assert.equal(explicit.json().ok, true);
  assert.equal(second.authorization[1], 'Bearer synthetic-test-only-key');

  const anonymous = await f.app.inject({
    method: 'POST',
    url: '/api/settings/test',
    payload: { baseUrl: first.baseUrl, apiKey: '' },
  });
  assert.equal(anonymous.json().ok, true);
  assert.equal(first.authorization[1], '');
  assert.equal(
    f.store.secret('model.apiKey'),
    'synthetic-provider-key',
    'connection tests must not replace the saved key',
  );
  assert.equal(f.store.settings().model.baseUrl, first.baseUrl);
});

test('full settings forms can change live policies but cannot change execution settings during a task', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: {
          model: {
            baseUrl: 'http://example.test:1234/v1',
            modelId: 'synthetic-model',
            apiKey: 'synthetic-saved-key',
          },
          demoMode: true,
        },
      })
    ).statusCode,
    200,
  );
  f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Synthetic active task',
  });
  const current = f.store.settings();
  const result = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      ...current,
      model: {
        ...current.model,
        baseUrl: 'HTTP://EXAMPLE.TEST:1234/v1/',
        apiKey: 'synthetic-saved-key',
      },
      workspacePath: `${current.workspacePath}/.`,
      permissions: { ...current.permissions, network: 'deny' },
      autoLearn: false,
    },
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().permissions.network, 'deny');
  assert.equal(result.json().autoLearn, false);
  assert.equal(f.store.secret('model.apiKey'), 'synthetic-saved-key');

  for (const change of [
    { model: { modelId: 'different-model' } },
    { model: { baseUrl: 'http://other-provider.example.test/v1' } },
    { model: { apiKey: 'different-key' } },
    { model: { temperature: 1.25 } },
    { workspacePath: join(f.directory, 'must-not-be-created') },
    { demoMode: false },
  ]) {
    const rejected = await f.app.inject({ method: 'PUT', url: '/api/settings', payload: change });
    assert.equal(rejected.statusCode, 409, JSON.stringify(change));
  }
  assert.equal(
    f.store.secret('model.apiKey'),
    'synthetic-saved-key',
    'a rejected origin change must not clear the saved credential',
  );
  assert.equal(f.store.settings().model.modelId, 'synthetic-model');
  assert.equal(existsSync(join(f.directory, 'must-not-be-created')), false);
});

test('editing a watched source resets its baseline while preserving the prior active-task guard', async (t) => {
  const f = await fixture(t);
  await f.app.inject({ method: 'POST', url: '/api/demo', payload: { enabled: true } });
  let content = 'first';
  let fetches = 0;
  const scheduler = createScheduler(
    {
      store: f.store,
      enqueueTask: f.controller.enqueueTask,
      notify: f.controller.notify,
      changed: f.controller.changed,
    },
    {
      fetchText: async (url) => {
        fetches++;
        return { url, status: 200, contentType: 'text/plain', text: content };
      },
    },
  );
  t.after(() => scheduler.stop());
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/automations',
    payload: {
      name: 'Synthetic source edit',
      kind: 'url_watch',
      roomId: 'room_lounge',
      botId: 'bot_aster',
      prompt: 'Report important changes.',
      intervalMinutes: 1,
      sourceUrl: 'https://example.test/old',
      enabled: true,
    },
  });
  assert.equal(response.statusCode, 200);
  const automation = response.json<Automation>();
  await scheduler.run(automation.id);
  content = 'second';
  await scheduler.run(automation.id);
  const firstTask = f.store.list<Task>('tasks')[0];
  assert.ok(firstTask);

  const edited = await f.app.inject({
    method: 'PATCH',
    url: `/api/automations/${automation.id}`,
    payload: { sourceUrl: 'https://example.test/new' },
  });
  assert.equal(edited.statusCode, 200);
  const saved = f.store.get<{ lastTaskId: string; sourceHash?: string }>(
    'automationState',
    automation.id,
  )!;
  assert.equal(saved.lastTaskId, firstTask.id);
  assert.equal(saved.sourceHash, undefined);
  const beforeFetches = fetches;
  await scheduler.run(automation.id);
  assert.equal(
    fetches,
    beforeFetches,
    'editing the source must not let a second poll consume new events while its previous task is active',
  );
  assert.equal(f.store.list('tasks').length, 1);

  f.controller.updateTask(firstTask.id, { status: 'completed' });
  await scheduler.run(automation.id);
  assert.equal(fetches, beforeFetches + 1);
  assert.equal(
    f.store.list('tasks').length,
    1,
    'the new source first establishes a fresh baseline',
  );
  content = 'third';
  await scheduler.run(automation.id);
  assert.equal(f.store.list('tasks').length, 2);
});
