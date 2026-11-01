import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server/app.js';
import type { MailProviderAdapter } from '../src/server/mail-accounts.js';
import type { MailAccount, MailAccountInput, MailDraft } from '../src/shared/mail-accounts.js';
import type { ServiceAccount } from '../src/shared/service-accounts.js';
import type { Automation, Snapshot } from '../src/shared/types.js';

const input = (overrides: Partial<MailAccountInput> = {}): MailAccountInput => ({
  name: 'Bot mail',
  address: 'bot@example.test',
  provider: 'imap',
  enabled: true,
  botIds: ['bot_aster'],
  sendPolicy: 'ask',
  imap: {
    host: 'imap.example.test',
    port: 993,
    secure: true,
    user: 'bot@example.test',
    mailbox: 'INBOX',
    password: 'fixture-imap-secret',
  },
  smtp: {
    host: 'smtp.example.test',
    port: 465,
    secure: true,
    user: 'bot@example.test',
    password: 'fixture-smtp-secret',
  },
  ...overrides,
});

async function fixture(t: TestContext, apiToken?: string) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-account-routes-'));
  const calls = { test: 0, list: 0, send: 0, failAfterSend: false };
  const provider: MailProviderAdapter = {
    async test(context) {
      context.check();
      calls.test++;
      return { send: true };
    },
    async list(context) {
      context.check();
      calls.list++;
      return { messages: [] };
    },
    async read() {
      throw new Error('diagnostic fixture-imap-secret must never appear');
    },
    async send(context) {
      context.beforeSend();
      calls.send++;
      if (calls.failAfterSend) throw new Error('connection lost fixture-smtp-secret');
      return { messageId: '<accepted@example.test>' };
    },
    async poll(context) {
      context.check();
      return { messages: [], cursor: 'fixture_cursor', baseline: true };
    },
  };
  const context = await createApp({
    dataDir,
    scheduler: false,
    apiToken,
    mailAccountAdapters: { providers: { imap: provider } },
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  t.after(async () => {
    await context.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    context.app.inject({
      method,
      url,
      payload: payload as object,
      headers: { host: 'localhost', ...headers },
    });
  const create = async () => {
    const result = await call('POST', '/api/mail/accounts', input());
    assert.equal(result.statusCode, 200, result.body);
    return result.json<MailAccount>();
  };
  return { ...context, call, calls, create };
}

function rule(accountId: string): Automation {
  return {
    id: 'rule_mail',
    name: 'Notify on mail',
    kind: 'imap',
    enabled: true,
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Notify me about relevant messages.',
    intervalMinutes: 2,
    sourceUrl: '',
    mailAccountId: accountId,
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

test('network denial stops transports but still permits local account management', async (t) => {
  const { call, calls, create } = await fixture(t);
  const account = await create();
  assert.equal(
    (await call('PUT', '/api/settings', { permissions: { network: 'deny' } })).statusCode,
    200,
  );
  assert.equal((await call('GET', '/api/mail/accounts')).statusCode, 200);
  for (const response of [
    await call('GET', `/api/mail/accounts/${account.id}/messages`),
    await call('POST', '/api/mail/accounts/test', { input: input() }),
  ]) {
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'network_denied');
  }
  assert.equal(calls.list + calls.test, 0);
});

test('renaming preserves checkpoints; retargeting clears them and unassignment pauses the watcher', async (t) => {
  const { call, create, store } = await fixture(t);
  let account = await create();
  store.put('automations', rule(account.id));
  store.put('automationState', {
    id: 'rule_mail',
    sourceIdentity: 'old_identity',
    mailCursor: 'old_cursor',
    lastTaskId: 'still_running',
    lastUid: 10,
    uidValidity: '8',
    pendingMail: [{ id: 'mail_old' }],
    coalescedMailCount: 3,
  });
  const renamed = await call(
    'PUT',
    `/api/mail/accounts/${account.id}`,
    input({ name: 'Renamed', expectedRevision: account.revision }),
  );
  assert.equal(renamed.statusCode, 200, renamed.body);
  account = renamed.json<MailAccount>();
  assert.equal(
    store.get<Record<string, unknown>>('automationState', 'rule_mail')!.mailCursor,
    'old_cursor',
  );
  const changed = await call(
    'PUT',
    `/api/mail/accounts/${account.id}`,
    input({
      expectedRevision: account.revision,
      imap: { ...input().imap!, host: 'new.example.test', password: undefined },
      botIds: [],
    }),
  );
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json<MailAccount>().imap!.passwordConfigured, false);
  const state = store.get<Record<string, unknown>>('automationState', 'rule_mail')!;
  for (const field of ['mailCursor', 'lastUid', 'uidValidity', 'pendingMail', 'coalescedMailCount'])
    assert.equal(state[field], undefined);
  assert.equal(state.lastTaskId, 'still_running');
  assert.ok(typeof state.mailSince === 'string' && Number.isFinite(Date.parse(state.mailSince)));
  assert.equal(store.get<Automation>('automations', 'rule_mail')!.enabled, false);
  assert.equal(
    (
      await call(
        'PUT',
        `/api/mail/accounts/${account.id}`,
        input({ expectedRevision: account.revision }),
      )
    ).statusCode,
    409,
  );
});

test('reviewed sends survive repeated HTTP requests and uncertain delivery is never retried', async (t) => {
  const { call, calls, create } = await fixture(t);
  const account = await create();
  const newDraft = async () => {
    const result = await call('POST', '/api/mail/drafts', {
      accountId: account.id,
      to: ['recipient@example.test'],
      subject: 'Reviewed subject',
      text: 'Reviewed content',
    });
    assert.equal(result.statusCode, 200, result.body);
    return result.json<MailDraft>();
  };
  const draft = await newDraft();
  const request = {
    requestId: randomUUID(),
    expectedRevision: draft.revision,
    expectedAccountRevision: account.revision,
  };
  assert.equal(
    (await call('POST', `/api/mail/drafts/${draft.id}/send`, request)).json<MailDraft>().status,
    'sent',
  );
  assert.equal(
    (await call('POST', `/api/mail/drafts/${draft.id}/send`, request)).json<MailDraft>().status,
    'sent',
  );
  assert.equal(calls.send, 1);
  const uncertain = await newDraft();
  assert.equal(
    (await call('POST', `/api/mail/drafts/${uncertain.id}/send`, request)).statusCode,
    400,
  );
  calls.failAfterSend = true;
  const attempt = { ...request, requestId: randomUUID() };
  const unknown = await call('POST', `/api/mail/drafts/${uncertain.id}/send`, attempt);
  assert.equal(unknown.json<MailDraft>().status, 'unknown');
  assert.ok(!unknown.body.includes('fixture-smtp-secret'));
  assert.equal(
    (await call('POST', `/api/mail/drafts/${uncertain.id}/send`, attempt)).json<MailDraft>().status,
    'unknown',
  );
  assert.equal(
    (
      await call('POST', `/api/mail/drafts/${uncertain.id}/send`, {
        ...attempt,
        requestId: randomUUID(),
      })
    ).statusCode,
    409,
  );
  assert.equal(calls.send, 2);
});

test('deleting a bot and disconnecting mail preserve service identity and drafts without provider I/O', async (t) => {
  const { call, create, store, calls } = await fixture(t);
  const account = await create();
  const service = (
    await call('POST', '/api/service-accounts', {
      name: 'Service',
      url: 'https://service.example',
      login: account.address,
      botId: 'bot_aster',
      mailAccountId: account.id,
      status: 'active',
      notes: '',
      credential: 'retained-service-secret',
    })
  ).json<ServiceAccount>();
  const draft = (
    await call('POST', '/api/mail/drafts', {
      accountId: account.id,
      to: ['recipient@example.test'],
      subject: '',
      text: 'Retained draft',
    })
  ).json<MailDraft>();
  const { password: _, ...connection } = input().imap!;
  store.put('automations', {
    ...rule(account.id),
    imap: { ...connection, passwordConfigured: true },
  });
  store.setSecret('imap.rule_mail.password', 'retained-legacy-transport-secret');
  assert.equal((await call('DELETE', '/api/bots/bot_aster')).statusCode, 200);
  const kept = (await call('GET', `/api/mail/accounts/${account.id}`)).json<MailAccount>();
  assert.deepEqual(kept.botIds, []);
  assert.equal(kept.imap!.passwordConfigured, true);
  let retained = (await call('GET', `/api/service-accounts/${service.id}`)).json<ServiceAccount>();
  assert.equal(retained.botId, null);
  assert.equal(retained.mailAccountId, account.id);
  assert.equal(store.get<Automation>('automations', 'rule_mail')!.enabled, false);
  assert.equal(
    (await call('DELETE', `/api/mail/accounts/${account.id}?expectedRevision=${account.revision}`))
      .statusCode,
    409,
  );
  assert.equal(
    (await call('DELETE', `/api/mail/accounts/${account.id}?expectedRevision=${kept.revision}`))
      .statusCode,
    200,
  );
  assert.equal(store.secret(`mail.${account.id}.imap`), '');
  assert.equal(store.secret(`mail.${account.id}.smtp`), '');
  assert.equal(store.secret('imap.rule_mail.password'), '');
  assert.equal(store.get<Automation>('automations', 'rule_mail')!.imap!.passwordConfigured, false);
  retained = (await call('GET', `/api/service-accounts/${service.id}`)).json<ServiceAccount>();
  assert.equal(retained.mailAccountId, null);
  assert.equal(retained.login, account.address);
  assert.equal(retained.credentialConfigured, true);
  assert.equal(
    (await call('GET', `/api/mail/drafts/${draft.id}`)).json<MailDraft>().text,
    'Retained draft',
  );
  assert.equal(
    (
      await call('POST', `/api/mail/drafts/${draft.id}/send`, {
        requestId: randomUUID(),
        expectedRevision: draft.revision,
      })
    ).statusCode,
    404,
  );
  assert.deepEqual([calls.test, calls.list, calls.send], [0, 0, 0]);
});

test('mail and service routes enforce owner authentication and same-origin mutations', async (t) => {
  const { call, calls } = await fixture(t, 'fixture-only-owner-access-token');
  for (const path of ['/api/mail/accounts', '/api/mail/drafts', '/api/service-accounts'])
    assert.equal((await call('GET', path)).statusCode, 401);
  assert.equal(
    (
      await call('POST', '/api/mail/accounts', input(), {
        authorization: 'Bearer fixture-only-owner-access-token',
        origin: 'https://other.example',
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call('POST', '/api/mail/accounts', input(), {
        authorization: 'Bearer fixture-only-owner-access-token',
      })
    ).statusCode,
    200,
  );
  assert.deepEqual([calls.test, calls.list, calls.send], [0, 0, 0]);
});

test('Gmail SMTP app passwords normalize display spacing without changing other provider passwords', async (t) => {
  const { call, store } = await fixture(t);
  for (const host of ['smtp.gmail.com', 'smtp.example.test']) {
    const response = await call(
      'POST',
      '/api/mail/accounts',
      input({ smtp: { ...input().smtp!, host, password: 'abcd efgh ijkl mnop' } }),
    );
    assert.equal(response.statusCode, 200, response.body);
    const account = response.json<MailAccount>();
    assert.equal(
      store.secret(`mail.${account.id}.smtp`),
      host === 'smtp.gmail.com' ? 'abcdefghijklmnop' : 'abcd efgh ijkl mnop',
    );
    assert.ok(!response.body.includes('abcdefghijklmnop'));
  }
});

test('connection tests do not save accounts; snapshots and errors omit transport and service secrets', async (t) => {
  const { call, calls, create, store } = await fixture(t);
  const tested = await call('POST', '/api/mail/accounts/test', { input: input() });
  assert.equal(tested.statusCode, 200, tested.body);
  assert.equal(calls.test, 1);
  assert.equal(store.list('mailAccounts').length, 0);
  const account = await create();
  const service = await call('POST', '/api/service-accounts', {
    name: 'Service',
    url: 'https://service.example/login',
    login: account.address,
    botId: 'bot_aster',
    mailAccountId: account.id,
    status: 'active',
    notes: '',
    credential: 'fixture-service-secret',
  });
  assert.equal(service.statusCode, 200, service.body);
  assert.equal(service.json().credentialConfigured, true);
  const state = await call('GET', '/api/state');
  assert.equal(state.json<Snapshot>().mailAccounts?.length, 1);
  assert.equal(state.json<Snapshot>().serviceAccounts?.length, 1);
  for (const secret of ['fixture-imap-secret', 'fixture-smtp-secret', 'fixture-service-secret'])
    assert.ok(!state.body.includes(secret));
  const error = await call('GET', `/api/mail/accounts/${account.id}/messages/message_1`);
  assert.equal(error.statusCode, 400);
  assert.equal(error.json().code, 'connection_failed');
  assert.ok(!error.body.includes('fixture-imap-secret'));
});
