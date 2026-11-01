import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.js';
import {
  MailService,
  MailAccountError,
  mailAccountSecretKey,
  type MailProviderAdapter,
  type MailProviderContext,
} from '../src/server/mail-accounts.js';
import type { MailAccountInput, MailDraft, MailDraftInput } from '../src/shared/mail-accounts.js';

const accountInput = (overrides: Partial<MailAccountInput> = {}): MailAccountInput => ({
  provider: 'imap',
  name: 'Research mailbox',
  address: 'research@example.test',
  botIds: ['bot_aster'],
  sendPolicy: 'ask',
  imap: {
    host: 'imap.example.test',
    port: 993,
    secure: true,
    user: 'research@example.test',
    mailbox: 'INBOX',
    password: 'fake-imap-secret',
  },
  smtp: {
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    user: 'research@example.test',
    password: 'fake-smtp-secret',
  },
  ...overrides,
});
const apiInput = (overrides: Partial<MailAccountInput> = {}): MailAccountInput => ({
  provider: 'agentmail',
  name: 'API inbox',
  address: 'research@example.test',
  botIds: ['bot_aster'],
  sendPolicy: 'ask',
  api: { inboxId: 'existing-inbox', apiKey: 'fake-provider-secret' },
  ...overrides,
});
const draftInput = (
  accountId: string,
  overrides: Partial<MailDraftInput> = {},
): MailDraftInput => ({
  accountId,
  to: ['owner@example.test'],
  subject: 'Review update',
  text: 'The requested update.',
  ...overrides,
});

