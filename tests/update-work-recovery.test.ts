import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/server/controller.js';
import { Store } from '../src/server/store.js';
import { recoverLegacyUpdateWork } from '../src/server/update-work-recovery.js';
import type { OperationRecord } from '../src/server/runtime/contract.js';
import type {
  Activity,
  Approval,
  Bot,
  Message,
  Room,
  Task,
  WorkItem,
} from '../src/shared/types.js';
import { DEFAULT_AUTONOMOUS_WAKEUP_POLICY, type Wakeup } from '../src/shared/work.js';

const old = '2030-01-15T08:00:00.000Z';
const started = '2030-01-15T10:00:00.001Z';
const blocked = '2030-01-15T10:05:00.000Z';
const queued = '2030-01-15T10:05:00.001Z';
const current = '2030-01-15T10:06:00.000Z';

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(current) });
  const directory = await mkdtemp(join(tmpdir(), 'loom-update-work-recovery-'));
  const store = new Store(directory);
  store.seed();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const room = store.patch<Room>('rooms', 'room_lounge', {
    paused: true,
    autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room' },
  });
  const bot = store.get<Bot>('bots', 'bot_aster')!;
  const work = store.put<WorkItem>('workItems', {
    id: 'work_update',
    roomId: room.id,
    name: 'Continue the approved assignment',
    purpose: 'Follow up on the assigned report.',
    kind: 'task',
    status: 'blocked',
    createdByBotId: bot.id,
    sourceTaskId: 'task_source',
    scope: `${room.description}\n${bot.role}`.trim(),
    workspacePath: store.settings().workspacePath,
    checkpoint: {
      summary: 'The first report was inspected.',
      completed: 'Initial inspection.',
      nextStep: 'Finish the follow-up.',
      references: ['report.txt'],
      doneWhen: 'The follow-up is reported.',
      pendingChecks: ['Check the next report when it arrives.'],
      uncertainActions: [],
    },
    revision: 4,
    createdAt: old,
    updatedAt: blocked,
    reviewedAt: '2030-01-15T09:00:00.000Z',
    lastError:
      'Task task_update stopped. Review its results and resume explicitly before continuing.',
  });
  const source = store.put<Task>('tasks', {
    id: work.sourceTaskId,
    roomId: room.id,
    botId: bot.id,
    prompt: 'Inspect the first report and reserve a follow-up.',
    workspacePath: work.workspacePath,
    status: 'completed',
    rootTaskId: work.sourceTaskId,
    depth: 0,
    kind: 'chat',
    workId: work.id,
    workRunId: work.sourceTaskId,
    output: 'Initial report inspected.',
    createdAt: old,
    startedAt: old,
    completedAt: old,
    updatedAt: old,
    inputTokens: 17,
    outputTokens: 23,
  });
  const task = store.put<Task>('tasks', {
    ...source,
    id: 'task_update',
    rootTaskId: 'task_update',
    status: 'queued',
    kind: 'automation',
    prompt: 'Continue the report follow-up.',
    wakeupId: 'wake_update',
    output: 'The partial follow-up is retained.',
    startedAt: started,
    completedAt: undefined,
    createdAt: '2030-01-15T10:00:00.000Z',
    updatedAt: queued,
  });
  const wake = store.put<Wakeup>('wakeups', {
    id: task.wakeupId!,
    workId: work.id,
    roomId: room.id,
    botId: bot.id,
    createdByBotId: bot.id,
    sourceTaskId: source.id,
    key: 'report-follow-up',
    reason: 'The next report is available later.',
    prompt: task.prompt,
    schedule: {
      type: 'once',
      dateTime: '2030-01-15T10:00',
      timeZone: 'UTC',
      missedRunPolicy: 'run_once',
    },
    status: 'dispatched',
    workRunId: source.workRunId!,
    lastTaskId: task.id,
    lastRunAt: started,
    revision: 2,
    createdAt: old,
    updatedAt: started,
  });
  store.put<Wakeup>('wakeups', {
    ...wake,
    id: 'wake_future',
    status: 'scheduled',
    key: 'future-follow-up',
    nextRunAt: '2030-01-16T10:00:00.000Z',
    lastTaskId: undefined,
    lastRunAt: undefined,
  });
  const message = store.put<Message>('messages', {
    id: 'message_update',
    roomId: room.id,
    authorType: 'bot',
    authorId: bot.id,
    body: task.output,
    taskId: task.id,
    status: 'complete',
    createdAt: '2030-01-15T10:00:00.002Z',
  });
  const activity = store.put<Activity>('activities', {
    id: 'activity_update',
    taskId: task.id,
    roomId: room.id,
    botId: bot.id,
    messageId: message.id,
    kind: 'status',
    title: 'Paused for application update',
    detail: 'Paused for an application update. Resume the room to continue from saved context.',
    status: 'success',
    createdAt: '2030-01-15T10:00:00.000Z',
  });
  const operation: OperationRecord = {
    key: 'operation_update',
    taskId: task.id,
    toolName: 'browser_use',
    args: { operation: 'click', pageId: 'page_1', uid: 'submit' },
    status: 'completed',
    result: 'The submission was confirmed.',
    updatedAt: '2030-01-15T10:04:00.000Z',
  };
  store.put('operations', { ...operation, id: operation.key });
  const approval = store.put<Approval>('approvals', {
    id: 'approval_update',
    taskId: task.id,
    roomId: room.id,
    botId: bot.id,
    toolName: 'write_file',
    summary: 'Write the follow-up.',
    target: 'follow-up.txt',
    args: { path: 'follow-up.txt', content: 'The pending next step.' },
    status: 'cancelled',
    createdAt: '2030-01-15T10:04:00.000Z',
    decidedAt: '2030-01-15T10:04:59.999Z',
  });
  const relatedState = () =>
    Object.fromEntries(
      [
        'tasks',
        'rooms',
        'messages',
        'activities',
        'operations',
        'approvals',
        'wakeups',
        'mailDrafts',
      ].map((kind) => [kind, store.list(kind)]),
    );
  return {
    store,
    work,
    room,
    bot,
    source,
    task,
    wake,
    activity,
    message,
    operation,
    approval,
    relatedState,
  };
}

