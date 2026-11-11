import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import {
  MAX_CONTEXT_ERROR_BODY_BYTES,
  contextSafetyTokens,
  diagnoseContextOverflow,
  maxModelInputTokens,
  planContextOverflowRetry,
  planModelContextBudget,
  type ContextOverflowDiagnostic,
} from '../src/server/runtime/model-context-budget.js';
import {
  streamWithModelTimeouts,
  type ModelStreamObserver,
} from '../src/server/runtime/model-stream.js';

const contextWindow = 262_144;
const lowerBoundBody = {
  message:
    "This model's maximum context length is 262144 tokens. However, you requested 131072 output tokens and your prompt contains at least 131073 input tokens, for a total of at least 262145 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=131073)",
  type: 'BadRequestError',
  param: 'input_tokens',
  code: 400,
};

function retry(diagnostic: ContextOverflowDiagnostic | undefined, previousMaxTokens = 131_072) {
  return planContextOverflowRetry({
    diagnostic,
    contextWindow,
    previousMaxTokens,
    attempts: 0,
    generationStarted: false,
    aborted: false,
  });
}

test('request budgets keep smaller caller caps and retain uncertainty margin near capacity', () => {
  const summary = planModelContextBudget({
    contextWindow,
    configuredMaxTokens: 131_072,
    requestedMaxTokens: 16_384,
    estimatedInputTokens: 100_000,
  });
  assert.equal(summary.maxTokens, 16_384, 'a summary cap must not become the conversation cap');
  const nearFull = planModelContextBudget({
    contextWindow,
    configuredMaxTokens: 131_072,
    estimatedInputTokens: 210_000,
  });
  assert.equal(nearFull.maxTokens, 20_644);
  assert.equal(nearFull.safetyTokens, 31_500, 'do not revert to a smaller fixed-only margin');
  assert.equal(
    planModelContextBudget({
      contextWindow,
      configuredMaxTokens: 131_072,
      requestedMaxTokens: 200_000,
      estimatedInputTokens: 100,
    }).maxTokens,
    131_072,
  );
});

test('an exhausted estimate never turns into an overflowing one-token request', () => {
  const budget = planModelContextBudget({
    contextWindow,
    configuredMaxTokens: 131_072,
    estimatedInputTokens: 250_000,
  });
  assert.equal(budget.maxTokens, undefined);
  assert.ok(budget.inputTokens + budget.safetyTokens > contextWindow);
  const small = planModelContextBudget({
    contextWindow: 2_048,
    configuredMaxTokens: 128,
    estimatedInputTokens: 1_000,
  });
  assert.equal(small.maxTokens, 128);
});

test('compaction input targets use the same budgeting boundary as subsequent requests', () => {
  for (const [context, output] of [
    [2_048, 128],
    [32_768, 1_024],
    [262_144, 131_072],
    [262_144, 16_384],
    [2_097_152, 1_048_576],
  ]) {
    const target = maxModelInputTokens(context, output);
    const plan = (estimatedInputTokens: number) =>
      planModelContextBudget({
        contextWindow: context,
        configuredMaxTokens: output,
        estimatedInputTokens,
      });
    assert.equal(plan(target).maxTokens, output);
    assert.ok((plan(target + 1).maxTokens ?? 0) < output);
  }
  assert.equal(maxModelInputTokens(2_048, 2_048), 0);
});

test('the observed vLLM at-least value remains a lower bound, never an actual input count', () => {
  for (const body of [lowerBoundBody, { error: lowerBoundBody }, JSON.stringify(lowerBoundBody)]) {
    const diagnostic = diagnoseContextOverflow({ httpStatus: 400, body });
    assert.deepEqual(diagnostic, {
      kind: 'context_overflow',
      httpStatus: 400,
      contextWindow,
      inputTokens: { kind: 'lower_bound', value: 131_073 },
      requestedMaxTokens: 131_072,
    });
    assert.deepEqual(retry(diagnostic), {
      maxTokens: 65_536,
      contextWindow,
      evidence: 'lower_bound',
    });
  }
  const numericField = diagnoseContextOverflow({
    httpStatus: 400,
    body: { ...lowerBoundBody, input_tokens: 131_073 },
  });
  assert.equal(numericField?.inputTokens?.kind, 'lower_bound');
});

