import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import type { ImageTestAdapters } from '../src/server/image-tests.js';
import {
  IMAGE_TEST_PREVIEW_TTL_MS,
  IMAGE_TEST_PROMPT,
  isActiveImageTest,
  type ImageTestJob,
  type ImageTestRequest,
  type ImageTestSettings,
} from '../src/shared/image-tests.js';
import { DEFAULT_IMAGE_SETTINGS } from '../src/shared/model-settings.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6cAAAAASUVORK5CYII=',
  'base64',
);
const replyImage = (response: ServerResponse) =>
  response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));

async function server(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const http = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => response.destroy(error));
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
function input(baseUrl: string, settings: Partial<ImageTestSettings> = {}): ImageTestRequest {
  return {
    requestId: randomUUID(),
    settings: {
      baseUrl: `${baseUrl}/v1`,
      modelId: 'unsaved-image-model',
      size: '512x512',
      responseFormat: 'auto',
      timeoutSeconds: 10,
      shareInferenceSlot: true,
      ...settings,
    },
  };
}
async function fixture(
  t: TestContext,
  baseUrl: string,
  options: { apiToken?: string; adapters?: ImageTestAdapters } = {},
) {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'loom-image-test-')));
  const appOptions = {
    dataDir,
    scheduler: false,
    apiToken: options.apiToken,
    imageTestAdapters: options.adapters,
  };
  let f = await createApp(appOptions);
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
      enabled: false,
      baseUrl: `${baseUrl}/saved`,
      modelId: 'saved-model',
    },
    permissions: { shell: 'deny', fileWrite: 'deny', network: 'ask' },
  });
  f.store.setSecret('image.apiKey', 'saved-image-key');
  f.store.setSecret('model.apiKey', 'private-language-key');
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
      return f.imageTests;
    },
    get avatarJobs() {
      return f.avatarGenerations;
    },
    async restart() {
      await f.app.close();
      f = await createApp(appOptions);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function finished(f: Fixture, id: string) {
  await until(() => !isActiveImageTest(f.jobs.get(id)), 'image test completion');
  return f.jobs.get(id);
}

test('image test actually generates one image using unsaved settings, without saving settings or chat images', async (t) => {
  const requests: { url?: string; auth?: string; body: Record<string, unknown> }[] = [];
  const base = await server(t, async (req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization, body: await body(req) });
    replyImage(res);
  });
  const f = await fixture(t, base, { apiToken: 'test-app-token' });
  const headers = { authorization: 'Bearer test-app-token' };
  const before = f.store.settings();
  const untouchedKinds = [
    'messages',
    'rooms',
    'tasks',
    'activities',
    'approvals',
    'images',
    'bots',
  ];
  const original = Object.fromEntries(untouchedKinds.map((kind) => [kind, f.store.list(kind)]));
  const payload = { ...input(base, { responseFormat: 'b64_json' }), apiKey: 'entered-unsaved-key' };
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/image-tests', headers, payload })).statusCode,
    202,
  );
  const job = await finished(f, payload.requestId);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.modelId, 'unsaved-image-model');
  assert.equal(job.previewAvailable, true);
  assert.ok(job.image);
  assert.ok(
    Math.abs(
      Date.parse(job.previewExpiresAt!) -
        Date.parse(job.image.createdAt) -
        IMAGE_TEST_PREVIEW_TTL_MS,
    ) < 5000,
  );
  assert.deepEqual(requests, [
    {
      url: '/v1/images/generations',
      auth: 'Bearer entered-unsaved-key',
      body: {
        model: 'unsaved-image-model',
        prompt: IMAGE_TEST_PROMPT,
        n: 1,
        size: '512x512',
        response_format: 'b64_json',
      },
    },
  ]);
  assert.deepEqual(f.store.settings(), before);
  assert.equal(f.store.secret('image.apiKey'), 'saved-image-key');
  assert.equal(f.store.secret('model.apiKey'), 'private-language-key');
  assert.deepEqual(
    Object.fromEntries(untouchedKinds.map((kind) => [kind, f.store.list(kind)])),
    original,
  );
  const stored = JSON.stringify(f.store.list('imageTests'));
  assert.ok(!stored.includes('entered-unsaved-key'));
  assert.ok(!stored.includes(png.toString('base64')));
  const imageUrl = `/api/image-tests/${job.id}/image`;
  for (const [method, url] of [
    ['POST', '/api/image-tests'],
    ['GET', `/api/image-tests/${job.id}`],
    ['DELETE', `/api/image-tests/${job.id}`],
    ['GET', imageUrl],
  ] as const)
    assert.equal((await f.app.inject({ method, url })).statusCode, 401);
  const result = await f.app.inject({ url: `/api/image-tests/${job.id}`, headers });
  assert.ok(!result.body.includes('fingerprint'));
  assert.ok(!result.body.includes('entered-unsaved-key'));
  const preview = await f.app.inject({ url: imageUrl, headers });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.headers['content-type'], 'image/png');
  assert.equal(preview.headers['cache-control'], 'no-store');
  assert.match(String(preview.headers['content-disposition']), /^inline;/);
  assert.deepEqual(preview.rawPayload, png);
  const download = await f.app.inject({ url: `${imageUrl}?download=1`, headers });
  assert.match(String(download.headers['content-disposition']), /^attachment;/);
  assert.deepEqual(download.rawPayload, png);
  assert.equal(
    (await f.app.inject({ url: `/api/images/${job.image.id}`, headers })).statusCode,
    404,
  );
  const repeated = await f.app.inject({
    method: 'POST',
    url: '/api/image-tests',
    headers,
    payload,
  });
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json<ImageTestJob>().image?.id, job.image.id);
  assert.equal(requests.length, 1);
});

