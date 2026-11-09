import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { createTools, contextOperationKey, operationKey } from '../src/server/runtime/tools.js';
import type { OperationRecord, ToolContext } from '../src/server/runtime/contract.js';
import type { Approval, Room, Task } from '../src/shared/types.js';
import { DEFAULT_IMAGE_SETTINGS } from '../src/shared/model-settings.js';
import type { MailAccount, MailDraft } from '../src/shared/mail-accounts.js';
import {
  DEFAULT_AUTONOMOUS_WAKEUP_POLICY,
  type WorkItem,
  type Wakeup,
} from '../src/shared/work.js';

const createWake = {
  operation: 'upsert',
  key: 'review-result',
  name: 'Review the project result',
  purpose: 'Finish the requested review when its input is available.',
  reason: 'The next input is expected later.',
  prompt: 'Read the referenced project result and finish the review.',
  schedule: {
    type: 'once',
    dateTime: '2099-06-15T09:00',
    timeZone: 'Asia/Tokyo',
    missedRunPolicy: 'run_once',
  },
  checkpoint: {
    summary: 'Waiting for the next input.',
    completed: 'Inspected the current result.',
    nextStep: 'Inspect the new result and complete the review.',
    references: ['result.txt'],
    doneWhen: 'The final result has been reviewed and reported.',
    uncertainActions: [],
  },
};

