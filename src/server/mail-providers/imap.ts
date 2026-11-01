import { Socket } from 'node:net';
import {
  ImapFlow,
  type FetchMessageObject,
  type ImapFlowOptions,
  type MailboxObject,
} from 'imapflow';
import { createTransport } from 'nodemailer';
import { simpleParser } from 'mailparser';
import type {
  MailAccount,
  MailDraft,
  MailListOptions,
  MailListResult,
  MailMessage,
  MailMessageSummary,
  MailPollOptions,
  MailPollResult,
} from '../../shared/mail-accounts.js';
import { mailClientOptions } from '../mail.js';
import {
  MailAccountError,
  MAX_MAIL_SOURCE,
  MAX_POLL_PAGE,
  abortable,
  boundedLimit,
  cleanHeader,
  decodeOpaque,
  encodeOpaque,
  initialSince,
  locator,
  normalizeAddresses,
  parseLocator,
  plainBody,
  safeDate,
  safeReference,
  type MailProviderAdapter,
  type MailProviderContext,
} from './types.js';

type ImapClient = Pick<
  ImapFlow,
  'connect' | 'mailboxOpen' | 'close' | 'on' | 'search' | 'fetch' | 'fetchOne'
>;
interface SmtpResult {
  messageId: string;
  accepted?: unknown[];
  rejected?: unknown[];
}
export interface SmtpClient {
  verify(): Promise<unknown>;
  sendMail(options: Record<string, unknown>): Promise<SmtpResult>;
  close(): void;
}
export interface ImapSmtpAdapters {
  createImap?: (options: ImapFlowOptions) => ImapClient;
  createSmtp?: (context: MailProviderContext) => SmtpClient;
}

function smtpClient(context: MailProviderContext): SmtpClient {
  const endpoint = context.account.smtp;
  if (!endpoint) throw new MailAccountError('send_disabled', true);
  if (!context.secrets.smtpPassword) throw new MailAccountError('credentials_required', true);
  // Keep a socket handle so abort also closes an in-flight SMTP operation.
  const socket = new Socket();
  socket.on('connect', () => {
    try {
      context.check();
    } catch {
      socket.destroy();
    }
  });
  const options = {
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    requireTLS: !endpoint.secure,
    ignoreTLS: false,
    auth: { user: endpoint.user, pass: context.secrets.smtpPassword },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
    pool: false,
    socket,
    allowInternalNetworkInterfaces: true,
  };
  const transport = createTransport(options);
  return {
    verify: () => transport.verify(),
    sendMail: (message) => transport.sendMail(message),
    close() {
      socket.destroy();
      transport.close();
    },
  };
}

const validUid = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 4_294_967_295;
const validLastUid = (value: unknown): value is number => value === 0 || validUid(value);

/** Preserve the processed UID across migration, including arrivals while Loom was off. */
export function encodeLegacyImapCursor(uidValidity: string, lastUid: number): string {
  if (!/^\d{1,20}$/.test(uidValidity) || !validLastUid(lastUid))
    throw new MailAccountError('invalid_request', true);
  return encodeOpaque({ v: 1, kind: 'imap-legacy', uidValidity, lastUid });
}

function summary(
  account: MailAccount,
  mailbox: MailboxObject,
  value: FetchMessageObject,
): MailMessageSummary {
  const envelope = value.envelope;
  return {
    id: locator(account, {
      kind: 'imap-message',
      uid: value.uid,
      uidValidity: mailbox.uidValidity.toString(),
    }),
    accountId: account.id,
    folder: account.imap!.mailbox,
    subject: cleanHeader(envelope?.subject),
    from: normalizeAddresses(envelope?.from),
    to: normalizeAddresses(envelope?.to),
    cc: normalizeAddresses(envelope?.cc),
    date: safeDate(value.internalDate, safeDate(envelope?.date)),
    unread: !value.flags?.has('\\Seen'),
    messageId: safeReference(envelope?.messageId),
    ...(value.threadId ? { threadId: cleanHeader(value.threadId, 500) } : {}),
  };
}

export class ImapSmtpProvider implements MailProviderAdapter {
  constructor(private readonly adapters: ImapSmtpAdapters = {}) {}

  async test(context: MailProviderContext): Promise<{ send: boolean }> {
    await this.withImap(context, async () => {});
    if (!context.account.smtp) return { send: false };
    await this.withSmtp(context, (smtp) => smtp.verify());
    return { send: true };
  }

