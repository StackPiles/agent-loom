/** Mail hosts are external. These are connection records, never provisioned mailboxes. */
export type MailProvider = 'imap' | 'agentmail' | 'resend';
export type MailSendPolicy = 'ask' | 'allow' | 'deny';
export interface MailEndpoint {
  host: string;
  port: number;
  /** false requires STARTTLS; it never permits clear-text authentication. */
  secure: boolean;
  user: string;
  passwordConfigured: boolean;
}
export interface MailAccount {
  id: string;
  name: string;
  address: string;
  provider: MailProvider;
  enabled: boolean;
  botIds: string[];
  sendPolicy: MailSendPolicy;
  imap?: MailEndpoint & { mailbox: string };
  smtp?: MailEndpoint;
  api?: { inboxId: string; apiKeyConfigured: boolean };
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastSyncAt?: string;
  lastError?: string;
}
export interface MailAccountInput {
  name: string;
  address: string;
  provider: MailProvider;
  enabled?: boolean;
  botIds?: string[];
  sendPolicy?: MailSendPolicy;
  imap?: Omit<MailEndpoint, 'passwordConfigured'> & { mailbox: string; password?: string };
  smtp?: Omit<MailEndpoint, 'passwordConfigured'> & { password?: string };
  api?: { inboxId: string; apiKey?: string };
  expectedRevision?: number;
}
export interface MailAddress {
  address: string;
  name?: string;
}
export interface MailAttachmentInfo {
  filename: string;
  contentType: string;
  size: number;
}
export interface MailMessageSummary {
  /** Opaque locator, scoped to its account. Pass it back unchanged. */
  id: string;
  accountId: string;
  folder: string;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc?: MailAddress[];
  date: string;
  preview?: string;
  unread?: boolean;
  messageId?: string;
  threadId?: string;
}
export interface MailMessage extends MailMessageSummary {
  text: string;
  replyTo?: MailAddress[];
  references?: string[];
  attachments?: MailAttachmentInfo[];
  truncated: boolean;
}
export interface MailListOptions {
  query?: string;
  cursor?: string;
  limit?: number;
}
export interface MailListResult {
  messages: MailMessageSummary[];
  nextCursor?: string;
}
export interface MailPollOptions {
  since?: string;
  limit?: number;
}
export interface MailPollResult {
  messages: MailMessageSummary[];
  cursor: string;
  /** Synchronization initialized/reset its checkpoint. Returned messages are still new. */
  baseline: boolean;
  hasMore?: boolean;
  /** Existing IMAP UIDs became incomparable. Current history was checkpointed without replay. */
  reset?: 'uidvalidity_changed';
}
export type MailDraftStatus = 'draft' | 'sending' | 'sent' | 'unknown' | 'failed';
export interface MailDraftInput {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  replyToMessageId?: string;
  expectedRevision?: number;
}
export interface MailDraft {
  id: string;
  accountId: string;
  accountRevision: number;
  botId?: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  replyToMessageId?: string;
  revision: number;
  status: MailDraftStatus;
  requestId?: string;
  providerMessageId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}
export interface MailSendOptions {
  requestId: string;
  expectedRevision: number;
  expectedAccountRevision?: number;
  botId?: string;
}
export interface MailAccountTestResult {
  ok: true;
  provider: MailProvider;
  address: string;
  receive: true;
  send: boolean;
}
export type MailAccountErrorCode =
  | 'invalid_configuration'
  | 'not_found'
  | 'account_disabled'
  | 'account_unassigned'
  | 'network_denied'
  | 'credentials_required'
  | 'authentication_failed'
  | 'connection_failed'
  | 'mailbox_unavailable'
  | 'provider_mismatch'
  | 'message_too_large'
  | 'send_disabled'
  | 'stale_revision'
  | 'busy'
  | 'timeout'
  | 'cancelled'
  | 'send_uncertain'
  | 'invalid_request'
  | 'rate_limited';
