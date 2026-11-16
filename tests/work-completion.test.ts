import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/server/controller.js';
import { Store } from '../src/server/store.js';
import type { OperationRecord } from '../src/server/runtime/contract.js';
import type { Room, Task } from '../src/shared/types.js';
import {
  DEFAULT_AUTONOMOUS_WAKEUP_POLICY,
  type WorkItem,
  type Wakeup,
  type WorkCompletionInput,
} from '../src/shared/work.js';

const checkpoint = {
  summary: 'The requested review is almost ready.',
  completed: 'Inspected the existing report.',
  nextStep: 'Collect the requested answer and summarize.',
  references: ['report.txt'],
  doneWhen: 'The user receives a verified report.',
  pendingChecks: [] as string[],
  uncertainActions: [] as string[],
};

async function fixture(t: TestContext, options: { checks?: string[]; keepWake?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-completion-'));
  const store = new Store(directory);
  store.seed();
  store.put('settings', { ...store.settings(), id: 'main', demoMode: true, maxHandoffs: null });
  store.patch<Room>('rooms', 'room_lounge', {
    autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room', maxRunsPerHour: 200 },
  });
  let controller = new Controller(store);
  const parent = controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Finish the verified report.',
  });
  const reserved = controller.work.manageWakeup(parent.id, {
    operation: 'upsert',
    key: 'later',
    name: 'Verified report',
    purpose: 'Give the user a verified report.',
    reason: 'Review later if needed.',
    prompt: 'Check for remaining evidence.',
    checkpoint: { ...checkpoint, pendingChecks: options.checks ?? [] },
    schedule: {
      type: 'once',
      dateTime: '2099-06-15T09:00',
      timeZone: 'UTC',
      missedRunPolicy: 'run_once',
    },
  });
  if (!options.keepWake) controller.work.cancelWakeup(reserved.wakeup.id, 'bot');
  t.after(async () => {
    await controller.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const current = () => store.get<WorkItem>('workItems', reserved.work.id)!;
  const complete = (completion?: WorkCompletionInput, taskId = parent.id) =>
    controller.work.manageWork(taskId, {
      operation: 'complete',
      workId: reserved.work.id,
      baseRevision: current().revision,
      completion,
    });
  const settle = (taskId: string, status: Task['status'] = 'completed') =>
    controller.updateTask(taskId, {
      status,
      completedAt: new Date().toISOString(),
      output: 'Verified result: report is correct.',
    });
  return {
    store,
    parent,
    workId: reserved.work.id,
    wakeId: reserved.wakeup.id,
    current,
    complete,
    settle,
    get controller() {
      return controller;
    },
    child(prompt = 'Verify the report details.') {
      return controller.enqueueTask({
        roomId: parent.roomId,
        botId: 'bot_nova',
        parentTaskId: parent.id,
        prompt,
      });
    },
    async restart() {
      await controller.shutdown();
      controller = new Controller(store);
    },
  };
}

function decision(
  work: WorkItem,
  action: 'wait' | 'dismiss' | 'defer',
  reason = 'This choice preserves the requested report.',
) {
  return work.completionReview!.items.map((item) => ({ itemId: item.id, action, reason }));
}

test('completion returns remaining tasks, checks and reservations without stopping any peer', async (t) => {
  const f = await fixture(t, { checks: ['Need the teammate answer.'], keepWake: true });
  const child = f.child();
  const work = await f.complete();
  assert.equal(work.status, 'active');
  assert.equal(work.completionReview?.status, 'needs_review');
  assert.deepEqual(work.completionReview?.items.map((item) => item.kind).sort(), [
    'check',
    'task',
    'wakeup',
  ]);
  assert.equal(f.store.get<Task>('tasks', child.id)?.status, 'queued');
  assert.equal(f.store.get<Wakeup>('wakeups', f.wakeId)?.status, 'scheduled');
  assert.equal(f.store.get<Task>('tasks', f.parent.id)?.status, 'queued');
});

test('evidence-backed dismissal closes optional backlog and records who disposed it', async (t) => {
  const f = await fixture(t, { checks: ['Optional second opinion.'], keepWake: true });
  const child = f.child();
  const review = await f.complete();
  const finished = await f.complete({
    summary: 'The requested report is verified; the second opinion is redundant.',
    decisions: decision(review, 'dismiss', 'The report already has the requested verification.'),
  });
  assert.equal(finished.status, 'completed');
  assert.deepEqual(finished.checkpoint.pendingChecks, []);
  const stopped = f.store.get<Task>('tasks', child.id)!;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.stopContext?.reason, 'work_superseded');
  assert.equal(stopped.stopContext?.actorType, 'bot');
  assert.equal(stopped.stopContext?.causeTaskId, f.parent.id);
  assert.doesNotMatch(stopped.error ?? '', /Stopped by the user/);
  assert.equal(f.store.get<Wakeup>('wakeups', f.wakeId)?.cancelledBy, 'bot');
  assert.equal(f.store.get<Task>('tasks', f.parent.id)?.status, 'queued');
});

