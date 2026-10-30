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
          eyebrow={t('話しかけなくても、動き出す', 'A LITTLE INITIATIVE GOES A LONG WAY')}
          title={t('先回りする、仕組み', 'Make room for initiative')}
          description={t(
            '決まった時間や変化をきっかけに、仲間が気づいて、動いて、お知らせします。',
            'Let time or a change start the conversation. Your teammates notice, act, and keep you in the loop.',
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
              <h2>{t('何を、任せてみますか？', 'What would you like to set in motion?')}</h2>
              <p>
                {t(
                  '設定は後から、いつでも変えられます。',
                  'Start small. You can always change the details.',
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
                        ? t(
                            '朝の計画や定期的なふりかえりに。',
                            'Morning plans or a regular check-in.',
                          )
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
                    {item.lastError && <p className="form-error">{item.lastError}</p>}
                  </div>
                  <div className="automation-actions">
                    <Toggle
                      checked={item.enabled}
                      onChange={(value) =>
                        void mutate(`/automations/${item.id}`, 'PATCH', { enabled: value }).catch(
                          () => {},
                        )
                      }
                      label={item.enabled ? t('有効', 'On') : t('停止', 'Off')}
                    />
                    <div>
                      <IconButton
                        icon={Play}
                        label={t('今すぐ実行', 'Run now')}
                        disabled={running === item.id}
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
  const { data, t, mutate } = useApp();
  const [name, setName] = useState(automation?.name || '');
  const [kind, setKind] = useState<Automation['kind']>(automation?.kind || 'interval');
  const [roomId, setRoomId] = useState(
    automation?.roomId || data.rooms.find((room) => !room.archived)?.id || '',
  );
  const room = data.rooms.find((item) => item.id === roomId);
  const members = data.bots.filter((bot) => room?.botIds.includes(bot.id) && bot.enabled);
  const [botId, setBotId] = useState(automation?.botId || members[0]?.id || '');
  const [prompt, setPrompt] = useState(automation?.prompt || '');
  const [minutes, setMinutes] = useState(automation?.intervalMinutes || 60);
  const [url, setUrl] = useState(automation?.sourceUrl || '');
  const [enabled, setEnabled] = useState(automation?.enabled ?? true);
  const [host, setHost] = useState(automation?.imap?.host || '');
  const [port, setPort] = useState(automation?.imap?.port || 993);
  const [secure, setSecure] = useState(automation?.imap?.secure ?? true);
  const [user, setUser] = useState(automation?.imap?.user || '');
  const [password, setPassword] = useState('');
  const [mailbox, setMailbox] = useState(automation?.imap?.mailbox || 'INBOX');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      wide
      title={
        automation?.id ? t('自動化を編集', 'Edit automation') : t('新しい自動化', 'New automation')
      }
      description={t(
        'きっかけと、任せたいことを決めましょう。',
        'Choose a trigger and tell your teammate what to do.',
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
                ...(kind === 'imap'
                  ? {
                      imap: {
                        host,
                        port,
                        secure,
                        user,
                        mailbox,
                        ...(password ? { password } : {}),
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
              <option value="imap">{t('新着メール（IMAP）', 'Incoming email (IMAP)')}</option>
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
              '自動チェックには、設定のネットワーク権限を「許可」にする必要があります。',
              'Background checks require the network permission to be set to Allow in Settings.',
            )}
          </div>
        )}
        {kind === 'imap' && (
          <div className="form-subsection">
            <h3>{t('メールサーバー', 'Mail server')}</h3>
            <p className="field-hint" style={{ marginBottom: 18 }}>
              {t(
                '新着メールの送信者・件名・日時を、1回に最大20件確認します。初回は既存のメールを基準として記録します。本文・添付は取得せず、既読状態も変更しません。',
                'Checks sender, subject, and date for up to 20 new messages per poll. The first poll records a baseline. Bodies and attachments are not fetched, and read status is unchanged.',
              )}
            </p>
            <div className="form-grid">
              <Field label={t('ホスト', 'Host')}>
                <input
                  required
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="imap.example.com"
                />
              </Field>
              <Field label={t('ポート', 'Port')}>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                />
              </Field>
            </div>
            <Field label={t('ユーザー名', 'Username')}>
              <input
                required
                value={user}
                onChange={(e) => setUser(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field
              label={t('アプリパスワード', 'App password')}
              hint={
                automation?.imap?.passwordConfigured
                  ? t(
                      '設定済み。空欄なら現在の値を保持します。',
                      'Already configured. Leave blank to keep it.',
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
                required={!automation?.imap?.passwordConfigured}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label={t('メールボックス', 'Mailbox')}>
              <input required value={mailbox} onChange={(e) => setMailbox(e.target.value)} />
            </Field>
            <Toggle checked={secure} onChange={setSecure} label={t('TLS接続', 'TLS connection')} />
          </div>
        )}
        <div className="form-grid">
          <Field label={t('結果を届けるルーム', 'Destination room')}>
            <select
              required
              value={roomId}
              onChange={(e) => {
                setRoomId(e.target.value);
                setBotId(
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
            <select required value={botId} onChange={(e) => setBotId(e.target.value)}>
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
          <Button variant="primary" type="submit" busy={busy} disabled={!roomId || !botId}>
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
