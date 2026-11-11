import { randomUUID } from 'node:crypto';
import {
  getCurrentSystemMessage,
  normalizeContext,
  type AssistantMessage,
  type TranscriptContext,
  type Usage,
} from '@earendil-works/pi-ai';
import {
  buildSessionProjection,
  convertToLlm,
  generateSummaryWithUsage,
  getLatestCompactionEntry,
  type AgentSession,
  type CompactionEntry,
  type CompactionResult,
  type FileOperations,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';

type SummaryArguments = Parameters<typeof generateSummaryWithUsage>;
type SummaryStream = NonNullable<SummaryArguments[9]>;
type RepairSession = Pick<
  AgentSession,
  'sessionManager' | 'isStreaming' | 'refreshContext' | 'compact'
>;
const unusedUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface ContextCompactionOptions {
  model: SummaryArguments[1];
  /** Input capacity after reserving the next answer and the request safety margin. */
  maxInputTokens: number;
  measure(context: TranscriptContext): number | Promise<number>;
  stream: SummaryStream;
  /** Include pending inputs, live image projection, system instructions, and tool schemas. */
  project?(branch: SessionEntry[]): TranscriptContext | Promise<TranscriptContext>;
  /** Omit only proven unreplayed reasoning from measurement copies, before usage is zeroed. */
  prepareMeasurement?(
    context: TranscriptContext,
    branch: SessionEntry[],
  ): TranscriptContext | Promise<TranscriptContext>;
  /** An intentional threshold skip must account for the full projected next input. */
  decideThreshold?(
    context: TranscriptContext,
    branch: SessionEntry[],
  ): { skip: boolean } | Promise<{ skip: boolean }>;
  getCurrentBranch?(): SessionEntry[];
  thinkingLevel?: SummaryArguments[8];
  signal?: AbortSignal;
  sessionId?: string;
  /** Ordinary compaction has passed its checks and is about to generate a summary. */
  onStart?(): void;
  onRepair?(event: {
    phase: 'start' | 'end';
    beforeTokens?: number;
    afterTokens?: number;
    targetTokens?: number;
    error?: string;
  }): void;
}

interface FileLists {
  readFiles: string[];
  modifiedFiles: string[];
}

interface SummaryPlan {
  mode: 'compact' | 'repair';
  branch: SessionEntry[];
  firstKeptEntryId: string;
  messages: SummaryArguments[0];
  previousSummary?: string;
  customInstructions?: string;
  details?: unknown;
  files: FileLists;
  signal?: AbortSignal;
  getCurrentBranch?(): SessionEntry[];
  beforeTokens: number;
  retainedTokens: number;
  onGenerationStart?(targetTokens: number): void;
}

function fileLists(fileOps: FileOperations): FileLists {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return {
    readFiles: [...fileOps.read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function objectDetails(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : value === undefined
      ? {}
      : { previousDetails: value };
}

function previousFileLists(details: unknown): FileLists {
  const value = objectDetails(details);
  const strings = (items: unknown) =>
    Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : [];
  return { readFiles: strings(value.readFiles), modifiedFiles: strings(value.modifiedFiles) };
}

function fileFooter(files: FileLists): string {
  const sections: string[] = [];
  if (files.readFiles.length) {
    sections.push(`<read-files>\n${files.readFiles.join('\n')}\n</read-files>`);
  }
  if (files.modifiedFiles.length) {
    sections.push(`<modified-files>\n${files.modifiedFiles.join('\n')}\n</modified-files>`);
  }
  return sections.length ? `\n\n${sections.join('\n\n')}` : '';
}

function addUsage(left: Usage | undefined, right: Usage): Usage {
  if (!left) return right;
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...((left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined) && {
      cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0),
    }),
    ...((left.reasoning !== undefined || right.reasoning !== undefined) && {
      reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0),
    }),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
      totalFromProvider:
        left.cost.totalFromProvider === true && right.cost.totalFromProvider === true,
    },
  };
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Context compaction was cancelled.', 'AbortError');
}

function assertUnchanged(branch: SessionEntry[], getCurrentBranch?: () => SessionEntry[]): void {
  if (!getCurrentBranch) return;
  const current = getCurrentBranch();
  if (
    current.length !== branch.length ||
    current.some((entry, index) => entry.id !== branch[index]?.id)
  ) {
    throw new Error('The session changed during compaction; the previous context is preserved.');
  }
}

/**
 * Pi owns ordinary compaction persistence. This hook returns only validated candidates,
 * and the separate repair path handles old summaries for which Pi has no removable tail.
 */
