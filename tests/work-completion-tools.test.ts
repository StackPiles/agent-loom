import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import { createTools } from '../src/server/runtime/tools.js';
import type { Room, Task } from '../src/shared/types.js';
import {
  DEFAULT_AUTONOMOUS_WAKEUP_POLICY,
  type WorkCompletionInput,
  type WorkItem,
} from '../src/shared/work.js';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-completion-tools-'));
  const app = await createApp({
    dataDir,
    scheduler: false,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  await app.app.ready();
  t.after(async () => {
    await app.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  app.store.put('settings', {
    ...app.store.settings(),
    id: 'main',
    demoMode: true,
    maxHandoffs: null,
  });
  app.store.patch<Room>('rooms', 'room_lounge', {
    autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room', maxRunsPerHour: 100 },
  });
  const parent = app.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Finish the report and keep optional improvements for later.',
  });
  const { work, wakeup } = app.controller.manageWakeup(parent.id, {
    operation: 'upsert',
    key: 'follow-up',
    name: 'Report review',
    purpose: 'Deliver the verified report.',
    reason: 'Revisit the optional improvement later.',
    prompt: 'Inspect the saved report.',
    checkpoint: {
      summary: 'The report has been verified.',
      completed: 'Verified the report against the source.',
      nextStep: 'Decide whether the optional follow-up is needed.',
      references: ['report.md'],
      doneWhen: 'The verified report is delivered.',
      pendingChecks: ['Consider an optional CSV export.'],
      uncertainActions: [],
    },
    schedule: {
      type: 'once',
      dateTime: '2099-06-15T09:00',
      timeZone: 'UTC',
      missedRunPolicy: 'run_once',
    },
  });
  const child = app.controller.enqueueTask({
    roomId: parent.roomId,
    botId: 'bot_nova',
    parentTaskId: parent.id,
    prompt: 'Investigate the optional CSV export.',
  });
  const registry = createTools({
    host: app.controller,
    task: parent,
    settings: app.store.settings(),
    signal: new AbortController().signal,
    operationKeys: new Set(),
  });
  const current = () => app.store.get<WorkItem>('workItems', work.id)!;
  const complete = async (completion?: WorkCompletionInput) =>
    JSON.parse(
      await registry.invoke('manage_work', {
        operation: 'complete',
        workId: work.id,
        baseRevision: current().revision,
        ...(completion ? { completion } : {}),
      }),
    ) as WorkItem;
  return { ...app, parent, child, work, wakeup, registry, current, complete };
}

test('the model tool returns a completion review instead of stopping an unanswered teammate', async (t) => {
  const f = await fixture(t);
  const result = await f.complete();
  assert.equal(result.status, 'active');
  assert.equal(result.completionReview?.status, 'needs_review');
  assert.deepEqual(
    new Set(result.completionReview?.items.map((item) => item.kind)),
    new Set(['task', 'wakeup', 'check']),
  );
  const child = f.store.get<Task>('tasks', f.child.id)!;
  assert.equal(child.status, 'queued');
  assert.equal(child.error, undefined);
  assert.equal(child.stopContext, undefined);
  assert.equal(f.store.list('approvals').length, 0);
  const definition = f.registry.definitions.find((tool) => tool.name === 'manage_work')!;
  assert.ok(JSON.stringify(definition.parameters).includes('completion'));
});

test('explicit model dispositions close optional work and preserve a linked follow-up without execution', async (t) => {
  const f = await fixture(t);
  const initial = await f.complete();
  const items = initial.completionReview!.items;
  const taskCount = f.store.list<Task>('tasks').length;
  const result = await f.complete({
    summary: 'The requested report is verified and delivered. CSV export is optional future scope.',
    decisions: items.map((item) => ({
      itemId: item.id,
      action: item.kind === 'wakeup' ? 'dismiss' : 'defer',
      reason:
        item.kind === 'wakeup'
          ? 'This reminder is obsolete after report delivery.'
          : 'Keep the optional CSV improvement for a later assignment.',
    })),
    followUp: { name: 'Optional CSV export', purpose: 'Assess CSV export if it becomes useful.' },
  });
  assert.equal(result.status, 'completed');
  const deferred = f.store.get<WorkItem>('workItems', result.completionReview!.followUpWorkId!)!;
  assert.equal(deferred.deferredFromWorkId, f.work.id);
  assert.equal(deferred.roomId, f.work.roomId);
  assert.equal(deferred.workspacePath, f.work.workspacePath);
  assert.equal(
    f.store.list<Task>('tasks').length,
    taskCount,
    'deferral does not run or replay tasks',
  );
  const stopped = f.store.get<Task>('tasks', f.child.id)!;
  assert.equal(stopped.workId, f.work.id, 'original task and operation identity stay intact');
  assert.equal(stopped.stopContext?.reason, 'work_deferred');
  assert.equal(stopped.stopContext?.actorType, 'bot');
  assert.equal(stopped.stopContext?.actorId, f.parent.botId);
  assert.doesNotMatch(stopped.error ?? '', /Stopped by the user/);
});

test('owner completion requires reviewing current remaining work and rejects stale decisions without stopping it', async (t) => {
  const f = await fixture(t);
  const url = `/api/work-items/${f.work.id}/complete`;
  const preview = await f.app.inject({ method: 'POST', url });
  assert.equal(preview.statusCode, 200);
  const work = preview.json<WorkItem>();
  assert.equal(work.status, 'active');
  const completion: WorkCompletionInput = {
    summary: 'The report is verified; all remaining tasks are optional and no longer requested.',
    decisions: work.completionReview!.items.map((item) => ({
      itemId: item.id,
      action: 'dismiss',
      reason: 'The owner has reviewed the report and ends this optional follow-up.',
    })),
  };
  const stale = await f.app.inject({
    method: 'POST',
    url,
    payload: { baseRevision: work.revision - 1, completion },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(f.store.get<Task>('tasks', f.child.id)?.status, 'queued');
  assert.equal(f.current().status, 'active');
  const finish = await f.app.inject({
    method: 'POST',
    url,
    payload: { baseRevision: work.revision, completion },
  });
  assert.equal(finish.statusCode, 200, finish.body);
  assert.equal(finish.json<WorkItem>().status, 'completed');
  const stopped = f.store.get<Task>('tasks', f.child.id)!;
  assert.equal(stopped.stopContext?.actorType, 'owner');
  assert.notEqual(stopped.stopContext?.reason, 'owner_stop');
  assert.doesNotMatch(stopped.error ?? '', /Stopped by the user/);
});

test('completion input validation rejects malformed decisions before recording or changing work', async (t) => {
  const f = await fixture(t);
  const work = await f.complete();
  const saved = JSON.stringify(f.current());
  const operationCount = f.store.list('operations').length;
  await assert.rejects(
    f.registry.invoke('manage_work', {
      operation: 'complete',
      workId: work.id,
      baseRevision: work.revision,
      completion: {
        summary: 'Done',
        decisions: [{ itemId: work.completionReview!.items[0].id, action: 'dismiss', reason: '' }],
      },
    }),
  );
  assert.equal(JSON.stringify(f.current()), saved);
  assert.equal(f.store.list('operations').length, operationCount);
  const response = await f.app.inject({
    method: 'POST',
    url: `/api/work-items/${work.id}/complete`,
    payload: {
      baseRevision: work.revision,
      completion: { summary: 'Done', decisions: [], force: true },
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.stringify(f.current()), saved);
});