async function fixture(t: TestContext, mode: 'off' | 'self' | 'room' = 'room') {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-wake-tools-'));
  const calls: { sends: number; outcome: 'sent' | 'unknown' | 'preflight' } = {
    sends: 0,
    outcome: 'sent',
  };
  const f = await createApp({
    dataDir,
    scheduler: false,
    mailAccountAdapters: {
      providers: {
        agentmail: {
          async test() {
            return { send: true };
          },
          async list() {
            return { messages: [] };
          },
          async read() {
            throw new Error('This fixture never reads external mail.');
          },
          async poll() {
            return { messages: [], cursor: 'fixture', baseline: false };
          },
          async send(context) {
            if (calls.outcome === 'preflight')
              throw new Error('Synthetic failure before submission.');
            context.beforeSend();
            calls.sends++;
            if (calls.outcome === 'unknown')
              throw new Error('Synthetic transport loss after submission.');
            return { messageId: `fixture-accepted-${calls.sends}` };
          },
        },
      },
    },
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  await f.app.ready();
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    demoMode: true,
    maxHandoffs: null,
    permissions: { shell: 'allow', network: 'allow', fileWrite: 'allow' },
  });
  const policy = (nextMode: 'off' | 'self' | 'room') =>
    f.store.patch<Room>('rooms', 'room_lounge', {
      autonomousWakeups: {
        ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY,
        mode: nextMode,
        maxRunsPerHour: 100,
      },
    });
  policy(mode);
  t.after(async () => {
    await f.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  function tools(patch: Partial<Task> = {}, waitForRoom?: ToolContext['waitForRoom']) {
    const task = f.controller.enqueueTask({
      roomId: patch.roomId ?? 'room_lounge',
      botId: patch.botId ?? 'bot_aster',
      prompt: 'Continue the authorized project review.',
      kind: patch.kind,
      parentTaskId: patch.parentTaskId,
      workId: patch.workId,
      workRunId: patch.workRunId,
      wakeupId: patch.wakeupId,
    });
    Object.assign(task, patch);
    f.store.put('tasks', task);
    const context: ToolContext = {
      host: f.controller,
      task,
      settings: f.store.settings(),
      signal: new AbortController().signal,
      operationKeys: new Set(),
      waitForRoom,
    };
    return { task, context, registry: createTools(context) };
  }
  async function schedule(runtime = tools(), patch: Record<string, unknown> = {}) {
    const result = JSON.parse(
      await runtime.registry.invoke('manage_wakeup', { ...createWake, ...patch }),
    ) as {
      work: WorkItem;
      wakeup: Wakeup;
    };
    return { ...result, runtime };
  }
  return { ...f, calls, tools, schedule, policy };
}

test('chat, scheduled and handoff tasks have narrow wake tools while learning and automation authority stay restricted', async (t) => {
  const f = await fixture(t);
  const root = f.tools();
  const background = f.tools({ kind: 'automation' });
  const handoff = f.tools({ parentTaskId: root.task.id, botId: 'bot_nova' });
  for (const runtime of [root, background, handoff]) {
    for (const name of ['list_wakeups', 'manage_wakeup', 'manage_work'])
      assert.ok(runtime.registry.definitions.some((tool) => tool.name === name));
  }
  for (const runtime of [background, handoff]) {
    assert.equal(
      runtime.registry.definitions.some((tool) => tool.name === 'manage_automation'),
      false,
    );
    await f.schedule(runtime);
  }
  const learning = f.tools({ kind: 'learning' });
  assert.equal(
    learning.registry.definitions.some((tool) =>
      /^(list_wakeups|manage_wakeup|manage_work)$/.test(tool.name),
    ),
    false,
  );
  await assert.rejects(learning.registry.invoke('manage_wakeup', createWake), /not available/);
  assert.equal(f.store.list('approvals').length, 0);
});

test('current room opt-in and self-only policy are enforced even by a previously created registry', async (t) => {
  const f = await fixture(t, 'off');
  const runtime = f.tools();
  const list = JSON.parse(await runtime.registry.invoke('list_wakeups', {}));
  assert.equal(list.policy.mode, 'off');
  await assert.rejects(runtime.registry.invoke('manage_wakeup', createWake), /disabled/);
  assert.equal(f.store.list('workItems').length, 0);
  f.policy('self');
  const self = f.tools();
  await assert.rejects(
    self.registry.invoke('manage_wakeup', { ...createWake, botHandle: '@nova' }),
    /only.*creator|own wake-ups/,
  );
  const scheduled = await f.schedule(self);
  assert.equal(scheduled.wakeup.botId, 'bot_aster');
  f.policy('off');
  await assert.rejects(self.registry.invoke('manage_wakeup', createWake), /disabled/);
  assert.equal(f.store.list('wakeups').length, 1);
});

test('strict inputs cannot inject authority and room listings and mutations cannot cross rooms', async (t) => {
  const f = await fixture(t);
  const runtime = f.tools();
  const activities = f.store.list('activities').length;
  await assert.rejects(
    runtime.registry.invoke('manage_wakeup', {
      ...createWake,
      roomId: 'other-room',
      createdByBotId: 'bot_nova',
      permission: 'allow',
    }),
    /Unrecognized/,
  );
  assert.equal(f.store.list('activities').length, activities);
  const room = f.store.get<Room>('rooms', 'room_lounge')!;
  f.store.put('rooms', { ...room, id: 'other-room', name: 'Other room' });
  const other = await f.schedule(f.tools({ roomId: 'other-room' }));
  const listing = JSON.parse(await runtime.registry.invoke('list_wakeups', {}));
  assert.deepEqual(listing.workItems, []);
  await assert.rejects(
    runtime.registry.invoke('list_wakeups', { workId: other.work.id }),
    /this room/,
  );
  await assert.rejects(
    runtime.registry.invoke('manage_wakeup', {
      operation: 'cancel',
      wakeupId: other.wakeup.id,
    }),
    /current room|current work/,
  );
  f.store.patch<Room>('rooms', 'room_lounge', { botIds: ['bot_aster'] });
  await assert.rejects(
    runtime.registry.invoke('manage_wakeup', { ...createWake, botHandle: 'nova' }),
    /in this room/,
  );
});

test('a stable reservation key updates one wake-up and ownership prevents cancelling teammate work', async (t) => {
  const f = await fixture(t);
  const made = await f.schedule();
  assert.match(
    await made.runtime.registry.invoke('manage_wakeup', createWake),
    /already completed/,
  );
  const changed = JSON.parse(
    await made.runtime.registry.invoke('manage_wakeup', {
      operation: 'upsert',
      key: createWake.key,
      reason: 'The result was delayed.',
      schedule: { ...createWake.schedule, dateTime: '2099-06-16T09:00' },
      baseRevision: made.wakeup.revision,
    }),
  );
  assert.equal(changed.wakeup.id, made.wakeup.id);
  assert.equal(f.store.list('wakeups').length, 1);
  const teammate = f.tools({ botId: 'bot_nova', parentTaskId: made.runtime.task.id });
  await assert.rejects(
    teammate.registry.invoke('manage_wakeup', {
      operation: 'cancel',
      wakeupId: made.wakeup.id,
    }),
    /only reservations you created/,
  );
  await assert.rejects(
    teammate.registry.invoke('manage_work', {
      operation: 'complete',
      workId: made.work.id,
    }),
    /Only the creator/,
  );
  const own = JSON.parse(
    await teammate.registry.invoke('manage_wakeup', {
      operation: 'upsert',
      key: 'teammate-followup',
      reason: createWake.reason,
      prompt: createWake.prompt,
      schedule: createWake.schedule,
    }),
  );
  assert.equal(own.work.id, made.work.id);
  assert.equal(own.wakeup.createdByBotId, 'bot_nova');
  assert.equal(own.wakeup.botId, 'bot_nova');
  await assert.rejects(
    made.runtime.registry.invoke('manage_wakeup', { ...createWake, key: 'reset-purpose' }),
    /original name|original.*purpose|manage_work|new work only/,
  );
  const cancelled = JSON.parse(
    await teammate.registry.invoke('manage_wakeup', {
      operation: 'cancel',
      wakeupId: own.wakeup.id,
      baseRevision: own.wakeup.revision,
    }),
  );
  assert.equal(cancelled.wakeup.status, 'cancelled');
});

test('finishing work cancels all reservations and permits only the closing final answer', async (t) => {
  const f = await fixture(t);
  const made = await f.schedule();
  const finished = JSON.parse(
    await made.runtime.registry.invoke('manage_work', {
      operation: 'complete',
      workId: made.work.id,
      baseRevision: made.work.revision,
      checkpoint: { ...createWake.checkpoint, summary: 'Review finished.', nextStep: '' },
    }),
  );
  assert.equal(finished.status, 'completed');
  assert.equal(f.store.get<Wakeup>('wakeups', made.wakeup.id)?.status, 'cancelled');
  assert.doesNotThrow(() => f.controller.assertWorkTask(made.runtime.task.id, true));
  await assert.rejects(made.runtime.registry.invoke('list_wakeups', {}), /completed/);
  await assert.rejects(
    made.runtime.registry.invoke('write_file', { path: 'after.txt', content: 'Do not write.' }),
    /completed/,
  );
});

test('existing reservations and shared checkpoints require current revisions', async (t) => {
  const f = await fixture(t);
  const made = await f.schedule();
  const update = { operation: 'upsert', key: createWake.key, reason: 'Input is still pending.' };
  await assert.rejects(
    made.runtime.registry.invoke('manage_wakeup', update),
    /revision|baseRevision/i,
  );
  const changed = JSON.parse(
    await made.runtime.registry.invoke('manage_wakeup', {
      ...update,
      baseRevision: made.wakeup.revision,
    }),
  );
  assert.equal(changed.wakeup.revision, made.wakeup.revision + 1);
  await assert.rejects(
    made.runtime.registry.invoke('manage_wakeup', {
      ...update,
      reason: 'A stale planning update.',
      baseRevision: made.wakeup.revision,
    }),
    /changed/,
  );
  await assert.rejects(
    made.runtime.registry.invoke('manage_wakeup', {
      operation: 'cancel',
      wakeupId: made.wakeup.id,
    }),
    /revision|baseRevision/i,
  );
  await assert.rejects(
    made.runtime.registry.invoke('manage_wakeup', {
      operation: 'upsert',
      key: 'another-step',
      reason: createWake.reason,
      prompt: createWake.prompt,
      schedule: createWake.schedule,
      checkpoint: createWake.checkpoint,
    }),
    /manage_work|new work only/,
  );
  const progress = {
    operation: 'update',
    workId: made.work.id,
    checkpoint: { ...createWake.checkpoint, summary: 'More results reviewed.' },
  };
  await assert.rejects(
    made.runtime.registry.invoke('manage_work', progress),
    /revision|baseRevision/i,
  );
  const work = JSON.parse(
    await made.runtime.registry.invoke('manage_work', {
      ...progress,
      baseRevision: made.work.revision,
    }),
  );
  assert.equal(work.revision, made.work.revision + 1);
  await assert.rejects(
    made.runtime.registry.invoke('manage_work', {
      ...progress,
      checkpoint: createWake.checkpoint,
      baseRevision: made.work.revision,
    }),
    /changed/,
  );
});

test('uncertain checkpoints block continuations and cannot be silently cleared by a bot', async (t) => {
  const f = await fixture(t);
  const made = await f.schedule();
  const checkpoint = {
    ...createWake.checkpoint,
    uncertainActions: ['Confirm whether the external submission was accepted.'],
  };
  const blocked = JSON.parse(
    await made.runtime.registry.invoke('manage_work', {
      operation: 'update',
      workId: made.work.id,
      checkpoint,
      baseRevision: made.work.revision,
    }),
  );
  assert.equal(blocked.status, 'blocked');
  await assert.rejects(
    made.runtime.registry.invoke('manage_work', {
      operation: 'update',
      workId: made.work.id,
      checkpoint: createWake.checkpoint,
    }),
    /blocked/,
  );
  await assert.rejects(made.runtime.registry.invoke('manage_wakeup', createWake), /blocked/);
});

test('policy revocation during approval prevents a queued file effect', async (t) => {
  const f = await fixture(t);
  const made = await f.schedule();
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    permissions: { ...f.store.settings().permissions, fileWrite: 'ask' },
  });
  const args = { path: 'approval.txt', content: 'This must not be written.' };
  const pending = made.runtime.registry.invoke('write_file', args);
  const rejected = assert.rejects(pending, /disabled/);
  let approval: Approval | undefined;
  for (let attempt = 0; attempt < 100 && !approval; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    approval = f.store.list<Approval>('approvals').find((item) => item.status === 'pending');
  }
  assert.ok(approval, 'the exact write is waiting for owner approval');
  f.policy('off');
  f.controller.decideApproval(approval.id, true);
  await rejected;
  assert.equal(
    f.controller.getOperation(contextOperationKey(made.runtime.context, 'write_file', args)),
    undefined,
  );
  await assert.rejects(readFile(join(f.store.settings().workspacePath, args.path)), /ENOENT/);
});

