import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createApp } from '../src/server/app.js';
import type { OperationRecord } from '../src/server/runtime/contract.js';
import type { Activity, Task, TaskInput, TaskInputResult } from '../src/shared/types.js';

const MODEL_ID = 'reasoning-context-fixture';
const CONTEXT_WINDOW = 262_144;
const OUTPUT_CEILING = 131_072;
const FINISHED = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const SUMMARY =
  'The historical observations were reviewed. Preserve completed operation receipts and follow the latest owner instructions.';

interface ReportedUsage {
  input: number;
  output: number;
  reasoning?: number;
}

const OPAQUE_USAGE = { input: 15_000, output: 110_020, reasoning: 110_000 };
const LOW_USAGE = { input: 15_000, output: 20, reasoning: 0 };
const SUMMARY_USAGE = { input: 1_000, output: 20, reasoning: 0 };

interface ModelPayload {
  messages: Array<{
    role: string;
    content?: unknown;
    reasoning_content?: string;
    reasoning?: string;
    reasoning_text?: string;
    tool_call_id?: string;
  }>;
  tools?: unknown[];
  max_tokens: number;
}

interface ModelRequest {
  kind: 'conversation' | 'summary';
  payload: ModelPayload;
  response: ServerResponse;
  reportedUsage?: ReportedUsage;
  complete(text?: string, usage?: ReportedUsage, reasoningText?: string): void;
  tool(name: string, args: Record<string, unknown>, usage?: ReportedUsage): void;
  overflow(inputTokens: number): void;
}

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

function usageFields(message: AssistantMessage) {
  return {
    input: message.usage.input,
    output: message.usage.output,
    reasoning: message.usage.reasoning ?? 0,
    cacheRead: message.usage.cacheRead,
    cacheWrite: message.usage.cacheWrite,
    totalTokens: message.usage.totalTokens,
  };
}

function expectedUsage(usage: ReportedUsage) {
  return {
    input: usage.input,
    output: usage.output,
    reasoning: usage.reasoning ?? 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: usage.input + usage.output,
  };
}

function contentCharacters(payload: ModelPayload) {
  return payload.messages.reduce((sum, message) => {
    const content = message.content;
    return (
      sum +
      (typeof content === 'string'
        ? content.length
        : Array.isArray(content)
          ? content.reduce((size, part: { text?: string }) => size + (part.text?.length ?? 0), 0)
          : 0)
    );
  }, 0);
}

