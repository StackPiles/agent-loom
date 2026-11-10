/** Limits shared by chat uploads, model image input, and image generation references. */
export const IMAGE_INPUT_LIMITS = {
  maxImages: 10,
  maxImageBytes: 20 * 1024 * 1024,
  maxTotalBytes: 80 * 1024 * 1024,
} as const;

export const IMAGE_INPUT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export interface ChatImageUpload {
  filename: string;
  mimeType: (typeof IMAGE_INPUT_MIME_TYPES)[number];
  /** Canonical raw base64, without a data URL prefix. */
  data: string;
}
