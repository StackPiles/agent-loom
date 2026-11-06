import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Bell, Check, CheckCheck, CircleHelp, Hash, Reply, Send } from 'lucide-react';
import {
  NOTIFICATION_REPLY_BODY_LIMIT,
  resolveNotification,
  type NotificationReplyBlocked,
  type ResolvedNotification,
} from '../shared/notifications';
import type { Notification, NotificationReplyResult } from '../shared/types';
import { api } from './api';
import { dateLabel, useApp, type Locale } from './context';
import { Avatar, Button, EmptyState, PageHeader } from './components';
import { notificationSenderDetails } from './notification-presentation';

function newReplyRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Authenticated HTTP LAN installations still expose getRandomValues.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function unavailableReason(reason: NotificationReplyBlocked | undefined, locale: Locale): string {
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  switch (reason) {
    case 'system':
      return t('Agent Loomからのシステム通知です。', 'This is a system notice from Agent Loom.');
    case 'unknown_sender':
      return t(
        '送信元を特定できる記録がないため、返信できません。',
        'There is no recorded sender to reply to.',
      );
    case 'bot_missing':
      return t(
        'このボットは削除されているため、返信できません。',
        'This bot was deleted and cannot receive replies.',
      );
    case 'bot_disabled':
      return t(
        'このボットは無効になっています。有効にすると返信できます。',
        'Enable this bot before replying.',
      );
    case 'room_missing':
      return t(
        '元のルームが見つからないため、返信できません。',
        'The original room is unavailable.',
      );
    case 'room_archived':
      return t(
        '元のルームはアーカイブされています。ルームを戻すと返信できます。',
        'Restore the archived room before replying.',
      );
    case 'not_member':
      return t(
        'このボットは元のルームに参加していないため、返信できません。',
        'This bot is no longer a member of the original room.',
      );
    case 'source_mismatch':
      return t(
        '送信元と元の会話の記録が一致しないため、返信できません。',
        'The sender and original conversation records do not match.',
      );
    default:
      return '';
  }
}

function replyIdentity(item: Notification, source: ResolvedNotification): string {
  return JSON.stringify([
    item.id,
    item.roomId,
    source.sender.kind === 'bot' ? source.sender.botId : source.sender.kind,
    item.taskId,
    item.messageId,
    item.title,
    item.body,
    item.createdAt,
  ]);
}

