import { ChevronDown, Reply } from 'lucide-react';
import { isNotificationReplyContext } from '../shared/notifications';
import type { NotificationReplyContext } from '../shared/types';
import type { Locale } from './context';
import { Markdown } from './components';

export function NotificationReplyQuote({
  reply,
  locale,
}: {
  reply: NotificationReplyContext;
  locale: Locale;
}) {
  if (!isNotificationReplyContext(reply)) return null;
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  return (
    <details
      className="notification-reply-quote"
      data-notification-reply-quote={reply.notificationId}
    >
      <summary>
        <Reply size={14} aria-hidden="true" />
        <span>
          <span className="notification-reply-quote-label">
            {t('お知らせへの返信', 'Reply to notification')} · {reply.senderName} (@
            {reply.senderHandle})
          </span>
          <strong>{reply.title}</strong>
        </span>
        <ChevronDown size={14} className="notification-quote-toggle" aria-hidden="true" />
      </summary>
      <blockquote>
        <Markdown>{reply.body}</Markdown>
      </blockquote>
    </details>
  );
}
