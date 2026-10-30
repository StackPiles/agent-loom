import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AvatarGeneration } from '../shared/types.js';
import { Controller, problem, required } from './controller.js';
import { generateImage, imageGenerationRequest } from './runtime/images.js';
import { throwIfAborted } from './runtime/gate.js';
import { Store, now } from './store.js';

const kind = 'avatarGenerations';
const active = (job: AvatarGeneration) => job.status === 'queued' || job.status === 'generating';
const jobId = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const requestSchema = z.object({
  requestId: jobId,
  prompt: z.string().trim().min(1).max(16_000),
});

export function hasActiveAvatarGeneration(store: Store): boolean {
  return store.list<AvatarGeneration>(kind).some(active);
}

/** User-initiated image jobs survive navigation; uncertain generations are never replayed. */
export function createAvatarGenerations(store: Store, controller: Controller) {
  const running = new Map<string, { abort: AbortController; finished: Promise<void> }>();
  let closing = false;
  for (const job of store.list<AvatarGeneration>(kind)) {
    if (job.image) store.put('images', job.image);
    if (active(job))
      store.patch<AvatarGeneration>(kind, job.id, {
        status: 'interrupted',
        error:
          'The server restarted. The image request was not repeated. Generate again explicitly if needed.',
        updatedAt: now(),
      });
  }

  function update(id: string, patch: Partial<AvatarGeneration>) {
    store.patch<AvatarGeneration>(kind, id, { ...patch, updatedAt: now() });
    controller.changed();
  }

  function start(input: z.infer<typeof requestSchema>): AvatarGeneration {
    const previous = store.get<AvatarGeneration>(kind, input.requestId);
    if (previous) {
      if (previous.prompt !== input.prompt)
        problem('That image request ID is already associated with a different prompt.', 409);
      return previous;
    }
    if (closing || controller.closing) problem('The server is shutting down.', 503);
    if (hasActiveAvatarGeneration(store))
      problem(
        'An avatar is already being generated. Wait for it to finish or cancel it first.',
        409,
      );
    const settings = structuredClone(store.settings());
    const policy = settings.permissions.network;
    if (policy === 'deny') problem('Image generation is disabled by the network permission.', 403);
    // Validate before saving a job. The Generate button is the user's explicit
    // consent for this prompt; chat-tool approval cards are not involved.
    try {
      imageGenerationRequest(settings, { prompt: input.prompt });
    } catch (error) {
      problem(error instanceof Error ? error.message : 'Invalid image generation settings.');
    }
    const acquireInference = controller.runtime?.acquireInference?.bind(controller.runtime);
    if (settings.images?.shareInferenceSlot !== false && !acquireInference)
      problem('The inference runtime cannot reserve a shared image-generation slot.', 503);
    const secrets = Object.values(controller.getSecrets()).filter(Boolean) as string[];
    const stamp = now();
    const job = store.put<AvatarGeneration>(kind, {
      id: input.requestId,
      status: 'queued',
      prompt: input.prompt,
      createdAt: stamp,
      updatedAt: stamp,
    });
    const abort = new AbortController();
    const finished = Promise.resolve()
      .then(async () => {
        try {
          throwIfAborted(abort.signal);
          const imageId = `img_${createHash('sha256').update(`avatar\0${job.id}`).digest('hex')}`;
          const image = await generateImage(
            {
              host: controller,
              settings,
              signal: abort.signal,
              acquireInference,
              onState: (status) => update(job.id, { status }),
            },
            { prompt: job.prompt },
            imageId,
            policy,
          );
          // Index even a just-cancelled completed raster so there is no unsafe
          // file lookup or unindexed provider URL in subsequent requests.
          store.put('images', image);
          throwIfAborted(abort.signal);
          update(job.id, { status: 'completed', image });
        } catch (error) {
          if (abort.signal.aborted) {
            update(job.id, {
              status: closing ? 'interrupted' : 'cancelled',
              error: closing
                ? 'The server shut down. The image request was not repeated.'
                : 'Image generation was cancelled. The request will not be repeated automatically.',
            });
          } else {
            let message = error instanceof Error ? error.message : String(error);
            for (const secret of [...secrets, ...Object.values(controller.getSecrets())])
              if (secret) message = message.split(secret).join('[redacted]');
            update(job.id, { status: 'failed', error: message.slice(0, 4_000) });
          }
        }
      })
      .finally(() => running.delete(job.id));
    running.set(job.id, { abort, finished });
    controller.changed();
    return job;
  }

  return {
    start,
    list: () => store.list<AvatarGeneration>(kind).slice(-20).reverse(),
    get: (id: string) => required<AvatarGeneration>(store, kind, id),
    async cancel(id: string) {
      const job = required<AvatarGeneration>(store, kind, id);
      const worker = running.get(id);
      if (active(job) && worker) {
        worker.abort.abort();
        await worker.finished;
      }
      return required<AvatarGeneration>(store, kind, id);
    },
    async shutdown() {
      closing = true;
      const jobs = [...running.values()];
      for (const job of jobs) job.abort.abort();
      await Promise.allSettled(jobs.map((job) => job.finished));
    },
  };
}

export function registerAvatarGenerationRoutes(
  app: FastifyInstance,
  jobs: ReturnType<typeof createAvatarGenerations>,
) {
  app.get('/api/avatar-generations', async () => jobs.list());
  app.post('/api/avatar-generations', async (req, reply) => {
    const result = jobs.start(requestSchema.parse(req.body));
    return reply.code(active(result) ? 202 : 200).send(result);
  });
  app.get<{ Params: { id: string } }>('/api/avatar-generations/:id', async (req) =>
    jobs.get(jobId.parse(req.params.id)),
  );
  app.delete<{ Params: { id: string } }>('/api/avatar-generations/:id', async (req) =>
    jobs.cancel(jobId.parse(req.params.id)),
  );
}
