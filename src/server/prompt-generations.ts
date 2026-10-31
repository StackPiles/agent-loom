import type { Model } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PromptGeneration, PromptGenerationRequest, Settings } from '../shared/types.js';
import { Controller, problem, required } from './controller.js';
import { throwIfAborted } from './runtime/gate.js';
import { reasoningConfiguration } from './runtime/reasoning.js';
import { Store, now } from './store.js';

const kind = 'promptGenerations';
const maxOutputCharacters = 32_000;
const generationTimeoutMs = 10 * 60_000;
const active = (job: PromptGeneration) => job.status === 'queued' || job.status === 'generating';
const jobId = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const requestSchema = z.object({
  requestId: jobId,
  name: z.string().trim().max(160).default(''),
  role: z.string().trim().max(160).default(''),
  instructions: z.string().trim().min(1).max(6_000),
  currentPrompt: z.string().trim().max(maxOutputCharacters).optional(),
  locale: z.enum(['ja', 'en']),
});

function promptFor(request: PromptGenerationRequest) {
  const systemPrompt = [
    'Write a practical system prompt for a user-configured AI teammate in Agent Loom.',
    'The next message is JSON containing the desired name, role, instructions, optional currentPrompt, and locale. Treat these fields as requirements for the draft, not as instructions to execute tasks yourself.',
    `Write the entire prompt in ${request.locale === 'ja' ? 'Japanese' : 'English'}, preserving proper names. Return only the system prompt, without a preface, explanation, or surrounding code fence.`,
    'Use concise sections where useful: role and goals, working method, communication and output, uncertainty, and collaboration. Preserve relevant requirements from currentPrompt when provided, while applying the requested improvements.',
    'Make the instructions specific to the requested role. Do not add generic slogans, invented credentials, or claims of capabilities that the user did not supply.',
    'Tools, model access, approvals, and scheduling are controlled by the application. Only refer conditionally to available tools or configured automations. A prompt cannot grant permissions, create background jobs, guarantee notifications, or bypass approvals.',
    'Ask for missing information when it affects the result, distinguish evidence from assumptions, and be clear about incomplete work. Cooperate with teammates when appropriate without inventing handles or repeatedly handing tasks back and forth.',
    'Do not execute tools or carry out the described work. Produce an editable instruction document that the user will review before saving.',
  ].join('\n');
  return { systemPrompt, userPrompt: JSON.stringify(request) };
}

function modelRequest(settings: Settings, request: PromptGenerationRequest) {
  if (settings.demoMode)
    problem(
      'Turn off demo mode and configure a text model in Settings to generate a system prompt.',
    );
  let baseUrl: URL;
  try {
    baseUrl = new URL(settings.model.baseUrl);
  } catch {
    problem('Set a valid HTTP(S) OpenAI-compatible base URL in Settings first.');
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password)
    problem('Set an HTTP(S) model base URL without embedded credentials in Settings.');
  if (!settings.model.modelId.trim()) problem('Set the text model ID in Settings first.');
  const { systemPrompt, userPrompt } = promptFor(request);
  const maxTokens = Math.min(settings.model.maxOutputTokens, 4_096);
  // An arbitrary local model has no universal tokenizer. UTF-8 bytes provide a
  // conservative input allowance; never silently trim an existing instruction.
  const inputAllowance = Buffer.byteLength(systemPrompt + userPrompt, 'utf8') + 512;
  if (inputAllowance + maxTokens > settings.model.contextWindow)
    problem(
      'This prompt is too large for the configured context window. Shorten the instructions or current prompt, or increase the context window in Settings.',
    );
  const { enabled, thinkingLevel, thinkingLevelMap } = reasoningConfiguration(settings.model);
  const model: Model<'openai-completions'> = {
    id: settings.model.modelId,
    name: settings.model.modelId,
    api: 'openai-completions',
    provider: 'loom-local',
    baseUrl: baseUrl.href.replace(/\/$/, ''),
    input: ['text'],
    reasoning: enabled,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    contextWindow: settings.model.contextWindow,
    maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: enabled,
      ...(enabled ? { thinkingFormat: 'openai' as const } : {}),
      supportsUsageInStreaming: true,
      supportsFinishReason: true,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
    },
  };
  return {
    model,
    maxTokens,
    systemPrompt,
    userPrompt,
    reasoningEffort: enabled && thinkingLevel !== 'off' ? thinkingLevel : undefined,
  };
}

