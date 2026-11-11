import {
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
  toToolDeclaration,
  type AssistantMessage,
  type Message,
  type Model,
  type TranscriptContext,
  type Usage,
} from '@earendil-works/pi-ai';
import { estimateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import {
  buildSessionProjection,
  convertToLlm,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';

export interface ReasoningContextOptions {
  branch?: SessionEntry[];
  /** Compare original and candidate text without using historical usage anchors. */
  comparison?: boolean;
}

export interface PreparedReasoningContext {
  transcript: TranscriptContext;
  estimatedInputTokens: number;
  /** Only the validated latest response's reported reasoning, never a text estimate. */
  excludedReasoningTokens: number;
  /** True only for a usable provider-usage correction, not a text-only projection. */
  corrected: boolean;
  projectedThinkingBlocks: number;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function sameModel(message: AssistantMessage, model: Model<string>): boolean {
  return (
    message.api === model.api && message.provider === model.provider && message.model === model.id
  );
}

/** This narrow profile follows Pi 1.5.2's OpenAI-completions conversion. */
function supported(model: Model<string>, messages: Message[]): boolean {
  if (model.api !== 'openai-completions' || model.provider !== 'loom-local') return false;
  // An image-capability change can add a tool/pixel budget that the old provider
  // input anchor never saw. Optimize only Loom's fully text-only request view.
  if (model.input.length !== 1 || model.input[0] !== 'text') return false;
  if (getCurrentTools(messages).some((tool) => tool.name === 'view_image')) return false;
  const compat = (model as Model<'openai-completions'>).compat;
  // Pi's detected defaults for these flags are false. Do not reproduce its
  // broader URL/provider compatibility resolver or assume future transports.
  for (const flag of [
    compat?.requiresThinkingAsText,
    compat?.supportsMidConvoSystemMessages,
    compat?.supportsMidConvoToolAdditions,
    compat?.supportsOpenAIGrammarTools,
  ])
    if (flag !== undefined && flag !== false) return false;
  return !messages.some(
    (message) =>
      (message.role === 'user' || message.role === 'toolResult') &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image'),
  );
}

function reasoningEvidence(message: AssistantMessage, model: Model<string>): number | undefined {
  if (!sameModel(message, model) || !['stop', 'toolUse'].includes(message.stopReason)) return;
  const usage = message.usage;
  if (
    !count(usage.reasoning) ||
    usage.reasoning === 0 ||
    !count(usage.output) ||
    usage.reasoning > usage.output
  )
    return;
  // A raw reasoning-field signature replays all of this message's thinking.
  // Structured/encrypted signatures and tool thought signatures can also replay
  // reasoning. Unknown metadata therefore keeps the original accounting.
  if (
    message.content.some(
      (part) =>
        (part.type === 'thinking' && (Boolean(part.thinkingSignature) || Boolean(part.redacted))) ||
        (part.type === 'toolCall' && Boolean(part.thoughtSignature)),
    )
  )
    return;
  return usage.reasoning;
}

function unusedUsage(usage: Usage): Usage {
  return {
    ...usage,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: 0 }),
    reasoning: 0,
    totalTokens: 0,
    // Cost is historical billing data, not an input-size hint.
    cost: usage.cost,
  };
}

function withoutUsage(messages: Message[]): TranscriptContext {
  return normalizeContext({
    messages: messages.map((message) =>
      message.role === 'assistant' ? { ...message, usage: unusedUsage(message.usage) } : message,
    ),
  });
}

function projectMessage(message: Message, model: Model<string>): Message {
  if (message.role !== 'assistant' || reasoningEvidence(message, model) === undefined)
    return message;
  return { ...message, content: message.content.filter((part) => part.type !== 'thinking') };
}

function prefixKey(messages: Message[], model: Model<string>): string {
  const projected = messages.map((message) => projectMessage(message, model));
  return JSON.stringify({
    system: getCurrentSystemPrompt(projected),
    tools: getCurrentTools(projected).map(toToolDeclaration),
    messages: projected.flatMap<Record<string, unknown>>((message) => {
      if (message.role === 'system') return [];
      if (message.role === 'assistant')
        return [
          {
            role: message.role,
            content: message.content,
            api: message.api,
            provider: message.provider,
            model: message.model,
            stopReason: message.stopReason,
          },
        ];
      if (message.role === 'toolResult')
        return [
          {
            role: message.role,
            content: message.content,
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            isError: message.isError,
          },
        ];
      return [{ role: message.role, content: message.content }];
    }),
  });
}

function isAnchorCopy(message: AssistantMessage, candidate: Message): boolean {
  if (message === candidate) return true;
  return (
    candidate.role === 'assistant' &&
    candidate.timestamp === message.timestamp &&
    candidate.api === message.api &&
    candidate.provider === message.provider &&
    candidate.model === message.model &&
    candidate.stopReason === message.stopReason &&
    JSON.stringify(candidate.content) === JSON.stringify(message.content) &&
    JSON.stringify(candidate.usage) === JSON.stringify(message.usage)
  );
}

function compatiblePrefix(
  branch: SessionEntry[] | undefined,
  messages: Message[],
  anchorIndex: number,
  model: Model<string>,
): boolean {
  if (!branch) return false;
  const anchor = messages[anchorIndex] as AssistantMessage;
  const matches: number[] = [];
  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index];
    if (entry.type === 'message' && isAnchorCopy(anchor, entry.message as Message))
      matches.push(index);
  }
  if (matches.length !== 1) return false;
  const entryIndex = matches[0];
  if (
    branch
      .slice(entryIndex + 1)
      .some(
        (entry) =>
          entry.type === 'compaction' ||
          entry.type === 'context_edit' ||
          entry.type === 'model_change',
      )
  )
    return false;
  // Loom keeps internal declarations in its branch, but its text-only request
  // projection omits view_image. Apply only that known omission to the reference;
  // never rewrite historical pixels or disguise any other changed declarations.
  const previousInput = convertToLlm(
    buildSessionProjection(branch.slice(0, entryIndex)).messages,
  ).map((message) =>
    message.role === 'system'
      ? {
          ...message,
          ...(message.toolsAdded
            ? { toolsAdded: message.toolsAdded.filter((tool) => tool.name !== 'view_image') }
            : {}),
          ...(message.toolsRemoved
            ? { toolsRemoved: message.toolsRemoved.filter((tool) => tool.name !== 'view_image') }
            : {}),
        }
      : message,
  );
  return prefixKey(previousInput, model) === prefixKey(messages.slice(0, anchorIndex), model);
}

