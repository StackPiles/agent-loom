import { createHash } from 'node:crypto';
import type {
  MailAccount,
  MailAccountErrorCode,
  MailAddress,
  MailDraft,
  MailListOptions,
  MailListResult,
  MailMessage,
  MailPollOptions,
  MailPollResult,
} from '../../shared/mail-accounts.js';

export const MAX_MAIL_TEXT = 65_536;
export const MAX_MAIL_SOURCE = 1_000_000;
export const MAX_MAIL_PAGE = 50;
export const MAX_POLL_PAGE = 20;

const messages: Record<MailAccountErrorCode, string> = {
  invalid_configuration: 'Check the mail provider, address and connection settings.',
  not_found: 'The mail account, message or draft was not found.',
  account_disabled: 'This mail account is disabled.',
  account_unassigned: 'This bot is not assigned to this mail account.',
  network_denied: 'Mail connections are disabled by the network permission in Settings.',
  credentials_required:
    'Enter credentials for this connection. Saved credentials are only reused for their original account and server.',
  authentication_failed:
    'The mail provider rejected authentication or access. Check the credentials and their permissions.',
  connection_failed:
    'The mail provider could not be reached securely. Check the connection and TLS settings.',
  mailbox_unavailable: 'The configured mailbox could not be opened.',
  provider_mismatch: 'The configured address does not match this provider inbox.',
  message_too_large: 'This message exceeds the bounded mail reader limit.',
  send_disabled: 'Sending is disabled for this mail account.',
  stale_revision:
    'The account or draft changed. Reload it and review the current recipients and content.',
  busy: 'This mail operation is already running. Wait for it to finish.',
  timeout: 'The mail operation timed out.',
  cancelled: 'The mail operation was cancelled.',
  send_uncertain:
    'The provider may have accepted this message. Check the external mailbox before creating a new send; Loom will not retry this attempt.',
  invalid_request: 'The mail request or message locator is invalid.',
  rate_limited: 'The mail provider temporarily limited requests. Try again later.',
};

/** Provider diagnostics can contain passwords and message bodies; never expose them. */
export class MailAccountError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: MailAccountErrorCode,
    readonly definiteNoSend = false,
  ) {
    super(messages[code]);
    this.name = 'MailAccountError';
    this.statusCode =
      code === 'not_found'
        ? 404
        : ['network_denied', 'account_unassigned', 'account_disabled', 'send_disabled'].includes(
              code,
            )
          ? 403
          : ['busy', 'stale_revision', 'send_uncertain'].includes(code)
            ? 409
            : code === 'rate_limited'
              ? 429
              : code === 'timeout'
                ? 504
                : 400;
  }
}

export interface MailProviderContext {
  account: MailAccount;
  secrets: { imapPassword: string; smtpPassword: string; apiKey: string };
  signal: AbortSignal;
  /** Recheck current account revision, assignment and network permission before each request. */
  check(): void;
  /** Call immediately before the one operation capable of delivering an email. */
  beforeSend(): void;
}

export interface MailProviderAdapter {
  test(context: MailProviderContext): Promise<{ send: boolean }>;
  list(context: MailProviderContext, options: MailListOptions): Promise<MailListResult>;
  read(context: MailProviderContext, messageId: string): Promise<MailMessage>;
  send(
    context: MailProviderContext,
    draft: MailDraft,
    requestId: string,
  ): Promise<{ messageId: string }>;
  poll(
    context: MailProviderContext,
    cursor: string | undefined,
    options: MailPollOptions,
  ): Promise<MailPollResult>;
}

export function safeMailError(error: unknown): MailAccountError {
  if (error instanceof MailAccountError) return error;
  const detail =
    error && typeof error === 'object'
      ? (error as {
          authenticationFailed?: unknown;
          code?: unknown;
          serverResponseCode?: unknown;
          responseCode?: unknown;
        })
      : {};
  if (
    detail.authenticationFailed ||
    detail.code === 'EAUTH' ||
    ['AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'LOGINFAILED'].includes(
      String(detail.serverResponseCode),
    )
  )
    return new MailAccountError('authentication_failed', true);
  if (detail.code === 'EMESSAGE' || detail.code === 'EENVELOPE')
    return new MailAccountError('invalid_request', true);
  return new MailAccountError('connection_failed');
}