test('deferral saves a linked follow-up without moving receipts or automatically executing it', async (t) => {
  const f = await fixture(t, { checks: ['Consider a CSV export later.'] });
  const child = f.child('Explore a future CSV export.');
  const review = await f.complete();
  const count = f.store.list<Task>('tasks').length;
  const finished = await f.complete({
    summary: 'The report is complete; CSV export is a separate improvement.',
    decisions: decision(review, 'defer'),
    followUp: {
      name: 'CSV export improvement',
      purpose: 'Assess a future CSV export without replaying the report work.',
    },
  });
  const followUp = f.store.get<WorkItem>('workItems', finished.completionReview!.followUpWorkId!)!;
  assert.equal(finished.status, 'completed');
  assert.equal(followUp.deferredFromWorkId, finished.id);
  assert.equal(followUp.workspacePath, finished.workspacePath);
  assert.equal(followUp.createdByBotId, finished.createdByBotId);
  assert.equal(followUp.deferredItems?.length, 2);
  assert.equal(f.store.get<Task>('tasks', child.id)?.workId, finished.id);
  assert.equal(f.store.get<Task>('tasks', child.id)?.stopContext?.reason, 'work_deferred');
  assert.equal(f.store.list<Task>('tasks').length, count);
  assert.equal(
    f.store.list<Wakeup>('wakeups').filter((wake) => wake.workId === followUp.id).length,
    0,
  );
});

test('waiting releases the parent turn and queues exactly one review after the answer, never automatic completion', async (t) => {
  const f = await fixture(t);
  const child = f.child();
  const review = await f.complete();
  const waiting = await f.complete({
    summary: 'The teammate answer is still required.',
    decisions: decision(review, 'wait'),
  });
  assert.equal(waiting.status, 'active');
  assert.equal(waiting.completionReview?.status, 'waiting');
  f.settle(child.id);
  assert.equal(f.store.list<Task>('tasks').length, 2, 'parent still holds its turn');
  f.settle(f.parent.id);
  const queued = f.current().completionReview!;
  assert.equal(queued.status, 'review_queued');
  assert.equal(f.current().status, 'active');
  const continuation = f.store.get<Task>('tasks', queued.reviewTaskId!)!;
  assert.equal(continuation.botId, f.parent.botId);
  assert.equal(continuation.workRunId, f.parent.rootTaskId);
  assert.match(continuation.prompt, /Verified result/);
  f.controller.work.tick();
  f.settle(child.id);
  assert.equal(f.store.list<Task>('tasks').length, 3);
  const finished = await f.complete(undefined, continuation.id);
  assert.equal(
    finished.status,
    'completed',
    'the creator explicitly decides after reading the answer',
  );
});