test('pre-reservation receipts follow one-time continuations but a new recurring occurrence can act again', async (t) => {
  const f = await fixture(t);
  const first = f.tools();
  const args = { path: 'result.txt', content: 'Reviewed result.' };
  await first.registry.invoke('write_file', args);
  const legacyKey = operationKey(first.task.id, 'write_file', args);
  assert.equal(f.controller.getOperation(legacyKey)?.status, 'completed');
  const made = await f.schedule(first);
  assert.equal(first.task.workId, undefined, 'the live context can retain its original task copy');
  const followup = f.tools({ parentTaskId: first.task.id, kind: 'automation' });
  const file = join(f.store.settings().workspacePath, args.path);
  await writeFile(file, 'A subsequent external change.');
  assert.equal(contextOperationKey(followup.context, 'write_file', args), legacyKey);
  assert.match(await followup.registry.invoke('write_file', args), /already completed/);
  assert.equal(await readFile(file, 'utf8'), 'A subsequent external change.');
  const nextOccurrence = f.tools({
    kind: 'automation',
    workId: made.work.id,
    workRunId: 'server-created-next-occurrence',
  });
  assert.doesNotMatch(
    await nextOccurrence.registry.invoke('write_file', args),
    /already completed/,
  );
  assert.equal(await readFile(file, 'utf8'), args.content);
});