test('image tests use unsaved step settings and keep omitted or null counts server-managed', async (t) => {
  const requests: Record<string, unknown>[] = [];
  const base = await server(t, async (req, res) => {
    requests.push(await body(req));
    replyImage(res);
  });
  const f = await fixture(t, base);
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    images: { ...f.store.settings().images!, steps: 75, stepsParameter: 'steps' },
  });
  const before = f.store.settings();
  for (const settings of [
    { steps: 40, stepsParameter: 'num_inference_steps' as const },
    { steps: 20 },
    {},
    { steps: null, stepsParameter: 'steps' as const },
  ]) {
    const payload = input(base, settings);
    const started = await f.app.inject({ method: 'POST', url: '/api/image-tests', payload });
    assert.equal(started.statusCode, 202, started.body);
    const job = await finished(f, payload.requestId);
    assert.equal(job.status, 'completed', job.error);
    const differentCount = await f.app.inject({
      method: 'POST',
      url: '/api/image-tests',
      payload: { ...payload, settings: { ...payload.settings, steps: 41 } },
    });
    assert.equal(differentCount.statusCode, 409, differentCount.body);
  }
  assert.equal(requests.length, 4);
  assert.equal(requests[0]!.num_inference_steps, 40);
  assert.equal(requests[0]!.prompt, IMAGE_TEST_PROMPT);
  assert.equal(Object.hasOwn(requests[0]!, 'steps'), false);
  const match = /<sd_cpp_extra_args>([\s\S]*?)<\/sd_cpp_extra_args>/.exec(
    String(requests[1]!.prompt),
  );
  assert.ok(match);
  assert.deepEqual(JSON.parse(match[1]!), { sample_params: { sample_steps: 20 } });
  assert.equal(Object.hasOwn(requests[1]!, 'steps'), false);
  for (const request of requests.slice(2)) {
    assert.equal(request.prompt, IMAGE_TEST_PROMPT);
    for (const parameter of ['steps', 'num_inference_steps', 'sample_steps'])
      assert.equal(Object.hasOwn(request, parameter), false);
  }
  assert.deepEqual(f.store.settings(), before);
});

