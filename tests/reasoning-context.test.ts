import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeContext,
  type AssistantMessage,
  type Message,
  type Model,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { convertMessages, streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { estimateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import {
  buildSessionProjection,
  convertToLlm,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { prepareReasoningContext } from '../src/server/runtime/reasoning-context.js';
import { projectModelImageInput } from '../src/server/runtime/model-image-input.js';

const compat: Parameters<typeof convertMessages>[2] = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  supportsFinishReason: true,
  maxTokensField: 'max_tokens',
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresNonNullAssistantContent: false,
  requiresToolsWithToolHistory: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: 'openai',
  openRouterRouting: {},
  vercelGatewayRouting: {},
  chatTemplateKwargs: {},
  chatTemplateArgs: {},
  zaiToolStream: false,
  supportsThinkingTokenBudget: false,
  supportsStrictMode: false,
  supportsOpenAIGrammarTools: false,
  supportsMidConvoSystemMessages: false,
  supportsMidConvoToolAdditions: false,
  sendSessionAffinityHeaders: false,
  sessionAffinityFormat: 'openai',
  supportsLongCacheRetention: true,
};

const model: Model<'openai-completions'> = {
  api: 'openai-completions',
  provider: 'loom-local',
  id: 'reasoning-fixture',
  name: 'Reasoning fixture',
  baseUrl: 'https://fixture.invalid/v1',
  input: ['text'],
  reasoning: false,
  contextWindow: 262_144,
  maxTokens: 131_072,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat,
};

function answer(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: 'Unsigned reasoning that is absent from the next wire request. '.repeat(1_000),
      },
      { type: 'text', text: 'Confirmed receipt op-17; continue from this result.' },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: 'stop',
    timestamp: 3,
    usage: {
      input: 10_000,
      output: 110_020,
      reasoning: 110_000,
      cacheRead: 3_000,
      cacheWrite: 2_000,
      cacheWrite1h: 500,
      totalTokens: 125_020,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
    ...overrides,
  };
}

function fixture(response = answer(), prompt = 'Original owner instruction.') {
  const manager = SessionManager.inMemory('/tmp/loom-reasoning-context');
  manager.appendMessage({
    role: 'system',
    content: 'Preserve operation receipts.',
    timestamp: 1,
    toolsAdded: [
      {
        name: 'inspect',
        description: 'Inspect one item.',
        parameters: { type: 'object', properties: {} },
      },
    ],
  });
  const inputId = manager.appendMessage({ role: 'user', content: prompt, timestamp: 2 });
  const anchorId = manager.appendMessage(response);
  const trailing: Message = {
    role: 'user',
    content: 'Continue without repeating op-17.',
    timestamp: 4,
  };
  manager.appendMessage(trailing);
  const context = () =>
    normalizeContext({
      messages: convertToLlm(buildSessionProjection(manager.getBranch()).messages),
    });
  return { manager, context, response, trailing, inputId, anchorId };
}

function prepared(f: ReturnType<typeof fixture>, selected = model) {
  return prepareReasoningContext(selected, f.context(), { branch: f.manager.getBranch() });
}

test('a validated provider anchor retains caches and costs while Pi sees the same conservative request budget', async () => {
  const f = fixture();
  const original = structuredClone(f.manager.getBranch());
  const result = prepared(f);
  assert.equal(result.corrected, true);
  assert.equal(result.excludedReasoningTokens, 110_000);
  assert.equal(result.projectedThinkingBlocks, 1);
  assert.equal(result.estimatedInputTokens, 15_020 + estimateMessageTokens(f.trailing));
  assert.equal(estimateContextTokens(result.transcript).tokens, result.estimatedInputTokens);
  const projected = result.transcript.messages.findLast(
    (message) => message.role === 'assistant',
  )! as AssistantMessage;
  assert.equal(projected.usage.input, 10_000);
  assert.equal(projected.usage.cacheRead, 3_000);
  assert.equal(projected.usage.cacheWrite, 2_000);
  assert.equal(projected.usage.cacheWrite1h, 500);
  assert.equal(projected.usage.output, 20);
  assert.equal(projected.usage.cost, f.response.usage.cost);
  assert.deepEqual(f.manager.getBranch(), original);

  let payload: Record<string, unknown> | undefined;
  const response = streamSimple(model, result.transcript, {
    apiKey: 'test-only',
    maxTokens: 131_072,
    maxRetries: 0,
    fetch: async (_input, init) => {
      payload = JSON.parse(init!.body as string) as Record<string, unknown>;
      return new Response(
        `data: ${JSON.stringify({ id: 'reasoning-fixture', choices: [{ index: 0, delta: { content: 'OK.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  assert.equal((await response.result()).stopReason, 'stop');
  assert.equal(
    payload?.max_tokens,
    131_072,
    'Pi must not restore the old reasoning-inclusive clamp',
  );
  assert.deepEqual(payload?.messages, convertMessages(model, f.context(), compat));
  assert.deepEqual(
    f.manager.getBranch(),
    original,
    'streaming the budget copy never changes the usage ledger',
  );
});

test('the full projected text estimate is a floor, never replaced by a smaller reported anchor', () => {
  const f = fixture(answer(), 'A long owner input. '.repeat(6_000));
  const result = prepared(f);
  const comparison = prepareReasoningContext(model, f.context(), { comparison: true });
  assert.equal(result.corrected, true);
  assert.ok(comparison.estimatedInputTokens > 15_020);
  assert.equal(result.estimatedInputTokens, comparison.estimatedInputTokens);
  assert.equal(estimateContextTokens(result.transcript).tokens, result.estimatedInputTokens);
});

test('only the latest response reasoning is subtracted from the measured input anchor', () => {
  const f = fixture();
  const latest = answer({
    timestamp: 5,
    usage: {
      ...f.response.usage,
      input: 20_000,
      cacheRead: 0,
      cacheWrite: 0,
      output: 40_020,
      reasoning: 40_000,
      totalTokens: 60_020,
    },
  });
  f.manager.appendMessage(latest);
  const result = prepared(f);
  assert.equal(result.corrected, true);
  assert.equal(result.excludedReasoningTokens, 40_000);
  assert.equal(result.estimatedInputTokens, 20_020);
  assert.equal(result.projectedThinkingBlocks, 2);
});

for (const [name, mutate, selected, corrected] of [
  ['unsigned', (message: AssistantMessage) => message, model, true],
  [
    'empty signature',
    (message: AssistantMessage) => ({
      ...message,
      content: [
        { type: 'thinking' as const, thinking: 'Unsigned.', thinkingSignature: '' },
        { type: 'text' as const, text: 'OK.' },
      ],
    }),
    model,
    true,
  ],
  [
    'raw reasoning_content',
    (message: AssistantMessage) => ({
      ...message,
      content: [
        {
          type: 'thinking' as const,
          thinking: 'Replay this reasoning.',
          thinkingSignature: 'reasoning_content',
        },
        { type: 'text' as const, text: 'OK.' },
      ],
    }),
    model,
    false,
  ],
  [
    'structured reasoning',
    (message: AssistantMessage) => ({
      ...message,
      content: [
        {
          type: 'thinking' as const,
          thinking: 'Structured reasoning.',
          thinkingSignature: JSON.stringify([
            { type: 'reasoning.text', text: 'Structured reasoning.' },
          ]),
        },
        { type: 'text' as const, text: 'OK.' },
      ],
    }),
    model,
    false,
  ],
  [
    'empty encrypted reasoning',
    (message: AssistantMessage) => ({
      ...message,
      content: [
        {
          type: 'thinking' as const,
          thinking: '',
          thinkingSignature: JSON.stringify([
            { type: 'reasoning.encrypted', data: 'encrypted-replay' },
          ]),
        },
        { type: 'text' as const, text: 'OK.' },
      ],
    }),
    model,
    false,
  ],
  [
    'empty signed thinking',
    (message: AssistantMessage) => ({
      ...message,
      content: [
        { type: 'thinking' as const, thinking: '', thinkingSignature: 'reasoning_content' },
        { type: 'text' as const, text: 'OK.' },
      ],
    }),
    model,
    false,
  ],
  [
    'tool thoughtSignature',
    (message: AssistantMessage) => ({
      ...message,
      content: [
        { type: 'text' as const, text: 'OK.' },
        {
          type: 'toolCall' as const,
          id: 'old-call',
          name: 'inspect',
          arguments: {},
          thoughtSignature: JSON.stringify({ type: 'reasoning.encrypted', data: 'tool-replay' }),
        },
      ],
    }),
    model,
    false,
  ],
  [
    'thinking as text',
    (message: AssistantMessage) => message,
    { ...model, compat: { ...compat, requiresThinkingAsText: true } },
    false,
  ],
] as const) {
  test(`public OpenAI projection is unchanged for ${name}`, () => {
    const f = fixture(mutate(answer()));
    const original = structuredClone(f.manager.getBranch());
    const result = prepared(f, selected);
    assert.equal(result.corrected, corrected);
    const resolved = { ...compat, ...selected.compat };
    assert.deepEqual(
      convertMessages(selected, result.transcript, resolved),
      convertMessages(selected, f.context(), resolved),
    );
    const comparison = prepareReasoningContext(selected, f.context(), { comparison: true });
    assert.deepEqual(
      convertMessages(selected, comparison.transcript, resolved),
      convertMessages(selected, f.context(), resolved),
      'measurement must not pretend replayed reasoning was removed',
    );
    assert.deepEqual(f.manager.getBranch(), original);
  });
}

test('missing or inconsistent reasoning/input evidence keeps the original conservative context', () => {
  for (const patch of [
    { reasoning: undefined },
    { reasoning: 0 },
    { reasoning: -1 },
    { reasoning: 110_021 },
    { reasoning: NaN },
    { input: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 110_020 },
    { totalTokens: 125_021 },
    { cacheRead: Infinity },
  ]) {
    const response = answer();
    const f = fixture({ ...response, usage: { ...response.usage, ...patch } });
    const context = f.context();
    const result = prepareReasoningContext(model, context, { branch: f.manager.getBranch() });
    assert.equal(result.corrected, false);
    assert.equal(result.transcript, context);
    assert.equal(result.excludedReasoningTokens, 0);
  }
});

test('unknown model, image and replay profiles cannot use a reasoning correction', () => {
  for (const selected of [
    { ...model, provider: 'other-provider' },
    { ...model, id: 'another-model' },
    { ...model, input: ['text', 'image'] as typeof model.input },
    { ...model, api: 'openai-responses' } as unknown as typeof model,
    { ...model, compat: { ...compat, supportsMidConvoSystemMessages: true } },
    { ...model, compat: { ...compat, supportsOpenAIGrammarTools: true } },
  ])
    assert.equal(prepared(fixture(), selected).corrected, false);
  for (const stopReason of ['error', 'aborted', 'length'] as const)
    assert.equal(prepared(fixture(answer({ stopReason }))).corrected, false);
  const f = fixture();
  f.manager.appendMessage({
    role: 'user',
    content: [{ type: 'image', data: 'pixels', mimeType: 'image/png' }],
    timestamp: 5,
  });
  assert.equal(prepared(f).corrected, false);
});

test("only Loom's known text-only view_image omission can differ from durable declarations", () => {
  const f = fixture();
  const head = f.manager
    .getBranch()
    .find((entry) => entry.type === 'message' && entry.message.role === 'system');
  assert.ok(head?.type === 'message' && head.message.role === 'system');
  head.message.toolsAdded!.push({
    name: 'view_image',
    description: 'Inspect pixels.',
    parameters: { type: 'object', properties: {} },
  });
  const branch = f.manager.getBranch();
  const projected = projectModelImageInput(model, f.context(), false, true);
  assert.equal(
    prepareReasoningContext(projected.model, projected.transcript, { branch }).corrected,
    true,
  );
  assert.equal(
    prepared(f).corrected,
    false,
    'an actual view_image declaration is not silently ignored',
  );
  const enabled = projectModelImageInput(model, f.context(), true, true);
  assert.equal(
    prepareReasoningContext(enabled.model, enabled.transcript, { branch }).corrected,
    false,
    'image-capable requests without pixels still have unproven input/loadout history',
  );
});

test('branch proof rejects edits, compaction and changed system/tool/input prefixes', () => {
  const f = fixture();
  assert.equal(prepareReasoningContext(model, f.context()).corrected, false);
  for (const mutate of [
    (messages: Message[]) =>
      messages.map((message) =>
        message.role === 'system' ? { ...message, content: 'Changed system.' } : message,
      ),
    (messages: Message[]) =>
      messages.map((message) =>
        message.role === 'system' ? { ...message, toolsAdded: [] } : message,
      ),
    (messages: Message[]) =>
      messages.map((message) =>
        message.role === 'user' && message.timestamp === 2
          ? { ...message, content: 'Different owner input.' }
          : message,
      ),
  ]) {
    const result = prepareReasoningContext(
      model,
      normalizeContext({ messages: mutate(f.context().messages) }),
      { branch: f.manager.getBranch() },
    );
    assert.equal(result.corrected, false);
  }
  const edited = fixture();
  edited.manager.appendContextEdit(edited.inputId, null);
  assert.equal(prepared(edited).corrected, false);
  const compacted = fixture();
  compacted.manager.appendCompaction('A new checkpoint.', compacted.anchorId, 100_000);
  assert.equal(prepared(compacted).corrected, false);
});

test('comparison projection survives a new checkpoint without reintroducing old unsigned thinking', () => {
  const f = fixture();
  const before = prepareReasoningContext(model, f.context(), {
    branch: f.manager.getBranch(),
    comparison: true,
  });
  f.manager.appendCompaction('A new checkpoint.', f.anchorId, 100_000);
  const after = prepareReasoningContext(model, f.context(), {
    branch: f.manager.getBranch(),
    comparison: true,
  });
  assert.equal(before.corrected, false);
  assert.equal(
    after.corrected,
    false,
    'fresh text comparisons are never authority to skip a threshold',
  );
  assert.equal(after.excludedReasoningTokens, 0);
  assert.equal(before.projectedThinkingBlocks, 1);
  assert.equal(after.projectedThinkingBlocks, 1);
  assert.ok(after.estimatedInputTokens < 1_000);
  assert.equal(f.response.usage.reasoning, 110_000);
  assert.ok(f.response.content.some((part) => part.type === 'thinking'));
});