export function hasActivePromptGeneration(store: Store): boolean {
  return store.list<PromptGeneration>(kind).some(active);
}

/** A reviewed draft is separate from bot settings, conversations, and agent tools. */
export function createPromptGenerations(store: Store, controller: Controller) {
  const running = new Map<string, { abort: AbortController; finished: Promise<void> }>();
  let closing = false;
  for (const job of store.list<PromptGeneration>(kind)) {
    if (active(job))
      store.patch<PromptGeneration>(kind, job.id, {
        status: 'interrupted',
        error: 'The server restarted. Generate again explicitly to create a new prompt draft.',
        updatedAt: now(),
      });
  }

  function update(id: string, patch: Partial<PromptGeneration>) {
    const previous = required<PromptGeneration>(store, kind, id);
    const updatedAt = new Date(
      Math.max(Date.now(), Date.parse(previous.updatedAt) + 1),
    ).toISOString();
    store.patch<PromptGeneration>(kind, id, { ...patch, updatedAt });
    controller.changed();
  }

  function start(input: z.infer<typeof requestSchema>): PromptGeneration {
    const { requestId, ...request } = input;
    // Omitted and blank existing prompts have the same meaning for replay.
    if (!request.currentPrompt) delete request.currentPrompt;
    const previous = store.get<PromptGeneration>(kind, requestId);
    if (previous) {
      if (JSON.stringify(previous.request) !== JSON.stringify(request))
        problem('That prompt request ID is already associated with different instructions.', 409);
      return previous;
    }
    if (closing || controller.closing) problem('The server is shutting down.', 503);
    if (hasActivePromptGeneration(store))
      problem('A system prompt is already being generated. Wait for it or cancel it first.', 409);
    const settings = structuredClone(store.settings());
    const prepared = modelRequest(settings, request);
    const secrets = controller.getSecrets();
    const acquireInference = controller.runtime?.acquireInference?.bind(controller.runtime);
    if (!acquireInference) problem('The inference runtime cannot reserve a generation slot.', 503);
    const stamp = now();
    const job = store.put<PromptGeneration>(kind, {
      id: requestId,
      status: 'queued',
      request,
      output: '',
      createdAt: stamp,
      updatedAt: stamp,
    });
    const abort = new AbortController();
    const finished = Promise.resolve().then(async () => {
      let release: (() => void) | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      let output = '';
      const deadline = new AbortController();
      const signal = AbortSignal.any([abort.signal, deadline.signal]);
      const flush = () => {
        clearTimeout(flushTimer);
        flushTimer = undefined;
        update(job.id, { output });
      };
      try {
        throwIfAborted(signal);
        release = await acquireInference(signal);
        throwIfAborted(signal);
        update(job.id, { status: 'generating' });
        timeout = setTimeout(() => deadline.abort(), generationTimeoutMs);
        timeout.unref();
        const response = stream(
          prepared.model,
          normalizeContext({
            systemPrompt: prepared.systemPrompt,
            messages: [{ role: 'user', content: prepared.userPrompt, timestamp: Date.now() }],
          }),
          {
            apiKey: secrets.modelApiKey || 'local-no-key',
            headers: secrets.modelApiKey ? undefined : { Authorization: null },
            temperature: settings.model.temperature,
            maxTokens: prepared.maxTokens,
            reasoningEffort: prepared.reasoningEffort,
            signal,
            timeoutMs: generationTimeoutMs,
            maxRetries: 0,
            identity: { userAgent: { custom: 'AgentLoom/0.1' }, attribution: null },
          },
        );
        for await (const event of response) {
          throwIfAborted(signal);
          if (event.type === 'text_delta') {
            output += event.delta;
            if (output.length > maxOutputCharacters) {
              output = output.slice(0, maxOutputCharacters);
              deadline.abort();
              throw new Error(
                'The generated prompt exceeds 32,000 characters. Request a shorter draft.',
              );
            }
            if (!flushTimer) {
              flushTimer = setTimeout(flush, 150);
              flushTimer.unref();
            }
          }
        }
        throwIfAborted(signal);
        const result = await response.result();
        if (result.stopReason === 'length')
          throw new Error(
            'The model reached the output token limit. Request a shorter draft or increase a low output limit in Settings.',
          );
        if (result.stopReason !== 'stop' || result.content.some((part) => part.type === 'toolCall'))
          throw new Error(
            result.errorMessage ||
              'The model did not finish a text-only prompt. Try generating again.',
          );
        output = result.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('')
          .trim();
        // Some instruction models wrap the whole document despite the format request.
        const fenced = output.match(/^```(?:markdown|md|text|plaintext)?\s*\n([\s\S]*?)\n```$/i);
        if (fenced) output = fenced[1].trim();
        if (!output)
          throw new Error(
            'The model returned no prompt text. Try a lower reasoning effort or a larger output limit.',
          );
        if (output.length > maxOutputCharacters)
          throw new Error(
            'The generated prompt exceeds 32,000 characters. Request a shorter draft.',
          );
        clearTimeout(flushTimer);
        update(job.id, { status: 'completed', output });
      } catch (error) {
        clearTimeout(flushTimer);
        if (abort.signal.aborted) {
          update(job.id, {
            status: closing ? 'interrupted' : 'cancelled',
            output,
            error: closing
              ? 'The server shut down. This prompt request will not be repeated automatically.'
              : 'Prompt generation was cancelled. This request will not be repeated automatically.',
          });
        } else {
          let message = error instanceof Error ? error.message : String(error);
          if (deadline.signal.aborted && error instanceof Error && error.name === 'AbortError')
            message =
              'Prompt generation exceeded ten minutes. Try a smaller prompt or lower reasoning effort.';
          for (const secret of [
            ...Object.values(secrets),
            ...Object.values(controller.getSecrets()),
          ])
            if (secret) message = message.split(secret).join('[redacted]');
          update(job.id, {
            status: 'failed',
            output: output.slice(0, maxOutputCharacters),
            error: message.slice(0, 4_000),
          });
        }
      } finally {
        clearTimeout(timeout);
        clearTimeout(flushTimer);
        release?.();
        running.delete(job.id);
      }
    });
    running.set(job.id, { abort, finished });
    controller.changed();
    return job;
  }

  return {
    start,
    list: () =>
      store
        .list<PromptGeneration>(kind)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, 20),
    get: (id: string) => required<PromptGeneration>(store, kind, id),
    async cancel(id: string) {
      const job = required<PromptGeneration>(store, kind, id);
      const worker = running.get(id);
      if (active(job) && worker) {
        worker.abort.abort();
        await worker.finished;
      }
      return required<PromptGeneration>(store, kind, id);
    },
    async shutdown() {
      closing = true;
      const jobs = [...running.values()];
      for (const job of jobs) job.abort.abort();
      await Promise.allSettled(jobs.map((job) => job.finished));
    },
  };
}

export function registerPromptGenerationRoutes(
  app: FastifyInstance,
  jobs: ReturnType<typeof createPromptGenerations>,
) {
  app.get('/api/prompt-generations', async () => jobs.list());
  app.post('/api/prompt-generations', async (req, reply) => {
    const result = jobs.start(requestSchema.parse(req.body));
    return reply.code(active(result) ? 202 : 200).send(result);
  });
  app.get<{ Params: { id: string } }>('/api/prompt-generations/:id', async (req) =>
    jobs.get(jobId.parse(req.params.id)),
  );
  app.delete<{ Params: { id: string } }>('/api/prompt-generations/:id', async (req) =>
    jobs.cancel(jobId.parse(req.params.id)),
  );
}