test('invalid image test step values reject before starting a job or sending a model request', async (t) => {
  let requests = 0;
  const base = await server(t, (_req, res) => {
    requests++;
    replyImage(res);
  });
  const f = await fixture(t, base);
  const before = f.store.settings();
  for (const patch of [
    ...[0, 1001, 1.5, '40', true].map((steps) => ({ steps })),
    ...['unsupported', null, ['steps']].map((stepsParameter) => ({ stepsParameter })),
  ]) {
    const payload = input(base);
    const rejected = await f.app.inject({
      method: 'POST',
      url: '/api/image-tests',
      payload: { ...payload, settings: { ...payload.settings, ...patch } },
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
  }
  assert.equal(requests, 0);
  assert.deepEqual(f.store.list('imageTests'), []);
  assert.deepEqual(f.store.settings(), before);
});

test('saved image credentials are origin-bound; edited and explicitly cleared keys do not alter saved credentials', async (t) => {
  const seen: { destination: string; auth?: string }[] = [];
  const first = await server(t, async (req, res) => {
    await body(req);
    seen.push({ destination: 'saved-origin', auth: req.headers.authorization });
    replyImage(res);
  });
  const other = await server(t, async (req, res) => {
    await body(req);
    seen.push({ destination: 'other-origin', auth: req.headers.authorization });
    replyImage(res);
  });
  const f = await fixture(t, first);
  for (const payload of [
    input(first),
    input(other),
    { ...input(other), apiKey: 'explicit-other-key' },
    { ...input(first), apiKey: '' },
  ]) {
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/api/image-tests', payload })).statusCode,
      202,
    );
    assert.equal((await finished(f, payload.requestId)).status, 'completed');
  }
  assert.deepEqual(seen, [
    { destination: 'saved-origin', auth: 'Bearer saved-image-key' },
    { destination: 'other-origin', auth: undefined },
    { destination: 'other-origin', auth: 'Bearer explicit-other-key' },
    { destination: 'saved-origin', auth: undefined },
  ]);
  assert.equal(f.store.secret('image.apiKey'), 'saved-image-key');
  assert.equal(f.store.settings().images!.baseUrl, `${first}/saved`);
});

test('a keyless queued image test keeps its empty credential snapshot when the saved endpoint and key change', async (t) => {
  const seen: { destination: string; auth?: string }[] = [];
  const first = await server(t, async (req, res) => {
    await body(req);
    seen.push({ destination: 'original', auth: req.headers.authorization });
    replyImage(res);
  });
  const other = await server(t, async (req, res) => {
    await body(req);
    seen.push({ destination: 'new', auth: req.headers.authorization });
    replyImage(res);
  });
  const f = await fixture(t, first);
  f.store.setSecret('image.apiKey', '');
  const release = await f.runtime.acquireInference!(new AbortController().signal);
  t.after(release);
  const payload = input(first);
  await f.app.inject({ method: 'POST', url: '/api/image-tests', payload });
  await until(
    () => f.runtime.queueState().waiting === 1,
    'image test waiting behind the language model',
  );
  assert.equal(seen.length, 0);
  const saved = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { images: { baseUrl: `${other}/v1`, apiKey: 'new-origin-private-key' } },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  release();
  assert.equal((await finished(f, payload.requestId)).status, 'completed');
  assert.deepEqual(seen, [{ destination: 'original', auth: undefined }]);
  assert.equal(f.store.secret('image.apiKey'), 'new-origin-private-key');
});

test('image tests share the runtime gate, cancel while queued, and recheck network permission before dispatch', async (t) => {
  let requests = 0;
  const base = await server(t, (_req, res) => {
    requests++;
    replyImage(res);
  });
  const f = await fixture(t, base);
  const release = await f.runtime.acquireInference!(new AbortController().signal);
  t.after(release);
  const cancelled = input(base);
  await f.app.inject({ method: 'POST', url: '/api/image-tests', payload: cancelled });
  await until(() => f.runtime.queueState().waiting === 1, 'queued cancellable image test');
  assert.equal(f.jobs.get(cancelled.requestId).deadlineAt, undefined);
  const response = await f.app.inject({
    method: 'DELETE',
    url: `/api/image-tests/${cancelled.requestId}`,
  });
  assert.equal(response.json<ImageTestJob>().status, 'cancelled');
  assert.equal(response.json<ImageTestJob>().deadlineAt, undefined);
  assert.equal(f.runtime.queueState().waiting, 0);
  const changedPolicy = input(base);
  await f.app.inject({ method: 'POST', url: '/api/image-tests', payload: changedPolicy });
  await until(() => f.runtime.queueState().waiting === 1, 'queued permission recheck');
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
  release();
  const failed = await finished(f, changedPolicy.requestId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /network permission/);
  assert.equal(requests, 0);
  assert.equal(f.runtime.queueState().active, 0);
  assert.equal(f.runtime.queueState().waiting, 0);
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/image-tests', payload: input(base) }))
      .statusCode,
    403,
  );
});

