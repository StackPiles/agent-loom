import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { getGlobalDispatcher } from 'undici';
import { createApp } from '../src/server/app.js';
import {
  streamWithModelTimeouts,
  type ModelRequestTimeouts,
} from '../src/server/runtime/model-stream.js';
import type { Room, Task } from '../src/shared/types.js';

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

async function readRequest(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function open(response: ServerResponse) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.flushHeaders();
}

function chunk(response: ServerResponse, delta: object, finish: string | null = null) {
  response.write(
    `data: ${JSON.stringify({
      id: 'timeout-fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'timeout-fixture',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`,
  );
}

function finish(response: ServerResponse, text = 'finished') {
  chunk(response, { content: text });
  chunk(response, {}, 'stop');
  response.end('data: [DONE]\n\n');
}

function model(baseUrl: string): Model<'openai-completions'> {
  return {
    id: 'timeout-fixture',
    name: 'Timeout fixture',
    api: 'openai-completions',
    provider: 'loom-local',
    baseUrl,
    input: ['text'],
    reasoning: false,
    contextWindow: 32_768,
    maxTokens: 2_048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsUsageInStreaming: true, supportsFinishReason: true },
  };
}

function request(
  baseUrl: string,
  timeouts: ModelRequestTimeouts,
  signal = new AbortController().signal,
) {
  const selected = model(baseUrl);
  return streamWithModelTimeouts(selected, timeouts, signal, (options) =>
    stream(
      selected,
      normalizeContext({ messages: [{ role: 'user', content: 'Reply once.', timestamp: 1 }] }),
      { ...options, apiKey: 'local-no-key', headers: { Authorization: null } },
    ),
  );
}

async function until(check: () => boolean, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

test('early headers and role-only chunks keep the response-wait budget until generation starts', async (t) => {
  const globalFetch = globalThis.fetch;
  const globalDispatcher = getGlobalDispatcher();
  let calls = 0;
  const base = await server(t, async (req, res) => {
    await readRequest(req);
    calls++;
    open(res);
    chunk(res, { role: 'assistant', content: '' });
    res.write(': waiting for an inference slot\n\n');
    await delay(650);
    finish(res);
  });
  const response = request(base, { responseTimeoutMs: 2_500, idleTimeoutMs: 250 });
  const result = await response.result();
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.deepEqual(result.content, [{ type: 'text', text: 'finished' }]);
  assert.equal(calls, 1);
  assert.equal(globalThis.fetch, globalFetch);
  assert.equal(getGlobalDispatcher(), globalDispatcher);
});

test('generation can outlast both budgets when real text, reasoning and tool progress keep arriving', async (t) => {
  let calls = 0;
  const base = await server(t, async (req, res) => {
    await readRequest(req);
    calls++;
    open(res);
    chunk(res, { reasoning_content: 'Thinking' });
    await delay(300);
    chunk(res, { reasoning_content: ' carefully' });
    await delay(300);
    chunk(res, { content: 'Working' });
    await delay(300);
    chunk(res, {
      tool_calls: [
        {
          index: 0,
          id: 'call-one',
          type: 'function',
          function: { name: 'inspect', arguments: '' },
        },
      ],
    });
    await delay(300);
    chunk(res, { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] });
    await delay(300);
    chunk(res, {}, 'tool_calls');
    res.end('data: [DONE]\n\n');
  });
  const response = request(base, { responseTimeoutMs: 1_000, idleTimeoutMs: 800 });
  const result = await response.result();
  assert.equal(result.stopReason, 'toolUse', result.errorMessage);
  assert.ok(
    result.content.some(
      (part) => part.type === 'thinking' && part.thinking === 'Thinking carefully',
    ),
  );
  assert.ok(result.content.some((part) => part.type === 'text' && part.text === 'Working'));
  assert.ok(result.content.some((part) => part.type === 'toolCall' && part.name === 'inspect'));
  assert.equal(calls, 1);
});

