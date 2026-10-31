import { useEffect, useId, useRef, useState } from 'react';
import { ChevronUp, Play, ShieldCheck, Square } from 'lucide-react';
import type { Approval, Task } from '../shared/types';
import { activeStatuses, useApp } from './context';
import { Avatar, Button, Modal, Status } from './components';
import { ApprovalCard } from './ApprovalCard';
import { getTaskStatus } from './task-status';

/** Prefer work needing attention, then active work, then the latest settled task. */
export function selectRoomBotTask(botId: string, tasks: Task[], approvals: Approval[]) {
  const pending = new Set(
    approvals.filter((item) => item.status === 'pending').map((item) => item.taskId),
  );
  const order = (task: Task) => {
    if (pending.has(task.id) && activeStatuses.includes(task.status)) return 0;
    const rank = [
      'awaiting_approval',
      'running',
      'waiting_tool',
      'waiting_model',
      'queued',
    ].indexOf(task.status);
    return rank === -1 ? 10 : rank + 1;
  };
  return tasks
    .filter((task) => task.botId === botId)
    .sort(
      (a, b) =>
        order(a) - order(b) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.id.localeCompare(b.id),
    )[0];
}

export function RoomActivity({
  roomId,
  onFocusTask,
}: {
  roomId: string;
  onFocusTask?: (taskId: string) => void;
}) {
  const { data, t, locale, mutate, connected } = useApp();
  const room = data.rooms.find((item) => item.id === roomId);
  const tasks = data.tasks.filter((item) => item.roomId === roomId);
  const pending = data.approvals
    .filter((item) => item.roomId === roomId && item.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const [expanded, setExpanded] = useState(false);
  const [selectedApproval, setSelectedApproval] = useState<string>();
  const [busyTasks, setBusyTasks] = useState<Set<string>>(new Set());
  const taskLocks = useRef(new Set<string>());
  const tray = useRef<HTMLDivElement>(null);
  const trayId = useId();
  const visible = expanded && pending.length > 0;
  const pendingNames = [
    ...new Set(
      pending.map(
        (item) => data.bots.find((bot) => bot.id === item.botId)?.name || t('ボット', 'Bot'),
      ),
    ),
  ];
  const attentionNames = pendingNames.join(locale === 'ja' ? '・' : ', ');
  const visibleBotIds = new Set([
    ...(room?.botIds || []),
    ...tasks.filter((task) => activeStatuses.includes(task.status)).map((task) => task.botId),
    ...pending.map((item) => item.botId),
  ]);
  const bots = data.bots.filter((bot) => visibleBotIds.has(bot.id));

  useEffect(() => {
    setExpanded(false);
    setSelectedApproval(undefined);
  }, [roomId]);
  useEffect(() => {
    if (!pending.length) {
      setExpanded(false);
      setSelectedApproval(undefined);
    }
  }, [pending.length]);
  useEffect(() => {
    if (!visible || !selectedApproval) return;
    const target = [
      ...(tray.current?.querySelectorAll<HTMLElement>('[data-approval-id]') || []),
    ].find((item) => item.dataset.approvalId === selectedApproval);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
  }, [visible, selectedApproval]);

  async function changeTask(task: Task, action: 'stop' | 'resume') {
    if (taskLocks.current.has(task.id)) return;
    taskLocks.current.add(task.id);
    setBusyTasks(new Set(taskLocks.current));
    try {
      await mutate(`/tasks/${task.id}/${action}`, 'POST');
    } catch {
      // The application mutation handler shows the error and permits retry.
    } finally {
      taskLocks.current.delete(task.id);
      setBusyTasks(new Set(taskLocks.current));
    }
  }

  return (
    <section
      className={`room-activity${pending.length ? ' has-pending-approval' : ''}`}
      data-room-activity={roomId}
      aria-label={t('ルームの実行状況', 'Room activity')}
    >
      <div className="room-activity-heading">
        <span>{t('ボットの状態', 'Bot status')}</span>
        {connected === false && (
          <span className="room-status-unconfirmed">
            {t('再接続中・最新状態を確認できません', 'Reconnecting · current state unconfirmed')}
          </span>
        )}
      </div>
      {pending.length > 0 && (
        <div className="room-approval-notice">
          <ShieldCheck size={19} aria-hidden="true" />
          <div
            className="room-approval-summary"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <strong>
              {t(
                `承認待ち ${pending.length}件`,
                `${pending.length} pending approval${pending.length === 1 ? '' : 's'}`,
              )}
            </strong>
            <span title={attentionNames}>{attentionNames}</span>
          </div>
          <button
            type="button"
            className="room-review-button"
            aria-label={t('承認待ちを確認', 'Review pending approvals')}
            aria-haspopup="dialog"
            aria-expanded={visible}
            aria-controls={visible ? trayId : undefined}
            onClick={() => {
              setSelectedApproval(undefined);
              setExpanded(true);
            }}
          >
            {t('確認する', 'Review')}
            <ChevronUp size={15} />
          </button>
        </div>
      )}
      <div className="room-bot-states" aria-label={t('ボットごとの状態', 'Status by bot')}>
        {bots.map((bot) => {
          const task = selectRoomBotTask(bot.id, tasks, pending);
          const presentation = task ? getTaskStatus(task, data, locale, connected) : undefined;
          const botPending = pending.filter((item) => item.botId === bot.id);
          const multiple = tasks.filter(
            (item) => item.botId === bot.id && activeStatuses.includes(item.status),
          ).length;
          return (
            <div
              key={bot.id}
              className={`room-bot-state${botPending.length ? ' needs-approval' : ''}`}
              data-room-bot-id={bot.id}
              data-room-task-id={task?.id}
              data-phase={presentation?.phase || 'idle'}
            >
              <button
                type="button"
                className="room-bot-state-main"
                disabled={!task && !botPending.length}
                title={presentation?.detail || bot.name}
                aria-label={t(
                  `${bot.name}の状態: ${presentation?.label || (bot.enabled ? '待機中' : '無効')}`,
                  `${bot.name}: ${presentation?.label || (bot.enabled ? 'Idle' : 'Disabled')}`,
                )}
                onClick={() => {
                  if (botPending.length) {
                    setSelectedApproval(botPending[0].id);
                    setExpanded(true);
                  } else if (task) onFocusTask?.(task.id);
                }}
              >
                <Avatar bot={bot} size="small" />
                <span className="room-bot-state-text">
                  <strong title={bot.name}>{bot.name}</strong>
                  {task && presentation ? (
                    <Status status={task.status} presentation={presentation} />
                  ) : (
                    <span className="room-bot-idle">
                      {bot.enabled ? t('待機中', 'Idle') : t('無効', 'Disabled')}
                    </span>
                  )}
                </span>
                {multiple > 1 && (
                  <span
                    className="room-bot-task-count"
                    title={t(
                      `ほかに${multiple - 1}件の作業があります`,
                      `${multiple - 1} other active task${multiple > 2 ? 's' : ''}`,
                    )}
                  >
                    +{multiple - 1}
                  </span>
                )}
              </button>
              {task && (presentation?.active || presentation?.resumable) && (
                <Button
                  type="button"
                  variant="ghost"
                  className="room-task-action"
                  icon={presentation.resumable ? Play : Square}
                  busy={busyTasks.has(task.id)}
                  aria-label={
                    presentation.resumable
                      ? t(`${bot.name}の作業を再開`, `Resume ${bot.name}'s task`)
                      : t(`${bot.name}の作業を停止`, `Stop ${bot.name}'s task`)
                  }
                  onClick={() => void changeTask(task, presentation.resumable ? 'resume' : 'stop')}
                >
                  {presentation.resumable ? t('再開', 'Resume') : t('停止', 'Stop')}
                </Button>
              )}
            </div>
          );
        })}
        {!bots.length && (
          <span className="room-bot-idle">
            {t('参加中のボットはいません', 'No bots in this room')}
          </span>
        )}
      </div>
      {visible && (
        <Modal
          title={t(
            `承認待ちの操作 ${pending.length}件`,
            `${pending.length} pending action${pending.length === 1 ? '' : 's'}`,
          )}
          onClose={() => setExpanded(false)}
          wide
        >
          <div
            ref={tray}
            id={trayId}
            className="room-approval-tray"
            data-approval-tray=""
            role="region"
            aria-label={t('承認待ちの操作', 'Pending actions')}
          >
            {pending.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} />
            ))}
          </div>
        </Modal>
      )}
    </section>
  );
}