test('an image test can wait beyond its generation budget and receives a full deadline after admission', async (t) => {
  let requests = 0;
  const base = await server(t, (_req, res) => {
    requests++;
    replyImage(res);
  });
  const timeoutMs = 1000;
  const f = await fixture(t, base, { adapters: { timeoutMs } });
  const release = await f.runtime.acquireInference!(new AbortController().signal);
  t.after(release);
  const payload = input(base);
  await f.app.inject({ method: 'POST', url: '/api/image-tests', payload });
  await until(() => f.runtime.queueState().waiting === 1, 'test waiting for inference capacity');
  assert.equal(f.jobs.get(payload.requestId).deadlineAt, undefined);
  await delay(timeoutMs + 100);
  assert.equal(f.jobs.get(payload.requestId).status, 'queued');
  assert.equal(f.jobs.get(payload.requestId).deadlineAt, undefined);
  assert.equal(f.runtime.queueState().waiting, 1);
  assert.equal(f.runtime.queueState().active, 1);
  assert.equal(requests, 0);
  const admittedAfter = Date.now();
  release();
  const job = await finished(f, payload.requestId);
  assert.equal(job.status, 'completed', job.error);
  assert.ok(Date.parse(job.deadlineAt!) >= admittedAfter + timeoutMs);
  assert.equal(requests, 1);
  assert.equal(f.runtime.queueState().waiting, 0);
  assert.equal(f.runtime.queueState().active, 0);
  await f.app.inject({ method: 'POST', url: '/api/image-tests', payload });
  assert.equal(requests, 1, 'the completed request ID must never generate again');
});

test('a 2K image test accepts a one-hour budget and starts its deadline after inference admission', async (t) => {
  let response: ServerResponse | undefined;
  const requests: Record<string, unknown>[] = [];
  const base = await server(t, async (request, reply) => {
    requests.push(await body(request));
    response = reply;
  });
  const f = await fixture(t, base);
  const release = await f.runtime.acquireInference!(new AbortController().signal);
  t.after(release);
  const payload = input(base, { size: '2048x2048', timeoutSeconds: 3600 });
  const accepted = await f.app.inject({ method: 'POST', url: '/api/image-tests', payload });
  assert.equal(accepted.statusCode, 202, accepted.body);
  await until(() => f.runtime.queueState().waiting === 1, 'one-hour test waits for admission');
  assert.equal(f.jobs.get(payload.requestId).deadlineAt, undefined);
  assert.equal(requests.length, 0);
  const admittedAfter = Date.now();
  release();
  await until(() => Boolean(response), 'one-hour test HTTP request');
  const admittedBefore = Date.now();
  const deadline = Date.parse(f.jobs.get(payload.requestId).deadlineAt!);
  assert.ok(deadline >= admittedAfter + 3_600_000);
  assert.ok(deadline <= admittedBefore + 3_600_000);
  assert.deepEqual(requests, [
    {
      model: 'unsaved-image-model',
      prompt: IMAGE_TEST_PROMPT,
      n: 1,
      size: '2048x2048',
    },
  ]);
  replyImage(response!);
  assert.equal((await finished(f, payload.requestId)).status, 'completed');
  await f.app.inject({ method: 'POST', url: '/api/image-tests', payload });
  assert.equal(requests.length, 1, 'the one-hour request is never submitted twice');
});

test('request UUIDs suppress duplicates, mismatched input, concurrent tests, and a late POST after cancellation', async (t) => {
  let requests = 0;
  let disconnected = false;
  const base = await server(t, async (req, res) => {
    await body(req);
    requests++;
    res.once('close', () => {
      disconnected = true;
    });
  });
  const f = await fixture(t, base);
  const payload = input(base);
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/image-tests', payload })).statusCode,
    202,
  );
  await until(() => requests === 1, 'running HTTP image test');
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/image-tests', payload })).statusCode,
    202,
  );
  for (const duplicate of [
    { ...payload, apiKey: 'changed-key' },
    { ...payload, settings: { ...payload.settings, modelId: 'different-model' } },
    input(base),
  ])
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/api/image-tests', payload: duplicate }))
        .statusCode,
      409,
    );
  const cancel = await f.app.inject({
    method: 'DELETE',
    url: `/api/image-tests/${payload.requestId}`,
  });
  assert.equal(cancel.json<ImageTestJob>().status, 'cancelled');
  await until(() => disconnected, 'provider request aborted');
  const repeat = await f.app.inject({ method: 'POST', url: '/api/image-tests', payload });
  assert.equal(repeat.statusCode, 200);
  assert.equal(repeat.json<ImageTestJob>().status, 'cancelled');
  const late = input(base);
  assert.equal(
    (
      await f.app.inject({ method: 'DELETE', url: `/api/image-tests/${late.requestId}` })
    ).json<ImageTestJob>().status,
    'cancelled',
  );
  assert.equal(
    (
      await f.app.inject({ method: 'POST', url: '/api/image-tests', payload: late })
    ).json<ImageTestJob>().status,
    'cancelled',
  );
  assert.equal(requests, 1);
  assert.equal(f.runtime.queueState().active, 0);
  await f.restart();
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/image-tests', payload })).statusCode,
    409,
  );
  assert.equal(
    (
      await f.app.inject({ method: 'POST', url: '/api/image-tests', payload: late })
    ).json<ImageTestJob>().status,
    'cancelled',
  );
  assert.equal(requests, 1);
});

