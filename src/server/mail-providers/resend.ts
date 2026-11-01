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
import {
  MailAccountError,
  MAX_POLL_PAGE,
  boundedLimit,
  cleanHeader,
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
import {
  apiArray,
  apiId,
  apiPath,
  apiToken,
  mailApiRequest,
  queryPath,
  type MailApiTransport,
} from './http.js';

/** Resend Inboxes API. Requires an existing inbox and a key with read access. */
export class ResendMailProvider implements MailProviderAdapter {
  constructor(private readonly request: MailApiTransport = mailApiRequest) {}

  async test(context: MailProviderContext): Promise<{ send: boolean }> {
    await this.verify(context);
    return { send: true };
  }

  async list(context: MailProviderContext, options: MailListOptions): Promise<MailListResult> {
    await this.verify(context);
    const limit = boundedLimit(options.limit);
    let after: string | undefined;
    if (options.cursor) {
      const cursor = parseLocator(context.account, options.cursor);
      if (cursor.kind !== 'resend-list' || cursor.query !== (options.query ?? ''))
        throw new MailAccountError('invalid_request', true);
      after = apiToken(cursor.after);
    }
    const response = await this.call(
      context,
      queryPath(this.path(context, options.query ? '/threads/search' : '/threads'), {
        limit,
        after,
        folders: 'inbox',
        ...(options.query ? { query: options.query } : {}),
      }),
    );
    const threads = apiArray(response.data);
    if (threads.length > limit || (response.has_more && !threads.length))
      throw new MailAccountError('connection_failed');
    return {
      messages: threads.map((thread): MailMessageSummary => {
        const threadId = apiId(thread.id);
        const matched = thread.matched_email_id ? apiId(thread.matched_email_id) : undefined;
        return {
          id: locator(context.account, {
            kind: matched ? 'resend-message' : 'resend-thread',
            threadId,
            ...(matched ? { emailId: matched } : {}),
          }),
          accountId: context.account.id,
          folder: cleanHeader(thread.folder, 40) || 'inbox',
          threadId,
          subject: cleanHeader(thread.subject),
          from: normalizeAddresses(thread.from),
          to: normalizeAddresses(thread.to),
          cc: normalizeAddresses(thread.cc),
          date: safeDate(thread.received_at),
          unread: thread.read === false,
        };
      }),
      ...(response.has_more
        ? {
            nextCursor: locator(context.account, {
              kind: 'resend-list',
              after: apiId(threads.at(-1)!.id),
              query: options.query ?? '',
            }),
          }
        : {}),
    };
  }

  async read(context: MailProviderContext, messageId: string): Promise<MailMessage> {
    await this.verify(context);
    const target = parseLocator(context.account, messageId);
    if (!['resend-thread', 'resend-message'].includes(String(target.kind)))
      throw new MailAccountError('invalid_request', true);
    const threadId = apiId(target.threadId);
    if (target.kind === 'resend-message')
      return this.message(
        context.account,
        threadId,
        await this.getEmail(context, threadId, apiId(target.emailId)),
      );
    // Thread lists do not include the newest email ID. Read bounded pages to resolve it,
    // returning a concrete immutable message locator for later draft/reply approval.
    let after: string | undefined;
    for (let page = 0; page < 4; page++) {
      const response = await this.call(
        context,
        queryPath(this.path(context, `/threads/${encodeURIComponent(threadId)}/emails`), {
          limit: 50,
          after,
        }),
      );
      const emails = apiArray(response.data);
      if (emails.length > 50 || !emails.length) throw new MailAccountError('not_found', true);
      const latest = emails.at(-1)!;
      if (!response.has_more) return this.message(context.account, threadId, latest);
      after = apiId(latest.id);
    }
    // Do not silently show an old email as the newest in an exceptionally long thread.
    throw new MailAccountError('message_too_large', true);
  }

  async send(
    context: MailProviderContext,
    draft: MailDraft,
    requestId: string,
  ): Promise<{ messageId: string }> {
    await this.verify(context);
    if (draft.from !== context.account.address) throw new MailAccountError('stale_revision', true);
    if (draft.replyToMessageId) {
      const target = parseLocator(context.account, draft.replyToMessageId);
      if (target.kind !== 'resend-message') throw new MailAccountError('invalid_request', true);
      const threadId = apiId(target.threadId);
      const emailId = apiId(target.emailId);
      const original = await this.getEmail(context, threadId, emailId);
      const replyTo = normalizeAddresses(original.reply_to);
      const derived =
        original.direction === 'outbound'
          ? normalizeAddresses(original.to)
          : replyTo.length
            ? replyTo
            : normalizeAddresses(original.from);
      const reviewed = [...draft.to].map((address) => address.toLowerCase()).sort();
      const recipients = derived.map((entry) => entry.address.toLowerCase()).sort();
      // This endpoint derives To itself. Refuse a different envelope instead of changing the reviewed recipients.
      if (JSON.stringify(reviewed) !== JSON.stringify(recipients))
        throw new MailAccountError('invalid_request', true);
      context.beforeSend();
      const result = await this.call(
        context,
        this.path(
          context,
          `/threads/${encodeURIComponent(threadId)}/emails/${encodeURIComponent(emailId)}/reply`,
        ),
        {
          text: draft.text,
          subject: draft.subject,
          cc: [...draft.cc],
          bcc: [...draft.bcc],
          reply_all: false,
        },
        requestId,
      );
      return { messageId: apiId(result.id) };
    }
    // Resend records a new outgoing message in its inbox by creating then sending a draft.
    // The local receipt is already durable. No retries, including after an uncertain create/send.
    const remoteDraft = await this.call(
      context,
      this.path(context, '/drafts'),
      {
        to: [...draft.to],
        cc: [...draft.cc],
        bcc: [...draft.bcc],
        subject: draft.subject,
        text: draft.text,
      },
      `${requestId}:draft`,
    );
    const remoteId = apiId(remoteDraft.id);
    context.beforeSend();
    const result = await this.call(
      context,
      this.path(context, `/drafts/${encodeURIComponent(remoteId)}/send`),
      {},
      requestId,
    );
    return { messageId: apiId(result.id) };
  }

  async poll(
    context: MailProviderContext,
    token: string | undefined,
    options: MailPollOptions,
  ): Promise<MailPollResult> {
    await this.verify(context);
    const limit = boundedLimit(options.limit, MAX_POLL_PAGE);
    const cursor = token ? parseLocator(context.account, token) : undefined;
    if (cursor && cursor.kind !== 'resend-poll')
      throw new MailAccountError('invalid_request', true);
    const since = cursor ? this.cursorDate(cursor.since) : initialSince(context.account, options);
    const cycleStart = cursor?.cycleStart
      ? this.cursorDate(cursor.cycleStart)
      : new Date().toISOString();
    let threadId = cursor?.threadId ? apiId(cursor.threadId) : undefined;
    let threadHasMore = cursor?.threadHasMore === true;
    const after = cursor ? apiToken(cursor.after) : undefined;
    const completeCycle = (): MailPollResult => ({
      messages: [],
      baseline: !token,
      hasMore: false,
      cursor: locator(context.account, {
        kind: 'resend-poll',
        since: new Date(Math.max(Date.parse(since), Date.parse(cycleStart) - 60_000)).toISOString(),
      }),
    });
    if (!threadId) {
      // Live threads, not search: Resend's search index may lag new mail.
      const response = await this.call(
        context,
        queryPath(this.path(context, '/threads'), { limit: 1, after, folders: 'inbox,archive' }),
      );
      const threads = apiArray(response.data);
      if (threads.length > 1 || (response.has_more && !threads.length))
        throw new MailAccountError('connection_failed');
      if (!threads.length) return completeCycle();
      const thread = threads[0];
      if (
        typeof thread.received_at !== 'string' ||
        !Number.isFinite(Date.parse(thread.received_at))
      )
        throw new MailAccountError('connection_failed');
      if (Date.parse(thread.received_at) < Date.parse(since)) return completeCycle();
      threadId = apiId(thread.id);
      threadHasMore = response.has_more === true;
    }
    const response = await this.call(
      context,
      queryPath(this.path(context, `/threads/${encodeURIComponent(threadId)}/emails`), {
        limit,
        after: cursor?.emailAfter ? apiId(cursor.emailAfter) : undefined,
      }),
    );
    const emails = apiArray(response.data);
    if (emails.length > limit || (response.has_more && !emails.length))
      throw new MailAccountError('connection_failed');
    const messages = emails
      .filter((email) => {
        if (
          typeof email.received_at !== 'string' ||
          !Number.isFinite(Date.parse(email.received_at))
        )
          throw new MailAccountError('connection_failed');
        return email.direction === 'inbound' && Date.parse(email.received_at) >= Date.parse(since);
      })
      .map((email) => this.message(context.account, threadId!, email));
    if (response.has_more)
      return {
        messages,
        baseline: !token,
        hasMore: true,
        cursor: locator(context.account, {
          kind: 'resend-poll',
          since,
          cycleStart,
          after,
          threadId,
          threadHasMore,
          emailAfter: apiId(emails.at(-1)!.id),
        }),
      };
    if (threadHasMore)
      return {
        messages,
        baseline: !token,
        hasMore: true,
        cursor: locator(context.account, {
          kind: 'resend-poll',
          since,
          cycleStart,
          after: threadId,
        }),
      };
    return { ...completeCycle(), messages };
  }

  private path(context: MailProviderContext, suffix = ''): string {
    if (!context.account.api) throw new MailAccountError('invalid_configuration', true);
    return apiPath(context.account.api.inboxId, suffix);
  }

  private call(
    context: MailProviderContext,
    path: string,
    body?: Record<string, unknown>,
    idempotencyKey?: string,
  ) {
    context.check();
    if (!context.secrets.apiKey) throw new MailAccountError('credentials_required', true);
    return this.request(context, {
      origin: 'https://api.resend.com',
      path,
      method: body ? 'POST' : 'GET',
      ...(body ? { body } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  private async verify(context: MailProviderContext): Promise<void> {
    const inbox = await this.call(context, this.path(context));
    if (
      typeof inbox.email_address !== 'string' ||
      inbox.email_address.toLowerCase() !== context.account.address.toLowerCase()
    )
      throw new MailAccountError('provider_mismatch', true);
  }

  private getEmail(context: MailProviderContext, threadId: string, emailId: string) {
    return this.call(
      context,
      this.path(
        context,
        `/threads/${encodeURIComponent(threadId)}/emails/${encodeURIComponent(emailId)}`,
      ),
    );
  }

  private message(
    account: MailAccount,
    threadId: string,
    value: Record<string, unknown>,
  ): MailMessage {
    return {
      id: locator(account, { kind: 'resend-message', threadId, emailId: apiId(value.id) }),
      accountId: account.id,
      folder: value.direction === 'outbound' ? 'sent' : 'inbox',
      threadId,
      subject: cleanHeader(value.subject),
      from: normalizeAddresses(value.from),
      to: normalizeAddresses(value.to),
      cc: normalizeAddresses(value.cc),
      date: safeDate(value.received_at),
      unread: value.read === false,
      messageId: safeReference(value.message_id),
      ...plainBody(value.text, value.html),
      replyTo: normalizeAddresses(value.reply_to),
      attachments: (Array.isArray(value.attachments) ? value.attachments.slice(0, 100) : []).map(
        (raw) => {
          const entry = raw as Record<string, unknown>;
          return {
            filename: cleanHeader(entry.filename, 250),
            contentType: cleanHeader(entry.content_type, 200) || 'application/octet-stream',
            size: Math.max(0, Number(entry.size) || 0),
          };
        },
      ),
    };
  }

  private cursorDate(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
      throw new MailAccountError('invalid_request', true);
    return new Date(value).toISOString();
  }
}
