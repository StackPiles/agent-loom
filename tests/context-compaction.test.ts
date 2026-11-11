import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contentText,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
  toToolDeclaration,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
  type Usage,
} from '@earendil-works/pi-ai';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import {
  buildSessionProjection,
  convertToLlm,
  getLatestCompactionEntry,
  SessionManager,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import {
  createContextCompaction,
  type ContextCompactionOptions,
} from '../src/server/runtime/context-compaction.js';
import { prepareReasoningContext } from '../src/server/runtime/reasoning-context.js';

const model: Model<'openai-completions'> = {
  id: 'summary-fixture',
  name: 'Summary fixture',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'http://fixture.invalid/v1',
  input: ['text'],
  reasoning: true,
  contextWindow: 262144,
  maxTokens: 131072,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const reasoningModel = { ...model, provider: 'loom-local' };

function usage(output = 0, reasoning?: number): Usage {
  return {
    input: 100,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens: 100 + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function answer(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: 'stop',
    timestamp: 1,
    usage: { ...usage(), input: 0, totalTokens: 0 },
    ...overrides,
  };
}

function streamFixture(
  replies: AssistantMessage[],
  onRequest?: (count: number) => void,
): {
  stream: ContextCompactionOptions['stream'];
  calls: { context: TranscriptContext; options?: SimpleStreamOptions }[];
} {
  const calls: { context: TranscriptContext; options?: SimpleStreamOptions }[] = [];
  return {
    calls,
    stream: async (_model, context, options) => {
      calls.push({ context, options });
      onRequest?.(calls.length);
      const stream = createAssistantMessageEventStream();
      stream.end(replies[Math.min(calls.length - 1, replies.length - 1)]!);
      return stream;
    },
  };
}

const project = (branch: SessionEntry[]) =>
  normalizeContext({ messages: convertToLlm(buildSessionProjection(branch).messages) });
const measure = (context: TranscriptContext) => estimateContextTokens(context).tokens;

function reasoningCallbacks(maxInputTokens: number) {
  return {
    prepareMeasurement(context: TranscriptContext, branch: SessionEntry[]) {
      return prepareReasoningContext(reasoningModel, context, { branch, comparison: true })
        .transcript;
    },
    decideThreshold(context: TranscriptContext, branch: SessionEntry[]) {
      const result = prepareReasoningContext(reasoningModel, context, { branch });
      return { skip: result.corrected && result.estimatedInputTokens <= maxInputTokens };
    },
  };
}

function fixture() {
  const manager = SessionManager.inMemory('/tmp/loom-compaction-test');
  manager.appendMessage({
    role: 'system',
    content: 'Preserve user instructions and confirm operations with receipts.',
    toolsAdded: [
      toToolDeclaration({
        name: 'read',
        description: 'Read a file.',
        parameters: Type.Object({ path: Type.String() }),
      }),
    ],
    sections: { room: 'Original room context.' },
    timestamp: 1,
  });
  manager.appendMessage({
    role: 'user',
    content: 'Historical observations. '.repeat(2500),
    timestamp: 2,
  });
  manager.appendMessage(answer('Investigated the original request.', { timestamp: 3 }));
  manager.appendMessage({
    role: 'system',
    content: '',
    sections: { room: 'Current room context.' },
    toolsRemoved: [{ name: 'read' }],
    toolsAdded: [
      toToolDeclaration({
        name: 'finish',
        description: 'Finish an operation.',
        parameters: Type.Object({ id: Type.String() }),
      }),
    ],
    timestamp: 4,
  });
  const firstKeptEntryId = manager.appendMessage({
    role: 'user',
    content: 'Continue the current request; do not repeat completed operations.',
    timestamp: 5,
  });
  manager.appendMessage(
    answer('', {
      timestamp: 6,
      stopReason: 'toolUse',
      content: [
        { type: 'toolCall', id: 'call-receipt', name: 'finish', arguments: { id: 'op-17' } },
      ],
    }),
  );
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'call-receipt',
    toolName: 'finish',
    content: [{ type: 'text', text: 'Receipt op-17: completed exactly once.' }],
    isError: false,
    timestamp: 7,
  });
  let refreshed = 0;
  const session = {
    sessionManager: manager,
    isStreaming: false,
    refreshContext() {
      refreshed++;
    },
    async compact(): Promise<never> {
      throw new Error('Nothing to compact (session too small)');
    },
  };
  const event = (): SessionBeforeCompactEvent => {
    const branchEntries = manager.getBranch();
    return {
      type: 'session_before_compact',
      reason: 'threshold',
      willRetry: false,
      signal: new AbortController().signal,
      customInstructions: 'Keep the handover in Japanese and retain exact operation IDs.',
      branchEntries,
      preparation: {
        firstKeptEntryId,
        messagesToSummarize: branchEntries
          .slice(1, 3)
          .flatMap((entry) => (entry.type === 'message' ? [entry.message] : [])),
        turnPrefixMessages: [
          { role: 'user', content: 'Partial current turn goal: preserve op-17.', timestamp: 4 },
        ],
        isSplitTurn: true,
        tokensBefore: measure(project(branchEntries)),
        fileOps: {
          read: new Set(['/work/reference.md', '/work/changed.ts']),
          edited: new Set(['/work/changed.ts']),
          written: new Set<string>(),
        },
        settings: { enabled: true, reserveTokens: 131072, keepRecentTokens: 1000 },
      },
    };
  };
  const storeLargeSummary = () => {
    const summary = 'Prior decisions and confirmed receipts. '.repeat(1600);
    manager.appendCompaction(summary, firstKeptEntryId, 100000, {
      readFiles: ['/work/reference.md'],
      modifiedFiles: ['/work/changed.ts'],
      retainedExtensionData: { version: 3 },
    });
    manager.appendMessage({
      role: 'user',
      content: 'A new task must still see receipt op-17.',
      timestamp: Date.now(),
    });
    return summary;
  };
  return {
    manager,
    session,
    firstKeptEntryId,
    event,
    storeLargeSummary,
    refreshed: () => refreshed,
  };
}

function addReasoningResponse(
  f: ReturnType<typeof fixture>,
  input = 15000,
  reasoning: number | undefined = 110000,
  thinking?: string,
) {
  f.manager.appendMessage(
    answer('OK', {
      provider: reasoningModel.provider,
      timestamp: Date.now(),
      usage: { ...usage(110020, reasoning), input, totalTokens: input + 110020 },
      content: [
        ...(thinking ? [{ type: 'thinking' as const, thinking }] : []),
        { type: 'text', text: 'OK' },
      ],
    }),
  );
}

test('a proven reasoning-only threshold excess skips generation using the full projected next input', async () => {
  const f = fixture();
  addReasoningResponse(f);
  const original = structuredClone(f.manager.getBranch());
  const provider = streamFixture([answer('This summary should not be requested.')]);
  const pending = {
    role: 'user' as const,
    content: 'Pending receipt op-23: completed.',
    timestamp: Date.now() + 1,
  };
  let decisions = 0;
  let starts = 0;
  const callbacks = reasoningCallbacks(30000);
  const control = createContextCompaction({
    model: reasoningModel,
    maxInputTokens: 30000,
    measure,
    stream: provider.stream,
    getCurrentBranch: () => f.manager.getBranch(),
    project(branch) {
      return normalizeContext({ messages: [...project(branch).messages, pending] });
    },
    ...callbacks,
    decideThreshold(context, branch) {
      decisions++;
      assert.ok(context.messages.includes(pending));
      assert.ok(getCurrentTools(context.messages).length > 0);
      assert.ok(getCurrentSystemPrompt(context.messages).includes('Preserve user instructions'));
      const assistant = context.messages.findLast((message) => message.role === 'assistant');
      assert.equal(
        assistant?.usage.reasoning,
        110000,
        'evidence must be present before measurement zeros usage',
      );
      return callbacks.decideThreshold(context, branch);
    },
    onStart() {
      starts++;
    },
  });
  assert.deepEqual(await control.beforeCompact(f.event()), { cancel: true });
  control.throwIfFailed();
  assert.equal(control.takeThresholdSkipped(), true);
  assert.equal(control.takeThresholdSkipped(), false, 'the runtime consumes the marker once');
  assert.equal(decisions, 1);
  assert.equal(starts, 0);
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(f.manager.getBranch(), original);
});

for (const reason of ['manual', 'overflow', 'retry'] as const) {
  test(`the threshold decision cannot suppress ${reason} compaction`, async () => {
    const f = fixture();
    const provider = streamFixture([answer('A concise valid checkpoint.')]);
    let decisions = 0;
    let starts = 0;
    const control = createContextCompaction({
      model,
      maxInputTokens: 10000,
      measure,
      stream: provider.stream,
      decideThreshold() {
        decisions++;
        return { skip: true };
      },
      onStart() {
        starts++;
      },
    });
    const event = f.event();
    event.reason = reason === 'retry' ? 'threshold' : reason;
    event.willRetry = reason === 'retry';
    assert.ok((await control.beforeCompact(event)).compaction);
    assert.equal(decisions, 0);
    assert.equal(starts, 1);
    assert.equal(provider.calls.length, 1);
    assert.equal(control.takeThresholdSkipped(), false);
    control.throwIfFailed();
  });
}

for (const evidence of ['large_input', 'unknown_reasoning'] as const) {
  test(`ordinary compaction continues when ${evidence} prevents a safe threshold skip`, async () => {
    const f = fixture();
    addReasoningResponse(f, evidence === 'large_input' ? 45000 : 15000);
    if (evidence === 'unknown_reasoning') {
      const last = f.manager.getBranch().at(-1)!;
      assert.equal(last.type, 'message');
      if (last.type !== 'message' || last.message.role !== 'assistant') return;
      delete last.message.usage.reasoning;
    }
    const provider = streamFixture([answer('A concise valid checkpoint.')]);
    const control = createContextCompaction({
      model: reasoningModel,
      maxInputTokens: 30000,
      measure,
      stream: provider.stream,
      ...reasoningCallbacks(30000),
    });
    assert.ok((await control.beforeCompact(f.event())).compaction);
    assert.equal(provider.calls.length, 1);
    assert.equal(control.takeThresholdSkipped(), false);
    control.throwIfFailed();
  });
}

test('an unconsumed skip marker cannot hide a later cancellation', async () => {
  const f = fixture();
  const provider = streamFixture([answer('No generation is needed.')]);
  let decisions = 0;
  let starts = 0;
  const control = createContextCompaction({
    model,
    maxInputTokens: 30000,
    measure,
    stream: provider.stream,
    decideThreshold() {
      decisions++;
      return { skip: true };
    },
    onStart() {
      starts++;
    },
  });
  assert.deepEqual(await control.beforeCompact(f.event()), { cancel: true });
  const abort = new AbortController();
  abort.abort();
  const next = f.event();
  next.signal = abort.signal;
  assert.deepEqual(await control.beforeCompact(next), { cancel: true });
  assert.equal(control.takeThresholdSkipped(), false);
  assert.throws(control.throwIfFailed, { name: 'AbortError' });
  assert.equal(decisions, 1, 'cancellation wins before consulting the threshold decision');
  assert.equal(starts, 0);
  assert.equal(provider.calls.length, 0);
});

test('cancellation after a skip decision is still reported as cancellation', async () => {
  const f = fixture();
  const abort = new AbortController();
  const provider = streamFixture([answer('No generation is needed.')]);
  const control = createContextCompaction({
    model,
    maxInputTokens: 30000,
    measure,
    stream: provider.stream,
    decideThreshold() {
      return { skip: true };
    },
  });
  const event = f.event();
  event.signal = abort.signal;
  assert.deepEqual(await control.beforeCompact(event), { cancel: true });
  abort.abort();
  assert.equal(control.takeThresholdSkipped(), false);
  assert.equal(provider.calls.length, 0);
});

test('a prior compaction failure takes precedence over a subsequent skip decision', async () => {
  const f = fixture();
  const provider = streamFixture([answer('Partial checkpoint.', { stopReason: 'length' })]);
  let decisions = 0;
  const control = createContextCompaction({
    model,
    maxInputTokens: 10000,
    measure,
    stream: provider.stream,
    decideThreshold() {
      decisions++;
      return { skip: true };
    },
  });
  const manual = f.event();
  manual.reason = 'manual';
  assert.deepEqual(await control.beforeCompact(manual), { cancel: true });
  assert.deepEqual(await control.beforeCompact(f.event()), { cancel: true });
  assert.throws(control.throwIfFailed, /\(length\)/);
  assert.equal(control.takeThresholdSkipped(), false);
  assert.equal(decisions, 0);
  assert.equal(provider.calls.length, 1);
});

for (const change of ['abort', 'branch'] as const) {
  test(`an asynchronous threshold decision cannot conceal a concurrent ${change} change`, async () => {
    const f = fixture();
    const original = structuredClone(f.manager.getBranch());
    const abort = new AbortController();
    const provider = streamFixture([answer('No generation is needed.')]);
    let starts = 0;
    const control = createContextCompaction({
      model,
      maxInputTokens: 30000,
      measure,
      stream: provider.stream,
      signal: abort.signal,
      getCurrentBranch: () => f.manager.getBranch(),
      async decideThreshold() {
        await Promise.resolve();
        if (change === 'abort') abort.abort();
        else
          f.manager.appendMessage({
            role: 'user',
            content: 'A new instruction.',
            timestamp: Date.now(),
          });
        return { skip: true };
      },
      onStart() {
        starts++;
      },
    });
    assert.deepEqual(await control.beforeCompact(f.event()), { cancel: true });
    assert.equal(control.takeThresholdSkipped(), false);
    assert.throws(control.throwIfFailed, change === 'abort' ? /cancelled/ : /session changed/);
    assert.equal(starts, 0);
    assert.equal(provider.calls.length, 0);
    assert.deepEqual(f.manager.getBranch().slice(0, original.length), original);
  });
}

test('stored-summary repair projects proven unreplayed thoughts before zeroing usage and keeps the saved history intact', async () => {
  const f = fixture();
  f.storeLargeSummary();
  addReasoningResponse(f, 15000, 110000, 'Private reasoning that is not replayed. '.repeat(6000));
  const original = structuredClone(f.manager.getBranch());
  const provider = streamFixture([answer('Keep the current goal and confirmed receipts.')]);
  const callbacks = reasoningCallbacks(30000);
  let preparations = 0;
  let decisions = 0;
  const control = createContextCompaction({
    model: reasoningModel,
    maxInputTokens: 30000,
    measure(context) {
      for (const message of context.messages) {
        if (message.role === 'assistant') {
          assert.equal(message.usage.totalTokens, 0);
          assert.equal(
            message.content.some((block) => block.type === 'thinking'),
            false,
          );
        }
      }
      return measure(context);
    },
    stream: provider.stream,
    prepareMeasurement(context, branch) {
      preparations++;
      const last = context.messages.findLast((message) => message.role === 'assistant');
      assert.equal(last?.usage.reasoning, 110000);
      return callbacks.prepareMeasurement(context, branch);
    },
    decideThreshold() {
      decisions++;
      return { skip: true };
    },
  });
  assert.equal(await control.repairOversizedSummary(f.session), true);
  assert.ok(preparations > 1);
  assert.equal(decisions, 0, 'summary repair is not eligible for a threshold skip');
  assert.equal(provider.calls.length, 1);
  assert.equal(control.takeThresholdSkipped(), false);
  assert.deepEqual(f.manager.getBranch().slice(0, original.length), original);
  assert.equal(
    getLatestCompactionEntry(f.manager.getBranch())!.firstKeptEntryId,
    f.firstKeptEntryId,
  );
});

test('ordinary compaction validates before persistence and preserves boundary, system, tools, files, and instructions', async () => {
  const f = fixture();
  const original = structuredClone(f.manager.getBranch());
  const provider = streamFixture([
    answer('Current goal: continue safely. Receipt op-17 confirms completion.', {
      content: [
        { type: 'thinking', thinking: 'Reasoning is not saved summary text. '.repeat(5000) },
        { type: 'text', text: 'Current goal: continue safely. Receipt op-17 confirms completion.' },
      ],
      usage: usage(60000, 59980),
    }),
  ]);
  const projections: TranscriptContext[] = [];
  const control = createContextCompaction({
    model,
    maxInputTokens: 10000,
    measure(context) {
      projections.push(context);
      return measure(context);
    },
    stream: provider.stream,
    getCurrentBranch: () => f.manager.getBranch(),
    thinkingLevel: 'high',
  });
  const result = await control.beforeCompact(f.event());
  assert.ok(result.compaction);
  assert.deepEqual(
    f.manager.getBranch(),
    original,
    'the hook must not save before Pi accepts its result',
  );
  assert.equal(result.compaction.firstKeptEntryId, f.firstKeptEntryId);
  assert.ok(result.compaction.estimatedTokensAfter! <= 10000);
  assert.match(result.compaction.summary, /<read-files>\n\/work\/reference.md/);
  assert.match(result.compaction.summary, /<modified-files>\n\/work\/changed.ts/);
  assert.doesNotMatch(result.compaction.summary, /Reasoning is not saved/);
  assert.equal(result.compaction.usage?.reasoning, 59980);
  assert.equal(provider.calls.length, 1);
  assert.equal(
    provider.calls[0]!.options?.maxTokens,
    undefined,
    'visible text target must not become a fixed generation cap',
  );
  assert.equal(provider.calls[0]!.options?.reasoning, 'high');
  const prompt = provider.calls[0]!.context.messages.filter((message) => message.role === 'user')
    .map((message) => contentText(message.content))
    .join('\n');
  assert.match(prompt, /Keep the handover in Japanese/);
  assert.match(prompt, /Partial current turn goal/);
  assert.match(prompt, /not for reasoning or the total generation budget/);
  const projected = projections.at(-1)!;
  assert.equal(
    getCurrentSystemPrompt(projected.messages),
    getCurrentSystemPrompt(project(original).messages),
  );
  assert.deepEqual(
    getCurrentTools(projected.messages),
    getCurrentTools(project(original).messages),
  );
  assert.deepEqual(
    projected.messages.filter((message) => message.role === 'toolResult'),
    project(original).messages.filter((message) => message.role === 'toolResult'),
  );
  control.throwIfFailed();
});

test('one complete oversized response can be retried with a tighter text target and combined usage', async () => {
  const f = fixture();
  const provider = streamFixture([
    answer('Too much detail. '.repeat(5000), { usage: usage(20000, 1000) }),
    answer('Continue the user request. Receipt op-17 is complete.', { usage: usage(9000, 8900) }),
  ]);
  const control = createContextCompaction({
    model,
    maxInputTokens: 10000,
    measure,
    stream: provider.stream,
  });
  const result = await control.beforeCompact(f.event());
  assert.ok(result.compaction);
  assert.equal(provider.calls.length, 2);
  assert.equal(result.compaction.usage?.output, 29000);
  assert.equal(result.compaction.usage?.reasoning, 9900);
  const second = provider.calls[1]!.context.messages.filter((message) => message.role === 'user')
    .map((message) => contentText(message.content))
    .join('\n');
  assert.match(second, /previous attempt was too large/);
  assert.match(second, /Historical observations/);
  assert.doesNotMatch(second, /Too much detail/);
});

test('non-shrinking summaries cancel the hook after two attempts and latch a failure instead of falling back', async () => {
  const f = fixture();
  const original = structuredClone(f.manager.getBranch());
  const provider = streamFixture([answer('The old transcript repeated. '.repeat(5000))]);
  const control = createContextCompaction({
    model,
    maxInputTokens: 10000,
    measure,
    stream: provider.stream,
  });
  assert.deepEqual(await control.beforeCompact(f.event()), { cancel: true });
  assert.equal(provider.calls.length, 2);
  assert.throws(control.throwIfFailed, /Two complete summaries exceeded/);
  assert.deepEqual(await control.beforeCompact(f.event()), { cancel: true });
  assert.equal(provider.calls.length, 2, 'the failed operation has a finite request budget');
  assert.deepEqual(f.manager.getBranch(), original);
});

test('old large usage counters cannot make an expanding summary pass the shrinkage check', async () => {
  const f = fixture();
  const branch = f.manager.getBranch();
  const history = branch[1]!;
  const response = branch[2]!;
  assert.equal(history.type, 'message');
  assert.equal(response.type, 'message');
  if (history.type !== 'message' || response.type !== 'message') return;
  history.message = { role: 'user', content: 'Prior historical facts. '.repeat(100), timestamp: 2 };
  response.message = answer('The old response.', {
    timestamp: Date.now() + 1000,
    usage: usage(100000, 99000),
  });
  const original = structuredClone(branch);
  const provider = streamFixture([answer('Expanded detail without useful shrinkage. '.repeat(80))]);
  const control = createContextCompaction({
    model,
    maxInputTokens: 10000,
    measure,
    stream: provider.stream,
  });
  assert.deepEqual(await control.beforeCompact(f.event()), { cancel: true });
  assert.equal(provider.calls.length, 2);
  assert.throws(control.throwIfFailed, /Two complete summaries exceeded/);
  assert.deepEqual(
    f.manager.getBranch(),
    original,
    'measurement must not alter saved provider usage',
  );
});

for (const reason of ['length', 'aborted', 'error', 'toolUse'] as const) {
  test(`a ${reason} summary is never saved or retried as a valid checkpoint`, async () => {
    const f = fixture();
    const original = structuredClone(f.manager.getBranch());
    const provider = streamFixture([
      answer('A plausible but incomplete summary.', {
        stopReason: reason,
        ...(reason === 'toolUse'
          ? {
              content: [
                {
                  type: 'toolCall' as const,
                  id: 'bad',
                  name: 'finish',
                  arguments: { id: 'op-18' },
                },
              ],
            }
          : {}),
      }),
    ]);
    const control = createContextCompaction({
      model,
      maxInputTokens: 10000,
      measure,
      stream: provider.stream,
    });
    assert.deepEqual(await control.beforeCompact(f.event()), { cancel: true });
    assert.equal(provider.calls.length, 1);
    assert.throws(control.throwIfFailed, new RegExp(`\\(${reason}\\)`));
    assert.deepEqual(f.manager.getBranch(), original);
  });
}

test('a completed response with no visible summary is rejected', async () => {
  const f = fixture();
  const provider = streamFixture([
    answer('', { content: [{ type: 'thinking', thinking: 'Only reasoning.' }] }),
  ]);
  const control = createContextCompaction({
    model,
    maxInputTokens: 10000,
    measure,
    stream: provider.stream,
  });
  assert.deepEqual(await control.beforeCompact(f.event()), { cancel: true });
  assert.equal(provider.calls.length, 1);
  assert.throws(control.throwIfFailed, /Summary generation failed/);
});

test('a large existing summary is repaired below total capacity and keeps raw logs, recent input, receipts, and hysteresis', async () => {
  const f = fixture();
  const oldSummary = f.storeLargeSummary();
  const original = structuredClone(f.manager.getBranch());
  const originalTranscript = project(original);
  assert.ok(
    measure(originalTranscript) < 30000,
    'repair must also trigger below the total-input threshold',
  );
  const pending = {
    role: 'user' as const,
    content: 'Pending receipt op-19: accepted; do not submit again.',
    timestamp: Date.now() + 1,
  };
  const projections: TranscriptContext[] = [];
  const provider = streamFixture([
    answer(
      'Current goal: finish the handover. Confirmed receipt op-17 is complete; preserve outstanding requests.',
    ),
  ]);
  const lifecycle: { phase: string; summary: string | undefined; error?: string }[] = [];
  const control = createContextCompaction({
    model,
    maxInputTokens: 30000,
    measure(context) {
      projections.push(context);
      return measure(context);
    },
    project(branch) {
      return normalizeContext({ messages: [...project(branch).messages, pending] });
    },
    stream: provider.stream,
    onRepair(event) {
      lifecycle.push({
        phase: event.phase,
        summary: getLatestCompactionEntry(f.manager.getBranch())?.summary,
        error: event.error,
      });
    },
  });
  assert.equal(await control.repairOversizedSummary(f.session), true);
  assert.equal(provider.calls.length, 1);
  assert.equal(f.refreshed(), 1);
  const branch = f.manager.getBranch();
  assert.deepEqual(branch.slice(0, original.length), original, 'repair only appends a checkpoint');
  assert.equal(branch.length, original.length + 1);
  const latest = getLatestCompactionEntry(branch)!;
  assert.equal(latest.firstKeptEntryId, f.firstKeptEntryId);
  assert.notEqual(latest.summary, oldSummary);
  assert.deepEqual((latest.details as { retainedExtensionData: unknown }).retainedExtensionData, {
    version: 3,
  });
  assert.match(latest.summary, /\/work\/reference.md/);
  assert.match(latest.summary, /\/work\/changed.ts/);
  const repaired = project(branch);
  assert.equal(
    getCurrentSystemPrompt(repaired.messages),
    getCurrentSystemPrompt(originalTranscript.messages),
  );
  assert.deepEqual(
    getCurrentTools(repaired.messages),
    getCurrentTools(originalTranscript.messages),
  );
  assert.deepEqual(
    repaired.messages.filter((message) => message.role === 'toolResult'),
    originalTranscript.messages.filter((message) => message.role === 'toolResult'),
  );
  assert.ok(
    repaired.messages.some(
      (message) => message.role === 'user' && contentText(message.content).includes('A new task'),
    ),
  );
  assert.ok(
    projections.at(-1)!.messages.includes(pending),
    'pending receipt must participate in the final admission check',
  );
  assert.deepEqual(
    lifecycle.map((event) => event.phase),
    ['start', 'end'],
  );
  assert.equal(lifecycle[0]!.summary, oldSummary);
  assert.equal(
    lifecycle[1]!.summary,
    latest.summary,
    'end is emitted after the validated checkpoint is saved',
  );
  assert.equal(await control.repairOversizedSummary(f.session), false);
  assert.equal(
    provider.calls.length,
    1,
    'a repaired summary must not trigger another repair immediately',
  );
  assert.equal(lifecycle.length, 2);
});

test('an irreducible pending input defers to the send budget without saving an unsafe summary', async () => {
  const f = fixture();
  f.storeLargeSummary();
  const original = structuredClone(f.manager.getBranch());
  const provider = streamFixture([answer('Small summary.')]);
  const control = createContextCompaction({
    model,
    maxInputTokens: 10000,
    measure,
    stream: provider.stream,
    project(branch) {
      return normalizeContext({
        messages: [
          ...project(branch).messages,
          {
            role: 'user',
            content: 'Pending receipt must remain complete. '.repeat(2000),
            timestamp: Date.now() + 1,
          },
        ],
      });
    },
  });
  assert.equal(await control.repairOversizedSummary(f.session), false);
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(f.manager.getBranch(), original);
  assert.equal(f.refreshed(), 0);
  control.throwIfFailed();
});

test('a small old summary with a large newer history delegates to normal compaction before prompting', async () => {
  const f = fixture();
  const previousSummary = 'A short checkpoint: operation op-17 completed.';
  f.manager.appendCompaction(previousSummary, f.firstKeptEntryId, 20000);
  const progress = {
    role: 'user' as const,
    content: 'Post-checkpoint progress. '.repeat(1400),
    timestamp: 10,
  };
  f.manager.appendMessage(progress);
  f.manager.appendMessage(answer('The progress was recorded.', { timestamp: 11 }));
  const newestId = f.manager.appendMessage({
    role: 'user',
    content: 'Continue from that progress.',
    timestamp: 12,
  });
  const original = structuredClone(f.manager.getBranch());
  const provider = streamFixture([
    answer('Keep the current goal and confirmed receipt op-17. The newer progress is recorded.'),
  ]);
  let compactCalls = 0;
  const control = createContextCompaction({
    model,
    maxInputTokens: 10000,
    measure,
    stream: provider.stream,
  });
  const session = {
    ...f.session,
    async compact() {
      compactCalls++;
      const event = f.event();
      event.preparation.firstKeptEntryId = newestId;
      event.preparation.previousSummary = previousSummary;
      event.preparation.messagesToSummarize = [progress];
      event.preparation.turnPrefixMessages = [];
      const result = await control.beforeCompact(event);
      control.throwIfFailed();
      assert.ok(result.compaction);
      f.manager.appendCompaction(
        result.compaction.summary,
        newestId,
        result.compaction.tokensBefore,
        result.compaction.details,
      );
      f.session.refreshContext();
      return result.compaction;
    },
  };
  assert.ok(measure(project(original)) > 10000);
  assert.ok(
    progress.content.length / 4 < 10000,
    'the usual chars/4 trigger can lag the guarded chars/3.5 budget',
  );
  assert.equal(await control.repairOversizedSummary(session), true);
  assert.equal(compactCalls, 1);
  assert.equal(
    provider.calls.length,
    1,
    'do not spend a request recompressing the already-small checkpoint',
  );
  assert.equal(getLatestCompactionEntry(f.manager.getBranch())!.firstKeptEntryId, newestId);
  assert.deepEqual(f.manager.getBranch().slice(0, original.length), original);
  assert.ok(measure(project(f.manager.getBranch())) < 10000);
});

test('a session change while recompressing rejects the stale candidate and preserves the new message', async () => {
  const f = fixture();
  const oldSummary = f.storeLargeSummary();
  const oldLength = f.manager.getBranch().length;
  const provider = streamFixture([answer('Small safe summary.')], () => {
    f.manager.appendMessage({
      role: 'user',
      content: 'A concurrent correction must not be lost.',
      timestamp: Date.now(),
    });
  });
  const control = createContextCompaction({
    model,
    maxInputTokens: 30000,
    measure,
    stream: provider.stream,
  });
  await assert.rejects(
    control.repairOversizedSummary(f.session),
    /session changed during compaction/,
  );
  assert.equal(getLatestCompactionEntry(f.manager.getBranch())!.summary, oldSummary);
  assert.equal(f.manager.getBranch().length, oldLength + 1);
  assert.equal(provider.calls.length, 1);
  assert.equal(f.refreshed(), 0);
});

test('cancellation during summary generation leaves the old checkpoint untouched', async () => {
  const f = fixture();
  f.storeLargeSummary();
  const original = structuredClone(f.manager.getBranch());
  const abort = new AbortController();
  const provider = streamFixture([answer('Small safe summary.')], () => abort.abort());
  const control = createContextCompaction({
    model,
    maxInputTokens: 30000,
    measure,
    stream: provider.stream,
    signal: abort.signal,
  });
  await assert.rejects(control.repairOversizedSummary(f.session), { name: 'AbortError' });
  assert.equal(provider.calls[0]!.options?.signal, abort.signal);
  assert.deepEqual(f.manager.getBranch(), original);
  assert.equal(provider.calls.length, 1);
  assert.equal(f.refreshed(), 0);
});

test('stored-summary repair refuses an actively streaming session', async () => {
  const f = fixture();
  f.storeLargeSummary();
  f.session.isStreaming = true;
  const provider = streamFixture([answer('Small safe summary.')]);
  const control = createContextCompaction({
    model,
    maxInputTokens: 30000,
    measure,
    stream: provider.stream,
  });
  await assert.rejects(control.repairOversizedSummary(f.session), /session is idle/);
  assert.equal(provider.calls.length, 0);
});
