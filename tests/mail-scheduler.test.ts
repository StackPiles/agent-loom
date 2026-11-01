import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createScheduler, type SchedulerOptions } from '../src/server/scheduler.js';
import { encodeLegacyImapCursor } from '../src/server/mail-accounts.js';
import { saveAutomation } from '../src/server/automations.js';
import type {
  MailAccount,
  MailPollResult,
  MailMessageSummary,
} from '../src/shared/mail-accounts.js';
import type { Automation, Task } from '../src/shared/types.js';

const stamp = '2026-11-01T00:00:00.000Z';
const message = (id: string): MailMessageSummary => ({
  id,
  accountId: 'mail_account',
  folder: 'INBOX',
  subject: `Subject ${id}`,
  from: [{ address: 'sender@example.test' }],
  to: [{ address: 'bot@example.test' }],
  date: stamp,
});
const empty = (cursor = 'cursor'): MailPollResult => ({ messages: [], cursor, baseline: false });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'loom-mail-scheduler-'));
  const store = new Store(directory);
  store.seed();
  store.put('settings', {
    ...store.settings(),
    id: 'main',
    permissions: { ...store.settings().permissions, network: 'allow' },
  });
  const account = store.put<MailAccount>('mailAccounts', {
    id: 'mail_account',
    name: 'Bot mail',
    address: 'bot@example.test',
    provider: 'agentmail',
    botIds: ['bot_aster'],
    sendPolicy: 'ask',
    enabled: true,
    api: { inboxId: 'source_one', apiKeyConfigured: true },
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  });
  const rule = store.put<Automation>('automations', {
    id: 'auto_mail',
    name: 'Mail rule',
    kind: 'imap',
    mailAccountId: account.id,
    enabled: true,
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Summarize important mail.',
    intervalMinutes: 1,
    sourceUrl: '',
    createdAt: stamp,
  });
  let sequence = 0;
  let failEnqueue = false;
  let poll: NonNullable<SchedulerOptions['mail']>['poll'] = async () => empty();
  const requests: { cursor?: string; since?: string; limit?: number }[] = [];
  const options: SchedulerOptions = {
    store,
    changed() {},
    notify: (input) => ({ ...input, id: 'notice', read: false, createdAt: stamp }),
    enqueueTask(input) {
      const task = store.put<Task>('tasks', {
        ...input,
        id: `task_${++sequence}`,
        rootTaskId: `task_${sequence}`,
        depth: 0,
        kind: 'automation',
        status: 'queued',
        output: '',
        createdAt: stamp,
        updatedAt: stamp,
        inputTokens: 0,
        outputTokens: 0,
      });
      if (failEnqueue) throw new Error('Synthetic enqueue failure.');
      return task;
    },
    mail: {
      get: (id) => store.get<MailAccount>('mailAccounts', id)!,
      poll: (id, cursor, signal, settings) => {
        requests.push({ cursor, ...settings });
        return poll(id, cursor, signal, settings);
      },
    },
  };
  const scheduler = createScheduler(options);
  const tasks = () => store.list<Task>('tasks').sort((a, b) => a.id.localeCompare(b.id));
  const state = () =>
    store.get<{
      id: string;
      sourceIdentity?: string;
      mailCursor?: string;
      mailSince?: string;
      pendingMail?: { id: string; text: string }[];
      lastTaskId?: string;
      legacyMailAccountId?: string;
      lastUid?: number;
    }>('automationState', rule.id)!;
  return {
    store,
    account,
    rule,
    scheduler,
    options,
    requests,
    tasks,
    state,
    setPoll: (next: typeof poll) => {
      poll = next;
    },
    failEnqueue: (next: boolean) => {
      failEnqueue = next;
    },
    complete: () => {
      for (const task of tasks()) store.patch<Task>('tasks', task.id, { status: 'completed' });
    },
    async close() {
      await scheduler.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('a provider mailbox reset persists its new checkpoint and informs the owner without replaying history', async () => {
  const f = fixture();
  await f.scheduler.stop();
  const notices: string[] = [];
  const scheduler = createScheduler({
    ...f.options,
    notify(input) {
      notices.push(input.body);
      return f.options.notify(input);
    },
  });
  try {
    f.setPoll(async () => ({
      messages: [],
      cursor: 'new_epoch',
      baseline: true,
      reset: 'uidvalidity_changed',
    }));
    await scheduler.run(f.rule.id);
    assert.equal(f.state().mailCursor, 'new_epoch');
    assert.equal(f.tasks().length, 0);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /UIDVALIDITY/);
    assert.match(notices[0], /Check the mailbox directly/);
    f.setPoll(async () => ({
      messages: [message('later_arrival')],
      cursor: 'after_reset',
      baseline: false,
    }));
    await scheduler.run(f.rule.id);
    assert.equal(f.tasks().length, 1);
    assert.equal(notices.length, 1);
  } finally {
    await scheduler.stop();
    await f.close();
  }
});

test('first poll keeps signup mail since rule creation; busy intake and overlap dedup survive scheduler restart', async () => {
  const f = fixture();
  try {
    let step = 0;
    f.setPoll(async () =>
      step++ === 0
        ? { messages: [message('signup')], cursor: 'one', baseline: true }
        : { messages: [message('signup'), message('new')], cursor: 'two', baseline: false },
    );
    await f.scheduler.run(f.rule.id);
    assert.equal(f.requests[0].since, stamp);
    assert.equal(f.tasks().length, 1);
    assert.match(f.tasks()[0].prompt, /signup/);
    assert.match(f.tasks()[0].prompt, /untrusted external content/);
    assert.match(f.tasks()[0].prompt, /read_mail/);
    await f.scheduler.run(f.rule.id);
    assert.equal(f.tasks().length, 1);
    assert.deepEqual(
      f.state().pendingMail?.map((item) => item.id),
      ['new'],
    );
    assert.equal(f.state().mailCursor, 'two');
    await f.scheduler.stop();
    f.complete();
    const restarted = createScheduler(f.options);
    await restarted.run(f.rule.id);
    await restarted.stop();
    assert.equal(f.tasks().length, 2);
    assert.match(f.tasks()[1].prompt, /"id":"new"/);
    assert.doesNotMatch(f.tasks()[1].prompt, /"id":"signup"/);
    assert.equal(f.state().pendingMail?.length, 0);
  } finally {
    await f.close();
  }
});

test('pending mail has bounded backpressure without advancing or discarding its provider cursor', async () => {
  const f = fixture();
  try {
    let page = 0;
    f.setPoll(async (_id, _cursor, _signal, options) => {
      const current = ++page;
      return {
        messages: Array.from({ length: options!.limit! }, (_, index) =>
          message(`${current}-${index}`),
        ),
        cursor: `cursor-${current}`,
        baseline: current === 1,
      };
    });
    for (let index = 0; index < 6; index++) await f.scheduler.run(f.rule.id);
    assert.equal(f.tasks().length, 1);
    assert.equal(f.state().pendingMail?.length, 100);
    assert.equal(page, 6);
    await f.scheduler.run(f.rule.id);
    assert.equal(page, 6, 'a full local queue stops provider polling until space is available');
    assert.equal(f.state().mailCursor, 'cursor-6');
    f.complete();
    f.setPoll(async (_id, cursor) => empty(cursor));
    await f.scheduler.run(f.rule.id);
    assert.equal(f.tasks().length, 2);
    assert.equal(f.state().pendingMail?.length, 80);
  } finally {
    await f.close();
  }
});

test('enqueue and pending acknowledgement are atomic when task admission fails', async () => {
  const f = fixture();
  try {
    f.setPoll(async () => ({ messages: [message('once')], cursor: 'committed', baseline: true }));
    f.failEnqueue(true);
    await assert.rejects(f.scheduler.run(f.rule.id));
    assert.equal(f.tasks().length, 0, 'partially persisted task rolls back');
    assert.deepEqual(
      f.state().pendingMail?.map((item) => item.id),
      ['once'],
    );
    assert.equal(f.state().mailCursor, 'committed');
    f.failEnqueue(false);
    await f.scheduler.run(f.rule.id);
    assert.equal(f.tasks().length, 1);
    assert.equal(f.state().pendingMail?.length, 0);
    assert.equal(f.state().lastTaskId, f.tasks()[0].id);
  } finally {
    await f.close();
  }
});

test('source edits discard stale in-flight results and use the edit-time cutoff; metadata edits keep the cursor', async () => {
  const f = fixture();
  try {
    f.setPoll(async () => empty('initial'));
    await f.scheduler.run(f.rule.id);
    let release!: (result: MailPollResult) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.setPoll(async () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const work = f.scheduler.run(f.rule.id);
    await waiting;
    f.store.patch<MailAccount>('mailAccounts', f.account.id, {
      revision: 2,
      api: { inboxId: 'changed_source', apiKeyConfigured: true },
    });
    const editTime = '2026-11-01T01:00:00.000Z';
    f.store.put('automationState', {
      ...f.state(),
      mailCursor: undefined,
      pendingMail: [],
      mailSince: editTime,
    });
    release({ messages: [message('old-source')], cursor: 'stale', baseline: false });
    await work;
    assert.equal(f.tasks().length, 0);
    assert.equal(f.state().mailCursor, undefined);
    f.setPoll(async () => ({
      messages: [message('new-source')],
      cursor: 'new-cursor',
      baseline: true,
    }));
    await f.scheduler.run(f.rule.id);
    assert.equal(f.requests.at(-1)?.since, editTime);
    assert.equal(f.requests.at(-1)?.cursor, undefined);
    assert.equal(f.tasks().length, 1);
    assert.doesNotMatch(f.tasks()[0].prompt, /old-source/);
    f.store.patch<MailAccount>('mailAccounts', f.account.id, {
      revision: 3,
      name: 'Renamed account',
      sendPolicy: 'deny',
    });
    f.setPoll(async () => empty('same-cursor'));
    await f.scheduler.run(f.rule.id);
    assert.equal(
      f.requests.at(-1)?.cursor,
      'new-cursor',
      'name, revision, and send policy do not change the source',
    );
  } finally {
    await f.close();
  }
});

test('migration preserves IMAP UIDs even if an owner edits a migrated rule before its first poll', async () => {
  const f = fixture();
  try {
    const imap = {
      host: 'imap.example.test',
      port: 993,
      secure: true,
      user: 'bot@example.test',
      mailbox: 'INBOX',
      passwordConfigured: true,
    };
    f.store.put<MailAccount>('mailAccounts', {
      ...f.account,
      provider: 'imap',
      api: undefined,
      imap,
    });
    const migrated = f.store.put<Automation>('automations', { ...f.rule, imap });
    f.store.put('automationState', {
      id: f.rule.id,
      sourceIdentity: 'legacy-source',
      uidValidity: '7',
      lastUid: 42,
      legacyMailAccountId: f.account.id,
      lastTaskId: 'historical-task',
    });
    const edited = saveAutomation(f.store, { ...migrated, name: 'Edited before poll' }, migrated);
    assert.equal(edited.imap, undefined, 'deprecated inline config is removed');
    assert.equal(f.state().legacyMailAccountId, f.account.id);
    assert.equal(f.state().lastUid, 42);
    f.setPoll(async () => empty('generic-cursor'));
    await f.scheduler.run(f.rule.id);
    assert.equal(f.requests[0].cursor, encodeLegacyImapCursor('7', 42));
    assert.equal(f.state().legacyMailAccountId, undefined);
    assert.equal(f.state().lastUid, undefined);
    assert.equal(f.state().mailCursor, 'generic-cursor');
  } finally {
    await f.close();
  }
});

test('new sources receive edit-time cursors even before any previous poll state exists', async () => {
  const f = fixture();
  try {
    const next = f.store.put<MailAccount>('mailAccounts', {
      ...f.account,
      id: 'mail_second',
      api: { inboxId: 'second', apiKeyConfigured: true },
    });
    assert.equal(f.state(), undefined);
    saveAutomation(f.store, { ...f.rule, mailAccountId: next.id }, f.rule);
    assert.ok(Date.parse(f.state().mailSince!) >= Date.parse(stamp));
    assert.equal(f.state().pendingMail, undefined);
    f.setPoll(async () => empty());
    await f.scheduler.run(f.rule.id);
    assert.equal(f.requests[0].since, f.state().mailSince);
  } finally {
    await f.close();
  }
});

test('mail intake obeys network permission, bot assignment and shutdown cancellation', async () => {
  const f = fixture();
  try {
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      permissions: { ...f.store.settings().permissions, network: 'ask' },
    });
    await assert.rejects(f.scheduler.run(f.rule.id), /network permission/);
    assert.equal(f.requests.length, 0);
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      permissions: { ...f.store.settings().permissions, network: 'allow' },
    });
    f.store.patch<MailAccount>('mailAccounts', f.account.id, { botIds: [] });
    await assert.rejects(f.scheduler.run(f.rule.id), /assign it/);
    assert.equal(f.requests.length, 0);
    f.store.patch<MailAccount>('mailAccounts', f.account.id, { botIds: ['bot_aster'] });
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.setPoll(
      async (_id, _cursor, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
          started();
        }),
    );
    const running = f.scheduler.run(f.rule.id);
    const rejected = assert.rejects(running, /cancelled/);
    await waiting;
    await f.scheduler.stop();
    await rejected;
    assert.equal(f.tasks().length, 0);
    assert.equal(f.state(), undefined);
  } finally {
    await f.close();
  }
});
