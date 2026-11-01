import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { migrateLegacyMailAccounts } from '../src/server/mail-account-migration.js';
import { mailAccountSecretKey } from '../src/server/mail-accounts.js';
import type { Automation } from '../src/shared/types.js';
import type { MailAccount } from '../src/shared/mail-accounts.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-mail-migrate-'));
  const store = new Store(directory);
  store.seed();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

function watcher(id: string, overrides: Partial<Automation> = {}): Automation {
  return {
    id,
    name: `Mail ${id}`,
    kind: 'imap',
    enabled: true,
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Notify me when a reply arrives.',
    intervalMinutes: 2,
    sourceUrl: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    imap: {
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      user: 'bot@example.test',
      mailbox: 'INBOX',
      passwordConfigured: true,
    },
    ...overrides,
  };
}

function seed(store: Store, rule: Automation, password = 'abcd efgh ijkl mnop') {
  store.put('automations', rule);
  store.setSecret(`imap.${rule.id}.password`, password);
}

test('legacy watchers share one read-only connection without moving or exposing credentials', async (t) => {
  const store = await fixture(t);
  seed(store, watcher('rule_one'));
  seed(store, watcher('rule_two', { botId: 'bot_nova' }));
  assert.equal(migrateLegacyMailAccounts(store), 2);
  const accounts = store.list<MailAccount>('mailAccounts');
  assert.equal(accounts.length, 1);
  const account = accounts[0];
  assert.deepEqual(new Set(account.botIds), new Set(['bot_aster', 'bot_nova']));
  assert.equal(account.provider, 'imap');
  assert.equal(account.smtp, undefined);
  assert.equal(account.sendPolicy, 'ask');
  assert.equal(account.createdAt, '2026-10-01T00:00:00.000Z');
  assert.equal(store.secret(mailAccountSecretKey(account.id, 'imap')), 'abcdefghijklmnop');
  assert.equal(store.secret('imap.rule_one.password'), 'abcd efgh ijkl mnop');
  assert.ok(!JSON.stringify(accounts).includes('abcdefghijklmnop'));
  for (const rule of store.list<Automation>('automations')) {
    assert.equal(rule.mailAccountId, account.id);
    assert.equal(rule.imap?.host, 'imap.gmail.com');
  }
});

test('migration preserves matching UID baselines, pending work, and restart idempotency', async (t) => {
  const store = await fixture(t);
  const rule = watcher('rule_cursor');
  seed(store, rule);
  const sourceIdentity = createHash('sha256')
    .update(JSON.stringify(['imap', rule.imap!.host, 993, true, rule.imap!.user, 'INBOX']))
    .digest('hex');
  store.put('automationState', {
    id: rule.id,
    sourceIdentity,
    uidValidity: '123',
    lastUid: 80,
    lastTaskId: 'existing_task',
    pendingMail: [{ id: 'pending' }],
  });
  assert.equal(migrateLegacyMailAccounts(store), 1);
  const account = store.list<MailAccount>('mailAccounts')[0];
  const state = store.get<Record<string, unknown>>('automationState', rule.id)!;
  assert.equal(state.legacyMailAccountId, account.id);
  assert.equal(state.lastUid, 80);
  assert.equal(state.lastTaskId, 'existing_task');
  assert.deepEqual(state.pendingMail, [{ id: 'pending' }]);
  assert.equal(migrateLegacyMailAccounts(store), 0);
  assert.equal(store.list<MailAccount>('mailAccounts')[0].revision, 1);
  assert.deepEqual(store.get('automationState', rule.id), state);
});

test('a cursor belonging to an old server is not marked for reuse', async (t) => {
  const store = await fixture(t);
  const rule = watcher('rule_stale');
  seed(store, rule);
  store.put('automationState', {
    id: rule.id,
    sourceIdentity: 'different-source',
    uidValidity: '123',
    lastUid: 80,
  });
  migrateLegacyMailAccounts(store);
  assert.equal(
    store.get<Record<string, unknown>>('automationState', rule.id)!.legacyMailAccountId,
    undefined,
  );
});

test('different legacy credentials remain separate while account IDs do not derive from passwords', async (t) => {
  const store = await fixture(t);
  seed(store, watcher('rule_a'), 'first-secret');
  seed(store, watcher('rule_b'), 'second-secret');
  migrateLegacyMailAccounts(store);
  const accounts = store.list<MailAccount>('mailAccounts');
  assert.equal(accounts.length, 2);
  for (const ruleId of ['rule_a', 'rule_b']) {
    const expected = `mail_legacy_${createHash('sha256').update(ruleId).digest('hex').slice(0, 20)}`;
    assert.equal(store.get<Automation>('automations', ruleId)!.mailAccountId, expected);
  }
});

test('non-email usernames keep the legacy connection and missing credentials create disabled connections', async (t) => {
  const store = await fixture(t);
  const old = watcher('rule_login');
  seed(store, { ...old, imap: { ...old.imap!, user: 'local-user' } });
  seed(store, watcher('rule_empty', { enabled: false }), '');
  assert.equal(migrateLegacyMailAccounts(store), 1);
  assert.equal(store.get<Automation>('automations', old.id)!.mailAccountId, undefined);
  assert.equal(store.secret(`imap.${old.id}.password`), 'abcd efgh ijkl mnop');
  const account = store.list<MailAccount>('mailAccounts')[0];
  assert.equal(account.enabled, false);
  assert.equal(account.imap!.passwordConfigured, false);
});

test('a later legacy watcher joins the same account without resurrecting a removed bot', async (t) => {
  const store = await fixture(t);
  seed(store, watcher('rule_first'));
  migrateLegacyMailAccounts(store);
  const first = store.list<MailAccount>('mailAccounts')[0];
  seed(store, watcher('rule_later', { botId: 'deleted_bot' }));
  assert.equal(migrateLegacyMailAccounts(store), 1);
  const accounts = store.list<MailAccount>('mailAccounts');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, first.id);
  assert.deepEqual(accounts[0].botIds, ['bot_aster']);
  assert.equal(store.get<Automation>('automations', 'rule_later')!.mailAccountId, first.id);
});

test('reconfiguring a migrated rule back to inline mail cannot overwrite its old connected account', async (t) => {
  const store = await fixture(t);
  const original = watcher('rule_reconfigured');
  seed(store, original, 'original-password');
  migrateLegacyMailAccounts(store);
  const first = store.list<MailAccount>('mailAccounts')[0];
  seed(
    store,
    { ...original, imap: { ...original.imap!, user: 'other@example.test' } },
    'new-password',
  );
  assert.equal(migrateLegacyMailAccounts(store), 1);
  const secondId = store.get<Automation>('automations', original.id)!.mailAccountId!;
  assert.notEqual(secondId, first.id);
  assert.equal(store.list<MailAccount>('mailAccounts').length, 2);
  assert.deepEqual(store.get<MailAccount>('mailAccounts', first.id), first);
  assert.equal(store.secret(mailAccountSecretKey(first.id, 'imap')), 'original-password');
  assert.equal(store.secret(mailAccountSecretKey(secondId, 'imap')), 'new-password');
  assert.equal(migrateLegacyMailAccounts(store), 0);
});