test('a review deadline requests reassessment without calling missing work successful', async (t) => {
  const f = await fixture(t, { checks: ['Need a future external response.'] });
  const review = await f.complete();
  const deadline = Date.now() + 60_000;
  await f.complete({
    summary: 'Wait briefly, then reassess the missing response.',
    decisions: decision(review, 'wait'),
    waitUntil: new Date(deadline).toISOString(),
  });
  f.settle(f.parent.id);
  assert.equal(f.store.list<Task>('tasks').length, 1);
  t.mock.timers.enable({ apis: ['Date'], now: deadline });
  f.controller.work.tick();
  assert.equal(f.current().status, 'active');
  const next = f.store.get<Task>('tasks', f.current().completionReview!.reviewTaskId!)!;
  assert.match(next.prompt, /Missing results are not successful completion/);
  assert.deepEqual(f.current().checkpoint.pendingChecks, ['Need a future external response.']);
});

test('a paused room retains ready completion review across restart and dispatches once after resume', async (t) => {
  const f = await fixture(t);
  const child = f.child();
  const review = await f.complete();
  await f.complete({ summary: 'Need the teammate result.', decisions: decision(review, 'wait') });
  f.store.patch<Room>('rooms', f.parent.roomId, { paused: true });
  f.settle(f.parent.id);
  f.settle(child.id);
  assert.equal(f.current().completionReview?.status, 'waiting');
  await f.restart();
  f.controller.work.tick();
  assert.equal(f.store.list<Task>('tasks').length, 2);
  f.store.patch<Room>('rooms', f.parent.roomId, { paused: false });
  f.controller.work.tick();
  assert.equal(f.current().completionReview?.status, 'review_queued');
  f.controller.work.tick();
  assert.equal(f.store.list<Task>('tasks').length, 3);
});

test('explicit owner stop prevents completion continuation from reviving work', async (t) => {
  const f = await fixture(t);
  const child = f.child();
  const review = await f.complete();
  await f.complete({ summary: 'Need the teammate result.', decisions: decision(review, 'wait') });
  await f.controller.stop(f.parent.id);
  f.settle(child.id);
  f.controller.work.tick();
  assert.equal(f.current().status, 'blocked');
  assert.equal(f.store.list<Task>('tasks').length, 2);
});

test('new peer admission invalidates an incomplete decision set without aborting reviewed peers', async (t) => {
  const f = await fixture(t);
  const first = f.child();
  const review = await f.complete();
  const second = f.child('A newer required check.');
  const result = await f.complete({
    summary: 'One optional peer can be dismissed.',
    decisions: decision(review, 'dismiss'),
  });
  assert.equal(result.status, 'active');
  assert.equal(result.completionReview?.status, 'needs_review');
  assert.equal(result.completionReview?.items.filter((item) => item.kind === 'task').length, 2);
  for (const task of [first, second])
    assert.equal(f.store.get<Task>('tasks', task.id)?.status, 'queued');
});

test('stale and foreign decisions fail before changing or stopping work', async (t) => {
  const f = await fixture(t);
  const child = f.child();
  const review = await f.complete();
  await assert.rejects(
    f.controller.work.completeWork(f.workId, {
      baseRevision: review.revision - 1,
      completion: { summary: 'Dismiss redundant work.', decisions: decision(review, 'dismiss') },
    }),
    /changed/,
  );
  await assert.rejects(
    f.complete({
      summary: 'Dismiss redundant work.',
      decisions: [{ itemId: 'task:outside', action: 'dismiss', reason: 'Not in this work.' }],
    }),
    /does not belong/,
  );
  assert.equal(f.store.get<Task>('tasks', child.id)?.status, 'queued');
  assert.equal(f.current().revision, review.revision);
});

test('in-flight peer operation cannot be dismissed or deferred until its outcome is recorded', async (t) => {
  const f = await fixture(t);
  const child = f.child();
  const review = await f.complete();
  f.store.put<OperationRecord & { id: string }>('operations', {
    id: 'op_send',
    key: 'op_send',
    taskId: child.id,
    toolName: 'send_mail',
    args: {},
    status: 'started',
    updatedAt: new Date().toISOString(),
  });
  const result = await f.complete({
    summary: 'Attempt to finish.',
    decisions: decision(review, 'dismiss'),
  });
  assert.equal(result.status, 'active');
  assert.match(result.completionReview?.lastError ?? '', /recorded outcome/);
  assert.equal(f.store.get<Task>('tasks', child.id)?.status, 'queued');
});