function NotificationCard({
  item,
  present,
  anotherReplyOpen,
  onReplyOpen,
  onReplyClose,
}: {
  item: Notification;
  present: boolean;
  anotherReplyOpen: boolean;
  onReplyOpen: (item: Notification) => void;
  onReplyClose: (id: string) => void;
}) {
  const { data, t, locale, connected, mutate, navigate, refresh, toast } = useApp();
  const source = resolveNotification(item, data);
  const sender = notificationSenderDetails(source, locale);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const identity = useRef('');
  const attempt = useRef<{ requestId: string; body: string } | null>(null);
  const inFlight = useRef(false);
  const composing = useRef(false);
  const mounted = useRef(true);
  const fieldId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const changed = open && identity.current !== replyIdentity(item, source);
  const unavailable = !present
    ? t(
        'このお知らせは現在のデータにありません。入力内容は保持されています。',
        'This notice is no longer in the current data. Your draft is kept.',
      )
    : changed
      ? t(
          'お知らせの宛先や内容が変わりました。入力内容を控え、返信欄を閉じて確認し直してください。',
          'The recipient or original notice changed. Keep a copy of your draft, then close this reply and review the notice again.',
        )
      : unavailableReason(source.replyBlocked, locale);
  const canSubmit =
    present &&
    !changed &&
    source.canReply &&
    connected !== false &&
    body.trim().length > 0 &&
    body.trim().length <= NOTIFICATION_REPLY_BODY_LIMIT;
  const renamed =
    source.sender.kind === 'bot' &&
    source.senderBasis === 'saved' &&
    source.bot &&
    (source.sender.name !== source.bot.name || source.sender.handle !== source.bot.handle);
  const currentName = source.bot?.name || sender.name;
  const currentHandle = source.bot?.handle || sender.handle;

  function openReply() {
    if (!present || !source.canReply || open || anotherReplyOpen || inFlight.current) return;
    identity.current = replyIdentity(item, source);
    attempt.current = null;
    setError('');
    setSent(false);
    setOpen(true);
    onReplyOpen(item);
  }
  function closeReply() {
    if (inFlight.current) return;
    setOpen(false);
    setBody('');
    setError('');
    attempt.current = null;
    onReplyClose(item.id);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || inFlight.current || composing.current) return;
    const text = body.trim();
    inFlight.current = true;
    setSending(true);
    setError('');
    let result: NotificationReplyResult;
    try {
      if (attempt.current?.body !== text)
        attempt.current = { requestId: newReplyRequestId(), body: text };
      result = await api<NotificationReplyResult>(
        `/notifications/${encodeURIComponent(item.id)}/reply`,
        'POST',
        attempt.current,
      );
    } catch (cause) {
      if (mounted.current)
        setError(
          t(
            '返信を送信できませんでした。入力内容は残っています。',
            'Could not send your reply. Your draft is kept.',
          ) +
            ' ' +
            (cause instanceof Error
              ? cause.message
              : t('接続を確認してください。', 'Check your connection.')),
        );
      return;
    } finally {
      inFlight.current = false;
      if (mounted.current) setSending(false);
    }
    // A successful POST remains accepted even when the subsequent refresh fails.
    if (mounted.current) {
      setBody('');
      attempt.current = null;
      setOpen(false);
      setSent(true);
      onReplyClose(item.id);
      navigate('chat', result.message.roomId);
    }
    toast(t(`${currentName}に返信しました`, `Reply sent to ${currentName}`));
    void refresh().catch(() => {
      toast(
        t(
          '返信は送信済みです。最新の表示を取得できませんでした。',
          'Your reply was sent, but the latest view could not be refreshed.',
        ),
        'error',
      );
    });
  }

  return (
    <article
      data-notification-id={item.id}
      className={`notification-card ${item.read ? 'read' : 'unread'}${open ? ' replying' : ''}`}
      aria-labelledby={`${fieldId}-title`}
    >
      <span className="notification-symbol notification-sender-avatar">
        {source.sender.kind === 'bot' ? (
          <Avatar bot={source.bot ?? { name: sender.name, avatar: 'bot', color: '#8c9192' }} />
        ) : source.sender.kind === 'system' ? (
          <Bell size={19} aria-hidden="true" />
        ) : (
          <CircleHelp size={19} aria-hidden="true" />
        )}
        {!item.read && <i aria-hidden="true" />}
        {!item.read && <span className="visually-hidden">{t('未読', 'Unread')}</span>}
      </span>
      <div className="notification-content">
        <header className="notification-heading">
          <div className="notification-source">
            <div className="notification-sender">
              {sender.basis && <span className="notification-sender-basis">{sender.basis}</span>}
              <strong>{sender.name}</strong>
              {sender.handle && (
                <span className="notification-sender-handle">@{sender.handle}</span>
              )}
            </div>
            <div className="notification-room">
              <Hash size={12} aria-hidden="true" />
              <span>
                {source.room?.name ||
                  (item.roomId
                    ? t('ルームを確認できません', 'Room unavailable')
                    : t('ワークスペース全体', 'Workspace'))}
              </span>
              {source.room?.archived && <span>{t('アーカイブ', 'Archived')}</span>}
            </div>
            {renamed && (
              <small className="notification-current-sender">
                {t('現在のボット名', 'Current bot name')}: {currentName} (@{currentHandle})
              </small>
            )}
          </div>
          <time dateTime={item.createdAt}>{dateLabel(item.createdAt, locale, true)}</time>
        </header>
        <h2 id={`${fieldId}-title`}>{item.title}</h2>
        <p className="notification-body">{item.body}</p>
        {unavailable && <p className="notification-unavailable">{unavailable}</p>}
        <footer className="notification-actions">
          {source.sender.kind === 'bot' && (
            <button
              type="button"
              className="text-button notification-reply-open"
              data-notification-reply={item.id}
              aria-label={t(`${sender.name}に返信`, `Reply to ${sender.name}`)}
              aria-expanded={open}
              aria-controls={open ? `${fieldId}-form` : undefined}
              disabled={!present || !source.canReply || open || sending || anotherReplyOpen}
              title={
                !source.canReply
                  ? unavailable
                  : anotherReplyOpen
                    ? t(
                        '開いている返信を送信するか、キャンセルしてください。',
                        'Send or cancel the open reply first.',
                      )
                    : undefined
              }
              onClick={openReply}
            >
              <Reply size={15} aria-hidden="true" />
              {t('返信', 'Reply')}
            </button>
          )}
          {source.room && !source.room.archived && present && (
            <button
              type="button"
              className="text-button"
              disabled={sending}
              onClick={() => {
                if (!item.read && connected !== false)
                  void mutate('/notifications/read', 'POST', { id: item.id }).catch(() => {});
                navigate('chat', source.room!.id);
              }}
            >
              {t('ルームを開く', 'Open conversation')}
              <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          )}
          {!item.read && present && (
            <button
              type="button"
              className="text-button muted"
              disabled={sending || connected === false}
              onClick={() =>
                void mutate('/notifications/read', 'POST', { id: item.id }).catch(() => {})
              }
            >
              <Check size={14} aria-hidden="true" />
              {t('既読にする', 'Mark as read')}
            </button>
          )}
        </footer>
        {open && (
          <form
            id={`${fieldId}-form`}
            className="notification-reply-form"
            data-notification-reply-form={item.id}
            onSubmit={(event) => void submit(event)}
            aria-busy={sending}
          >
            <label htmlFor={fieldId} className="notification-reply-label">
              {t(`${currentName}に返信`, `Reply to ${currentName}`)}
            </label>
            <p className="notification-reply-help" id={`${fieldId}-help`}>
              {t(
                `「${source.room?.name ?? ''}」ルームで ${currentName}${currentHandle ? ` (@${currentHandle})` : ''} に送ります。返信はそのルームで共有されます。`,
                `Send to ${currentName}${currentHandle ? ` (@${currentHandle})` : ''} in “${source.room?.name ?? ''}”. Your reply is shared in that room.`,
              )}
            </p>
            <textarea
              id={fieldId}
              value={body}
              rows={4}
              autoFocus
              required
              maxLength={NOTIFICATION_REPLY_BODY_LIMIT}
              disabled={sending}
              aria-describedby={`${fieldId}-help`}
              placeholder={t('このお知らせへの返信を入力…', 'Write a reply to this notice…')}
              onChange={(event) => setBody(event.target.value)}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
                if (
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229 ||
                  composing.current
                )
                  return;
                event.preventDefault();
                if (canSubmit && !inFlight.current) event.currentTarget.form?.requestSubmit();
              }}
            />
            {source.room?.paused && (
              <p className="notification-reply-status">
                {t(
                  'ルームは停止中です。返信は保存され、ルームを再開するとボットが対応します。',
                  'This room is paused. Your reply will be saved, and the bot will respond after the room is resumed.',
                )}
              </p>
            )}
            {connected === false && (
              <p className="notification-reply-status" role="status">
                {t(
                  '接続が戻るまで送信できません。入力内容は保持されています。',
                  'Reconnect to send. Your draft is kept.',
                )}
              </p>
            )}
            {error && (
              <p className="notification-reply-error" role="alert">
                {error}
              </p>
            )}
            <div className="notification-reply-controls">
              <small>{t('Ctrl / ⌘ + Enterで送信', 'Ctrl / ⌘ + Enter to send')}</small>
              <div>
                <Button type="button" variant="ghost" disabled={sending} onClick={closeReply}>
                  {t('キャンセル', 'Cancel')}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  icon={Send}
                  busy={sending}
                  disabled={!canSubmit}
                >
                  {sending ? t('送信中…', 'Sending…') : t('返信を送信', 'Send reply')}
                </Button>
              </div>
            </div>
          </form>
        )}
        {sent && (
          <p className="notification-reply-sent" role="status">
            {t(
              '返信を送信しました。回答はルームで確認できます。',
              'Reply sent. Follow the answer in the room.',
            )}
          </p>
        )}
      </div>
    </article>
  );
}

