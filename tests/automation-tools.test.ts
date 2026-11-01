import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { createTools, operationKey } from '../src/server/runtime/tools.js';
import { automationRevision, type AutomationInput } from '../src/server/automations.js';
import type { Approval, Automation, Bot, Room, Task } from '../src/shared/types.js';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-automation-tools-'));
  const f = await createApp({
    dataDir,
    scheduler: false,
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
    permissions: { shell: 'allow', network: 'allow', fileWrite: 'allow' },
  });
  t.after(async () => {
    await f.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  function tools(patch: Partial<Task> = {}) {
    const task = f.controller.enqueueTask({
      roomId: 'room_lounge',
      botId: 'bot_aster',
      prompt: 'Configure my recurring check.',
    });
    Object.assign(task, patch);
    f.store.put('tasks', task);
    const abort = new AbortController();
    const registry = createTools({
      host: f.controller,
      task,
      settings: f.store.settings(),
      signal: abort.signal,
      operationKeys: new Set(),
    });
    return { task, abort, registry };
  }
  function pending() {
    const approval = f.store
      .list<Approval>('approvals')
      .findLast((item) => item.status === 'pending');
    assert.ok(approval, 'the owner has a concrete pending approval');
    return approval;
  }
  async function approve(args: Record<string, unknown>, runtime = tools()) {
    const work = runtime.registry.invoke('manage_automation', args);
    f.controller.decideApproval(pending().id, true);
    return { result: await work, ...runtime };
  }
  function save(patch: Partial<AutomationInput> = {}) {
    return f.controller.saveAutomation({
      name: 'Existing check',
      kind: 'interval',
      roomId: 'room_lounge',
      botId: 'bot_aster',
      prompt: 'Report actionable changes.',
      intervalMinutes: 60,
      sourceUrl: '',
      enabled: true,
      ...patch,
    });
  }
  return { ...f, tools, pending, approve, save };
}

const createRule = {
  operation: 'create',
  name: 'Check releases',
  kind: 'url_watch',
  sourceUrl: 'https://example.com/releases',
  prompt: 'Summarize new releases.',
  intervalMinutes: 30,
  botHandle: '@nova',
};

test('chat automation creation requires concrete approval even with Allow and journals replay', async (t) => {
  const f = await fixture(t);
  const runtime = f.tools();
  const work = runtime.registry.invoke('manage_automation', createRule);
  assert.equal(f.store.list('automations').length, 0);
  assert.equal(f.store.get<Task>('tasks', runtime.task.id)?.status, 'awaiting_approval');
  const approval = f.pending();
  assert.match(approval.summary, /Create automation: Check releases/);
  assert.match(approval.target, /ラウンジ.*Nova/);
  assert.equal(approval.args.intervalMinutes, 30);
  assert.equal(approval.args.instructions, createRule.prompt);
  assert.equal(approval.args.sourceUrl, createRule.sourceUrl);
  f.controller.decideApproval(approval.id, true);
  const result = JSON.parse(await work);
  const rule = f.store.get<Automation>('automations', result.id)!;
  assert.equal(rule.enabled, true);
  assert.equal(rule.botId, 'bot_nova');
  assert.equal(rule.roomId, 'room_lounge');
  assert.ok(rule.nextRunAt);
  assert.match(await runtime.registry.invoke('manage_automation', createRule), /already completed/);
  assert.equal(f.store.list('automations').length, 1);
  assert.equal(f.store.list('approvals').length, 1);
  assert.equal(
    f.controller.getOperation(operationKey(runtime.task.id, 'manage_automation', createRule))
      ?.status,
    'completed',
  );
});

test('denied and aborted automation approvals do not create a rule', async (t) => {
  const f = await fixture(t);
  const first = f.tools();
  const denied = first.registry.invoke('manage_automation', createRule);
  const denial = assert.rejects(denied, /denied or cancelled/);
  f.controller.decideApproval(f.pending().id, false);
  await denial;
  const second = f.tools();
  const cancelled = second.registry.invoke('manage_automation', createRule);
  const cancellation = assert.rejects(cancelled, /Task stopped/);
  const approvalId = f.pending().id;
  second.abort.abort();
  await cancellation;
  assert.equal(f.store.get<Approval>('approvals', approvalId)?.status, 'cancelled');
  assert.equal(f.store.list('automations').length, 0);
});

test('automation tools reject unknown credential fields before persisting activities', async (t) => {
  const f = await fixture(t);
  const runtime = f.tools();
  const before = f.store.list('activities').length;
  await assert.rejects(
    runtime.registry.invoke('manage_automation', {
      ...createRule,
      roomId: 'another-room',
      password: 'synthetic-secret',
    }),
    /Unrecognized/,
  );
  await assert.rejects(
    runtime.registry.invoke('manage_automation', {
      operation: 'create',
      name: 'Mail',
      kind: 'imap',
      prompt: 'Inspect senders.',
      imap: { user: 'owner@gmail.com', password: 'synthetic-secret' },
    }),
    /Unrecognized/,
  );
  assert.equal(f.store.list('activities').length, before);
  assert.equal(f.store.list('approvals').length, 0);
  await assert.rejects(
    runtime.registry.invoke('manage_automation', {
      ...createRule,
      sourceUrl: 'file:///home/private',
    }),
    /public HTTP/,
  );
  assert.equal(f.store.list('approvals').length, 0);
});

test('room automation listings and edits cannot reach another room or reveal mail/hook secrets', async (t) => {
  const f = await fixture(t);
  const own = f.save({
    kind: 'imap',
    imap: {
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      user: 'owner@gmail.com',
      mailbox: 'INBOX',
      password: 'aaaa bbbb cccc dddd',
    },
  });
  const otherRoom = {
    ...f.store.get<Room>('rooms', 'room_lounge')!,
    id: 'other-room',
    name: 'Private room',
  };
  f.store.put('rooms', otherRoom);
  const other = f.save({ roomId: otherRoom.id, name: 'Other room rule' });
  f.store.setSecret(`hook.${own.id}`, 'synthetic-hook-secret');
  const runtime = f.tools();
  const text = await runtime.registry.invoke('list_automations', {});
  const list = JSON.parse(text);
  assert.deepEqual(
    list.automations.map((rule: { id: string }) => rule.id),
    [own.id],
  );
  assert.equal(list.automations[0].imap.passwordConfigured, true);
  assert.equal(text.includes('aaaabbbbccccdddd'), false);
  assert.equal(text.includes('synthetic-hook-secret'), false);
  await assert.rejects(
    runtime.registry.invoke('list_automations', { automationId: other.id }),
    /this room/,
  );
  await assert.rejects(
    runtime.registry.invoke('manage_automation', { operation: 'pause', automationId: other.id }),
    /this room/,
  );
  assert.equal(f.store.list('approvals').length, 0);
});

test('approved edits preserve the prior task guard and reset only source baselines', async (t) => {
  const f = await fixture(t);
  const rule = f.save({ kind: 'url_watch', sourceUrl: 'https://example.com/old' });
  f.store.put('automationState', {
    id: rule.id,
    lastTaskId: 'previous-task',
    sourceIdentity: 'old',
    sourceHash: 'hash',
    uidValidity: '42',
    lastUid: 5,
  });
  await f.approve({
    operation: 'update',
    automationId: rule.id,
    sourceUrl: 'https://example.com/new',
    intervalMinutes: 10,
  });
  assert.equal(
    f.store.get<Automation>('automations', rule.id)?.sourceUrl,
    'https://example.com/new',
  );
  assert.deepEqual(f.store.get('automationState', rule.id), {
    id: rule.id,
    lastTaskId: 'previous-task',
  });
  await f.approve({ operation: 'pause', automationId: rule.id });
  assert.equal(f.store.get<Automation>('automations', rule.id)?.enabled, false);
  assert.equal(f.store.get<Automation>('automations', rule.id)?.nextRunAt, undefined);
  await f.approve({ operation: 'resume', automationId: rule.id });
  assert.equal(f.store.get<Automation>('automations', rule.id)?.enabled, true);
});

test('approval rejects an owner edit but ignores ordinary polling timestamps', async (t) => {
  const f = await fixture(t);
  const rule = f.save();
  const runtime = f.tools();
  const pending = runtime.registry.invoke('manage_automation', {
    operation: 'update',
    automationId: rule.id,
    intervalMinutes: 20,
  });
  const rejection = assert.rejects(pending, /changed while awaiting approval/);
  f.controller.saveAutomation(
    { ...rule, prompt: 'Owner edited these instructions.' },
    { id: rule.id },
  );
  f.controller.decideApproval(f.pending().id, true);
  await rejection;
  assert.equal(f.store.get<Automation>('automations', rule.id)?.intervalMinutes, 60);
  assert.equal(
    f.store.get<Automation>('automations', rule.id)?.prompt,
    'Owner edited these instructions.',
  );
  const second = f.tools();
  const approved = second.registry.invoke('manage_automation', {
    operation: 'update',
    automationId: rule.id,
    intervalMinutes: 20,
  });
  f.store.patch<Automation>('automations', rule.id, {
    lastRunAt: new Date().toISOString(),
    lastError: 'temporary poll failure',
  });
  f.controller.decideApproval(f.pending().id, true);
  await approved;
  assert.equal(f.store.get<Automation>('automations', rule.id)?.intervalMinutes, 20);
});

test('room, actor and target membership are checked again after approval', async (t) => {
  for (const mutation of ['archived', 'actor-disabled', 'target-removed'] as const) {
    const f = await fixture(t);
    const runtime = f.tools();
    const work = runtime.registry.invoke('manage_automation', createRule);
    const rejection = assert.rejects(work, /active room|enabled|changed/);
    if (mutation === 'archived') f.store.patch<Room>('rooms', 'room_lounge', { archived: true });
    else if (mutation === 'actor-disabled')
      f.store.patch<Bot>('bots', 'bot_aster', { enabled: false });
    else f.store.patch<Room>('rooms', 'room_lounge', { botIds: ['bot_aster'] });
    f.controller.decideApproval(f.pending().id, true);
    await rejection;
    assert.equal(f.store.list('automations').length, 0);
  }
});

test('Gmail rule drafts stay disabled until the owner adds credentials through the API', async (t) => {
  const f = await fixture(t);
  const { result } = await f.approve({
    operation: 'create',
    name: 'Important Gmail',
    kind: 'imap',
    prompt: 'Notify me about important senders.',
    intervalMinutes: 5,
    enabled: true,
    imap: { user: 'owner@gmail.com' },
  });
  const created = JSON.parse(result);
  const rule = f.store.get<Automation>('automations', created.id)!;
  assert.equal(rule.enabled, false);
  assert.deepEqual(rule.imap, {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    user: 'owner@gmail.com',
    mailbox: 'INBOX',
    passwordConfigured: false,
  });
  assert.match(created.note, /app password/);
  assert.equal(f.store.secret(`imap.${rule.id}.password`), '');
  await assert.rejects(
    f.tools().registry.invoke('manage_automation', { operation: 'resume', automationId: rule.id }),
    /app password/,
  );
  const saved = await f.app.inject({
    method: 'PATCH',
    url: `/api/automations/${rule.id}`,
    payload: { imap: { ...rule.imap, password: 'aaaa bbbb cccc dddd' }, enabled: true },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json<Automation>().imap?.passwordConfigured, true);
  assert.equal(f.store.secret(`imap.${rule.id}.password`), 'aaaabbbbccccdddd');
  assert.equal(saved.body.includes('aaaabbbbccccdddd'), false);
});

test('connected mail credentials cannot be retargeted by a bot and owner account changes clear them', async (t) => {
  const f = await fixture(t);
  const rule = f.save({
    kind: 'imap',
    imap: {
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      user: 'owner@gmail.com',
      mailbox: 'INBOX',
      password: 'aaaabbbbccccdddd',
    },
  });
  await assert.rejects(
    f.tools().registry.invoke('manage_automation', {
      operation: 'update',
      automationId: rule.id,
      imap: { host: 'different.example', user: 'owner@gmail.com' },
    }),
    /automation editor/,
  );
  assert.equal(f.store.list('approvals').length, 0);
  await f.approve({ operation: 'update', automationId: rule.id, intervalMinutes: 15 });
  assert.equal(f.store.secret(`imap.${rule.id}.password`), 'aaaabbbbccccdddd');
  const rejected = await f.app.inject({
    method: 'PATCH',
    url: `/api/automations/${rule.id}`,
    payload: { imap: { ...rule.imap, host: 'another.example' } },
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(f.store.secret(`imap.${rule.id}.password`), 'aaaabbbbccccdddd');
  const changed = await f.app.inject({
    method: 'PATCH',
    url: `/api/automations/${rule.id}`,
    payload: { imap: { ...rule.imap, host: 'another.example' }, enabled: false },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(f.store.secret(`imap.${rule.id}.password`), '');
  assert.equal(changed.json<Automation>().imap?.passwordConfigured, false);
});

test('background, learning and bot-handoff tasks cannot configure recurring work', async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { kind: 'automation' },
    { kind: 'learning' },
    { parentTaskId: 'parent', depth: 1 },
  ] as Partial<Task>[]) {
    const { registry } = f.tools(patch);
    assert.equal(
      registry.definitions.some((tool) => /^(list_automations|manage_automation)$/.test(tool.name)),
      false,
    );
    await assert.rejects(registry.invoke('manage_automation', createRule), /not available/);
  }
  const rule = f.save();
  assert.throws(
    () =>
      f.controller.saveAutomation(
        { ...rule, name: 'Overwrite' },
        { id: rule.id, revision: 'stale' },
      ),
    /changed while awaiting approval/,
  );
  assert.equal(f.store.get<Automation>('automations', rule.id)?.name, rule.name);
  assert.equal(automationRevision(rule), automationRevision({ ...rule, lastError: 'different' }));
});

test('bots can propose a connected mail watcher only for an assigned account and target bot', async (t) => {
  const f = await fixture(t);
  const account = f.controller.mail!.save({
    name: 'Aster inbox',
    address: 'aster@example.test',
    provider: 'agentmail',
    enabled: true,
    botIds: ['bot_aster'],
    sendPolicy: 'ask',
    api: { inboxId: 'test-inbox', apiKey: 'synthetic-mail-key' },
  });
  const args = {
    operation: 'create',
    name: 'Important incoming mail',
    kind: 'imap',
    mailAccountId: account.id,
    prompt: 'Notify me when a message needs a reply.',
    intervalMinutes: 2,
  };
  const runtime = f.tools();
  const work = runtime.registry.invoke('manage_automation', args);
  const review = f.pending();
  assert.deepEqual(review.args.mailAccount, {
    id: account.id,
    name: account.name,
    address: account.address,
    provider: 'agentmail',
  });
  assert.doesNotMatch(JSON.stringify(review), /synthetic-mail-key/);
  f.controller.decideApproval(review.id, true);
  const created = JSON.parse(await work);
  const rule = f.store.get<Automation>('automations', created.id)!;
  assert.equal(rule.mailAccountId, account.id);
  assert.equal(rule.imap, undefined);
  assert.equal(rule.enabled, true);
  await assert.rejects(
    f.tools().registry.invoke('manage_automation', { ...args, botHandle: 'nova' }),
    /assigned/,
  );
  await assert.rejects(
    f
      .tools()
      .registry.invoke('manage_automation', { ...args, imap: { user: 'different@example.test' } }),
    /do not supply inline/,
  );
  f.store.patch('mailAccounts', account.id, { enabled: false });
  await assert.rejects(f.tools().registry.invoke('manage_automation', args), /disabled|Enable/);
  const disabled = await f.approve({ ...args, enabled: false });
  assert.equal(
    f.store.get<Automation>('automations', JSON.parse(disabled.result).id)?.enabled,
    false,
  );
});