test('the initiating manage_work receipt does not prevent normal completion', async (t) => {
  const f = await fixture(t);
  f.store.put<OperationRecord & { id: string }>('operations', {
    id: 'op_complete',
    key: 'op_complete',
    taskId: f.parent.id,
    toolName: 'manage_work',
    args: {},
    status: 'started',
    updatedAt: new Date().toISOString(),
  });
  assert.equal((await f.complete()).status, 'completed');
});

test('owner completion starts the same review and requires a revision to apply decisions', async (t) => {
  const f = await fixture(t);
  const child = f.child();
  const review = await f.controller.work.changeStatus(f.workId, 'completed');
  assert.equal(review.status, 'active');
  assert.equal(review.completionReview?.requestedByTaskId, undefined);
  await assert.rejects(
    f.controller.work.completeWork(f.workId, {
      completion: {
        summary: 'These tasks are no longer needed.',
        decisions: decision(review, 'dismiss'),
      },
    }),
    /baseRevision/,
  );
  const result = await f.controller.work.completeWork(f.workId, {
    baseRevision: review.revision,
    completion: {
      summary: 'The requested report is already verified.',
      decisions: decision(review, 'dismiss'),
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(f.store.get<Task>('tasks', child.id)?.stopContext?.actorType, 'owner');
});

test('no-progress review has a bounded automatic retry count', async (t) => {
  const f = await fixture(t, { checks: ['No response yet.'] });
  const review = await f.complete();
  await f.complete({ summary: 'Need a response.', decisions: decision(review, 'wait') });
  f.settle(f.parent.id);
  const work = f.current();
  f.store.patch<WorkItem>('workItems', work.id, {
    completionReview: {
      ...work.completionReview!,
      attempts: 3,
      waitUntil: new Date(Date.now() - 1).toISOString(),
    },
  });
  f.controller.work.tick();
  assert.equal(f.current().completionReview?.status, 'needs_review');
  assert.match(f.current().completionReview?.lastError ?? '', /no-progress limit/);
  assert.equal(f.store.list<Task>('tasks').length, 1);
  assert.equal(f.current().status, 'active');
});

test('complete cannot erase a saved check merely by supplying an empty checkpoint list', async (t) => {
  const f = await fixture(t, { checks: ['User-required verification.'] });
  const work = await f.controller.work.manageWork(f.parent.id, {
    operation: 'complete',
    workId: f.workId,
    baseRevision: f.current().revision,
    checkpoint,
  });
  assert.equal(work.status, 'active');
  assert.equal(work.completionReview?.items[0]?.label, 'User-required verification.');
});

test('duplicate saved checks keep distinct review identities', async (t) => {
  const f = await fixture(t, { checks: ['Verify the result.', 'Verify the result.'] });
  const review = await f.complete();
  assert.equal(review.completionReview?.items.length, 2);
  assert.notEqual(review.completionReview?.items[0].id, review.completionReview?.items[1].id);
  assert.equal(review.checkpoint.pendingChecks?.length, 2);
});

test('closing and deferring replaces one active work even at the room work limit', async (t) => {
  const f = await fixture(t, { checks: ['Optional later improvement.'] });
  const room = f.store.get<Room>('rooms', f.parent.roomId)!;
  f.store.patch<Room>('rooms', room.id, {
    autonomousWakeups: { ...room.autonomousWakeups!, maxPendingWakeups: 1 },
  });
  const review = await f.complete();
  const finished = await f.complete({
    summary: 'The current report is complete.',
    decisions: decision(review, 'defer'),
    followUp: { name: 'Later improvement', purpose: 'Consider the optional improvement.' },
  });
  assert.equal(finished.status, 'completed');
  assert.equal(
    f.store.list<WorkItem>('workItems').filter((work) => work.status === 'active').length,
    1,
  );
});

test('a large deferred backlog retains every item beyond the short checkpoint summary', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 26; i++) f.child(`Optional improvement ${i}.`);
  const review = await f.complete();
  const finished = await f.complete({
    summary: 'Only the original report was required.',
    decisions: decision(review, 'defer'),
    followUp: { name: 'Optional improvements', purpose: 'Review all saved optional improvements.' },
  });
  const saved = f.store.get<WorkItem>('workItems', finished.completionReview!.followUpWorkId!)!;
  assert.equal(saved.checkpoint.pendingChecks?.length, 24);
  assert.equal(saved.deferredItems?.length, 26);
  assert.equal(new Set(saved.deferredItems?.map((item) => item.taskId)).size, 26);
  for (let i = 0; i < 26; i++)
    assert.ok(
      saved.deferredItems!.some((item) => item.label.endsWith(`Optional improvement ${i}.`)),
    );
});

test('a disposed task cannot be resumed after the latest review is replaced', async (t) => {
  const f = await fixture(t, { checks: ['Still need an external answer.'] });
  const child = f.child('Redundant verification.');
  const review = await f.complete();
  await f.complete({
    summary: 'The peer is redundant; the external answer is still needed.',
    decisions: review.completionReview!.items.map((item) => ({
      itemId: item.id,
      action: item.kind === 'task' ? 'dismiss' : 'wait',
      reason: 'The required external answer remains separate.',
    })),
  });
  await f.controller.work.completeWork(f.workId);
  assert.throws(() => f.controller.resume(child.id), /dismissed or deferred/);
  assert.equal(f.current().status, 'active');
  assert.equal(f.store.get<Task>('tasks', child.id)?.status, 'stopped');
});

test('persisted disposal survives a crash before running-task abort finishes', async (t) => {
  const f = await fixture(t, { checks: ['Wait for the external answer.'] });
  const child = f.child('Redundant work.');
  f.controller.updateTask(child.id, { status: 'running' });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.controller.runtime = {
    start() {},
    async stop() {
      await blocked;
    },
    async shutdown() {},
    queueState: () => ({ active: 1, waiting: 0 }),
  };
  const review = await f.complete();
  const completing = f.complete({
    summary: 'Dispose the redundant peer while keeping the external wait.',
    decisions: review.completionReview!.items.map((item) => ({
      itemId: item.id,
      action: item.kind === 'task' ? 'dismiss' : 'wait',
      reason: 'The peer is not needed for the external result.',
    })),
  });
  assert.equal(f.store.get<Task>('tasks', child.id)?.stopContext?.reason, 'work_superseded');
  f.settle(f.parent.id);
  await f.restart();
  assert.equal(f.store.get<Task>('tasks', child.id)?.status, 'stopped');
  assert.equal(f.current().status, 'active');
  release();
  await completing;
});

test('waiting for a recurring reservation uses the next occurrence rather than its old result', async (t) => {
  const f = await fixture(t, { keepWake: true });
  const previous = f.child('Old occurrence result.');
  f.settle(previous.id);
  const wake = f.store.get<Wakeup>('wakeups', f.wakeId)!;
  f.store.patch<Wakeup>('wakeups', wake.id, {
    schedule: { type: 'daily', time: '09:00', timeZone: 'UTC', missedRunPolicy: 'run_once' },
    lastTaskId: previous.id,
  });
  const review = await f.complete();
  await f.complete({
    summary: 'Need one more recurring observation.',
    decisions: decision(review, 'wait'),
  });
  f.settle(f.parent.id);
  assert.equal(f.current().completionReview?.status, 'waiting');
  const next = f.controller.enqueueTask({
    roomId: f.parent.roomId,
    botId: 'bot_nova',
    prompt: 'New occurrence result.',
    kind: 'automation',
    workId: f.workId,
    workRunId: 'workrun_next',
    wakeupId: f.wakeId,
  });
  f.store.patch<Wakeup>('wakeups', f.wakeId, { lastTaskId: next.id, revision: wake.revision + 1 });
  f.settle(next.id);
  assert.equal(f.current().completionReview?.status, 'review_queued');
  assert.equal(f.store.get<Wakeup>('wakeups', f.wakeId)?.status, 'scheduled');
});

test('editing a reviewed reservation requires fresh decisions before cancelling it', async (t) => {
  const f = await fixture(t, { keepWake: true });
  const review = await f.complete();
  const wake = f.store.get<Wakeup>('wakeups', f.wakeId)!;
  f.controller.work.manageWakeup(f.parent.id, {
    operation: 'upsert',
    wakeupId: wake.id,
    baseRevision: wake.revision,
    reason: 'A newly required verification.',
    prompt: 'Do not cancel this newly required verification.',
  });
  assert.equal(f.current().revision, review.revision, 'reservation edits use their own revision');
  const result = await f.complete({
    summary: 'The former optional reminder is unnecessary.',
    decisions: decision(review, 'dismiss'),
  });
  assert.equal(result.status, 'active');
  assert.match(result.completionReview?.lastError ?? '', /changed after the review/);
  assert.equal(f.store.get<Wakeup>('wakeups', f.wakeId)?.status, 'scheduled');
});

test('three unchanged deadline reviews do not create an endless automatic loop', async (t) => {
  const f = await fixture(t, { checks: ['No response yet.'] });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let actor = f.parent.id;
  for (let attempt = 0; attempt < 4; attempt++) {
    const review = await f.complete(undefined, actor);
    const deadline = Date.now() + 1000;
    await f.complete(
      {
        summary: 'The response is still needed.',
        decisions: decision(review, 'wait'),
        waitUntil: new Date(deadline).toISOString(),
      },
      actor,
    );
    f.settle(actor);
    t.mock.timers.setTime(deadline);
    f.controller.work.tick();
    if (attempt < 3) {
      assert.equal(f.current().completionReview?.status, 'review_queued');
      actor = f.current().completionReview!.reviewTaskId!;
    }
  }
  assert.equal(f.current().completionReview?.status, 'needs_review');
  assert.equal(f.store.list<Task>('tasks').length, 4);
  assert.equal(f.current().status, 'active');
});

test('runtime status changes do not reset the no-progress completion review cap', async (t) => {
  const f = await fixture(t);
  const child = f.child('The required result has not arrived.');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let actor = f.parent.id;
  const states = ['queued', 'running', 'waiting_model', 'waiting_tool'] as const;
  for (const status of states) {
    f.controller.updateTask(child.id, { status });
    const review = await f.complete(undefined, actor);
    const deadline = Date.now() + 1000;
    await f.complete(
      {
        summary: 'The result is still missing despite runtime activity.',
        decisions: decision(review, 'wait'),
        waitUntil: new Date(deadline).toISOString(),
      },
      actor,
    );
    f.settle(actor);
    t.mock.timers.setTime(deadline);
    f.controller.work.tick();
    if (status !== states.at(-1)) {
      assert.equal(f.current().completionReview?.status, 'review_queued');
      actor = f.current().completionReview!.reviewTaskId!;
    }
  }
  assert.equal(f.current().completionReview?.status, 'needs_review');
  assert.equal(f.current().completionReview?.attempts, 3);
  assert.equal(f.store.list<Task>('tasks').length, 5);
  assert.equal(f.current().status, 'active');
});

test('the owner can review and complete work with autonomy off while bot completion remains denied', async (t) => {
  const f = await fixture(t, { checks: ['Optional later check.'] });
  const room = f.store.get<Room>('rooms', f.parent.roomId)!;
  f.store.patch<Room>('rooms', room.id, {
    autonomousWakeups: { ...room.autonomousWakeups!, mode: 'off' },
  });
  await assert.rejects(f.complete(), /Autonomous wake-ups are disabled/);
  const review = await f.controller.work.changeStatus(f.workId, 'completed');
  assert.equal(review.status, 'active');
  const closed = await f.controller.work.completeWork(f.workId, {
    baseRevision: review.revision,
    completion: {
      summary: 'The owner has verified the result and no further autonomous work is needed.',
      decisions: decision(
        review,
        'dismiss',
        'The owner has accepted the result and removed this optional work.',
      ),
    },
  });
  assert.equal(closed.status, 'completed');
  assert.equal(f.store.get<Task>('tasks', f.parent.id)?.stopContext?.actorType, 'owner');
  assert.equal(f.store.get<Room>('rooms', room.id)?.autonomousWakeups?.mode, 'off');
});
