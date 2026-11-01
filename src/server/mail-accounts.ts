import { z } from 'zod';
import type { Bot } from '../shared/types.js';
import type {
  MailAccount,
  MailAccountInput,
  MailAccountTestResult,
  MailDraft,
  MailDraftInput,
  MailListOptions,
  MailListResult,
  MailMessage,
  MailPollOptions,
  MailPollResult,
  MailProvider,
  MailSendOptions,
} from '../shared/mail-accounts.js';
import { normalizeMailPassword } from '../shared/mail-settings.js';
import { Store, id, now } from './store.js';
import { ImapSmtpProvider, encodeLegacyImapCursor } from './mail-providers/imap.js';
import { AgentMailProvider } from './mail-providers/agentmail.js';
import { ResendMailProvider } from './mail-providers/resend.js';
import {
  MailAccountError,
  MAX_MAIL_TEXT,
  boundedLimit,
  safeMailError,
  type MailProviderAdapter,
  type MailProviderContext,
} from './mail-providers/types.js';

export { MailAccountError, encodeLegacyImapCursor };
export type { MailProviderAdapter, MailProviderContext } from './mail-providers/types.js';

const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !/[\r\n\0]/.test(v));
const email = singleLine(254)
  .min(3)
  .refine((v) => /^[^\s<>(),;:"\\[\]]+@[^\s<>(),;:"\\[\]]+\.[^\s<>(),;:"\\[\]]+$/.test(v));
const endpoint = z
  .object({
    host: singleLine(250)
      .min(1)
      .regex(/^[a-zA-Z0-9.:-]+$/)
      .transform((v) => v.toLowerCase()),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: singleLine(250).min(1),
    password: z
      .string()
      .max(4_096)
      .refine((v) => !v.includes('\0'))
      .optional(),
  })
  .strict();
const accountSchema = z
  .object({
    name: singleLine(160).min(1),
    address: email,
    provider: z.enum(['imap', 'agentmail', 'resend']),
    enabled: z.boolean().default(true),
    botIds: z
      .array(singleLine(160).min(1))
      .max(100)
      .default([])
      .transform((v) => [...new Set(v)]),
    sendPolicy: z.enum(['ask', 'allow', 'deny']).default('ask'),
    imap: endpoint.extend({ mailbox: singleLine(250).min(1) }).optional(),
    smtp: endpoint.optional(),
    api: z
      .object({
        inboxId: singleLine(500)
          .min(1)
          .refine((v) => v !== '.' && v !== '..'),
        apiKey: z
          .string()
          .max(4_096)
          .refine((v) => !/[\r\n\0]/.test(v))
          .optional(),
      })
      .strict()
      .optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.provider === 'imap'
        ? !value.imap || Boolean(value.api)
        : !value.api || Boolean(value.imap || value.smtp)
    )
      context.addIssue({ code: 'custom', message: 'Provider configuration does not match.' });
  });

const draftSchema = z
  .object({
    accountId: singleLine(160).min(1),
    to: z.array(email).min(1).max(50),
    cc: z.array(email).max(50).default([]),
    bcc: z.array(email).max(50).default([]),
    subject: singleLine(998),
    text: z
      .string()
      .max(MAX_MAIL_TEXT)
      .refine((v) => !v.includes('\0')),
    replyToMessageId: z.string().min(1).max(24_000).optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => v.to.length + v.cc.length + v.bcc.length <= 50);

const sendSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    expectedAccountRevision: z.number().int().positive().optional(),
    botId: singleLine(160).min(1).optional(),
  })
  .strict();

