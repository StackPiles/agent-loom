import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import {
  createScheduler,
  type SchedulerAdapters,
  type SchedulerMailClient,
} from '../src/server/scheduler.js';
import type { Automation, Notification, Task } from '../src/shared/types.js';
import type { NewTask } from '../src/server/runtime/contract.js';

function fixture(adapters: SchedulerAdapters = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'loom-scheduler-'));
  const store = new Store(directory);
  store.seed();
  const tasks: Task[] = [];
  const notifications: Notification[] = [];
  let currentTime = Date.parse('2026-10-30T10:00:00Z');
  const enqueueTask = (input: NewTask): Task => {
    const task: Task = {
      id: `task_${tasks.length + 1}`,
      roomId: input.roomId,
      botId: input.botId,
      prompt: input.prompt,
      status: 'queued',
      rootTaskId: `task_${tasks.length + 1}`,
      depth: 0,
      kind: input.kind ?? 'chat',
      output: '',
      createdAt: new Date(currentTime).toISOString(),
      updatedAt: new Date(currentTime).toISOString(),
      inputTokens: 0,
      outputTokens: 0,
    };
    tasks.push(task);
    return store.put('tasks', task);
  };
  const notify = (
    input: Pick<Notification, 'title' | 'body'> & Partial<Pick<Notification, 'roomId' | 'taskId'>>,
  ): Notification => {
    const notification: Notification = {
      ...input,
      id: `notification_${notifications.length + 1}`,
      read: false,
      createdAt: new Date(currentTime).toISOString(),
    };
    notifications.push(notification);
    return notification;
  };
  const options = { store, enqueueTask, notify, changed() {} };
  const scheduler = createScheduler(options, { clock: () => currentTime, ...adapters });
  return {
    store,
    tasks,
    notifications,
    scheduler,
    options,
    now: () => currentTime,
    advance: (milliseconds: number) => {
      currentTime += milliseconds;
    },
    add(kind: Automation['kind'], patch: Partial<Automation> = {}) {
      return store.put<Automation>('automations', {
        id: 'automation_test',
        name: 'Test rule',
        kind,
        enabled: true,
        roomId: 'room_lounge',
        botId: 'bot_aster',
        prompt: 'Report only important changes.',
        intervalMinutes: 1,
        sourceUrl: 'https://example.com/news',
        createdAt: new Date(currentTime).toISOString(),
        ...patch,
      });
    },
    complete(task: Task) {
      store.patch<Task>('tasks', task.id, { status: 'completed' });
    },
    async close() {
      await scheduler.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('interval jobs persist their next run, clamp to one minute, and coalesce active work', async () => {
  const f = fixture();
  try {
    const automation = f.add('interval', { intervalMinutes: 0 });
    await f.scheduler.run(automation.id);
    assert.equal(f.tasks.length, 1);
    assert.equal(f.tasks[0].kind, 'automation');
    assert.equal(
      Date.parse(f.store.get<Automation>('automations', automation.id)!.nextRunAt!),
      f.now() + 60_000,
    );
    f.advance(60_000);
    await f.scheduler.run(automation.id);
    assert.equal(f.tasks.length, 1, 'an active prior task must not create an unbounded backlog');
    f.complete(f.tasks[0]);
    await f.scheduler.run(automation.id);
    assert.equal(f.tasks.length, 2);
  } finally {
    await f.close();
  }
});

test('URL baseline survives a new scheduler; changes queue once and pending work preserves the cursor', async () => {
  let body = '<p>Version one</p>';
  let fetched = 0;
  const fetchText: NonNullable<SchedulerAdapters['fetchText']> = async (url) => {
    fetched++;
    return { url, status: 200, contentType: 'text/html', text: body };
  };
  const f = fixture({ fetchText });
  try {
    const automation = f.add('url_watch');
    await f.scheduler.run(automation.id);
    assert.equal(f.tasks.length, 0, 'the first fetch establishes a baseline');
    const restarted = createScheduler(f.options, { fetchText });
    await restarted.run(automation.id);
    assert.equal(f.tasks.length, 0, 'a new scheduler reads the persisted hash');
    body = '<p>Version two</p>';
    await restarted.run(automation.id);
    assert.equal(f.tasks.length, 1);
    assert.match(f.tasks[0].prompt, /Version two/);
    body = '<p>Version three</p>';
    const before = fetched;
    await restarted.run(automation.id);
    assert.equal(fetched, before, 'do not consume an event while the previous task is active');
    f.complete(f.tasks[0]);
    await restarted.run(automation.id);
    assert.equal(f.tasks.length, 2);
    assert.match(f.tasks[1].prompt, /Version three/);
    await restarted.stop();
  } finally {
    await f.close();
  }
});

test('network permission blocks unattended polling and repeated errors do not flood notifications', async () => {
  let fetched = 0;
  const f = fixture({
    fetchText: async (url) => {
      fetched++;
      return { url, status: 200, contentType: 'text/plain', text: 'x' };
    },
  });
  try {
    const automation = f.add('url_watch');
    const settings = f.store.settings();
    f.store.put('settings', {
      ...settings,
      id: 'main',
      permissions: { ...settings.permissions, network: 'ask' },
    });
    await assert.rejects(f.scheduler.run(automation.id), /network permission/);
    await assert.rejects(f.scheduler.run(automation.id), /network permission/);
    assert.equal(fetched, 0);
    assert.equal(f.notifications.length, 1);
    assert.match(f.store.get<Automation>('automations', automation.id)!.lastError!, /Allow/);
    f.store.put('settings', {
      ...settings,
      id: 'main',
      permissions: { ...settings.permissions, network: 'auto' },
    });
    await f.scheduler.run(automation.id);
    assert.equal(fetched, 1);
    assert.equal(f.store.get<Automation>('automations', automation.id)!.lastError, undefined);
    f.store.put('settings', {
      ...settings,
      id: 'main',
      permissions: { ...settings.permissions, network: 'deny' },
    });
    await assert.rejects(f.scheduler.run(automation.id), /network permission/);
    assert.equal(fetched, 1);
    f.store.put('settings', { ...settings, id: 'main' });
    await f.scheduler.run(automation.id);
    assert.equal(fetched, 2);
  } finally {
    await f.close();
  }
});

test('webhooks deduplicate IDs and persist a bounded batch while a task is active', async () => {
  const f = fixture();
  try {
    const automation = f.add('webhook');
    const first = f.scheduler.deliverWebhook(automation.id, {
      text: 'First event',
      eventId: 'delivery-1',
    });
    assert.ok(first);
    assert.equal(
      f.scheduler.deliverWebhook(automation.id, { text: 'Retry', eventId: 'delivery-1' }),
      undefined,
    );
    for (let index = 2; index <= 22; index++) {
      assert.equal(
        f.scheduler.deliverWebhook(automation.id, {
          text: `Event body ${index}`,
          eventId: `delivery-${index}`,
        }),
        undefined,
      );
    }
    assert.equal(f.tasks.length, 1);
    const saved = f.store.get<{ pendingWebhooks: unknown[]; coalescedWebhookCount: number }>(
      'automationState',
      automation.id,
    )!;
    assert.equal(saved.pendingWebhooks.length, 20);
    assert.equal(saved.coalescedWebhookCount, 1);
    f.complete(first);
    const restarted = createScheduler(f.options);
    await restarted.run(automation.id);
    assert.equal(f.tasks.length, 2);
    assert.match(f.tasks[1].prompt, /Event body 22/);
    assert.match(f.tasks[1].prompt, /1 older event/);
    assert.doesNotMatch(f.tasks[1].prompt, /Event body 2\n/);
    assert.equal(
      restarted.deliverWebhook(automation.id, { text: 'Another retry', eventId: 'delivery-22' }),
      undefined,
    );
    await restarted.stop();
  } finally {
    await f.close();
  }
});

test('IMAP is read-only, baselines old mail, fetches at most 20 new envelopes, and handles UIDVALIDITY', async () => {
  let uidNext = 11;
  let uidValidity = 7n;
  const batches: number[][] = [];
  const selections: unknown[] = [];
  const queries: unknown[] = [];
  const client: SchedulerMailClient = {
    async connect() {},
    async mailboxOpen(path, options) {
      selections.push({ path, options });
      return { uidNext, uidValidity };
    },
    async search(query) {
      const [start, end] = String(query.uid).split(':').map(Number);
      return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    },
    async fetchAll(uids, query) {
      batches.push(uids);
      queries.push(query);
      return uids.map((uid) => ({
        seq: uid,
        uid,
        envelope: { subject: `Subject ${uid}`, from: [{ address: 'sender@example.test' }] },
      }));
    },
    async logout() {},
    close() {},
    on() {},
  };
  const f = fixture({
    createMailClient(config) {
      assert.equal(config.logger, false);
      assert.equal(config.auth?.pass, 'synthetic-test-password');
      return client;
    },
  });
  try {
    const automation = f.add('imap', {
      imap: {
        host: 'mail.example.test',
        port: 993,
        secure: true,
        user: 'test@example.test',
        mailbox: 'INBOX',
        passwordConfigured: true,
      },
    });
    f.store.setSecret(`imap.${automation.id}.password`, 'synthetic-test-password');
    await f.scheduler.run(automation.id);
    assert.equal(f.tasks.length, 0);
    assert.equal(batches.length, 0);
    uidNext = 36;
    await f.scheduler.run(automation.id);
    assert.equal(f.tasks.length, 1);
    assert.equal(batches[0].length, 20);
    assert.deepEqual(
      batches[0],
      Array.from({ length: 20 }, (_, index) => index + 11),
    );
    assert.deepEqual(queries[0], { uid: true, envelope: true, internalDate: true });
    assert.match(f.tasks[0].prompt, /Bodies and attachments were not fetched/);
    await f.scheduler.run(automation.id);
    assert.equal(batches.length, 2, 'new envelopes are collected while the model is busy');
    assert.equal(f.tasks.length, 1, 'only one inference task is active for this watcher');
    assert.equal(
      f.store.get<{ pendingMail: unknown[] }>('automationState', automation.id)!.pendingMail.length,
      5,
    );
    f.complete(f.tasks[0]);
    await f.scheduler.run(automation.id);
    assert.deepEqual(batches[1], [31, 32, 33, 34, 35]);
    assert.equal(f.tasks.length, 2);
    f.complete(f.tasks[1]);
    uidValidity = 8n;
    uidNext = 100;
    await f.scheduler.run(automation.id);
    assert.equal(f.tasks.length, 2, 'a changed UID namespace must not replay existing mail');
    assert.match(f.notifications[0].title, /baseline reset/);
    assert.ok(
      selections.every(
        (selection) => (selection as { options: { readOnly: boolean } }).options.readOnly,
      ),
    );
    assert.equal(f.store.get<{ lastUid: number }>('automationState', automation.id)!.lastUid, 99);
  } finally {
    await f.close();
  }
});

test('Gmail polling redacts both stored and normalized legacy app passwords from errors and notifications', async () => {
  const password = 'abcd efgh ijkl mnop';
  const normalized = 'abcdefghijklmnop';
  const expected = 'Synthetic IMAP failure [redacted] / [redacted]';
  const f = fixture({
    createMailClient(config) {
      assert.equal(config.auth?.pass, normalized);
      return {
        async connect() {
          throw new Error(`Synthetic IMAP failure ${password} / ${config.auth?.pass}`);
        },
        async mailboxOpen() {
          throw new Error('Authentication failed before opening a mailbox.');
        },
        async search() {
          return [];
        },
        async fetchAll() {
          return [];
        },
        async logout() {},
        close() {},
        on() {},
      };
    },
  });
  try {
    const automation = f.add('imap', {
      imap: {
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        user: 'test@example.test',
        mailbox: 'INBOX',
        passwordConfigured: true,
      },
    });
    f.store.setSecret(`imap.${automation.id}.password`, password);
    await assert.rejects(f.scheduler.run(automation.id), { message: expected });
    assert.equal(f.store.get<Automation>('automations', automation.id)!.lastError, expected);
    assert.equal(f.notifications.length, 1);
    assert.equal(f.notifications[0].body, expected);
    assert.equal(f.tasks.length, 0);
  } finally {
    await f.close();
  }
});

test('overlapping polls share a job, and shutdown aborts the transport without reporting an error', async () => {
  let fetched = 0;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    fetchText: async (_url, options) => {
      fetched++;
      entered();
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted for test')), {
          once: true,
        }),
      );
    },
  });
  try {
    const automation = f.add('url_watch');
    const one = f.scheduler.run(automation.id);
    const two = f.scheduler.run(automation.id);
    assert.equal(one, two);
    const rejected = assert.rejects(one, /aborted/);
    await ready;
    await f.scheduler.stop();
    await rejected;
    assert.equal(fetched, 1);
    assert.equal(f.notifications.length, 0);
    assert.equal(f.store.get<Automation>('automations', automation.id)!.lastError, undefined);
  } finally {
    await f.close();
  }
});
