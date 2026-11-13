import { createHash } from 'node:crypto';
import { IMAGE_INPUT_LIMITS, imageInputLimits } from '../../shared/image-inputs.js';
import type { ImageInputReceipt, ImageSource } from '../../shared/types.js';
import type { ToolContext } from './contract.js';
import { normalizeImageSource, readImageSource } from './image-view.js';
import type { ImageUpload } from './images.js';

export type ImageOperation = 'generate' | 'edit';
export interface ImageInputSource extends ImageSource {
  role: ImageInputReceipt['role'];
}

/** Keep new generation with references distinct from modifying one required source. */
export function imageInputSources(
  operation: ImageOperation,
  args: Record<string, unknown>,
): ImageInputSource[] {
  const allowed = new Set(['prompt', 'size', 'steps', 'referenceImages']);
  if (operation === 'edit') {
    allowed.add('sourceImage');
    allowed.add('mask');
  }
  if (Object.keys(args).some((key) => !allowed.has(key)))
    throw new Error(
      'Unrecognized image arguments. Use referenceImages for generation, or sourceImage for edit_image.',
    );
  if (operation === 'edit' && args.sourceImage === undefined)
    throw new Error('edit_image requires sourceImage identifying the image to modify.');
  if (args.referenceImages !== undefined && !Array.isArray(args.referenceImages))
    throw new Error(
      'referenceImages must be an array of imageId or workspace-relative path sources.',
    );
  const source = (value: unknown, role: ImageInputReceipt['role']): ImageInputSource => ({
    role,
    ...normalizeImageSource(value as ImageSource),
  });
  const images: ImageInputSource[] = [
    ...(operation === 'edit' ? [source(args.sourceImage, 'source')] : []),
    ...((args.referenceImages ?? []) as unknown[]).map((value) => source(value, 'reference')),
  ];
  if (images.length > IMAGE_INPUT_LIMITS.maxImages)
    throw new Error(
      `Use at most ${IMAGE_INPUT_LIMITS.maxImages} input images, including the edit source.`,
    );
  if (operation === 'edit' && args.mask !== undefined) images.push(source(args.mask, 'mask'));
  return images;
}

/** Read once before approval; the queued request retains these exact bytes. */
export async function prepareImageInputs(
  context: ToolContext,
  sources: readonly ImageInputSource[],
): Promise<ImageUpload[]> {
  const limits = imageInputLimits(context.settings.images);
  const images: ImageUpload[] = [];
  let total = 0;
  for (const { role, ...source } of sources) {
    const image = await readImageSource(context, source);
    total += image.data.length;
    if (total > limits.maxTotalBytes)
      throw new Error(
        `Image-model inputs exceed the combined ${limits.maxTotalBytes / 1024 / 1024} MiB limit.`,
      );
    images.push({
      data: image.data,
      mimeType: image.mimeType,
      receipt: {
        role,
        ...image.source,
        sha256: createHash('sha256').update(image.data).digest('hex'),
      },
    });
  }
  return images;
}

/** Fingerprints are durable; bytes and data URLs never enter the operation journal. */
export function boundImageReceipts(
  result: string | undefined,
  sources: readonly ImageInputSource[],
): ImageInputReceipt[] {
  let value: unknown;
  try {
    value = JSON.parse(result ?? '');
  } catch {
    throw new Error('The saved image-input receipt is unavailable or invalid.');
  }
  if (
    !Array.isArray(value) ||
    value.length !== sources.length ||
    value.some((item, index) => {
      const expected = sources[index];
      return (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        Object.keys(item).some((key) => !['role', 'imageId', 'path', 'sha256'].includes(key)) ||
        item.role !== expected.role ||
        item.imageId !== expected.imageId ||
        item.path !== expected.path ||
        typeof item.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.sha256)
      );
    })
  )
    throw new Error('The saved image-input receipt does not match this request.');
  return value as ImageInputReceipt[];
}

export function assertBoundImageInputs(
  images: readonly ImageUpload[],
  receipts: readonly ImageInputReceipt[],
): void {
  if (
    images.length !== receipts.length ||
    images.some((image, index) => image.receipt.sha256 !== receipts[index].sha256)
  )
    throw new Error(
      'An input image changed since this request was prepared. The saved request will not use different pixels. Choose an immutable room image or start a new task for the changed image.',
    );
}