for (const headers of [false, true]) {
  test(`response timeout closes a silent server ${headers ? 'after early headers/heartbeats' : 'before headers'} without reposting`, async (t) => {
    let calls = 0;
    let closed = false;
    const base = await server(t, async (req, res) => {
      await readRequest(req);
      calls++;
      res.once('close', () => {
        closed = true;
      });
      if (headers) {
        open(res);
        chunk(res, { role: 'assistant', content: '' });
        const heartbeat = setInterval(() => res.write(': still queued\n\n'), 30);
        res.once('close', () => clearInterval(heartbeat));
      }
    });
    const response = request(base, { responseTimeoutMs: 1_500, idleTimeoutMs: 150 });
    const events: AssistantMessageEvent[] = [];
    for await (const event of response) events.push(event);
    const result = await response.result();
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage!, /did not begin responding/);
    assert.match(result.errorMessage!, /not retried automatically/);
    assert.equal(
      events.filter((event) => event.type === 'error' || event.type === 'done').length,
      1,
    );
    assert.equal(calls, 1);
    await until(() => closed, 'timed-out transport closed');
  });
}

test('an idle timeout preserves streamed content and usage and ignores heartbeat traffic', async (t) => {
  let calls = 0;
  let closed = false;
  const base = await server(t, async (req, res) => {
    await readRequest(req);
    calls++;
    open(res);
    chunk(res, { content: 'Keep this partial answer.' });
    res.write(
      `data: ${JSON.stringify({ id: 'timeout-fixture', choices: [], usage: { prompt_tokens: 23, completion_tokens: 7, total_tokens: 30 } })}\n\n`,
    );
    const heartbeat = setInterval(() => res.write(': alive but no model progress\n\n'), 30);
    res.once('close', () => {
      clearInterval(heartbeat);
      closed = true;
    });
  });
  const response = request(base, { responseTimeoutMs: 2_000, idleTimeoutMs: 300 });
  const result = await response.result();
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage!, /stopped producing output/);
  assert.deepEqual(result.content, [{ type: 'text', text: 'Keep this partial answer.' }]);
  assert.equal(result.usage.input, 23);
  assert.equal(result.usage.output, 7);
  assert.equal(calls, 1);
  await until(() => closed, 'stalled transport closed');
});

test('caller cancellation closes a request waiting for its first token and remains cancellation', async (t) => {
  let calls = 0;
  let closed = false;
  const base = await server(t, async (req, res) => {
    await readRequest(req);
    calls++;
    open(res);
    res.once('close', () => {
      closed = true;
    });
  });
  const cancel = new AbortController();
  const response = request(base, { responseTimeoutMs: 2_000, idleTimeoutMs: 200 }, cancel.signal);
  await until(() => calls === 1, 'request accepted');
  cancel.abort();
  const result = await response.result();
  assert.equal(result.stopReason, 'aborted');
  assert.doesNotMatch(result.errorMessage!, /did not begin responding|stopped producing output/);
  assert.equal(calls, 1);
  await until(() => closed, 'cancelled transport closed');
});

