import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { DEFAULT_IMAGE_SETTINGS } from '../src/shared/model-settings.js';
import { CHARACTER_AVATARS, getAvatarImageSource } from '../src/shared/avatars.js';
import type { AvatarGeneration, Bot, GeneratedImage } from '../src/shared/types.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6cAAAAASUVORK5CYII=',
  'base64',
);

async function server(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const http = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) =>
      response.destroy(error as Error),
    );
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  );
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function until(check: () => boolean, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

async function fixture(t: TestContext, baseUrl: string, apiToken?: string) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-avatar-'));
  let f = await createApp({ dataDir, scheduler: false, apiToken });
  t.after(async () => {
    await f.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    autoLearn: false,
    images: {
      ...DEFAULT_IMAGE_SETTINGS,
      enabled: true,
      baseUrl: `${baseUrl}/v1`,
      modelId: 'avatar-fixture',
      timeoutSeconds: 10,
    },
    permissions: { shell: 'deny', fileWrite: 'deny', network: 'ask' },
  });
  f.store.setSecret('image.apiKey', 'image-fixture-key');
  f.store.setSecret('model.apiKey', 'model-private-key');
  return {
    get app() {
      return f.app;
    },
    get store() {
      return f.store;
    },
    get runtime() {
      return f.runtime;
    },
    get jobs() {
      return f.avatarGenerations;
    },
    async restart() {
      await f.app.close();
      f = await createApp({ dataDir, scheduler: false, apiToken });
    },
  };
}

test('avatar jobs use the image model without an LLM or tool approval, persist, and apply only on profile save', async (t) => {
  const requests: Array<{ url?: string; auth?: string; body: Record<string, unknown> }> = [];
  const base = await server(t, async (req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization, body: await body(req) });
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  const f = await fixture(t, base, 'app-token');
  const headers = { authorization: 'Bearer app-token' };
  const original = f.store.get<Bot>('bots', 'bot_aster')!;
  const requestId = randomUUID();
  const prompt = 'An original small forest character, centered square portrait, no text.';
  const started = await f.app.inject({
    method: 'POST',
    url: '/api/avatar-generations',
    headers,
    payload: { requestId, prompt },
  });
  assert.equal(started.statusCode, 202);
  await until(() => f.jobs.get(requestId).status === 'completed', 'avatar completion');
  const job = f.jobs.get(requestId);
  assert.ok(job.image);
  assert.equal(f.store.get<Bot>('bots', original.id)!.avatar, original.avatar);
  assert.equal(f.store.list('tasks').length, 0);
  assert.equal(f.store.list('approvals').length, 0);
  assert.deepEqual(requests, [
    {
      url: '/v1/images/generations',
      auth: 'Bearer image-fixture-key',
      body: { model: 'avatar-fixture', prompt, n: 1, size: '1024x1024' },
    },
  ]);
  const repeated = await f.app.inject({
    method: 'POST',
    url: '/api/avatar-generations',
    headers,
    payload: { requestId, prompt },
  });
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json<AvatarGeneration>().image!.id, job.image.id);
  assert.equal(requests.length, 1);
  const imagePath = getAvatarImageSource(`image:${job.image.id}`)!;
  assert.equal((await f.app.inject({ url: imagePath })).statusCode, 401);
  const served = await f.app.inject({ url: imagePath, headers });
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.deepEqual(served.rawPayload, png);
  const saved = await f.app.inject({
    method: 'PATCH',
    url: '/api/bots/bot_aster',
    headers,
    payload: { avatar: `image:${job.image.id}` },
  });
  assert.equal(saved.statusCode, 200);
  await f.restart();
  assert.equal(f.store.get<Bot>('bots', original.id)!.avatar, `image:${job.image.id}`);
  assert.equal(f.jobs.get(requestId).status, 'completed');
  assert.deepEqual((await f.app.inject({ url: imagePath, headers })).rawPayload, png);
  const list = await f.app.inject({ url: '/api/avatar-generations', headers });
  assert.equal(list.json<AvatarGeneration[]>().length, 1);
  assert.ok(!list.body.includes('image-fixture-key'));
  assert.ok(!list.body.includes('model-private-key'));
  assert.ok(!list.body.includes(png.toString('base64')));
});

