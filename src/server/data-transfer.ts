import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  DATA_TRANSFER_BROWSER_KEYS,
  DATA_TRANSFER_CHUNK_BYTES,
  DATA_TRANSFER_MAX_ARCHIVE_BYTES,
  type DataTransferBrowserState,
  type DataTransferInfo,
  type DataTransferJob,
  type DataTransferSummary,
} from '../shared/data-transfer.js';
import { importDataArchive } from './data-transfer-archive.js';
import type { Store } from './store.js';

const JOB_LIFETIME = 24 * 60 * 60 * 1_000;
const JOB_ID = /^[a-f0-9]{32}$/;
const passwordSchema = z
  .string()
  .refine((value) => Array.from(value).length >= 12, 'Use a password with at least 12 characters.')
  .max(1024)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 1024, 'Password is too long.');
const browserStateSchema = z
  .record(z.string(), z.string())
  .refine(
    (value) =>
      Object.keys(value).every((key) =>
        (DATA_TRANSFER_BROWSER_KEYS as readonly string[]).includes(key),
      ),
    'Unknown browser setting.',
  )
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 1024 ** 2,
    'Browser drafts are too large.',
  )
  .optional();

export function transferProblem(message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { statusCode, code: 'data_transfer_error' });
}

export function dataCounts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(
    (
      db
        .prepare(
          "SELECT kind,COUNT(*) AS count FROM objects WHERE kind != 'authSessions' GROUP BY kind",
        )
        .all() as { kind: string; count: number }[]
    ).map(({ kind, count }) => [kind, Number(count)]),
  );
}

// Include receipts and dedup state, not only the public snapshot. Login sessions
// remain local to this server and do not make an otherwise current preview stale.
export function dataFingerprint(db: DatabaseSync): string {
  const hash = createHash('sha256');
  for (const sql of [
    "SELECT * FROM objects WHERE kind != 'authSessions' ORDER BY kind,id",
    'SELECT * FROM secrets ORDER BY key',
    'SELECT * FROM events ORDER BY id',
    'SELECT * FROM dedup ORDER BY key',
  ]) {
    hash.update(sql);
    for (const row of db.prepare(sql).iterate()) hash.update(JSON.stringify(row)).update('\n');
  }
  return hash.digest('hex');
}

interface StoredJob {
  job: DataTransferJob;
  fingerprint?: string;
}

export interface DataTransferOperations {
  store(): Store;
  restoreResult(
    jobId: string,
  ): Promise<{ status: 'committed' | 'rolled-back'; backupPath?: string } | undefined>;
  exportArchive(input: {
    archivePath: string;
    password: string;
    browserState?: DataTransferBrowserState;
  }): Promise<DataTransferSummary>;
  restore(input: { stagingDir: string; jobId: string; fingerprint: string }): Promise<string>;
}

export class DataTransferService {
  readonly jobsDir: string;
  maintenance = false;
  private jobs = new Map<string, StoredJob>();
  private active?: string;
  private activeDone?: Promise<void>;
  private resolveActive?: () => void;
  private creating = false;
  private uploading = new Set<string>();
  private downloads = new Map<string, number>();
  private pending = new Set<Promise<void>>();
  private stopping = false;

  constructor(
    readonly dataDir: string,
    private operations: DataTransferOperations,
  ) {
    this.jobsDir = join(dataDir, '.loom-transfer', 'jobs');
  }