interface SendReceipt {
  id: string;
  draftId: string;
  draftRevision: number;
  accountRevision: number;
  status: 'sending' | 'sent' | 'unknown' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export interface MailServiceAdapters {
  providers?: Partial<Record<MailProvider, MailProviderAdapter>>;
  timeoutMs?: number;
}

export const mailAccountSecretKey = (accountId: string, field: 'imap' | 'smtp' | 'api') =>
  `mail.${accountId}.${field}`;
const secretKey = mailAccountSecretKey;
function sameEndpoint(a: MailAccount['smtp'], b: MailAccountInput['smtp']): boolean {
  return Boolean(
    a &&
    b &&
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.port === b.port &&
    a.secure === b.secure &&
    a.user === b.user,
  );
}

/** Provider-neutral local registry. Mail hosting, DNS and mailbox provisioning stay external. */
export class MailService {
  private readonly providers: Record<MailProvider, MailProviderAdapter>;
  private readonly active = new Set<{
    accountId: string;
    abort: AbortController;
    finished: Promise<void>;
  }>();
  private readonly sending = new Set<string>();
  private closing = false;
  constructor(
    private readonly store: Store,
    private readonly changed: () => void = () => {},
    private readonly adapters: MailServiceAdapters = {},
  ) {
    this.providers = {
      imap: adapters.providers?.imap ?? new ImapSmtpProvider(),
      agentmail: adapters.providers?.agentmail ?? new AgentMailProvider(),
      resend: adapters.providers?.resend ?? new ResendMailProvider(),
    };
    // A crash after dispatch has an unknowable outcome. Never turn it back into a draft.
    this.atomic(() => {
      for (const draft of store.list<MailDraft>('mailDrafts')) {
        if (draft.status !== 'sending') continue;
        store.put('mailDrafts', {
          ...draft,
          status: 'unknown',
          error: new MailAccountError('send_uncertain').message,
          updatedAt: now(),
        });
      }
      for (const receipt of store.list<SendReceipt>('mailSends')) {
        if (receipt.status === 'sending')
          store.put('mailSends', { ...receipt, status: 'unknown', updatedAt: now() });
      }
    });
  }

  list(): MailAccount[] {
    return this.store.list<MailAccount>('mailAccounts').map((v) => this.publicAccount(v));
  }

  get(accountId: string): MailAccount {
    const account = this.store.get<MailAccount>('mailAccounts', accountId);
    if (!account) throw new MailAccountError('not_found', true);
    return this.publicAccount(account);
  }

  save(raw: MailAccountInput, accountId?: string): MailAccount {
    const { account, secrets } = this.prepare(raw, accountId);
    if (accountId && [...this.active].some((job) => job.accountId === accountId))
      throw new MailAccountError('busy', true);
    this.atomic(() => {
      this.store.setSecret(secretKey(account.id, 'imap'), secrets.imapPassword);
      this.store.setSecret(secretKey(account.id, 'smtp'), secrets.smtpPassword);
      this.store.setSecret(secretKey(account.id, 'api'), secrets.apiKey);
      this.store.put('mailAccounts', account);
    });
    this.changed();
    return this.get(account.id);
  }

  remove(accountId: string, expectedRevision?: number): void {
    const account = this.get(accountId);
    if (expectedRevision !== undefined && expectedRevision !== account.revision)
      throw new MailAccountError('stale_revision', true);
    if ([...this.active].some((job) => job.accountId === accountId))
      throw new MailAccountError('busy', true);
    this.atomic(() => {
      for (const field of ['imap', 'smtp', 'api'] as const)
        this.store.setSecret(secretKey(accountId, field), '');
      this.store.remove('mailAccounts', accountId);
    });
    // Keep drafts and receipts as a local audit trail. They can no longer be sent.
    this.changed();
  }

  async test(
    raw: MailAccountInput,
    existingId?: string,
    signal?: AbortSignal,
  ): Promise<MailAccountTestResult> {
    const prepared = this.prepare(raw, existingId, true);
    return this.run(
      prepared.account,
      undefined,
      signal,
      async (context) => {
        const result = await this.providers[prepared.account.provider].test(context);
        return {
          ok: true,
          provider: prepared.account.provider,
          address: prepared.account.address,
          receive: true,
          send: result.send,
        };
      },
      { ...prepared.secrets },
      true,
    );
  }

  async listMessages(
    accountId: string,
    options: MailListOptions = {},
    signal?: AbortSignal,
    botId?: string,
  ): Promise<MailListResult> {
    this.validateList(options);
    const account = this.access(accountId, botId);
    return this.run(account, botId, signal, (context) =>
      this.providers[account.provider].list(context, options),
    );
  }

  async readMessage(
    accountId: string,
    messageId: string,
    signal?: AbortSignal,
    botId?: string,
  ): Promise<MailMessage> {
    if (typeof messageId !== 'string' || !messageId || messageId.length > 24_000)
      throw new MailAccountError('invalid_request', true);
    const account = this.access(accountId, botId);
    return this.run(account, botId, signal, (context) =>
      this.providers[account.provider].read(context, messageId),
    );
  }

  listDrafts(accountId?: string, botId?: string): MailDraft[] {
    if (accountId && botId) this.access(accountId, botId, false);
    return this.store
      .list<MailDraft>('mailDrafts')
      .filter(
        (draft) =>
          (!accountId || draft.accountId === accountId) &&
          (!botId ||
            ((!draft.botId || draft.botId === botId) && this.isAssigned(draft.accountId, botId))),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 200);
  }

