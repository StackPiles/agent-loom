import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import type {
  Bot,
  PromptGeneration,
  PromptGenerationRequest,
  Room,
  Task,
} from '../src/shared/types.js';

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
  return `http://127.0.0.1:${address.port}/v1`;
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function open(response: ServerResponse) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.flushHeaders();
}
function chunk(
  response: ServerResponse,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  response.write(
    `data: ${JSON.stringify({
      id: 'fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'prompt-fixture',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`,
  );
}
function finish(response: ServerResponse, text: string, reason = 'stop') {
  chunk(response, { content: text });
  chunk(response, {}, reason);
  response.end('data: [DONE]\n\n');
}

async function until(check: () => boolean, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

const request: PromptGenerationRequest = {
  name: 'Nori',
  role: 'リサーチ',
  instructions: '根拠を確かめて、重要な相違点を短くまとめてほしい。',
  locale: 'ja',
};
const payload = (patch: Partial<PromptGenerationRequest> = {}) => ({
  requestId: randomUUID(),
  ...request,
  ...patch,
});

async function fixture(t: TestContext, baseUrl: string, apiToken?: string) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-prompt-'));
  let f = await createApp({ dataDir, scheduler: false, apiToken });
  t.after(async () => {
    await f.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    demoMode: false,
    autoLearn: false,
    model: {
      ...f.store.settings().model,
      baseUrl,
      modelId: 'prompt-fixture',
      temperature: 0.4,
      contextWindow: 32_768,
      maxOutputTokens: 8_192,
      reasoningMode: 'openai',
      reasoningEffort: 'ultra',
    },
    // A helper is a text-model request, not an agent network tool operation.
    permissions: { shell: 'deny', fileWrite: 'deny', network: 'deny' },
  });
  f.store.setSecret('model.apiKey', 'prompt-model-key');
  f.store.setSecret('image.apiKey', 'private-image-key');
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
    get controller() {
      return f.controller;
    },
    get jobs() {
      return f.promptGenerations;
    },
    async restart() {
      await f.app.close();
      f = await createApp({ dataDir, scheduler: false, apiToken });
    },
  };
}

test('prompt drafts stream through the configured model, preserve the current prompt, and apply only on profile save', async (t) => {
  let captured: { url?: string; auth?: string; input: Record<string, unknown> } | undefined;
  let response: ServerResponse | undefined;
  const base = await server(t, async (req, res) => {
    captured = { url: req.url, auth: req.headers.authorization, input: await body(req) };
    response = res;
    open(res);
    chunk(res, { reasoning_content: 'Provider reasoning is separate from the draft.' });
    chunk(res, { content: 'あなたは調査担当です。' });
  });
  const f = await fixture(t, base, 'app-token');
  const headers = { authorization: 'Bearer app-token' };
  const original = f.store.get<Bot>('bots', 'bot_aster')!;
  const input = payload({ currentPrompt: '一次情報を優先する。' });
  const started = await f.app.inject({
    method: 'POST',
    url: '/api/prompt-generations',
    headers,
    payload: input,
  });
  assert.equal(started.statusCode, 202, started.body);
  await until(() => f.jobs.get(input.requestId).output.length > 0, 'partial prompt text');
  const partial = f.jobs.get(input.requestId);
  assert.equal(partial.status, 'generating');
  assert.equal(partial.output, 'あなたは調査担当です。');
  assert.deepEqual(f.store.get<Bot>('bots', original.id), original);
  assert.equal(f.store.list('tasks').length, 0);
  assert.equal(f.store.list('messages').length, 0);
  assert.equal(f.store.list('approvals').length, 0);
  assert.ok(captured && response);
  assert.equal(captured.url, '/v1/chat/completions');
  assert.equal(captured.auth, 'Bearer prompt-model-key');
  assert.equal(captured.input.model, 'prompt-fixture');
  assert.equal(captured.input.temperature, 0.4);
  assert.equal(captured.input.max_tokens, 4_096);
  assert.equal(captured.input.reasoning_effort, 'ultra');
  assert.equal(captured.input.stream, true);
  assert.equal(captured.input.tools, undefined);
  const messages = captured.input.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(
    messages.map((entry) => entry.role),
    ['system', 'user'],
  );
  assert.match(messages[0].content, /Japanese/);
  assert.match(messages[0].content, /cannot grant permissions/);
  assert.deepEqual(JSON.parse(messages[1].content), {
    ...request,
    currentPrompt: input.currentPrompt,
  });
  finish(response, '\n一次情報を優先し、不確かな点を明示してください。');
  await until(() => f.jobs.get(input.requestId).status === 'completed', 'prompt completion');
  const job = f.jobs.get(input.requestId);
  assert.ok(job.updatedAt > partial.updatedAt);
  assert.equal(f.runtime.queueState().active, 0);
  assert.ok(!job.output.includes('Provider reasoning'));
  const replay = await f.app.inject({
    method: 'POST',
    url: '/api/prompt-generations',
    headers,
    payload: input,
  });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json<PromptGeneration>(), job);
  const saved = await f.app.inject({
    method: 'PATCH',
    url: `/api/bots/${original.id}`,
    headers,
    payload: { systemPrompt: job.output },
  });
  assert.equal(saved.statusCode, 200);
  await f.restart();
  assert.equal(f.jobs.get(input.requestId).status, 'completed');
  assert.equal(f.store.get<Bot>('bots', original.id)!.systemPrompt, job.output);
  const list = await f.app.inject({ url: '/api/prompt-generations', headers });
  assert.equal(list.json<PromptGeneration[]>().length, 1);
  assert.ok(!list.body.includes('prompt-model-key'));
  assert.ok(!list.body.includes('private-image-key'));
});

