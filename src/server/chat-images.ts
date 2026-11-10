import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  IMAGE_INPUT_LIMITS,
  IMAGE_INPUT_MIME_TYPES,
  type ChatImageUpload,
} from '../shared/image-inputs.js';
import type { GeneratedImage } from '../shared/types.js';
import { imageMimeType, saveRasterImage } from './runtime/images.js';

const maxEncodedImageBytes = Math.ceil(IMAGE_INPUT_LIMITS.maxImageBytes / 3) * 4;
export const CHAT_MESSAGE_BODY_LIMIT =
  Math.ceil(IMAGE_INPUT_LIMITS.maxTotalBytes / 3) * 4 + 256 * 1024;

export const chatImageUploadSchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    mimeType: z.enum(IMAGE_INPUT_MIME_TYPES),
    data: z.string().min(4).max(maxEncodedImageBytes),
  })
  .strict();

const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { statusCode: 400 });
};

/** Decode and inspect the complete batch before writing any user attachment. */
export function validateChatImages(uploads: ChatImageUpload[]): Array<{
  image: GeneratedImage;
  data: Buffer;
}> {
  if (uploads.length > IMAGE_INPUT_LIMITS.maxImages)
    invalid(`A message can contain at most ${IMAGE_INPUT_LIMITS.maxImages} images.`);
  let total = 0;
  return uploads.map((upload) => {
    const encoded = upload.data;
    if (
      !encoded.length ||
      encoded.length > maxEncodedImageBytes ||
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    )
      invalid('An attached image contains invalid or oversized base64 data.');
    const data = Buffer.from(encoded, 'base64');
    if (data.toString('base64') !== encoded)
      invalid('An attached image contains invalid base64 data.');
    total += data.length;
    if (total > IMAGE_INPUT_LIMITS.maxTotalBytes)
      invalid('The attached images exceed the 80 MiB total message limit.');
    let mimeType: GeneratedImage['mimeType'];
    try {
      mimeType = imageMimeType(data);
    } catch (error) {
      invalid(`Invalid attached image: ${(error as Error).message}`);
    }
    if (mimeType! !== upload.mimeType)
      invalid('The attached image media type does not match its actual contents.');
    // The display name is never used as a filesystem path or HTTP header.
    const filename = upload.filename
      .split(/[\\/]/)
      .at(-1)!
      .replace(/[\x00-\x1f\x7f]/g, '')
      .trim();
    if (!filename) invalid('Use a valid attached-image filename.');
    return {
      data,
      image: {
        id: `img_${randomBytes(32).toString('hex')}`,
        type: 'image',
        mimeType: mimeType!,
        filename,
        byteLength: data.length,
        prompt: '',
        model: '',
        source: 'uploaded',
        createdAt: new Date().toISOString(),
      },
    };
  });
}

/** Save immutable files, retaining a cleanup handle until the message commits. */
export async function saveChatImages(dataDir: string, uploads: ChatImageUpload[]) {
  const prepared = validateChatImages(uploads);
  const images: GeneratedImage[] = [];
  const discard = async () => {
    await Promise.allSettled(
      images.map((image) =>
        unlink(join(dataDir, 'generated-images', `${image.id}.${extensions[image.mimeType]}`)),
      ),
    );
  };
  try {
    const signal = AbortSignal.timeout(30_000);
    for (const { image, data } of prepared)
      images.push(await saveRasterImage(dataDir, image, data, signal));
    return { images, discard };
  } catch (error) {
    await discard();
    throw error;
  }
}
