import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import type { Approval, Snapshot, Task } from '../src/shared/types.js';

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}

test(
  'complete app workflow: handoff, stopped approval, resume, file, notification and candidate skill',
  { timeout: 25_000 },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'loom-workflow-'));
    const { app, controller } = await createApp({ dataDir, scheduler: false });
    t.after(async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const call = (url: string, payload?: object) =>
      app.inject({ method: 'POST', url, payload, headers: { host: 'localhost' } });
    await call('/api/demo', { enabled: true });
    const response = await call('/api/rooms/room_lounge/messages', { body: 'デモを実行して' });
    assert.equal(response.statusCode, 200);
    const root = response.json<{ tasks: Task[] }>().tasks[0];
    let first: Approval | undefined;
    await until(
      () =>
        Boolean(
          (first = controller
            .getSnapshot()
            .approvals.find((a) => a.taskId === root.id && a.status === 'pending')),
        ),
      'file approval appears',
    );
    assert.equal(first!.toolName, 'write_file');
    assert.ok(String(first!.args.content).includes('Agent Loom demo'));
    await until(
      () =>
        controller
          .getSnapshot()
          .tasks.some((task) => task.parentTaskId === root.id && task.status === 'completed'),
      'teammate completes while root awaits approval',
    );
    assert.equal(controller.getSnapshot().queue.active, 0);
    await call(`/api/tasks/${root.id}/stop`);
    assert.equal(
      controller.getSnapshot().tasks.find((task) => task.id === root.id)!.status,
      'stopped',
    );
    assert.equal(
      controller.getSnapshot().approvals.find((a) => a.id === first!.id)!.status,
      'cancelled',
    );
    assert.equal(
      (await call(`/api/approvals/${first!.id}`, { decision: 'approve' })).statusCode,
      409,
    );
    await call(`/api/tasks/${root.id}/resume`);
    let second: Approval | undefined;
    await until(
      () =>
        Boolean(
          (second = controller
            .getSnapshot()
            .approvals.find((a) => a.taskId === root.id && a.status === 'pending')),
        ),
      'fresh approval after resume',
    );
    assert.notEqual(second!.id, first!.id);
    assert.equal(
      (await call(`/api/approvals/${second!.id}`, { decision: 'approve' })).statusCode,
      200,
    );
    await until(
      () =>
        controller.getSnapshot().tasks.find((task) => task.id === root.id)!.status === 'completed',
      'resumed workflow completes',
    );
    const state: Snapshot = controller.getSnapshot();
    assert.equal(
      state.tasks.filter((task) => task.parentTaskId === root.id).length,
      1,
      'completed handoff is not replayed',
    );
    assert.equal(state.notifications.length, 1);
    assert.equal(state.skills.length, 1);
    assert.equal(state.skills[0].status, 'candidate');
    assert.equal(await readFile(second!.target, 'utf8'), second!.args.content);
    assert.ok(
      state.messages.some(
        (message) => message.authorId === 'bot_nova' && message.status === 'complete',
      ),
    );
  },
);
