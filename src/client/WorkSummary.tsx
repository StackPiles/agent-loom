import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Task } from '../shared/types';
import type { WorkItem } from '../shared/work';
import { formatScheduleInstant } from '../shared/schedules';
import { activeStatuses, dateLabel, useApp } from './context';
import { workCompletionLabel } from './work-completion';

export function needsWorkAttention(work: WorkItem, tasks: readonly Task[]): boolean {
  if (work.status === 'completed' || work.status === 'cancelled') return false;
  return (
    work.status === 'blocked' ||
    work.completionReview?.status === 'needs_review' ||
    Boolean(work.completionReview?.lastError) ||
    work.checkpoint.uncertainActions.length > 0 ||
    tasks.some((task) => task.workId === work.id && task.status === 'awaiting_approval')
  );
}

export function readViewPreference(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveViewPreference(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable or full; the current view must still work.
  }
}

export function useViewPreference(key: string, fallback: string) {
  const [state, setState] = useState(() => ({
    key,
    value: readViewPreference(key) ?? fallback,
  }));
  // A workspace can change without unmounting the page. Never carry its view into another key.
  const value = state.key === key ? state.value : (readViewPreference(key) ?? fallback);
  const save = (value: string) => {
    setState({ key, value });
    saveViewPreference(key, value);
  };
  return [value, save] as const;
}

export function WorkSummary({ work, children }: { work: WorkItem; children: ReactNode }) {
  const { data, t, locale } = useApp();
  const storageKey = `loom:work-detail:${data.settings.workspacePath}:${work.id}`;
  const [preference, setPreference] = useViewPreference(storageKey, 'closed');
  const open = preference === 'open';
  const room = data.rooms.find((item) => item.id === work.roomId);
  const settled = work.status === 'completed' || work.status === 'cancelled';
  const next = (data.wakeups || [])
    .filter((item) => item.workId === work.id && item.status === 'scheduled')
    .sort(
      (a, b) =>
        (a.nextRunAt || '\uffff').localeCompare(b.nextRunAt || '\uffff') ||
        a.id.localeCompare(b.id),
    )[0];
  const active = data.tasks.filter(
    (task) => task.workId === work.id && activeStatuses.includes(task.status),
  );
  const approval = active.some((task) => task.status === 'awaiting_approval');
  const needsAttention = needsWorkAttention(work, data.tasks);
  const label =
    workCompletionLabel(work, locale) ||
    {
      active: approval
        ? t('承認待ち', 'Awaiting approval')
        : active.length
          ? t('実行中', 'Running')
          : next
            ? t('起床待ち', 'Waiting for wake-up')
            : work.deferredFromWorkId
              ? t('後続の仕事・未着手', 'Saved follow-up')
              : t('継続中', 'Ongoing'),
      paused: t('一時停止', 'Paused'),
      blocked: work.checkpoint.uncertainActions.length
        ? t('操作結果の確認待ち', 'Awaiting outcome review')
        : t('再開待ち', 'Awaiting resumption'),
      completed: t('完了', 'Completed'),
      cancelled: t('中止', 'Cancelled'),
    }[work.status];
  const assignedIds = active.length
    ? [...new Set(active.map((task) => task.botId))]
    : next && !settled
      ? [next.botId]
      : [work.createdByBotId];
  const assignees = assignedIds
    .map((id) => data.bots.find((bot) => bot.id === id))
    .map((bot) => (bot ? `@${bot.handle}` : t('削除されたボット', 'Removed bot')))
    .join(', ');
  const held =
    work.status !== 'active' || room?.paused || (room?.autonomousWakeups?.mode || 'off') === 'off';
  let nextTime = t('次回時刻を確認してください', 'Review the next time');
  if (next?.nextRunAt) {
    try {
      nextTime = formatScheduleInstant(next.nextRunAt, next.schedule.timeZone, locale);
    } catch {
      nextTime = dateLabel(next.nextRunAt, locale, true);
    }
  }
  return (
    <details
      className="compact-work"
      data-work-summary-id={work.id}
      data-needs-attention={needsAttention || undefined}
      open={open}
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        setPreference(event.currentTarget.open ? 'open' : 'closed');
      }}
      style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)' }}
    >
      <summary
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '12px 14px',
          cursor: 'pointer',
          listStyle: 'none',
        }}
      >
        <ChevronRight
          size={16}
          aria-hidden="true"
          style={{ marginTop: 3, transform: open ? 'rotate(90deg)' : undefined }}
        />
        <span
          style={{
            display: 'flex',
            flex: 1,
            minWidth: 0,
            flexWrap: 'wrap',
            alignItems: 'flex-start',
            gap: '6px 12px',
          }}
        >
          <span style={{ flex: '1 1 240px', minWidth: 0 }}>
            <strong
              title={work.name}
              style={{
                display: 'block',
                fontSize: 13,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {work.name}
            </strong>
            <span
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '3px 10px',
                marginTop: 5,
                fontSize: 11,
                color: 'var(--sage-dark)',
                overflowWrap: 'anywhere',
              }}
            >
              <span>#{room?.name || t('ルーム', 'Room')}</span>
              <span>
                {active.length || (next && !settled)
                  ? t('担当：', 'Assigned: ')
                  : t('作成：', 'Created by ')}
                {assignees}
              </span>
              {!settled && next && (
                <span>
                  {held ? t('保留中の予約：', 'Held wake-up: ') : t('次回：', 'Next: ')}
                  {nextTime}
                </span>
              )}
              {!settled &&
              !next &&
              work.completionReview?.status === 'waiting' &&
              work.completionReview.waitUntil ? (
                <span>
                  {t('再判断：', 'Reassess: ')}
                  {dateLabel(work.completionReview.waitUntil, locale, true)}
                </span>
              ) : !settled && !next ? (
                <span>{t('次の予約なし', 'No upcoming wake-up')}</span>
              ) : null}
            </span>
          </span>
          <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <span className={`autonomous-work-status autonomous-work-status-${work.status}`}>
              {label}
            </span>
            {needsAttention && (
              <span
                className="work-attention-badge"
                style={{
                  padding: '3px 7px',
                  borderRadius: 12,
                  background: 'var(--amber-soft)',
                  color: 'var(--amber)',
                  fontSize: 11,
                }}
              >
                {t('要対応', 'Needs attention')}
              </span>
            )}
          </span>
        </span>
      </summary>
      <div style={{ padding: '0 8px 8px' }}>{children}</div>
    </details>
  );
}
