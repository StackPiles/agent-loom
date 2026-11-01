import type { MailAddress, MailProvider } from '../shared/mail-accounts';
import { ApiError } from './api';

export const providerName = (provider: MailProvider) =>
  provider === 'imap' ? 'IMAP / SMTP' : provider === 'agentmail' ? 'AgentMail' : 'Resend';
export const mailAddresses = (addresses: MailAddress[] = []) =>
  addresses.map((item) => (item.name ? `${item.name} <${item.address}>` : item.address)).join(', ');

export function newMailRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Authenticated HTTP LAN installs still expose getRandomValues.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function mailErrorText(error: unknown, t: (ja: string, en: string) => string): string {
  const code =
    error instanceof ApiError
      ? error.code
      : error instanceof Error && error.name === 'TimeoutError'
        ? 'timeout'
        : undefined;
  const errors: Record<string, [string, string]> = {
    invalid_configuration: [
      'メールのアドレスと接続設定を確認してください。',
      'Check the email address and connection settings.',
    ],
    credentials_required: [
      'この接続先の認証情報を入力してください。接続先やアカウントを変更した場合は再入力が必要です。',
      'Enter credentials for this connection. Changing the endpoint or account requires new credentials.',
    ],
    authentication_failed: [
      '認証できませんでした。ユーザー名、パスワードまたはAPIキーを確認してください。',
      'Authentication failed. Check the username, password or API key.',
    ],
    connection_failed: [
      '安全な接続を確立できませんでした。接続先、TLS設定、ネットワークを確認してください。',
      'Could not establish a secure connection. Check the endpoint, TLS settings and network.',
    ],
    mailbox_unavailable: [
      '受信箱を開けませんでした。受信箱名またはIDと利用権限を確認してください。',
      'Could not open the mailbox. Check its name or ID and access permissions.',
    ],
    provider_mismatch: [
      '受信箱とメールアドレスが一致しません。提供元の設定を確認してください。',
      'The inbox and email address do not match. Check the provider settings.',
    ],
    network_denied: [
      'ネットワーク権限が「拒否」になっています。設定から変更できます。',
      'Network access is denied. You can change the permission in Settings.',
    ],
    account_disabled: [
      'このメール接続は停止中です。接続設定から有効にしてください。',
      'This mail connection is disabled. Enable it in the account settings.',
    ],
    account_unassigned: [
      'このボットにはメールアカウントが割り当てられていません。',
      'This email account is not assigned to the bot.',
    ],
    send_disabled: [
      'このメールアカウントは送信できません。送信接続と権限を確認してください。',
      'Sending is disabled for this account. Check the sending connection and permission.',
    ],
    stale_revision: [
      '設定または下書きが更新されました。最新の内容を開き直して確認してください。',
      'The account or draft has changed. Reopen it and review the latest version.',
    ],
    message_too_large: [
      'このメールは取得できるサイズを超えています。メールサービス側で開いてください。',
      'This message exceeds the retrieval limit. Open it with your email provider.',
    ],
    timeout: [
      '接続がタイムアウトしました。ネットワークと接続先を確認してください。',
      'The connection timed out. Check the network and provider.',
    ],
    busy: [
      'このアカウントで別の処理が進行中です。完了後に再試行してください。',
      'Another operation is using this account. Try again after it finishes.',
    ],
    rate_limited: [
      'メールサービスの利用上限に達しました。時間を置いて再試行してください。',
      'The provider rate limit was reached. Try again later.',
    ],
    not_found: [
      'この項目は見つかりません。最新の一覧を読み込んでください。',
      'This item was not found. Reload the latest list.',
    ],
    invalid_request: [
      '宛先、件名、本文などの入力内容を確認してください。',
      'Check the recipients, subject and message contents.',
    ],
    send_uncertain: [
      '送信結果を確認できませんでした。メールサービス側の履歴を確認してください。',
      'The send result is uncertain. Check the history at your email provider.',
    ],
    cancelled: ['接続がキャンセルされました。', 'The connection was cancelled.'],
  };
  const entry = code ? errors[code] : undefined;
  return entry
    ? t(...entry)
    : t(
        '処理を完了できませんでした。接続状態を確認してから再試行してください。',
        'The operation could not be completed. Check the connection before trying again.',
      );
}
