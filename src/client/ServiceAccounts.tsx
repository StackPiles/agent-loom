import { useEffect, useRef, useState } from 'react';
import {
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Globe2,
  LockKeyhole,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import type { ServiceAccount, ServiceAccountCredential } from '../shared/service-accounts';
import type { Room } from '../shared/types';
import { api, ApiError } from './api';
import { useApp } from './context';
import { Avatar, Button, Confirm, EmptyState, Field, IconButton, Modal } from './components';

const UNSELECTED_ROOM = '__select_room__';

function defaultServiceRoom(rooms: Room[], currentRoomId: string) {
  const available = rooms.filter((room) => !room.archived && !room.deletion);
  return (
    available.find((room) => room.id === currentRoomId)?.id ??
    (available.length === 1 ? available[0].id : undefined)
  );
}

function serviceOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return value.trim();
  }
}

function SavedServiceCredential({ account }: { account: ServiceAccount }) {
  const { t } = useApp();
  const [revealed, setRevealed] = useState('');
  const [busy, setBusy] = useState<'show' | 'copy' | ''>('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const forget = () => {
    generation.current++;
    request.current?.abort();
    request.current = null;
    setRevealed('');
    setBusy('');
    setError('');
    setStatus('');
  };
  useEffect(() => {
    active.current = true;
    const hidden = () => {
      if (document.visibilityState === 'hidden') forget();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', forget);
    return () => {
      active.current = false;
      generation.current++;
      request.current?.abort();
      request.current = null;
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', forget);
    };
  }, []);
  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(forget, 60_000);
    return () => clearTimeout(timer);
  }, [revealed]);

  const read = async (action: 'show' | 'copy') => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const attempt = ++generation.current;
    const current = () => active.current && generation.current === attempt;
    setBusy(action);
    setError('');
    setStatus('');
    try {
      const result = await api<ServiceAccountCredential>(
        `/service-accounts/${encodeURIComponent(account.id)}/credential`,
        'POST',
        { expectedRevision: account.revision },
        controller.signal,
      );
      if (!current()) return;
      if (
        result?.accountId !== account.id ||
        result.revision !== account.revision ||
        typeof result.credential !== 'string' ||
        !result.credential
      )
        throw new Error('Invalid credential response.');
      if (action === 'show') {
        setRevealed(result.credential);
        return;
      }
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable.');
        await navigator.clipboard.writeText(result.credential);
        if (current()) setStatus(t('コピーしました', 'Copied'));
      } catch {
        if (!current()) return;
        setRevealed(result.credential);
        setError(
          t(
            'コピーできませんでした。表示した秘密情報を選択して、手動でコピーしてください。',
            'Could not copy. Select the displayed credential and copy it manually.',
          ),
        );
      }
    } catch (caught) {
      if (!current()) return;
      setRevealed('');
      setError(
        caught instanceof ApiError && caught.status === 409
          ? t(
              'サービスの設定が更新されています。閉じて開き直してください。',
              'The service settings changed. Close and reopen them.',
            )
          : caught instanceof ApiError && caught.status === 404
            ? t(
                '保存した秘密情報が見つかりません。設定を読み直してください。',
                'No saved credential was found. Reload the service settings.',
              )
            : t(
                '秘密情報を読み込めませんでした。接続を確認して再度お試しください。',
                'Could not load the credential. Check your connection and try again.',
              ),
      );
    } finally {
      if (current()) {
        request.current = null;
        setBusy('');
      }
    }
  };

  return (
    <div className="service-saved-credential" data-service-saved-credential>
      <div className="service-credential-actions">
        <span>{t('保存済みの秘密情報', 'Saved credential')}</span>
        <div>
          <Button
            type="button"
            icon={revealed ? EyeOff : Eye}
            aria-label={
              revealed
                ? t('秘密情報を隠す', 'Hide saved credential')
                : t('秘密情報を表示', 'Show saved credential')
            }
            aria-expanded={Boolean(revealed)}
            busy={busy === 'show'}
            disabled={Boolean(busy)}
            onClick={() => (revealed ? forget() : void read('show'))}
          >
            {revealed ? t('隠す', 'Hide') : t('表示', 'Show')}
          </Button>
          <Button
            type="button"
            icon={Copy}
            aria-label={t('秘密情報をコピー', 'Copy saved credential')}
            busy={busy === 'copy'}
            disabled={Boolean(busy)}
            onClick={() => void read('copy')}
          >
            {t('コピー', 'Copy')}
          </Button>
        </div>
      </div>
      {revealed && (
        <Field
          label={t('保存した秘密情報', 'Stored credential')}
          hint={t('表示は1分後に隠れます。', 'The value is hidden after one minute.')}
        >
          <textarea
            data-service-credential-value
            readOnly
            rows={2}
            value={revealed}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
          />
        </Field>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
    </div>
  );
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
            const room = data.rooms.find((item) => item.id === service.roomId);
            const sharedBots = [...new Set(service.sharedBotIds || [])]
              .filter((id) => id !== service.botId)
              .map((id) => data.bots.find((item) => item.id === id)?.name || id);
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
                  <dt>{t('対象ルーム', 'Room scope')}</dt>
                  <dd>
                    {service.roomId === null
                      ? t('すべてのルーム（明示的に共有）', 'All rooms (explicit sharing)')
                      : room
                        ? room.name + (room.archived ? t('（アーカイブ）', ' (archived)') : '')
                        : t('ルームが見つかりません', 'Room unavailable')}
                  </dd>
                  <dt>{t('管理するボット', 'Managing bot')}</dt>
                  <dd>{bot?.name || service.botId || t('未割り当て', 'Unassigned')}</dd>
                  <dt>{t('共有するボット', 'Shared bots')}</dt>
                  <dd>{sharedBots.length ? sharedBots.join(t('、', ', ')) : t('なし', 'None')}</dd>
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
                {room?.archived && (
                  <p className="service-card-notes">
                    {t(
                      '稼働中のルームでは利用されません。設定から利用するルームを選び直せます。',
                      'Unavailable in active rooms. Choose the room where it should be used in settings.',
                    )}
                  </p>
                )}
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
  account: initialAccount,
  onClose,
}: {
  account?: ServiceAccount;
  onClose: () => void;
}) {
  const { data, roomId: currentRoomId, t, refresh, toast, connected } = useApp();
  // Keep the draft and its optimistic revision tied to the same opening snapshot.
  const [account] = useState(initialAccount);
  const [name, setName] = useState(account?.name || '');
  const [url, setUrl] = useState(account?.url || '');
  const [login, setLogin] = useState(account?.login || '');
  const [botId, setBotId] = useState(account?.botId || '');
  const [sharedBotIds, setSharedBotIds] = useState(() =>
    [...new Set(account?.sharedBotIds || [])].filter((id) => id !== account?.botId),
  );
  // Empty is deliberate sharing; undefined still requires an owner selection.
  const [roomId, setRoomId] = useState<string | undefined>(() =>
    account
      ? account.roomId === null
        ? ''
        : account.roomId
      : defaultServiceRoom(data.rooms, currentRoomId),
  );
  const [mailAccountId, setMailAccountId] = useState(account?.mailAccountId || '');
  const [status, setStatus] = useState<ServiceAccount['status']>(account?.status || 'pending');
  const [notes, setNotes] = useState(account?.notes || '');
  const [credential, setCredential] = useState('');
  const [clearCredential, setClearCredential] = useState(false);
  const [credentialSectionOpen, setCredentialSectionOpen] = useState(false);
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
  const currentAccount = data.serviceAccounts?.find((item) => item.id === account?.id);
  const deletingRoom = data.rooms.some(
    (room) => (room.id === roomId || room.id === currentAccount?.roomId) && room.deletion,
  );
  const canReadCredential = Boolean(
    account &&
    retained &&
    !busy &&
    !deletingRoom &&
    connected !== false &&
    currentAccount?.credentialConfigured &&
    currentAccount.revision === account.revision &&
    currentAccount.login === account.login &&
    serviceOrigin(currentAccount.url) === serviceOrigin(account.url),
  );
  const linkedMail = data.mailAccounts?.find((mail) => mail.id === mailAccountId);
  const selectedRoom = data.rooms.find((room) => room.id === roomId);
  const rooms = data.rooms.filter(
    (room) =>
      (!room.archived && !room.deletion) || room.id === roomId || room.id === account?.roomId,
  );
  const botEligible = (id: string) =>
    data.bots.some((bot) => bot.id === id) &&
    (roomId === '' ||
      Boolean(
        selectedRoom &&
        !selectedRoom.archived &&
        !selectedRoom.deletion &&
        selectedRoom.botIds.includes(id),
      ));
  const savedShares = [...new Set(account?.sharedBotIds || [])].filter(
    (id) => id !== account?.botId,
  );
  const accessNotExpanded = Boolean(
    account &&
    roomId === (account.roomId === null ? '' : account.roomId) &&
    (!botId || botId === (account.botId || '')) &&
    sharedBotIds.every((id) => savedShares.includes(id)),
  );
  const unavailableMail = Boolean(
    mailAccountId && (!linkedMail || (botId && !linkedMail.botIds.includes(botId))),
  );
  const invalidAssignment =
    unavailableMail && !(accessNotExpanded && mailAccountId === account?.mailAccountId);
  const unavailableBotIds = [botId, ...sharedBotIds].filter((id) => id && !botEligible(id));
  const invalidScope =
    roomId === undefined ||
    (!accessNotExpanded &&
      ((roomId !== '' && (!selectedRoom || selectedRoom.archived)) ||
        unavailableBotIds.length > 0));
  const stale = Boolean(
    account && (!currentAccount || currentAccount.revision !== account.revision),
  );
  const saveBlocked =
    invalidAssignment || invalidScope || stale || connected === false || deletingRoom;
  const managingBots = data.bots.filter((bot) => bot.id === botId || botEligible(bot.id));
  const shareableBotIds = [
    ...new Set([
      ...data.bots.filter((bot) => botEligible(bot.id)).map((bot) => bot.id),
      ...sharedBotIds,
    ]),
  ].filter((id) => id !== botId);
  return (
    <Modal
      title={account ? t('サービスの設定', 'Service settings') : t('サービスを登録', 'Add service')}
      description={t(
        '既存のサービスアカウントと、その利用者を登録します。',
        'Register an existing service account and the bots that use it.',
      )}
      onClose={onClose}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current || saveBlocked) return;
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
                roomId: roomId || null,
                sharedBotIds: sharedBotIds.filter((id) => id !== botId),
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
          <section className="account-settings-section service-room-scope">
            <Field
              label={t('対象ルーム', 'Room scope')}
              hint={t(
                '新しいサービスはこのルームに限定します。ほかのルームでも使う場合だけ、共有を選んでください。',
                'New services stay in one room. Choose sharing only when they should also be used in other rooms.',
              )}
            >
              <select
                value={roomId ?? UNSELECTED_ROOM}
                onChange={(event) =>
                  setRoomId(event.target.value === UNSELECTED_ROOM ? undefined : event.target.value)
                }
              >
                <option value={UNSELECTED_ROOM} disabled>
                  {t('対象ルームを選択してください', 'Choose a room')}
                </option>
                <option value="">
                  {t('すべてのルーム（明示的に共有）', 'All rooms (explicit sharing)')}
                </option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                    {room.archived ? t('（アーカイブ）', ' (archived)') : ''}
                  </option>
                ))}
                {roomId && !rooms.some((room) => room.id === roomId) && (
                  <option value={roomId} disabled>
                    {t('ルームが見つかりません', 'Room unavailable')}
                  </option>
                )}
              </select>
            </Field>
            {roomId === undefined ? (
              <p className="field-hint" role="status">
                {t(
                  '保存先のルームを選んでください。対象が決まるまで保存できません。',
                  'Choose an available room before saving. No sharing scope has been selected.',
                )}
              </p>
            ) : selectedRoom?.archived ? (
              <p className="field-hint" role="status">
                {t(
                  `このサービスはアーカイブ済みのルーム「${selectedRoom.name}」に保管されています。稼働中のルームでは利用されません。管理・共有先と秘密情報を保持したまま、利用するルームを選び直せます。`,
                  `This service is kept in the archived room “${selectedRoom.name}” and is unavailable in active rooms. Choose a room to use it while keeping its manager, shared bots, and credential.`,
                )}
              </p>
            ) : roomId === '' ? (
              <p className="field-hint" role="status">
                {t(
                  '管理・共有先に選んだボットは、それぞれが参加するすべてのルームで利用できます。',
                  'The managing and shared bots can use this service in every room they belong to.',
                )}
              </p>
            ) : unavailableBotIds.length > 0 && accessNotExpanded ? (
              <p className="field-hint" role="status">
                {t(
                  '保存済みの管理・共有先を保持しています。対象ルームに所属しないボットは、このサービスを利用できません。',
                  'Saved assignments are retained. Bots outside the selected room cannot use this service.',
                )}
              </p>
            ) : null}
            {invalidScope && roomId !== undefined && (
              <p className="form-error" role="alert">
                {t(
                  '対象や共有先を変更するには、稼働中のルームと、そのルームに所属する管理・共有先を選んでください。保存済みの割り当ては自動では変更されません。',
                  'To change access, choose an active room and managing/shared bots who belong to it. Saved assignments are not changed automatically.',
                )}
              </p>
            )}
          </section>
          <div className="form-grid">
            <Field
              label={t('管理するボット', 'Managing bot')}
              hint={t(
                'このサービスを利用し、登録情報を更新できるボットです。',
                'This bot can use the service and update its registration.',
              )}
            >
              <select
                value={botId}
                onChange={(event) => {
                  const nextBotId = event.target.value;
                  setBotId(nextBotId);
                  setSharedBotIds((ids) => ids.filter((id) => id !== nextBotId));
                }}
              >
                <option value="">{t('未割り当て', 'Unassigned')}</option>
                {managingBots.map((bot) => (
                  <option key={bot.id} value={bot.id} disabled={!botEligible(bot.id)}>
                    {bot.name}
                    {!botEligible(bot.id) &&
                      t('（対象ルームでは利用不可）', ' (Unavailable in this room)')}
                    {!bot.enabled && t('（停止中）', ' (Disabled)')}
                  </option>
                ))}
                {botId && !data.bots.some((bot) => bot.id === botId) && (
                  <option value={botId} disabled>
                    {botId} · {t('ボットが見つかりません', 'Bot unavailable')}
                  </option>
                )}
              </select>
            </Field>
            <Field
              label={t('登録メールアカウント', 'Registered email account')}
              hint={
                botId
                  ? t(
                      '管理するボットに割り当て済みのメールを選べます。割り当てはメール接続の設定で変更できます。',
                      'Choose email already assigned to the managing bot. Assignments can be changed in the email connection settings.',
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
                {mailAccountId && !linkedMail && (
                  <option value={mailAccountId} disabled>
                    {mailAccountId} · {t('メールが見つかりません', 'Email unavailable')}
                  </option>
                )}
              </select>
              {unavailableMail && !invalidAssignment && (
                <span className="field-hint">
                  {t(
                    '利用できない登録メールへの参照を保持しています。メール接続の設定で確認・変更できます。',
                    'The saved email reference is retained but unavailable. Review it in the email connection settings.',
                  )}
                </span>
              )}
            </Field>
          </div>
          {invalidAssignment && (
            <p className="form-error" role="alert">
              {t(
                '選択中のメールを管理するボットに割り当てるか、登録メールの選択を変更してください。',
                'Assign the selected email to the managing bot, or change the registered email selection.',
              )}
            </p>
          )}
          <section className="account-settings-section service-sharing-section">
            <h3>{t('共有するボット', 'Shared bots')}</h3>
            {shareableBotIds.length ? (
              <div
                className="account-bot-options"
                role="group"
                aria-label={t('共有するボット', 'Shared bots')}
              >
                {shareableBotIds.map((id) => {
                  const bot = data.bots.find((item) => item.id === id);
                  const name = bot?.name || id;
                  const available = botEligible(id);
                  return (
                    <label
                      className={`account-bot-option ${sharedBotIds.includes(id) ? 'checked' : ''}`}
                      key={id}
                    >
                      <Avatar bot={bot} size="small" />
                      <span>
                        <strong>{name}</strong>
                        <small>
                          {!bot
                            ? t('ボットが見つかりません', 'Bot unavailable')
                            : available
                              ? `@${bot.handle}`
                              : t('対象ルームでは利用不可', 'Unavailable in this room')}
                          {bot && !bot.enabled && t(' · 停止中', ' · Disabled')}
                        </small>
                      </span>
                      <input
                        type="checkbox"
                        aria-label={t(`${name}に共有`, `Share with ${name}`)}
                        checked={sharedBotIds.includes(id)}
                        onChange={(event) =>
                          setSharedBotIds((ids) =>
                            event.target.checked
                              ? [...ids, id]
                              : ids.filter((selectedId) => selectedId !== id),
                          )
                        }
                      />
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="field-hint">
                {t(
                  '共有先に選べるほかのボットがありません。',
                  'There are no other bots to share with.',
                )}
              </p>
            )}
            <p className="field-hint">
              {t(
                '対象ルーム内の選んだボットがサービスと保存済みの秘密情報を利用できます。メールの権限は別に設定します。',
                'Selected bots can use the service and its saved credential within the room scope. Email permissions are configured separately.',
              )}
            </p>
            {shareableBotIds.some((id) =>
              data.bots.some((bot) => bot.id === id && !bot.enabled),
            ) && (
              <p className="field-hint">
                {t(
                  '停止中のボットは、再開後に対象ルームで利用できます。',
                  'Disabled bots can use the service in the selected room after they are enabled.',
                )}
              </p>
            )}
          </section>
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
          <details
            className="account-settings-section"
            onToggle={(event) => setCredentialSectionOpen(event.currentTarget.open)}
          >
            <summary>{t('秘密情報', 'Credential')}</summary>
            {account && canReadCredential && credentialSectionOpen && (
              <SavedServiceCredential key={`${account.id}:${account.revision}`} account={account} />
            )}
            <Field
              label={t('パスワードまたはAPIキー', 'Password or API key')}
              hint={
                retained
                  ? t(
                      '設定済み。空欄なら現在の値を保持します。',
                      'Configured. Leave blank to keep the existing credential.',
                    )
                  : t(
                      '必要な場合だけ保存できます。ボットの会話には含まれません。',
                      'Optional. Saved values are not included in bot conversations.',
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
        {deletingRoom && (
          <p className="form-error" role="status">
            {t(
              'このLoomは削除処理中のため、変更できません。',
              'This Loom is being deleted. Changes are unavailable.',
            )}
          </p>
        )}
        {(stale || connected === false) && (
          <p className="form-error" role="alert">
            {stale
              ? t(
                  'サービスの設定が更新または削除されたため保存できません。入力内容を確認してから、閉じて開き直してください。',
                  'The service was changed or removed, so this draft cannot be saved. Review your changes, then close and reopen the settings.',
                )
              : t(
                  '接続が戻るまで保存できません。入力内容は保持しています。',
                  'Saving is unavailable while disconnected. Your draft is retained.',
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
          <Button type="submit" variant="primary" busy={busy} disabled={saveBlocked}>
            {t('サービスを保存', 'Save service')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