/** Real Loom/Pi and loopback SSE. Usage is synthetic; wire fields and persistence are real. */
async function fixture(t: TestContext, historyCharacters = 60_000) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-reasoning-context-'));
  const workspace = join(directory, 'workspace');
  const dataDir = join(directory, 'data');
  await mkdir(workspace);
  const requests: ModelRequest[] = [];
  const heldTools: ServerResponse[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/held-tool') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('started\n');
      heldTools.push(response);
      return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelPayload;
    const index = requests.length;
    const base = {
      id: `reasoning-context-${index}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: MODEL_ID,
    };
    const send = (delta: object, finishReason: string | null = null) => {
      if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      );
    };
    const finish = (reason: string, usage: ReportedUsage) => {
      record.reportedUsage = { ...usage };
      send({}, reason);
      response.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [],
          usage: {
            prompt_tokens: usage.input,
            completion_tokens: usage.output,
            total_tokens: usage.input + usage.output,
            ...(usage.reasoning === undefined
              ? {}
              : { completion_tokens_details: { reasoning_tokens: usage.reasoning } }),
          },
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    };
    const record: ModelRequest = {
      kind: payload.tools?.length ? 'conversation' : 'summary',
      payload,
      response,
      complete(text = 'OK', usage = OPAQUE_USAGE, reasoningText) {
        assert.equal(response.destroyed, false);
        if (reasoningText) send({ role: 'assistant', reasoning_content: reasoningText });
        send({ content: text });
        finish('stop', usage);
      },
      tool(name, args, usage = OPAQUE_USAGE) {
        send({
          tool_calls: [
            {
              index: 0,
              id: `call_reasoning_${index}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
        finish('tool_calls', usage);
      },
      overflow(inputTokens) {
        assert.equal(response.headersSent, false);
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            message:
              `This model's maximum context length is ${CONTEXT_WINDOW} tokens. However, you requested ` +
              `${payload.max_tokens} output tokens and your prompt contains ${inputTokens} input tokens, ` +
              `for a total of ${inputTokens + payload.max_tokens} tokens. ` +
              'Please reduce the length of the input prompt or the number of requested output tokens. ' +
              `(parameter=input_tokens, value=${inputTokens})`,
            type: 'BadRequestError',
            param: 'input_tokens',
            code: 400,
          }),
        );
      },
    };
    requests.push(record);
    // Unexpected summaries finish too, so the regression reports extra work rather than timing out.
    if (record.kind === 'summary') record.complete(SUMMARY, SUMMARY_USAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const instance = await createApp({ dataDir, scheduler: false });
  t.after(async () => {
    await instance.app.close();
    for (const request of requests) request.response.destroy();
    for (const response of heldTools) response.destroy();
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
    permissions: { ...settings.permissions, shell: 'allow', fileWrite: 'allow' },
    model: {
      ...settings.model,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: MODEL_ID,
      contextWindow: CONTEXT_WINDOW,
      maxOutputTokens: OUTPUT_CEILING,
      responseTimeoutSeconds: 15,
      idleTimeoutSeconds: 15,
    },
  });
  const key = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
  const sessionDir = join(dataDir, 'sessions', key('bot_aster'), key('room_lounge'));
  await mkdir(sessionDir, { recursive: true });
  const manager = SessionManager.create(workspace, sessionDir);
  manager.appendModelChange('loom-local', MODEL_ID);
  const timestamp = Date.now() - 100_000;
  for (let turn = 0; turn < 60; turn++) {
    const length = Math.ceil(historyCharacters / 60);
    manager.appendMessage({
      role: 'user',
      content:
        `Historical observation ${turn}: ` +
        'The prior observation was checked; retain its receipt. '.repeat(length).slice(0, length),
      timestamp: timestamp + turn * 2,
    });
    manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'Reviewed.' }],
      api: 'openai-completions',
      provider: 'loom-local',
      model: MODEL_ID,
      stopReason: 'stop',
      timestamp: timestamp + turn * 2 + 1,
      usage: {
        ...expectedUsage({ input: 0, output: 0, reasoning: 0 }),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
  }
  const file = manager.getSessionFile();
  assert.ok(file);
  const original = await readFile(file, 'utf8');
  const current = (task: Task) => instance.store.get<Task>('tasks', task.id)!;
  const entries = () => SessionManager.open(file).getEntries();
  return {
    ...instance,
    workspace,
    file,
    original,
    requests,
    heldTools,
    entries,
    current,
    get conversations() {
      return requests.filter((request) => request.kind === 'conversation');
    },
    get summaries() {
      return requests.filter((request) => request.kind === 'summary');
    },
    assistants() {
      return entries().flatMap((entry) =>
        entry.type === 'message' &&
        entry.message.role === 'assistant' &&
        entry.message.usage.totalTokens > 0
          ? [entry.message]
          : [],
      );
    },
    activities(task: Task) {
      return instance.store.list<Activity>('activities').filter((item) => item.taskId === task.id);
    },
    start(prompt = 'Continue the review and report the next result.') {
      return instance.controller.enqueueTask({ roomId: 'room_lounge', botId: 'bot_aster', prompt });
    },
    async request(task: Task, index: number) {
      await until(
        () =>
          requests.filter((request) => request.kind === 'conversation').length > index ||
          FINISHED.has(current(task).status),
        `conversation request ${index + 1}`,
      );
      const request = requests.filter((request) => request.kind === 'conversation')[index];
      assert.ok(request, `Missing request ${index + 1}: ${current(task).error ?? ''}`);
      return request;
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
    heldCommand() {
      return `node -e "fetch('http://127.0.0.1:${address.port}/held-tool').then(r=>r.text()).then(()=>require('node:fs').appendFileSync('effect-count.txt','effect\\n'))"`;
    },
  };
}

function assertRecordedTaskUsage(task: Task, requests: ModelRequest[]) {
  assert.equal(
    task.inputTokens,
    requests.reduce((sum, request) => sum + (request.reportedUsage?.input ?? 0), 0),
  );
  assert.equal(
    task.outputTokens,
    requests.reduce((sum, request) => sum + (request.reportedUsage?.output ?? 0), 0),
  );
}

function assertNoPhantomCompaction(activities: Activity[]) {
  const summaries = activities.filter((activity) => /summar|compact/i.test(activity.title));
  assert.ok(
    summaries.every((activity) => activity.status !== 'error' && activity.status !== 'running'),
    JSON.stringify(summaries),
  );
  assert.ok(
    summaries.every((activity) => activity.title !== 'Session context summarized'),
    'an intentional skip must not claim that a summary was saved',
  );
}

