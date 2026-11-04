import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createManagedApp } from '../src/server/managed-app.js';
import { createApp } from '../src/server/app.js';
import { EventEmitter } from 'node:events';
import type { FastifyReply } from 'fastify';
import { DataTransferService } from '../src/server/data-transfer.js';
import type { DataTransferJob } from '../src/shared/data-transfer.js';

const PASSWORD = 'test-only transfer password 123';
const fakeRuntime = () => ({
  start() {},
  async stop() {},
  async shutdown() {},
  queueState: () => ({ active: 0, waiting: 0 }),
});

async function fixture(t: TestContext, name: string, beforeClose?: () => void) {
  const dataDir = await mkdtemp(join(tmpdir(), `loom-transfer-${name}-`));
  const apiToken = `${name}-local-server-access-token-long-enough`;
  const managed = await createManagedApp({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    apiToken,
    scheduler: false,
    runtimeFactory: fakeRuntime,
  });
  t.after(async () => {
    beforeClose?.();
    await managed.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${managed.address}${path}`, {
      signal: AbortSignal.timeout(5_000),
      ...init,
      headers: { authorization: `Bearer ${apiToken}`, ...init.headers },
    });
  const json = (path: string, value: unknown) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  const waitFor = async (id: string, status: DataTransferJob['status']) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await call(`/api/data-transfer/jobs/${id}`);
        if (response.ok) {
          const job = (await response.json()) as DataTransferJob;
          if (job.status === status) return job;
          assert.notEqual(job.status, 'failed', job.error);
        }
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
      }
      await delay(10);
    }
    throw new Error(`Transfer never reached ${status}`);
  };
  return { dataDir, apiToken, managed, call, json, waitFor };
}

test('encrypted copy crosses live servers, retains local login and receipts, and pauses imported automation', async (t) => {
  let finishCompletedRecord: (() => void) | undefined;
  const source = await fixture(t, 'source');
  const destination = await fixture(t, 'destination', () => finishCompletedRecord?.());
  const sourceStore = source.managed.current!.store;
  const stamp = new Date().toISOString();
  sourceStore.setSecret('model.apiKey', 'synthetic-source-api-key');
  sourceStore.setSecret('mail.test.password', 'synthetic-mail-password');
  sourceStore.put('messages', {
    id: 'message_to_copy',
    roomId: 'room_lounge',
    authorType: 'user',
    authorId: 'user',
    body: 'A persistent conversation',
    status: 'complete',
    createdAt: stamp,
  });
  sourceStore.put('operations', {
    id: 'operation_original',
    key: 'operation_original',
    status: 'completed',
    args: { path: join(source.dataDir, 'workspace', 'original.txt') },
    result: 'already completed',
  });
  sourceStore.put('mailSends', {
    id: 'send_original',
    status: 'unknown',
    requestId: 'request_original',
  });
  sourceStore.remember('mail:event:already-processed');
  sourceStore.put('automations', {
    id: 'automation_copy',
    name: 'Imported timer',
    enabled: true,
    botId: 'bot_aster',
    roomId: 'room_lounge',
    kind: 'interval',
    sourceUrl: '',
    intervalMinutes: 5,
    prompt: 'test',
    createdAt: stamp,
    updatedAt: stamp,
    nextRunAt: '2020-01-01T00:00:00.000Z',
  });
  await mkdir(join(source.dataDir, 'workspace'), { recursive: true });
  await writeFile(join(source.dataDir, 'workspace', 'copy.txt'), 'workspace data');
  await writeFile(join(destination.dataDir, 'destination-only.txt'), 'retain in automatic backup');
  const sourceLogin = await source.json('/api/auth', { token: source.apiToken });
  const sourceCookie = sourceLogin.headers.get('set-cookie')!.split(';')[0];
  const destinationLogin = await destination.json('/api/auth', { token: destination.apiToken });
  const destinationCookie = destinationLogin.headers.get('set-cookie')!.split(';')[0];

  const exportResponse = await source.json('/api/data-transfer/export', {
    password: PASSWORD,
    browserState: { 'loom.locale': 'ja', 'loom.drafts': '{"room_lounge":"unsent"}' },
  });
  assert.equal(exportResponse.status, 202);
  const exportJob = (await exportResponse.json()) as DataTransferJob;
  const exported = await source.waitFor(exportJob.id, 'ready');
  assert.equal(exported.summary?.counts.messages, 1);
  const archive = Buffer.from(
    await (await source.call(`/api/data-transfer/jobs/${exportJob.id}/download`)).arrayBuffer(),
  );
  assert.ok(archive.length > 100);
  assert.equal(archive.includes(Buffer.from('synthetic-source-api-key')), false);

  const importedResponse = await destination.json('/api/data-transfer/import', {
    size: archive.length,
  });
  assert.equal(importedResponse.status, 201);
  const imported = (await importedResponse.json()) as DataTransferJob;
  const base = `/api/data-transfer/jobs/${imported.id}`;
  const upload = await destination.call(`${base}/upload`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'x-loom-offset': '0' },
    body: archive,
  });
  assert.equal(upload.status, 200);
  assert.equal(((await upload.json()) as DataTransferJob).uploadedBytes, archive.length);
  assert.equal((await destination.json(`${base}/inspect`, { password: PASSWORD })).status, 202);
  let preview = await destination.waitFor(imported.id, 'ready');
  assert.equal(preview.preview?.counts.messages, 1);
  assert.equal(preview.preview?.disabledAutomations, 1);
  assert.equal(preview.preview?.browserState?.['loom.locale'], 'ja');
  assert.equal(destination.managed.current!.store.get('messages', 'message_to_copy'), undefined);

  // A preview is a plan for a specific destination generation, not a blanket
  // authorization to discard messages arriving while the user reviews it.
  destination.managed.current!.store.put('memories', {
    id: 'new_after_preview',
    content: 'Keep until reviewed',
  });
  assert.equal(
    (await destination.json(`${base}/apply`, { previewToken: preview.preview!.token })).status,
    409,
  );
  const jobRecorder = destination.managed.dataTransfer as unknown as {
    save(item: { job: DataTransferJob }): Promise<void>;
  };
  const recordJob = jobRecorder.save.bind(jobRecorder);
  let finishReadyRecord!: () => void, readyWriteEntered!: () => void;
  const readyRecord = new Promise<void>((resolve) => {
    finishReadyRecord = resolve;
  });
  const savingReady = new Promise<void>((resolve) => {
    readyWriteEntered = resolve;
  });
  jobRecorder.save = async (item) => {
    if (item.job.status === 'ready') {
      readyWriteEntered();
      await readyRecord;
    }
    await recordJob(item);
  };
  assert.equal((await destination.json(`${base}/inspect`, { password: PASSWORD })).status, 202);
  try {
    await Promise.race([
      savingReady,
      delay(30_000, undefined, { ref: false }).then(() => {
        throw new Error('Preview metadata was not written.');
      }),
    ]);
    const whileSaving = await destination.call(base);
    assert.equal(((await whileSaving.json()) as DataTransferJob).status, 'working');
    assert.equal(destination.managed.dataTransfer.info().busy, true);
  } finally {
    finishReadyRecord();
  }
  preview = await destination.waitFor(imported.id, 'ready');
  assert.equal(
    destination.managed.dataTransfer.info().busy,
    false,
    'ready means apply can start immediately',
  );
  const completedRecord = new Promise<void>((resolve) => {
    finishCompletedRecord = resolve;
  });
  jobRecorder.save = async (item) => {
    if (item.job.status === 'completed') {
      // Keep final metadata pending until the live API has been checked, so a
      // premature completed status cannot hide behind a fast local filesystem.
      await completedRecord;
      throw new Error('Synthetic final metadata write failure');
    }
    await recordJob(item);
  };
  assert.equal(
    (await destination.json(`${base}/apply`, { previewToken: preview.preview!.token })).status,
    202,
  );
  const completed = await destination.waitFor(imported.id, 'completed');
  assert.equal(destination.managed.dataTransfer.info().busy, false);
  const restored = destination.managed.current!.store;
  assert.equal(restored.secret('model.apiKey'), 'synthetic-source-api-key');
  assert.equal(restored.secret('mail.test.password'), 'synthetic-mail-password');
  assert.equal(restored.settings().workspacePath, join(destination.dataDir, 'workspace'));
  assert.equal(restored.list<{ enabled: boolean }>('automations')[0].enabled, false);
  assert.equal(restored.get<{ status: string }>('mailSends', 'send_original')?.status, 'unknown');
  assert.equal(restored.remember('mail:event:already-processed'), false);
  assert.equal(
    restored.get<{ args: { path: string } }>('operations', 'operation_original')?.args.path,
    join(source.dataDir, 'workspace', 'original.txt'),
  );
  assert.equal(
    await readFile(join(destination.dataDir, 'workspace', 'copy.txt'), 'utf8'),
    'workspace data',
  );
  assert.equal(
    await readFile(join(completed.backupPath!, 'destination-only.txt'), 'utf8'),
    'retain in automatic backup',
  );
  await assert.rejects(access(join(destination.dataDir, 'destination-only.txt')));
  assert.equal(
    (
      await fetch(`${destination.managed.address}/api/state`, {
        headers: { cookie: destinationCookie },
      })
    ).status,
    200,
  );
  assert.equal(
    (await fetch(`${destination.managed.address}/api/state`, { headers: { cookie: sourceCookie } }))
      .status,
    401,
  );
  assert.equal(restored.list('authSessions').length, 1);
  assert.equal(
    (await destination.json(`${base}/apply`, { previewToken: preview.preview!.token })).status,
    409,
  );

  // The completed result remains accurate despite that metadata failure, and
  // startup must recover the committed outcome from the independent marker.
  const jobPath = join(destination.dataDir, '.loom-transfer', 'jobs', imported.id, 'job.json');
  const unfinished = JSON.parse(await readFile(jobPath, 'utf8'));
  assert.equal(unfinished.job.status, 'applying');
  assert.equal(unfinished.job.backupPath, undefined);
  // Pausing is durable, including the first real scheduler tick after restart.
  finishCompletedRecord!();
  await destination.managed.close();
  const reopened = await createManagedApp({
    dataDir: destination.dataDir,
    port: 0,
    apiToken: destination.apiToken,
    runtimeFactory: fakeRuntime,
  });
  try {
    await delay(20);
    assert.equal(
      reopened.current!.store.list<{ enabled: boolean }>('automations')[0].enabled,
      false,
    );
    assert.equal(reopened.current!.store.list('tasks').length, 0);
    assert.equal(reopened.dataTransfer.info().activeJob?.status, 'completed');
    assert.equal(reopened.dataTransfer.info().activeJob?.backupPath, completed.backupPath);
  } finally {
    await reopened.close();
  }
});

test('transfer endpoints preserve auth/origin checks and reject incomplete or oversized uploads without replacing data', async (t) => {
  const f = await fixture(t, 'guard');
  assert.equal((await fetch(`${f.managed.address}/api/data-transfer`)).status, 401);
  assert.equal(
    (await f.call('/api/data-transfer', { headers: { origin: 'https://other.example' } })).status,
    403,
  );
  assert.equal((await f.json('/api/data-transfer/export', { password: 'short' })).status, 400);
  const response = await f.json('/api/data-transfer/import', { size: 8 });
  const job = (await response.json()) as DataTransferJob;
  const base = `/api/data-transfer/jobs/${job.id}`;
  assert.equal((await f.json(`${base}/inspect`, { password: PASSWORD })).status, 409);
  assert.equal(
    (
      await f.call(`${base}/upload`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-loom-offset': '1' },
        body: new Uint8Array(1),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call(`${base}/upload`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-loom-offset': '0' },
        body: new Uint8Array(9),
      })
    ).status,
    413,
  );
  assert.equal((await f.call(base, { method: 'DELETE' })).status, 200);
  assert.equal((await f.call(base)).status, 404);
  assert.equal(f.managed.current!.store.list('messages').length, 0);
});

test('failed app initialization releases the data directory for recovery', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-transfer-failed-init-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await assert.rejects(
    createApp({
      dataDir,
      runtimeFactory() {
        throw new Error('synthetic initialization failure');
      },
    }),
    /synthetic initialization failure/,
  );
  const app = await createApp({ dataDir, scheduler: false, runtimeFactory: fakeRuntime });
  await app.app.close();
});

test('a peer disconnected during reservation cannot strand a transfer or server shutdown', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-transfer-disconnected-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let exports = 0;
  const service = new DataTransferService(dataDir, {
    store() {
      throw new Error('The export does not need a live Store.');
    },
    restoreResult: async () => undefined,
    restore: async () => {
      throw new Error('Unexpected restore.');
    },
    exportArchive: async ({ archivePath }) => {
      exports++;
      await writeFile(archivePath, 'synthetic archive');
      return {
        version: '0.4.0',
        createdAt: new Date().toISOString(),
        platform: process.platform,
        counts: {},
        fileCount: 0,
        totalBytes: 0,
        workspaces: [],
        warnings: [],
      };
    },
  });
  await service.initialize();
  const raw = Object.assign(new EventEmitter(), { destroyed: true, writableEnded: false });
  const job = await service.startExport({ password: PASSWORD }, { raw } as unknown as FastifyReply);
  await Promise.race([
    service.shutdown(),
    delay(1000).then(() => {
      throw new Error('Shutdown was stranded by the disconnected response.');
    }),
  ]);
  assert.equal(exports, 1);
  assert.equal(service.get(job.id).status, 'ready');
});