test('the three reported inputs fit after one bounded correction without inventing a tokenizer count', () => {
  for (const [actualInput, previousOutput] of [
    [134_896, 131_072],
    [131_202, 130_975],
    [143_806, 131_072],
  ]) {
    const diagnostic = diagnoseContextOverflow({ httpStatus: 400, body: lowerBoundBody });
    const correction = retry(diagnostic, previousOutput);
    assert.ok(correction);
    assert.ok(actualInput + previousOutput > contextWindow);
    assert.ok(actualInput + correction.maxTokens < contextWindow);
    assert.equal(correction.evidence, 'lower_bound');
  }
  const uncertainFirstEstimate = planModelContextBudget({
    contextWindow,
    configuredMaxTokens: 131_072,
    estimatedInputTokens: 109_965,
  });
  assert.equal(uncertainFirstEstimate.maxTokens, 131_072);
  assert.equal(uncertainFirstEstimate.inputEvidence, undefined, 'an estimate is not exact usage');
});

test('an exact rejection count permits a precise cap with a retained uncertainty allowance', () => {
  for (const actualInput of [134_896, 131_202, 143_806]) {
    const diagnostic = diagnoseContextOverflow({
      httpStatus: 400,
      body: {
        error: {
          code: 'context_length_exceeded',
          message: `This model's maximum context length is 262144 tokens. However, you requested ${actualInput + 131_072} tokens (${actualInput} in the messages, 131072 in the completion).`,
        },
      },
    });
    assert.deepEqual(diagnostic?.inputTokens, { kind: 'exact', value: actualInput });
    const correction = retry(diagnostic);
    assert.ok(correction);
    assert.equal(correction.evidence, 'exact');
    assert.equal(
      correction.maxTokens + actualInput + contextSafetyTokens(contextWindow, actualInput),
      contextWindow,
    );
  }
});

test('missing counts allow only a reduced probe and a smaller server window remains authoritative', () => {
  const unknown = diagnoseContextOverflow({
    httpStatus: 400,
    body: { error: { code: 'context_length_exceeded' } },
  });
  assert.deepEqual(retry(unknown), { maxTokens: 65_536, contextWindow, evidence: 'unknown' });
  const smaller = diagnoseContextOverflow({
    httpStatus: 400,
    body: {
      error: {
        code: 'context_length_exceeded',
        context_window: 32_768,
        input_tokens: 20_000,
      },
    },
  });
  assert.deepEqual(retry(smaller), { maxTokens: 8_672, contextWindow: 32_768, evidence: 'exact' });
  assert.equal(
    retry({ ...unknown!, inputTokens: { kind: 'lower_bound', value: contextWindow } }),
    undefined,
    'output reduction cannot fix input that already fills the whole context',
  );
});

test('normal bad requests, transport failures, unbounded or incomplete bodies are not overflow admissions', () => {
  for (const httpStatus of [undefined, 200, 401, 403, 408, 413, 429, 500, 504])
    assert.equal(diagnoseContextOverflow({ httpStatus, body: lowerBoundBody }), undefined);
  for (const body of [
    { error: { code: 400, message: 'Invalid tool schema.' } },
    { error: { code: 'invalid_request_error', message: 'max_tokens must be a positive integer.' } },
    { error: { code: 'invalid_request_error', message: 'Request timed out.' } },
    {
      error: {
        code: 'context_length_exceeded',
        message: 'Rate limit: too many tokens per minute.',
      },
    },
    '400: context_length_exceeded',
    '{"error":{"code":"context_length_exceeded"',
    JSON.stringify({ ...lowerBoundBody, message: 'x'.repeat(MAX_CONTEXT_ERROR_BODY_BYTES) }),
    undefined,
    [],
  ])
    assert.equal(diagnoseContextOverflow({ httpStatus: 400, body }), undefined);
});

test('partial generation, cancellation and any completed corrective attempt prohibit another retry', () => {
  const baseline = {
    diagnostic: diagnoseContextOverflow({ httpStatus: 400, body: lowerBoundBody }),
    contextWindow,
    previousMaxTokens: 131_072,
    attempts: 0,
    generationStarted: false,
    aborted: false,
  };
  for (const patch of [
    { generationStarted: true },
    { aborted: true },
    { attempts: 1 },
    { attempts: 2 },
    { attempts: -1 },
    { attempts: NaN },
    { diagnostic: undefined },
    { previousMaxTokens: 1 },
  ])
    assert.equal(planContextOverflowRetry({ ...baseline, ...patch }), undefined);
});

test('invalid caller budgets fail explicitly instead of expanding output or hiding invalid estimates', () => {
  const input = { contextWindow, configuredMaxTokens: 131_072, estimatedInputTokens: 100_000 };
  for (const patch of [
    { contextWindow: 0 },
    { configuredMaxTokens: -1 },
    { requestedMaxTokens: 0 },
    { estimatedInputTokens: NaN },
    { estimatedInputTokens: Infinity },
    { estimatedInputTokens: -1 },
    { estimatedInputTokens: 1.5 },
    { inputEvidence: { kind: 'exact' as const, value: Number.MAX_SAFE_INTEGER + 1 } },
  ])
    assert.throws(() => planModelContextBudget({ ...input, ...patch }), RangeError);
});

