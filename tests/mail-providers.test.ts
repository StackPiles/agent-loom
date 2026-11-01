import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FetchMessageObject, ImapFlowOptions, SearchObject } from 'imapflow';
import type { MailAccount, MailDraft } from '../src/shared/mail-accounts.js';
import { ImapSmtpProvider, encodeLegacyImapCursor } from '../src/server/mail-providers/imap.js';
import { AgentMailProvider } from '../src/server/mail-providers/agentmail.js';
import { ResendMailProvider } from '../src/server/mail-providers/resend.js';
import {
  MailAccountError,
  MAX_MAIL_SOURCE,
  locator,
  parseLocator,
  type MailProviderContext,
} from '../src/server/mail-providers/types.js';
import type { MailApiRequest, MailApiTransport } from '../src/server/mail-providers/http.js';

const created = '2026-10-28T12:00:00.000Z';
function account(provider: MailAccount['provider'] = 'imap'): MailAccount {
  return {
    id: 'mail_test',
    provider,
    name: 'Mailbox',
    address: 'bot@example.test',
    enabled: true,
    botIds: ['bot_aster'],
    sendPolicy: 'ask',
    revision: 1,
    createdAt: created,
    updatedAt: created,
    ...(provider === 'imap'
      ? {
          imap: {
            host: 'imap.example.test',
            port: 143,
            secure: false,
            user: 'bot@example.test',
            mailbox: 'INBOX',
            passwordConfigured: true,
          },
          smtp: {
            host: 'smtp.example.test',
            port: 587,
            secure: false,
            user: 'bot@example.test',
            passwordConfigured: true,
          },
        }
      : { api: { inboxId: 'existing-inbox', apiKeyConfigured: true } }),
  };
}
function context(value = account()): MailProviderContext & { sends: number } {
  const abort = new AbortController();
  return {
    account: value,
    signal: abort.signal,
    secrets: {
      imapPassword: 'fixture-imap',
      smtpPassword: 'fixture-smtp',
      apiKey: 'fixture-api-key',
    },
    sends: 0,
    check() {
      if (abort.signal.aborted) throw new MailAccountError('cancelled');
    },
    beforeSend() {
      this.check();
      this.sends++;
    },
  };
}
function draft(value: MailAccount): MailDraft {
  return {
    id: 'draft_test',
    accountId: value.id,
    accountRevision: value.revision,
    from: value.address,
    to: ['sender@example.test'],
    cc: [],
    bcc: ['audit@example.test'],
    subject: 'Re: Update',
    text: 'Reviewed reply',
    revision: 1,
    status: 'draft',
    createdAt: created,
    updatedAt: created,
  };
}

class ImapFixture {
  rows: FetchMessageObject[];
  uidValidity = 3n;
  uidNext = 44;
  calls: string[] = [];
  source = Buffer.from(
    'From: Sender <sender@example.test>\r\nTo: bot@example.test\r\nSubject: Update\r\nMessage-ID: <original@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello</p><script>unsafe()</script><img src="https://tracker.example/pixel">',
  );
  constructor() {
    this.rows = [40, 41, 42, 43].map((uid) => ({
      uid,
      seq: uid - 39,
      size: this.source.length,
      internalDate: new Date(uid < 42 ? '2026-10-28T11:00:00Z' : '2026-10-28T12:00:01Z'),
      envelope: {
        subject: `Update ${uid}`,
        from: [{ address: 'sender@example.test' }],
        to: [{ address: 'bot@example.test' }],
        messageId: '<original@example.test>',
        date: new Date('2000-01-01'),
      },
      flags: new Set(),
    }));
  }
  async connect() {
    this.calls.push('connect');
  }
  async mailboxOpen(path: string, options: { readOnly: boolean }) {
    assert.equal(path, 'INBOX');
    assert.equal(options.readOnly, true);
    this.calls.push('open-readonly');
    return {
      path,
      delimiter: '/',
      flags: new Set<string>(),
      uidValidity: this.uidValidity,
      uidNext: this.uidNext,
      exists: this.rows.length,
    };
  }
  on() {
    return this;
  }
  close() {
    this.calls.push('close');
  }
  async search(query: SearchObject, options?: { returnOptions?: string[] }) {
    this.calls.push('search');
    let rows = this.rows;
    if (query.since)
      rows = rows.filter(
        (row) => new Date(row.internalDate!).getTime() >= new Date(query.since!).getTime(),
      );
    if (query.uid) {
      const [from, to] = String(query.uid).split(':').map(Number);
      rows = rows.filter((row) => row.uid >= from && row.uid <= to);
    }
    if (options?.returnOptions) return { min: rows[0]?.uid };
    return rows.map((row) => row.uid);
  }
  async *fetch(uids: number[]) {
    this.calls.push(`fetch:${uids.join(',')}`);
    for (const row of this.rows) if (uids.includes(row.uid)) yield row;
  }
  async fetchOne(uid: string, query: { source?: unknown }) {
    this.calls.push(query.source ? 'source' : 'metadata');
    const row = this.rows.find((item) => item.uid === Number(uid));
    return row ? { ...row, ...(query.source ? { source: this.source } : {}) } : false;
  }
}