test('eight short opaque-reasoning replies keep the full wire ceiling, raw usage and pending owner instructions', async (t) => {
  const f = await fixture(t);
  const task = f.start();
  const inputs: TaskInput[] = [];
  for (let turn = 0; turn < 8; turn++) {
    const request = await f.request(task, turn);
    const text = JSON.stringify(request.payload.messages);
    for (let previous = 0; previous < inputs.length; previous++)
      assert.equal(
        text.match(new RegExp(`OWNER_CORRECTION_${previous}_9231`, 'g'))?.length,
        1,
        'each pending or delivered instruction remains in the real request exactly once',
      );
    assert.ok(
      request.payload.messages.every(
        (message) => !message.reasoning_content && !message.reasoning && !message.reasoning_text,
      ),
    );
    if (turn < 7) {
      const input = await f.input(
        task,
        `OWNER_CORRECTION_${turn}_9231: retain the completed review and check the next item.`,
      );
      inputs.push(input);
      assert.equal(f.inputState(input).status, 'pending');
    }
    request.complete();
  }
  const completed = await f.finished(task);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(f.summaries.length, 0, 'opaque reasoning must not cause repeated summaries');
  assert.deepEqual(
    f.conversations.map((request) => request.payload.max_tokens),
    Array(8).fill(OUTPUT_CEILING),
    'the provider must not reapply a smaller ceiling from the unadjusted usage',
  );
  assert.deepEqual(f.assistants().map(usageFields), Array(8).fill(expectedUsage(OPAQUE_USAGE)));
  assert.equal(completed.inputTokens, 8 * OPAQUE_USAGE.input);
  assert.equal(completed.outputTokens, 8 * OPAQUE_USAGE.output);
  assertRecordedTaskUsage(completed, f.requests);
  assert.ok(inputs.every((input) => f.inputState(input).status === 'delivered'));
  assert.equal(f.entries().filter((entry) => entry.type === 'compaction').length, 0);
  assert.ok((await readFile(f.file, 'utf8')).startsWith(f.original));
  assertNoPhantomCompaction(f.activities(task));
});

test('new tasks reuse an unchanged prompt and tool loadout without pre-prompt reasoning compaction', async (t) => {
  const f = await fixture(t);
  const tasks: Task[] = [];
  for (let turn = 0; turn < 3; turn++) {
    const task = f.start(`Continue the same review for request ${turn + 1}.`);
    const request = await f.request(task, turn);
    request.complete();
    const completed = await f.finished(task);
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.inputTokens, OPAQUE_USAGE.input);
    assert.equal(completed.outputTokens, OPAQUE_USAGE.output);
    tasks.push(completed);
  }
  assert.equal(f.summaries.length, 0, 'the next task must not compact a small unchanged prefix');
  assert.deepEqual(
    f.conversations.map((request) => request.payload.max_tokens),
    Array(3).fill(OUTPUT_CEILING),
  );
  assert.deepEqual(f.assistants().map(usageFields), Array(3).fill(expectedUsage(OPAQUE_USAGE)));
  assert.equal(f.entries().filter((entry) => entry.type === 'compaction').length, 0);
  for (const task of tasks) assertNoPhantomCompaction(f.activities(task));
});

test('missing reasoning usage detail preserves ordinary threshold compaction', async (t) => {
  const f = await fixture(t);
  const task = f.start();
  const request = await f.request(task, 0);
  const usage = { input: 15_000, output: 110_020 };
  request.complete('OK', usage);
  const completed = await f.finished(task);
  assert.equal(completed.status, 'completed', completed.error);
  assert.ok(f.summaries.length > 0, 'an unreported reasoning split is not evidence for skipping');
  assert.ok(f.entries().some((entry) => entry.type === 'compaction'));
  assert.deepEqual(f.assistants().map(usageFields), [expectedUsage(usage)]);
  assertRecordedTaskUsage(completed, f.requests);
});

test('reasoning_content retained by the real provider conversion is compacted and remains in the next request', async (t) => {
  const f = await fixture(t);
  const task = f.start();
  const request = await f.request(task, 0);
  const reasoning = 'REPLAYED_REASONING_9239: retain the measured evidence. '.repeat(1_000);
  request.complete('OK', OPAQUE_USAGE, reasoning);
  const completed = await f.finished(task);
  assert.equal(completed.status, 'completed', completed.error);
  assert.ok(f.summaries.length > 0, 'replayed reasoning must not be blindly subtracted');
  assert.ok(f.entries().some((entry) => entry.type === 'compaction'));
  assert.deepEqual(f.assistants().map(usageFields), [expectedUsage(OPAQUE_USAGE)]);
  assertRecordedTaskUsage(completed, f.requests);
  const next = f.start('Report what remains after the previous review.');
  const replay = await f.request(next, 1);
  assert.equal(
    replay.payload.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.reasoning_content ?? '')
      .join(''),
    reasoning,
  );
  replay.complete('OK', LOW_USAGE);
  assert.equal((await f.finished(next)).status, 'completed');
});

