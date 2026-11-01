import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Link2 } from 'lucide-react';
import type {
  MailAccount,
  MailAccountInput,
  MailEndpoint,
  MailProvider,
} from '../shared/mail-accounts';
import { mailApi } from './api';
import { useApp } from './context';
import { Avatar, Button, Field, Modal, Toggle } from './components';
import { mailErrorText } from './mail-ui';

type EndpointInput = Omit<MailEndpoint, 'passwordConfigured'> & { password?: string };
const emptyImap = () => ({
  host: '',
  port: 993,
  secure: true,
  user: '',
  mailbox: 'INBOX',
  password: '',
});
const emptySmtp = () => ({ host: '', port: 465, secure: true, user: '', password: '' });
function endpointIdentity(value?: Pick<MailEndpoint, 'host' | 'port' | 'secure' | 'user'>) {
  return value
    ? JSON.stringify([value.host.trim().toLowerCase(), value.port, value.secure, value.user.trim()])
    : '';
}
function editEndpoint(value: MailEndpoint): EndpointInput {
  return {
    host: value.host,
    port: value.port,
    secure: value.secure,
    user: value.user,
    password: '',
  };
}
function serialize(input: MailAccountInput): MailAccountInput {
  const result = { ...input, name: input.name.trim(), address: input.address.trim() };
  if (result.imap) {
    const { password, ...settings } = result.imap;
    result.imap = { ...settings, ...(password ? { password } : {}) };
  }
  if (result.smtp) {
    const { password, ...settings } = result.smtp;
    result.smtp = { ...settings, ...(password ? { password } : {}) };
  }
  if (result.api) {
    const { apiKey, ...settings } = result.api;
    result.api = { ...settings, ...(apiKey ? { apiKey } : {}) };
  }
  return result;
}

