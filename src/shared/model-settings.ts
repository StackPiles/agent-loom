import type { ImageSettings, InferenceSettings, ReasoningEffort, Settings } from './types.js';
import { DEFAULT_IMAGE_LIMIT_SETTINGS } from './image-inputs.js';

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
export const IMAGE_STEP_LIMITS = { min: 1, max: 1000 } as const;
export const IMAGE_STEP_PARAMETERS = [
  'sd_cpp_extra_args',
  'steps',
  'num_inference_steps',
  'sample_steps',
] as const satisfies readonly NonNullable<ImageSettings['stepsParameter']>[];

/** Default size, timeout and capacity; explicit saved values remain unchanged. */
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
  ...DEFAULT_IMAGE_LIMIT_SETTINGS,
  enabled: false,
  permission: 'inherit',
  baseUrl: '',
  modelId: '',
  apiKeyConfigured: false,
  size: IMAGE_2K_PARALLEL_PRESET.size,
  steps: null,
  stepsParameter: 'sd_cpp_extra_args',
  responseFormat: 'auto',
  timeoutSeconds: IMAGE_2K_PARALLEL_PRESET.timeoutSeconds,
  shareInferenceSlot: IMAGE_2K_PARALLEL_PRESET.shareInferenceSlot,
};