  async list(context: MailProviderContext, options: MailListOptions): Promise<MailListResult> {
    const limit = boundedLimit(options.limit);
    return this.withImap(context, async (client, mailbox) => {
      let before = mailbox.uidNext - 1;
      if (options.cursor) {
        const cursor = parseLocator(context.account, options.cursor);
        if (
          cursor.kind !== 'imap-list' ||
          cursor.uidValidity !== mailbox.uidValidity.toString() ||
          !validLastUid(cursor.before) ||
          cursor.query !== (options.query ?? '')
        )
          throw new MailAccountError('invalid_request', true);
        before = Math.min(before, cursor.before);
      }
      if (before <= 0) return { messages: [] };
      // Bound SEARCH itself. Empty pages may carry a next cursor across UID gaps.
      const start = Math.max(1, before - 1_999);
      context.check();
      const matches = await client.search(
        { uid: `${start}:${before}`, ...(options.query ? { text: options.query } : {}) },
        { uid: true },
      );
      if (!matches) throw new MailAccountError('connection_failed');
      const found = matches
        .filter((uid) => validUid(uid) && uid >= start && uid <= before)
        .sort((a, b) => b - a);
      const chosen = found.slice(0, limit);
      const messages = await this.summaries(context, client, mailbox, chosen);
      const next = found.length > chosen.length ? chosen.at(-1)! - 1 : start - 1;
      return {
        messages: messages.reverse(),
        ...(next > 0
          ? {
              nextCursor: locator(context.account, {
                kind: 'imap-list',
                uidValidity: mailbox.uidValidity.toString(),
                before: next,
                query: options.query ?? '',
              }),
            }
          : {}),
      };
    });
  }

