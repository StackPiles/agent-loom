import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app.js';
import { createManagedApp } from '../src/server/managed-app.js';
import type { Runtime, RuntimeShutdownReason } from '../src/server/runtime/contract.js';

function recorder(reasons: (RuntimeShutdownReason | undefined)[]): Runtime {
  return {
    start() {},
    async stop() {},
    async shutdown(reason) {
      reasons.push(reason);
    },
    queueState: () => ({ active: 0, waiting: 0 }),
  };
}

test('application close preserves the initiating cause and closes task admission before cleanup', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-lifecycle-close-'));
  const reasons: (RuntimeShutdownReason | undefined)[] = [];
  const f = await createApp({
    dataDir,
    scheduler: false,
    runtimeFactory: () => recorder(reasons),
  });
  t.after(async () => {
    await f.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  f.app.addHook('preClose', async () => {
    assert.equal(f.controller.closing, true);
    assert.throws(
      () =>
        f.controller.enqueueTask({
          roomId: 'room_lounge',
          botId: 'bot_aster',
          prompt: 'Must not start while closing.',
        }),
      /shutting down/,
    );
  });
  await f.app.ready();
  await Promise.all([f.close('supervisor_disconnect'), f.close('process_sigterm')]);
  assert.deepEqual(reasons, ['supervisor_disconnect']);
});

test('managed shutdown forwards its process cause to the runtime', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-lifecycle-managed-'));
  const reasons: (RuntimeShutdownReason | undefined)[] = [];
  const managed = await createManagedApp({
    dataDir,
    scheduler: false,
    port: 0,
    runtimeFactory: () => recorder(reasons),
  });
  t.after(async () => {
    await managed.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await Promise.all([managed.close('process_sigint'), managed.close('server_shutdown')]);
  assert.deepEqual(reasons, ['process_sigint']);
});

test('a listener startup failure is recorded without a user-stop attribution and releases the data lease', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-lifecycle-startup-'));
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const address = blocker.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });
  const reasons: (RuntimeShutdownReason | undefined)[] = [];
  await assert.rejects(
    createManagedApp({
      dataDir,
      scheduler: false,
      host: '127.0.0.1',
      port: address.port,
      runtimeFactory: () => recorder(reasons),
    }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EADDRINUSE',
  );
  assert.deepEqual(reasons, ['startup_failure']);
  const reopened = await createManagedApp({
    dataDir,
    scheduler: false,
    port: 0,
    runtimeFactory: () => recorder(reasons),
  });
  await reopened.close();
  assert.deepEqual(reasons, ['startup_failure', 'server_shutdown']);
});