  async initialize() {
    await mkdir(this.jobsDir, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.jobsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
      try {
        const raw = JSON.parse(
          await readFile(join(this.jobsDir, entry.name, 'job.json'), 'utf8'),
        ) as StoredJob;
        if (raw.job?.id !== entry.name || !['export', 'import'].includes(raw.job.kind)) continue;
        const result =
          raw.job.kind === 'import' ? await this.operations.restoreResult(entry.name) : undefined;
        if (result?.status === 'committed') {
          raw.job.status = 'completed';
          raw.job.backupPath = result.backupPath;
          delete raw.job.error;
          delete raw.job.requiresNewUpload;
          delete raw.fingerprint;
        }
        // Preview tokens belong to the process that validated the staged files.
        // An interrupted job must be uploaded/checked again after a full restart.
        if (
          !['ready', 'failed', 'completed'].includes(raw.job.status) ||
          (raw.job.kind === 'import' && raw.job.status === 'ready')
        ) {
          if (
            raw.job.status === 'applying' ||
            result?.status === 'rolled-back' ||
            (raw.job.status === 'uploading' && raw.job.uploadedBytes !== raw.job.totalBytes)
          )
            raw.job.requiresNewUpload = true;
          raw.job.status = 'failed';
          raw.job.error =
            result?.status === 'rolled-back'
              ? 'The interrupted transfer was rolled back. Your previous data is restored. Start a new transfer to retry.'
              : 'Agent Loom restarted before the result was recorded. The outcome is unconfirmed; check the current data and retained backups before starting another transfer.';
          delete raw.job.preview;
          delete raw.fingerprint;
        }
        this.jobs.set(entry.name, raw);
        await this.save(raw);
      } catch {
        // Incomplete metadata is never used as an import plan. Preserve the
        // private files: an I/O failure while recording a completed restore
        // must not also erase its durable result or recoverable copy.
      }
    }
    await this.cleanup();
  }

  info(): DataTransferInfo {
    const latest = [...this.jobs.values()]
      .filter(({ job }) => Date.parse(job.expiresAt) > Date.now())
      .sort((a, b) => Date.parse(b.job.createdAt) - Date.parse(a.job.createdAt))[0]?.job;
    const activeJob = this.active ? this.jobs.get(this.active)?.job : latest;
    return {
      available: true,
      busy: Boolean(this.active || this.stopping),
      maxArchiveBytes: DATA_TRANSFER_MAX_ARCHIVE_BYTES,
      chunkBytes: DATA_TRANSFER_CHUNK_BYTES,
      ...(activeJob ? { activeJob } : {}),
    };
  }

  private path(id: string) {
    if (!JOB_ID.test(id)) transferProblem('Unknown transfer.', 404);
    return join(this.jobsDir, id);
  }

  private require(id: string) {
    const item = this.jobs.get(id);
    if (!JOB_ID.test(id) || !item || Date.parse(item.job.expiresAt) <= Date.now())
      transferProblem('This transfer has expired. Start it again.', 404);
    return item;
  }

  get(id: string): DataTransferJob {
    return this.require(id).job;
  }