test('a hung provider times out once, closes its HTTP request, and does not retain a generation slot', async (t) => {
  let requests = 0;
  let disconnected = false;
  const base = await server(t, async (req, res) => {
    await body(req);
    requests++;
    res.once('close', () => {
      disconnected = true;
    });
  });
  const f = await fixture(t, base, { adapters: { timeoutMs: 1000 } });
  const payload = input(base);
  await f.app.inject({ method: 'POST', url: '/api/image-tests', payload });
  await until(() => requests === 1, 'HTTP request before timeout');
  assert.equal(f.jobs.get(payload.requestId).status, 'generating');
  assert.ok(f.jobs.get(payload.requestId).deadlineAt);
  const job = await finished(f, payload.requestId);
  assert.equal(job.errorCode, 'timeout');
  assert.match(job.error!, /after acquiring a generation slot/);
  await until(() => disconnected, 'timed-out provider request closed');
  assert.equal(f.runtime.queueState().active, 0);
  assert.equal(f.runtime.queueState().waiting, 0);
  await f.app.inject({ method: 'POST', url: '/api/image-tests', payload });
  assert.equal(requests, 1);
});

test('owner-requested image tests and avatars keep direct consent when bot image generation is denied', async (t) => {
  let requests = 0;
  const base = await server(t, (_request, response) => {
    requests++;
    replyImage(response);
  });
  const f = await fixture(t, base);
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    images: { ...f.store.settings().images!, enabled: true, permission: 'deny' },
  });
  const payload = input(base);
  const testResponse = await f.app.inject({ method: 'POST', url: '/api/image-tests', payload });
  assert.equal(testResponse.statusCode, 202, testResponse.body);
  assert.equal((await finished(f, payload.requestId)).status, 'completed');
  const avatarId = randomUUID();
  const avatarResponse = await f.app.inject({
    method: 'POST',
    url: '/api/avatar-generations',
    payload: { requestId: avatarId, prompt: 'An owner-requested avatar fixture.' },
  });
  assert.equal(avatarResponse.statusCode, 202, avatarResponse.body);
  await until(() => f.avatarJobs.get(avatarId).status === 'completed', 'owner avatar completion');
  assert.equal(requests, 2);
  assert.equal(f.store.list('approvals').length, 0);
  assert.equal(f.store.settings().images?.permission, 'deny');
  assert.equal(f.store.settings().permissions.network, 'ask');
});

test('independent image tests share the existing image gate and shutdown interrupts them without replay', async (t) => {
  let requests = 0;
  let disconnected = 0;
  const base = await server(t, async (req, res) => {
    await body(req);
    requests++;
    res.once('close', () => {
      disconnected++;
    });
  });
  const timeoutMs = 1000;
  const f = await fixture(t, base, { adapters: { timeoutMs } });
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    images: { ...f.store.settings().images!, enabled: true, shareInferenceSlot: false },
  });
  const release = await f.runtime.acquireInference!(new AbortController().signal);
  t.after(release);
  const avatarId = randomUUID();
  await f.app.inject({
    method: 'POST',
    url: '/api/avatar-generations',
    payload: { requestId: avatarId, prompt: 'Hold the image generation slot' },
  });
  await until(() => requests === 1, 'avatar using image gate');
  const payload = input(base, { shareInferenceSlot: false });
  await f.app.inject({ method: 'POST', url: '/api/image-tests', payload });
  await delay(timeoutMs + 100);
  assert.equal(f.jobs.get(payload.requestId).status, 'queued');
  assert.equal(f.jobs.get(payload.requestId).deadlineAt, undefined);
  assert.equal(requests, 1, 'waiting for the image queue does not consume the generation budget');
  assert.equal(f.runtime.queueState().active, 1);
  assert.equal(f.runtime.queueState().waiting, 0);
  await f.app.inject({ method: 'DELETE', url: `/api/avatar-generations/${avatarId}` });
  await until(() => requests === 2, 'test gets the same image gate after avatar cancellation');
  assert.equal(
    f.runtime.queueState().active,
    1,
    'independent image work does not take a text slot',
  );
  release();
  await f.restart();
  await until(() => disconnected === 2, 'shutdown aborts image HTTP');
  assert.equal(f.jobs.get(payload.requestId).status, 'interrupted');
  assert.equal(f.jobs.get(payload.requestId).previewAvailable, false);
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/image-tests', payload })).statusCode,
    409,
  );
  const abandoned = input(base);
  const stamp = new Date().toISOString();
  f.store.put<ImageTestJob>('imageTests', {
    id: abandoned.requestId,
    status: 'generating',
    baseUrl: abandoned.settings.baseUrl,
    modelId: abandoned.settings.modelId,
    size: abandoned.settings.size,
    createdAt: stamp,
    updatedAt: stamp,
    previewAvailable: false,
  });
  await f.restart();
  assert.equal(f.jobs.get(abandoned.requestId).status, 'interrupted');
  assert.equal(requests, 2);
});

