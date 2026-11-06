import type { ImageSettings, InferenceSettings, ReasoningEffort, Settings } from './types.js';

export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const satisfies readonly ReasoningEffort[];

export const DEFAULT_INFERENCE_SETTINGS: InferenceSettings = { maxConcurrentRequests: 1 };
export const DEFAULT_MODEL_TIMEOUTS = {
  responseTimeoutSeconds: 1800,
  idleTimeoutSeconds: 300,
} as const;
export const MODEL_TIMEOUT_LIMITS = { min: 10, max: 86_400 } as const;
export const IMAGE_TIMEOUT_LIMITS = { min: 10, max: 86_400 } as const;

/** Apply explicitly when the image and language models can run together. */
export const IMAGE_2K_PARALLEL_PRESET = {
  size: '2048x2048',
  timeoutSeconds: 3600,
  shareInferenceSlot: false,
} as const satisfies Pick<ImageSettings, 'size' | 'timeoutSeconds' | 'shareInferenceSlot'>;

/** Preserve the old screenshot opt-in until an explicit model-wide choice is saved. */
export function modelImageInputEnabled(settings: Pick<Settings, 'model' | 'browser'>): boolean {
  return settings.model.imageInput ?? settings.browser?.includeScreenshotsInModel ?? false;
}

export const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  enabled: false,
  permission: 'inherit',
  baseUrl: '',
  modelId: '',
  apiKeyConfigured: false,
  size: IMAGE_2K_PARALLEL_PRESET.size,
  responseFormat: 'auto',
  timeoutSeconds: IMAGE_2K_PARALLEL_PRESET.timeoutSeconds,
  shareInferenceSlot: true,
};
