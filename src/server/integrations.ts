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
import { MAX_HANDOFF_LIMIT } from '../shared/handoffs.js';
import { IMAGE_LIMIT_SETTING_LIMITS, imageLimitSettingsError } from '../shared/image-inputs.js';
import {
  BROWSER_UPLOAD_SETTING_LIMITS,
  browserUploadSettingsError,
  DEFAULT_BROWSER_SETTINGS,
} from '../shared/browser.js';
import { hasActiveAvatarGeneration } from './avatar-generations.js';
import { hasActivePromptGeneration } from './prompt-generations.js';
import {
  DEFAULT_IMAGE_SETTINGS,
  DEFAULT_INFERENCE_SETTINGS,
  DEFAULT_MODEL_TIMEOUTS,
  IMAGE_STEP_LIMITS,
  IMAGE_STEP_PARAMETERS,
  IMAGE_TIMEOUT_LIMITS,
  MODEL_TIMEOUT_LIMITS,
  modelImageInputEnabled,
  REASONING_EFFORTS,
} from '../shared/model-settings.js';

const text = z.string().trim().min(1).max(32_000);
const permission = z.enum(['allow', 'auto', 'ask', 'deny']);
const uploadSetting = (key: keyof typeof BROWSER_UPLOAD_SETTING_LIMITS) => {
  const { min, max } = BROWSER_UPLOAD_SETTING_LIMITS[key];
  return z.number().int().min(min).max(max);
};
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
      imageInput: z.boolean(),
      responseTimeoutSeconds: z
        .number()
        .int()
        .min(MODEL_TIMEOUT_LIMITS.min)
        .max(MODEL_TIMEOUT_LIMITS.max),
      idleTimeoutSeconds: z
        .number()
        .int()
        .min(MODEL_TIMEOUT_LIMITS.min)
        .max(MODEL_TIMEOUT_LIMITS.max),
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
      maxConcurrentBrowsers: z.number().int().min(1).max(16),
      uploadMaxFiles: uploadSetting('uploadMaxFiles'),
      uploadMaxFileMiB: uploadSetting('uploadMaxFileMiB'),
      uploadMaxTotalMiB: uploadSetting('uploadMaxTotalMiB'),
      uploadStorageMiB: uploadSetting('uploadStorageMiB'),
    })
    .partial()
    .strict()
    .optional(),
  images: z
    .object({
      enabled: z.boolean(),
      permission: z.enum(['inherit', 'allow', 'ask', 'deny']),
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
      steps: z.number().int().min(IMAGE_STEP_LIMITS.min).max(IMAGE_STEP_LIMITS.max).nullable(),
      stepsParameter: z.enum(IMAGE_STEP_PARAMETERS),
      timeoutSeconds: z.number().int().min(IMAGE_TIMEOUT_LIMITS.min).max(IMAGE_TIMEOUT_LIMITS.max),
      shareInferenceSlot: z.boolean(),
      maxImageMiB: z
        .number()
        .int()
        .min(IMAGE_LIMIT_SETTING_LIMITS.maxImageMiB.min)
        .max(IMAGE_LIMIT_SETTING_LIMITS.maxImageMiB.max),
      maxTotalMiB: z
        .number()
        .int()
        .min(IMAGE_LIMIT_SETTING_LIMITS.maxTotalMiB.min)
        .max(IMAGE_LIMIT_SETTING_LIMITS.maxTotalMiB.max),
    })
    .partial()
    .optional(),
  demoMode: z.boolean().optional(),
  autoLearn: z.boolean().optional(),
  maxHandoffs: z.number().int().min(0).max(MAX_HANDOFF_LIMIT).nullable().optional(),
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
      model: { ...DEFAULT_MODEL_TIMEOUTS, ...current.model, ...model },
      images: nextImages,
      inference: { ...DEFAULT_INFERENCE_SETTINGS, ...current.inference, ...patch.inference },
      browser: { ...DEFAULT_BROWSER_SETTINGS, ...current.browser, ...patch.browser },
      search: { ...current.search, ...search },
      permissions: { ...current.permissions, ...patch.permissions },
    };
    const uploadError = browserUploadSettingsError(settings.browser);
    if (uploadError) problem(uploadError);
    const imageLimitError = imageLimitSettingsError(nextImages);
    if (imageLimitError) problem(imageLimitError);
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
    // Bot image permission is live. Image input and image-model settings can
    // change once every task has reached a paused action boundary. Text-model
    // connections and execution settings remain pinned until tasks finish.
    const imagesChanged =
      nextImages.baseUrl !== normalizedBaseUrl(currentImages.baseUrl) ||
      (
        [
          'enabled',
          'modelId',
          'size',
          'steps',
          'stepsParameter',
          'responseFormat',
          'timeoutSeconds',
          'shareInferenceSlot',
          'maxImageMiB',
          'maxTotalMiB',
        ] as const
      ).some((key) => nextImages[key] !== currentImages[key]) ||
      nextImageKey !== savedImageKey;
    const imageInputChanged = modelImageInputEnabled(settings) !== modelImageInputEnabled(current);
    const pinnedModelChanged =
      settings.model.baseUrl !== normalizedBaseUrl(current.model.baseUrl) ||
      (['modelId', 'contextWindow', 'maxOutputTokens', 'temperature'] as const).some(
        (key) => settings.model[key] !== current.model[key],
      ) ||
      (['responseTimeoutSeconds', 'idleTimeoutSeconds'] as const).some(
        (key) =>
          (settings.model[key] ?? DEFAULT_MODEL_TIMEOUTS[key]) !==
          (current.model[key] ?? DEFAULT_MODEL_TIMEOUTS[key]),
      ) ||
      (settings.model.reasoningMode ?? 'server') !== (current.model.reasoningMode ?? 'server') ||
      (settings.model.reasoningEffort ?? 'medium') !==
        (current.model.reasoningEffort ?? 'medium') ||
      nextModelKey !== savedModelKey;
    const modelChanged = pinnedModelChanged || imageInputChanged;
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
      (pinnedModelChanged ||
        (workspaceChanged &&
          activeTasks().some((task) => !store.get<Room>('rooms', task.roomId)?.workspacePath)) ||
        settings.demoMode !== current.demoMode)
    ) {
      problem(
        'Stop active tasks before changing text-model connections, the workspace, or demo mode.',
        409,
      );
    }
    if (
      (imageInputChanged || imagesChanged) &&
      activeTasks().some(
        (task) =>
          store.get<Room>('rooms', task.roomId)?.paused !== true ||
          (task.status !== 'queued' && controller.runtime?.isTaskSuspended?.(task.id) !== true),
      )
    )
      problem(
        'Pause all rooms and wait for their current actions to finish, or stop active tasks, before changing image input or image-model settings.',
        409,
      );
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
      await controller.browser?.disconnectAll();
    controller.browser?.configure();
    controller.runtime?.configureInference?.();
    controller.changed();
    return store.settings();
  });
  app.post('/api/settings/test', async (req) => {
    const input = z
      .object({
        target: z.enum(['model', 'images']).default('model'),
        baseUrl: z.string().trim().max(2000),
        modelId: z.string().max(250).default(''),
        apiKey: z.string().max(4096).optional(),
      })
      .parse(req.body);
    validUrl(input.baseUrl);
    const settings = store.settings();
    const imageTarget = input.target === 'images';
    const saved = imageTarget ? { ...DEFAULT_IMAGE_SETTINGS, ...settings.images } : settings.model;
    const sameOrigin = urlOrigin(input.baseUrl) === urlOrigin(saved.baseUrl);
    const apiKey =
      input.apiKey ??
      (sameOrigin ? store.secret(imageTarget ? 'image.apiKey' : 'model.apiKey') : '');
    try {
      const response = await requestText(`${input.baseUrl.replace(/\/+$/, '')}/models`, {
        allowPrivate: true,
        sameOriginRedirects: true,
        timeoutMs: 12_000,
        maxBytes: 500_000,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      const data: unknown = JSON.parse(response.text);
      const listing = data && typeof data === 'object' ? data : {};
      const entries =
        'data' in listing && Array.isArray(listing.data)
          ? { values: listing.data, key: 'id' as const }
          : 'models' in listing && Array.isArray(listing.models)
            ? { values: listing.models, key: 'name' as const }
            : null;
      if (!entries)
        return {
          ok: false,
          models: [],
          message: imageTarget
            ? 'The image API did not provide a supported model list. Enter the image model ID manually.'
            : 'The API did not provide a supported model list. Enter the model ID manually.',
        };
      const models = [
        ...new Set(
          entries.values
            .map((entry: unknown) =>
              entry && typeof entry === 'object' && entries.key in entry
                ? (entry as Record<string, unknown>)[entries.key]
                : undefined,
            )
            .filter((id): id is string => typeof id === 'string')
            .map((id) => id.trim())
            .filter((id) => id.length > 0 && id.length <= 250),
        ),
      ];
      const message = !models.length
        ? imageTarget
          ? 'The image API returned an empty model list. Enter the image model ID manually.'
          : 'The API returned an empty model list. Enter the model ID manually.'
        : input.modelId && !models.includes(input.modelId)
          ? 'Connected. The selected model was not in the advertised list; you can enter its exact ID manually.'
          : imageTarget
            ? 'Model list loaded from the image API. Choose a model that supports image generation or editing.'
            : 'Connected to the model discovery endpoint. Tool calling is verified when you run a task.';
      return {
        ok: true,
        models,
        message,
      };
    } catch (error) {
      const message =
        error instanceof SyntaxError
          ? imageTarget
            ? 'The image API did not return a valid model list. Enter the image model ID manually.'
            : 'The API did not return a valid model list. Enter the model ID manually.'
          : (error as Error).message;
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