  private async save(item: StoredJob) {
    item.job.updatedAt = new Date().toISOString();
    const path = join(this.path(item.job.id), 'job.json');
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(item), { mode: 0o600 });
    await rename(temporary, path);
  }

  private async cleanup() {
    for (const [id, item] of this.jobs) {
      if (
        Date.parse(item.job.expiresAt) > Date.now() ||
        id === this.active ||
        this.uploading.has(id) ||
        this.downloads.has(id)
      )
        continue;
      await rm(this.path(id), { recursive: true, force: true });
      this.jobs.delete(id);
    }
  }

  private available() {
    if (this.stopping) transferProblem('Agent Loom is shutting down.', 503);
    if (this.active)
      transferProblem('Another data transfer is in progress. Wait for it to finish.');
  }

  private reserve(id: string) {
    this.available();
    this.active = id;
    this.activeDone = new Promise<void>((resolve) => {
      this.resolveActive = resolve;
    });
  }

  private release(id: string) {
    if (this.active !== id) return;
    this.active = undefined;
    this.maintenance = false;
    this.resolveActive?.();
    this.resolveActive = undefined;
    this.activeDone = undefined;
  }

  private async saveReservation(item: StoredJob) {
    try {
      await this.save(item);
    } catch (error) {
      this.release(item.job.id);
      throw error;
    }
  }

  private async create(
    kind: 'export' | 'import',
    status: DataTransferJob['status'],
  ): Promise<StoredJob> {
    this.available();
    if (this.creating) transferProblem('Another transfer is being prepared. Please try again.');
    this.creating = true;
    try {
      await this.cleanup();
      if ([...this.jobs.values()].filter(({ job }) => job.status !== 'completed').length >= 3)
        transferProblem('Discard an earlier transfer before starting another.');
      const id = randomBytes(16).toString('hex');
      await mkdir(this.path(id), { recursive: true, mode: 0o700 });
      const item: StoredJob = {
        job: {
          id,
          kind,
          status,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + JOB_LIFETIME).toISOString(),
        },
      };
      this.jobs.set(id, item);
      return item;
    } finally {
      this.creating = false;
    }
  }

  private launch(item: StoredJob, operation: () => Promise<void>, reply: FastifyReply) {
    // Work that closes the HTTP server starts only after the accepted response.
    // setImmediate also permits Fastify's onResponse/drain bookkeeping to finish.
    let begin!: () => void;
    const accepted = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const pending = accepted
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(operation)
      .catch(async (error: unknown) => {
        const e = error as Error & { statusCode?: number };
        item.job.status = 'failed';
        item.job.error =
          e.statusCode && e.statusCode >= 400 && e.statusCode < 500
            ? e.message.slice(0, 500)
            : 'The transfer could not be completed. Check available disk space and the server log before retrying.';
        delete item.job.preview;
        delete item.fingerprint;
        await this.save(item).catch(() => {});
      })
      .finally(() => {
        this.release(item.job.id);
        this.pending.delete(pending);
      });
    this.pending.add(pending);
    let started = false;
    const once = () => {
      if (!started) {
        started = true;
        begin();
      }
    };
    reply.raw.once('finish', once);
    // A client disconnect after acceptance must not strand a reserved job.
    reply.raw.once('close', once);
    // The peer may have disconnected while the reservation was being saved,
    // before either listener existed. Do not leave shutdown waiting forever.
    if (reply.raw.destroyed || reply.raw.writableEnded) once();
  }

  async startExport(
    input: { password: string; browserState?: DataTransferBrowserState },
    reply: FastifyReply,
  ) {
    const item = await this.create('export', 'queued');
    this.reserve(item.job.id);
    await this.saveReservation(item);
    this.launch(
      item,
      async () => {
        item.job.status = 'working';
        await this.save(item);
        this.maintenance = true;
        try {
          item.job.summary = await this.operations.exportArchive({
            archivePath: join(this.path(item.job.id), 'archive.loom'),
            password: input.password,
            browserState: input.browserState,
          });
        } finally {
          input.password = '';
        }
        item.job.archiveBytes = (await stat(join(this.path(item.job.id), 'archive.loom'))).size;
        this.release(item.job.id);
        item.job.status = 'ready';
        await this.save(item);
      },
      reply,
    );
    return item.job;
  }

  async startImport(size: number) {
    const item = await this.create('import', 'uploading');
    item.job.totalBytes = size;
    item.job.uploadedBytes = 0;
    await writeFile(join(this.path(item.job.id), 'archive.loom'), '', { mode: 0o600, flag: 'wx' });
    await this.save(item);
    return item.job;
  }

  async upload(id: string, offset: number, bytes: Buffer) {
    this.available();
    const item = this.require(id);
    if (item.job.kind !== 'import' || item.job.status !== 'uploading')
      transferProblem('This transfer is not accepting a file.');
    if (this.uploading.has(id)) transferProblem('A file chunk is already being uploaded.');
    if (offset !== item.job.uploadedBytes)
      transferProblem('Upload position changed. Start the upload again.');
    if (
      !bytes.length ||
      bytes.length > DATA_TRANSFER_CHUNK_BYTES ||
      offset + bytes.length > item.job.totalBytes!
    )
      transferProblem('The uploaded file exceeds the expected size.', 413);
    this.uploading.add(id);
    const filePath = join(this.path(id), 'archive.loom');
    try {
      const file = await open(filePath, 'r+');
      try {
        const info = await file.stat();
        if (info.size !== offset) transferProblem('The staged upload changed. Start it again.');
        let written = 0;
        while (written < bytes.length) {
          const result = await file.write(bytes, written, bytes.length - written, offset + written);
          if (!result.bytesWritten) throw new Error('Could not write the transfer file.');
          written += result.bytesWritten;
        }
        await file.sync();
        item.job.uploadedBytes = offset + bytes.length;
        await this.save(item);
      } catch (error) {
        await file.truncate(offset);
        item.job.uploadedBytes = offset;
        throw error;
      } finally {
        await file.close();
      }
    } finally {
      this.uploading.delete(id);
    }
    return item.job;
  }

  async inspect(id: string, password: string, reply: FastifyReply) {
    this.available();
    const item = this.require(id);
    if (item.job.requiresNewUpload)
      transferProblem(
        'This replacement attempt has finished. Select the copy file again to start a new transfer.',
      );
    if (
      item.job.kind !== 'import' ||
      !['uploading', 'ready', 'failed'].includes(item.job.status) ||
      item.job.uploadedBytes !== item.job.totalBytes
    )
      transferProblem('Upload the complete file before checking it.');
    if (this.uploading.has(id)) transferProblem('Wait for the upload to finish.');
    this.reserve(id);
    item.job.status = 'working';
    delete item.job.error;
    delete item.job.preview;
    delete item.fingerprint;
    await this.saveReservation(item);
    this.launch(
      item,
      async () => {
        const stagingDir = join(this.path(id), 'data');
        await rm(stagingDir, { recursive: true, force: true });
        let preview;
        try {
          preview = await importDataArchive({
            archivePath: join(this.path(id), 'archive.loom'),
            stagingDir,
            destinationDataDir: this.dataDir,
            password,
          });
        } finally {
          password = '';
        }
        const store = this.operations.store();
        item.fingerprint = dataFingerprint(store.db);
        item.job.preview = {
          ...preview,
          token: randomBytes(32).toString('hex'),
          currentCounts: dataCounts(store.db),
        };
        item.job.status = 'ready';
        await this.save(item);
      },
      reply,
    );
    return item.job;
  }

  async apply(id: string, token: string, reply: FastifyReply) {
    this.available();
    const item = this.require(id);
    if (
      item.job.kind !== 'import' ||
      item.job.status !== 'ready' ||
      !item.fingerprint ||
      item.job.preview?.token !== token
    )
      transferProblem('Check this file again before replacing the data.');
    if (item.fingerprint !== dataFingerprint(this.operations.store().db))
      transferProblem(
        'The destination data changed after the preview. Check the file again to review the latest data.',
      );
    this.reserve(id);
    this.maintenance = true;
    item.job.status = 'applying';
    item.job.requiresNewUpload = true;
    await this.saveReservation(item);
    this.launch(
      item,
      async () => {
        item.job.backupPath = await this.operations.restore({
          stagingDir: join(this.path(id), 'data'),
          jobId: id,
          fingerprint: item.fingerprint!,
        });
        // The new app is already listening and its data commit is durable. A
        // completed job must mean ordinary API requests can succeed immediately;
        // job metadata and temporary-file cleanup must not prolong maintenance.
        this.release(id);
        item.job.status = 'completed';
        delete item.job.requiresNewUpload;
        delete item.fingerprint;
        // The replacement's durable result marker is authoritative. A metadata
        // write failure after commit must not label the completed copy as failed.
        await this.save(item).catch(() => {});
        await rm(join(this.path(id), 'archive.loom'), { force: true }).catch(() => {});
      },
      reply,
    );
    return item.job;
  }

  async download(id: string) {
    const job = this.get(id);
    if (job.kind !== 'export' || job.status !== 'ready')
      transferProblem('The copy file is not ready.');
    const path = join(this.path(id), 'archive.loom');
    await stat(path);
    this.downloads.set(id, (this.downloads.get(id) ?? 0) + 1);
    const stream = createReadStream(path);
    stream.once('close', () => {
      const count = (this.downloads.get(id) ?? 1) - 1;
      if (count) this.downloads.set(id, count);
      else this.downloads.delete(id);
    });
    return stream;
  }

  async discard(id: string) {
    this.require(id);
    if (this.active === id || this.uploading.has(id) || this.downloads.has(id))
      transferProblem('Wait for this transfer to finish.');
    await rm(this.path(id), { recursive: true, force: true });
    this.jobs.delete(id);
  }

  async shutdown() {
    this.stopping = true;
    await this.activeDone;
    await Promise.allSettled([...this.pending]);
  }
}