test('IMAP/SMTP connection tests require encrypted transport and never fetch or send mail', async () => {
  const client = new ImapFixture();
  let options: ImapFlowOptions | undefined;
  let verified = 0;
  let sent = 0;
  const provider = new ImapSmtpProvider({
    createImap(value) {
      options = value;
      return client as never;
    },
    createSmtp: () => ({
      async verify() {
        verified++;
      },
      async sendMail() {
        sent++;
        return { messageId: 'never' };
      },
      close() {},
    }),
  });
  assert.deepEqual(await provider.test(context()), { send: true });
  assert.equal(options?.doSTARTTLS, true);
  assert.equal(options?.logger, false);
  assert.equal(options?.logRaw, false);
  assert.equal(options?.maxLiteralSize, MAX_MAIL_SOURCE);
  assert.equal(verified, 1);
  assert.equal(sent, 0);
  assert.deepEqual(client.calls, ['connect', 'open-readonly', 'close']);
});

test('IMAP first poll preserves arrivals after rule creation, filters INTERNALDATE, and pages without gaps', async () => {
  const client = new ImapFixture();
  const provider = new ImapSmtpProvider({ createImap: () => client as never });
  const ctx = context();
  const first = await provider.poll(ctx, undefined, { since: created, limit: 2 });
  assert.equal(first.baseline, true);
  assert.equal(first.messages.length, 0); // day-overlap messages before creation
  assert.equal(first.hasMore, true);
  const second = await provider.poll(ctx, first.cursor, { since: created, limit: 2 });
  assert.deepEqual(
    second.messages.map((message) => message.subject),
    ['Update 42', 'Update 43'],
  );
  assert.equal(second.hasMore, false);
  assert.equal((await provider.poll(ctx, second.cursor, {})).messages.length, 0);
  const legacy = await provider.poll(ctx, encodeLegacyImapCursor('3', 41), {});
  assert.deepEqual(
    legacy.messages.map((message) => message.subject),
    ['Update 42', 'Update 43'],
  );
});

test('IMAP UIDVALIDITY reset checkpoints current history without replay and then receives new arrivals', async () => {
  const client = new ImapFixture();
  const provider = new ImapSmtpProvider({ createImap: () => client as never });
  const ctx = context();
  const initial = await provider.poll(ctx, undefined, { since: created });
  assert.equal(initial.baseline, true);
  assert.equal(initial.reset, undefined);
  assert.deepEqual(
    initial.messages.map((message) => message.subject),
    ['Update 42', 'Update 43'],
  );
  client.uidValidity = 4n;
  client.calls = [];
  const reset = await provider.poll(ctx, initial.cursor, { since: created });
  assert.equal(reset.baseline, true);
  assert.equal(reset.reset, 'uidvalidity_changed');
  assert.equal(reset.hasMore, false);
  assert.deepEqual(reset.messages, []);
  assert.equal(parseLocator(ctx.account, reset.cursor).lastUid, 43);
  assert.equal(parseLocator(ctx.account, reset.cursor).uidValidity, '4');
  assert.deepEqual(client.calls, ['connect', 'open-readonly', 'close']);
  const legacy = await provider.poll(ctx, encodeLegacyImapCursor('3', 41), { since: created });
  assert.equal(legacy.reset, 'uidvalidity_changed');
  assert.deepEqual(legacy.messages, []);
  client.rows.push({
    ...client.rows[3],
    uid: 44,
    seq: 5,
    envelope: { ...client.rows[3].envelope, subject: 'New after reset' },
  });
  client.uidNext = 45;
  const next = await provider.poll(ctx, reset.cursor, { since: created });
  assert.equal(next.baseline, false);
  assert.equal(next.reset, undefined);
  assert.deepEqual(
    next.messages.map((message) => message.subject),
    ['New after reset'],
  );
});

