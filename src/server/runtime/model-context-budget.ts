/** Server token counts apply only to the exact request that produced the rejection. */
export interface ModelInputTokenEvidence {
  kind: 'exact' | 'lower_bound';
  value: number;
}

export interface ModelContextBudgetInput {
  contextWindow: number;
  configuredMaxTokens: number;
  requestedMaxTokens?: number;
  estimatedInputTokens: number;
  inputEvidence?: ModelInputTokenEvidence;
}

export interface ModelContextBudget {
  /** Undefined means no output fits the guarded estimate; do not send a one-token fallback. */
  maxTokens: number | undefined;
  estimatedInputTokens: number;
  /** Conservative planning basis, not a claim of tokenizer measurement. */
  inputTokens: number;
  safetyTokens: number;
  inputEvidence?: ModelInputTokenEvidence;
}

export interface ContextOverflowDiagnostic {
  kind: 'context_overflow';
  httpStatus: 400;
  contextWindow?: number;
  inputTokens?: ModelInputTokenEvidence;
  requestedMaxTokens?: number;
}

export interface ContextOverflowRetryInput {
  diagnostic: ContextOverflowDiagnostic | undefined;
  contextWindow: number;
  /** The previous wire limit when available, otherwise its conservative caller cap. */
  previousMaxTokens: number;
  /** Completed corrective attempts for this request, not Pi's general retry counter. */
  attempts: number;
  generationStarted: boolean;
  aborted: boolean;
}

export interface ContextOverflowRetryBudget {
  maxTokens: number;
  contextWindow: number;
  evidence: 'exact' | 'lower_bound' | 'unknown';
}

export const MAX_CONTEXT_ERROR_BODY_BYTES = 65_536;
const FIXED_MARGIN = 4_096;

function tokenCount(value: number, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(`${name} must be a safe integer of at least ${minimum}.`);
  return value;
}

/** Keep Pi's 15% uncertainty allowance even when it leaves less than 32K output. */
export function contextSafetyTokens(contextWindow: number, inputTokens: number): number {
  tokenCount(contextWindow, 'contextWindow', 1);
  tokenCount(inputTokens, 'inputTokens');
  // Split the arithmetic so even a valid large integer cannot overflow on ×15.
  const proportional =
    Math.floor(inputTokens / 100) * 15 + Math.ceil(((inputTokens % 100) * 15) / 100);
  // A fixed 4K allowance would leave no usable input in a supported 2K context.
  const fixed = Math.min(FIXED_MARGIN, Math.floor(contextWindow / 4));
  return Math.max(fixed, proportional);
}

/**
 * Fit a single request without changing the saved model configuration. The
 * estimate and margin are safeguards, not exact tokenization or a fit guarantee.
 */
export function planModelContextBudget(input: ModelContextBudgetInput): ModelContextBudget {
  const contextWindow = tokenCount(input.contextWindow, 'contextWindow', 1);
  const configured = tokenCount(input.configuredMaxTokens, 'configuredMaxTokens', 1);
  const requested =
    input.requestedMaxTokens === undefined
      ? configured
      : tokenCount(input.requestedMaxTokens, 'requestedMaxTokens', 1);
  const estimatedInputTokens = tokenCount(input.estimatedInputTokens, 'estimatedInputTokens');
  const evidence = input.inputEvidence;
  if (evidence && !['exact', 'lower_bound'].includes(evidence.kind))
    throw new RangeError('Input evidence must distinguish exact counts from lower bounds.');
  const inputTokens = Math.max(
    estimatedInputTokens,
    evidence ? tokenCount(evidence.value, 'inputEvidence.value') : 0,
  );
  const safetyTokens = contextSafetyTokens(contextWindow, inputTokens);
  const available = contextWindow - inputTokens - safetyTokens;
  return {
    maxTokens: available >= 1 ? Math.min(configured, requested, available) : undefined,
    estimatedInputTokens,
    inputTokens,
    safetyTokens,
    ...(evidence ? { inputEvidence: { ...evidence } } : {}),
  };
}

/** Largest estimated input that leaves the requested output and the same margin. */
export function maxModelInputTokens(contextWindow: number, maxTokens: number): number {
  tokenCount(contextWindow, 'contextWindow', 1);
  tokenCount(maxTokens, 'maxTokens', 1);
  const remaining = contextWindow - maxTokens;
  if (remaining <= 0) return 0;
  const fixedLimit = remaining - contextSafetyTokens(contextWindow, 0);
  // floor(remaining * 100 / 115), avoiding unsafe intermediate multiplication.
  const ratioLimit =
    Math.floor(remaining / 115) * 100 + Math.floor(((remaining % 115) * 100) / 115);
  return Math.max(0, Math.min(fixedLimit, ratioLimit));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function reportedCount(value: unknown, minimum = 1): number | undefined {
  const count =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value)
        ? Number(value.replaceAll(',', ''))
        : NaN;
  return Number.isSafeInteger(count) && count >= minimum ? count : undefined;
}

function firstCount(message: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const value = reportedCount(pattern.exec(message)?.[1]);
    if (value !== undefined) return value;
  }
  return undefined;
}

const OVERFLOW_CODES = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'model_context_window_exceeded',
  'exceed_context_size_error',
  'prompt_too_long',
]);

/**
 * Classify a bounded HTTP error body, never an SDK message that merely mentions
 * "400". The caller must supply the actual response status and a complete body.
 * Only numeric diagnostics escape this function; provider text can contain data.
 */
