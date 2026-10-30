import type { FastifyInstance } from 'fastify';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { RouteContext } from './routes.js';
import { ACTIVE, problem, required } from './controller.js';
import { id, now } from './store.js';
import { requestText } from './runtime/network.js';
import type { Automation, Room, Settings, Task } from '../shared/types.js';
import { MODEL_TOKEN_LIMITS } from '../shared/model-limits.js';

const short = z.string().trim().min(1).max(160);
const text = z.string().trim().min(1).max(32_000);
const permission = z.enum(['allow', 'auto', 'ask', 'deny']);
const imapSchema = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .max(250)
    .regex(/^[a-zA-Z0-9.:-]+$/),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().min(1).max(250),
  mailbox: z.string().trim().min(1).max(250),
  password: z.string().max(4096).optional(),
});
const automationSchema = z.object({
  name: short,
  kind: z.enum(['interval', 'url_watch', 'webhook', 'imap']),
  roomId: short,
  botId: short,
  prompt: text,
  intervalMinutes: z.number().int().min(1).max(525600),
  sourceUrl: z.string().max(2000),
  enabled: z.boolean(),
  imap: imapSchema.optional(),
});
const settingsSchema = z.object({
  model: z
    .object({
      baseUrl: z.string().trim().max(2000),
      modelId: z.string().trim().max(250),
      apiKey: z.string().max(4096).optional(),
      contextWindow: z
        .number()
        .int()
        .min(MODEL_TOKEN_LIMITS.contextWindow.min)
        .max(MODEL_TOKEN_LIMITS.contextWindow.max),
      maxOutputTokens: z
        .number()
        .int()
        .min(MODEL_TOKEN_LIMITS.maxOutputTokens.min)
        .max(MODEL_TOKEN_LIMITS.maxOutputTokens.max),
      temperature: z.number().min(0).max(2),
      reasoningMode: z.enum(['server', 'openai']),
      reasoningEffort: z.enum(['low', 'medium', 'high']),
    })
    .partial()
    .optional(),
  demoMode: z.boolean().optional(),
  autoLearn: z.boolean().optional(),
  maxHandoffs: z.number().int().min(0).max(20).optional(),
  workspacePath: z
    .string()
    .min(1)
    .max(2000)
    .refine((value) => !value.includes('\0'), 'The path must not contain NUL characters.')
    .optional(),
  permissions: z
    .object({ shell: permission, fileWrite: permission, network: permission })
    .partial()
    .optional(),
  search: z
    .object({
      provider: z.enum(['none', 'searxng', 'brave']),
      baseUrl: z.string().trim().max(2000),
      apiKey: z.string().max(4096).optional(),
    })
    .partial()
    .optional(),
});
function validUrl(value: string, optional = false) {
  if (!value && optional) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    problem('Enter a complete HTTP or HTTPS URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    problem('Use an HTTP or HTTPS URL without credentials, query parameters, or a fragment.');
  if (
    url.hostname === '169.254.169.254' ||
    url.hostname === 'metadata.google.internal' ||
    url.hostname.endsWith('.metadata.google.internal')
  )
    problem('Cloud metadata endpoints are not supported.');
}
function urlOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
function normalizedBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).href.replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  } // Allows comparing a malformed bootstrap value before its correction.
}
const tokenDigest = (token: string) => createHash('sha256').update(token).digest();
export function registerIntegrationRoutes(
  app: FastifyInstance,
  { store, controller, scheduler }: RouteContext,
) {
  const activeTasks = () => store.list<Task>('tasks').filter((t) => ACTIVE.has(t.status));
  app.put('/api/settings', async (req) => {
    const patch = settingsSchema.parse(req.body);
    const current = store.settings();
    const { apiKey: modelKey, ...model } = patch.model ?? {};
    const { apiKey: searchKey, ...search } = patch.search ?? {};
    const settings: Settings = {
      ...current,
      ...patch,
      model: { ...current.model, ...model },
      search: { ...current.search, ...search },
      permissions: { ...current.permissions, ...patch.permissions },
    };
    settings.model.baseUrl = normalizedBaseUrl(settings.model.baseUrl);
    validUrl(settings.model.baseUrl, true);
    if (settings.search.baseUrl) validUrl(settings.search.baseUrl);
    if (settings.model.maxOutputTokens >= settings.model.contextWindow)
      problem('Maximum output tokens must be smaller than the context window.');
    settings.workspacePath = resolve(settings.workspacePath);
    const savedModelKey = store.secret('model.apiKey');
    const originChanged = urlOrigin(settings.model.baseUrl) !== urlOrigin(current.model.baseUrl);
    // Retain credentials for the same provider origin. Moving to another origin
    // never silently carries a saved credential to that server.
    const nextModelKey = modelKey ?? (originChanged ? '' : savedModelKey);
    const modelChanged =
      settings.model.baseUrl !== normalizedBaseUrl(current.model.baseUrl) ||
      (['modelId', 'contextWindow', 'maxOutputTokens', 'temperature'] as const).some(
        (key) => settings.model[key] !== current.model[key],
      ) ||
      (settings.model.reasoningMode ?? 'server') !== (current.model.reasoningMode ?? 'server') ||
      (settings.model.reasoningEffort ?? 'medium') !==
        (current.model.reasoningEffort ?? 'medium') ||
      nextModelKey !== savedModelKey;
    const workspaceChanged = settings.workspacePath !== resolve(current.workspacePath);
    if (
      activeTasks().length &&
      (modelChanged ||
        (workspaceChanged &&
          activeTasks().some((task) => !store.get<Room>('rooms', task.roomId)?.workspacePath)) ||
        settings.demoMode !== current.demoMode)
    ) {
      problem('Stop active tasks before changing the model, workspace, or demo mode.', 409);
    }
    mkdirSync(settings.workspacePath, { recursive: true, mode: 0o700 });
    if (workspaceChanged) controller.pinLegacyWorkspaces();
    if (modelKey !== undefined || originChanged) store.setSecret('model.apiKey', nextModelKey);
    if (searchKey !== undefined) store.setSecret('search.apiKey', searchKey);
    store.put('settings', { ...settings, id: 'main' });
    controller.changed();
    return store.settings();
  });
  app.post('/api/settings/test', async (req) => {
    const input = z
      .object({
        baseUrl: z.string().trim().max(2000),
        modelId: z.string().max(250).default(''),
        apiKey: z.string().max(4096).optional(),
      })
      .parse(req.body);
    validUrl(input.baseUrl);
    const sameOrigin = urlOrigin(input.baseUrl) === urlOrigin(store.settings().model.baseUrl);
    const apiKey = input.apiKey ?? (sameOrigin ? store.secret('model.apiKey') : '');
    try {
      const response = await requestText(`${input.baseUrl.replace(/\/+$/, '')}/models`, {
        allowPrivate: true,
        sameOriginRedirects: true,
        timeoutMs: 12_000,
        maxBytes: 500_000,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      const data = JSON.parse(response.text) as {
        data?: { id: string }[];
        models?: { name: string }[];
      };
      const models = Array.isArray(data.data)
        ? data.data.map((m) => m.id).filter((s) => typeof s === 'string')
        : Array.isArray(data.models)
          ? data.models.map((m) => m.name).filter((s) => typeof s === 'string')
          : [];
      return {
        ok: true,
        models,
        message:
          input.modelId && models.length && !models.includes(input.modelId)
            ? 'Connected. The selected model was not in the advertised list; verify its exact ID.'
            : 'Connected to the model discovery endpoint. Tool calling is verified when you run a task.',
      };
    } catch (error) {
      const message = (error as Error).message;
      return {
        ok: false,
        models: [],
        message: apiKey ? message.replaceAll(apiKey, '[redacted]') : message,
      };
    }
  });
  app.post('/api/demo', async (req) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    if (activeTasks().length) problem('Stop active tasks before switching demo mode.', 409);
    store.put('settings', { ...store.settings(), demoMode: enabled, id: 'main' });
    controller.changed();
    return store.settings();
  });
  function saveAutomation(
    input: z.infer<typeof automationSchema>,
    existing?: Automation,
  ): Automation {
    controller.validateTarget(input.roomId, input.botId);
    if (input.kind === 'url_watch') {
      let url: URL;
      try {
        url = new URL(input.sourceUrl);
      } catch {
        problem('A valid page URL is required.');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        problem('Use a public HTTP or HTTPS page URL without credentials.');
    }
    if (input.kind === 'imap' && !input.imap) problem('IMAP connection settings are required.');
    const automationId = existing?.id ?? id('auto');
    const { imap, ...fields } = input;
    const { password, ...imapFields } = imap ?? {};
    if (password !== undefined) store.setSecret(`imap.${automationId}.password`, password);
    const automation: Automation = {
      ...fields,
      id: automationId,
      createdAt: existing?.createdAt ?? now(),
      nextRunAt:
        input.enabled && input.kind !== 'webhook'
          ? new Date(Date.now() + input.intervalMinutes * 60_000).toISOString()
          : undefined,
      lastRunAt: existing?.lastRunAt,
      imap: imap
        ? ({
            ...imapFields,
            passwordConfigured: Boolean(store.secret(`imap.${automationId}.password`)),
          } as Automation['imap'])
        : undefined,
    };
    if (
      existing &&
      (existing.kind !== input.kind ||
        existing.sourceUrl !== input.sourceUrl ||
        JSON.stringify(existing.imap) !== JSON.stringify(automation.imap))
    ) {
      const state = store.get<{ id: string; lastTaskId?: string; [key: string]: unknown }>(
        'automationState',
        automationId,
      );
      if (state) {
        // A new source needs a new baseline, but the old task still belongs to
        // this rule until it finishes. Keep its ID so edits cannot bypass coalescing.
        for (const key of ['sourceIdentity', 'sourceHash', 'uidValidity', 'lastUid'])
          delete state[key];
        if (existing.kind !== input.kind) {
          delete state.pendingWebhooks;
          delete state.coalescedWebhookCount;
        }
        store.put('automationState', state);
      }
    }
    store.put('automations', automation);
    controller.changed();
    return automation;
  }
  app.post('/api/automations', async (req) =>
    saveAutomation(
      automationSchema.parse({
        intervalMinutes: 60,
        sourceUrl: '',
        enabled: true,
        ...z.record(z.string(), z.unknown()).parse(req.body),
      }),
    ),
  );
  app.patch<{ Params: { id: string } }>('/api/automations/:id', async (req) => {
    const existing = required<Automation>(store, 'automations', req.params.id);
    const patch = automationSchema.partial().parse(req.body);
    return saveAutomation(automationSchema.parse({ ...existing, ...patch }), existing);
  });
  app.delete<{ Params: { id: string } }>('/api/automations/:id', async (req) => {
    required<Automation>(store, 'automations', req.params.id);
    store.remove('automations', req.params.id);
    store.remove('automationState', req.params.id);
    store.setSecret(`imap.${req.params.id}.password`, '');
    store.setSecret(`hook.${req.params.id}`, '');
    controller.changed();
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/automations/:id/run', async (req) => {
    required<Automation>(store, 'automations', req.params.id);
    await scheduler.run(req.params.id);
    return required<Automation>(store, 'automations', req.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/automations/:id/webhook-key', async (req) => {
    const automation = required<Automation>(store, 'automations', req.params.id);
    if (automation.kind !== 'webhook') problem('This automation is not a webhook.');
    const token = randomBytes(32).toString('base64url');
    store.setSecret(`hook.${automation.id}`, token);
    return { token, path: `/api/hooks/${automation.id}` };
  });
  app.post<{ Params: { id: string } }>('/api/hooks/:id', async (req) => {
    const expected = store.secret(`hook.${req.params.id}`);
    const authorization = req.headers.authorization ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!expected || !timingSafeEqual(tokenDigest(expected), tokenDigest(bearer)))
      problem('Invalid webhook token.', 401);
    const input = z
      .object({ text, eventId: z.string().min(1).max(160).optional() })
      .parse(req.body);
    const dedupKey = input.eventId
      ? `webhook:${req.params.id}:${tokenDigest(input.eventId.trim()).toString('hex')}`
      : undefined;
    const duplicate = Boolean(
      dedupKey && store.db.prepare('SELECT 1 FROM dedup WHERE key=?').get(dedupKey),
    );
    const task = scheduler.deliverWebhook(req.params.id, input);
    return { ok: true, duplicate, queued: !task && !duplicate, task };
  });
}