test('IMAP reader rejects oversized source before downloading and returns inert text for HTML', async () => {
  const client = new ImapFixture();
  const provider = new ImapSmtpProvider({ createImap: () => client as never });
  const ctx = context();
  const messages = await provider.list(ctx, { limit: 2 });
  assert.deepEqual(
    messages.messages.map((value) => value.subject),
    ['Update 43', 'Update 42'],
  );
  const read = await provider.read(ctx, messages.messages[0].id);
  assert.ok(read.text.includes('Hello'));
  assert.ok(!read.text.includes('unsafe()'));
  assert.ok(!read.text.includes('tracker.example'));
  client.calls = [];
  client.rows[3].size = MAX_MAIL_SOURCE + 1;
  await assert.rejects(provider.read(ctx, messages.messages[0].id), { code: 'message_too_large' });
  assert.ok(!client.calls.includes('source'));
  const different = context({ ...ctx.account, imap: { ...ctx.account.imap!, mailbox: 'Other' } });
  await assert.rejects(provider.read(different, messages.messages[0].id), {
    code: 'invalid_request',
  });
});

test('SMTP sends only the pinned reviewed envelope and partial acceptance is uncertain', async () => {
  const ctx = context();
  const sent: Record<string, unknown>[] = [];
  let partial = false;
  const provider = new ImapSmtpProvider({
    createSmtp: () => ({
      async verify() {},
      close() {},
      async sendMail(value) {
        sent.push(value);
        return {
          messageId: '<accepted@example.test>',
          accepted: ['sender@example.test'],
          rejected: partial ? ['audit@example.test'] : [],
        };
      },
    }),
  });
  const payload = draft(ctx.account);
  await provider.send(ctx, payload, randomUUID());
  assert.deepEqual(sent[0].envelope, {
    from: ctx.account.address,
    to: [...payload.to, ...payload.bcc],
  });
  assert.equal(sent[0].from, ctx.account.address);
  assert.equal(sent[0].disableUrlAccess, true);
  assert.equal(sent[0].disableFileAccess, true);
  assert.equal(ctx.sends, 1);
  partial = true;
  await assert.rejects(provider.send(ctx, payload, randomUUID()), { code: 'send_uncertain' });
  await assert.rejects(
    provider.send(ctx, { ...payload, from: 'spoof@example.test' }, randomUUID()),
    { code: 'stale_revision' },
  );
  assert.equal(sent.length, 2);
});

const agentMessage = (id: string, overrides: Record<string, unknown> = {}) => ({
  message_id: `<${id}@example.test>`,
  thread_id: 'thread-a',
  labels: ['received', 'unread'],
  timestamp: '2000-01-01T00:00:00Z',
  created_at: '2026-10-28T12:00:02Z',
  from: 'Sender <sender@example.test>',
  to: ['bot@example.test'],
  subject: id,
  preview: 'An update',
  ...overrides,
});
function apiFixture(
  respond: (request: MailApiRequest) => Record<string, unknown> | Promise<Record<string, unknown>>,
) {
  const calls: MailApiRequest[] = [];
  const request: MailApiTransport = async (context, value) => {
    context.check();
    calls.push(value);
    return respond(value);
  };
  return { request, calls };
}

test('AgentMail verifies the configured inbox address, uses v0 endpoints and performs a read-only test', async () => {
  const { request, calls } = apiFixture(() => ({
    inbox_id: 'existing-inbox',
    email: 'bot@example.test',
  }));
  const provider = new AgentMailProvider(request);
  await provider.test(context(account('agentmail')));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].origin, 'https://api.agentmail.to');
  assert.equal(calls[0].path, '/v0/inboxes/existing-inbox');
  assert.equal(calls[0].method, 'GET');
  const wrong = new AgentMailProvider(async () => ({
    inbox_id: 'other@example.test',
    email: 'other@example.test',
  }));
  await assert.rejects(
    wrong.send(context(account('agentmail')), draft(account('agentmail')), randomUUID()),
    { code: 'provider_mismatch' },
  );
});

