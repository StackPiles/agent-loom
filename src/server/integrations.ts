import type { FastifyInstance } from 'fastify';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { RouteContext } from './routes.js';
import { ACTIVE, problem, required } from './controller.js';
import { automationSchema, removeAutomation } from './automations.js';
import { requestText } from './runtime/network.js';
import type { Automation, Room, Settings, Task } from '../shared/types.js';
import { MODEL_TOKEN_LIMITS } from '../shared/model-limits.js';
import { DEFAULT_BROWSER_SETTINGS } from '../shared/browser.js';
import { hasActiveAvatarGeneration } from './avatar-generations.js';
import { hasActivePromptGeneration } from './prompt-generations.js';
import {
  DEFAULT_IMAGE_SETTINGS,
  DEFAULT_INFERENCE_SETTINGS,
  REASONING_EFFORTS,
} from '../shared/model-settings.js';

const text = z.string().trim().min(1).max(32_000);
const permission = z.enum(['allow', 'auto', 'ask', 'deny']);
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
      reasoningEffort: z.enum(REASONING_EFFORTS),
    })
    .partial()
    .optional(),
  inference: z
    .object({ maxConcurrentRequests: z.number().int().min(1).max(16) })
    .partial()
    .optional(),
  browser: z
    .object({
      enabled: z.boolean(),
      mode: z.enum(['existing', 'dedicated']),
      permission,
      includeScreenshotsInModel: z.boolean(),
    })
    .partial()
    .optional(),
  images: z
    .object({
      enabled: z.boolean(),
      baseUrl: z.string().trim().max(2000),
      modelId: z.string().trim().max(250),
      apiKey: z.string().max(4096).optional(),
      size: z
        .string()
        .trim()
        .refine((value) => {
          if (value === 'auto') return true;
          const match = /^(\d{2,4})x(\d{2,4})$/.exec(value);
          return Boolean(
            match &&
            match.slice(1).every((part) => Number(part) >= 64 && Number(part) <= 8192) &&
            Number(match[1]) * Number(match[2]) <= 16_777_216,
          );
        }, 'Use auto or WIDTHxHEIGHT (64–8192 per side, at most 16 megapixels).'),
      responseFormat: z.enum(['auto', 'b64_json']),
      timeoutSeconds: z.number().int().min(10).max(1800),
      shareInferenceSlot: z.boolean(),
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
    const { apiKey: imageKey, ...images } = patch.images ?? {};
    const currentImages = { ...DEFAULT_IMAGE_SETTINGS, ...current.images };
    const nextImages = { ...currentImages, ...images };
    const settings: Settings = {
      ...current,
      ...patch,
      model: { ...current.model, ...model },
      images: nextImages,
      inference: { ...DEFAULT_INFERENCE_SETTINGS, ...current.inference, ...patch.inference },
      browser: { ...DEFAULT_BROWSER_SETTINGS, ...current.browser, ...patch.browser },
      search: { ...current.search, ...search },
      permissions: { ...current.permissions, ...patch.permissions },
    };
    settings.model.baseUrl = normalizedBaseUrl(settings.model.baseUrl);
    nextImages.baseUrl = normalizedBaseUrl(nextImages.baseUrl);
    validUrl(settings.model.baseUrl, true);
    validUrl(nextImages.baseUrl, !nextImages.enabled);
    if (nextImages.enabled && !nextImages.modelId)
      problem('Set the image model ID before enabling image generation.');
    if (settings.search.baseUrl) validUrl(settings.search.baseUrl);
    if (settings.model.maxOutputTokens >= settings.model.contextWindow)
      problem('Maximum output tokens must be smaller than the context window.');
    settings.workspacePath = resolve(settings.workspacePath);
    const savedModelKey = store.secret('model.apiKey');
    const originChanged = urlOrigin(settings.model.baseUrl) !== urlOrigin(current.model.baseUrl);
    // Retain credentials for the same provider origin. Moving to another origin
    // never silently carries a saved credential to that server.
    const nextModelKey = modelKey ?? (originChanged ? '' : savedModelKey);
    const savedImageKey = store.secret('image.apiKey');
    const imageOriginChanged = urlOrigin(nextImages.baseUrl) !== urlOrigin(currentImages.baseUrl);
    const nextImageKey = imageKey ?? (imageOriginChanged ? '' : savedImageKey);
    const imagesChanged =
      nextImages.baseUrl !== normalizedBaseUrl(currentImages.baseUrl) ||
      (
        [
          'enabled',
          'modelId',
          'size',
          'responseFormat',
          'timeoutSeconds',
          'shareInferenceSlot',
        ] as const
      ).some((key) => nextImages[key] !== currentImages[key]) ||
      nextImageKey !== savedImageKey;
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
    const currentBrowser = { ...DEFAULT_BROWSER_SETTINGS, ...current.browser };
    const nextBrowser = settings.browser!;
    const browserModeChanged = nextBrowser.mode !== currentBrowser.mode;
    if (
      browserModeChanged &&
      ['connecting', 'connected'].includes(controller.browser?.status().state || '')
    )
      problem('Disconnect Chrome before changing the connection mode.', 409);
    if (
      activeTasks().length &&
      (browserModeChanged ||
        nextBrowser.includeScreenshotsInModel !== currentBrowser.includeScreenshotsInModel)
    )
      problem('Stop active tasks before changing the Chrome mode or screenshot model input.', 409);
    if (
      hasActivePromptGeneration(store) &&
      (modelChanged || settings.demoMode !== current.demoMode)
    )
      problem(
        'Wait for system prompt generation to finish or cancel it before changing the text model or demo mode.',
        409,
      );
    if (hasActiveAvatarGeneration(store) && (modelChanged || imagesChanged))
      problem(
        'Wait for avatar generation to finish or cancel it before changing model connections.',
        409,
      );
    if (
      activeTasks().length &&
      (modelChanged ||
        imagesChanged ||
        (workspaceChanged &&
          activeTasks().some((task) => !store.get<Room>('rooms', task.roomId)?.workspacePath)) ||
        settings.demoMode !== current.demoMode)
    ) {
      problem(
        'Stop active tasks before changing model connections, image generation, the workspace, or demo mode.',
        409,
      );
    }
    mkdirSync(settings.workspacePath, { recursive: true, mode: 0o700 });
    if (workspaceChanged) controller.pinLegacyWorkspaces();
    if (modelKey !== undefined || originChanged) store.setSecret('model.apiKey', nextModelKey);
    if (imageKey !== undefined || imageOriginChanged) store.setSecret('image.apiKey', nextImageKey);
    if (searchKey !== undefined) store.setSecret('search.apiKey', searchKey);
    store.put('settings', { ...settings, id: 'main' });
    if (
      (!nextBrowser.enabled || nextBrowser.permission === 'deny') &&
      (currentBrowser.enabled || controller.browser?.status().state === 'connecting')
    )
      await controller.browser?.disconnect();
    controller.runtime?.configureInference?.();
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
    const current = store.settings();
    if (enabled !== current.demoMode && hasActivePromptGeneration(store))
      problem(
        'Wait for system prompt generation to finish or cancel it before switching demo mode.',
        409,
      );
    store.put('settings', { ...current, demoMode: enabled, id: 'main' });
    controller.changed();
    return store.settings();
  });
  app.post('/api/automations', async (req) =>
    controller.saveAutomation(
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
    return controller.saveAutomation(automationSchema.parse({ ...existing, ...patch }), {
      id: existing.id,
    });
  });
  app.delete<{ Params: { id: string } }>('/api/automations/:id', async (req) => {
    removeAutomation(store, req.params.id);
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