const transportModel: Model<'openai-completions'> = {
  id: 'context-fixture',
  name: 'Context fixture',
  api: 'openai-completions',
  provider: 'loom-local',
  baseUrl: 'https://fixture.invalid',
  input: ['text'],
  reasoning: false,
  contextWindow,
  maxTokens: 131_072,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsUsageInStreaming: true, supportsFinishReason: true },
};

function providerRequest(transportFetch: typeof globalThis.fetch, observer: ModelStreamObserver) {
  return streamWithModelTimeouts(
    transportModel,
    { responseTimeoutMs: 2_000, idleTimeoutMs: 300 },
    new AbortController().signal,
    (options) =>
      stream(
        transportModel,
        normalizeContext({ messages: [{ role: 'user', content: 'Reply.', timestamp: 1 }] }),
        { ...options, apiKey: 'local-no-key', headers: { Authorization: null } },
      ),
    transportFetch,
    observer,
  );
}

function completion(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: transportModel.api,
    provider: transportModel.provider,
    model: transportModel.id,
    timestamp: 1,
    stopReason: 'stop',
    usage: {
      input: 0,
      output: 0,
      totalTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test('HTTP 400 observation preserves the consumed body and diagnoses only after its complete read', async () => {
  const original = JSON.stringify({
    ...lowerBoundBody,
    private_context: 'must-not-persist 日本語',
  });
  const bytes = new TextEncoder().encode(original);
  let offset = 0;
  let pulls = 0;
  let calls = 0;
  let dispatches = 0;
  const statuses: number[] = [];
  const diagnostics: ContextOverflowDiagnostic[] = [];
  let generated = 0;
  let consumption: Promise<void> | undefined;
  const response = streamWithModelTimeouts(
    transportModel,
    { responseTimeoutMs: 2_000, idleTimeoutMs: 300 },
    new AbortController().signal,
    (options) => {
      const events = createAssistantMessageEventStream();
      consumption = (async () => {
        const received = await options.fetch('https://fixture.invalid');
        await Promise.resolve();
        assert.deepEqual(statuses, [400]);
        assert.equal(pulls, 0, 'observing a response must not start reading it');
        assert.equal(diagnostics.length, 0);
        const reader = received.body!.getReader();
        const first = await reader.read();
        assert.equal(first.done, false);
        assert.equal(diagnostics.length, 0, 'a JSON prefix cannot authorize recovery');
        const parts: Uint8Array[] = [first.value!];
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          parts.push(next.value);
        }
        reader.releaseLock();
        assert.equal(Buffer.concat(parts).toString('utf8'), original);
      })();
      void consumption.then(
        () => {
          const message = completion();
          events.push({ type: 'done', reason: 'stop', message });
          events.end(message);
        },
        (error: unknown) => {
          const message = {
            ...completion(),
            stopReason: 'error' as const,
            errorMessage: String(error),
          };
          events.push({ type: 'error', reason: 'error', error: message });
          events.end(message);
        },
      );
      return events;
    },
    async () => {
      calls++;
      assert.equal(dispatches, 1, 'dispatch is observed immediately before transport starts');
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls++;
              if (offset === bytes.length) controller.close();
              else {
                controller.enqueue(bytes.slice(offset, offset + 7));
                offset = Math.min(offset + 7, bytes.length);
              }
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    },
    {
      onDispatch: () => {
        dispatches++;
        assert.equal(statuses.length, 0);
        assert.equal(pulls, 0);
      },
      onResponse: ({ status }) => statuses.push(status),
      onGenerationStarted: () => generated++,
      onContextOverflow: (diagnostic) => diagnostics.push(diagnostic),
    },
  );
  const result = await response.result();
  await consumption;
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.deepEqual(diagnostics, [
    diagnoseContextOverflow({ httpStatus: 400, body: lowerBoundBody }),
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /must-not-persist|日本語|message/);
  assert.equal(generated, 0);
  assert.equal(dispatches, 1);
  assert.equal(calls, 1);
});

test('cancellation before the fetch boundary neither dispatches nor spends a corrective attempt', async () => {
  const controller = new AbortController();
  let calls = 0;
  let dispatches = 0;
  const response = streamWithModelTimeouts(
    transportModel,
    { responseTimeoutMs: 2_000, idleTimeoutMs: 300 },
    controller.signal,
    (options) => {
      const events = createAssistantMessageEventStream();
      controller.abort();
      void options.fetch('https://fixture.invalid').then(
        () => assert.fail('An aborted request must not reach transport'),
        () => {
          const message = {
            ...completion(),
            stopReason: 'aborted' as const,
            errorMessage: 'Cancelled before dispatch.',
          };
          events.push({ type: 'error', reason: 'aborted', error: message });
          events.end(message);
        },
      );
      return events;
    },
    async () => {
      calls++;
      return Response.json({ error: lowerBoundBody }, { status: 400 });
    },
    { onDispatch: () => dispatches++ },
  );
  assert.equal((await response.result()).stopReason, 'aborted');
  assert.equal(dispatches, 0);
  assert.equal(calls, 0);
});

test('real Pi consumes a 400 rejection once and receives only numeric context diagnostics', async () => {
  let calls = 0;
  const statuses: number[] = [];
  const diagnostics: ContextOverflowDiagnostic[] = [];
  let generated = 0;
  const response = providerRequest(
    async () => {
      calls++;
      return Response.json({ error: lowerBoundBody }, { status: 400 });
    },
    {
      onResponse: ({ status }) => statuses.push(status),
      onGenerationStarted: () => generated++,
      onContextOverflow: (diagnostic) => diagnostics.push(diagnostic),
    },
  );
  const result = await response.result();
  assert.equal(result.stopReason, 'error');
  assert.deepEqual(statuses, [400]);
  assert.deepEqual(diagnostics, [
    diagnoseContextOverflow({ httpStatus: 400, body: lowerBoundBody }),
  ]);
  assert.equal(generated, 0);
  assert.equal(calls, 1, 'the transport observer itself never resends a request');
});

test('oversized, incomplete and unrelated HTTP errors never authorize an overflow correction', async () => {
  for (const [status, body] of [
    [
      400,
      JSON.stringify({
        ...lowerBoundBody,
        private_context: 'x'.repeat(MAX_CONTEXT_ERROR_BODY_BYTES),
      }),
    ],
    [400, JSON.stringify(lowerBoundBody).slice(0, -1)],
    [
      400,
      JSON.stringify({ error: { code: 'invalid_request_error', message: 'Invalid tool schema.' } }),
    ],
    [429, JSON.stringify(lowerBoundBody)],
    [500, JSON.stringify(lowerBoundBody)],
  ] as const) {
    let calls = 0;
    const diagnostics: ContextOverflowDiagnostic[] = [];
    const response = providerRequest(
      async () => {
        calls++;
        return new Response(body, { status, headers: { 'content-type': 'application/json' } });
      },
      { onContextOverflow: (diagnostic) => diagnostics.push(diagnostic) },
    );
    const result = await response.result();
    assert.equal(result.stopReason, 'error');
    assert.deepEqual(diagnostics, [], `HTTP ${status} must retain its original failure path`);
    assert.equal(calls, 1);
  }
});

test('successful SSE text resembling an overflow error is generation, not recovery evidence', async () => {
  const content = JSON.stringify(lowerBoundBody);
  const event = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: 'context-fixture',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const statuses: number[] = [];
  const diagnostics: ContextOverflowDiagnostic[] = [];
  let generated = 0;
  const response = providerRequest(
    async () =>
      new Response(
        ': queued\n\n' +
          event({ role: 'assistant', content: '' }) +
          event({ content: content.slice(0, 50) }) +
          event({ content: content.slice(50) }) +
          event({}, 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    {
      onResponse: ({ status }) => statuses.push(status),
      onGenerationStarted: () => generated++,
      onContextOverflow: (diagnostic) => diagnostics.push(diagnostic),
    },
  );
  for await (const event of response) {
    if (event.type === 'text_delta' && event.delta) assert.equal(generated, 1);
  }
  const result = await response.result();
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.deepEqual(result.content, [{ type: 'text', text: content }]);
  assert.deepEqual(statuses, [200]);
  assert.deepEqual(diagnostics, []);
  assert.equal(generated, 1);
});

test('role-only chunks and failed HTTP error-body reads never establish generation or an admission failure', async () => {
  let generated = 0;
  const diagnostics: ContextOverflowDiagnostic[] = [];
  const observer: ModelStreamObserver = {
    onGenerationStarted: () => generated++,
    onContextOverflow: (diagnostic) => diagnostics.push(diagnostic),
  };
  const roleOnly = providerRequest(
    async () =>
      new Response(
        `data: ${JSON.stringify({
          id: 'context-fixture',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    observer,
  );
  assert.equal((await roleOnly.result()).stopReason, 'stop');
  let pulls = 0;
  const interrupted = providerRequest(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (pulls++ === 0)
                controller.enqueue(new TextEncoder().encode(JSON.stringify(lowerBoundBody)));
              else controller.error(new Error('The HTTP error body did not finish.'));
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    observer,
  );
  assert.equal((await interrupted.result()).stopReason, 'error');
  assert.equal(generated, 0);
  assert.deepEqual(diagnostics, []);
});