test('genuinely large input still compacts when removing reported reasoning cannot fit the input allowance', async (t) => {
  const f = await fixture(t, 360_000);
  const task = f.start();
  const request = await f.request(task, 0);
  assert.ok(contentCharacters(request.payload) > 360_000);
  const summariesBefore = f.summaries.length;
  const usage = { input: 120_000, output: 1_020, reasoning: 1_000 };
  request.complete('OK', usage);
  const completed = await f.finished(task);
  assert.equal(completed.status, 'completed', completed.error);
  assert.ok(
    f.summaries.length > summariesBefore,
    'the reported input itself still requires compaction',
  );
  assert.ok(f.entries().some((entry) => entry.type === 'compaction'));
  assert.deepEqual(f.assistants().map(usageFields), [expectedUsage(usage)]);
  assertRecordedTaskUsage(completed, f.requests);
});

test('opaque reasoning retains tool results through an overflow correction and later owner instruction without repeating an effect', async (t) => {
  const f = await fixture(t);
  const task = f.start('Perform the held effect once, then report its receipt.');
  const first = await f.request(task, 0);
  first.tool('run_command', { command: f.heldCommand() });
  await until(() => f.heldTools.length === 1, 'external operation started');
  f.heldTools[0].end('operation may complete');
  const afterTool = await f.request(task, 1);
  assert.equal(afterTool.payload.max_tokens, OUTPUT_CEILING);
  assert.ok(afterTool.payload.messages.some((message) => message.role === 'tool'));
  assert.equal(
    f.summaries.length,
    0,
    'opaque reasoning must not compact the tool continuation before any actual overflow',
  );
  afterTool.overflow(140_000);
  const corrected = await f.request(task, 2);
  assert.deepEqual(corrected.payload.messages, afterTool.payload.messages);
  assert.ok(corrected.payload.max_tokens < OUTPUT_CEILING);
  assert.ok(140_000 + corrected.payload.max_tokens <= CONTEXT_WINDOW - 4_096);
  const input = await f.input(
    task,
    'OWNER_AFTER_TOOL_9241: retain the completed receipt and do not repeat it.',
  );
  assert.equal(f.inputState(input).status, 'pending');
  corrected.complete('OK', LOW_USAGE);
  const continuation = await f.request(task, 3);
  assert.equal(
    JSON.stringify(continuation.payload.messages).match(/OWNER_AFTER_TOOL_9241/g)?.length,
    1,
  );
  assert.ok(continuation.payload.messages.some((message) => message.role === 'tool'));
  assert.equal(f.inputState(input).status, 'pending');
  continuation.complete('OK', LOW_USAGE);
  const completed = await f.finished(task);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(f.conversations.length, 4);
  assert.equal(await readFile(join(f.workspace, 'effect-count.txt'), 'utf8'), 'effect\n');
  const operations = f.store
    .list<OperationRecord>('operations')
    .filter((operation) => operation.taskId === task.id);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].status, 'completed');
  assert.deepEqual(f.assistants().map(usageFields), [
    expectedUsage(OPAQUE_USAGE),
    expectedUsage(LOW_USAGE),
    expectedUsage(LOW_USAGE),
  ]);
  assertRecordedTaskUsage(completed, f.requests);
  assert.equal(f.inputState(input).status, 'delivered');
  assert.ok(
    f
      .activities(task)
      .every((activity) => !/summar|compact/i.test(activity.title) || activity.status !== 'error'),
    'actual overflow recovery must not leave a phantom compaction error',
  );
});

test('owner stop after an opaque-reasoning reply preserves the unaccepted pending instruction and raw usage', async (t) => {
  const f = await fixture(t);
  const task = f.start();
  const first = await f.request(task, 0);
  const input = await f.input(task, 'OWNER_STOP_9247: continue only after an explicit resume.');
  first.complete();
  const next = await f.request(task, 1);
  assert.equal(f.inputState(input).status, 'pending');
  assert.equal(next.payload.max_tokens, OUTPUT_CEILING);
  await f.controller.stop(task.id);
  const stopped = await f.finished(task);
  assert.equal(stopped.status, 'stopped');
  await until(() => next.response.destroyed, 'stopped model transport');
  assert.equal(f.summaries.length, 0);
  assert.equal(f.inputState(input).status, 'pending');
  assert.deepEqual(f.assistants().map(usageFields), [expectedUsage(OPAQUE_USAGE)]);
  assertRecordedTaskUsage(stopped, f.requests);
  assertNoPhantomCompaction(f.activities(task));
});
