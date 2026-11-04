import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  IMAGE_TEST_PREVIEW_TTL_MS,
  IMAGE_TEST_PROMPT,
  isActiveImageTest,
  type ImageTestJob,
  type ImageTestRequest,
} from '../shared/image-tests.js';
import type { GeneratedImage } from '../shared/types.js';
import { Controller, problem, required } from './controller.js';
import { generateImage, imageGenerationRequest } from './runtime/images.js';
import { throwIfAborted } from './runtime/gate.js';
import { Store, now } from './store.js';

const kind = 'imageTests';
const requestId = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const requestSchema = z
  .object({
    requestId,
    settings: z
      .object({
        baseUrl: z.string().trim().min(1).max(2000),
        modelId: z.string().trim().min(1).max(250),
        size: z.string().trim().min(1).max(30),
        responseFormat: z.enum(['auto', 'b64_json']),
        timeoutSeconds: z.number().int().min(10).max(1800),
        shareInferenceSlot: z.boolean(),
      })
      .strict(),
    apiKey: z.string().max(4096).optional(),
  })
  .strict();

interface StoredJob extends ImageTestJob {
  fingerprint?: string;
}
interface Preview {
  image: GeneratedImage;
  data: Buffer;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}
export interface ImageTestAdapters {
  /** Test seams; production uses the entered timeout and the normal preview lifetime. */
  timeoutMs?: number;
  previewTtlMs?: number;
}

function origin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/** Durable request receipts prevent replay; unsaved credentials and preview pixels stay in memory. */
export function createImageTests(
  store: Store,
  controller: Controller,
  adapters: ImageTestAdapters = {},
) {
  const running = new Map<string, { abort: AbortController; finished: Promise<void> }>();
  const previews = new Map<string, Preview>();
  // The secret HMAC key is deliberately process-local. Persisted fingerprints
  // cannot disclose an entered credential, and a restart never repeats a POST.
  const fingerprintKey = randomBytes(32);
  let closing = false;
  for (const job of store.list<StoredJob>(kind))
    if (isActiveImageTest(job))
      store.patch<StoredJob>(kind, job.id, {
        status: 'interrupted',
        errorCode: 'interrupted',
        error: 'The server restarted. This image test was not repeated.',
        updatedAt: now(),
      });

  function forgetPreview(id: string) {
    const preview = previews.get(id);
    if (preview) clearTimeout(preview.timer);
    previews.delete(id);
  }
  function currentPreview(id: string) {
    const preview = previews.get(id);
    if (preview && preview.expiresAt <= Date.now()) forgetPreview(id);
    return previews.get(id);
  }
  function publicJob(job: StoredJob): ImageTestJob {
    const { fingerprint: _fingerprint, image: _image, ...value } = job;
    const preview = currentPreview(job.id);
    return {
      ...value,
      previewAvailable: Boolean(preview),
      ...(preview ? { image: preview.image } : {}),
    };
  }
  const get = (id: string) => publicJob(required<StoredJob>(store, kind, id));
  function update(id: string, patch: Partial<StoredJob>) {
    store.patch<StoredJob>(kind, id, { ...patch, updatedAt: now() });
  }

  function start(raw: ImageTestRequest): ImageTestJob {
    if (controller.maintenance)
      problem('Agent Loom is updating. Please wait for it to restart.', 503);
    const input = requestSchema.parse(raw);
    if (closing || controller.closing) problem('The server is shutting down.', 503);
    const previous = store.get<StoredJob>(kind, input.requestId);
    // Cancellation can arrive before a disconnected POST. Its tombstone must
    // suppress that late request even though it has no settings fingerprint.
    if (previous?.status === 'cancelled' && !previous.fingerprint) return publicJob(previous);
    const settings = structuredClone(store.settings());
    settings.images = { ...input.settings, enabled: true, apiKeyConfigured: false };
    let endpoint: URL;
    try {
      endpoint = imageGenerationRequest(settings, { prompt: IMAGE_TEST_PROMPT }).endpoint;
    } catch (error) {
      problem(error instanceof Error ? error.message : 'Invalid image generation settings.');
    }
    const savedOrigin = origin(store.settings().images?.baseUrl ?? '');
    const apiKey =
      input.apiKey ?? (endpoint.origin === savedOrigin ? (store.secret('image.apiKey') ?? '') : '');
    const fingerprint = createHmac('sha256', fingerprintKey)
      .update(JSON.stringify({ settings: input.settings, apiKey }))
      .digest('hex');
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        problem(
          'This request ID belongs to an earlier image test. Check its result or start a new test.',
          409,
        );
      return publicJob(previous);
    }
    if (running.size)
      problem('An image settings test is already running. Wait for it or cancel it first.', 409);
    const policy = settings.permissions.network;
    if (policy === 'deny') problem('Image generation is disabled by the network permission.', 403);
    const acquireInference = controller.runtime?.acquireInference?.bind(controller.runtime);
    if (settings.images.shareInferenceSlot && !acquireInference)
      problem('The inference runtime cannot reserve an image-generation slot.', 503);
    const timeoutMs = adapters.timeoutMs ?? settings.images.timeoutSeconds * 1000;
    const stamp = now();
    const job = store.put<StoredJob>(kind, {
      id: input.requestId,
      status: 'queued',
      baseUrl: input.settings.baseUrl,
      modelId: input.settings.modelId,
      size: input.settings.size,
      createdAt: stamp,
      updatedAt: stamp,
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
      previewAvailable: false,
      fingerprint,
    });
    const abort = new AbortController();
    let timedOut = false;
    // Include queue waiting in the deadline, rather than waiting indefinitely
    // for a busy shared inference slot.
    const timeout = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, timeoutMs);
    timeout.unref();
    const finished = Promise.resolve().then(async () => {
      try {
        throwIfAborted(abort.signal);
        let previewExpiresAt: string | undefined;
        const imageId =
          'img_' +
          createHash('sha256')
            .update('image-test\0' + job.id)
            .digest('hex');
        const image = await generateImage(
          {
            host: controller,
            settings,
            signal: abort.signal,
            acquireInference,
            apiKey,
            onState: (status) => update(job.id, { status }),
            async saveImage(image, data, signal) {
              throwIfAborted(signal);
              const ttl = adapters.previewTtlMs ?? IMAGE_TEST_PREVIEW_TTL_MS;
              const expiresAt = Date.now() + ttl;
              previewExpiresAt = new Date(expiresAt).toISOString();
              const timer = setTimeout(() => forgetPreview(job.id), ttl);
              timer.unref();
              previews.set(job.id, { image, data, expiresAt, timer });
              // Keep at most three temporary previews, each already bounded to
              // the shared 20 MiB raster limit. No image is added to a conversation.
              while (previews.size > 3) forgetPreview(previews.keys().next().value!);
              return image;
            },
          },
          { prompt: IMAGE_TEST_PROMPT },
          imageId,
          policy,
        );
        throwIfAborted(abort.signal);
        update(job.id, {
          status: 'completed',
          image,
          previewExpiresAt,
        });
      } catch (error) {
        forgetPreview(job.id);
        if (abort.signal.aborted) {
          const status = closing ? 'interrupted' : timedOut ? 'failed' : 'cancelled';
          update(job.id, {
            status,
            errorCode: closing ? 'interrupted' : timedOut ? 'timeout' : 'cancelled',
            error: closing
              ? 'The server shut down. This image test was not repeated.'
              : timedOut
                ? 'The image test timed out, including time waiting for a generation slot. It was not repeated.'
                : 'The image test was cancelled. It was not repeated.',
          });
        } else {
          let message = error instanceof Error ? error.message : String(error);
          for (const secret of [apiKey, ...Object.values(controller.getSecrets())])
            if (secret) message = message.split(secret).join('[redacted]');
          update(job.id, {
            status: 'failed',
            errorCode: 'generation_failed',
            error: message.slice(0, 2000),
          });
        }
      } finally {
        clearTimeout(timeout);
        running.delete(job.id);
      }
    });
    running.set(job.id, { abort, finished });
    return publicJob(job);
  }

  async function cancel(id: string): Promise<ImageTestJob> {
    if (closing) problem('The server is shutting down.', 503);
    const previous = store.get<StoredJob>(kind, id);
    if (!previous) {
      const stamp = now();
      return publicJob(
        store.put<StoredJob>(kind, {
          id,
          status: 'cancelled',
          baseUrl: '',
          modelId: '',
          size: '',
          createdAt: stamp,
          updatedAt: stamp,
          previewAvailable: false,
          errorCode: 'cancelled',
          error: 'This image test was cancelled before it started.',
        }),
      );
    }
    const worker = running.get(id);
    worker?.abort.abort();
    if (worker) await worker.finished;
    forgetPreview(id);
    return get(id);
  }

  return {
    start,
    get,
    cancel,
    preview(id: string) {
      required<StoredJob>(store, kind, id);
      const preview = currentPreview(id);
      if (!preview) problem('This temporary image preview is no longer available.', 410);
      return preview;
    },
    async shutdown() {
      closing = true;
      const workers = [...running.values()];
      for (const worker of workers) worker.abort.abort();
      await Promise.allSettled(workers.map((worker) => worker.finished));
      for (const id of previews.keys()) forgetPreview(id);
    },
  };
}