test('completed cross-task file receipts do not bypass newly denied permissions', async (t) => {
  const f = await fixture(t);
  const made = await f.schedule();
  const args = { path: 'permission.txt', content: 'Original contents.' };
  await made.runtime.registry.invoke('write_file', args);
  const followup = f.tools({ parentTaskId: made.runtime.task.id });
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    permissions: { ...f.store.settings().permissions, fileWrite: 'deny' },
  });
  await assert.rejects(followup.registry.invoke('write_file', args), /currently disabled/);
});

test('rebasing an imported workspace preserves work receipts while an unreviewed workspace change remains blocked', async (t) => {
  const f = await fixture(t);
  const made = await f.schedule();
  const args = { path: 'imported-result.txt', content: 'Original verified result.' };
  await made.runtime.registry.invoke('write_file', args);
  const savedKey = contextOperationKey(made.runtime.context, 'write_file', args);
  const importedPath = join(f.store.dataDir, 'rebased-workspace');
  await mkdir(importedPath);
  await writeFile(join(importedPath, args.path), 'Current contents after restoring the archive.');
  // Import preserves immutable IDs and journals, while moving the complete
  // work/task workspace identity to the restored filesystem location.
  f.store.put('settings', { ...f.store.settings(), id: 'main', workspacePath: importedPath });
  f.store.patch<WorkItem>('workItems', made.work.id, { workspacePath: importedPath });
  f.store.patch<Task>('tasks', made.runtime.task.id, { workspacePath: importedPath });
  const next = f.tools({ parentTaskId: made.runtime.task.id });
  assert.equal(contextOperationKey(next.context, 'write_file', args), savedKey);
  assert.match(await next.registry.invoke('write_file', args), /already completed/);
  assert.equal(
    await readFile(join(importedPath, args.path), 'utf8'),
    'Current contents after restoring the archive.',
  );
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    workspacePath: join(f.store.dataDir, 'different-workspace'),
  });
  await assert.rejects(next.registry.invoke('write_file', args), /workspace changed/);
});