function fixture(t: TestContext, overrides: Partial<MailProviderAdapter> = {}, timeoutMs = 200) {
  const directory = mkdtempSync(join(tmpdir(), 'loom-mail-accounts-'));
  const store = new Store(directory);
  store.seed();
  const calls: { action: string; context: MailProviderContext; draft?: MailDraft }[] = [];
  const provider: MailProviderAdapter = {
    async test(context) {
      calls.push({ action: 'test', context });
      if (
        !(context.account.provider === 'imap'
          ? context.secrets.imapPassword
          : context.secrets.apiKey)
      )
        throw new MailAccountError('credentials_required', true);
      return { send: true };
    },
    async list(context) {
      calls.push({ action: 'list', context });
      return { messages: [] };
    },
    async read(context) {
      calls.push({ action: 'read', context });
      throw new MailAccountError('not_found', true);
    },
    async send(context, draft) {
      context.beforeSend();
      calls.push({ action: 'send', context, draft });
      return { messageId: '<accepted@example.test>' };
    },
    async poll(context) {
      calls.push({ action: 'poll', context });
      return { messages: [], cursor: 'fixture-cursor', baseline: false };
    },
    ...overrides,
  };
  const adapters = {
    timeoutMs,
    providers: { imap: provider, agentmail: provider, resend: provider },
  };
  const service = new MailService(store, undefined, adapters);
  t.after(async () => {
    await service.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { service, store, calls, provider, adapters };
}

test('mail credentials are encrypted and never serialized in public metadata', (t) => {
  const { service, store } = fixture(t);
  const account = service.save(accountInput());
  assert.equal(account.imap?.passwordConfigured, true);
  assert.equal(account.smtp?.passwordConfigured, true);
  assert.equal(store.secret(mailAccountSecretKey(account.id, 'imap')), 'fake-imap-secret');
  assert.equal(store.secret(mailAccountSecretKey(account.id, 'smtp')), 'fake-smtp-secret');
  for (const output of [
    account,
    service.list(),
    store.db.prepare('SELECT data FROM objects WHERE kind=?').all('mailAccounts'),
    store.db.prepare('SELECT value FROM secrets').all(),
  ]) {
    assert.ok(!JSON.stringify(output).includes('fake-imap-secret'));
    assert.ok(!JSON.stringify(output).includes('fake-smtp-secret'));
  }
});

test('metadata edits preserve credentials and creation time; identity changes clear omitted credentials', (t) => {
  const { service, store } = fixture(t);
  const original = service.save(accountInput());
  const imap = { ...accountInput().imap!, password: undefined };
  const smtp = { ...accountInput().smtp!, password: undefined };
  const renamed = service.save(
    accountInput({ name: 'Renamed', imap, smtp, expectedRevision: original.revision }),
    original.id,
  );
  assert.equal(renamed.createdAt, original.createdAt);
  assert.equal(renamed.revision, original.revision + 1);
  assert.equal(renamed.imap?.passwordConfigured, true);
  assert.equal(renamed.smtp?.passwordConfigured, true);
  const changed = service.save(
    accountInput({
      imap: { ...imap, host: 'other.example.test' },
      smtp,
      expectedRevision: renamed.revision,
    }),
    original.id,
  );
  assert.equal(changed.imap?.passwordConfigured, false);
  assert.equal(changed.smtp?.passwordConfigured, true);
  assert.equal(store.secret(mailAccountSecretKey(original.id, 'imap')), '');
  const newAddress = service.save(
    accountInput({ address: 'other@example.test', imap, smtp, expectedRevision: changed.revision }),
    original.id,
  );
  assert.equal(newAddress.imap?.passwordConfigured, false);
  assert.equal(newAddress.smtp?.passwordConfigured, false);
});

test('SMTP never reuses an IMAP password; inbox/provider edits never forward API keys', (t) => {
  const { service, store } = fixture(t);
  const separate = service.save(
    accountInput({ smtp: { ...accountInput().smtp!, password: undefined } }),
  );
  assert.equal(separate.smtp?.passwordConfigured, false);
  let api = service.save(apiInput());
  api = service.save(
    apiInput({ api: { inboxId: 'other-inbox' }, expectedRevision: api.revision }),
    api.id,
  );
  assert.equal(api.api?.apiKeyConfigured, false);
  api = service.save(apiInput({ expectedRevision: api.revision }), api.id);
  api = service.save(
    apiInput({
      provider: 'resend',
      api: { inboxId: 'existing-inbox' },
      expectedRevision: api.revision,
    }),
    api.id,
  );
  assert.equal(store.secret(mailAccountSecretKey(api.id, 'api')), '');
});

test('unsaved tests scope credentials to the unchanged identity and never persist test credentials', async (t) => {
  const { service, store, calls } = fixture(t);
  const account = service.save(accountInput());
  await service.test(
    accountInput({ imap: { ...accountInput().imap!, password: undefined } }),
    account.id,
  );
  assert.equal(calls[0].context.secrets.imapPassword, 'fake-imap-secret');
  await assert.rejects(
    service.test(
      accountInput({ imap: { ...accountInput().imap!, user: 'different', password: undefined } }),
      account.id,
    ),
    { code: 'credentials_required' },
  );
  assert.equal(calls[1].context.secrets.imapPassword, '');
  await service.test(
    accountInput({ imap: { ...accountInput().imap!, password: 'temporary-test-secret' } }),
    account.id,
  );
  assert.equal(store.secret(mailAccountSecretKey(account.id, 'imap')), 'fake-imap-secret');
  assert.equal(service.get(account.id).revision, account.revision);
});

test('stale edits cannot change credentials; metadata and credential writes roll back together', (t) => {
  const { service, store } = fixture(t);
  const first = service.save(accountInput());
  const current = service.save(
    accountInput({ name: 'Current', expectedRevision: first.revision }),
    first.id,
  );
  assert.throws(
    () => service.save(accountInput({ name: 'Stale', expectedRevision: first.revision }), first.id),
    { code: 'stale_revision' },
  );
  const setSecret = store.setSecret.bind(store);
  store.setSecret = (key, value) => {
    if (key.endsWith('.smtp')) throw new Error('injected database failure');
    setSecret(key, value);
  };
  assert.throws(() =>
    service.save(
      accountInput({
        name: 'Broken',
        imap: { ...accountInput().imap!, password: 'replacement-secret' },
        expectedRevision: current.revision,
      }),
      first.id,
    ),
  );
  store.setSecret = setSecret;
  assert.equal(service.get(first.id).name, 'Current');
  assert.equal(store.secret(mailAccountSecretKey(first.id, 'imap')), 'fake-imap-secret');
});

test('assignment, bot/account enabled state and network denial are enforced before transport', async (t) => {
  const { service, store, calls } = fixture(t);
  let account = service.save(accountInput());
  await assert.rejects(service.listMessages(account.id, {}, undefined, 'bot_nova'), {
    code: 'account_unassigned',
  });
  store.patch('bots', 'bot_aster', { enabled: false });
  await assert.rejects(service.listMessages(account.id, {}, undefined, 'bot_aster'), {
    code: 'account_unassigned',
  });
  account = service.save(
    accountInput({ enabled: false, expectedRevision: account.revision }),
    account.id,
  );
  await assert.rejects(service.listMessages(account.id), { code: 'account_disabled' });
  const settings = store.settings();
  store.put('settings', {
    ...settings,
    id: 'main',
    permissions: { ...settings.permissions, network: 'deny' },
  });
  await assert.rejects(service.test(accountInput()), { code: 'network_denied' });
  assert.equal(calls.length, 0);
});

test('drafts pin the sender, reject header injection and file inputs, and retain explicit recipients', (t) => {
  const { service } = fixture(t);
  const account = service.save(accountInput());
  for (const bad of [
    { subject: 'Hi\r\nBcc: hidden@example.test' },
    { to: ['owner@example.test\r\nBcc: hidden@example.test'] },
    { to: ['Owner <owner@example.test>'] },
    { from: 'spoof@example.test' },
    { attachments: [{ path: '/private/file' }] },
  ])
    assert.throws(
      () => service.saveDraft({ ...draftInput(account.id), ...bad } as MailDraftInput),
      { code: 'invalid_request' },
    );
  const draft = service.saveDraft(
    draftInput(account.id, {
      cc: ['reviewer@example.test'],
      bcc: ['audit@example.test'],
      text: 'First line\nSecond line',
    }),
    undefined,
    'bot_aster',
  );
  assert.equal(draft.from, account.address);
  assert.equal(draft.accountRevision, account.revision);
  assert.deepEqual(draft.bcc, ['audit@example.test']);
  assert.equal(draft.status, 'draft');
});

test('account/draft changes invalidate previously reviewed send intent', async (t) => {
  const { service, calls } = fixture(t);
  const account = service.save(accountInput());
  const first = service.saveDraft(draftInput(account.id));
  const edited = service.saveDraft(
    draftInput(account.id, { subject: 'Changed', expectedRevision: first.revision }),
    first.id,
  );
  await assert.rejects(
    service.sendDraft(first.id, { requestId: randomUUID(), expectedRevision: first.revision }),
    { code: 'stale_revision' },
  );
  service.save(
    accountInput({ sendPolicy: 'allow', expectedRevision: account.revision }),
    account.id,
  );
  await assert.rejects(
    service.sendDraft(edited.id, { requestId: randomUUID(), expectedRevision: edited.revision }),
    { code: 'stale_revision' },
  );
  assert.equal(calls.length, 0);
});

test('send receipt replays without transport, survives service restart and binds UUID to one draft', async (t) => {
  const { service, store, calls, adapters } = fixture(t);
  const account = service.save(accountInput());
  const draft = service.saveDraft(draftInput(account.id), undefined, 'bot_aster');
  const options = {
    requestId: randomUUID(),
    expectedRevision: draft.revision,
    expectedAccountRevision: draft.accountRevision,
    botId: 'bot_aster',
  };
  const sent = await service.sendDraft(draft.id, options);
  assert.equal(sent.status, 'sent');
  assert.equal(calls[0].draft?.from, account.address);
  await service.shutdown();
  const restarted = new MailService(store, undefined, adapters);
  t.after(() => restarted.shutdown());
  assert.deepEqual(await restarted.sendDraft(draft.id, options), sent);
  assert.equal(calls.filter((call) => call.action === 'send').length, 1);
  const second = restarted.saveDraft(draftInput(account.id));
  await assert.rejects(restarted.sendDraft(second.id, { ...options, botId: undefined }), {
    code: 'invalid_request',
  });
});

test('uncertain acceptance is terminal across retries and never exposes provider diagnostics', async (t) => {
  let sends = 0;
  const { service } = fixture(t, {
    async send(context) {
      context.beforeSend();
      sends++;
      throw new Error('provider diagnostic fake-secret-private-body');
    },
  });
  const account = service.save(accountInput());
  const draft = service.saveDraft(draftInput(account.id));
  const options = { requestId: randomUUID(), expectedRevision: draft.revision };
  const result = await service.sendDraft(draft.id, options);
  assert.equal(result.status, 'unknown');
  assert.ok(!JSON.stringify(result).includes('fake-secret-private-body'));
  assert.equal((await service.sendDraft(draft.id, options)).status, 'unknown');
  await assert.rejects(service.sendDraft(draft.id, { ...options, requestId: randomUUID() }), {
    code: 'stale_revision',
  });
  assert.throws(
    () =>
      service.saveDraft(draftInput(account.id, { expectedRevision: result.revision }), draft.id),
    { code: 'stale_revision' },
  );
  assert.equal(sends, 1);
});

test('timeouts cancel transport and cannot let a late completion rewrite the unknown receipt', async (t) => {
  let resolve!: (value: { messageId: string }) => void;
  let abortSeen = false;
  const { service } = fixture(
    t,
    {
      async send(context) {
        context.beforeSend();
        context.signal.addEventListener('abort', () => {
          abortSeen = true;
        });
        return new Promise((done) => {
          resolve = done;
        });
      },
    },
    15,
  );
  const account = service.save(accountInput());
  const draft = service.saveDraft(draftInput(account.id));
  const result = await service.sendDraft(draft.id, {
    requestId: randomUUID(),
    expectedRevision: draft.revision,
  });
  assert.equal(result.status, 'unknown');
  assert.equal(abortSeen, true);
  resolve({ messageId: '<late@example.test>' });
  await new Promise((done) => setImmediate(done));
  assert.equal(service.getDraft(draft.id).status, 'unknown');
});

test('preflight failure does not claim a send, while concurrent send requests dispatch once', async (t) => {
  let release!: (value: { messageId: string }) => void;
  let sends = 0;
  const { service, provider } = fixture(t, {
    async send(context) {
      context.beforeSend();
      sends++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const account = service.save(accountInput());
  const draft = service.saveDraft(draftInput(account.id));
  const options = { requestId: randomUUID(), expectedRevision: draft.revision };
  const pending = service.sendDraft(draft.id, options);
  await assert.rejects(service.sendDraft(draft.id, options), { code: 'busy' });
  release({ messageId: '<one@example.test>' });
  assert.equal((await pending).status, 'sent');
  assert.equal(sends, 1);
  provider.send = async () => {
    throw new MailAccountError('credentials_required', true);
  };
  const next = service.saveDraft(draftInput(account.id));
  assert.equal(
    (await service.sendDraft(next.id, { requestId: randomUUID(), expectedRevision: next.revision }))
      .status,
    'failed',
  );
});

test('restart converts an interrupted sending journal to unknown and disconnect preserves the audit', async (t) => {
  const { service, store, adapters } = fixture(t);
  const account = service.save(accountInput());
  const draft = service.saveDraft(draftInput(account.id));
  const requestId = randomUUID();
  store.patch('mailDrafts', draft.id, { status: 'sending', requestId });
  store.put('mailSends', {
    id: requestId,
    draftId: draft.id,
    draftRevision: draft.revision,
    accountRevision: account.revision,
    status: 'sending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await service.shutdown();
  const restarted = new MailService(store, undefined, adapters);
  t.after(() => restarted.shutdown());
  assert.equal(restarted.getDraft(draft.id).status, 'unknown');
  assert.equal(
    (await restarted.sendDraft(draft.id, { requestId, expectedRevision: draft.revision })).status,
    'unknown',
  );
  restarted.remove(account.id, account.revision);
  assert.equal(store.secret(mailAccountSecretKey(account.id, 'imap')), '');
  assert.equal(restarted.getDraft(draft.id).status, 'unknown');
  assert.ok(store.get('mailSends', requestId));
});

test('limits reject unbounded search/poll requests before network activity', async (t) => {
  const { service, calls } = fixture(t);
  const account = service.save(accountInput());
  await assert.rejects(service.listMessages(account.id, { limit: 51 }), {
    code: 'invalid_request',
  });
  await assert.rejects(service.listMessages(account.id, { query: 'x'.repeat(257) }), {
    code: 'invalid_request',
  });
  await assert.rejects(service.poll(account.id, undefined, undefined, { limit: 21 }), {
    code: 'invalid_request',
  });
  assert.equal(calls.length, 0);
});
