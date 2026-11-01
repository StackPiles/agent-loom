/** Mail connection fields shared by the editor, credential store and test endpoint. */
export interface MailConnectionSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  mailbox: string;
}

export const GMAIL_CONNECTION = {
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  mailbox: 'INBOX',
} as const;

export function isGmailConnection(config?: Partial<MailConnectionSettings>): boolean {
  return Boolean(
    config &&
    config.host?.trim().toLowerCase() === GMAIL_CONNECTION.host &&
    config.port === GMAIL_CONNECTION.port &&
    config.secure === GMAIL_CONNECTION.secure,
  );
}

/** Google displays app passwords in groups; other providers' passwords stay literal. */
export function normalizeMailPassword(
  config: Partial<MailConnectionSettings>,
  password: string,
): string {
  const gmailSmtp =
    config.host?.trim().toLowerCase() === 'smtp.gmail.com' &&
    ((config.port === 465 && config.secure === true) ||
      (config.port === 587 && config.secure === false));
  return isGmailConnection(config) || gmailSmtp ? password.replace(/\s/g, '') : password;
}

/** A stored credential may only follow the same transport endpoint and account. */
export function sameMailAccount(
  left?: Partial<MailConnectionSettings>,
  right?: Partial<MailConnectionSettings>,
): boolean {
  return Boolean(
    left &&
    right &&
    left.host &&
    left.user &&
    left.host.trim().toLowerCase() === right.host?.trim().toLowerCase() &&
    left.port === right.port &&
    left.secure === right.secure &&
    left.user.trim() === right.user?.trim(),
  );
}

export type MailTestErrorCode =
  | 'invalid_configuration'
  | 'network_denied'
  | 'credentials_required'
  | 'authentication_failed'
  | 'mailbox_unavailable'
  | 'connection_failed'
  | 'timeout'
  | 'busy';

export interface MailTestResult {
  ok: true;
  host: string;
  user: string;
  mailbox: string;
}