test('avatar generation shares the actual runtime gate, can cancel before sending, and locks provider settings', async (t) => {
  let requests = 0;
  const base = await server(t, (_req, res) => {
    requests++;
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  const f = await fixture(t, base);
  const release = await f.runtime.acquireInference!(new AbortController().signal);
  const requestId = randomUUID();
  await f.app.inject({
    method: 'POST',
    url: '/api/avatar-generations',
    payload: { requestId, prompt: 'An avatar waiting its turn' },
  });
  await until(() => f.runtime.queueState().waiting === 1, 'shared inference wait');
  assert.equal(f.jobs.get(requestId).status, 'queued');
  assert.equal(requests, 0);
  const settings = f.store.settings();
  assert.equal(
    (
      await f.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { images: { modelId: 'other-image-model' } },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { model: { apiKey: 'changed-key' } },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { images: settings.images, model: settings.model },
      })
    ).statusCode,
    200,
  );
  const cancelled = await f.app.inject({
    method: 'DELETE',
    url: `/api/avatar-generations/${requestId}`,
  });
  assert.equal(cancelled.json<AvatarGeneration>().status, 'cancelled');
  assert.equal(f.runtime.queueState().waiting, 0);
  release();
  assert.equal(requests, 0);
  assert.equal(f.runtime.queueState().active, 0);
  const deniedId = randomUUID();
  const releaseAgain = await f.runtime.acquireInference!(new AbortController().signal);
  await f.app.inject({
    method: 'POST',
    url: '/api/avatar-generations',
    payload: { requestId: deniedId, prompt: 'Policy changes while queued' },
  });
  await until(() => f.runtime.queueState().waiting === 1, 'second shared inference wait');
  assert.equal(
    (
      await f.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { permissions: { network: 'deny' } },
      })
    ).statusCode,
    200,
  );
  releaseAgain();
  await until(() => f.jobs.get(deniedId).status === 'failed', 'queued permission recheck');
  assert.equal(requests, 0);
  assert.equal(f.runtime.queueState().active, 0);
  const denied = await f.app.inject({
    method: 'POST',
    url: '/api/avatar-generations',
    payload: { requestId: randomUUID(), prompt: 'Denied avatar' },
  });
  assert.equal(denied.statusCode, 403);
});

test('avatar idempotency and cancellation prevent duplicate or automatically replayed image requests', async (t) => {
  let requests = 0;
  let disconnected = false;
  const base = await server(t, async (req, res) => {
    const value = await body(req);
    requests++;
    if (value.prompt === 'Hang until cancelled') {
      res.once('close', () => {
        disconnected = true;
      });
      return;
    }
    res.end(
      JSON.stringify({ data: [{ b64_json: Buffer.from('<svg></svg>').toString('base64') }] }),
    );
  });
  const f = await fixture(t, base);
  const requestId = randomUUID();
  const payload = { requestId, prompt: 'Hang until cancelled' };
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/avatar-generations', payload })).statusCode,
    202,
  );
  await until(() => requests === 1, 'running image request');
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/avatar-generations', payload })).statusCode,
    202,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/avatar-generations',
        payload: { ...payload, prompt: 'Different prompt' },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/avatar-generations',
        payload: { requestId: randomUUID(), prompt: 'Another generation' },
      })
    ).statusCode,
    409,
  );
  await f.app.inject({ method: 'DELETE', url: `/api/avatar-generations/${requestId}` });
  await until(() => disconnected, 'image HTTP cancellation');
  assert.equal(f.jobs.get(requestId).status, 'cancelled');
  assert.equal(
    (
      await f.app.inject({ method: 'POST', url: '/api/avatar-generations', payload })
    ).json<AvatarGeneration>().status,
    'cancelled',
  );
  assert.equal(requests, 1);
  const failedId = randomUUID();
  const failedPayload = { requestId: failedId, prompt: 'Return invalid raster' };
  await f.app.inject({ method: 'POST', url: '/api/avatar-generations', payload: failedPayload });
  await until(() => f.jobs.get(failedId).status === 'failed', 'invalid raster failure');
  assert.match(f.jobs.get(failedId).error!, /PNG, JPEG, or WebP/);
  await f.app.inject({ method: 'POST', url: '/api/avatar-generations', payload: failedPayload });
  assert.equal(requests, 2);
  assert.equal(f.store.list<GeneratedImage>('images').length, 0);
  assert.equal(f.runtime.queueState().active, 0);
});

