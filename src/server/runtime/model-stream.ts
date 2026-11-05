import { EventEmitter } from 'node:events';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';
import { Client, EnvHttpProxyAgent, Pool, fetch as undiciFetch } from 'undici';
import { DEFAULT_MODEL_TIMEOUTS } from '../../shared/model-settings.js';
import type { ModelSettings } from '../../shared/types.js';

// OpenAI's SDK treats zero as an immediate timeout. Loom owns the actual
// response/idle budgets below, including streams whose headers arrive early.
export const MODEL_PROVIDER_TIMEOUT_MS = 2_147_483_647;

export interface ModelRequestTimeouts {
  responseTimeoutMs: number;
  idleTimeoutMs: number;
}

interface ModelRequestOptions {
  signal: AbortSignal;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  maxRetries: 0;
}

export function modelRequestTimeouts(model: ModelSettings): ModelRequestTimeouts {
  return {
    responseTimeoutMs:
      (model.responseTimeoutSeconds ?? DEFAULT_MODEL_TIMEOUTS.responseTimeoutSeconds) * 1_000,
    idleTimeoutMs: (model.idleTimeoutSeconds ?? DEFAULT_MODEL_TIMEOUTS.idleTimeoutSeconds) * 1_000,
  };
}

// Undici may emit an internal Client error while an aborted response body is
// being cleaned up. The stream still rejects; this prevents an unhandled
// EventEmitter error from terminating the whole Loom process.
function observeTransport<T extends EventEmitter>(transport: T): T {
  EventEmitter.prototype.on.call(transport, 'error', () => {});
  return transport;
}

function createClient(origin: URL, options: object) {
  return observeTransport(new Client(origin, options));
}

function createTransport(): EnvHttpProxyAgent {
  return observeTransport(
    new EnvHttpProxyAgent({
      allowH2: false,
      proxyTunnel: true,
      // Native fetch has its own five-minute defaults. Use the matching Undici
      // fetch and disable only this request's lower-level response/body clocks.
      headersTimeout: 0,
      bodyTimeout: 0,
      connect: { timeout: 10_000, autoSelectFamilyAttemptTimeout: 2_000 },
      clientFactory: createClient,
      factory: (origin, options) =>
        observeTransport(new Pool(origin, { ...options, factory: createClient })),
    }),
  );
}

function isGenerationProgress(event: AssistantMessageEvent): boolean {
  if (
    event.type === 'text_delta' ||
    event.type === 'thinking_delta' ||
    event.type === 'toolcall_delta'
  )
    return event.delta.length > 0;
  if (event.type === 'toolcall_start') {
    const block = event.partial.content[event.contentIndex];
    return block?.type === 'toolCall' && Boolean(block.name || block.id);
  }
  // Headers, empty role chunks, and SSE heartbeats do not establish that a
  // request has left the inference server's own queue or finished prefill.
  return false;
}

function failure(
  model: Model<string>,
  partial: AssistantMessage | undefined,
  message: string,
  aborted: boolean,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      totalTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...partial,
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: message,
  };
}

/** Call only after acquiring Loom's inference slot, so local waits use no budget. */
export function streamWithModelTimeouts(
  model: Model<string>,
  timeouts: ModelRequestTimeouts,
  callerSignal: AbortSignal,
  start: (options: ModelRequestOptions) => AssistantMessageEventStream,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const cancellation = new AbortController();
    const signal = AbortSignal.any([callerSignal, cancellation.signal]);
    let dispatcher: EnvHttpProxyAgent | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeoutMessage: string | undefined;
    let partial: AssistantMessage | undefined;
    let interrupted: AssistantMessage | undefined;
    let terminal: Extract<AssistantMessageEvent, { type: 'done' | 'error' }> | undefined;
    const preservePartial = () => {
      // Pi mutates its partial message as chunks arrive. A late chunk after
      // cancellation must not silently extend the preserved answer.
      interrupted = partial ? structuredClone(partial) : undefined;
      // The provider normally strips its parsing buffers before publishing a
      // terminal event. A snapshot taken during parsing needs the same cleanup.
      for (const block of interrupted?.content ?? []) {
        const parsing = block as unknown as Record<string, unknown>;
        delete parsing.index;
        delete parsing.partialArgs;
        delete parsing.customInput;
        delete parsing.streamIndex;
      }
    };
    signal.addEventListener('abort', preservePartial, { once: true });
    const arm = (phase: 'response' | 'idle') => {
      clearTimeout(timer);
      const milliseconds =
        phase === 'response' ? timeouts.responseTimeoutMs : timeouts.idleTimeoutMs;
      timer = setTimeout(() => {
        if (callerSignal.aborted) return;
        const seconds = milliseconds / 1_000;
        timeoutMessage =
          phase === 'response'
            ? `The model did not begin responding within ${seconds} seconds after starting the request. It may be waiting in the inference server's queue, loading a model, or processing the prompt. Increase the response wait timeout in Settings or reduce concurrent generation. This request was not retried automatically.`
            : `The model stopped producing output for ${seconds} seconds. The partial response is preserved. Increase the generation idle timeout in Settings if the model legitimately pauses this long. This request was not retried automatically.`;
        cancellation.abort();
      }, milliseconds);
      timer.unref();
    };
    try {
      callerSignal.throwIfAborted();
      for (const milliseconds of [timeouts.responseTimeoutMs, timeouts.idleTimeoutMs])
        if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 86_400_000)
          throw new Error(
            'Model response and idle timeouts must be positive and at most 24 hours.',
          );
      dispatcher = createTransport();
      const fetch: typeof globalThis.fetch = (input, init) =>
        undiciFetch(
          input as Parameters<typeof undiciFetch>[0],
          {
            ...init,
            dispatcher,
          } as Parameters<typeof undiciFetch>[1],
        ) as unknown as Promise<Response>;
      arm('response');
      const underlying = start({
        signal,
        fetch,
        timeoutMs: MODEL_PROVIDER_TIMEOUT_MS,
        maxRetries: 0,
      });
      for await (const event of underlying) {
        if (event.type === 'done' || event.type === 'error') {
          clearTimeout(timer);
          terminal = event;
          if (!signal.aborted) partial = event.type === 'done' ? event.message : event.error;
        } else {
          if (signal.aborted) continue;
          partial = event.partial;
          if (isGenerationProgress(event)) arm('idle');
          stream.push(event);
        }
      }
      const result = await underlying.result();
      if (!terminal) {
        partial = result;
        throw new Error('The model stream ended without a completion event.');
      }
      if (timeoutMessage && !callerSignal.aborted) {
        const error = failure(model, interrupted, timeoutMessage, false);
        terminal = { type: 'error', reason: 'error', error };
      } else if (callerSignal.aborted) {
        const error = failure(
          model,
          interrupted,
          result.errorMessage || 'The model request was cancelled.',
          true,
        );
        terminal = { type: 'error', reason: 'aborted', error };
      }
    } catch (error) {
      const aborted = callerSignal.aborted;
      const detail =
        !aborted && timeoutMessage
          ? timeoutMessage
          : error instanceof Error
            ? error.message
            : String(error);
      terminal = {
        type: 'error',
        reason: aborted ? 'aborted' : 'error',
        error: failure(model, signal.aborted ? interrupted : partial, detail, aborted),
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', preservePartial);
      // Await cleanup before publishing the terminal event: the caller may
      // release its inference slot as soon as it receives that event.
      await dispatcher?.destroy().catch(() => {});
    }
    if (terminal) {
      stream.push(terminal);
      stream.end(terminal.type === 'done' ? terminal.message : terminal.error);
    }
  })();
  return stream;
}
