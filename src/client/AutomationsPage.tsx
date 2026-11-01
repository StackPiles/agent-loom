import { useState } from 'react';
import {
  ArrowUpRight,
  Clock3,
  Globe2,
  KeyRound,
  Mail,
  Pencil,
  Play,
  Plus,
  Trash2,
  Webhook,
  Workflow,
} from 'lucide-react';
import type { Automation } from '../shared/types';
import type { MailAccount } from '../shared/mail-accounts';
import { GMAIL_CONNECTION, normalizeMailPassword } from '../shared/mail-settings';
import { MailSettings, type MailFormValue } from './MailSettings';
import { dateLabel, useApp } from './context';
import {
  Button,
  Confirm,
  CopyButton,
  EmptyState,
  Field,
  IconButton,
  Modal,
  PageHeader,
  Toggle,
} from './components';

const kindIcons = { interval: Clock3, url_watch: Globe2, webhook: Webhook, imap: Mail };
function mailReady(rule: Automation, accounts: MailAccount[] = []): boolean {
  if (rule.kind !== 'imap') return true;
  if (!rule.mailAccountId) return Boolean(rule.imap?.passwordConfigured);
  const account = accounts.find((item) => item.id === rule.mailAccountId);
  return Boolean(account?.enabled && account.botIds.includes(rule.botId));
}
export function AutomationsPage() {
  const { data, t, locale, mutate, navigate } = useApp();
  const [editor, setEditor] = useState<Automation | 'new' | null>(null);
  const [removing, setRemoving] = useState<Automation | null>(null);
  const [hook, setHook] = useState<Automation | null>(null);
  const [running, setRunning] = useState('');
  const labels = {
    interval: t('定期実行', 'Schedule'),
    url_watch: t('ページの変化', 'Page changes'),
    webhook: 'Webhook',
    imap: t('受信メール', 'Incoming email'),
  };
  return (
    <div className="page-scroll">
      <div className="page-container">
        <PageHeader
          title={t('自動化', 'Automations')}
          description={t(
            'スケジュールや外部のイベントを条件に、タスクを実行します。',
            'Run tasks on a schedule or in response to an external event.',
          )}
          action={
            <Button variant="primary" icon={Plus} onClick={() => setEditor('new')}>
              {t('自動化をつくる', 'New automation')}
            </Button>
          }
        />
        <div className="automation-overview">
          <div>
            <span className="stat-icon">
              <Workflow size={21} />
            </span>
            <strong>{data.automations.filter((item) => item.enabled).length}</strong>
            <span>{t('有効な自動化', 'active automations')}</span>
          </div>
          <div>
            <span className="connection-dot online" />
            <p>
              {t(
                'アプリのサーバー起動中に実行します。結果はルームとお知らせに届きます。',
                'Runs while your app server is on. Results arrive in the room and your inbox.',
              )}
            </p>
          </div>
        </div>
        {!data.automations.length ? (
          <div className="automation-starters">
            <div className="section-intro">
              <h2>{t('実行条件を選択', 'Choose a trigger')}</h2>
              <p>
                {t(
                  '担当ボット、指示、通知先のルームを設定します。',
                  'Choose a bot, instructions, and a destination room.',
                )}
              </p>
            </div>
            <div className="starter-grid">
              {(['interval', 'url_watch', 'webhook', 'imap'] as const).map((kind) => {
                const Icon = kindIcons[kind];
                return (
                  <button key={kind} onClick={() => setEditor({ kind } as Automation)}>
                    <Icon size={24} strokeWidth={1.5} />
                    <h3>{labels[kind]}</h3>
                    <p>
                      {kind === 'interval'
                        ? t('指定した間隔でタスクを実行します。', 'Run a task at a set interval.')
                        : kind === 'url_watch'
                          ? t(
                              '指定ページが変わったら、要点を確認。',
                              'Find out what changed on a page.',
                            )
                          : kind === 'imap'
                            ? t(
                                '新着メールを確認して、重要な内容を通知。',
                                'Review new messages for what matters.',
                              )
                            : t(
                                '他のアプリのイベントから、仕事を依頼。',
                                'Turn an event from another app into action.',
                              )}
                    </p>
                    <span>
                      {t('設定する', 'Set up')}
                      <ArrowUpRight size={14} />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="automation-list">
            {data.automations.map((item) => {
              const Icon = kindIcons[item.kind];
              const account = data.mailAccounts?.find((entry) => entry.id === item.mailAccountId);
              return (
                <article className="automation-card" key={item.id}>
                  <span className={`automation-kind-icon kind-${item.kind}`}>
                    <Icon size={21} />
                  </span>
                  <div className="automation-main">
                    <div className="automation-title">
                      <h2>{item.name}</h2>
                      <span className="subtle-tag">{labels[item.kind]}</span>
                    </div>
                    <p>{item.prompt}</p>
                    <div className="automation-meta">
                      <button onClick={() => navigate('chat', item.roomId)}>
                        #{' '}
                        {data.rooms.find((room) => room.id === item.roomId)?.name ||
                          t('ルーム', 'Room')}
                      </button>
                      <span>@{data.bots.find((bot) => bot.id === item.botId)?.handle}</span>
                      {account && (
                        <span style={{ minWidth: 0, maxWidth: '100%' }} title={account.address}>
                          <Mail size={12} style={{ flexShrink: 0 }} />
                          <span style={{ overflowWrap: 'anywhere' }}>{account.address}</span>
                        </span>
                      )}
                      {item.kind !== 'webhook' && (
                        <span>
                          <Clock3 size={12} />
                          {t(`${item.intervalMinutes}分おき`, `Every ${item.intervalMinutes} min`)}
                        </span>
                      )}
                    </div>
                    <div className="automation-timing">
                      {item.lastRunAt ? (
                        <span>
                          {t('前回：', 'Last run: ')}
                          {dateLabel(item.lastRunAt, locale, true)}
                        </span>
                      ) : (
                        <span>{t('まだ実行されていません', 'Has not run yet')}</span>
                      )}
                      {item.nextRunAt && item.enabled && (
                        <span>
                          {t('次回：', 'Next: ')}
                          {dateLabel(item.nextRunAt, locale, true)}
                        </span>
                      )}
                    </div>
                    {!mailReady(item, data.mailAccounts) && (
                      <div className="automation-mail-setup">
                        <span>
                          {t('メールの接続設定が必要です', 'Mail connection needs setup')}
                        </span>
                        <button
                          onClick={() =>
                            item.mailAccountId ? navigate('accounts') : setEditor(item)
                          }
                        >
                          {t('接続を設定', 'Set up connection')}
                          <ArrowUpRight size={13} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                    {item.lastError && <p className="form-error">{item.lastError}</p>}
                  </div>
                  <div className="automation-actions">
                    <Toggle
                      checked={item.enabled}
                      onChange={(value) => {
                        if (value && !mailReady(item, data.mailAccounts)) {
                          setEditor(item);
                          return;
                        }
                        void mutate(`/automations/${item.id}`, 'PATCH', { enabled: value }).catch(
                          () => {},
                        );
                      }}
                      label={item.enabled ? t('有効', 'On') : t('停止', 'Off')}
                    />
                    <div>
                      <IconButton
                        icon={Play}
                        label={t('今すぐ実行', 'Run now')}
                        disabled={running === item.id || !mailReady(item, data.mailAccounts)}
                        onClick={async () => {
                          setRunning(item.id);
                          try {
                            await mutate(
                              `/automations/${item.id}/run`,
                              'POST',
                              undefined,
                              t('チェックを実行しました', 'Check finished'),
                            );
                          } catch {
                          } finally {
                            setRunning('');
                          }
                        }}
                      />
                      {item.kind === 'webhook' && (
                        <IconButton
                          icon={KeyRound}
                          label={t('Webhookの接続情報', 'Webhook connection')}
                          onClick={() => setHook(item)}
                        />
                      )}
                      <IconButton
                        icon={Pencil}
                        label={t('編集', 'Edit')}
                        onClick={() => setEditor(item)}
                      />
                      <IconButton
                        icon={Trash2}
                        label={t('削除', 'Delete')}
                        onClick={() => setRemoving(item)}
                      />
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {editor && (
          <AutomationEditor
            automation={editor === 'new' ? undefined : editor}
            onClose={() => setEditor(null)}
          />
        )}{' '}
        {hook && <WebhookDialog automation={hook} onClose={() => setHook(null)} />}{' '}
        {removing && (
          <Confirm
            title={t('自動化を削除しますか？', 'Delete this automation?')}
            onClose={() => setRemoving(null)}
            onConfirm={async () => {
              await mutate(`/automations/${removing.id}`, 'DELETE');
            }}
          >
            {removing.name}
            {t(
              ' の今後の実行を停止し、設定を削除します。過去の結果は残ります。',
              ' will no longer run. Its past results stay saved.',
            )}
          </Confirm>
        )}
      </div>
    </div>
  );
}

function AutomationEditor({
  automation,
  onClose,
}: {
  automation?: Automation;
  onClose: () => void;
}) {
  const { data, t, mutate, navigate } = useApp();
  const [name, setName] = useState(automation?.name || '');
  const [kind, setKind] = useState<Automation['kind']>(automation?.kind || 'interval');
  const [roomId, setRoomId] = useState(
    automation?.roomId || data.rooms.find((room) => !room.archived)?.id || '',
  );
  const room = data.rooms.find((item) => item.id === roomId);
  const members = data.bots.filter((bot) => room?.botIds.includes(bot.id) && bot.enabled);
  const [botId, setBotId] = useState(automation?.botId || members[0]?.id || '');
  const accounts = (data.mailAccounts ?? []).filter((account) => account.botIds.includes(botId));
  const [mailAccountId, setMailAccountId] = useState(
    automation?.mailAccountId ||
      (automation?.imap ? 'legacy' : accounts.find((account) => account.enabled)?.id || ''),
  );
  const selectedAccount = accounts.find((account) => account.id === mailAccountId);
  const chooseBot = (id: string) => {
    setBotId(id);
    if (
      mailAccountId &&
      mailAccountId !== 'legacy' &&
      !data.mailAccounts?.some(
        (account) => account.id === mailAccountId && account.botIds.includes(id),
      )
    )
      setMailAccountId(
        data.mailAccounts?.find((account) => account.enabled && account.botIds.includes(id))?.id ||
          '',
      );
  };
  const [prompt, setPrompt] = useState(automation?.prompt || '');
  const [minutes, setMinutes] = useState(automation?.intervalMinutes || 60);
  const [url, setUrl] = useState(automation?.sourceUrl || '');
  const [enabled, setEnabled] = useState(automation?.enabled ?? true);
  const [mail, setMail] = useState<MailFormValue>({
    host: automation?.imap?.host ?? GMAIL_CONNECTION.host,
    port: automation?.imap?.port ?? GMAIL_CONNECTION.port,
    secure: automation?.imap?.secure ?? GMAIL_CONNECTION.secure,
    user: automation?.imap?.user ?? '',
    mailbox: automation?.imap?.mailbox ?? GMAIL_CONNECTION.mailbox,
    password: '',
  });
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      wide
      title={
        automation?.id ? t('自動化を編集', 'Edit automation') : t('新しい自動化', 'New automation')
      }
      description={t(
        '実行条件、担当ボット、指示を設定します。',
        'Configure the trigger, bot, and task instructions.',
      )}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await mutate(
              automation?.id ? `/automations/${automation.id}` : '/automations',
              automation?.id ? 'PATCH' : 'POST',
              {
                name: name.trim(),
                kind,
                roomId,
                botId,
                prompt: prompt.trim(),
                intervalMinutes: minutes,
                sourceUrl: url,
                enabled,
                ...(kind === 'imap' && mailAccountId !== 'legacy'
                  ? { mailAccountId }
                  : kind === 'imap'
                    ? {
                        mailAccountId: null,
                        imap: {
                          host: mail.host,
                          port: mail.port,
                          secure: mail.secure,
                          user: mail.user,
                          mailbox: mail.mailbox,
                          ...(mail.password
                            ? { password: normalizeMailPassword(mail, mail.password) }
                            : {}),
                        },
                      }
                    : {}),
              },
              t('自動化を保存しました', 'Automation saved'),
            );
            onClose();
          } catch {
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t('名前', 'Name')}>
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('例：朝のチェックイン', 'e.g. Morning check-in')}
          />
        </Field>
        <div className="form-grid">
          <Field label={t('きっかけ', 'Trigger')}>
            <select value={kind} onChange={(e) => setKind(e.target.value as Automation['kind'])}>
              <option value="interval">{t('定期実行', 'Schedule')}</option>
              <option value="url_watch">{t('Webページの変化', 'Page changes')}</option>
              <option value="webhook">Webhook</option>
              <option value="imap">{t('新着メール', 'Incoming email')}</option>
            </select>
          </Field>
          {kind !== 'webhook' && (
            <Field label={t('間隔（分）', 'Interval (minutes)')}>
              <input
                type="number"
                required
                min={1}
                max={525600}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              />
            </Field>
          )}
        </div>
        {kind === 'url_watch' && (
          <Field
            label={t('監視するURL', 'Page URL')}
            hint={t(
              'ページから抽出したテキストの変化を検出します。初回は基準を保存します。ログインが必要なページには対応していません。',
              'Detects changes to readable page text. The first check records a baseline. Pages requiring sign-in are not supported.',
            )}
          >
            <input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/updates"
            />
          </Field>
        )}
        {kind === 'webhook' && (
          <div className="inline-note">
            <Webhook size={17} />
            {t(
              '保存後、鍵アイコンからWebhookのトークンと接続先を作成できます。',
              'After saving, use the key icon to generate a webhook token and endpoint.',
            )}
          </div>
        )}
        {(kind === 'url_watch' || kind === 'imap') && (
          <div className="inline-note">
            {t(
              '自動チェックには、設定のネットワーク権限を「許可」または「自動判定」にする必要があります。',
              'Background checks require network permission Allow or Smart auto-approve in Settings.',
            )}
          </div>
        )}
        <div className="form-grid">
          <Field label={t('結果を届けるルーム', 'Destination room')}>
            <select
              required
              value={roomId}
              onChange={(e) => {
                setRoomId(e.target.value);
                chooseBot(
                  data.bots.find(
                    (bot) =>
                      data.rooms
                        .find((item) => item.id === e.target.value)
                        ?.botIds.includes(bot.id) && bot.enabled,
                  )?.id || '',
                );
              }}
            >
              <option value="" disabled>
                {t('選択してください', 'Select a room')}
              </option>
              {data.rooms
                .filter((item) => !item.archived)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t('担当する仲間', 'Teammate')}>
            <select required value={botId} onChange={(e) => chooseBot(e.target.value)}>
              <option value="" disabled>
                {t('選択してください', 'Select a teammate')}
              </option>
              {members.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {kind === 'imap' && (
          <>
            <Field
              label={t('受信するメールアカウント', 'Mail account')}
              hint={t(
                'このボットに割り当てたメールを選択します。推論中も受信チェックを続け、未処理のメールを順番に届けます。',
                'Choose an account assigned to this bot. Checks continue while the bot is working; received messages wait for their turn.',
              )}
            >
              <select
                required
                value={mailAccountId}
                onChange={(event) => {
                  setMailAccountId(event.target.value);
                  if (
                    accounts.find((account) => account.id === event.target.value)?.enabled === false
                  )
                    setEnabled(false);
                }}
              >
                <option value="">{t('メールアカウントを選択', 'Select a mail account')}</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.address}
                    {account.enabled ? '' : t('（停止中）', ' (disabled)')}
                  </option>
                ))}
                <option value="legacy">
                  {t('従来のIMAP接続を使う', 'Legacy IMAP connection')}
                </option>
              </select>
            </Field>
            <Button
              type="button"
              icon={ArrowUpRight}
              onClick={() => {
                onClose();
                navigate('accounts');
              }}
            >
              {t('メールアカウントを管理', 'Manage mail accounts')}
            </Button>
            {mailAccountId === 'legacy' ? (
              <MailSettings
                value={mail}
                onChange={setMail}
                automation={automation}
                enabled={enabled}
              />
            ) : (
              !selectedAccount && (
                <p className="field-hint">
                  {t(
                    'アカウント画面で接続し、このボットに割り当ててください。',
                    'Connect an account and assign it to this bot in Accounts.',
                  )}
                </p>
              )
            )}
            {selectedAccount && !selectedAccount.enabled && (
              <p className="form-error">
                {t(
                  'このメールアカウントは停止中です。アカウント画面で有効にするか、この自動化を停止して保存してください。',
                  'This account is disabled. Enable it in Accounts, or save this automation disabled.',
                )}
              </p>
            )}
          </>
        )}
        <Field
          label={t('任せること', 'Instructions')}
          hint={t(
            '何を確認し、どんな場合に知らせてほしいか、具体的に書きます。',
            'Describe what to check and when you would like to be notified.',
          )}
        >
          <textarea
            rows={4}
            required
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t(
              '変化の内容を要約し、対応が必要な項目があれば教えて。',
              'Summarize what changed and tell me if anything needs my attention.',
            )}
          />
        </Field>
        <Toggle
          checked={enabled}
          onChange={setEnabled}
          label={t('保存後、有効にする', 'Enable after saving')}
        />
        {!members.length && (
          <p className="form-error">
            {t(
              '有効な仲間がいるルームを先に作成してください。',
              'First create a room with an enabled teammate.',
            )}
          </p>
        )}
        <footer className="form-actions">
          <Button type="button" onClick={onClose}>
            {t('キャンセル', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            busy={busy}
            disabled={
              !roomId ||
              !botId ||
              (kind === 'imap' &&
                mailAccountId !== 'legacy' &&
                (!selectedAccount || (enabled && !selectedAccount.enabled)))
            }
          >
            {t('保存する', 'Save automation')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

function WebhookDialog({ automation, onClose }: { automation: Automation; onClose: () => void }) {
  const { t, mutate } = useApp();
  const [key, setKey] = useState<{ token: string; path: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const url = key ? `${window.location.origin}${key.path}` : '';
  const example = key
    ? `curl -X POST '${url}' \\\n  -H 'Authorization: Bearer ${key.token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"text":"Something needs attention","eventId":"unique-event-1"}'`
    : '';
  return (
    <Modal
      title={t('Webhookの接続', 'Connect a webhook')}
      description={automation.name}
      onClose={onClose}
    >
      {!key ? (
        <>
          <p className="confirm-description">
            {t(
              '新しい接続トークンを発行します。既存のトークンがある場合は無効になります。発行したトークンはこの画面で一度だけ表示します。',
              'Generate a new connection token. This replaces any previous token. The new token is shown only once in this dialog.',
            )}
          </p>
          <Button
            icon={KeyRound}
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setKey(await mutate(`/automations/${automation.id}/webhook-key`));
              } catch {
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('トークンを発行', 'Generate token')}
          </Button>
        </>
      ) : (
        <>
          <div className="inline-note">
            {t(
              '接続先とトークンを、安全な場所に保存してください。',
              'Save the endpoint and token in a safe place.',
            )}
          </div>
          <Field label="URL">
            <div className="copy-value">
              <code>{url}</code>
              <CopyButton text={url} />
            </div>
          </Field>
          <Field label={t('トークン', 'Token')}>
            <div className="copy-value">
              <code>{key.token}</code>
              <CopyButton text={key.token} />
            </div>
          </Field>
          <div className="code-example">
            <header>
              <span>{t('リクエスト例', 'Example request')}</span>
              <CopyButton text={example} />
            </header>
            <pre>{example}</pre>
          </div>
        </>
      )}
      <footer className="form-actions">
        <Button onClick={onClose}>{t('閉じる', 'Close')}</Button>
      </footer>
    </Modal>
  );
}
