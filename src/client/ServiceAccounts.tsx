import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Globe2, LockKeyhole, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ServiceAccount } from '../shared/service-accounts';
import { api } from './api';
import { useApp } from './context';
import { Button, Confirm, EmptyState, Field, IconButton, Modal } from './components';

function serviceOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return value.trim();
  }
}

export function ServiceAccounts({
  editor,
  onEdit,
}: {
  editor: ServiceAccount | 'new' | null;
  onEdit: (value: ServiceAccount | 'new' | null) => void;
}) {
  const { data, t, refresh, toast } = useApp();
  const services = data.serviceAccounts || [];
  const [removing, setRemoving] = useState<ServiceAccount | null>(null);
  return (
    <>
      {!services.length ? (
        <EmptyState
          icon={Globe2}
          title={t('サービスアカウントがありません', 'No service accounts yet')}
          action={
            <Button icon={Plus} onClick={() => onEdit('new')}>
              {t('サービスを登録', 'Add service')}
            </Button>
          }
        >
          {t(
            'ボットが利用するサービスと、登録に使ったメールアドレスをまとめて管理します。',
            'Keep track of the services your bots use and the email accounts registered with them.',
          )}
        </EmptyState>
      ) : (
        <div className="service-grid">
          {services.map((service) => {
            const bot = data.bots.find((item) => item.id === service.botId);
            const mail = data.mailAccounts?.find((item) => item.id === service.mailAccountId);
            let domain = service.url;
            try {
              domain = new URL(service.url).hostname;
            } catch {
              /* Legacy metadata. */
            }
            return (
              <article className="service-card" key={service.id}>
                <header className="service-card-heading">
                  <div>
                    <h2>{service.name}</h2>
                    <span className="service-card-domain" title={service.url}>
                      {domain}
                    </span>
                  </div>
                  <div className="card-icon-actions">
                    <IconButton
                      icon={Pencil}
                      label={t(`${service.name}を編集`, `Edit ${service.name}`)}
                      onClick={() => onEdit(service)}
                    />
                    <IconButton
                      icon={Trash2}
                      label={t(`${service.name}を削除`, `Remove ${service.name}`)}
                      onClick={() => setRemoving(service)}
                    />
                  </div>
                </header>
                <dl className="service-card-details">
                  <dt>{t('ボット', 'Bot')}</dt>
                  <dd>{bot?.name || t('未割り当て', 'Unassigned')}</dd>
                  <dt>{t('ログイン', 'Login')}</dt>
                  <dd>{service.login || '—'}</dd>
                  <dt>{t('メール', 'Email')}</dt>
                  <dd>{mail?.address || t('未設定', 'Not linked')}</dd>
                  <dt>{t('状態', 'Status')}</dt>
                  <dd>
                    {service.status === 'active'
                      ? t('利用中', 'Active')
                      : service.status === 'pending'
                        ? t('設定中', 'Pending setup')
                        : t('停止中', 'Disabled')}
                  </dd>
                </dl>
                {service.notes && <p className="service-card-notes">{service.notes}</p>}
                <footer className="service-card-footer">
                  <span className="service-credential-label">
                    <LockKeyhole size={13} />
                    {service.credentialConfigured
                      ? t('秘密情報を保存済み', 'Credential saved')
                      : t('秘密情報なし', 'No stored credential')}
                  </span>
                  {/^https?:\/\//i.test(service.url) && (
                    <a
                      className="text-button"
                      href={service.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('サービスを開く', 'Open service')}
                      <ExternalLink size={13} />
                    </a>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}
      {editor && (
        <ServiceAccountEditor
          key={editor === 'new' ? 'new' : editor.id}
          account={editor === 'new' ? undefined : editor}
          onClose={() => onEdit(null)}
        />
      )}
      {removing && (
        <Confirm
          title={t(
            `${removing.name}をLoomから削除しますか？`,
            `Remove ${removing.name} from Loom?`,
          )}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api(
              `/service-accounts/${encodeURIComponent(removing.id)}?expectedRevision=${removing.revision}`,
              'DELETE',
            );
            await refresh().catch(() => {});
            toast(t('サービスの登録を削除しました', 'Service entry removed'));
          }}
        >
          {t(
            'Loom内の登録情報と保存した秘密情報を削除します。サービス側のアカウントは残ります。',
            'Removes the Loom entry and its stored credential. The account at the external service remains available.',
          )}
        </Confirm>
      )}
    </>
  );
}

export function ServiceAccountEditor({
  account,
  onClose,
}: {
  account?: ServiceAccount;
  onClose: () => void;
}) {
  const { data, t, refresh, toast } = useApp();
  const [name, setName] = useState(account?.name || '');
  const [url, setUrl] = useState(account?.url || '');
  const [login, setLogin] = useState(account?.login || '');
  const [botId, setBotId] = useState(account?.botId || '');
  const [mailAccountId, setMailAccountId] = useState(account?.mailAccountId || '');
  const [status, setStatus] = useState<ServiceAccount['status']>(account?.status || 'pending');
  const [notes, setNotes] = useState(account?.notes || '');
  const [credential, setCredential] = useState('');
  const [clearCredential, setClearCredential] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const sameIdentity =
    account &&
    serviceOrigin(account.url) === serviceOrigin(url) &&
    account.login.trim() === login.trim();
  const retained = Boolean(account?.credentialConfigured && sameIdentity && !clearCredential);
  const linkedMail = data.mailAccounts?.find((mail) => mail.id === mailAccountId);
  const invalidAssignment = Boolean(botId && linkedMail && !linkedMail.botIds.includes(botId));
  return (
    <Modal
      title={account ? t('サービスの設定', 'Service settings') : t('サービスを登録', 'Add service')}
      description={t(
        '既存のサービスアカウントと、その利用者を登録します。',
        'Register an existing service account and the bot that uses it.',
      )}
      onClose={onClose}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current || invalidAssignment) return;
          submitting.current = true;
          setBusy(true);
          setError('');
          try {
            await api(
              account ? `/service-accounts/${encodeURIComponent(account.id)}` : '/service-accounts',
              account ? 'PUT' : 'POST',
              {
                name: name.trim(),
                url: url.trim(),
                login: login.trim(),
                botId: botId || null,
                mailAccountId: mailAccountId || null,
                status,
                notes: notes.trim(),
                ...(credential || clearCredential ? { credential } : {}),
                ...(account ? { expectedRevision: account.revision } : {}),
              },
            );
            await refresh().catch(() => {});
            toast(t('サービスを保存しました', 'Service saved'));
            if (mounted.current) onClose();
          } catch (caught) {
            if (mounted.current) setError((caught as Error).message);
          } finally {
            submitting.current = false;
            if (mounted.current) setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy} className="account-fields">
          <Field label={t('サービス名', 'Service name')}>
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="GitHub"
            />
          </Field>
          <Field label={t('サービスURL', 'Service URL')}>
            <input
              type="url"
              required
              maxLength={2000}
              value={url}
              onChange={(event) => {
                if (serviceOrigin(url) !== serviceOrigin(event.target.value)) setCredential('');
                setUrl(event.target.value);
              }}
              placeholder="https://github.com"
            />
          </Field>
          <Field label={t('ログイン名', 'Login name')}>
            <input
              maxLength={250}
              value={login}
              autoComplete="off"
              onChange={(event) => {
                if (login.trim() !== event.target.value.trim()) setCredential('');
                setLogin(event.target.value);
              }}
              placeholder={t('ユーザー名またはメールアドレス', 'Username or email address')}
            />
          </Field>
          <div className="form-grid">
            <Field label={t('利用するボット', 'Assigned bot')}>
              <select value={botId} onChange={(event) => setBotId(event.target.value)}>
                <option value="">{t('未割り当て', 'Unassigned')}</option>
                {data.bots.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={t('登録メールアカウント', 'Registered email account')}
              hint={
                botId
                  ? t(
                      'このボットに割り当て済みのメールを選べます。割り当てはメール接続の設定で変更できます。',
                      'Choose email already assigned to this bot. Assignments can be changed in the email connection settings.',
                    )
                  : undefined
              }
            >
              <select
                value={mailAccountId}
                onChange={(event) => setMailAccountId(event.target.value)}
              >
                <option value="">{t('未設定', 'Not linked')}</option>
                {(data.mailAccounts || []).map((mail) => (
                  <option
                    key={mail.id}
                    value={mail.id}
                    disabled={!!botId && !mail.botIds.includes(botId)}
                  >
                    {mail.name} · {mail.address}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {invalidAssignment && (
            <p className="form-error" role="alert">
              {t(
                '選択中のメールをこのボットに割り当てるか、登録メールの選択を変更してください。',
                'Assign the selected email to this bot, or change the registered email selection.',
              )}
            </p>
          )}
          <Field label={t('利用状態', 'Service status')}>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as ServiceAccount['status'])}
            >
              <option value="pending">{t('設定中', 'Pending setup')}</option>
              <option value="active">{t('利用中', 'Active')}</option>
              <option value="disabled">{t('停止中', 'Disabled')}</option>
            </select>
          </Field>
          <Field
            label={t('メモ', 'Notes')}
            hint={t(
              '秘密情報は下の専用欄に保存してください。',
              'Use the credential field below for secrets.',
            )}
          >
            <textarea
              rows={3}
              maxLength={4000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
          <details className="account-settings-section">
            <summary>{t('秘密情報', 'Credential')}</summary>
            <Field
              label={t('パスワードまたはAPIキー', 'Password or API key')}
              hint={
                retained
                  ? t(
                      '設定済み。空欄なら現在の値を保持します。',
                      'Configured. Leave blank to keep the existing credential.',
                    )
                  : t(
                      '必要な場合だけ保存できます。保存した値は画面やボットの会話に返しません。',
                      'Optional. Saved values are not returned to the screen or bot conversations.',
                    )
              }
            >
              <input
                type="password"
                autoComplete="new-password"
                maxLength={4096}
                value={credential}
                onChange={(event) => {
                  setCredential(event.target.value);
                  setClearCredential(false);
                }}
              />
            </Field>
            {account?.credentialConfigured && (
              <label className="account-clear-credential">
                <input
                  type="checkbox"
                  checked={clearCredential}
                  onChange={(event) => {
                    setClearCredential(event.target.checked);
                    setCredential('');
                  }}
                />
                <span>{t('保存した秘密情報を削除する', 'Remove the stored credential')}</span>
              </label>
            )}
          </details>
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="form-actions">
          <Button type="button" onClick={onClose}>
            {t('キャンセル', 'Cancel')}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={invalidAssignment}>
            {t('サービスを保存', 'Save service')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
