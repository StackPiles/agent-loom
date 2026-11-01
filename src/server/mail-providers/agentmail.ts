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

/** AgentMail API v0. Connects an existing inbox; never creates or changes the inbox. */
export class AgentMailProvider implements MailProviderAdapter {
  constructor(private readonly request: MailApiTransport = mailApiRequest) {}

  async test(context: MailProviderContext): Promise<{ send: boolean }> {
    await this.verify(context);
    return { send: true };
  }

  async list(context: MailProviderContext, options: MailListOptions): Promise<MailListResult> {
    await this.verify(context);
    const limit = boundedLimit(options.limit);
    let pageToken: string | undefined;
    if (options.cursor) {
      const cursor = parseLocator(context.account, options.cursor);
      if (cursor.kind !== 'agentmail-list' || cursor.query !== (options.query ?? ''))
        throw new MailAccountError('invalid_request', true);
      pageToken = apiToken(cursor.pageToken);
    }
    const response = await this.call(
      context,
      queryPath(this.path(context, options.query ? '/messages/search' : '/messages'), {
        limit,
        page_token: pageToken,
        labels: 'received',
        ...(options.query ? { q: options.query } : {}),
      }),
    );
    const values = apiArray(response.messages);
    if (values.length > limit) throw new MailAccountError('connection_failed');
    const next = apiToken(response.next_page_token);
    return {
      messages: values.map((value) => this.summary(context.account, value)),
      ...(next
        ? {
            nextCursor: locator(context.account, {
              kind: 'agentmail-list',
              pageToken: next,
              query: options.query ?? '',
            }),
          }
        : {}),
    };
  }

  async read(context: MailProviderContext, messageId: string): Promise<MailMessage> {
    await this.verify(context);
    return this.readVerified(context, messageId);
  }

  async send(
    context: MailProviderContext,
    draft: MailDraft,
    _requestId: string,
  ): Promise<{ messageId: string }> {
    await this.verify(context);
    if (draft.from !== context.account.address) throw new MailAccountError('stale_revision', true);
    const reply = draft.replyToMessageId
      ? await this.readVerified(context, draft.replyToMessageId)
      : undefined;
    if (reply && !reply.messageId) throw new MailAccountError('invalid_request', true);
    context.beforeSend();
    // Explicit recipients are the reviewed envelope; reply-all cannot add hidden recipients.
    const result = await this.call(context, this.path(context, '/messages/send'), {
      to: [...draft.to],
      cc: [...draft.cc],
      bcc: [...draft.bcc],
      subject: draft.subject,
      text: draft.text,
      ...(reply
        ? {
            headers: {
              'In-Reply-To': reply.messageId,
              References: [...(reply.references ?? []), reply.messageId].slice(-20).join(' '),
            },
          }
        : {}),
    });
    return { messageId: apiId(result.message_id) };
  }

  async poll(
    context: MailProviderContext,
    token: string | undefined,
    options: MailPollOptions,
  ): Promise<MailPollResult> {
    await this.verify(context);
    const limit = boundedLimit(options.limit, MAX_POLL_PAGE);
    const cursor = token ? parseLocator(context.account, token) : undefined;
    if (cursor && cursor.kind !== 'agentmail-poll')
      throw new MailAccountError('invalid_request', true);
    const since = cursor ? this.cursorDate(cursor.since) : initialSince(context.account, options);
    const cycleStart = cursor?.cycleStart
      ? this.cursorDate(cursor.cycleStart)
      : new Date().toISOString();
    const pageToken = cursor ? apiToken(cursor.pageToken) : undefined;
    // The provider orders by sender timestamp. Scan bounded pages using ingestion created_at,
    // so even sender-backdated verification emails are eventually found.
    const response = await this.call(
      context,
      queryPath(this.path(context, '/messages'), {
        limit,
        page_token: pageToken,
        labels: 'received',
      }),
    );
    const values = apiArray(response.messages);
    if (values.length > limit) throw new MailAccountError('connection_failed');
    const next = apiToken(response.next_page_token);
    const messages = values
      .filter((value) => {
        if (typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at)))
          throw new MailAccountError('connection_failed');
        return Date.parse(value.created_at) >= Date.parse(since);
      })
      .map((value) => this.summary(context.account, value));
    const nextSince = next
      ? since
      : new Date(Math.max(Date.parse(since), Date.parse(cycleStart) - 60_000)).toISOString();
    return {
      messages,
      baseline: !token,
      hasMore: Boolean(next),
      cursor: locator(context.account, {
        kind: 'agentmail-poll',
        since: nextSince,
        ...(next ? { cycleStart, pageToken: next } : {}),
      }),
    };
  }

  private path(context: MailProviderContext, suffix = ''): string {
    if (!context.account.api) throw new MailAccountError('invalid_configuration', true);
    return `/v0${apiPath(context.account.api.inboxId, suffix)}`;
  }

  private call(context: MailProviderContext, path: string, body?: Record<string, unknown>) {
    context.check();
    if (!context.secrets.apiKey) throw new MailAccountError('credentials_required', true);
    return this.request(context, {
      origin: 'https://api.agentmail.to',
      path,
      method: body ? 'POST' : 'GET',
      ...(body ? { body } : {}),
    });
  }

  private async verify(context: MailProviderContext): Promise<void> {
    const inbox = await this.call(context, this.path(context));
    const address = typeof inbox.email === 'string' ? inbox.email : inbox.inbox_id;
    if (
      typeof address !== 'string' ||
      address.toLowerCase() !== context.account.address.toLowerCase()
    )
      throw new MailAccountError('provider_mismatch', true);
    if (inbox.status === 'paused') throw new MailAccountError('account_disabled', true);
  }

  private summary(account: MailAccount, value: Record<string, unknown>): MailMessageSummary {
    const rawId = apiId(value.message_id);
    const labels = Array.isArray(value.labels) ? value.labels : [];
    return {
      id: locator(account, { kind: 'agentmail-message', messageId: rawId }),
      accountId: account.id,
      folder: labels.includes('sent') && !labels.includes('received') ? 'sent' : 'inbox',
      subject: cleanHeader(value.subject),
      from: normalizeAddresses(value.from),
      to: normalizeAddresses(value.to),
      cc: normalizeAddresses(value.cc),
      date: safeDate(value.created_at, safeDate(value.timestamp)),
      preview: cleanHeader(value.preview, 500),
      unread: labels.includes('unread'),
      messageId: safeReference(rawId),
      ...(value.thread_id ? { threadId: cleanHeader(value.thread_id, 500) } : {}),
    };
  }

  private async readVerified(
    context: MailProviderContext,
    messageId: string,
  ): Promise<MailMessage> {
    const target = parseLocator(context.account, messageId);
    if (target.kind !== 'agentmail-message') throw new MailAccountError('invalid_request', true);
    const value = await this.call(
      context,
      this.path(context, `/messages/${encodeURIComponent(apiId(target.messageId))}`),
    );
    return {
      ...this.summary(context.account, value),
      ...plainBody(value.text ?? value.extracted_text, value.html ?? value.extracted_html),
      replyTo: normalizeAddresses(value.reply_to),
      references: (Array.isArray(value.references) ? value.references : [])
        .map(safeReference)
        .filter((v): v is string => Boolean(v))
        .slice(-20),
      attachments: (Array.isArray(value.attachments) ? value.attachments.slice(0, 100) : []).map(
        (raw) => {
          const entry = raw as Record<string, unknown>;
          return {
            filename: cleanHeader(entry.filename, 250),
            contentType: cleanHeader(entry.content_type, 200),
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