test('continuations that both waited at a room boundary cannot claim the same effect twice', async (t) => {
  const f = await fixture(t);
  const made = await f.schedule();
  let waiting = 0;
  let release!: () => void;
  let bothWaiting!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    bothWaiting = resolve;
  });
  const boundary = () => {
    let calls = 0;
    return async () => {
      // The first check is tool entry; the second is after receipt lookup,
      // immediately before the journal claim and actual effect.
      if (++calls !== 2) return;
      if (++waiting === 2) bothWaiting();
      await barrier;
    };
  };
  const first = f.tools({ parentTaskId: made.runtime.task.id }, boundary());
  const second = f.tools({ parentTaskId: made.runtime.task.id }, boundary());
  const args = { message: 'The reviewed result is ready.', title: 'Review complete' };
  const operations = [
    first.registry.invoke('send_user_message', args),
    second.registry.invoke('send_user_message', args),
  ];
  await arrived;
  release();
  const results = await Promise.allSettled(operations);
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  assert.equal(
    f.store.list<{ body: string }>('messages').filter((item) => item.body === args.message).length,
    1,
  );
  assert.equal(f.store.list('notifications').length, 1);
});

test('completed shell inspections can repeat after edits while uncertain shell effects follow the work', async (t) => {
  const f = await fixture(t);
  const made = await f.schedule();
  const file = join(f.store.settings().workspacePath, 'checks.txt');
  const args = {
    command: "node -e \"require('node:fs').appendFileSync('checks.txt', 'checked\\n')\"",
  };
  await made.runtime.registry.invoke('run_command', args);
  const next = f.tools({ parentTaskId: made.runtime.task.id });
  await next.registry.invoke('run_command', args);
  assert.equal(await readFile(file, 'utf8'), 'checked\nchecked\n');
  const uncertainArgs = { command: 'node -e "throw new Error(\'unconfirmed effect\')"' };
  const uncertainKey = operationKey(made.runtime.task.id, 'run_command', uncertainArgs);
  f.controller.saveOperation({
    key: uncertainKey,
    taskId: made.runtime.task.id,
    toolName: 'run_command',
    args: uncertainArgs,
    status: 'started',
    updatedAt: new Date().toISOString(),
  });
  await assert.rejects(next.registry.invoke('run_command', uncertainArgs), /uncertain or failed/);
  assert.equal(contextOperationKey(next.context, 'run_command', uncertainArgs), uncertainKey);
});

