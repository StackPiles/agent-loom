import type { ImageSettings, InferenceSettings, ReasoningEffort } from './types.js';

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
export const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  enabled: false,
  permission: 'inherit',
  baseUrl: '',
  modelId: '',
  apiKeyConfigured: false,
  size: '1024x1024',
  responseFormat: 'auto',
  timeoutSeconds: 120,
  shareInferenceSlot: true,
};