export function createContextCompaction(options: ContextCompactionOptions) {
  if (!Number.isFinite(options.maxInputTokens) || options.maxInputTokens <= 0) {
    throw new Error('Compaction requires a positive model input budget.');
  }
  const maxInputTokens = Math.floor(options.maxInputTokens);
  const project =
    options.project ??
    ((branch: SessionEntry[]) =>
      normalizeContext({ messages: convertToLlm(buildSessionProjection(branch).messages) }));
  let failure: Error | undefined;
  let inProgress = false;
  let delegating = false;
  let thresholdSkipped = false;
  let thresholdSkipSignal: AbortSignal | undefined;

  const throwIfFailed = () => {
    if (failure) throw failure;
  };
  const takeThresholdSkipped = () => {
    const skipped = thresholdSkipped && !failure && !thresholdSkipSignal?.aborted;
    thresholdSkipped = false;
    thresholdSkipSignal = undefined;
    return skipped;
  };
  const measure = async (branch: SessionEntry[]) => {
    const projected = await project(branch);
    const transcript = options.prepareMeasurement
      ? await options.prepareMeasurement(projected, branch)
      : projected;
    // Old response usage describes a different prefix, and can include reasoning
    // that is not replayed. Compare original and candidate with the same estimator
    // instead of mixing historical usage with a fresh summary's text estimate.
    // These copies are for measurement only; the session log is never rewritten.
    const count = await options.measure(
      normalizeContext({
        messages: transcript.messages.map((message) =>
          message.role === 'assistant' ? { ...message, usage: unusedUsage } : message,
        ),
      }),
    );
    if (!Number.isFinite(count) || count < 0) {
      throw new Error('The model input token estimate is invalid; compaction was not saved.');
    }
    return Math.ceil(count);
  };
  const candidate = (branch: SessionEntry[], firstKeptEntryId: string, summary: string) => {
    if (!branch.some((entry) => entry.id === firstKeptEntryId)) {
      throw new Error(
        'The retained compaction boundary is missing; the previous context is preserved.',
      );
    }
    const projection = buildSessionProjection(branch);
    const systemMessage = getCurrentSystemMessage(convertToLlm(projection.messages));
    const timestamp = Date.now();
    const entry: CompactionEntry = {
      type: 'compaction',
      id: `loom-compaction-candidate-${randomUUID()}`,
      parentId: branch.at(-1)?.id ?? null,
      timestamp: new Date(timestamp).toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore: 0,
      fromHook: true,
      ...(systemMessage && { systemMessage: { ...systemMessage, timestamp } }),
    };
    return [...branch, entry];
  };

  const generate = async (plan: SummaryPlan, targetTokens: number, attempt: number) => {
    let responsePromise: Promise<AssistantMessage> | undefined;
    const observingStream: SummaryStream = async (model, context, streamOptions) => {
      const stream = await options.stream(model, context, streamOptions);
      responsePromise = stream.result();
      return stream;
    };
    const instructions = [
      `Rewrite the summary into at most ${targetTokens} visible text tokens (roughly ${targetTokens * 3} characters).`,
      'This is a limit for the saved summary text, not for reasoning or the total generation budget.',
      'Preserve current goals, user constraints, decisions, confirmed results, unfinished work, and exact identifiers and paths needed to continue.',
      'Preserve unresolved user requests and operation receipts. Distinguish completed actions from plans; do not repeat an action whose receipt confirms completion.',
      'Merge and compress the previous summary, including any partial current turn. Do not copy long logs, tool output, or the conversation verbatim.',
      'Newer messages are retained separately. Keep the context needed to understand that retained continuation.',
      'Tracked read/modified file lists will be appended verbatim; do not duplicate those XML lists.',
      ...(attempt > 0
        ? [
            'The previous attempt was too large. Produce a substantially shorter complete summary from the original evidence.',
          ]
        : []),
      ...(plan.customInstructions
        ? [`Additional user instructions:\n${plan.customInstructions}`]
        : []),
    ].join('\n');
    try {
      const result = await generateSummaryWithUsage(
        plan.messages,
        options.model,
        undefined,
        undefined,
        undefined,
        plan.signal,
        instructions,
        plan.previousSummary,
        options.thinkingLevel,
        observingStream,
        undefined,
        { enabled: false, maxRetries: 0, baseDelayMs: 0 },
        undefined,
        options.sessionId,
      );
      const response = await responsePromise;
      abortIfNeeded(plan.signal);
      if (!response || response.stopReason !== 'stop') {
        throw new Error(
          `Summary generation did not finish (${response?.stopReason ?? 'missing response'}).`,
        );
      }
      if (!result.text.trim()) throw new Error('Summary generation returned no visible text.');
      return { text: result.text.trim(), usage: result.usage };
    } catch (error) {
      abortIfNeeded(plan.signal);
      const response = await responsePromise?.catch(() => undefined);
      const reason = response && response.stopReason !== 'stop' ? ` (${response.stopReason})` : '';
      throw new Error(`Summary generation failed${reason}; the previous context is preserved.`, {
        cause: error,
      });
    }
  };

  const run = async (plan: SummaryPlan): Promise<CompactionResult> => {
    abortIfNeeded(plan.signal);
    assertUnchanged(plan.branch, plan.getCurrentBranch);
    const sourceTokens = plan.beforeTokens - plan.retainedTokens;
    const availableTokens = maxInputTokens - plan.retainedTokens;
    // Require substantial shrinkage of the replaced prefix and keep reserve for
    // continued work. A repaired summary is below half its future repair trigger.
    const targetTokens = Math.floor(
      Math.min(sourceTokens / 2, availableTokens * 0.75, maxInputTokens / 8),
    );
    const footer = fileFooter(plan.files);
    const footerTokens = Math.max(
      0,
      (await measure(candidate(plan.branch, plan.firstKeptEntryId, footer))) - plan.retainedTokens,
    );
    if (targetTokens <= footerTokens) {
      throw new Error(
        'The retained conversation and required references leave no safe summary budget.',
      );
    }

    let usage: Usage | undefined;
    let afterTokens: number | undefined;
    throwIfFailed();
    abortIfNeeded(plan.signal);
    assertUnchanged(plan.branch, plan.getCurrentBranch);
    plan.onGenerationStart?.(targetTokens);
    for (let attempt = 0; attempt < 2; attempt++) {
      abortIfNeeded(plan.signal);
      assertUnchanged(plan.branch, plan.getCurrentBranch);
      // The visible-text target tightens once; the reasoning/generation limit is
      // left to the shared request budget. Never truncate a completed response.
      const textTarget = Math.max(1, Math.floor((targetTokens - footerTokens) / (attempt + 1)));
      const result = await generate(plan, textTarget, attempt);
      usage = addUsage(usage, result.usage);
      const summary = result.text + footer;
      afterTokens = await measure(candidate(plan.branch, plan.firstKeptEntryId, summary));
      abortIfNeeded(plan.signal);
      assertUnchanged(plan.branch, plan.getCurrentBranch);
      if (afterTokens <= maxInputTokens && afterTokens <= plan.retainedTokens + targetTokens) {
        return {
          summary,
          firstKeptEntryId: plan.firstKeptEntryId,
          tokensBefore: plan.beforeTokens,
          estimatedTokensAfter: afterTokens,
          usage,
          details: {
            ...objectDetails(plan.details),
            ...plan.files,
            loomCompaction: {
              mode: plan.mode,
              beforeTokens: plan.beforeTokens,
              afterTokens,
              retainedTokens: plan.retainedTokens,
              targetTokens,
              maxInputTokens,
              attempts: attempt + 1,
            },
          },
        };
      }
    }
    throw new Error(
      'Two complete summaries exceeded the safe size target; the previous context is preserved.',
    );
  };

  const beforeCompact = async (
    event: SessionBeforeCompactEvent,
  ): Promise<SessionBeforeCompactResult> => {
    thresholdSkipped = false;
    thresholdSkipSignal = undefined;
    let ownsOperation = false;
    try {
      throwIfFailed();
      if (inProgress) throw new Error('Another context compaction is already running.');
      inProgress = true;
      ownsOperation = true;
      const signal = options.signal
        ? AbortSignal.any([options.signal, event.signal])
        : event.signal;
      abortIfNeeded(signal);
      const branch = event.branchEntries.slice();
      assertUnchanged(branch, options.getCurrentBranch);
      if (event.reason === 'threshold' && !event.willRetry && options.decideThreshold) {
        const context = await project(branch);
        throwIfFailed();
        abortIfNeeded(signal);
        assertUnchanged(branch, options.getCurrentBranch);
        const decision = await options.decideThreshold(context, branch);
        throwIfFailed();
        abortIfNeeded(signal);
        assertUnchanged(branch, options.getCurrentBranch);
        if (decision.skip) {
          thresholdSkipped = true;
          thresholdSkipSignal = signal;
          // Pi represents an extension's benign skip as cancellation. The runtime
          // consumes this flag to distinguish it from failure or owner cancellation.
          return { cancel: true };
        }
      }
      const preparation = event.preparation;
      const result = await run({
        mode: 'compact',
        branch,
        firstKeptEntryId: preparation.firstKeptEntryId,
        messages: [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
        previousSummary: preparation.previousSummary,
        customInstructions: event.customInstructions,
        files: fileLists(preparation.fileOps),
        signal,
        getCurrentBranch: options.getCurrentBranch,
        beforeTokens: await measure(branch),
        retainedTokens: await measure(candidate(branch, preparation.firstKeptEntryId, '')),
        onGenerationStart: () => options.onStart?.(),
      });
      return { compaction: result };
    } catch (error) {
      failure = error instanceof Error ? error : new Error('Context compaction failed.');
      // ExtensionRunner catches thrown hooks and would otherwise run Pi's default
      // compactor. Explicit cancellation plus the runtime latch prevents that bypass.
      return { cancel: true };
    } finally {
      if (ownsOperation) inProgress = false;
    }
  };

  const repairOversizedSummary = async (session: RepairSession): Promise<boolean> => {
    thresholdSkipped = false;
    thresholdSkipSignal = undefined;
    throwIfFailed();
    if (inProgress || delegating || session.isStreaming) {
      throw new Error('A stored summary can only be repaired while the session is idle.');
    }
    inProgress = true;
    let repairEvent:
      Omit<Parameters<NonNullable<ContextCompactionOptions['onRepair']>>[0], 'phase'> | undefined;
    try {
      abortIfNeeded(options.signal);
      const branch = session.sessionManager.getBranch().slice();
      const getCurrentBranch = () => session.sessionManager.getBranch();
      const previous = getLatestCompactionEntry(branch);
      if (!previous) return false;
      const beforeTokens = await measure(
        candidate(branch, previous.firstKeptEntryId, previous.summary),
      );
      const retainedTokens = await measure(candidate(branch, previous.firstKeptEntryId, ''));
      abortIfNeeded(options.signal);
      assertUnchanged(branch, getCurrentBranch);
      const summaryTokens = Math.max(0, beforeTokens - retainedTokens);
      if (beforeTokens <= maxInputTokens && summaryTokens <= maxInputTokens / 4) return false;
      if (
        beforeTokens > maxInputTokens &&
        (summaryTokens <= maxInputTokens / 4 || retainedTokens >= maxInputTokens)
      ) {
        // A small checkpoint is not the cause of a large newer conversation.
        // Let Pi advance the retained boundary through its public compaction API.
        // Explicitly compact here: its chars/4 threshold can lag the request's
        // chars/3.5 estimate even when the history is eligible for compaction.
        abortIfNeeded(options.signal);
        assertUnchanged(branch, getCurrentBranch);
        delegating = true;
        inProgress = false; // The public call re-enters our beforeCompact hook.
        try {
          await session.compact();
          throwIfFailed();
          abortIfNeeded(options.signal);
          return true;
        } catch (error) {
          // A cancelled/failed validating hook must never become a no-op. With
          // no removable history, leave an irreducible new input to the shared
          // request budget, which can reduce the output allowance or reject it.
          throwIfFailed();
          abortIfNeeded(options.signal);
          if (
            error instanceof Error &&
            ['Nothing to compact (session too small)', 'Already compacted'].includes(error.message)
          ) {
            return false;
          }
          throw error;
        } finally {
          delegating = false;
        }
      }
      const result = await run({
        mode: 'repair',
        branch,
        firstKeptEntryId: previous.firstKeptEntryId,
        messages: [],
        previousSummary: previous.summary,
        details: previous.details,
        files: previousFileLists(previous.details),
        signal: options.signal,
        getCurrentBranch,
        beforeTokens,
        retainedTokens,
        onGenerationStart(targetTokens) {
          repairEvent = { beforeTokens, targetTokens };
          options.onRepair?.({ phase: 'start', ...repairEvent });
        },
      });
      abortIfNeeded(options.signal);
      assertUnchanged(branch, getCurrentBranch);
      session.sessionManager.appendCompaction(
        result.summary,
        result.firstKeptEntryId,
        result.tokensBefore,
        result.details,
        true,
        result.usage,
      );
      session.refreshContext();
      if (repairEvent) repairEvent.afterTokens = result.estimatedTokensAfter;
      return true;
    } catch (error) {
      failure = error instanceof Error ? error : new Error('Stored summary repair failed.');
      if (repairEvent) repairEvent.error = failure.message;
      throw failure;
    } finally {
      inProgress = false;
      if (repairEvent) options.onRepair?.({ phase: 'end', ...repairEvent });
    }
  };

  return { beforeCompact, repairOversizedSummary, throwIfFailed, takeThresholdSkipped };
}