  async read(context: MailProviderContext, messageId: string): Promise<MailMessage> {
    const target = parseLocator(context.account, messageId);
    if (target.kind !== 'imap-message' || !validUid(target.uid))
      throw new MailAccountError('invalid_request', true);
    return this.withImap(context, async (client, mailbox) => {
      if (target.uidValidity !== mailbox.uidValidity.toString())
        throw new MailAccountError('not_found', true);
      context.check();
      const metadata = await client.fetchOne(
        String(target.uid),
        { uid: true, envelope: true, flags: true, internalDate: true, size: true },
        { uid: true },
      );
      if (!metadata) throw new MailAccountError('not_found', true);
      if (!metadata.size || metadata.size > MAX_MAIL_SOURCE)
        throw new MailAccountError('message_too_large', true);
      context.check();
      const fetched = await client.fetchOne(
        String(target.uid),
        { source: { maxLength: MAX_MAIL_SOURCE + 1 } },
        { uid: true },
      );
      if (!fetched || !fetched.source) throw new MailAccountError('not_found', true);
      if (fetched.source.length > MAX_MAIL_SOURCE)
        throw new MailAccountError('message_too_large', true);
      const parsed = await simpleParser(fetched.source, {
        skipHtmlToText: true,
        skipTextToHtml: true,
        skipImageLinks: true,
        maxHtmlLengthToParse: MAX_MAIL_SOURCE,
      });
      return {
        ...summary(context.account, mailbox, metadata),
        ...plainBody(parsed.text, parsed.html),
        replyTo: normalizeAddresses(parsed.replyTo?.value),
        references: (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
          .map(safeReference)
          .filter((v): v is string => Boolean(v))
          .slice(-20),
        attachments: parsed.attachments.slice(0, 100).map((item) => ({
          filename: cleanHeader(item.filename, 250),
          contentType: cleanHeader(item.contentType, 200),
          size: item.size,
        })),
      };
    });
  }

  async send(
    context: MailProviderContext,
    draft: MailDraft,
    requestId: string,
  ): Promise<{ messageId: string }> {
    if (draft.from !== context.account.address) throw new MailAccountError('stale_revision', true);
    const reply = draft.replyToMessageId
      ? await this.read(context, draft.replyToMessageId)
      : undefined;
    if (reply && !reply.messageId) throw new MailAccountError('invalid_request', true);
    return this.withSmtp(context, async (client) => {
      context.beforeSend();
      const result = await client.sendMail({
        from: context.account.address,
        envelope: { from: context.account.address, to: [...draft.to, ...draft.cc, ...draft.bcc] },
        to: [...draft.to],
        cc: [...draft.cc],
        bcc: [...draft.bcc],
        subject: draft.subject,
        text: draft.text,
        messageId: `<loom.${requestId}@${context.account.address.split('@')[1]}>`,
        ...(reply
          ? {
              inReplyTo: reply.messageId,
              references: [...(reply.references ?? []), reply.messageId!].slice(-20),
            }
          : {}),
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      // Partial acceptance must not become a resendable failure.
      if (result.rejected?.length || !result.accepted?.length)
        throw new MailAccountError('send_uncertain');
      return { messageId: result.messageId };
    });
  }

  async poll(
    context: MailProviderContext,
    token: string | undefined,
    options: MailPollOptions,
  ): Promise<MailPollResult> {
    const limit = boundedLimit(options.limit, MAX_POLL_PAGE);
    return this.withImap(context, async (client, mailbox) => {
      const uidValidity = mailbox.uidValidity.toString();
      let saved: Record<string, unknown> | undefined;
      if (token) {
        const decoded = decodeOpaque(token);
        saved = decoded.kind === 'imap-legacy' ? decoded : parseLocator(context.account, token);
        if (
          !['imap-poll', 'imap-legacy'].includes(String(saved.kind)) ||
          !validLastUid(saved.lastUid) ||
          typeof saved.uidValidity !== 'string'
        )
          throw new MailAccountError('invalid_request', true);
      }
      const high = Math.max(0, mailbox.uidNext - 1);
      if (saved && saved.uidValidity !== uidValidity) {
        // A reindexed mailbox assigns new locators to existing messages. The old UID
        // checkpoint cannot distinguish those from new arrivals, so do not replay the
        // entire rule history as new mail. Resume at the current high UID, as with the
        // legacy watcher, and tell the caller explicitly that continuity was reset.
        return {
          messages: [],
          cursor: locator(context.account, { kind: 'imap-poll', uidValidity, lastUid: high }),
          baseline: true,
          hasMore: false,
          reset: 'uidvalidity_changed',
        };
      }
      const baseline = !saved;
      const cutoff = baseline
        ? initialSince(context.account, options)
        : typeof saved!.cutoff === 'string'
          ? saved!.cutoff
          : undefined;
      let lastUid = baseline ? 0 : Number(saved!.lastUid);
      if (baseline && high) {
        context.check();
        // SINCE has day precision; overlap one day and filter by INTERNALDATE.
        const search = await client.search(
          { since: new Date(Date.parse(cutoff!) - 86_400_000) },
          { uid: true, returnOptions: ['MIN'] },
        );
        if (!search) throw new MailAccountError('connection_failed');
        const minimum = Array.isArray(search)
          ? search.filter(validUid).sort((a, b) => a - b)[0]
          : search.min;
        lastUid = minimum && validUid(minimum) ? minimum - 1 : high;
      }
      if (lastUid >= high)
        return {
          messages: [],
          cursor: locator(context.account, { kind: 'imap-poll', uidValidity, lastUid }),
          baseline,
          hasMore: false,
        };
      const end = Math.min(high, lastUid + 2_000);
      context.check();
      const search = await client.search({ uid: `${lastUid + 1}:${end}` }, { uid: true });
      if (!search) throw new MailAccountError('connection_failed');
      const matches = search
        .filter((uid) => validUid(uid) && uid > lastUid && uid <= end)
        .sort((a, b) => a - b);
      const chosen = matches.slice(0, limit);
      const values = await this.summaries(context, client, mailbox, chosen);
      lastUid = matches.length > chosen.length ? chosen.at(-1)! : end;
      const hasMore = lastUid < high;
      return {
        messages: values.filter((value) => !cutoff || Date.parse(value.date) >= Date.parse(cutoff)),
        cursor: locator(context.account, {
          kind: 'imap-poll',
          uidValidity,
          lastUid,
          ...(hasMore && cutoff ? { cutoff } : {}),
        }),
        baseline,
        hasMore,
      };
    });
  }

  private async summaries(
    context: MailProviderContext,
    client: ImapClient,
    mailbox: MailboxObject,
    uids: number[],
  ): Promise<MailMessageSummary[]> {
    if (!uids.length) return [];
    context.check();
    const found: FetchMessageObject[] = [];
    const requested = new Set(uids);
    // Drain this bounded FETCH before another IMAP command (ImapFlow iterator contract).
    for await (const value of client.fetch(
      uids,
      { uid: true, envelope: true, flags: true, internalDate: true },
      { uid: true },
    )) {
      if (requested.has(value.uid) && found.length < uids.length) found.push(value);
    }
    return found
      .sort((a, b) => a.uid - b.uid)
      .map((value) => summary(context.account, mailbox, value));
  }

  private async withImap<T>(
    context: MailProviderContext,
    operation: (client: ImapClient, mailbox: MailboxObject) => Promise<T>,
  ): Promise<T> {
    context.check();
    const config = context.account.imap;
    if (!config) throw new MailAccountError('invalid_configuration', true);
    if (!context.secrets.imapPassword) throw new MailAccountError('credentials_required', true);
    const options: ImapFlowOptions = {
      ...mailClientOptions(config, context.secrets.imapPassword),
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    };
    const client = this.adapters.createImap?.(options) ?? new ImapFlow(options);
    client.on('error', () => {});
    const close = () => {
      try {
        client.close();
      } catch {
        /* already closed */
      }
    };
    const work = async () => {
      await client.connect();
      context.check();
      let mailbox: MailboxObject;
      try {
        mailbox = await client.mailboxOpen(config.mailbox, { readOnly: true });
      } catch {
        throw new MailAccountError('mailbox_unavailable', true);
      }
      context.check();
      return operation(client, mailbox);
    };
    try {
      return await abortable(work(), context.signal, close);
    } finally {
      close();
    }
  }

  private async withSmtp<T>(
    context: MailProviderContext,
    operation: (client: SmtpClient) => Promise<T>,
  ): Promise<T> {
    context.check();
    if (!context.account.smtp) throw new MailAccountError('send_disabled', true);
    if (!context.secrets.smtpPassword) throw new MailAccountError('credentials_required', true);
    const client = (this.adapters.createSmtp ?? smtpClient)(context);
    try {
      return await abortable(operation(client), context.signal, () => client.close());
    } finally {
      client.close();
    }
  }
}