export function diagnoseContextOverflow(input: {
  httpStatus: number | undefined;
  body: unknown;
}): ContextOverflowDiagnostic | undefined {
  if (input.httpStatus !== 400) return;
  let body = input.body;
  if (typeof body === 'string') {
    if (new TextEncoder().encode(body).byteLength > MAX_CONTEXT_ERROR_BODY_BYTES) return;
    try {
      body = JSON.parse(body);
    } catch {
      return;
    }
  }
  const outer = record(body);
  const error = record(outer?.error) ?? outer;
  if (!error) return;
  const message = typeof error.message === 'string' ? error.message : '';
  if (message.length > MAX_CONTEXT_ERROR_BODY_BYTES) return;
  // These are not rejected prompt-size admissions, even if they mention tokens.
  if (/rate[ -]?limit|too many requests|quota|tokens? per minute|\bTPM\b/i.test(message)) return;
  const knownCode = [error.code, error.type].some(
    (value) => typeof value === 'string' && OVERFLOW_CODES.has(value.toLowerCase()),
  );
  const explicitOverflow =
    /(?:exceeds?|exceeded|too (?:long|large)|maximum context length[^.]*\.\s*However, you requested)/i.test(
      message,
    ) && /(?:context (?:length|window|size)|prompt.{0,30}too long)/i.test(message);
  if (!knownCode && !explicitOverflow) return;

  const contextWindow =
    reportedCount(error.context_window) ??
    reportedCount(error.max_context_length) ??
    firstCount(message, [
      /maximum context length (?:is|of)\s+([\d,]+)\s+tokens/i,
      /maximum context length\s*\(([\d,]+)\)/i,
      /context length\s*\(([\d,]+)(?:\s+tokens)?\)/i,
      /configured context size is\s+([\d,]+)\s+tokens/i,
    ]);
  const lowerBound =
    reportedCount(error.input_tokens_lower_bound, 0) ??
    firstCount(message, [
      /(?:prompt|request|input).{0,40}(?:contains|has)\s+at least\s+([\d,]+)\s+(?:input\s+)?tokens/i,
      /at least\s+([\d,]+)\s+(?:input|prompt) tokens/i,
      /(?:input|prompt) tokens?\s*[:=]\s*at least\s+([\d,]+)/i,
    ]);
  const exactInput =
    reportedCount(error.input_tokens, 0) ??
    reportedCount(error.prompt_tokens, 0) ??
    reportedCount(error.n_prompt_tokens, 0) ??
    firstCount(message, [
      /(?:prompt|request|input).{0,40}(?:contains|has)\s+([\d,]+)\s+(?:input\s+)?tokens/i,
      /\(([\d,]+)\s+in the (?:messages|prompt)/i,
      /([\d,]+)\s+tokens from the input messages/i,
      /input length\s*\(([\d,]+)\)/i,
      /input\s*\(([\d,]+)\s+tokens\)/i,
      /prompt (?:is )?too long:\s*([\d,]+)\s+tokens/i,
      /prompt has\s+([\d,]+)\s+tokens/i,
    ]);
  // A validator can stop counting at a threshold. Its value is not the actual
  // input, including when the same lower bound appears in a numeric JSON field.
  const qualified = /\bat least\b|\blower bound\b/i.test(message);
  const count = lowerBound ?? exactInput;
  const inputTokens: ModelInputTokenEvidence | undefined =
    count === undefined
      ? undefined
      : {
          kind:
            lowerBound !== undefined || qualified || error.input_tokens_is_lower_bound === true
              ? 'lower_bound'
              : 'exact',
          value: count,
        };
  const requestedMaxTokens =
    reportedCount(error.max_tokens) ??
    reportedCount(error.max_completion_tokens) ??
    firstCount(message, [
      /you requested\s+([\d,]+)\s+output tokens/i,
      /([\d,]+)\s+in the completion/i,
      /([\d,]+)\s+tokens for the completion/i,
      /max_tokens.*?too large:\s*([\d,]+)/i,
    ]);
  return {
    kind: 'context_overflow',
    httpStatus: 400,
    ...(contextWindow ? { contextWindow } : {}),
    ...(inputTokens ? { inputTokens } : {}),
    ...(requestedMaxTokens ? { requestedMaxTokens } : {}),
  };
}

/**
 * One corrective attempt for a confirmed pre-generation rejection. Lower bounds
 * cannot establish the available space: halve output as a bounded probe instead.
 * A second rejection must reach compaction/failure, never this same retry again.
 */
export function planContextOverflowRetry(
  input: ContextOverflowRetryInput,
): ContextOverflowRetryBudget | undefined {
  const diagnostic = input.diagnostic;
  if (
    !diagnostic ||
    diagnostic.kind !== 'context_overflow' ||
    diagnostic.httpStatus !== 400 ||
    input.attempts !== 0 ||
    input.generationStarted ||
    input.aborted
  )
    return;
  const configuredContext = tokenCount(input.contextWindow, 'contextWindow', 1);
  const previous = Math.min(
    tokenCount(input.previousMaxTokens, 'previousMaxTokens', 1),
    diagnostic.requestedMaxTokens ?? input.previousMaxTokens,
  );
  const contextWindow = Math.min(configuredContext, diagnostic.contextWindow ?? configuredContext);
  const evidence = diagnostic.inputTokens?.kind ?? 'unknown';
  const count = diagnostic.inputTokens?.value ?? 0;
  const room = contextWindow - count - contextSafetyTokens(contextWindow, count);
  const maxTokens = Math.min(
    previous - 1,
    room,
    evidence === 'exact' ? previous : Math.floor(previous / 2),
  );
  if (maxTokens < 1) return;
  return { maxTokens, contextWindow, evidence };
}