test('AgentMail bounded scan uses ingestion time, resumes pages, and does not lose sender-backdated arrivals', async () => {
  const { request, calls } = apiFixture((value) => {
    if (!value.path.includes('/messages')) return { email: 'bot@example.test' };
    const url = new URL(value.path, value.origin);
    assert.equal(url.searchParams.get('labels'), 'received');
    assert.equal(url.searchParams.get('limit'), '1');
    assert.equal(url.searchParams.has('after'), false);
    return url.searchParams.has('page_token')
      ? { messages: [agentMessage('new-but-backdated')] }
      : {
          messages: [agentMessage('old', { created_at: '2026-10-27T12:00:00Z' })],
          next_page_token: 'opaque-next',
        };
  });
  const provider = new AgentMailProvider(request);
  const ctx = context(account('agentmail'));
  const first = await provider.poll(ctx, undefined, { since: created, limit: 1 });
  assert.equal(first.baseline, true);
  assert.equal(first.messages.length, 0);
  assert.equal(first.hasMore, true);
  const second = await provider.poll(ctx, first.cursor, { limit: 1 });
  assert.equal(second.messages[0].subject, 'new-but-backdated');
  assert.equal(second.hasMore, false);
  assert.equal(calls.filter((value) => value.path.includes('/messages')).length, 2);
});

test('AgentMail search and reply keep explicit recipients, safe references and plain text only', async () => {
  const { request, calls } = apiFixture((value) => {
    if (value.path.includes('/messages/search')) return { messages: [agentMessage('original')] };
    if (value.path.endsWith('/messages/send'))
      return { message_id: '<sent@example.test>', thread_id: 'thread-a' };
    if (value.path.includes('/messages/'))
      return agentMessage('original', {
        text: 'Read original',
        references: ['<valid@example.test>', 'bad\r\nBcc: hidden@example.test'],
      });
    return { email: 'bot@example.test' };
  });
  const provider = new AgentMailProvider(request);
  const ctx = context(account('agentmail'));
  const search = await provider.list(ctx, { query: 'status update' });
  const payload = { ...draft(ctx.account), replyToMessageId: search.messages[0].id };
  await provider.send(ctx, payload, randomUUID());
  const send = calls.find((value) => value.path.endsWith('/messages/send'))!;
  assert.deepEqual(send.body?.to, payload.to);
  assert.deepEqual(send.body?.bcc, payload.bcc);
  assert.equal(send.body?.text, payload.text);
  assert.equal(send.body?.from, undefined);
  assert.equal(send.body?.html, undefined);
  assert.deepEqual(send.body?.headers, {
    'In-Reply-To': '<original@example.test>',
    References: '<valid@example.test> <original@example.test>',
  });
});

const resendEmail = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  direction: 'inbound',
  from: 'Sender <sender@example.test>',
  to: ['bot@example.test'],
  cc: [],
  bcc: [],
  reply_to: [],
  subject: 'Update',
  text: 'Email body',
  html: null,
  message_id: `<${id}@example.test>`,
  received_at: '2026-10-28T12:00:02Z',
  read: false,
  attachments: [],
  ...overrides,
});