  getDraft(draftId: string, botId?: string): MailDraft {
    const draft = this.store.get<MailDraft>('mailDrafts', draftId);
    if (!draft) throw new MailAccountError('not_found', true);
    if (botId) {
      this.access(draft.accountId, botId, false);
      if (draft.botId && draft.botId !== botId)
        throw new MailAccountError('account_unassigned', true);
    }
    return draft;
  }

  saveDraft(raw: MailDraftInput, draftId?: string, botId?: string): MailDraft {
    const parsed = draftSchema.safeParse(raw);
    if (!parsed.success) throw new MailAccountError('invalid_request', true);
    const input = parsed.data;
    const account = this.access(input.accountId, botId);
    const existing = draftId ? this.getDraft(draftId, botId) : undefined;
    if (
      existing &&
      (existing.status !== 'draft' ||
        existing.revision !== input.expectedRevision ||
        existing.accountId !== input.accountId)
    )
      throw new MailAccountError('stale_revision', true);
    if (!existing && input.expectedRevision !== undefined)
      throw new MailAccountError('invalid_request', true);
    const stamp = now();
    const { expectedRevision: _, ...fields } = input;
    const draft: MailDraft = {
      ...fields,
      id: existing?.id ?? id('draft'),
      from: account.address,
      accountRevision: account.revision,
      botId: existing?.botId ?? botId,
      revision: (existing?.revision ?? 0) + 1,
      status: 'draft',
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
    };
    this.store.put('mailDrafts', draft);
    this.changed();
    return draft;
  }

  async sendDraft(draftId: string, raw: MailSendOptions, signal?: AbortSignal): Promise<MailDraft> {
    const parsed = sendSchema.safeParse(raw);
    if (!parsed.success) throw new MailAccountError('invalid_request', true);
    const options = parsed.data;
    let draft = this.getDraft(draftId, options.botId);
    const receipt = this.store.get<SendReceipt>('mailSends', options.requestId);
    if (receipt) {
      if (
        receipt.draftId !== draftId ||
        receipt.draftRevision !== options.expectedRevision ||
        (options.expectedAccountRevision !== undefined &&
          receipt.accountRevision !== options.expectedAccountRevision)
      )
        throw new MailAccountError('invalid_request', true);
      if (this.sending.has(draftId)) throw new MailAccountError('busy', true);
      return draft; // Completed, failed and unknown attempts are all terminal for this UUID.
    }
    const account = this.access(draft.accountId, options.botId);
    if (
      draft.status !== 'draft' ||
      draft.revision !== options.expectedRevision ||
      draft.accountRevision !== account.revision ||
      draft.from !== account.address ||
      (options.expectedAccountRevision !== undefined &&
        options.expectedAccountRevision !== account.revision)
    )
      throw new MailAccountError('stale_revision', true);
    if (account.sendPolicy === 'deny' || (account.provider === 'imap' && !account.smtp))
      throw new MailAccountError('send_disabled', true);
    if (this.sending.has(draftId)) throw new MailAccountError('busy', true);
    if (signal?.aborted) throw new MailAccountError('cancelled', true);
    this.checkNetwork();
    this.sending.add(draftId);
    const started = now();
    const attempt: SendReceipt = {
      id: options.requestId,
      draftId,
      draftRevision: draft.revision,
      accountRevision: account.revision,
      status: 'sending',
      createdAt: started,
      updatedAt: started,
    };
    draft = { ...draft, status: 'sending', requestId: options.requestId, updatedAt: started };
    try {
      this.atomic(() => {
        this.store.put('mailSends', attempt);
        this.store.put('mailDrafts', draft);
      });
    } catch (error) {
      this.sending.delete(draftId);
      throw error;
    }
    this.changed();
    let dispatched = false;
    try {
      await this.run(account, options.botId, signal, async (context) => {
        const result = await this.providers[account.provider].send(
          {
            ...context,
            beforeSend() {
              context.check();
              dispatched = true;
            },
          },
          draft,
          options.requestId,
        );
        // An abort may already have persisted an unknown receipt and released shutdown.
        // A transport that settles late must not mutate a closed store or resume a send.
        if (context.signal.aborted) throw new MailAccountError('send_uncertain');
        if (
          typeof result.messageId !== 'string' ||
          !result.messageId ||
          result.messageId.length > 2_000 ||
          /[\r\n\0]/.test(result.messageId)
        )
          throw new MailAccountError('send_uncertain');
        const finished = now();
        draft = {
          ...draft,
          status: 'sent',
          providerMessageId: result.messageId,
          sentAt: finished,
          updatedAt: finished,
        };
        // Persist acceptance before any final permission/cancellation checks can hide the result.
        this.atomic(() => {
          this.store.put('mailSends', { ...attempt, status: 'sent', updatedAt: finished });
          this.store.put('mailDrafts', draft);
        });
      });
    } catch (error) {
      if (draft.status !== 'sent') {
        const safe = safeMailError(error);
        const uncertain = dispatched && !safe.definiteNoSend;
        const finished = now();
        draft = {
          ...draft,
          status: uncertain ? 'unknown' : 'failed',
          error: new MailAccountError(uncertain ? 'send_uncertain' : safe.code).message,
          updatedAt: finished,
        };
        this.atomic(() => {
          this.store.put('mailSends', { ...attempt, status: draft.status, updatedAt: finished });
          this.store.put('mailDrafts', draft);
        });
      }
    } finally {
      this.sending.delete(draftId);
      this.changed();
    }
    return draft;
  }