test('mail receipts preserve request identity across wakes and recheck account and actor access', async (t) => {
  const f = await fixture(t);
  const account = f.controller.mail!.save({
    name: 'Synthetic mailbox',
    address: 'aster@example.test',
    provider: 'agentmail',
    enabled: true,
    botIds: ['bot_aster', 'bot_nova'],
    sendPolicy: 'allow',
    api: { inboxId: 'test-inbox', apiKey: 'synthetic-never-sent-key' },
  });
  const first = f.tools();
  const draftArgs = {
    accountId: account.id,
    to: ['recipient@example.test'],
    subject: 'Review',
    text: 'Reviewed result.',
  };
  const draft = JSON.parse(await first.registry.invoke('draft_mail', draftArgs)) as MailDraft;
  const sendArgs = { draftId: draft.id, expectedRevision: draft.revision };
  await first.registry.invoke('send_mail', sendArgs);
  const legacyKey = operationKey(first.task.id, 'send_mail', sendArgs);
  const made = await f.schedule(first);
  const next = f.tools({ parentTaskId: first.task.id });
  assert.equal(contextOperationKey(next.context, 'send_mail', sendArgs), legacyKey);
  assert.match(await next.registry.invoke('send_mail', sendArgs), /fixture-accepted-1/);
  assert.equal(f.calls.sends, 1);
  const teammate = f.tools({ parentTaskId: first.task.id, botId: 'bot_nova' });
  const ownDraft = JSON.parse(await teammate.registry.invoke('draft_mail', draftArgs)) as MailDraft;
  assert.notEqual(ownDraft.id, draft.id, 'another actor cannot reuse this bot’s private receipt');
  await assert.rejects(teammate.registry.invoke('send_mail', sendArgs), /unavailable/);
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    permissions: { ...f.store.settings().permissions, network: 'deny' },
  });
  await assert.rejects(next.registry.invoke('send_mail', sendArgs), /currently denied/);
  assert.match(await first.registry.invoke('send_mail', sendArgs), /already completed/);
  f.store.patch<MailAccount>('mailAccounts', account.id, { botIds: ['bot_nova'] });
  await assert.rejects(next.registry.invoke('draft_mail', draftArgs), /assigned/);
  await assert.rejects(first.registry.invoke('send_mail', sendArgs), /assigned/);
  assert.equal(f.store.get<WorkItem>('workItems', made.work.id)?.status, 'active');
  assert.equal(f.calls.sends, 1);
});

test('binding work during a mail approval keeps the provider request and recoverable journal identity aligned', async (t) => {
  const f = await fixture(t);
  const account = f.controller.mail!.save({
    name: 'Synthetic teammate mailbox',
    address: 'nova@example.test',
    provider: 'agentmail',
    enabled: true,
    botIds: ['bot_nova'],
    sendPolicy: 'ask',
    api: { inboxId: 'test-inbox', apiKey: 'synthetic-never-sent-key' },
  });
  const root = f.tools();
  const descendant = f.tools({ parentTaskId: root.task.id, botId: 'bot_nova' });
  const draft = JSON.parse(
    await descendant.registry.invoke('draft_mail', {
      accountId: account.id,
      to: ['recipient@example.test'],
      subject: 'Review',
      text: 'Reviewed result.',
    }),
  ) as MailDraft;
  const args = { draftId: draft.id, expectedRevision: draft.revision };
  const sending = descendant.registry.invoke('send_mail', args);
  const approval = f.store.list<Approval>('approvals').find((item) => item.status === 'pending');
  assert.ok(approval);
  await f.schedule(root);
  assert.equal(descendant.task.workId, undefined);
  assert.ok(f.store.get<Task>('tasks', descendant.task.id)?.workId);
  f.controller.decideApproval(approval.id, true);
  await sending;
  const key = contextOperationKey(descendant.context, 'send_mail', args);
  assert.notEqual(key, operationKey(descendant.task.id, 'send_mail', args));
  const receipt = f.controller.getOperation(key)!;
  // Simulate the narrow crash window after durable provider acceptance but
  // before the generic operation journal records its completed status.
  f.controller.saveOperation({ ...receipt, status: 'started', result: undefined });
  const followup = f.tools({ parentTaskId: descendant.task.id, botId: 'bot_nova' });
  assert.match(await followup.registry.invoke('send_mail', args), /fixture-accepted-1/);
  assert.equal(f.controller.getOperation(key)?.status, 'completed');
  assert.equal(f.calls.sends, 1);
});

