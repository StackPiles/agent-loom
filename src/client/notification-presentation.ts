import { resolveNotification, type ResolvedNotification } from '../shared/notifications';
import type { Notification, Snapshot } from '../shared/types';
import type { Locale } from './context';

export function notificationSenderDetails(source: ResolvedNotification, locale: Locale) {
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  if (source.sender.kind === 'system')
    return { name: 'Agent Loom', handle: '', label: 'Agent Loom', basis: t('システム', 'System') };
  if (source.sender.kind === 'unknown') {
    const name = t('送信元不明', 'Unknown sender');
    return { name, handle: '', label: name, basis: '' };
  }
  const name = source.sender.name || t('削除されたボット', 'Deleted bot');
  const handle = source.sender.handle;
  return {
    name,
    handle,
    label: handle ? `${name} (@${handle})` : name,
    basis: source.senderBasis === 'task' ? t('担当ボット', 'Responsible bot') : t('送信元', 'From'),
  };
}

export function notificationDesktopTitle(
  notification: Notification,
  snapshot: Pick<Snapshot, 'bots' | 'rooms' | 'tasks' | 'messages'>,
  locale: Locale,
): string {
  const source = resolveNotification(notification, snapshot);
  const sender = notificationSenderDetails(source, locale);
  const label = source.senderBasis === 'task' ? `${sender.basis}: ${sender.label}` : sender.label;
  return `${label} · ${notification.title}`;
}
