import { ImapSmtpProvider } from '../../../src/server/mail-providers/imap.js';
import {
  MailAccountError,
  type MailProviderContext,
} from '../../../src/server/mail-providers/types.js';
import type { MailAccount, MailDraft } from '../../../src/shared/mail-accounts.js';

// This subprocess uses only the loopback fixture and synthetic credentials. A fresh
// process lets NODE_EXTRA_CA_CERTS trust the fixture without relaxing TLS checks.
const { port, secure, action } = JSON.parse(process.argv[2]) as {
  port: number;
  secure: boolean;
  action: 'verify' | 'send';
};
const controller = new AbortController();
process.on('message', (message) => {
  if (message === 'abort') controller.abort();
});
const createdAt = '2020-01-01T00:00:00.000Z';
const account: MailAccount = {
  id: 'mail_loopback',
  provider: 'imap',
  name: 'Loopback fixture',
  address: 'bot@example.test',
  botIds: ['bot_fixture'],
  enabled: true,
  sendPolicy: 'ask',
  revision: 1,
  createdAt,
  updatedAt: createdAt,
  imap: {
    host: 'imap.example.test',
    port: 993,
    secure: true,
    user: 'bot@example.test',
    passwordConfigured: true,
    mailbox: 'INBOX',
  },
  smtp: {
    host: '127.0.0.1',
    port,
    secure,
    user: 'bot@example.test',
    passwordConfigured: true,
  },
};
const context: MailProviderContext = {
  account,
  secrets: { imapPassword: 'fixture-imap', smtpPassword: 'fixture-smtp', apiKey: '' },
  signal: controller.signal,
  check() {
    if (controller.signal.aborted) throw new MailAccountError('cancelled');
  },
  beforeSend() {
    this.check();
  },
};
const provider = new ImapSmtpProvider({
  createImap: () =>
    ({
      async connect() {},
      async mailboxOpen() {
        return { path: 'INBOX', uidValidity: 1n, uidNext: 1, exists: 0 };
      },
      on() {},
      close() {},
    }) as never,
});
try {
  const draft: MailDraft = {
    id: 'draft_loopback',
    accountId: account.id,
    accountRevision: account.revision,
    from: account.address,
    to: ['recipient@example.test'],
    cc: [],
    bcc: [],
    subject: 'Loopback transport fixture',
    text: 'Synthetic message; never sent outside this test server.',
    revision: 1,
    status: 'draft',
    createdAt,
    updatedAt: createdAt,
  };
  const value =
    action === 'verify'
      ? await provider.test(context)
      : await provider.send(context, draft, 'loopback');
  process.send?.({ ok: true, value });
} catch (error) {
  const detail = error as { code?: string; connectionStage?: string };
  process.send?.({ ok: false, code: detail.code, connectionStage: detail.connectionStage });
} finally {
  process.disconnect?.();
}