test('late provider events cannot extend a timed-out answer or persist incomplete parsing buffers', async () => {
  const selected = model('http://127.0.0.1/unused');
  const partial: AssistantMessage = {
    role: 'assistant',
    api: selected.api,
    model: selected.id,
    provider: selected.provider,
    stopReason: 'pending',
    timestamp: Date.now(),
    content: [{ type: 'text', text: 'Before timeout.' }],
    usage: {
      input: 9,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  Object.assign(partial.content[0], {
    index: 0,
    partialArgs: 'incomplete',
    customInput: {},
    streamIndex: 0,
  });
  let providerFinished: Promise<void> | undefined;
  let abortedBeforeLateEvents = false;
  const response = streamWithModelTimeouts(
    selected,
    { responseTimeoutMs: 1_000, idleTimeoutMs: 40 },
    new AbortController().signal,
    ({ signal }) => {
      const provider = createAssistantMessageEventStream();
      provider.push({ type: 'text_delta', contentIndex: 0, delta: 'Before timeout.', partial });
      providerFinished = (async () => {
        // A ref'ed timer keeps this deterministic fake transport alive while
        // the request clock aborts it. No network endpoint is contacted.
        await delay(100);
        abortedBeforeLateEvents = signal.aborted;
        const text = partial.content[0];
        assert.equal(text.type, 'text');
        text.text += ' Late content.';
        partial.usage.output = 99;
        provider.push({ type: 'text_delta', contentIndex: 0, delta: ' Late content.', partial });
        partial.stopReason = 'stop';
        provider.push({ type: 'done', reason: 'stop', message: partial });
        provider.end(partial);
      })();
      return provider;
    },
  );
  const emitted: string[] = [];
  for await (const event of response) if (event.type === 'text_delta') emitted.push(event.delta);
  const result = await response.result();
  await providerFinished;
  assert.ok(abortedBeforeLateEvents);
  assert.equal(result.stopReason, 'error');
  assert.deepEqual(emitted, ['Before timeout.']);
  assert.deepEqual(result.content, [{ type: 'text', text: 'Before timeout.' }]);
  assert.equal(result.usage.output, 3);
});

async function appFixture(t: TestContext, baseUrl: string) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-model-timeouts-'));
  const f = await createApp({ dataDir: directory, scheduler: false });
  t.after(async () => {
    await f.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const settings = f.store.settings();
  // Short fixture-only values exercise the real pipeline quickly. Public
  // settings validation independently requires whole seconds from 10 onward.
  f.store.put('settings', {
    ...settings,
    id: 'main',
    autoLearn: false,
    inference: { maxConcurrentRequests: 1 },
    model: {
      ...settings.model,
      baseUrl,
      modelId: 'timeout-fixture',
      responseTimeoutSeconds: 1,
      idleTimeoutSeconds: 0.3,
    },
  });
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/rooms',
    payload: {
      name: 'Timeout regression',
      botIds: ['bot_aster', 'bot_nova'],
      parallelResponses: true,
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  return { ...f, room: created.json<Room>() };
}

test('real Pi local queue waits use no response budget and cancelled waiters never post to the model', async (t) => {
  let calls = 0;
  const base = await server(t, async (req, res) => {
    await readRequest(req);
    calls++;
    open(res);
    finish(res);
  });
  const f = await appFixture(t, base);
  const release = await f.runtime.acquireInference!(new AbortController().signal);
  t.after(release);
  const waiting = f.controller.enqueueTask({
    roomId: f.room.id,
    botId: 'bot_aster',
    prompt: 'Wait for capacity.',
  });
  const cancelled = f.controller.enqueueTask({
    roomId: f.room.id,
    botId: 'bot_nova',
    prompt: 'Cancel before posting.',
  });
  await until(() => f.runtime.queueState().waiting === 2, 'both Pi requests queued');
  await delay(1_200);
  assert.equal(f.store.get<Task>('tasks', waiting.id)!.status, 'waiting_model');
  assert.equal(calls, 0);
  await f.runtime.stop(cancelled.id);
  assert.equal(f.store.get<Task>('tasks', cancelled.id)!.status, 'stopped');
  assert.equal(calls, 0);
  release();
  await until(
    () => f.store.get<Task>('tasks', waiting.id)!.status === 'completed',
    'waiting task completed',
  );
  assert.equal(calls, 1);
  assert.equal(f.runtime.queueState().active, 0);
  assert.equal(f.runtime.queueState().waiting, 0);
});

test('real Pi marks a stalled request failed, preserves its output, and releases capacity to the next bot', async (t) => {
  let calls = 0;
  let stalledClosed = false;
  const base = await server(t, async (req, res) => {
    await readRequest(req);
    calls++;
    open(res);
    if (calls === 1) {
      chunk(res, { content: 'Preserved partial.' });
      res.once('close', () => {
        stalledClosed = true;
      });
    } else finish(res, 'Next bot finished.');
  });
  const f = await appFixture(t, base);
  const stalled = f.controller.enqueueTask({
    roomId: f.room.id,
    botId: 'bot_aster',
    prompt: 'Stall after a partial answer.',
  });
  await until(() => calls === 1, 'first request accepted');
  const next = f.controller.enqueueTask({
    roomId: f.room.id,
    botId: 'bot_nova',
    prompt: 'Answer after the first slot is released.',
  });
  await until(
    () => f.store.get<Task>('tasks', next.id)!.status === 'completed',
    'following bot completed',
  );
  const failed = f.store.get<Task>('tasks', stalled.id)!;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /stopped producing output/);
  assert.equal(failed.output, 'Preserved partial.');
  assert.equal(calls, 2);
  assert.equal(f.runtime.queueState().active, 0);
  await until(() => stalledClosed, 'stalled connection closed');
});