test('temporary previews expire, are discarded on cancellation and restart, and never create a managed image', async (t) => {
  const base = await server(t, (_req, res) => {
    replyImage(res);
  });
  const f = await fixture(t, base, { adapters: { previewTtlMs: 150 } });
  const expiring = input(base);
  await f.app.inject({ method: 'POST', url: '/api/image-tests', payload: expiring });
  assert.equal((await finished(f, expiring.requestId)).status, 'completed');
  await until(() => !f.jobs.get(expiring.requestId).previewAvailable, 'preview expiration');
  assert.equal(
    (await f.app.inject({ url: `/api/image-tests/${expiring.requestId}/image` })).statusCode,
    410,
  );
  assert.equal(f.jobs.get(expiring.requestId).status, 'completed');
  const cancelled = input(base);
  await f.app.inject({ method: 'POST', url: '/api/image-tests', payload: cancelled });
  await finished(f, cancelled.requestId);
  await f.app.inject({ method: 'DELETE', url: `/api/image-tests/${cancelled.requestId}` });
  assert.equal(
    (await f.app.inject({ url: `/api/image-tests/${cancelled.requestId}/image` })).statusCode,
    410,
  );
  const restarted = input(base);
  await f.app.inject({ method: 'POST', url: '/api/image-tests', payload: restarted });
  await finished(f, restarted.requestId);
  await f.restart();
  assert.equal(f.jobs.get(restarted.requestId).status, 'completed');
  assert.equal(f.jobs.get(restarted.requestId).previewAvailable, false);
  assert.equal(
    (await f.app.inject({ url: `/api/image-tests/${restarted.requestId}/image` })).statusCode,
    410,
  );
  assert.equal(f.store.list('images').length, 0);
});

test('image tests reject invalid input and non-raster provider output without retrying or leaking an entered key', async (t) => {
  let requests = 0;
  const base = await server(t, async (req, res) => {
    await body(req);
    requests++;
    res.end(
      JSON.stringify({ data: [{ b64_json: Buffer.from('<svg></svg>').toString('base64') }] }),
    );
  });
  const f = await fixture(t, base);
  for (const payload of [
    { ...input(base), requestId: 'not-a-uuid' },
    input(base, { modelId: '' }),
    input(base, { baseUrl: 'file:///private/image' }),
    input(base, { size: '10000x10000' }),
    ...[9, 86_401, 10.5, null, '3600'].map((timeoutSeconds) => ({
      ...input(base),
      settings: { ...input(base).settings, timeoutSeconds },
    })),
  ])
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/api/image-tests', payload })).statusCode,
      400,
    );
  assert.equal(requests, 0);
  const payload = { ...input(base), apiKey: 'entered-private-key' };
  await f.app.inject({ method: 'POST', url: '/api/image-tests', payload });
  const job = await finished(f, payload.requestId);
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'generation_failed');
  assert.match(job.error!, /PNG, JPEG, or WebP/);
  await f.app.inject({ method: 'POST', url: '/api/image-tests', payload });
  assert.equal(requests, 1);
  assert.equal(f.store.list('images').length, 0);
  assert.ok(!JSON.stringify(f.store.list('imageTests')).includes('entered-private-key'));
  f.runtime.acquireInference = () =>
    Promise.reject(new Error('entered-private-key saved-image-key private-language-key'));
  const redacted = { ...input(base), apiKey: 'entered-private-key' };
  await f.app.inject({ method: 'POST', url: '/api/image-tests', payload: redacted });
  assert.equal((await finished(f, redacted.requestId)).error, '[redacted] [redacted] [redacted]');
});