export function boundedLimit(limit: number | undefined, max = MAX_MAIL_PAGE): number {
  if (limit === undefined) return Math.min(20, max);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max)
    throw new MailAccountError('invalid_request', true);
  return limit;
}

/** Identifiers include source identity so old locators cannot target a different mailbox after edits. */
export function accountSource(account: MailAccount): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        account.id,
        account.provider,
        account.address.toLowerCase(),
        account.imap?.host,
        account.imap?.port,
        account.imap?.secure,
        account.imap?.user,
        account.imap?.mailbox,
        account.api?.inboxId,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

export function encodeOpaque(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeOpaque(value: string): Record<string, unknown> {
  if (!value || value.length > 24_000 || !/^[a-zA-Z0-9_-]+$/.test(value))
    throw new MailAccountError('invalid_request', true);
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new MailAccountError('invalid_request', true);
  }
}

export function locator(account: MailAccount, fields: object): string {
  return encodeOpaque({ v: 1, source: accountSource(account), ...fields });
}

export function parseLocator(account: MailAccount, value: string): Record<string, unknown> {
  const parsed = decodeOpaque(value);
  if (parsed.v !== 1 || parsed.source !== accountSource(account))
    throw new MailAccountError('invalid_request', true);
  return parsed;
}

export function cleanHeader(value: unknown, max = 2_000): string {
  return typeof value === 'string' ? value.replace(/[\r\n\0]/g, ' ').slice(0, max) : '';
}

export function normalizeAddresses(values: unknown): MailAddress[] {
  const all = Array.isArray(values) ? values : [values];
  return all.slice(0, 100).flatMap((value): MailAddress[] => {
    if (!value) return [];
    if (typeof value === 'object' && !Array.isArray(value)) {
      const item = value as { address?: unknown; name?: unknown };
      const address = cleanHeader(item.address, 320).trim();
      return address
        ? [{ address, ...(item.name ? { name: cleanHeader(item.name, 250) } : {}) }]
        : [];
    }
    const raw = cleanHeader(value, 700).trim();
    if (!raw) return [];
    const match = /^(.*?)\s*<([^<>]+)>$/.exec(raw);
    if (!match) return [{ address: raw.slice(0, 320) }];
    const name = match[1].trim().replace(/^"|"$/g, '');
    return [
      { address: match[2].trim().slice(0, 320), ...(name ? { name: name.slice(0, 250) } : {}) },
    ];
  });
}

export function safeDate(value: unknown, fallback = new Date(0).toISOString()): string {
  const stamp =
    value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : fallback;
}

/** HTML is converted to inert text; no URLs, images, CSS or attachments are loaded. */
export function plainBody(text: unknown, html?: unknown): { text: string; truncated: boolean } {
  const raw =
    typeof text === 'string' && (text.length > 0 || typeof html !== 'string')
      ? text
      : typeof html === 'string'
        ? html
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/&amp;/gi, '&')
        : '';
  return {
    text: raw.replace(/\0/g, '').slice(0, MAX_MAIL_TEXT),
    truncated: raw.length > MAX_MAIL_TEXT,
  };
}

export function safeReference(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 998 || /[\r\n\0]/.test(value)) return undefined;
  return /^<[^<>\s]+@[^<>\s]+>$/.test(value) ? value : undefined;
}

export function initialSince(account: MailAccount, options: MailPollOptions): string {
  const since = options.since ?? account.createdAt;
  if (!Number.isFinite(Date.parse(since))) throw new MailAccountError('invalid_request', true);
  return new Date(since).toISOString();
}

export async function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
  close?: () => void,
): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => {
      try {
        close?.();
      } catch {
        /* transport already closed */
      }
      reject(new MailAccountError('cancelled'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