test('Resend send connects an existing inbox and uses a single provider draft/send without provisioning', async () => {
  const { request, calls } = apiFixture((value) => {
    if (value.path.endsWith('/drafts')) return { id: 'remote-draft' };
    if (value.path.endsWith('/drafts/remote-draft/send')) return { id: 'accepted-email' };
    return { email_address: 'bot@example.test' };
  });
  const provider = new ResendMailProvider(request);
  const ctx = context(account('resend'));
  await provider.test(ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  const key = randomUUID();
  const payload = draft(ctx.account);
  assert.deepEqual(await provider.send(ctx, payload, key), { messageId: 'accepted-email' });
  const mutations = calls.filter((value) => value.method === 'POST');
  assert.equal(mutations.length, 2);
  assert.equal(mutations[0].path, '/inboxes/existing-inbox/drafts');
  assert.deepEqual(mutations[0].body?.to, payload.to);
  assert.deepEqual(mutations[0].body?.bcc, payload.bcc);
  assert.equal(mutations[1].idempotencyKey, key);
  assert.equal(ctx.sends, 1);
  assert.ok(calls.every((value) => value.origin === 'https://api.resend.com'));
  assert.ok(!mutations.some((value) => value.path === '/inboxes'));
});

test('Resend reply refuses derived recipients that differ from the reviewed To', async () => {
  const { request, calls } = apiFixture((value) => {
    if (value.path.endsWith('/reply')) return { id: 'reply-accepted' };
    if (value.path.includes('/emails/'))
      return resendEmail('email-one', { reply_to: ['reply@example.test'] });
    return { email_address: 'bot@example.test' };
  });
  const provider = new ResendMailProvider(request);
  const ctx = context(account('resend'));
  const payload = {
    ...draft(ctx.account),
    replyToMessageId: locator(ctx.account, {
      kind: 'resend-message',
      threadId: 'thread-one',
      emailId: 'email-one',
    }),
  };
  await assert.rejects(provider.send(ctx, payload, randomUUID()), { code: 'invalid_request' });
  assert.equal(
    calls.some((value) => value.method === 'POST'),
    false,
  );
  payload.to = ['reply@example.test'];
  await provider.send(ctx, payload, randomUUID());
  const sent = calls.find((value) => value.method === 'POST')!;
  assert.equal(sent.body?.reply_all, false);
  assert.deepEqual(sent.body?.bcc, payload.bcc);
  assert.equal(sent.body?.subject, payload.subject);
});

test('Resend thread reads resolve a concrete email locator and search uses the matching email', async () => {
  const { request } = apiFixture((value) => {
    if (value.path.includes('/threads/search'))
      return {
        data: [
          {
            id: 'thread-one',
            matched_email_id: 'matched-email',
            from: 'sender@example.test',
            to: ['bot@example.test'],
            subject: 'match',
            received_at: created,
          },
        ],
        has_more: false,
      };
    if (value.path.endsWith('/emails/matched-email')) return resendEmail('matched-email');
    if (value.path.includes('/threads/thread-one/emails'))
      return { data: [resendEmail('old-email'), resendEmail('latest-email')], has_more: false };
    if (value.path.includes('/threads?'))
      return {
        data: [
          {
            id: 'thread-one',
            from: 'sender@example.test',
            to: ['bot@example.test'],
            subject: 'thread',
            received_at: created,
          },
        ],
        has_more: false,
      };
    return { email_address: 'bot@example.test' };
  });
  const provider = new ResendMailProvider(request);
  const ctx = context(account('resend'));
  const listed = await provider.list(ctx, {});
  assert.equal(parseLocator(ctx.account, listed.messages[0].id).kind, 'resend-thread');
  const read = await provider.read(ctx, listed.messages[0].id);
  assert.equal(parseLocator(ctx.account, read.id).emailId, 'latest-email');
  const found = await provider.list(ctx, { query: 'word' });
  assert.equal(parseLocator(ctx.account, found.messages[0].id).emailId, 'matched-email');
  assert.equal(
    parseLocator(ctx.account, (await provider.read(ctx, found.messages[0].id)).id).emailId,
    'matched-email',
  );
});

test('Resend sync uses live thread pagination and retains initial arrivals across email pages', async () => {
  const { request, calls } = apiFixture((value) => {
    const url = new URL(value.path, value.origin);
    if (url.pathname.endsWith('/threads'))
      return { data: [{ id: 'thread-one', received_at: '2026-10-28T12:00:03Z' }], has_more: false };
    if (url.pathname.endsWith('/emails'))
      return url.searchParams.has('after')
        ? { data: [resendEmail('new-email')], has_more: false }
        : {
            data: [resendEmail('older-email', { received_at: '2026-10-28T11:00:00Z' })],
            has_more: true,
          };
    return { email_address: 'bot@example.test' };
  });
  const provider = new ResendMailProvider(request);
  const ctx = context(account('resend'));
  const first = await provider.poll(ctx, undefined, { since: created, limit: 1 });
  assert.equal(first.baseline, true);
  assert.equal(first.messages.length, 0);
  assert.equal(first.hasMore, true);
  const second = await provider.poll(ctx, first.cursor, { limit: 1 });
  assert.equal(second.messages.length, 1);
  assert.equal(parseLocator(ctx.account, second.messages[0].id).emailId, 'new-email');
  assert.equal(second.hasMore, false);
  assert.equal(calls.filter((value) => value.path.includes('/threads?')).length, 1);
  assert.ok(!calls.some((value) => value.path.includes('/search')));
});