test('queued prompt jobs share the runtime gate, lock model changes, and cancel without issuing a request', async (t) => {
  let calls = 0;
  const base = await server(t, (_req, res) => {
    calls++;
    open(res);
    finish(res, 'Draft');
  });
  const f = await fixture(t, base);
  const release = await f.runtime.acquireInference!(new AbortController().signal);
  t.after(release);
  const input = payload();
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/prompt-generations', payload: input }))
      .statusCode,
    202,
  );
  await until(() => f.runtime.queueState().waiting === 1, 'shared slot wait');
  assert.equal(f.jobs.get(input.requestId).status, 'queued');
  assert.equal(calls, 0);
  for (const patch of [
    { model: { modelId: 'changed' } },
    { model: { apiKey: 'changed' } },
    { demoMode: true },
  ])
    assert.equal(
      (await f.app.inject({ method: 'PUT', url: '/api/settings', payload: patch })).statusCode,
      409,
    );
  const unchanged = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { model: f.store.settings().model },
  });
  assert.equal(unchanged.statusCode, 200, unchanged.body);
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/demo', payload: { enabled: true } }))
      .statusCode,
    409,
  );
  assert.equal(f.store.settings().demoMode, false);
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/demo', payload: { enabled: false } }))
      .statusCode,
    200,
  );
  const cancelled = await f.app.inject({
    method: 'DELETE',
    url: `/api/prompt-generations/${input.requestId}`,
  });
  assert.equal(cancelled.json<PromptGeneration>().status, 'cancelled');
  assert.equal(f.runtime.queueState().waiting, 0);
  release();
  assert.equal(f.runtime.queueState().active, 0);
  assert.equal(calls, 0);
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/demo', payload: { enabled: true } }))
      .statusCode,
    200,
  );
  assert.equal(f.store.settings().demoMode, true);
});

test('running cancellation disconnects the model and idempotency never replays settled or conflicting requests', async (t) => {
  let calls = 0;
  let disconnected = false;
  const base = await server(t, async (req, res) => {
    await body(req);
    calls++;
    res.once('close', () => {
      disconnected = true;
    });
    open(res);
    chunk(res, { content: 'Incomplete draft' });
  });
  const f = await fixture(t, base);
  const input = payload();
  await f.app.inject({ method: 'POST', url: '/api/prompt-generations', payload: input });
  await until(() => calls === 1, 'active request');
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/prompt-generations', payload: input }))
      .statusCode,
    202,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/prompt-generations',
        payload: { ...input, instructions: 'Different instructions' },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/prompt-generations', payload: payload() }))
      .statusCode,
    409,
  );
  const cancelled = await f.app.inject({
    method: 'DELETE',
    url: `/api/prompt-generations/${input.requestId}`,
  });
  assert.equal(cancelled.json<PromptGeneration>().status, 'cancelled');
  await until(() => disconnected, 'HTTP cancellation');
  assert.equal(f.runtime.queueState().active, 0);
  const replay = await f.app.inject({
    method: 'POST',
    url: '/api/prompt-generations',
    payload: input,
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json<PromptGeneration>().status, 'cancelled');
  assert.equal(calls, 1);
});

