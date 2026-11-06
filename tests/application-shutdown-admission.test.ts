import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../src/server/app.js';
import type { Room, Task } from '../src/shared/types.js';

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

test('application shutdown closes real Pi admission before waiting for owner-generation cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-shutdown-admission-'));
  const responses: ServerResponse[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) {
        // The actual Pi POST must reach this loopback server before closing.
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      responses.push(response);
    })().catch((error) => response.destroy(error as Error));
  });
  let f: Awaited<ReturnType<typeof createApp>> | undefined;
  let closing: Promise<void> | undefined;
  let releaseOwnerCleanup!: () => void;
  const ownerCleanupHeld = new Promise<void>((resolve) => {
    releaseOwnerCleanup = resolve;
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    f = await createApp({ dataDir: directory, scheduler: false });
    const settings = f.store.settings();
    f.store.put('settings', {
      ...settings,
      id: 'main',
      demoMode: false,
      autoLearn: false,
      inference: { maxConcurrentRequests: 2 },
      model: {
        ...settings.model,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'shutdown-fixture',
        responseTimeoutSeconds: 30,
      },
    });
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: { name: 'Shutdown admission fixture', botIds: ['bot_aster'] },
    });
    assert.equal(created.statusCode, 200, created.body);
    const room = created.json<Room>();
    const post = async (body: string) => {
      const result = await f!.app.inject({
        method: 'POST',
        url: `/api/rooms/${room.id}/messages`,
        payload: { body, botIds: ['bot_aster'] },
      });
      assert.equal(result.statusCode, 200, result.body);
      return result.json<{ tasks: Task[] }>().tasks[0].id;
    };
    const first = await post('Finish the first task.');
    await until(() => responses.length === 1, 'first real Pi request accepted');
    const second = await post('Run only after the first task.');
    await until(
      () =>
        f!.runtime
          .queueState()
          .waitingTasks?.some((entry) => entry.taskId === second && entry.reason === 'session') ===
        true,
      'second task waiting for its bot and room session',
    );

    let ownerCleanupStarted = false;
    let closeSettled = false;
    const originalShutdown = f.avatarGenerations.shutdown.bind(f.avatarGenerations);
    f.avatarGenerations.shutdown = async () => {
      await originalShutdown();
      ownerCleanupStarted = true;
      await ownerCleanupHeld;
    };
    closing = f.close('process_sigterm').then(() => {
      closeSettled = true;
    });
    await until(
      () => ownerCleanupStarted && f!.controller.closing,
      'application closing while owner cleanup remains held',
    );

    // Before the fix, controller.closing was already true here, but runtime
    // pump() could still start the next task as soon as this response finished.
    // After the fix this request is cancelled; a late server completion must
    // not free the session into a new model request during application cleanup.
    if (!responses[0].destroyed) {
      const chunk = (delta: object, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id: 'shutdown-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      responses[0].end(
        chunk({ content: 'Finished during application shutdown.' }) +
          chunk({}, 'stop') +
          'data: [DONE]\n\n',
      );
    }
    await until(
      () =>
        ['completed', 'failed', 'stopped', 'interrupted'].includes(
          f!.store.get<Task>('tasks', first)!.status,
        ),
      'first task settled',
    );
    await until(
      () => f!.store.get<Task>('tasks', second)!.status !== 'queued',
      'waiting task settled without starting its model request',
    );
    assert.equal(closeSettled, false, 'the owner cleanup barrier must still hold app.close');
    for (const id of [first, second]) {
      const task = f.store.get<Task>('tasks', id)!;
      assert.equal(task.status, 'interrupted', task.error);
      assert.match(task.error!, /server received SIGTERM/);
    }
    await until(() => f!.runtime.queueState().active === 0, 'inference capacity released');
    assert.equal(responses.length, 1, 'shutdown must not post the second request to the model');
    assert.equal(f.runtime.queueState().waiting, 0);
  } finally {
    // Release even on an assertion failure so neither the app nor the test
    // runner can remain stuck in the deliberately held shutdown hook.
    releaseOwnerCleanup();
    try {
      await (closing ?? f?.close());
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }
});
