import { ImapSmtpProvider } from '../../../src/server/mail-providers/imap.js';
import {
  MailAccountError,
  parseLocator,
  type MailProviderContext,
} from '../../../src/server/mail-providers/types.js';
import type {
  MailAccount,
  MailMessageSummary,
  MailPollResult,
} from '../../../src/shared/mail-accounts.js';

// A fresh process trusts only the public loopback fixture through
// NODE_EXTRA_CA_CERTS. The provider and its ImapFlow client are not mocked.
const { port, action } = JSON.parse(process.argv[2]) as {
  port: number;
  action: 'full' | 'empty' | 'list' | 'read' | 'repeat-read' | 'identity-reset' | 'list-twice';
};
const createdAt = '2026-10-28T12:00:00.000Z';
const account: MailAccount = {
  id: 'mail_loopback',
  provider: 'imap',
  name: 'IMAP loopback fixture',
  address: 'bot@example.test',
  botIds: [],
  enabled: true,
  sendPolicy: 'ask',
  revision: 1,
  createdAt,
  updatedAt: createdAt,
  imap: {
    host: '127.0.0.1',
    port,
    secure: true,
    user: 'bot@example.test',
    passwordConfigured: true,
    mailbox: 'INBOX',
  },
};
const controller = new AbortController();
const context: MailProviderContext = {
  account,
  secrets: { imapPassword: 'fixture-imap', smtpPassword: '', apiKey: '' },
  signal: controller.signal,
  check() {
    if (controller.signal.aborted) throw new MailAccountError('cancelled');
  },
  beforeSend() {
    throw new Error('IMAP fixture must never send mail');
  },
};
let advanced: (() => void) | undefined;
let reset: (() => void) | undefined;
process.on('message', (message) => {
  if (message === 'advanced') advanced?.();
  if (message === 'reset') reset?.();
});
const arrive = () =>
  new Promise<void>((resolve) => {
    advanced = resolve;
    process.send?.({ type: 'advance' });
  });
const resetIdentity = () =>
  new Promise<void>((resolve) => {
    reset = resolve;
    process.send?.({ type: 'reset' });
  });
const uids = (messages: MailMessageSummary[]) =>
  messages.map((message) => parseLocator(account, message.id).uid);
const validity = (messages: MailMessageSummary[]) =>
  messages.map((message) => parseLocator(account, message.id).uidValidity);
const polled = (result: MailPollResult) => ({
  uids: uids(result.messages),
  lastUid: parseLocator(account, result.cursor).lastUid,
  baseline: result.baseline,
  hasMore: result.hasMore,
});
const provider = new ImapSmtpProvider();
try {
  let value: unknown;
  if (action === 'list') {
    const listed = await provider.list(context, { limit: 2 });
    value = { uids: uids(listed.messages), validity: validity(listed.messages) };
  } else if (action === 'read' || action === 'repeat-read') {
    const listed = await provider.list(context, { limit: 1 });
    const message = await provider.read(context, listed.messages[0].id);
    value = {
      uid: parseLocator(account, message.id).uid,
      uidValidity: parseLocator(account, message.id).uidValidity,
      text: message.text,
      unread: message.unread,
      ...(action === 'repeat-read'
        ? { repeatedText: (await provider.read(context, listed.messages[0].id)).text }
        : {}),
    };
  } else if (action === 'identity-reset') {
    const listed = await provider.list(context, { limit: 1 });
    await resetIdentity();
    let staleError: { code?: string; connectionStage?: string } | undefined;
    try {
      await provider.read(context, listed.messages[0].id);
    } catch (error) {
      const detail = error as { code?: string; connectionStage?: string };
      staleError = { code: detail.code, connectionStage: detail.connectionStage };
    }
    const fresh = await provider.list(context, { limit: 1 });
    const message = await provider.read(context, fresh.messages[0].id);
    value = {
      staleError,
      oldValidity: parseLocator(account, listed.messages[0].id).uidValidity,
      freshValidity: parseLocator(account, fresh.messages[0].id).uidValidity,
      text: message.text,
    };
  } else if (action === 'list-twice') {
    const outcomes = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await provider.list(context, { limit: 1 });
        outcomes.push({ ok: true });
      } catch (error) {
        const detail = error as { code?: string; connectionStage?: string };
        outcomes.push({
          ok: false,
          code: detail.code,
          connectionStage: detail.connectionStage,
        });
      }
    }
    value = outcomes;
  } else {
    const verified = await provider.test(context);
    const first = await provider.list(context, { limit: 1 });
    const second =
      action === 'full'
        ? await provider.list(context, { limit: 1, cursor: first.nextCursor })
        : undefined;
    const searched = await provider.list(context, { query: 'keep', limit: 2 });
    const read = action === 'full' ? await provider.read(context, first.messages[0].id) : undefined;
    const initial = await provider.poll(context, undefined, { since: createdAt, limit: 2 });
    await arrive();
    const later = await provider.poll(context, initial.cursor, { limit: 2 });
    const repeated =
      action === 'empty' ? await provider.poll(context, later.cursor, { limit: 2 }) : undefined;
    value = {
      verified,
      first: uids(first.messages),
      firstValidity: validity(first.messages),
      ...(second ? { second: uids(second.messages) } : {}),
      searched: uids(searched.messages),
      ...(read
        ? {
            read: {
              uid: parseLocator(account, read.id).uid,
              uidValidity: parseLocator(account, read.id).uidValidity,
              text: read.text,
              unread: read.unread,
            },
          }
        : {}),
      initial: polled(initial),
      later: polled(later),
      ...(repeated ? { repeated: polled(repeated) } : {}),
    };
  }
  process.send?.({ type: 'result', result: { ok: true, value } });
} catch (error) {
  const detail = error as { code?: string; connectionStage?: string };
  process.send?.({
    type: 'result',
    result: { ok: false, code: detail.code, connectionStage: detail.connectionStage },
  });
} finally {
  process.disconnect?.();
}
