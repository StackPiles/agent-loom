import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { Settings, Room, Task } from '../src/shared/types.js';
import {
  DEFAULT_IMAGE_SETTINGS,
  DEFAULT_INFERENCE_SETTINGS,
  REASONING_EFFORTS,
} from '../src/shared/model-settings.js';
import { createApp } from '../src/server/app.js';
import type { Runtime } from '../src/server/runtime/contract.js';

async function fixture(t: TestContext, realRuntime = false) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-model-configuration-'));
  let configurations = 0;
  const runtimeFactory = (): Runtime => ({
    start() {},
    async stop() {},
    async shutdown() {},
    queueState: () => ({ active: 0, waiting: 0 }),
    configureInference: () => {
      configurations++;
    },
  });
  const instance = await createApp({
    dataDir: directory,
    scheduler: false,
    ...(realRuntime ? {} : { runtimeFactory }),
  });
  t.after(async () => {
    await instance.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const save = (payload: unknown) =>
    instance.app.inject({ method: 'PUT', url: '/api/settings', payload: payload as object });
  return { ...instance, directory, save, configurations: () => configurations };
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

test('legacy settings receive conservative defaults and invalid model settings reject atomically', async (t) => {
  const f = await fixture(t);
  const stored = f.store.get<Settings & { id: string }>('settings', 'main')!;
  const { inference: _inference, images: _images, ...legacy } = stored;
  f.store.put('settings', legacy);
  assert.deepEqual(f.store.settings().inference, DEFAULT_INFERENCE_SETTINGS);
  assert.deepEqual(f.store.settings().images, DEFAULT_IMAGE_SETTINGS);
  const baseline = f.store.get('settings', 'main');
  const invalid: Array<Record<string, Record<string, unknown>>> = [
    { inference: { maxConcurrentRequests: 0 } },
    { inference: { maxConcurrentRequests: 17 } },
    { inference: { maxConcurrentRequests: 1.5 } },
    { images: { enabled: true } },
    { images: { size: '8192x8192' } },
    { images: { size: '64x63' } },
    { images: { size: 'landscape' } },
    { images: { timeoutSeconds: 1801 } },
    { images: { baseUrl: 'https://user:password@images.example.test/v1' } },
    { images: { baseUrl: 'http://169.254.169.254/v1' } },
    { images: { baseUrl: 'http://metadata.google.internal/v1' } },
    { model: { reasoningEffort: 'turbo' } },
  ];
  for (const patch of invalid) {
    const response = await f.save({
      ...patch,
      model: { apiKey: 'synthetic-rejected-model-key', ...patch.model },
      images: { apiKey: 'synthetic-rejected-image-key', ...patch.images },
    });
    assert.equal(response.statusCode, 400, JSON.stringify(patch));
    assert.deepEqual(f.store.get('settings', 'main'), baseline);
    assert.equal(f.store.secret('model.apiKey'), '');
    assert.equal(f.store.secret('image.apiKey'), '');
    assert.equal(response.body.includes('synthetic-rejected-'), false);
  }
});

test('image credentials are independently encrypted and never follow a changed provider origin', async (t) => {
  const f = await fixture(t);
  const modelKey = 'synthetic-text-provider-secret';
  const imageKey = 'synthetic-image-provider-secret';
  const initial = await f.save({
    model: {
      baseUrl: 'http://text.example.test:4000/v1',
      modelId: 'text-fixture',
      apiKey: modelKey,
    },
    images: {
      baseUrl: 'http://images.example.test:5000/v1',
      modelId: 'image-fixture',
      enabled: true,
      apiKey: imageKey,
    },
  });
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(f.store.secret('model.apiKey'), modelKey);
  assert.equal(f.store.secret('image.apiKey'), imageKey);
  assert.equal(initial.json().model.apiKeyConfigured, true);
  assert.equal(initial.json().images.apiKeyConfigured, true);
  const snapshot = await f.app.inject({ method: 'GET', url: '/api/state' });
  const rawSettings = JSON.stringify(f.store.get('settings', 'main'));
  const encrypted = f.store.db.prepare('SELECT key,value FROM secrets').all() as Array<{
    key: string;
    value: string;
  }>;
  for (const key of [modelKey, imageKey]) {
    assert.equal(initial.body.includes(key), false);
    assert.equal(snapshot.body.includes(key), false);
    assert.equal(rawSettings.includes(key), false);
    assert.equal(
      encrypted.some((row) => row.value.includes(key)),
      false,
    );
  }
  assert.ok(encrypted.find((row) => row.key === 'image.apiKey')?.value.includes('.'));
  const sameOrigin = await f.save({
    images: { baseUrl: 'http://IMAGES.example.test:5000/other/v1/' },
  });
  assert.equal(sameOrigin.statusCode, 200, sameOrigin.body);
  assert.equal(f.store.secret('image.apiKey'), imageKey);
  const changedOrigin = await f.save({ images: { baseUrl: 'http://images.example.test:5001/v1' } });
  assert.equal(changedOrigin.statusCode, 200, changedOrigin.body);
  assert.equal(f.store.secret('image.apiKey'), '');
  assert.equal(changedOrigin.json().images.apiKeyConfigured, false);
  assert.equal(f.store.secret('model.apiKey'), modelKey);
  const replacement = await f.save({
    images: {
      baseUrl: 'https://other-image.example.test/v1',
      apiKey: 'synthetic-replacement-image-key',
    },
  });
  assert.equal(replacement.statusCode, 200, replacement.body);
  assert.equal(f.store.secret('image.apiKey'), 'synthetic-replacement-image-key');
  assert.equal(f.store.secret('model.apiKey'), modelKey);
  const clear = await f.save({ images: { apiKey: '' } });
  assert.equal(clear.statusCode, 200, clear.body);
  assert.equal(clear.json().images.apiKeyConfigured, false);
  assert.equal(f.store.secret('image.apiKey'), '');
  assert.equal(f.store.secret('model.apiKey'), modelKey);
});

test('live capacity edits accept unchanged full forms while image connections and room policy stay pinned', async (t) => {
  const f = await fixture(t);
  const configured = await f.save({
    model: { baseUrl: 'http://text.example.test:4000/v1', modelId: 'text-fixture' },
    images: {
      baseUrl: 'http://images.example.test:5000/v1',
      modelId: 'image-fixture',
      apiKey: 'synthetic-pinned-key',
    },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  const task = f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Remain queued in the fixture.',
  });
  const before = f.configurations();
  const fullForm = await f.save({ ...f.store.settings(), inference: { maxConcurrentRequests: 4 } });
  assert.equal(fullForm.statusCode, 200, fullForm.body);
  assert.equal(fullForm.json().inference.maxConcurrentRequests, 4);
  assert.equal(f.configurations(), before + 1);
  const saved = f.store.settings();
  for (const images of [
    { enabled: true },
    { modelId: 'changed-image-model' },
    { baseUrl: 'http://images.example.test:5001/v1' },
    { shareInferenceSlot: false },
    { apiKey: 'synthetic-rejected-live-key' },
  ]) {
    const blocked = await f.save({ images });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.deepEqual(f.store.settings(), saved);
    assert.equal(f.store.secret('image.apiKey'), 'synthetic-pinned-key');
  }
  const unchanged = await f.app.inject({
    method: 'PATCH',
    url: '/api/rooms/room_lounge',
    payload: { parallelResponses: false },
  });
  assert.equal(unchanged.statusCode, 200, unchanged.body);
  const changed = await f.app.inject({
    method: 'PATCH',
    url: '/api/rooms/room_lounge',
    payload: { parallelResponses: true },
  });
  assert.equal(changed.statusCode, 409, changed.body);
  assert.equal(Boolean(f.store.get<Room>('rooms', 'room_lounge')?.parallelResponses), false);
  f.controller.updateTask(task.id, { status: 'completed' });
  const afterCompletion = await f.app.inject({
    method: 'PATCH',
    url: '/api/rooms/room_lounge',
    payload: { parallelResponses: true },
  });
  assert.equal(afterCompletion.statusCode, 200, afterCompletion.body);
  assert.equal(afterCompletion.json().parallelResponses, true);
});

test(
  'real Pi transmits every selected reasoning effort exactly and never silently downgrades unsupported ultra',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t, true);
    const requests: Array<{ method?: string; path?: string; body: Record<string, unknown> }> = [];
    let rejectUltra = false;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push({ method: request.method, path: request.url, body });
      if (rejectUltra && body.reasoning_effort === 'ultra') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: { message: 'Fixture does not support reasoning_effort=ultra.' },
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finishReason] of [
        [{ content: 'Fixture reasoning effort accepted.' }, null],
        [{}, 'stop'],
      ] as const) {
        response.write(
          `data: ${JSON.stringify({ id: `reasoning-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'reasoning-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
        );
      }
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const initial = await f.save({
      model: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'reasoning-fixture',
        reasoningMode: 'openai',
      },
      autoLearn: false,
    });
    assert.equal(initial.statusCode, 200, initial.body);
    const run = async (prompt: string) => {
      const task = f.controller.enqueueTask({ roomId: 'room_lounge', botId: 'bot_aster', prompt });
      await until(
        () => ['completed', 'failed'].includes(f.store.get<Task>('tasks', task.id)!.status),
        prompt,
      );
      return f.store.get<Task>('tasks', task.id)!;
    };
    for (const effort of REASONING_EFFORTS) {
      const setting = await f.save({ model: { reasoningMode: 'openai', reasoningEffort: effort } });
      assert.equal(setting.statusCode, 200, setting.body);
      const count = requests.length;
      const task = await run(`Confirm selected reasoning effort ${effort}.`);
      assert.equal(task.status, 'completed', task.error);
      assert.equal(requests.length, count + 1, effort);
      assert.equal(requests.at(-1)?.method, 'POST');
      assert.equal(requests.at(-1)?.path, '/v1/chat/completions');
      assert.equal(requests.at(-1)?.body.reasoning_effort, effort, effort);
    }
    const serverDefault = await f.save({
      model: { reasoningMode: 'server', reasoningEffort: 'ultra' },
    });
    assert.equal(serverDefault.statusCode, 200, serverDefault.body);
    const serverTask = await run('Use the inference server default.');
    assert.equal(serverTask.status, 'completed', serverTask.error);
    assert.equal(Object.hasOwn(requests.at(-1)!.body, 'reasoning_effort'), false);
    rejectUltra = true;
    const ultra = await f.save({ model: { reasoningMode: 'openai', reasoningEffort: 'ultra' } });
    assert.equal(ultra.statusCode, 200, ultra.body);
    const count = requests.length;
    const rejected = await run('Report the configured effort error.');
    assert.equal(rejected.status, 'failed');
    assert.match(rejected.error ?? '', /Fixture does not support reasoning_effort=ultra/);
    assert.equal(requests.length, count + 1);
    assert.equal(requests.at(-1)?.body.reasoning_effort, 'ultra');
  },
);