export function MailAccountEditor({
  account,
  onClose,
  onSaved,
}: {
  account?: MailAccount;
  onClose: () => void;
  onSaved?: (account: MailAccount) => void;
}) {
  const { data, t, refresh, toast } = useApp();
  const [value, setValue] = useState<MailAccountInput>(() => ({
    name: account?.name || '',
    address: account?.address || '',
    provider: account?.provider || 'imap',
    enabled: account?.enabled ?? true,
    botIds: account?.botIds || [],
    sendPolicy: account?.sendPolicy || 'ask',
    ...(account?.provider && account.provider !== 'imap'
      ? { api: { inboxId: account.api?.inboxId || '', apiKey: '' } }
      : {
          imap: account?.imap
            ? { ...editEndpoint(account.imap), mailbox: account.imap.mailbox }
            : emptyImap(),
          ...(account?.smtp ? { smtp: editEndpoint(account.smtp) } : {}),
        }),
    ...(account ? { expectedRevision: account.revision } : {}),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [test, setTest] = useState<{
    status: 'idle' | 'testing' | 'success' | 'error';
    message?: string;
  }>({ status: 'idle' });
  const pendingTest = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const submitting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
      pendingTest.current?.abort();
    };
  }, []);
  const originalIdentity =
    account?.provider === value.provider && account?.address.trim() === value.address.trim();
  const retainedImap = Boolean(
    originalIdentity &&
    account?.imap?.passwordConfigured &&
    endpointIdentity(account.imap) === endpointIdentity(value.imap),
  );
  const retainedSmtp = Boolean(
    originalIdentity &&
    account?.smtp?.passwordConfigured &&
    endpointIdentity(account.smtp) === endpointIdentity(value.smtp),
  );
  const retainedApi = Boolean(
    originalIdentity &&
    account?.api?.apiKeyConfigured &&
    account.api.inboxId === value.api?.inboxId,
  );
  const denied = data.settings.permissions.network === 'deny';
  const endpointReady = (entry: EndpointInput | undefined, retained: boolean) =>
    Boolean(
      entry?.host.trim() &&
      entry.user.trim() &&
      entry.port >= 1 &&
      entry.port <= 65535 &&
      (entry.password || retained),
    );
  const ready = Boolean(
    value.name.trim() &&
    value.address.trim() &&
    (value.provider === 'imap'
      ? endpointReady(value.imap, retainedImap) &&
        value.imap?.mailbox.trim() &&
        (!value.smtp || endpointReady(value.smtp, retainedSmtp))
      : value.api?.inboxId.trim() && (value.api.apiKey || retainedApi)),
  );
  function update(patch: Partial<MailAccountInput>) {
    const next = { ...value, ...patch };
    const allChanged =
      next.provider !== value.provider || next.address.trim() !== value.address.trim();
    if (next.imap && (allChanged || endpointIdentity(next.imap) !== endpointIdentity(value.imap)))
      next.imap = { ...next.imap, password: '' };
    if (next.smtp && (allChanged || endpointIdentity(next.smtp) !== endpointIdentity(value.smtp)))
      next.smtp = { ...next.smtp, password: '' };
    if (next.api && (allChanged || next.api.inboxId !== value.api?.inboxId))
      next.api = { ...next.api, apiKey: '' };
    sequence.current++;
    pendingTest.current?.abort();
    pendingTest.current = null;
    setTest({ status: 'idle' });
    setError('');
    setValue(next);
  }
  async function testConnection() {
    if (pendingTest.current || !ready || denied || busy) return;
    const owner = ++sequence.current;
    const controller = new AbortController();
    pendingTest.current = controller;
    setTest({ status: 'testing' });
    try {
      const result = await mailApi.test(
        serialize(value),
        account?.id,
        AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
      );
      if (mounted.current && sequence.current === owner && !controller.signal.aborted)
        setTest({
          status: 'success',
          message:
            result.provider === 'imap' && result.send
              ? t(
                  '受信・送信の接続を確認しました。メールは送信していません。',
                  'Receiving and sending connections verified. No email was sent.',
                )
              : t(
                  '受信箱に接続できました。メールは送信していません。',
                  'Connected to the mailbox. No email was sent.',
                ),
        });
    } catch (caught) {
      if (mounted.current && sequence.current === owner && !controller.signal.aborted)
        setTest({ status: 'error', message: mailErrorText(caught, t) });
    } finally {
      if (pendingTest.current === controller) pendingTest.current = null;
    }
  }
  return (
    <Modal
      wide
      title={
        account
          ? t('メールアカウントの設定', 'Email account settings')
          : t('メールアカウントを接続', 'Connect email account')
      }
      description={t(
        'メールサービスや自営サーバーで作成した、既存の受信箱を接続します。',
        'Connect an existing mailbox from your email provider or your own server.',
      )}
      onClose={onClose}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current) return;
          submitting.current = true;
          setBusy(true);
          setError('');
          sequence.current++;
          pendingTest.current?.abort();
          pendingTest.current = null;
          try {
            const saved = await mailApi.saveAccount(serialize(value), account?.id);
            await refresh().catch(() => {});
            toast(t('メール接続を保存しました', 'Email connection saved'));
            if (mounted.current) {
              onSaved?.(saved);
              onClose();
            }
          } catch (caught) {
            if (mounted.current) setError(mailErrorText(caught, t));
          } finally {
            submitting.current = false;
            if (mounted.current) setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy} className="account-fields">
          <div className="form-grid">
            <Field label={t('表示名', 'Display name')}>
              <input
                required
                maxLength={120}
                value={value.name}
                onChange={(event) => update({ name: event.target.value })}
                placeholder={t('例：Asterのメール', 'e.g. Aster mail')}
              />
            </Field>
            <Field label={t('メールアドレス', 'Email address')}>
              <input
                required
                type="email"
                maxLength={254}
                value={value.address}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) =>
                  update({
                    address: event.target.value,
                    ...(value.imap && (!value.imap.user || value.imap.user === value.address)
                      ? { imap: { ...value.imap, user: event.target.value } }
                      : {}),
                    ...(value.smtp && (!value.smtp.user || value.smtp.user === value.address)
                      ? { smtp: { ...value.smtp, user: event.target.value } }
                      : {}),
                  })
                }
                placeholder="aster@bots.example.com"
              />
            </Field>
          </div>
          <Field label={t('接続方式', 'Connection type')}>
            <select
              value={value.provider}
              onChange={(event) => {
                const provider = event.target.value as MailProvider;
                update({
                  provider,
                  imap: provider === 'imap' ? { ...emptyImap(), user: value.address } : undefined,
                  smtp: undefined,
                  api: provider === 'imap' ? undefined : { inboxId: '', apiKey: '' },
                });
              }}
            >
              <option value="imap">IMAP / SMTP</option>
              <option value="agentmail">AgentMail</option>
              <option value="resend">Resend Inboxes</option>
            </select>
          </Field>
          {value.provider === 'imap' && value.imap ? (
            <>
              <div className="account-preset-row">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    update({
                      imap: {
                        host: 'imap.gmail.com',
                        port: 993,
                        secure: true,
                        user: value.address,
                        mailbox: 'INBOX',
                        password: '',
                      },
                      smtp: {
                        host: 'smtp.gmail.com',
                        port: 465,
                        secure: true,
                        user: value.address,
                        password: '',
                      },
                    })
                  }
                >
                  {t('Gmailの接続設定を使う', 'Use Gmail connection settings')}
                </Button>
              </div>
              <section className="account-settings-section">
                <h3>{t('受信 · IMAP', 'Receiving · IMAP')}</h3>
                <EndpointEditor
                  kind="IMAP"
                  value={value.imap}
                  onChange={(imap) => update({ imap: { ...value.imap!, ...imap } })}
                  retained={retainedImap}
                  required={!!value.enabled}
                />
                <Field label={t('受信フォルダー', 'Receiving folder')}>
                  <input
                    required
                    maxLength={250}
                    value={value.imap.mailbox}
                    onChange={(event) =>
                      update({ imap: { ...value.imap!, mailbox: event.target.value } })
                    }
                  />
                </Field>
              </section>
              <section className="account-settings-section">
                <Toggle
                  label={t('SMTPでの送信を設定', 'Configure SMTP sending')}
                  checked={!!value.smtp}
                  onChange={(enabled) =>
                    update({ smtp: enabled ? { ...emptySmtp(), user: value.address } : undefined })
                  }
                />
                {value.smtp && (
                  <EndpointEditor
                    kind="SMTP"
                    value={value.smtp}
                    onChange={(smtp) => update({ smtp })}
                    retained={retainedSmtp}
                    required={!!value.enabled}
                  />
                )}
              </section>
            </>
          ) : (
            value.api && (
              <section className="account-settings-section">
                <Field
                  label={t('受信箱ID', 'Inbox ID')}
                  hint={
                    value.provider === 'agentmail'
                      ? t(
                          'AgentMailで作成済みの受信箱IDを指定します。',
                          'Use an inbox ID already created in AgentMail.',
                        )
                      : t(
                          'Resend Inboxesで作成済みの受信箱IDを指定します。',
                          'Use an inbox ID already created in Resend Inboxes.',
                        )
                  }
                >
                  <input
                    required
                    maxLength={500}
                    value={value.api.inboxId}
                    onChange={(event) =>
                      update({ api: { ...value.api!, inboxId: event.target.value } })
                    }
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label={t('APIキー', 'API key')}
                  hint={
                    retainedApi
                      ? t(
                          '設定済み。空欄なら現在のキーを保持します。',
                          'Configured. Leave blank to keep the existing key.',
                        )
                      : t(
                          'この受信箱へアクセスできるキーを入力してください。',
                          'Enter a key with access to this inbox.',
                        )
                  }
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    maxLength={4096}
                    required={!!value.enabled && !retainedApi}
                    value={value.api.apiKey || ''}
                    onChange={(event) =>
                      update({ api: { ...value.api!, apiKey: event.target.value } })
                    }
                  />
                </Field>
              </section>
            )
          )}
          <section className="account-settings-section">
            <h3>{t('利用するボット', 'Assigned bots')}</h3>
            <div className="account-bot-options">
              {data.bots.map((bot) => (
                <label
                  className={`account-bot-option ${value.botIds?.includes(bot.id) ? 'checked' : ''}`}
                  key={bot.id}
                >
                  <Avatar bot={bot} size="small" />
                  <span>
                    <strong>{bot.name}</strong>
                    <small>@{bot.handle}</small>
                  </span>
                  <input
                    type="checkbox"
                    aria-label={bot.name}
                    checked={value.botIds?.includes(bot.id) || false}
                    onChange={(event) =>
                      update({
                        botIds: event.target.checked
                          ? [...(value.botIds || []), bot.id]
                          : (value.botIds || []).filter((id) => id !== bot.id),
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <p className="field-hint">
              {t(
                '割り当てたボットが受信箱を読み取り、下の権限に従って送信できます。',
                'Assigned bots can read this mailbox and send according to the permission below.',
              )}
            </p>
          </section>
          <Field label={t('メール送信の権限', 'Sending permission')}>
            <select
              value={value.sendPolicy}
              onChange={(event) =>
                update({ sendPolicy: event.target.value as MailAccountInput['sendPolicy'] })
              }
            >
              <option value="ask">
                {t('送信内容を確認して承認', 'Review and approve each send')}
              </option>
              <option value="allow">
                {t('割り当てたボットの送信を許可', 'Allow assigned bots to send')}
              </option>
              <option value="deny">{t('送信しない', 'Do not send')}</option>
            </select>
          </Field>
          <Toggle
            label={t('このメール接続を有効にする', 'Enable this email connection')}
            checked={!!value.enabled}
            onChange={(enabled) => update({ enabled })}
          />
        </fieldset>
        <div className="account-test-row">
          <Button
            type="button"
            icon={Link2}
            busy={test.status === 'testing'}
            disabled={!ready || denied || busy}
            onClick={() => void testConnection()}
          >
            {test.status === 'testing'
              ? t('接続を確認中…', 'Testing connection…')
              : t('接続をテスト', 'Test connection')}
          </Button>
          <p className="field-hint">
            {t(
              '接続確認は設定を保存せず、メールも送信しません。',
              'Testing does not save settings or send email.',
            )}
          </p>
        </div>
        <div aria-live="polite">
          {test.status === 'success' && (
            <p className="account-test-success" role="status">
              <CheckCircle2 size={15} />
              {test.message}
            </p>
          )}
          {test.status === 'error' && (
            <p className="form-error" role="alert">
              {test.message}
            </p>
          )}
        </div>
        {denied && (
          <p className="field-hint">
            {t(
              'ネットワーク権限が「拒否」のため、接続確認はできません。設定の保存は可能です。',
              'Network access is denied, so testing is unavailable. You can still save settings.',
            )}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="form-actions">
          <Button type="button" onClick={onClose}>
            {t('キャンセル', 'Cancel')}
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {t('接続を保存', 'Save connection')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

function EndpointEditor({
  kind,
  value,
  onChange,
  retained,
  required,
}: {
  kind: 'IMAP' | 'SMTP';
  value: EndpointInput;
  onChange: (value: EndpointInput) => void;
  retained: boolean;
  required: boolean;
}) {
  const { t } = useApp();
  return (
    <div className="account-endpoint-fields">
      <div className="form-grid">
        <Field label={t(`${kind}ホスト`, `${kind} host`)}>
          <input
            required
            maxLength={250}
            value={value.host}
            onChange={(event) => onChange({ ...value, host: event.target.value })}
            placeholder={kind === 'IMAP' ? 'imap.example.com' : 'smtp.example.com'}
          />
        </Field>
        <Field label={t(`${kind}ポート`, `${kind} port`)}>
          <input
            required
            type="number"
            min={1}
            max={65535}
            value={value.port}
            onChange={(event) => onChange({ ...value, port: Number(event.target.value) })}
          />
        </Field>
      </div>
      <div className="form-grid">
        <Field label={t(`${kind}ユーザー名`, `${kind} username`)}>
          <input
            required
            maxLength={250}
            autoComplete="off"
            value={value.user}
            onChange={(event) => onChange({ ...value, user: event.target.value })}
          />
        </Field>
        <Field
          label={t(`${kind}パスワード`, `${kind} password`)}
          hint={
            retained
              ? t(
                  '設定済み。空欄なら現在の値を保持します。',
                  'Configured. Leave blank to keep the saved password.',
                )
              : t(
                  '必要に応じてアプリパスワードを使用します。',
                  'Use an app password if required by your provider.',
                )
          }
        >
          <input
            type="password"
            autoComplete="new-password"
            required={required && !retained}
            maxLength={4096}
            value={value.password || ''}
            onChange={(event) => onChange({ ...value, password: event.target.value })}
          />
        </Field>
      </div>
      <Field label={t(`${kind}暗号化`, `${kind} encryption`)}>
        <select
          value={value.secure ? 'tls' : 'starttls'}
          onChange={(event) => onChange({ ...value, secure: event.target.value === 'tls' })}
        >
          <option value="tls">TLS</option>
          <option value="starttls">STARTTLS</option>
        </select>
      </Field>
    </div>
  );
}
