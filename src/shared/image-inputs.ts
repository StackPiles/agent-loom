import type { ImageSettings } from './types.js';

export const DEFAULT_IMAGE_LIMIT_SETTINGS = { maxImageMiB: 100, maxTotalMiB: 256 } as const;

// Keep the largest base64 JSON body below the runtime's string-size ceiling.
export const IMAGE_LIMIT_SETTING_LIMITS = {
  maxImageMiB: { min: 1, max: 256 },
  maxTotalMiB: { min: 1, max: 256 },
} as const;

type ImageLimitSettings = Pick<ImageSettings, 'maxImageMiB' | 'maxTotalMiB'>;
const MIB = 1024 * 1024;

/** Hard bounds for request parsing, immutable saved files and archive validation. */
export const MAX_IMAGE_INPUT_LIMITS = {
  maxImages: 10,
  maxImageBytes: IMAGE_LIMIT_SETTING_LIMITS.maxImageMiB.max * MIB,
  maxTotalBytes: IMAGE_LIMIT_SETTING_LIMITS.maxTotalMiB.max * MIB,
} as const;

/** Defaults for callers without saved settings, including upgraded installations. */
export const IMAGE_INPUT_LIMITS = {
  maxImages: 10,
  maxImageBytes: DEFAULT_IMAGE_LIMIT_SETTINGS.maxImageMiB * MIB,
  maxTotalBytes: DEFAULT_IMAGE_LIMIT_SETTINGS.maxTotalMiB * MIB,
} as const;

export function imageLimitSettings(images?: ImageLimitSettings) {
  return {
    maxImageMiB: images?.maxImageMiB ?? DEFAULT_IMAGE_LIMIT_SETTINGS.maxImageMiB,
    maxTotalMiB: images?.maxTotalMiB ?? DEFAULT_IMAGE_LIMIT_SETTINGS.maxTotalMiB,
  };
}

export function imageInputLimits(images?: ImageLimitSettings) {
  const limits = imageLimitSettings(images);
  return {
    maxImages: IMAGE_INPUT_LIMITS.maxImages,
    maxImageBytes: limits.maxImageMiB * MIB,
    maxTotalBytes: limits.maxTotalMiB * MIB,
  };
}

export function imageLimitSettingsError(images?: unknown): string | undefined {
  if (images !== undefined && (!images || typeof images !== 'object' || Array.isArray(images)))
    return 'Image settings must be an object.';
  const values = images as Record<string, unknown> | undefined;
  const settings = {
    maxImageMiB:
      values?.maxImageMiB === undefined
        ? DEFAULT_IMAGE_LIMIT_SETTINGS.maxImageMiB
        : values.maxImageMiB,
    maxTotalMiB:
      values?.maxTotalMiB === undefined
        ? DEFAULT_IMAGE_LIMIT_SETTINGS.maxTotalMiB
        : values.maxTotalMiB,
  };
  for (const key of ['maxImageMiB', 'maxTotalMiB'] as const) {
    const { min, max } = IMAGE_LIMIT_SETTING_LIMITS[key];
    const value = settings[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
      return `Image ${key} must be a whole number from ${min} to ${max} MiB.`;
  }
  if ((settings.maxImageMiB as number) > (settings.maxTotalMiB as number))
    return 'The per-image size limit must not exceed the total image-input limit.';
}

export const IMAGE_INPUT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export interface ChatImageUpload {
  filename: string;
  mimeType: (typeof IMAGE_INPUT_MIME_TYPES)[number];
  /** Canonical raw base64, without a data URL prefix. */
  data: string;
}