test('binding work during image approval preserves attachment identity and later receipt replay', async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const imageServer = createServer((request, response) => {
    request.resume();
    requests++;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        data: [
          {
            b64_json:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6cAAAAASUVORK5CYII=',
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        imageServer.closeAllConnections();
        imageServer.close(() => resolve());
      }),
  );
  const address = imageServer.address();
  assert.ok(address && typeof address !== 'string');
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    images: {
      ...DEFAULT_IMAGE_SETTINGS,
      enabled: true,
      permission: 'ask',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: 'local-image-fixture',
      timeoutSeconds: 5,
    },
  });
  const root = f.tools();
  const descendant = f.tools({ parentTaskId: root.task.id, botId: 'bot_nova' });
  const args = { prompt: 'Draw a blue review mark.' };
  const generating = descendant.registry.invoke('generate_image', args);
  const approval = f.store.list<Approval>('approvals').find((item) => item.status === 'pending');
  assert.ok(approval);
  await f.schedule(root);
  f.controller.decideApproval(approval.id, true);
  const result = await generating;
  const receipt = f.store
    .list<OperationRecord>('operations')
    .find((item) => item.toolName === 'generate_image');
  assert.ok(receipt?.result);
  const attachment = JSON.parse(receipt.result);
  assert.equal(attachment.id, `img_${receipt.key}`);
  assert.ok(result.includes(attachment.id));
  const followup = f.tools({ parentTaskId: descendant.task.id, botId: 'bot_nova' });
  assert.match(
    await followup.registry.invoke('generate_image', args),
    /Restored the previously generated image/,
  );
  assert.equal(requests, 1);
});

test('a real unknown mail outcome blocks scheduled work even after the task finishes and requires owner acknowledgment', async (t) => {
  const f = await fixture(t);
  const made = await f.schedule();
  const account = f.controller.mail!.save({
    name: 'Synthetic mailbox',
    address: 'aster@example.test',
    provider: 'agentmail',
    enabled: true,
    botIds: ['bot_aster'],
    sendPolicy: 'allow',
    api: { inboxId: 'fixture', apiKey: 'synthetic-key' },
  });
  // An owner-created draft has no botId, but the bot's exact issued operation
  // still provides trusted provenance for its actual connector outcome.
  const draft = f.controller.mail!.saveDraft({
    accountId: account.id,
    to: ['recipient@example.test'],
    subject: 'Review',
    text: 'Reviewed result.',
  });
  const args = { draftId: draft.id, expectedRevision: draft.revision };
  f.calls.outcome = 'unknown';
  await assert.rejects(made.runtime.registry.invoke('send_mail', args), /may have accepted/);
  assert.equal(f.controller.mail!.getDraft(draft.id).status, 'unknown');
  const key = contextOperationKey(made.runtime.context, 'send_mail', args);
  const operation = f.controller.getOperation(key)!;
  assert.equal(operation.status, 'failed');
  assert.deepEqual(operation.uncertainty, { kind: 'mail', draftId: draft.id });
  const blocked = f.store.get<WorkItem>('workItems', made.work.id)!;
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.finishedByTaskId, made.runtime.task.id);
  assert.ok(
    blocked.checkpoint.uncertainActions.some(
      (note) => note.includes(draft.id) && note.includes(key),
    ),
  );
  assert.doesNotThrow(() => f.controller.assertWorkTask(made.runtime.task.id, true));
  await assert.rejects(made.runtime.registry.invoke('manage_wakeup', createWake), /blocked/);
  f.controller.updateTask(made.runtime.task.id, { status: 'completed' });
  const before = f.store.list('tasks').length;
  f.store.patch<Wakeup>('wakeups', made.wakeup.id, {
    nextRunAt: new Date(Date.now() - 1_000).toISOString(),
  });
  f.controller.work.tick();
  assert.equal(f.store.list('tasks').length, before);
  assert.equal(f.store.get<WorkItem>('workItems', made.work.id)?.status, 'blocked');
  // Ordinary final journal writes cannot erase either the marker or its review.
  f.controller.saveOperation({ ...operation, uncertainty: undefined });
  assert.deepEqual(f.controller.getOperation(key)?.uncertainty, operation.uncertainty);
  assert.throws(() => f.controller.work.resume(made.work.id), /clear.*uncertain/);
  f.controller.work.resume(made.work.id, { ...blocked.checkpoint, uncertainActions: [] });
  const acknowledged = f.controller.getOperation(key)!;
  assert.ok(acknowledged.uncertainty?.reviewedAt);
  assert.equal(acknowledged.status, 'failed');
  f.controller.saveOperation({ ...operation, uncertainty: undefined });
  assert.deepEqual(f.controller.getOperation(key)?.uncertainty, acknowledged.uncertainty);
  const followup = f.tools({ parentTaskId: made.runtime.task.id });
  await assert.rejects(followup.registry.invoke('send_mail', args), /uncertain or failed/);
  assert.equal(f.calls.sends, 1);
});

