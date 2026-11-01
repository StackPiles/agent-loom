import { useEffect, useState } from 'react';
import { CircleAlert, Globe2, Link2, Mail, Pencil, Plus, Unplug } from 'lucide-react';
import type { MailAccount } from '../shared/mail-accounts';
import type { ServiceAccount } from '../shared/service-accounts';
import { api } from './api';
import { useApp } from './context';
import { Avatar, Button, Confirm, EmptyState, IconButton, PageHeader } from './components';
import { MailAccountEditor } from './MailAccountEditor';
import { MailPanel } from './MailPanel';
import { ServiceAccounts } from './ServiceAccounts';
import { providerName } from './mail-ui';

export function AccountsPage() {
  const { data, t, refresh, toast } = useApp();
  const accounts = data.mailAccounts || [];
  const [tab, setTab] = useState<'mail' | 'services'>('mail');
  const [selected, setSelected] = useState(() => localStorage.getItem('loom.mailAccount') || '');
  const [editor, setEditor] = useState<MailAccount | 'new' | null>(null);
  const [serviceEditor, setServiceEditor] = useState<ServiceAccount | 'new' | null>(null);
  const [removing, setRemoving] = useState<MailAccount | null>(null);
  useEffect(() => {
    if (!accounts.some((item) => item.id === selected)) setSelected(accounts[0]?.id || '');
  }, [accounts, selected]);
  const account = accounts.find((item) => item.id === selected);
  const choose = (id: string) => {
    setSelected(id);
    localStorage.setItem('loom.mailAccount', id);
  };
  return (
    <div className="page-scroll">
      <div className="page-container accounts-page">
        <PageHeader
          title={t('メール・サービス', 'Mail & services')}
          description={t(
            '外部アカウントを接続し、ボットに割り当てます。',
            'Connect external accounts and assign them to bots.',
          )}
        />
        <div className="accounts-toolbar">
          <div
            className="page-tabs"
            role="tablist"
            aria-label={t('アカウントの種類', 'Account type')}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 'mail'
                  : event.key === 'End'
                    ? 'services'
                    : tab === 'mail'
                      ? 'services'
                      : 'mail';
              setTab(next);
              document
                .getElementById(next === 'mail' ? 'mail-accounts-tab' : 'service-accounts-tab')
                ?.focus();
            }}
          >
            <button
              id="mail-accounts-tab"
              role="tab"
              aria-selected={tab === 'mail'}
              tabIndex={tab === 'mail' ? 0 : -1}
              aria-controls="mail-accounts-content"
              className={tab === 'mail' ? 'selected' : ''}
              onClick={() => setTab('mail')}
            >
              <Mail size={16} />
              {t('メール', 'Email')}
              <span>{accounts.length}</span>
            </button>
            <button
              id="service-accounts-tab"
              role="tab"
              aria-selected={tab === 'services'}
              tabIndex={tab === 'services' ? 0 : -1}
              aria-controls="service-accounts-content"
              className={tab === 'services' ? 'selected' : ''}
              onClick={() => setTab('services')}
            >
              <Globe2 size={16} />
              {t('サービス', 'Services')}
              <span>{data.serviceAccounts?.length || 0}</span>
            </button>
          </div>
          <Button
            variant="primary"
            icon={Plus}
            onClick={() => (tab === 'mail' ? setEditor('new') : setServiceEditor('new'))}
          >
            {tab === 'mail'
              ? t('メールを接続', 'Connect email')
              : t('サービスを登録', 'Add service')}
          </Button>
        </div>
        {tab === 'mail' ? (
          <div id="mail-accounts-content" role="tabpanel" aria-labelledby="mail-accounts-tab">
            {!accounts.length ? (
              <EmptyState
                icon={Mail}
                title={t('メールアカウントを接続', 'Connect an email account')}
                action={
                  <Button icon={Link2} onClick={() => setEditor('new')}>
                    {t('接続を追加', 'Add connection')}
                  </Button>
                }
              >
                {t(
                  'IMAP / SMTP、AgentMail、Resendの既存メールボックスを利用できます。メール基盤はLoomの外で管理します。',
                  'Use an existing IMAP / SMTP, AgentMail or Resend mailbox. Your email provider remains independent of Loom.',
                )}
              </EmptyState>
            ) : (
              <div className="accounts-layout">
                <aside
                  className="account-list"
                  aria-label={t('メールアカウント一覧', 'Email accounts')}
                >
                  {accounts.map((item) => {
                    const bots = data.bots.filter((bot) => item.botIds.includes(bot.id));
                    const configured =
                      item.provider === 'imap'
                        ? item.imap?.passwordConfigured
                        : item.api?.apiKeyConfigured;
                    return (
                      <article
                        key={item.id}
                        className={`account-card ${selected === item.id ? 'selected' : ''}`}
                      >
                        <button
                          className="account-card-select"
                          aria-pressed={selected === item.id}
                          aria-label={t(
                            `${item.name}のメールを開く`,
                            `Open email for ${item.name}`,
                          )}
                          onClick={() => choose(item.id)}
                        >
                          <div className="account-card-heading">
                            <span>
                              <strong>{item.name}</strong>
                              <span className="account-card-address" title={item.address}>
                                {item.address}
                              </span>
                            </span>
                            <Mail size={17} />
                          </div>
                          <div className="account-card-meta">
                            <span
                              className={`account-status ${item.lastError ? 'error' : !item.enabled ? 'disabled' : ''}`}
                            >
                              {item.lastError && item.enabled ? (
                                <>
                                  <CircleAlert size={12} />
                                  {t('接続を確認', 'Check connection')}
                                </>
                              ) : !item.enabled ? (
                                t('停止中', 'Disabled')
                              ) : configured ? (
                                t('設定済み', 'Configured')
                              ) : (
                                t('認証情報が未設定', 'Credentials needed')
                              )}
                            </span>
                            <small>{providerName(item.provider)}</small>
                          </div>
                          <div
                            className="account-bot-list"
                            aria-label={
                              bots.length
                                ? bots.map((bot) => bot.name).join(', ')
                                : t('未割り当て', 'Unassigned')
                            }
                          >
                            {bots.slice(0, 4).map((bot) => (
                              <span key={bot.id} title={bot.name}>
                                <Avatar bot={bot} size="small" />
                              </span>
                            ))}
                            {bots.length > 4 && <small>+{bots.length - 4}</small>}
                            {!bots.length && (
                              <small>{t('ボット未割り当て', 'No assigned bots')}</small>
                            )}
                          </div>
                        </button>
                        <div className="account-card-actions">
                          <IconButton
                            icon={Pencil}
                            label={t(`${item.name}を編集`, `Edit ${item.name}`)}
                            onClick={() => setEditor(item)}
                          />
                          <IconButton
                            icon={Unplug}
                            label={t(`${item.name}の接続を解除`, `Disconnect ${item.name}`)}
                            onClick={() => setRemoving(item)}
                          />
                        </div>
                      </article>
                    );
                  })}
                  <Button
                    className="account-add"
                    variant="ghost"
                    icon={Plus}
                    onClick={() => setEditor('new')}
                  >
                    {t('接続を追加', 'Add connection')}
                  </Button>
                </aside>
                {account && <MailPanel key={account.id} account={account} />}
              </div>
            )}
          </div>
        ) : (
          <div id="service-accounts-content" role="tabpanel" aria-labelledby="service-accounts-tab">
            <ServiceAccounts editor={serviceEditor} onEdit={setServiceEditor} />
          </div>
        )}
        {editor && (
          <MailAccountEditor
            key={editor === 'new' ? 'new' : editor.id}
            account={editor === 'new' ? undefined : editor}
            onClose={() => setEditor(null)}
            onSaved={(saved) => choose(saved.id)}
          />
        )}
        {removing && (
          <Confirm
            title={t(`${removing.name}の接続を解除しますか？`, `Disconnect ${removing.name}?`)}
            onClose={() => setRemoving(null)}
            onConfirm={async () => {
              await api(
                `/mail/accounts/${encodeURIComponent(removing.id)}?expectedRevision=${removing.revision}`,
                'DELETE',
              );
              await refresh().catch(() => {});
              toast(t('メール接続を解除しました', 'Email connection removed'));
            }}
          >
            {t(
              'Loom内の接続情報と認証情報を削除します。このアカウントを使う自動化は停止します。メール基盤側の受信箱とメールは残ります。',
              'Removes the connection and credentials from Loom and pauses automations using it. The external mailbox and its email remain available.',
            )}
          </Confirm>
        )}
      </div>
    </div>
  );
}