test('repairs only the proven old update block without executing work or altering saved history', async (t) => {
  const f = await fixture(t);
  const before = f.relatedState();
  const expected = {
    ...f.work,
    status: 'active' as const,
    revision: f.work.revision + 1,
    updatedAt: current,
  };
  delete expected.lastError;
  assert.deepEqual(recoverLegacyUpdateWork(f.store), [f.work.id]);
  assert.deepEqual(f.store.get('workItems', f.work.id), expected);
  assert.deepEqual(f.relatedState(), before);
  assert.equal(f.store.get<Room>('rooms', f.room.id)?.paused, true);
  assert.equal(f.store.get<Task>('tasks', f.task.id)?.status, 'queued');
  assert.deepEqual(recoverLegacyUpdateWork(f.store), []);
  assert.deepEqual(f.store.get('workItems', f.work.id), expected);
  assert.deepEqual(f.relatedState(), before);
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
type RefusalCase = [string, (f: Fixture) => void];
const identityCases: RefusalCase[] = [
  ...(['active', 'paused', 'completed', 'cancelled'] as const).map((status): RefusalCase => [
    status + ' work',
    (f) => {
      f.store.patch('workItems', f.work.id, { status });
    },
  ]),
  [
    'different block reason',
    (f) => {
      f.store.patch('workItems', f.work.id, {
        lastError: 'An operation has an uncertain outcome.',
      });
    },
  ],
  [
    'a completed-by marker',
    (f) => {
      f.store.patch('workItems', f.work.id, { finishedByTaskId: f.task.id });
    },
  ],
  [
    'room resumed before repair',
    (f) => {
      f.store.patch('rooms', f.room.id, { paused: false });
    },
  ],
  [
    'archived room',
    (f) => {
      f.store.patch('rooms', f.room.id, { archived: true });
    },
  ],
  [
    'disabled autonomous policy',
    (f) => {
      f.store.patch('rooms', f.room.id, { autonomousWakeups: DEFAULT_AUTONOMOUS_WAKEUP_POLICY });
    },
  ],
  [
    'changed room workspace',
    (f) => {
      f.store.patch('rooms', f.room.id, { workspacePath: join(f.work.workspacePath, 'different') });
    },
  ],
  [
    'changed room scope',
    (f) => {
      f.store.patch('rooms', f.room.id, { description: 'A different assignment.' });
    },
  ],
  [
    'disabled creator',
    (f) => {
      f.store.patch('bots', f.bot.id, { enabled: false });
    },
  ],
  [
    'creator removed from room',
    (f) => {
      f.store.patch('rooms', f.room.id, { botIds: [] });
    },
  ],
  [
    'missing source task',
    (f) => {
      f.store.remove('tasks', f.source.id);
    },
  ],
  [
    'source no longer belongs to this work',
    (f) => {
      f.store.patch('tasks', f.source.id, { workId: 'other_work' });
    },
  ],
  [
    'task in a different room',
    (f) => {
      f.store.patch('tasks', f.task.id, { roomId: 'other_room' });
    },
  ],
  [
    'task in a different workspace',
    (f) => {
      f.store.patch('tasks', f.task.id, { workspacePath: join(f.work.workspacePath, 'different') });
    },
  ],
  [
    'task without its occurrence',
    (f) => {
      f.store.patch('tasks', f.task.id, { workRunId: undefined });
    },
  ],
  [
    'reservation mismatch',
    (f) => {
      f.store.patch('wakeups', f.wake.id, { workId: 'other_work' });
    },
  ],
  [
    'owner cancelled this reservation',
    (f) => {
      f.store.patch('wakeups', f.wake.id, { status: 'cancelled', cancelledBy: 'owner' });
    },
  ],
  [
    'future reservation target removed',
    (f) => {
      f.store.patch('wakeups', 'wake_future', { botId: 'missing_bot' });
    },
  ],
  [
    'future reservation crosses the current self policy',
    (f) => {
      f.store.patch('rooms', f.room.id, {
        autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'self' },
      });
      f.store.patch('wakeups', 'wake_future', { botId: 'bot_nova' });
    },
  ],
];

const checkpointCases: RefusalCase[] = [
  ...(['stopped', 'interrupted', 'failed', 'running', 'completed'] as const).map(
    (status): RefusalCase => [
      status + ' task',
      (f) => {
        f.store.patch('tasks', f.task.id, { status });
      },
    ],
  ),
  [
    'failed resume after the old update',
    (f) => {
      f.store.patch('tasks', f.task.id, {
        status: 'failed',
        error: 'This work is blocked. The owner must review it before it can continue.',
      });
    },
  ],
  [
    'task retains an error',
    (f) => {
      f.store.patch('tasks', f.task.id, { error: 'Stopped by the user.' });
    },
  ],
  [
    'task has a completion timestamp',
    (f) => {
      f.store.patch('tasks', f.task.id, { completedAt: blocked });
    },
  ],
  [
    'task was never started',
    (f) => {
      f.store.patch('tasks', f.task.id, { startedAt: undefined });
    },
  ],
  [
    'task was archived',
    (f) => {
      f.store.patch('tasks', f.task.id, { archivedAt: blocked });
    },
  ],
  [
    'queue record predates the work block',
    (f) => {
      f.store.patch('tasks', f.task.id, { updatedAt: old });
    },
  ],
  [
    'invalid block timestamp',
    (f) => {
      f.store.patch('workItems', f.work.id, { updatedAt: 'invalid' });
    },
  ],
  [
    'missing checkpoint activity',
    (f) => {
      f.store.remove('activities', f.activity.id);
    },
  ],
  [
    'unsuccessful checkpoint activity',
    (f) => {
      f.store.patch('activities', f.activity.id, { status: 'error' });
    },
  ],
  [
    'checkpoint title from ordinary shutdown',
    (f) => {
      f.store.patch('activities', f.activity.id, { title: 'Task interrupted' });
    },
  ],
  [
    'checkpoint detail differs',
    (f) => {
      f.store.patch('activities', f.activity.id, {
        detail: 'The application stopped unexpectedly.',
      });
    },
  ],
  [
    'checkpoint belongs to a different bot',
    (f) => {
      f.store.patch('activities', f.activity.id, { botId: 'bot_nova' });
    },
  ],
  [
    'missing checkpoint message',
    (f) => {
      f.store.remove('messages', f.message.id);
    },
  ],
  [
    'unfinished checkpoint message',
    (f) => {
      f.store.patch('messages', f.message.id, { status: 'streaming' });
    },
  ],
  [
    'old checkpoint message from a prior execution',
    (f) => {
      f.store.patch('messages', f.message.id, { createdAt: old });
    },
  ],
];

const safetyCases: RefusalCase[] = [
  [
    'checkpoint uncertainty',
    (f) => {
      f.store.patch('workItems', f.work.id, {
        checkpoint: {
          ...f.work.checkpoint,
          uncertainActions: ['The submission outcome is unknown.'],
        },
      });
    },
  ],
  ...(['started', 'failed'] as const).map((status): RefusalCase => [
    status + ' operation',
    (f) => {
      f.store.patch('operations', f.operation.key, { status });
    },
  ]),
  [
    'unreviewed mail uncertainty',
    (f) => {
      f.store.patch('operations', f.operation.key, {
        uncertainty: { kind: 'mail', draftId: 'draft_unknown' },
      });
    },
  ],
  [
    'reviewed mail uncertainty is not implicitly reused',
    (f) => {
      f.store.patch('operations', f.operation.key, {
        uncertainty: { kind: 'mail', draftId: 'draft_reviewed', reviewedAt: f.work.reviewedAt },
      });
    },
  ],
  [
    'pending approval',
    (f) => {
      f.store.patch('approvals', f.approval.id, { status: 'pending' });
    },
  ],
  [
    'approval cancelled by a later server startup',
    (f) => {
      f.store.patch('approvals', f.approval.id, { decidedAt: current });
    },
  ],
  [
    'unreviewed sibling failure',
    (f) => {
      f.store.put('tasks', {
        ...f.source,
        id: 'task_failed_sibling',
        status: 'failed',
        updatedAt: blocked,
      });
    },
  ],
  [
    'live sibling execution',
    (f) => {
      f.store.put('tasks', {
        ...f.source,
        id: 'task_running_sibling',
        status: 'running',
        completedAt: undefined,
      });
    },
  ],
  [
    'started sibling lacks its own checkpoint proof',
    (f) => {
      f.store.put('tasks', { ...f.task, id: 'task_checkpoint_sibling' });
    },
  ],
  [
    'failed sibling operation even after a past review',
    (f) => {
      f.store.put('operations', {
        ...f.operation,
        id: 'operation_failed_source',
        key: 'operation_failed_source',
        taskId: f.source.id,
        status: 'failed',
        updatedAt: old,
      });
    },
  ],
  ...(['unknown', 'sending'] as const).map((status): RefusalCase => [
    status + ' mail draft',
    (f) => {
      f.store.patch('operations', f.operation.key, {
        toolName: 'send_mail',
        args: { draftId: 'draft_update' },
      });
      f.store.put('mailDrafts', { id: 'draft_update', status });
    },
  ]),
];

for (const [category, cases] of [
  ['owner intent and work scope', identityCases],
  ['completed update provenance', checkpointCases],
  ['unresolved effects and sibling failures', safetyCases],
] as const) {
  test(`legacy recovery preserves ${category}`, async (t) => {
    for (const [name, mutate] of cases)
      await t.test(name, async (t) => {
        const f = await fixture(t);
        mutate(f);
        const workBefore = f.store.get('workItems', f.work.id);
        const before = f.relatedState();
        assert.deepEqual(recoverLegacyUpdateWork(f.store), []);
        assert.deepEqual(f.store.get('workItems', f.work.id), workBefore);
        assert.deepEqual(f.relatedState(), before);
      });
  });
}

test('an already reviewed historical failure does not require a new owner review', async (t) => {
  const f = await fixture(t);
  f.store.put('tasks', {
    ...f.source,
    id: 'task_reviewed_failure',
    status: 'failed',
    error: 'The prior attempt failed before the existing owner review.',
  });
  const before = f.relatedState();
  assert.deepEqual(recoverLegacyUpdateWork(f.store), [f.work.id]);
  assert.equal(f.store.get<WorkItem>('workItems', f.work.id)?.reviewedAt, f.work.reviewedAt);
  assert.deepEqual(f.relatedState(), before);
});

test('unstarted held siblings and unrelated work do not get changed by the repair', async (t) => {
  const f = await fixture(t);
  f.store.put('tasks', {
    ...f.task,
    id: 'task_unstarted_sibling',
    startedAt: undefined,
    wakeupId: undefined,
  });
  const unrelated = {
    ...f.work,
    id: 'work_other',
    lastError: 'A genuine interruption needs review.',
  };
  f.store.put('workItems', unrelated);
  const before = f.relatedState();
  assert.deepEqual(recoverLegacyUpdateWork(f.store), [f.work.id]);
  assert.deepEqual(f.store.get('workItems', unrelated.id), unrelated);
  assert.deepEqual(f.relatedState(), before);
});

test('controller startup restores a proven legacy work while leaving its room and queue held', async (t) => {
  const f = await fixture(t);
  const before = f.relatedState();
  const controller = new Controller(f.store);
  try {
    const work = f.store.get<WorkItem>('workItems', f.work.id)!;
    assert.equal(work.status, 'active');
    assert.equal(work.reviewedAt, f.work.reviewedAt);
    assert.equal(work.revision, f.work.revision + 1);
    assert.deepEqual(f.relatedState(), before);
  } finally {
    await controller.shutdown();
  }
});

test('a pending approval prevents recovery on both initial and subsequent startup', async (t) => {
  const f = await fixture(t);
  f.store.patch('approvals', f.approval.id, { status: 'pending', decidedAt: undefined });
  // Even a coarse clock must not turn normal startup cancellation into proof of
  // an older successful update checkpoint when the next process starts.
  t.mock.timers.setTime(Date.parse(blocked));
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new Controller(f.store);
    try {
      assert.deepEqual(f.store.get('workItems', f.work.id), f.work);
      assert.equal(f.store.get<Approval>('approvals', f.approval.id)?.status, 'cancelled');
      assert.equal(f.store.get<Task>('tasks', f.task.id)?.status, 'queued');
      assert.equal(f.store.get<Room>('rooms', f.room.id)?.paused, true);
    } finally {
      await controller.shutdown();
    }
  }
});
