import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import type { OperationRecord } from '../src/server/runtime/contract.js';
import type { Message, Task, TaskInput, TaskInputResult } from '../src/shared/types.js';

const CONTEXT_WINDOW = 262_144;
const FINISHED = new Set(['completed', 'failed', 'cancelled']);

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

interface ModelPayload {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  max_tokens: number;
}

interface ModelRequest {
  payload: ModelPayload;
  response: ServerResponse;
  partial(text: string): void;
  complete(text?: string): void;
  tool(name: string, args: Record<string, unknown>): void;
  reject(status: number, body: unknown, holdBody?: boolean): () => void;
}

/** A server admission oracle, independent of Pi's character-count estimate. */
function overflowBody(request: ModelRequest, inputTokens: number, lowerBound = false) {
  const reported = lowerBound ? CONTEXT_WINDOW - request.payload.max_tokens + 1 : inputTokens;
  const qualifier = lowerBound ? 'at least ' : '';
  return {
    message:
      `This model's maximum context length is ${CONTEXT_WINDOW} tokens. However, you requested ` +
      `${request.payload.max_tokens} output tokens and your prompt contains ${qualifier}${reported} input tokens, ` +
      `for a total of ${qualifier}${reported + request.payload.max_tokens} tokens. ` +
      'Please reduce the length of the input prompt or the number of requested output tokens. ' +
      `(parameter=input_tokens, value=${reported})`,
    type: 'BadRequestError',
    param: 'input_tokens',
    code: 400,
  };
}