test('unknown mail before first work blocks binding its caller, descendants and ancestors but not an unrelated sibling', async (t) => {
  const f = await fixture(t);
  const account = f.controller.mail!.save({
    name: 'Synthetic teammate mailbox',
    address: 'nova@example.test',
    provider: 'agentmail',
    enabled: true,
    botIds: ['bot_nova'],
    sendPolicy: 'allow',
    api: { inboxId: 'fixture', apiKey: 'synthetic-key' },
  });
  const root = f.tools();
  const sender = f.tools({ parentTaskId: root.task.id, botId: 'bot_nova' });
  const descendant = f.tools({ parentTaskId: sender.task.id });
  const sibling = f.tools({ parentTaskId: root.task.id });
  const draft = JSON.parse(
    await sender.registry.invoke('draft_mail', {
      accountId: account.id,
      to: ['recipient@example.test'],
      subject: 'Review',
      text: 'Reviewed result.',
    }),
  ) as MailDraft;
  f.calls.outcome = 'unknown';
  await assert.rejects(
    sender.registry.invoke('send_mail', { draftId: draft.id, expectedRevision: draft.revision }),
  );
  for (const runtime of [sender, root, descendant]) {
    await assert.rejects(f.schedule(runtime), /unreviewed unknown mail delivery/);
    assert.equal(f.store.get<Task>('tasks', runtime.task.id)?.workId, undefined);
    assert.equal(f.store.list('workItems').length, 0, 'the failed binding rolls back its new work');
    assert.equal(f.store.list('wakeups').length, 0);
  }
  const independent = await f.schedule(sibling);
  assert.equal(independent.work.status, 'active');
  assert.equal(f.calls.sends, 1);
});

test('definite mail preflight failure is not recorded as uncertainty and cannot spoof the trusted reporting path', async (t) => {
  const f = await fixture(t);
  const made = await f.schedule();
  const account = f.controller.mail!.save({
    name: 'Synthetic mailbox',
    address: 'aster@example.test',
    provider: 'agentmail',
    enabled: true,
    botIds: ['bot_aster'],
    sendPolicy: 'allow',
    api: { inboxId: 'fixture', apiKey: 'synthetic-key' },
  });
  const draft = JSON.parse(
    await made.runtime.registry.invoke('draft_mail', {
      accountId: account.id,
      to: ['recipient@example.test'],
      subject: 'Review',
      text: 'Reviewed result.',
    }),
  ) as MailDraft;
  const args = { draftId: draft.id, expectedRevision: draft.revision };
  f.calls.outcome = 'preflight';
  await assert.rejects(made.runtime.registry.invoke('send_mail', args));
  assert.equal(f.controller.mail!.getDraft(draft.id).status, 'failed');
  const key = contextOperationKey(made.runtime.context, 'send_mail', args);
  assert.equal(f.controller.getOperation(key)?.uncertainty, undefined);
  assert.throws(
    () => f.controller.recordUncertainWorkMail(made.runtime.task.id, key, draft.id),
    /No matching server-recorded unknown/,
  );
  assert.equal(f.store.get<WorkItem>('workItems', made.work.id)?.status, 'active');
  assert.deepEqual(
    f.store.get<WorkItem>('workItems', made.work.id)?.checkpoint.uncertainActions,
    [],
  );
  f.controller.updateTask(made.runtime.task.id, { status: 'completed' });
  f.store.patch<Wakeup>('wakeups', made.wakeup.id, {
    nextRunAt: new Date(Date.now() - 1_000).toISOString(),
  });
  f.controller.work.tick();
  assert.ok(f.store.get<Wakeup>('wakeups', made.wakeup.id)?.lastTaskId);
  assert.equal(f.calls.sends, 0);
});