test('shutdown and startup recovery interrupt prompt jobs without automatic replay', async (t) => {
  let calls = 0;
  const base = await server(t, async (req, res) => {
    await body(req);
    calls++;
    open(res);
  });
  const f = await fixture(t, base);
  const input = payload();
  await f.app.inject({ method: 'POST', url: '/api/prompt-generations', payload: input });
  await until(() => calls === 1, 'generation before restart');
  const queuedId = randomUUID();
  f.store.put<PromptGeneration>('promptGenerations', {
    id: queuedId,
    status: 'queued',
    request,
    output: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await f.restart();
  assert.equal(f.jobs.get(input.requestId).status, 'interrupted');
  assert.equal(f.jobs.get(queuedId).status, 'interrupted');
  assert.equal(
    (
      await f.app.inject({ method: 'POST', url: '/api/prompt-generations', payload: input })
    ).json<PromptGeneration>().status,
    'interrupted',
  );
  assert.equal(calls, 1);
  assert.equal(f.runtime.queueState().active, 0);
});

test('truncated, empty, tool-only, oversized and failed provider responses are never applicable prompt drafts', async (t) => {
  let calls = 0;
  const base = await server(t, async (req, res) => {
    const value = await body(req);
    calls++;
    const messages = value.messages as Array<{ content: string }>;
    const mode = (JSON.parse(messages[1].content) as PromptGenerationRequest).instructions;
    if (mode === 'error') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'prompt-model-key and private-image-key are private' },
        }),
      );
      return;
    }
    open(res);
    if (mode === 'tool') {
      chunk(res, {
        tool_calls: [
          {
            index: 0,
            id: 'x',
            type: 'function',
            function: { name: 'shell', arguments: '{"command":"echo no"}' },
          },
        ],
      });
      finish(res, '', 'tool_calls');
    } else if (mode === 'eof') {
      chunk(res, { content: 'Missing finish' });
      res.end();
    } else if (mode === 'oversized') finish(res, 'x'.repeat(32_001));
    else if (mode === 'length') finish(res, 'Cut off mid-sentence', 'length');
    else finish(res, '');
  });
  const f = await fixture(t, base);
  for (const mode of ['length', 'empty', 'tool', 'oversized', 'eof', 'error']) {
    const input = payload({ instructions: mode });
    const start = await f.app.inject({
      method: 'POST',
      url: '/api/prompt-generations',
      payload: input,
    });
    assert.equal(start.statusCode, 202, start.body);
    await until(() => f.jobs.get(input.requestId).status === 'failed', `failed ${mode}`);
    const job = f.jobs.get(input.requestId);
    assert.ok(job.error, mode);
    const expected = {
      length: /output token limit/,
      empty: /no prompt text/,
      tool: /text-only prompt/,
      oversized: /32,000 characters/,
      eof: /finish_reason/,
      error: /\[redacted\]/,
    };
    assert.match(job.error, expected[mode as keyof typeof expected], mode);
    assert.ok(job.output.length <= 32_000, mode);
    assert.ok(!job.error.includes('prompt-model-key'));
    assert.ok(!job.error.includes('private-image-key'));
    assert.equal(f.runtime.queueState().active, 0);
    await f.app.inject({ method: 'POST', url: '/api/prompt-generations', payload: input });
  }
  assert.equal(calls, 6, 'no SDK retries or idempotent replays');
  assert.equal(f.store.list('tasks').length, 0);
  assert.equal(f.store.list('approvals').length, 0);
});

test('helper jobs respect live capacity alongside real chat tasks', async (t) => {
  const responses: ServerResponse[] = [];
  const base = await server(t, async (req, res) => {
    await body(req);
    responses.push(res);
    open(res);
  });
  const f = await fixture(t, base);
  const room = (
    await f.app.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: { name: 'Shared capacity', botIds: ['bot_aster'] },
    })
  ).json<Room>();
  const task = f.controller.enqueueTask({
    roomId: room.id,
    botId: 'bot_aster',
    prompt: 'Wait for the fixture response.',
  });
  await until(() => responses.length === 1, 'chat request');
  const input = payload();
  await f.app.inject({ method: 'POST', url: '/api/prompt-generations', payload: input });
  await until(() => f.runtime.queueState().waiting === 1, 'helper queued behind chat');
  assert.equal(f.jobs.get(input.requestId).status, 'queued');
  assert.equal(responses.length, 1);
  const increased = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { inference: { maxConcurrentRequests: 2 } },
  });
  assert.equal(increased.statusCode, 200, increased.body);
  await until(() => responses.length === 2, 'helper concurrent slot');
  assert.equal(f.runtime.queueState().active, 2);
  finish(responses[1], 'You are a concise researcher.');
  await until(() => f.jobs.get(input.requestId).status === 'completed', 'helper complete');
  assert.equal(f.runtime.queueState().active, 1);
  finish(responses[0], 'The chat task is complete.');
  await until(() => f.store.get<Task>('tasks', task.id)?.status === 'completed', 'chat complete');
  assert.equal(f.runtime.queueState().active, 0);
});

