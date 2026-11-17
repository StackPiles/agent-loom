import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IMAGE_STORAGE_UNUSED_DAYS } from '../shared/image-storage.js';
import type { ImageStorage } from './image-storage.js';

const imageId = z.string().regex(/^img_[a-f0-9]{64}$/);
const imageIds = z.array(imageId).min(1).max(200);
const query = z
  .object({
    filter: z.enum(['all', 'candidates', 'protected', 'deleted']).optional(),
    sort: z.enum(['largest', 'oldest']).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
const settings = z
  .object({
    autoCleanup: z.boolean().optional(),
    unusedDays: z
      .number()
      .int()
      .min(IMAGE_STORAGE_UNUSED_DAYS.min)
      .max(IMAGE_STORAGE_UNUSED_DAYS.max)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one image storage setting.');
const cleanup = z.object({ imageIds }).strict();
const protection = z.object({ protected: z.boolean() }).strict();
const bulkProtection = z.object({ imageIds, protected: z.boolean() }).strict();
const use = z.object({ reason: z.enum(['open', 'download']) }).strict();

/** The application's existing loopback/API-token/origin checks cover these owner routes. */
export function registerImageStorageRoutes(app: FastifyInstance, storage: ImageStorage): void {
  app.get('/api/image-storage', async (request) => storage.list(query.parse(request.query)));
  app.patch('/api/image-storage/settings', async (request) =>
    storage.updateSettings(settings.parse(request.body)),
  );
  app.post('/api/image-storage/cleanup', async (request) =>
    storage.cleanup(cleanup.parse(request.body).imageIds),
  );
  app.post('/api/image-storage/protection', async (request) => {
    const input = bulkProtection.parse(request.body);
    return storage.protect(input.imageIds, input.protected);
  });
  app.put<{ Params: { id: string } }>('/api/images/:id/protection', async (request) =>
    storage.setProtected(
      imageId.parse(request.params.id),
      protection.parse(request.body).protected,
    ),
  );
  app.post<{ Params: { id: string } }>('/api/images/:id/use', async (request) => {
    storage.touch(imageId.parse(request.params.id), use.parse(request.body).reason);
    return { ok: true };
  });
  app.post('/api/image-storage/deduplicate', async (request) => {
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return storage.deduplicate();
  });
}