test('avatar generation on separate hardware does not consume a text slot and shuts down without replay', async (t) => {
  let requests = 0;
  const base = await server(t, async (req, _res) => {
    await body(req);
    requests++;
  });
  const f = await fixture(t, base);
  await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { images: { shareInferenceSlot: false } },
  });
  const release = await f.runtime.acquireInference!(new AbortController().signal);
  const requestId = randomUUID();
  await f.app.inject({
    method: 'POST',
    url: '/api/avatar-generations',
    payload: { requestId, prompt: 'Use the independent image GPU' },
  });
  await until(() => requests === 1, 'independent image request');
  assert.equal(f.runtime.queueState().active, 1);
  assert.equal(f.runtime.queueState().waiting, 0);
  release();
  await f.restart();
  assert.equal(f.jobs.get(requestId).status, 'interrupted');
  await f.app.inject({
    method: 'POST',
    url: '/api/avatar-generations',
    payload: { requestId, prompt: 'Use the independent image GPU' },
  });
  assert.equal(requests, 1);
  const queuedId = randomUUID();
  f.store.put<AvatarGeneration>('avatarGenerations', {
    id: queuedId,
    status: 'queued',
    prompt: 'Never auto-replay',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await f.restart();
  assert.equal(f.jobs.get(queuedId).status, 'interrupted');
  assert.equal(requests, 1);
});

test('avatar routes authenticate requests and reject remote, malformed, or nonexistent image references', async (t) => {
  const f = await fixture(t, 'http://127.0.0.1:1', 'avatar-app-token');
  for (const [method, url] of [
    ['GET', '/api/avatar-generations'],
    ['POST', '/api/avatar-generations'],
    ['GET', `/api/avatar-generations/${randomUUID()}`],
    ['DELETE', `/api/avatar-generations/${randomUUID()}`],
  ] as const)
    assert.equal((await f.app.inject({ method, url })).statusCode, 401);
  const headers = { authorization: 'Bearer avatar-app-token' };
  for (const avatar of [
    'https://example.com/image.png',
    '/private/file.png',
    'data:image/svg+xml,<svg/>',
    `image:img_${'a'.repeat(64)}`,
    'character:missing',
    '<img>',
    'a'.repeat(41),
  ]) {
    const result = await f.app.inject({
      method: 'PATCH',
      url: '/api/bots/bot_aster',
      headers,
      payload: { avatar },
    });
    assert.equal(result.statusCode, 400, avatar);
    assert.equal(
      getAvatarImageSource(avatar),
      avatar.startsWith('image:img_') ? `/api/images/${avatar.slice(6)}` : undefined,
    );
  }
  for (const avatar of [...CHARACTER_AVATARS.map((entry) => entry.value), 'sparkles', '🤖', '👩‍💻'])
    assert.equal(
      (
        await f.app.inject({
          method: 'PATCH',
          url: '/api/bots/bot_aster',
          headers,
          payload: { avatar },
        })
      ).statusCode,
      200,
    );
  for (const payload of [
    { requestId: 'invalid', prompt: 'Draw' },
    { requestId: randomUUID(), prompt: ' ' },
    { requestId: randomUUID(), prompt: 'a'.repeat(16_001) },
  ])
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/api/avatar-generations', headers, payload }))
        .statusCode,
      400,
    );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/avatar-generations',
        headers: { ...headers, origin: 'https://elsewhere.invalid' },
        payload: { requestId: randomUUID(), prompt: 'Draw' },
      })
    ).statusCode,
    403,
  );
  assert.equal(f.jobs.list().length, 0);
});

test('runtime shutdown rejects external inference waiters and does not leak a permit', async (t) => {
  const f = await fixture(t, 'http://127.0.0.1:1');
  const release = await f.runtime.acquireInference!(new AbortController().signal);
  const waiting = f.runtime.acquireInference!(new AbortController().signal);
  const rejected = assert.rejects(waiting, /stopped/);
  await f.runtime.shutdown();
  await rejected;
  release();
  assert.equal(f.runtime.queueState().waiting, 0);
  assert.equal(f.runtime.queueState().active, 0);
  await assert.rejects(f.runtime.acquireInference!(new AbortController().signal), /shutting down/);
});

test('avatar job errors redact both image and language-model credentials before persistence', async (t) => {
  const f = await fixture(t, 'http://127.0.0.1:1');
  f.runtime.acquireInference = () =>
    Promise.reject(new Error('Failed with image-fixture-key and model-private-key'));
  const requestId = randomUUID();
  await f.app.inject({
    method: 'POST',
    url: '/api/avatar-generations',
    payload: { requestId, prompt: 'An avatar' },
  });
  await until(() => f.jobs.get(requestId).status === 'failed', 'redacted generation failure');
  assert.equal(f.jobs.get(requestId).error, 'Failed with [redacted] and [redacted]');
  const response = await f.app.inject({ url: `/api/avatar-generations/${requestId}` });
  assert.ok(!response.body.includes('image-fixture-key'));
  assert.ok(!response.body.includes('model-private-key'));
});