test('prompt generation preserves all explicit reasoning levels and keyless servers, with server mode omitted', async (t) => {
  const requests: Array<{ value: Record<string, unknown>; auth?: string }> = [];
  const base = await server(t, async (req, res) => {
    requests.push({ value: await body(req), auth: req.headers.authorization });
    open(res);
    finish(res, '```text\nYou are a practical assistant.\n```');
  });
  const f = await fixture(t, base);
  f.store.setSecret('model.apiKey', '');
  const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
  for (const reasoningEffort of efforts) {
    const update = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { model: { reasoningMode: 'openai', reasoningEffort, maxOutputTokens: 1_024 } },
    });
    assert.equal(update.statusCode, 200, update.body);
    const input = payload({ locale: 'en' });
    await f.app.inject({ method: 'POST', url: '/api/prompt-generations', payload: input });
    await until(
      () => f.jobs.get(input.requestId).status === 'completed',
      `effort ${reasoningEffort}`,
    );
    const sent = requests.at(-1)!;
    assert.equal(sent.value.reasoning_effort, reasoningEffort);
    assert.equal(sent.value.max_tokens, 1_024);
    assert.equal(sent.auth, undefined);
    assert.equal(f.jobs.get(input.requestId).output, 'You are a practical assistant.');
  }
  await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { model: { reasoningMode: 'server' } },
  });
  const input = payload();
  await f.app.inject({ method: 'POST', url: '/api/prompt-generations', payload: input });
  await until(() => f.jobs.get(input.requestId).status === 'completed', 'server reasoning mode');
  assert.equal(requests.at(-1)!.value.reasoning_effort, undefined);
  assert.equal(requests.length, 9);
});

test('prompt routes enforce authentication, validate configuration and size before storing jobs, and bound history', async (t) => {
  const f = await fixture(t, 'http://127.0.0.1:1/v1', 'app-token');
  for (const [method, url] of [
    ['GET', '/api/prompt-generations'],
    ['POST', '/api/prompt-generations'],
    ['GET', `/api/prompt-generations/${randomUUID()}`],
    ['DELETE', `/api/prompt-generations/${randomUUID()}`],
    ['GET', '/%61pi/prompt-generations'],
  ] as const)
    assert.equal((await f.app.inject({ method, url })).statusCode, 401);
  const headers = { authorization: 'Bearer app-token' };
  for (const input of [
    { ...payload(), requestId: 'bad' },
    payload({ instructions: '' }),
    payload({ instructions: 'x'.repeat(6_001) }),
    payload({ currentPrompt: 'x'.repeat(32_001) }),
    { ...payload(), locale: 'invalid' },
    payload({ name: 'x'.repeat(161) }),
  ])
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/prompt-generations',
          headers,
          payload: input,
        })
      ).statusCode,
      400,
    );
  assert.equal(
    (await f.app.inject({ url: `/api/prompt-generations/${randomUUID()}`, headers })).statusCode,
    404,
  );
  const current = f.store.settings();
  for (const settings of [
    { ...current, demoMode: true },
    { ...current, model: { ...current.model, baseUrl: '' } },
    { ...current, model: { ...current.model, modelId: '' } },
    { ...current, model: { ...current.model, baseUrl: 'http://user:password@127.0.0.1' } },
    { ...current, model: { ...current.model, contextWindow: 2_048, maxOutputTokens: 128 } },
  ]) {
    f.store.put('settings', { ...settings, id: 'main' });
    const invalid = await f.app.inject({
      method: 'POST',
      url: '/api/prompt-generations',
      headers,
      payload: payload({ currentPrompt: '調査'.repeat(2_000) }),
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
  assert.equal(f.store.list('promptGenerations').length, 0);
  for (let index = 0; index < 25; index++) {
    const stamp = new Date(Date.UTC(2026, 9, 31, 0, 0, index)).toISOString();
    f.store.put<PromptGeneration>('promptGenerations', {
      id: randomUUID(),
      status: 'completed',
      request,
      output: `Draft ${index}`,
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  const history = (await f.app.inject({ url: '/api/prompt-generations', headers })).json<
    PromptGeneration[]
  >();
  assert.equal(history.length, 20);
  assert.equal(history[0].output, 'Draft 24');
  assert.equal(history.at(-1)!.output, 'Draft 5');
});