export function registerImageTestRoutes(
  app: FastifyInstance,
  tests: ReturnType<typeof createImageTests>,
) {
  app.post('/api/image-tests', async (request, reply) => {
    const job = tests.start(requestSchema.parse(request.body));
    const disconnected = () => {
      if (!reply.raw.writableEnded) void tests.cancel(job.id).catch(() => {});
    };
    reply.raw.once('close', disconnected);
    reply.raw.once('finish', () => reply.raw.off('close', disconnected));
    if (reply.raw.destroyed) disconnected();
    return reply.code(isActiveImageTest(job) ? 202 : 200).send(job);
  });
  app.get<{ Params: { id: string } }>('/api/image-tests/:id', async (request) =>
    tests.get(requestId.parse(request.params.id)),
  );
  app.delete<{ Params: { id: string } }>('/api/image-tests/:id', async (request) =>
    tests.cancel(requestId.parse(request.params.id)),
  );
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    '/api/image-tests/:id/image',
    async (request, reply) => {
      const { image, data } = tests.preview(requestId.parse(request.params.id));
      const download = z
        .object({ download: z.literal('1').optional() })
        .parse(request.query).download;
      return reply
        .type(image.mimeType)
        .header('Cache-Control', 'no-store')
        .header(
          'Content-Disposition',
          (download ? 'attachment' : 'inline') + '; filename="' + image.filename + '"',
        )
        .send(data);
    },
  );
}