  async poll(
    accountId: string,
    cursor?: string,
    signal?: AbortSignal,
    options: MailPollOptions = {},
  ): Promise<MailPollResult> {
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 24_000))
      throw new MailAccountError('invalid_request', true);
    boundedLimit(options.limit, 20);
    if (options.since !== undefined && !Number.isFinite(Date.parse(options.since)))
      throw new MailAccountError('invalid_request', true);
    const account = this.access(accountId);
    return this.run(account, undefined, signal, (context) =>
      this.providers[account.provider].poll(context, cursor, options),
    );
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const jobs = [...this.active];
    for (const job of jobs) job.abort.abort();
    await Promise.allSettled(jobs.map((job) => job.finished));
  }

  private atomic<T>(operation: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.store.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }

  private publicAccount(account: MailAccount): MailAccount {
    const projectEndpoint = (value: NonNullable<MailAccount['smtp']>, field: 'imap' | 'smtp') => ({
      host: value.host,
      port: value.port,
      secure: value.secure,
      user: value.user,
      passwordConfigured: Boolean(this.store.secret(secretKey(account.id, field))),
    });
    return {
      id: account.id,
      name: account.name,
      address: account.address,
      provider: account.provider,
      enabled: account.enabled,
      botIds: [...account.botIds],
      sendPolicy: account.sendPolicy,
      ...(account.imap
        ? { imap: { ...projectEndpoint(account.imap, 'imap'), mailbox: account.imap.mailbox } }
        : {}),
      ...(account.smtp ? { smtp: projectEndpoint(account.smtp, 'smtp') } : {}),
      ...(account.api
        ? {
            api: {
              inboxId: account.api.inboxId,
              apiKeyConfigured: Boolean(this.store.secret(secretKey(account.id, 'api'))),
            },
          }
        : {}),
      revision: account.revision,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      ...(account.lastSyncAt ? { lastSyncAt: account.lastSyncAt } : {}),
      ...(account.lastError ? { lastError: account.lastError } : {}),
    };
  }

  private prepare(raw: MailAccountInput, accountId?: string, testing = false) {
    const parsed = accountSchema.safeParse(raw);
    if (!parsed.success) throw new MailAccountError('invalid_configuration', true);
    const input = parsed.data;
    const previous = accountId ? this.get(accountId) : undefined;
    if (
      previous &&
      input.expectedRevision !== previous.revision &&
      (!testing || input.expectedRevision !== undefined)
    )
      throw new MailAccountError('stale_revision', true);
    if (!previous && input.expectedRevision !== undefined)
      throw new MailAccountError('invalid_configuration', true);
    for (const botId of input.botIds)
      if (!this.store.get<Bot>('bots', botId))
        throw new MailAccountError('invalid_configuration', true);
    const key = previous?.id ?? id('mail');
    const sameIdentity =
      previous?.provider === input.provider &&
      previous?.address.toLowerCase() === input.address.toLowerCase();
    const imapPassword = input.imap
      ? normalizeMailPassword(
          input.imap,
          input.imap.password ??
            (sameIdentity && sameEndpoint(previous?.imap, input.imap)
              ? this.store.secret(secretKey(key, 'imap'))
              : ''),
        )
      : '';
    const smtpPassword = input.smtp
      ? normalizeMailPassword(
          { ...input.smtp, mailbox: '' },
          input.smtp.password ??
            (sameIdentity && sameEndpoint(previous?.smtp, input.smtp)
              ? this.store.secret(secretKey(key, 'smtp'))
              : ''),
        )
      : '';
    const apiKey = input.api
      ? (input.api.apiKey ??
        (sameIdentity && previous?.api?.inboxId === input.api.inboxId
          ? this.store.secret(secretKey(key, 'api'))
          : ''))
      : '';
    const stamp = now();
    const account: MailAccount = {
      id: key,
      name: input.name,
      address: input.address,
      provider: input.provider,
      enabled: input.enabled,
      botIds: input.botIds,
      sendPolicy: input.sendPolicy,
      ...(input.imap
        ? {
            imap: {
              host: input.imap.host,
              port: input.imap.port,
              secure: input.imap.secure,
              user: input.imap.user,
              mailbox: input.imap.mailbox,
              passwordConfigured: Boolean(imapPassword),
            },
          }
        : {}),
      ...(input.smtp
        ? {
            smtp: {
              host: input.smtp.host,
              port: input.smtp.port,
              secure: input.smtp.secure,
              user: input.smtp.user,
              passwordConfigured: Boolean(smtpPassword),
            },
          }
        : {}),
      ...(input.api
        ? { api: { inboxId: input.api.inboxId, apiKeyConfigured: Boolean(apiKey) } }
        : {}),
      revision: testing ? (previous?.revision ?? 1) : (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? stamp,
      updatedAt: stamp,
    };
    return { account, secrets: { imapPassword, smtpPassword, apiKey } };
  }

  private isAssigned(accountId: string, botId: string): boolean {
    const account = this.store.get<MailAccount>('mailAccounts', accountId);
    const bot = this.store.get<Bot>('bots', botId);
    return Boolean(account?.enabled && account.botIds.includes(botId) && bot?.enabled);
  }

  private access(accountId: string, botId?: string, requireEnabled = true): MailAccount {
    const account = this.get(accountId);
    if (requireEnabled && !account.enabled) throw new MailAccountError('account_disabled', true);
    if (botId && !this.isAssigned(accountId, botId))
      throw new MailAccountError('account_unassigned', true);
    return account;
  }

  private checkNetwork() {
    if (this.store.settings().permissions.network === 'deny')
      throw new MailAccountError('network_denied', true);
  }

  private validateList(options: MailListOptions) {
    boundedLimit(options.limit);
    if (
      (options.query !== undefined &&
        (typeof options.query !== 'string' ||
          options.query.length > 256 ||
          /[\r\n\0]/.test(options.query))) ||
      (options.cursor !== undefined &&
        (typeof options.cursor !== 'string' || options.cursor.length > 24_000))
    )
      throw new MailAccountError('invalid_request', true);
  }

  private async run<T>(
    account: MailAccount,
    botId: string | undefined,
    signal: AbortSignal | undefined,
    operation: (context: MailProviderContext) => Promise<T>,
    suppliedSecrets?: MailProviderContext['secrets'],
    testing = false,
  ): Promise<T> {
    if (this.closing || this.active.size >= 12) throw new MailAccountError('busy', true);
    this.checkNetwork();
    if (signal?.aborted) throw new MailAccountError('cancelled', true);
    const abort = new AbortController();
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const job = { accountId: account.id, abort, finished };
    this.active.add(job);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.adapters.timeoutMs ?? 35_000);
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const check = () => {
      if (abort.signal.aborted) throw new MailAccountError(timedOut ? 'timeout' : 'cancelled');
      this.checkNetwork();
      if (!testing) {
        const current = this.access(account.id, botId);
        if (current.revision !== account.revision)
          throw new MailAccountError('stale_revision', true);
      }
    };
    let abortListener!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(new MailAccountError(timedOut ? 'timeout' : 'cancelled'));
      abort.signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      const secrets = suppliedSecrets ?? {
        imapPassword: this.store.secret(secretKey(account.id, 'imap')),
        smtpPassword: this.store.secret(secretKey(account.id, 'smtp')),
        apiKey: this.store.secret(secretKey(account.id, 'api')),
      };
      const result = await Promise.race([
        operation({ account, secrets, signal: abort.signal, check, beforeSend: check }),
        aborted,
      ]);
      check();
      if (!testing) {
        this.store.patch<MailAccount>('mailAccounts', account.id, {
          lastSyncAt: now(),
          lastError: undefined,
        });
        this.changed();
      }
      return result;
    } catch (error) {
      const safe = timedOut ? new MailAccountError('timeout') : safeMailError(error);
      if (!testing && this.store.get<MailAccount>('mailAccounts', account.id)) {
        this.store.patch<MailAccount>('mailAccounts', account.id, { lastError: safe.message });
        this.changed();
      }
      throw safe;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      abort.signal.removeEventListener('abort', abortListener);
      this.active.delete(job);
      complete();
    }
  }
}