/** Real app, Pi and HTTP/SSE; only the local model server is a deterministic fixture. */
async function fixture(t: TestContext, maxOutputTokens = 131_072, contextWindow = CONTEXT_WINDOW) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-context-recovery-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const requests: ModelRequest[] = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelPayload;
    assert.ok(Number.isInteger(payload.max_tokens) && payload.max_tokens > 0);
    const index = requests.length;
    const send = (delta: object, finishReason: string | null = null) => {
      if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ id: `context-${index}`, object: 'chat.completion.chunk', created: 1, model: 'context-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      );
    };
    const finish = (reason: string) => {
      send({}, reason);
      response.end('data: [DONE]\n\n');
    };
    requests.push({
      payload,
      response,
      partial(text) {
        send({ role: 'assistant', content: text });
      },
      complete(text = 'Completed after checking the current instructions.') {
        send({ content: text });
        finish('stop');
      },
      tool(name, args) {
        send({
          tool_calls: [
            {
              index: 0,
              id: `call_context_${index}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
        finish('tool_calls');
      },
      reject(status, body, holdBody = false) {
        assert.equal(response.headersSent, false);
        response.writeHead(status, { 'content-type': 'application/json' });
        const json = JSON.stringify(body);
        if (holdBody) response.write(json.slice(0, Math.floor(json.length / 2)));
        const end = () => response.end(holdBody ? json.slice(Math.floor(json.length / 2)) : json);
        if (!holdBody) end();
        return end;
      },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const instance = await createApp({ dataDir: join(directory, 'data'), scheduler: false });
  t.after(async () => {
    await instance.app.close();
    for (const request of requests) request.response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const settings = instance.store.settings();
  instance.store.put('settings', {
    ...settings,
    id: 'main',
    demoMode: false,
    autoLearn: false,
    workspacePath: workspace,
    inference: { maxConcurrentRequests: 1 },
    permissions: { ...settings.permissions, fileWrite: 'allow', shell: 'allow' },
    model: {
      ...settings.model,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: 'context-fixture',
      contextWindow,
      maxOutputTokens,
      responseTimeoutSeconds: 15,
      idleTimeoutSeconds: 15,
    },
  });
  const current = (task: Task) => instance.store.get<Task>('tasks', task.id)!;
  return {
    ...instance,
    workspace,
    requests,
    current,
    start() {
      return instance.controller.enqueueTask({
        roomId: 'room_lounge',
        botId: 'bot_aster',
        prompt: 'Complete the context recovery fixture using the current owner instructions.',
      });
    },
    async request(task: Task, index: number) {
      await until(
        () => requests.length > index || FINISHED.has(current(task).status),
        `model request ${index + 1}`,
      );
      assert.ok(requests[index], `Missing request ${index + 1}: ${current(task).error ?? ''}`);
      return requests[index];
    },
    async finished(task: Task) {
      await until(() => FINISHED.has(current(task).status), 'task completion');
      return current(task);
    },
    inputState(input: TaskInput) {
      return instance.controller
        .getSnapshot()
        .taskInputs!.find((candidate) => candidate.id === input.id)!;
    },
    async input(task: Task, body: string) {
      const response = await instance.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/inputs`,
        payload: { requestId: randomUUID(), body, mode: 'boundary' },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<TaskInputResult>().input;
    },
  };
}

for (const [inputTokens, maxOutputTokens] of [
  [131_202, 130_975],
  [134_896, 131_072],
  [143_806, 131_072],
]) {
  test(`real Pi corrects a context 400 for ${inputTokens} input and ${maxOutputTokens} requested output`, async (t) => {
    const f = await fixture(t, maxOutputTokens);
    const task = f.start();
    const first = await f.request(task, 0);
    assert.equal(first.payload.max_tokens, maxOutputTokens);
    assert.ok(inputTokens + first.payload.max_tokens > CONTEXT_WINDOW);
    first.reject(400, overflowBody(first, inputTokens));

    const corrected = await f.request(task, 1);
    assert.deepEqual(corrected.payload.messages, first.payload.messages);
    assert.ok(corrected.payload.max_tokens < first.payload.max_tokens);
    assert.ok(inputTokens + corrected.payload.max_tokens <= CONTEXT_WINDOW - 4_096);
    corrected.complete();
    const completed = await f.finished(task);
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(f.requests.length, 2, 'one rejected model request gets one corrective attempt');
    assert.equal(f.store.settings().model.maxOutputTokens, maxOutputTokens);
    assert.equal(completed.inputTokens, 0, 'admission diagnostics are not provider usage');
  });
}

test('a lower-bound context 400 does not treat 131073 as the full prompt size', async (t) => {
  const f = await fixture(t);
  const task = f.start();
  const first = await f.request(task, 0);
  const actualInput = 143_806;
  const body = overflowBody(first, actualInput, true);
  assert.match(body.message, /at least 131073 input tokens/);
  first.reject(400, body);
  const corrected = await f.request(task, 1);
  assert.deepEqual(corrected.payload.messages, first.payload.messages);
  assert.ok(
    actualInput + corrected.payload.max_tokens <= CONTEXT_WINDOW - 4_096,
    'the uncounted part of the input must fit too',
  );
  corrected.complete();
  const completed = await f.finished(task);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(f.requests.length, 2);
});

for (const [status, message] of [
  [400, 'The temperature parameter is invalid.'],
  [429, 'Too many requests: tokens per minute rate limit.'],
  [503, 'The model service is temporarily unavailable.'],
] as const) {
  test(`a non-context HTTP ${status} does not receive a corrective model retry`, async (t) => {
    const f = await fixture(t);
    const task = f.start();
    const request = await f.request(task, 0);
    request.reject(status, { error: { message, code: 'fixture_error' } });
    const failed = await f.finished(task);
    assert.equal(failed.status, 'failed');
    assert.equal(f.requests.length, 1);
  });
}

test('a failed stream with partial output is preserved and is not replayed', async (t) => {
  const f = await fixture(t);
  const task = f.start();
  const request = await f.request(task, 0);
  const partial = 'Partial work must stay visible after the connection fails.';
  request.partial(partial);
  await until(
    () =>
      f.store
        .list<Message>('messages')
        .some((message) => message.taskId === task.id && message.body.includes(partial)),
    'partial response persisted',
  );
  request.response.destroy();
  const failed = await f.finished(task);
  assert.equal(failed.status, 'failed');
  assert.equal(f.requests.length, 1);
  assert.ok(
    f.store
      .list<Message>('messages')
      .some((message) => message.taskId === task.id && message.body.includes(partial)),
  );
});

test('correcting a post-tool context 400 preserves the tool result and executes the effect once', async (t) => {
  const f = await fixture(t);
  const task = f.start();
  const first = await f.request(task, 0);
  first.tool('run_command', {
    command: `node -e "require('node:fs').appendFileSync('effect-count.txt', 'effect\\n')"`,
  });
  const afterTool = await f.request(task, 1);
  assert.ok(afterTool.payload.messages.some((message) => message.role === 'tool'));
  assert.equal(await readFile(join(f.workspace, 'effect-count.txt'), 'utf8'), 'effect\n');
  afterTool.reject(400, overflowBody(afterTool, 134_896));
  const corrected = await f.request(task, 2);
  assert.deepEqual(corrected.payload.messages, afterTool.payload.messages);
  corrected.complete();
  const completed = await f.finished(task);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(f.requests.length, 3);
  assert.equal(await readFile(join(f.workspace, 'effect-count.txt'), 'utf8'), 'effect\n');
  const operations = f.store
    .list<OperationRecord>('operations')
    .filter((operation) => operation.taskId === task.id && operation.toolName === 'run_command');
  assert.equal(operations.length, 1);
  assert.equal(operations[0].status, 'completed');
});

test('an owner instruction arriving during a context 400 replaces the stale retry and stays pending until accepted', async (t) => {
  const f = await fixture(t);
  const task = f.start();
  const first = await f.request(task, 0);
  const finishError = first.reject(400, overflowBody(first, 143_806, true), true);
  const instruction = 'RECOVERY_OWNER_INSTRUCTION_52791: preserve this new requirement.';
  const input = await f.input(task, instruction);
  assert.equal(f.inputState(input).status, 'pending');
  finishError();

  const current = await f.request(task, 1);
  const serialized = JSON.stringify(current.payload.messages);
  assert.ok(
    serialized.includes(instruction),
    'never resend the old transcript after the new instruction',
  );
  assert.equal(serialized.split(instruction).length - 1, 1, 'inject the instruction exactly once');
  assert.equal(f.inputState(input).status, 'pending', 'sending is not an accepted model response');
  current.reject(400, overflowBody(current, 143_806, true));
  const corrected = await f.request(task, 2);
  assert.deepEqual(corrected.payload.messages, current.payload.messages);
  assert.ok(corrected.payload.max_tokens < current.payload.max_tokens);
  assert.equal(
    f.inputState(input).status,
    'pending',
    'the new instruction survives its own rejected request',
  );
  corrected.tool('list_automations', {});
  const continued = await f.request(task, 3);
  assert.equal(f.inputState(input).status, 'delivered');
  assert.equal(JSON.stringify(continued.payload.messages).split(instruction).length - 1, 1);
  continued.complete();
  const completed = await f.finished(task);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(f.requests.length, 4, 'a withdrawn correction does not consume the one sent retry');
});

test('a large output ceiling near the context limit still admits a short task with a smaller wire budget', async (t) => {
  const f = await fixture(t, 64_000, 65_536);
  const saved = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { model: { contextWindow: 65_536, maxOutputTokens: 64_000 } },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const task = f.start();
  const request = await f.request(task, 0);
  assert.ok(request.payload.max_tokens > 0);
  assert.ok(request.payload.max_tokens < 64_000, 'reserve space for the actual request input');
  request.complete('A short task still runs with the requested ceiling as an upper bound.');
  const completed = await f.finished(task);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(f.requests.length, 1);
  assert.equal(f.store.settings().model.contextWindow, 65_536);
  assert.equal(f.store.settings().model.maxOutputTokens, 64_000);
});
