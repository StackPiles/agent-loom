import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import type { GeneratedImage, Permission, Settings } from '../../shared/types.js';
import type { RuntimeHost, ToolContext } from './contract.js';
import { InferenceGate, throwIfAborted } from './gate.js';
import { isPublicAddress } from './network.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 128 * 1024;
export const GENERATED_IMAGE_ID = /^img_[a-f0-9]{64}$/;
const imageGates = new WeakMap<RuntimeHost, InferenceGate>();
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;

export interface ImageRequest {
  prompt: string;
  size?: string;
}

export function imageGenerationRequest(settings: Settings, args: ImageRequest) {
  const images = settings.images;
  if (!images?.enabled)
    throw new Error(
      'Image generation is disabled. Enable and configure an image model in Settings.',
    );
  let endpoint: URL;
  try {
    endpoint = new URL(images.baseUrl);
  } catch {
    throw new Error('Set a valid HTTP(S) image model base URL in Settings.');
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      'The image model base URL must be HTTP(S), without credentials, query, or fragment.',
    );
  if (!images.modelId?.trim()) throw new Error('Set the image model ID in Settings first.');
  if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 16_000)
    throw new Error('An image prompt must contain 1 to 16,000 characters.');
  const size = args.size ?? images.size;
  if (size !== 'auto') {
    const match = /^(\d{2,4})x(\d{2,4})$/.exec(size);
    if (!match) throw new Error('Image size must be auto or WIDTHxHEIGHT, such as 1024x1024.');
    if (Number(match[1]) < 64 || Number(match[2]) < 64)
      throw new Error('Requested image dimensions must be at least 64 pixels per side.');
    validateDimensions(Number(match[1]), Number(match[2]));
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/images/generations`;
  return { images, endpoint, args: { prompt: args.prompt, size } };
}

function validateDimensions(width: number, height: number) {
  if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16_777_216)
    throw new Error(
      'Image dimensions exceed the supported limit of 8,192 per side and 16 megapixels.',
    );
}

/** Inspect raster signatures/dimensions. SVG and arbitrary provider HTML are never served as images. */
export function imageMimeType(data: Buffer): GeneratedImage['mimeType'] {
  if (!data.length || data.length > MAX_IMAGE_BYTES)
    throw new Error('The generated image is empty or exceeds the 20 MiB image limit.');
  if (data.length >= 45 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    if (
      data.readUInt32BE(8) !== 13 ||
      data.toString('ascii', 12, 16) !== 'IHDR' ||
      data.toString('ascii', data.length - 8, data.length - 4) !== 'IEND'
    )
      throw new Error('The image server returned an invalid PNG image.');
    validateDimensions(data.readUInt32BE(16), data.readUInt32BE(20));
    return 'image/png';
  }
  if (
    data.length >= 4 &&
    data.readUInt16BE(0) === 0xffd8 &&
    data.readUInt16BE(data.length - 2) === 0xffd9
  ) {
    let offset = 2;
    while (offset + 4 < data.length) {
      if (data[offset++] !== 0xff) break;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        length >= 8
      ) {
        validateDimensions(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3));
        return 'image/jpeg';
      }
      offset += length;
    }
    throw new Error('The image server returned an invalid JPEG image.');
  }
  if (
    data.length >= 30 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  ) {
    if (data.readUInt32LE(4) + 8 !== data.length)
      throw new Error('The image server returned an invalid WebP image.');
    const kind = data.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      validateDimensions(data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1);
    } else if (kind === 'VP8L' && data[20] === 0x2f) {
      validateDimensions(
        1 + (((data[22] & 0x3f) << 8) | data[21]),
        1 + (((data[24] & 0x0f) << 10) | (data[23] << 2) | ((data[22] & 0xc0) >> 6)),
      );
    } else if (kind === 'VP8 ' && data.subarray(23, 26).equals(Buffer.from('9d012a', 'hex'))) {
      validateDimensions(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
    } else throw new Error('The image server returned an unsupported WebP image.');
    return 'image/webp';
  }
  throw new Error('The image server must return a PNG, JPEG, or WebP raster image.');
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Image generation was cancelled or timed out.'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

interface ImageHttpOptions {
  method: 'GET' | 'POST';
  configuredOrigin: string;
  key?: string;
  body?: Buffer;
  maxBytes: number;
  signal: AbortSignal;
}

/** Downloads have pinned DNS, bounded redirects and no credential forwarding between origins. */
async function imageHttp(input: URL, options: ImageHttpOptions): Promise<Buffer> {
  let url = input;
  for (let redirects = 0; redirects <= 4; redirects++) {
    throwIfAborted(options.signal);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Image download URLs must be HTTP(S), without embedded credentials.');
    const sameOrigin = url.origin === options.configuredOrigin;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(lookup(hostname, { all: true, verbatim: true }), options.signal);
    if (!addresses.length) throw new Error('The image server hostname did not resolve.');
    if (!sameOrigin && addresses.some(({ address }) => !isPublicAddress(address)))
      throw new Error(
        'An image URL outside the configured server resolves to a private or reserved address.',
      );
    const pinned = addresses[0];
    const result = await new Promise<{ status: number; location?: string; body: Buffer }>(
      (resolve, reject) => {
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
          url,
          {
            method: options.method,
            agent: false,
            signal: options.signal,
            headers: {
              accept:
                options.method === 'POST'
                  ? 'application/json'
                  : 'image/png, image/jpeg, image/webp',
              'accept-encoding': 'identity',
              ...(options.body
                ? {
                    'content-type': 'application/json',
                    'content-length': String(options.body.length),
                  }
                : {}),
              ...(sameOrigin && options.key ? { authorization: `Bearer ${options.key}` } : {}),
            },
            lookup: (_hostname, lookupOptions, callback) => {
              if (typeof lookupOptions === 'object' && lookupOptions.all)
                (
                  callback as unknown as (
                    error: null,
                    records: Array<{ address: string; family: number }>,
                  ) => void
                )(null, [pinned]);
              else callback(null, pinned.address, pinned.family);
            },
          },
          (response) => {
            const fail = (message: string) => {
              response.destroy();
              request.destroy();
              reject(new Error(message));
            };
            if (Number(response.headers['content-length'] ?? 0) > options.maxBytes) {
              fail('The image server response exceeds the size limit.');
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > options.maxBytes)
                fail('The image server response exceeds the size limit.');
              else chunks.push(chunk);
            });
            response.on('error', reject);
            response.on('end', () =>
              resolve({
                status: response.statusCode ?? 0,
                location: response.headers.location,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        request.on('error', reject);
        request.end(options.body);
      },
    );
    if ([301, 302, 303, 307, 308].includes(result.status) && result.location) {
      if (options.method === 'POST')
        throw new Error(
          'The image generation endpoint redirected. Set its final base URL in Settings; the generation request was not replayed.',
        );
      url = new URL(result.location, url);
      continue;
    }
    if (result.status < 200 || result.status >= 300)
      throw new Error(
        `The image server returned HTTP ${result.status}. Check its model ID, size, credentials, and API compatibility.`,
      );
    return result.body;
  }
  throw new Error('The image download redirected more than four times.');
}

async function generatedDirectory(dataDir: string): Promise<string> {
  const base = await realpath(dataDir);
  const directory = path.join(base, 'generated-images');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink() || (await realpath(directory)) !== directory)
    throw new Error('The generated-image directory must not be a symbolic link.');
  return directory;
}

function imageFilename(image: Pick<GeneratedImage, 'id' | 'mimeType'>): string {
  if (!GENERATED_IMAGE_ID.test(image.id) || !Object.hasOwn(extensions, image.mimeType))
    throw new Error('Invalid generated image identifier or media type.');
  return `${image.id}.${extensions[image.mimeType]}`;
}

/** Serves only immutable app-managed raster files; the attachment's display filename is not a path. */
export async function readGeneratedImage(dataDir: string, image: GeneratedImage): Promise<Buffer> {
  const directory = await generatedDirectory(dataDir);
  const filename = path.join(directory, imageFilename(image));
  if ((await lstat(filename)).isSymbolicLink() || (await realpath(filename)) !== filename)
    throw new Error('Generated image paths must not be symbolic links.');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES || stat.size !== image.byteLength)
      throw new Error('The stored image is unavailable or has changed.');
    const data = await handle.readFile();
    if (imageMimeType(data) !== image.mimeType)
      throw new Error('The stored image media type has changed.');
    return data;
  } finally {
    await handle.close();
  }
}

export async function generateImage(
  context: ToolContext,
  args: ImageRequest,
  id: string,
  approvedPolicy: Permission,
): Promise<GeneratedImage> {
  if (!GENERATED_IMAGE_ID.test(id)) throw new Error('Invalid generated image identifier.');
  const { images, endpoint, args: request } = imageGenerationRequest(context.settings, args);
  if (!imageGates.has(context.host)) imageGates.set(context.host, new InferenceGate());
  const releaseImage = await imageGates.get(context.host)!.acquire(context.signal);
  let releaseInference: (() => void) | undefined;
  try {
    if (images.shareInferenceSlot !== false && context.acquireInference) {
      context.host.updateTask(context.task.id, { status: 'waiting_model' });
      releaseInference = await context.acquireInference(context.signal);
    }
    context.host.updateTask(context.task.id, { status: 'waiting_tool' });
    const currentPolicy = context.host.getSnapshot().settings.permissions.network;
    if (currentPolicy === 'deny')
      throw new Error('Image generation is disabled by the current network permission.');
    if (currentPolicy !== approvedPolicy && currentPolicy !== 'allow')
      throw new Error(
        'Network permission changed while this image request was waiting. Start a new task to review it under the current policy.',
      );
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout((images.timeoutSeconds || 300) * 1000),
    ]);
    const apiKey = context.host.getSecrets().imageApiKey;
    if (apiKey && /[\r\n]/.test(apiKey))
      throw new Error('The image API key contains invalid control characters.');
    const body = Buffer.from(
      JSON.stringify({
        model: images.modelId,
        prompt: request.prompt,
        n: 1,
        size: request.size,
        ...(images.responseFormat === 'b64_json' ? { response_format: 'b64_json' } : {}),
      }),
    );
    const raw = await imageHttp(endpoint, {
      method: 'POST',
      configuredOrigin: endpoint.origin,
      key: apiKey,
      body,
      maxBytes: MAX_RESPONSE_BYTES,
      signal,
    });
    let payload: { data?: Array<{ b64_json?: string; url?: string }> };
    try {
      payload = JSON.parse(raw.toString('utf8')) as typeof payload;
    } catch {
      throw new Error('The image server did not return an OpenAI-compatible JSON image response.');
    }
    const first = Array.isArray(payload?.data) ? payload.data[0] : undefined;
    let data: Buffer;
    if (typeof first?.b64_json === 'string') {
      const encoded = first.b64_json;
      if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
        throw new Error('The image server returned invalid base64 image data.');
      data = Buffer.from(encoded, 'base64');
      if (data.toString('base64') !== encoded)
        throw new Error('The image server returned invalid base64 image data.');
    } else if (typeof first?.url === 'string') {
      let imageUrl: URL;
      try {
        imageUrl = new URL(first.url, endpoint);
      } catch {
        throw new Error('The image server returned an invalid image URL.');
      }
      data = await imageHttp(imageUrl, {
        method: 'GET',
        configuredOrigin: endpoint.origin,
        key: apiKey,
        maxBytes: MAX_IMAGE_BYTES,
        signal,
      });
    } else
      throw new Error(
        'The image server returned no image. Expected data[0].b64_json or data[0].url.',
      );
    const mimeType = imageMimeType(data);
    throwIfAborted(signal);
    const image: GeneratedImage = {
      id,
      type: 'image',
      mimeType,
      filename: `generated-${id.slice(4, 16)}.${extensions[mimeType]}`,
      byteLength: data.length,
      prompt: request.prompt,
      model: images.modelId,
      createdAt: new Date().toISOString(),
    };
    const directory = await abortable(generatedDirectory(context.host.dataDir), signal);
    const destination = path.join(directory, imageFilename(image));
    const handle = await open(destination, 'wx', 0o600);
    let complete = false;
    try {
      await handle.writeFile(data, { signal });
      throwIfAborted(signal);
      complete = true;
    } finally {
      await handle.close();
      if (!complete) await unlink(destination).catch(() => {});
    }
    return image;
  } finally {
    releaseInference?.();
    releaseImage();
  }
}