/**
 * Prepare a request-only budget view. Canonical content, operation receipts,
 * provider usage, cache accounting and costs are never mutated or persisted.
 * A missing/ambiguous proof keeps Pi's original conservative estimate.
 */
export function prepareReasoningContext(
  model: Model<string>,
  context: TranscriptContext,
  options: ReasoningContextOptions = {},
): PreparedReasoningContext {
  const eligible = supported(model, context.messages);
  const projected = eligible
    ? context.messages.map((message) => projectMessage(message, model))
    : context.messages;
  const projectedThinkingBlocks = context.messages.reduce(
    (total, message, index) =>
      total +
      (message.role === 'assistant'
        ? message.content.length - (projected[index] as AssistantMessage).content.length
        : 0),
    0,
  );
  const comparison = withoutUsage(projected);
  const fullEstimate = estimateContextTokens(comparison).tokens;
  if (options.comparison)
    return {
      transcript: comparison,
      estimatedInputTokens: fullEstimate,
      excludedReasoningTokens: 0,
      corrected: false,
      projectedThinkingBlocks,
    };
  const fallback = (): PreparedReasoningContext => ({
    transcript: context,
    estimatedInputTokens: estimateContextTokens(context).tokens,
    excludedReasoningTokens: 0,
    corrected: false,
    projectedThinkingBlocks: 0,
  });
  if (!eligible) return fallback();
  const anchorIndex = context.messages.findLastIndex((message) => message.role === 'assistant');
  if (anchorIndex < 0) return fallback();
  const anchor = context.messages[anchorIndex] as AssistantMessage;
  const reasoning = reasoningEvidence(anchor, model);
  if (
    reasoning === undefined ||
    !compatiblePrefix(options.branch, context.messages, anchorIndex, model)
  )
    return fallback();
  const usage = anchor.usage;
  if (
    ![usage.input, usage.cacheRead, usage.cacheWrite, usage.output, usage.totalTokens].every(count)
  )
    return fallback();
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  const reportedTotal = input + usage.output;
  if (
    !count(input) ||
    input === 0 ||
    !count(reportedTotal) ||
    (usage.totalTokens !== 0 && usage.totalTokens !== reportedTotal)
  )
    return fallback();
  const trailingTokens = projected
    .slice(anchorIndex + 1)
    .reduce((total, message) => total + estimateMessageTokens(message), 0);
  const adjusted = reportedTotal - reasoning + trailingTokens;
  const estimatedInputTokens = Math.max(adjusted, fullEstimate);
  if (!count(estimatedInputTokens)) return fallback();
  const messages = comparison.messages.map((message, index) =>
    index === anchorIndex
      ? ({
          ...message,
          usage: {
            ...usage,
            output: usage.output - reasoning,
            reasoning: 0,
            // Pi prefers totalTokens as its footprint hint. The full-text lower floor
            // can be larger than the adjusted usage components; retain that safeguard
            // in this transient hint so Pi's second clamp cannot restore the old count.
            totalTokens: estimatedInputTokens - trailingTokens,
            cost: usage.cost,
          },
        } as AssistantMessage)
      : message,
  );
  return {
    transcript: normalizeContext({ messages }),
    estimatedInputTokens,
    excludedReasoningTokens: reasoning,
    corrected: true,
    projectedThinkingBlocks,
  };
}