export function registerDataTransferRoutes(app: FastifyInstance, service?: DataTransferService) {
  app.get(
    '/api/data-transfer',
    async () =>
      service?.info() ?? {
        available: false,
        busy: false,
        maxArchiveBytes: DATA_TRANSFER_MAX_ARCHIVE_BYTES,
        chunkBytes: DATA_TRANSFER_CHUNK_BYTES,
      },
  );
  if (!service) return;
  app.post('/api/data-transfer/export', { bodyLimit: 1_100_000 }, async (request, reply) => {
    const input = z
      .object({ password: passwordSchema, browserState: browserStateSchema })
      .parse(request.body);
    return reply.code(202).send(await service.startExport(input, reply));
  });
  app.post('/api/data-transfer/import', async (request, reply) => {
    const { size } = z
      .object({ size: z.number().int().positive().max(DATA_TRANSFER_MAX_ARCHIVE_BYTES) })
      .parse(request.body);
    return reply.code(201).send(await service.startImport(size));
  });
  app.get<{ Params: { id: string } }>('/api/data-transfer/jobs/:id', async (request) =>
    service.get(request.params.id),
  );
  app.get<{ Params: { id: string } }>(
    '/api/data-transfer/jobs/:id/download',
    async (request, reply) => {
      const stream = await service.download(request.params.id);
      return reply
        .type('application/octet-stream')
        .header(
          'Content-Disposition',
          `attachment; filename="agent-loom-${request.params.id.slice(0, 8)}.loom"`,
        )
        .send(stream);
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/data-transfer/jobs/:id/inspect',
    async (request, reply) => {
      const { password } = z.object({ password: passwordSchema }).parse(request.body);
      return reply.code(202).send(await service.inspect(request.params.id, password, reply));
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/data-transfer/jobs/:id/apply',
    async (request, reply) => {
      const { previewToken } = z
        .object({ previewToken: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(request.body);
      return reply.code(202).send(await service.apply(request.params.id, previewToken, reply));
    },
  );
  app.delete<{ Params: { id: string } }>('/api/data-transfer/jobs/:id', async (request) => {
    await service.discard(request.params.id);
    return { ok: true };
  });
  // Keep binary parsing and its bounded chunk limit scoped to the upload route.
  app.register(async (uploads) => {
    uploads.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: DATA_TRANSFER_CHUNK_BYTES },
      (_request, body, done) => done(null, body),
    );
    uploads.put<{ Params: { id: string } }>(
      '/api/data-transfer/jobs/:id/upload',
      { bodyLimit: DATA_TRANSFER_CHUNK_BYTES },
      async (request) => {
        const rawOffset = request.headers['x-loom-offset'];
        if (typeof rawOffset !== 'string' || !/^(0|[1-9]\d{0,10})$/.test(rawOffset))
          transferProblem('A valid upload offset is required.', 400);
        if (!Buffer.isBuffer(request.body)) transferProblem('Upload a binary file.', 400);
        return service.upload(request.params.id, Number(rawOffset), request.body);
      },
    );
  });
}