export function InboxPage() {
  const { data, t, connected, mutate } = useApp();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [openReplies, setOpenReplies] = useState<Map<string, Notification>>(() => new Map());
  const unread = data.notifications.filter((item) => !item.read).length;
  const currentIds = new Set(data.notifications.map((item) => item.id));
  const notifications = [
    ...data.notifications,
    ...[...openReplies.values()].filter((item) => !currentIds.has(item.id)),
  ]
    .filter((item) => !unreadOnly || !item.read || openReplies.has(item.id))
    .reverse();
  return (
    <div className="page-scroll">
      <div className="page-container inbox-container">
        <PageHeader
          title={t('お知らせ', 'Inbox')}
          description={t(
            '送信元を確認し、ボットへの返信をここから送れます。',
            'See who sent each update and reply to the bot here.',
          )}
          action={
            <Button
              icon={CheckCheck}
              disabled={!unread || connected === false}
              onClick={() =>
                void mutate(
                  '/notifications/read',
                  'POST',
                  {},
                  t('すべて既読にしました', 'All notifications marked as read'),
                ).catch(() => {})
              }
            >
              {t('すべて既読に', 'Mark all as read')}
            </Button>
          }
        />
        <div className="page-tabs">
          <button className={!unreadOnly ? 'selected' : ''} onClick={() => setUnreadOnly(false)}>
            {t('すべて', 'All updates')}
            <span>{data.notifications.length}</span>
          </button>
          <button className={unreadOnly ? 'selected' : ''} onClick={() => setUnreadOnly(true)}>
            {t('未読', 'Unread')}
            <span>{unread}</span>
          </button>
        </div>
        {unreadOnly && openReplies.size > 0 && (
          <p className="notification-filter-note">
            {t(
              '返信中のお知らせは、既読になっても表示しています。',
              'Notices with an open reply stay visible when marked as read.',
            )}
          </p>
        )}
        {notifications.length ? (
          <div className="notification-list">
            {notifications.map((item) => (
              <NotificationCard
                key={item.id}
                item={item}
                present={currentIds.has(item.id)}
                anotherReplyOpen={openReplies.size > 0 && !openReplies.has(item.id)}
                onReplyOpen={(notice) =>
                  setOpenReplies((current) => new Map(current).set(notice.id, notice))
                }
                onReplyClose={(id) =>
                  setOpenReplies((current) => {
                    const next = new Map(current);
                    next.delete(id);
                    return next;
                  })
                }
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={unreadOnly ? CheckCheck : Bell}
            title={
              unreadOnly
                ? t('未読のお知らせはありません', 'No unread notifications')
                : t('お知らせはありません', 'No notifications yet')
            }
          >
            {t(
              '作業の結果や自動化からのお知らせが、ここにまとまります。',
              'Task results and automation updates appear here.',
            )}
          </EmptyState>
        )}
      </div>
    </div>
  );
}
