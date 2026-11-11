import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { normalizeContext, type AssistantMessage } from '@earendil-works/pi-ai';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import {
  buildSessionProjection,
  convertToLlm,
  estimateTokens,
  getLatestCompactionEntry,
  SessionManager,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { createApp } from '../src/server/app.js';
import { maxModelInputTokens } from '../src/server/runtime/model-context-budget.js';
import type { Task, TaskInput, TaskInputResult } from '../src/shared/types.js';

const FINISHED = new Set(['completed', 'failed', 'stopped', 'cancelled']);
const LARGE_SUMMARY = 'OLD_SUMMARY_LOG: prior observations and receipts. '.repeat(6_700);
const RETAINED_INSTRUCTION =
  'RETAINED_OWNER_REQUIREMENT_9107: keep receipt op-9107 and do not repeat the completed operation.';
const NEW_REQUEST = 'NEW_OWNER_REQUEST_9131: report the outstanding work using the saved evidence.';

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

function answer(text: string, timestamp: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'loom-local',
    model: 'compaction-fixture',
    stopReason: 'stop',
    timestamp,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

interface ModelRequest {
  payload: {
    messages: Array<{ role: string; content?: unknown }>;
    tools?: unknown[];
    max_tokens: number;
  };
  response: ServerResponse;
  complete(text: string, inputTokens?: number): void;
}

/** Persisted historical fixtures, real Pi hooks and a controlled local model endpoint. */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-compaction-runtime-'));
  const workspace = join(directory, 'workspace');
  const dataDir = join(directory, 'data');
  await mkdir(workspace);
  const requests: ModelRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelRequest['payload'];
    assert.equal(request.url, '/v1/chat/completions');
    const index = requests.length;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    requests.push({
      payload,
      response,
      complete(text, inputTokens) {
        assert.equal(response.destroyed, false, 'a live fixture request is required');
        const base = {
          id: `compaction-${index}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'compaction-fixture',
        };
        for (const [delta, finishReason] of [
          [{ role: 'assistant', content: text }, null],
          [{}, 'stop'],
        ] as const)
          response.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
          );
        if (inputTokens !== undefined)
          response.write(
            `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: 20, total_tokens: inputTokens + 20 } })}\n\n`,
          );
        response.end('data: [DONE]\n\n');
      },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const instance = await createApp({ dataDir, scheduler: false });
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
    model: {
      ...settings.model,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: 'compaction-fixture',
      contextWindow: 262_144,
      maxOutputTokens: 131_072,
      responseTimeoutSeconds: 15,
      idleTimeoutSeconds: 15,
    },
  });
  const diskKey = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
  const sessionDir = join(dataDir, 'sessions', diskKey('bot_aster'), diskKey('room_lounge'));
  await mkdir(sessionDir, { recursive: true });
  const current = (task: Task) => instance.store.get<Task>('tasks', task.id)!;
  return {
    ...instance,
    requests,
    current,
    async seed(storedSummary: boolean) {
      const manager = SessionManager.create(workspace, sessionDir);
      const timestamp = Date.now() - 10_000;
      manager.appendModelChange('loom-local', 'compaction-fixture');
      manager.appendMessage({
        role: 'user',
        content: 'ARCHIVED_EVIDENCE_9107: historical observations. '.repeat(1_700),
        timestamp,
      });
      manager.appendMessage(
        answer(
          'The original operation completed. Receipt op-9107 is authoritative.',
          timestamp + 1,
        ),
      );
      const firstKeptEntryId = manager.appendMessage({
        role: 'user',
        content: storedSummary
          ? RETAINED_INSTRUCTION
          : `${RETAINED_INSTRUCTION}\n${'Retain this recent detail. '.repeat(1_100)}`,
        timestamp: timestamp + 2,
      });
      manager.appendMessage(
        answer(
          'I will retain the current requirement and completed operation receipt.',
          timestamp + 3,
        ),
      );
      if (storedSummary)
        manager.appendCompaction(LARGE_SUMMARY, firstKeptEntryId, 120_000, {
          readFiles: ['reference-9107.md'],
          modifiedFiles: ['completed-9107.txt'],
          preservedFixtureData: 'keep-this-metadata',
        });
      const file = manager.getSessionFile();
      assert.ok(file);
      return {
        file,
        firstKeptEntryId,
        original: await readFile(file, 'utf8'),
        originalIds: manager.getEntries().map((entry) => entry.id),
        oldCompactionId: getLatestCompactionEntry(manager.getBranch())?.id,
        read: () => SessionManager.open(file),
      };
    },
    start() {
      return instance.controller.enqueueTask({
        roomId: 'room_lounge',
        botId: 'bot_aster',
        prompt: NEW_REQUEST,
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

function assertSummaryRequest(request: ModelRequest) {
  assert.equal(request.payload.tools?.length ?? 0, 0);
  assert.match(JSON.stringify(request.payload.messages), /Rewrite the summary into at most/);
}

test('an oversized persisted summary is repaired before the next task while retaining its boundary and original history', async (t) => {
  const f = await fixture(t);
  const seed = await f.seed(true);
  const task = f.start();
  const repair = await f.request(task, 0);
  assertSummaryRequest(repair);
  assert.match(JSON.stringify(repair.payload.messages), /<previous-summary>/);
  assert.match(JSON.stringify(repair.payload.messages), /OLD_SUMMARY_LOG/);
  repair.complete(
    'Setup is complete. Preserve receipt op-9107, the retained owner requirement, and the remaining review.',
  );

  const conversation = await f.request(task, 1);
  const messages = JSON.stringify(conversation.payload.messages);
  assert.ok((conversation.payload.tools?.length ?? 0) > 0);
  assert.ok(messages.includes(RETAINED_INSTRUCTION));
  assert.ok(messages.includes(NEW_REQUEST));
  assert.match(messages, /receipt op-9107/);
  assert.doesNotMatch(messages, /OLD_SUMMARY_LOG/);
  conversation.complete('The saved setup is complete; only the requested review remains.');
  const completed = await f.finished(task);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(f.requests.length, 2);

  const manager = seed.read();
  const latest = getLatestCompactionEntry(manager.getBranch());
  assert.ok(latest);
  assert.notEqual(latest.id, seed.oldCompactionId);
  assert.equal(latest.firstKeptEntryId, seed.firstKeptEntryId);
  const details = latest.details as {
    preservedFixtureData: string;
    loomCompaction: { mode: string };
  };
  assert.equal(details.preservedFixtureData, 'keep-this-metadata');
  assert.equal(details.loomCompaction.mode, 'repair');
  assert.match(latest.summary, /reference-9107\.md/);
  assert.match(latest.summary, /completed-9107\.txt/);
  assert.ok(
    (await readFile(seed.file, 'utf8')).startsWith(seed.original),
    'the previous JSONL content remains intact',
  );
  const ids = new Set(manager.getEntries().map((entry) => entry.id));
  assert.ok(
    seed.originalIds.every((id) => ids.has(id)),
    'all historical entries remain saved',
  );
});

test('real automatic compaction rejects two oversized stop responses without falling back to an unchecked default summary', async (t) => {
  const f = await fixture(t);
  const seed = await f.seed(false);
  const task = f.start();
  const conversation = await f.request(task, 0);
  assert.ok((conversation.payload.tools?.length ?? 0) > 0);
  // The provider's usage triggers Pi's ordinary post-run threshold compaction.
  conversation.complete('The requested review is complete.', 125_000);
  const first = await f.request(task, 1);
  assertSummaryRequest(first);
  assert.match(JSON.stringify(first.payload.messages), /ARCHIVED_EVIDENCE_9107/);
  first.complete(LARGE_SUMMARY);
  const second = await f.request(task, 2);
  assertSummaryRequest(second);
  assert.match(JSON.stringify(second.payload.messages), /previous attempt was too large/);
  assert.match(JSON.stringify(second.payload.messages), /ARCHIVED_EVIDENCE_9107/);
  second.complete(LARGE_SUMMARY);

  const failed = await f.finished(task);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /Two complete summaries exceeded the safe size target/);
  assert.equal(
    f.requests.length,
    3,
    'an extension failure must never invoke the default compactor',
  );
  assert.equal(getLatestCompactionEntry(seed.read().getBranch()), null);
  const saved = await readFile(seed.file, 'utf8');
  assert.ok(saved.startsWith(seed.original));
  assert.doesNotMatch(
    saved,
    /OLD_SUMMARY_LOG/,
    'rejected summary text is never a session checkpoint',
  );
});

test('stopping a stored-summary repair preserves the checkpoint and a new pending owner instruction', async (t) => {
  const f = await fixture(t);
  const seed = await f.seed(true);
  const task = f.start();
  const repair = await f.request(task, 0);
  assertSummaryRequest(repair);
  const input = await f.input(
    task,
    'AFTER_REPAIR_STOP_9107: keep this requirement for explicit resume.',
  );
  assert.equal(
    f.inputState(input).status,
    'pending',
    'a summary request does not deliver owner instructions',
  );
  await f.controller.stop(task.id);
  const stopped = await f.finished(task);
  assert.equal(stopped.status, 'stopped');
  await until(() => repair.response.destroyed, 'summary HTTP request closed');
  assert.equal(f.requests.length, 1);
  assert.equal(f.inputState(input).status, 'pending');
  const latest = getLatestCompactionEntry(seed.read().getBranch());
  assert.equal(latest?.id, seed.oldCompactionId);
  assert.equal(latest?.summary, LARGE_SUMMARY);
  assert.equal(latest?.firstKeptEntryId, seed.firstKeptEntryId);
  assert.ok((await readFile(seed.file, 'utf8')).startsWith(seed.original));
});

test('a new owner instruction arriving during repair reaches the next conversation exactly once', async (t) => {
  const f = await fixture(t);
  const seed = await f.seed(true);
  const task = f.start();
  const repair = await f.request(task, 0);
  assertSummaryRequest(repair);
  const instruction = 'DURING_REPAIR_9173: include this additional requirement in the answer.';
  const input = await f.input(task, instruction);
  assert.equal(f.inputState(input).status, 'pending');
  repair.complete(
    'The original setup completed with receipt op-9107. The current owner requirements remain authoritative.',
  );
  const conversation = await f.request(task, 1);
  const messages = JSON.stringify(conversation.payload.messages);
  assert.equal(messages.split(instruction).length - 1, 1);
  assert.ok(messages.includes(RETAINED_INSTRUCTION));
  assert.ok(messages.includes(NEW_REQUEST));
  conversation.complete(
    'The response includes the additional requirement and preserves completed work.',
  );
  const completed = await f.finished(task);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(f.inputState(input).status, 'delivered');
  assert.equal(f.requests.length, 2);
  assert.equal(
    getLatestCompactionEntry(seed.read().getBranch())?.firstKeptEntryId,
    seed.firstKeptEntryId,
  );
});

test('a small saved summary with large new history uses ordinary compaction before the send-time budget is exhausted', async (t) => {
  const f = await fixture(t);
  const seed = await f.seed(false);
  // Capture Loom's real system prompt and tool declarations in the persisted session.
  const warmup = f.start();
  (await f.request(warmup, 0)).complete('The current system and tool configuration is ready.');
  assert.equal((await f.finished(warmup)).status, 'completed');

  const manager = seed.read();
  manager.appendCompaction(
    'Small checkpoint: operation op-9107 is complete.',
    seed.firstKeptEntryId,
    30_000,
  );
  const base = manager.getBranch().slice();
  const timestamp = Date.now();
  const tail = `LATEST_RETAINED_DETAIL_9197\n${'Keep this recent detail. '.repeat(1_200)}`;
  const preview = (text: string) => {
    const messages = [
      { role: 'user' as const, content: text, timestamp },
      answer('The expanded observations have been recorded.', timestamp + 1),
      { role: 'user' as const, content: tail, timestamp: timestamp + 2 },
      answer('Keep the latest detail while continuing the review.', timestamp + 3),
    ];
    const entries: SessionEntry[] = messages.map((message, index) => ({
      type: 'message',
      id: `fixture-growth-${index}`,
      parentId: index ? `fixture-growth-${index - 1}` : base.at(-1)!.id,
      timestamp: new Date(timestamp + index).toISOString(),
      message,
    }));
    return buildSessionProjection([...base, ...entries]);
  };
  const inputBudget = maxModelInputTokens(262_144, 131_072);
  const initialTokens = estimateContextTokens(
    normalizeContext({ messages: convertToLlm(preview('').messages) }),
  ).tokens;
  const characters = Math.ceil((inputBudget + 4_000 - initialTokens) * 3.5);
  assert.ok(characters > 0);
  const text = 'NEW_HISTORY_REQUIRING_COMPACTION '
    .repeat(Math.ceil(characters / 32))
    .slice(0, characters);
  const projection = preview(text);
  assert.ok(
    estimateContextTokens(normalizeContext({ messages: convertToLlm(projection.messages) }))
      .tokens > inputBudget,
    'the send-time estimator requires compaction',
  );
  assert.ok(
    projection.messages.reduce((total, message) => total + estimateTokens(message), 0) <
      inputBudget,
    "Pi's more optimistic compaction estimator would not trigger yet",
  );
  manager.appendMessage({ role: 'user', content: text, timestamp });
  manager.appendMessage(answer('The expanded observations have been recorded.', timestamp + 1));
  const recentId = manager.appendMessage({ role: 'user', content: tail, timestamp: timestamp + 2 });
  manager.appendMessage(
    answer('Keep the latest detail while continuing the review.', timestamp + 3),
  );

  const task = f.start();
  const summary = await f.request(task, 1);
  assertSummaryRequest(summary);
  assert.match(JSON.stringify(summary.payload.messages), /NEW_HISTORY_REQUIRING_COMPACTION/);
  summary.complete(
    'Operation op-9107 is complete. Expanded observations were recorded; continue the review using the latest retained detail.',
  );
  const conversation = await f.request(task, 2);
  const sent = JSON.stringify(conversation.payload.messages);
  assert.match(sent, /LATEST_RETAINED_DETAIL_9197/);
  assert.doesNotMatch(sent, /NEW_HISTORY_REQUIRING_COMPACTION/);
  conversation.complete('The review continues with the latest retained detail.');
  const completed = await f.finished(task);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(f.requests.length, 3);
  const saved = getLatestCompactionEntry(seed.read().getBranch());
  assert.ok(saved);
  assert.equal(saved.firstKeptEntryId, recentId);
  assert.equal(
    (saved.details as { loomCompaction: { mode: string } }).loomCompaction.mode,
    'compact',
  );
});
