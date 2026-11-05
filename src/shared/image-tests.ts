import type { GeneratedImage, ImageSettings } from './types.js';

export const IMAGE_TEST_PROMPT =
  'A single small blue circle centered on a plain white background. Simple flat illustration, no text, no logo.';
export const IMAGE_TEST_PREVIEW_TTL_MS = 15 * 60 * 1000;

export type ImageTestSettings = Pick<
  ImageSettings,
  'baseUrl' | 'modelId' | 'size' | 'responseFormat' | 'timeoutSeconds' | 'shareInferenceSlot'
>;

export interface ImageTestRequest {
  requestId: string;
  settings: ImageTestSettings;
  /** Omitted reuses the saved image key only for the same origin; empty explicitly uses no key. */
  apiKey?: string;
}

export interface ImageTestJob {
  id: string;
  status: 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  baseUrl: string;
  modelId: string;
  size: string;
  createdAt: string;
  updatedAt: string;
  /** Active generation deadline; absent while waiting for image or inference capacity. */
  deadlineAt?: string;
  image?: GeneratedImage;
  previewAvailable: boolean;
  previewExpiresAt?: string;
  error?: string;
  errorCode?: 'timeout' | 'generation_failed' | 'cancelled' | 'interrupted';
}

export const isActiveImageTest = (job: ImageTestJob) =>
  job.status === 'queued' || job.status === 'generating';
