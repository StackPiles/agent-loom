import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Link2 } from 'lucide-react';
import type { Automation } from '../shared/types';
import {
  GMAIL_CONNECTION,
  isGmailConnection,
  normalizeMailPassword,
  sameMailAccount,
  type MailConnectionSettings,
} from '../shared/mail-settings';
import { api, ApiError } from './api';
import { useApp } from './context';
import { Button, Field, Toggle } from './components';

export type MailFormValue = MailConnectionSettings & { password: string };

type TestState =
  { status: 'idle' | 'testing' } | { status: 'success' } | { status: 'error'; code: string };

export function MailSettings({
  value,
  onChange,
  automation,
  enabled,
}: {
  value: MailFormValue;
  onChange: (value: MailFormValue) => void;
  automation?: Automation;
  enabled: boolean;
}) {
  const { data, t } = useApp();
  const [provider, setProvider] = useState<'gmail' | 'imap'>(
    isGmailConnection(value) ? 'gmail' : 'imap',
  );
  const [testState, setTestState] = useState<TestState>({ status: 'idle' });
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const gmail = provider === 'gmail';
  const savedPassword = Boolean(
    automation?.imap?.passwordConfigured && sameMailAccount(automation.imap, value),
  );
  const denied = data.settings.permissions.network === 'deny';
  const ready = Boolean(
    value.host.trim() &&
    value.user.trim() &&
    value.mailbox.trim() &&
    Number.isInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65535 &&
    (value.password || savedPassword),
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current++;
      request.current?.abort();
      request.current = null;
    };
  }, []);

  function invalidate() {
    revision.current++;
    request.current?.abort();
    request.current = null;
    setTestState({ status: 'idle' });
  }

  function update(patch: Partial<MailFormValue>) {
    invalidate();
    const next = { ...value, ...patch };
    // A credential entered for one server/account never follows an identity edit.
    if (
      value.host.trim().toLowerCase() !== next.host.trim().toLowerCase() ||
      value.port !== next.port ||
      value.secure !== next.secure ||
      value.user.trim() !== next.user.trim()
    )
      next.password = '';
    onChange(next);
  }

  async function testConnection() {
    if (request.current || !ready || denied) return;
    const owner = ++revision.current;
    const controller = new AbortController();
    request.current = controller;
    setTestState({ status: 'testing' });
    const { password, ...connection } = value;
    try {
      await api<{ ok: true; host: string; user: string; mailbox: string }>(
        '/mail/test',
        'POST',
        {
          ...(automation?.id ? { automationId: automation.id } : {}),
          imap: {
            ...connection,
            ...(password ? { password: normalizeMailPassword(connection, password) } : {}),
          },
        },
        AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]),
      );
      if (mounted.current && owner === revision.current && !controller.signal.aborted)
        setTestState({ status: 'success' });
    } catch (error) {
      if (mounted.current && owner === revision.current && !controller.signal.aborted) {
        const code =
          error instanceof ApiError
            ? error.code || 'connection_failed'
            : error instanceof Error && error.name === 'TimeoutError'
              ? 'timeout'
              : 'connection_failed';
        setTestState({ status: 'error', code });
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  const errors: Record<string, string> = {
    network_denied: t(
      'ネットワーク権限が「拒否」になっています。設定を変更してから再試行してください。',
      'Network access is denied. Change the permission in Settings before retrying.',
    ),
    credentials_required: t(
      'このメールアカウントのアプリパスワードを入力してください。',
      'Enter an app password for this email account.',
    ),
    authentication_failed: gmail
      ? t(
          'Gmailに認証できませんでした。メールアドレスと、Googleで発行したアプリパスワードを確認してください。',
          'Gmail could not authenticate. Check the full email address and the app password issued by Google.',
        )
      : t(
          'メールサーバーに認証できませんでした。ユーザー名とパスワードを確認してください。',
          'The mail server could not authenticate. Check the username and password.',
        ),
    mailbox_unavailable: t(
      '指定したメールボックスを開けませんでした。メールボックス名を確認してください。',
      'The mailbox could not be opened. Check its name.',
    ),
    timeout: t(
      '接続確認がタイムアウトしました。ネットワークとメールサーバーを確認してください。',
      'The connection test timed out. Check the network and mail server.',
    ),
    busy: t(
      '別のメール接続を確認中です。完了してから再試行してください。',
      'Another mail connection is being tested. Try again after it finishes.',
    ),
    invalid_configuration: t(
      'メールの接続設定を確認してください。',
      'Check the mail connection settings.',
    ),
    connection_failed: t(
      '接続できませんでした。ネットワーク、接続先、TLS設定を確認してください。',
      'Could not connect. Check the network, server, and TLS settings.',
    ),
  };

  return (
    <section
      className="form-subsection mail-settings"
      aria-label={t('メール受信設定', 'Mail connection')}
    >
      <Field label={t('メールサービス', 'Email service')}>
        <select
          value={provider}
          onChange={(event) => {
            const next = event.target.value as 'gmail' | 'imap';
            setProvider(next);
            update({
              ...(next === 'gmail'
                ? GMAIL_CONNECTION
                : { host: '', port: 993, secure: true, mailbox: 'INBOX' }),
              password: '',
            });
          }}
        >
          <option value="gmail">Gmail / Google Workspace</option>
          <option value="imap">{t('その他のIMAP', 'Other IMAP')}</option>
        </select>
      </Field>
      {gmail && (
        <div className="mail-gmail-setup">
          <p>
            {t(
              'Googleの2段階認証を有効にし、Agent Loom用のアプリパスワードを発行してください。',
              'Turn on Google 2-Step Verification, then create an app password for Agent Loom.',
            )}
          </p>
          <div className="mail-setup-links">
            <a
              href="https://myaccount.google.com/signinoptions/two-step-verification"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('2段階認証', '2-Step Verification')}
            </a>
            <a
              href="https://myaccount.google.com/apppasswords"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('アプリパスワードを発行', 'Create an app password')}
            </a>
          </div>
          <p className="field-hint">
            {t(
              'アカウントや組織のポリシーによって利用できない場合があります。',
              'Availability depends on your account and organization policy.',
            )}{' '}
            <a
              href="https://support.google.com/accounts/answer/185833"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('Googleの案内', 'Google help')}
            </a>
          </p>
        </div>
      )}
      {!gmail && (
        <div className="form-grid">
          <Field label={t('ホスト', 'Host')}>
            <input
              required
              value={value.host}
              onChange={(e) => update({ host: e.target.value })}
              placeholder="imap.example.com"
            />
          </Field>
          <Field label={t('ポート', 'Port')}>
            <input
              type="number"
              required
              min={1}
              max={65535}
              value={value.port}
              onChange={(e) => update({ port: Number(e.target.value) })}
            />
          </Field>
        </div>
      )}
      <Field label={gmail ? t('メールアドレス', 'Email address') : t('ユーザー名', 'Username')}>
        <input
          required
          type={gmail ? 'email' : 'text'}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={value.user}
          onChange={(e) => update({ user: e.target.value })}
          placeholder={gmail ? 'you@gmail.com' : undefined}
        />
      </Field>
      <Field
        label={t('アプリパスワード', 'App password')}
        hint={
          savedPassword
            ? t(
                '設定済み。空欄なら、このアカウントの現在の値を保持します。',
                'Already configured. Leave blank to keep this account’s saved password.',
              )
            : gmail
              ? t(
                  'Googleアカウントの通常のパスワードは使えません。発行された16文字を貼り付けてください。',
                  'Use the 16-character app password, not your regular Google account password.',
                )
              : t(
                  'メールサービスで発行したIMAP用のパスワードを入力してください。',
                  'Use an IMAP app password from your email provider.',
                )
        }
      >
        <input
          type="password"
          autoComplete="new-password"
          required={enabled && !savedPassword}
          value={value.password}
          onChange={(e) => update({ password: normalizeMailPassword(value, e.target.value) })}
          spellCheck={false}
          autoCapitalize="none"
        />
      </Field>
      {gmail ? (
        <details className="mail-advanced">
          <summary>{t('接続の詳細', 'Connection details')}</summary>
          <p className="field-hint">imap.gmail.com · 993 · TLS</p>
          <Field label={t('メールボックス', 'Mailbox')}>
            <input
              required
              value={value.mailbox}
              onChange={(e) => update({ mailbox: e.target.value })}
            />
          </Field>
        </details>
      ) : (
        <>
          <Field label={t('メールボックス', 'Mailbox')}>
            <input
              required
              value={value.mailbox}
              onChange={(e) => update({ mailbox: e.target.value })}
            />
          </Field>
          <Toggle
            checked={value.secure}
            onChange={(secure) => update({ secure })}
            label={t('TLS接続', 'TLS connection')}
          />
        </>
      )}
      <div className="mail-test">
        <Button
          type="button"
          icon={Link2}
          busy={testState.status === 'testing'}
          disabled={!ready || denied}
          onClick={() => void testConnection()}
        >
          {testState.status === 'testing'
            ? t('接続を確認中…', 'Testing connection…')
            : t('接続をテスト', 'Test connection')}
        </Button>
        <p className="field-hint">
          {t(
            '接続確認だけを行います。設定の保存やメールの処理は行いません。',
            'Tests the connection without saving settings or processing mail.',
          )}
        </p>
      </div>
      <div aria-live="polite" aria-atomic="true">
        {testState.status === 'success' && (
          <p className="mail-test-success" role="status">
            <CheckCircle2 size={16} aria-hidden="true" />
            {t(
              '受信箱に接続できました。保存すると設定が反映されます。',
              'Connected to the mailbox. Save to apply these settings.',
            )}
          </p>
        )}
        {testState.status === 'error' && (
          <p className="form-error" role="alert">
            {errors[testState.code] || errors.connection_failed}
          </p>
        )}
      </div>
      {denied && <p className="field-hint">{errors.network_denied}</p>}
      <p className="field-hint mail-receive-limits">
        {t(
          '初回チェックで既存メールを基準にします。その後は1回に最大20通の送信者・件名・日時を取得します。本文・添付の取得や既読化は行いません。',
          'The first poll records existing mail as a baseline. Later polls read sender, subject, and date for up to 20 new messages. Bodies, attachments, and read status are unchanged.',
        )}
      </p>
      {!enabled && !savedPassword && !value.password && (
        <p className="field-hint">
          {t(
            'パスワード未設定のまま下書きを保存できます。有効にする前に入力してください。',
            'You can save a disabled draft without a password. Add one before enabling it.',
          )}
        </p>
      )}
    </section>
  );
}
