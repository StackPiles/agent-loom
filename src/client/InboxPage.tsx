import { useState } from 'react';
import { ArrowUpRight, Bell, Check, CheckCheck } from 'lucide-react';
import { dateLabel, useApp } from './context';
import { Button, EmptyState, PageHeader } from './components';

export function InboxPage() {
  const { data, t, locale, mutate, navigate } = useApp();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const unread = data.notifications.filter((item) => !item.read).length;
  const notifications = data.notifications
    .filter((item) => !unreadOnly || !item.read)
    .slice()
    .reverse();
  return (
    <div className="page-scroll">
      <div className="page-container inbox-container">
        <PageHeader
          title={t('お知らせ', 'Inbox')}
          description={t(
            'タスクの結果と自動化からの通知を確認します。',
            'Review task results and automation notifications.',
          )}
          action={
            <Button
              icon={CheckCheck}
              disabled={!unread}
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
        {notifications.length ? (
          <div className="notification-list">
            {notifications.map((item) => (
              <article
                key={item.id}
                className={`notification-card ${item.read ? 'read' : 'unread'}`}
              >
                <span className="notification-symbol">
                  <Bell size={19} />
                  {!item.read && <i />}
                </span>
                <div>
                  <header>
                    <h2>{item.title}</h2>
                    <time>{dateLabel(item.createdAt, locale, true)}</time>
                  </header>
                  <p>{item.body}</p>
                  <footer>
                    {item.roomId && (
                      <button
                        className="text-button"
                        onClick={() => {
                          if (!item.read)
                            void mutate('/notifications/read', 'POST', { id: item.id }).catch(
                              () => {},
                            );
                          navigate('chat', item.roomId);
                        }}
                      >
                        {t('ルームを開く', 'Open conversation')}
                        <ArrowUpRight size={14} />
                      </button>
                    )}
                    {!item.read && (
                      <button
                        className="text-button muted"
                        onClick={() =>
                          void mutate('/notifications/read', 'POST', { id: item.id }).catch(
                            () => {},
                          )
                        }
                      >
                        <Check size={14} />
                        {t('既読にする', 'Mark as read')}
                      </button>
                    )}
                  </footer>
                </div>
              </article>
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
