import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ArrowUpRight, FileText, Play } from 'lucide-react';
import type { Task } from '../shared/types';
import { getTaskRequestSource } from '../shared/message-context';
import { dateLabel, useApp } from './context';
import { Button, Modal, Status } from './components';
import { WorkCard } from './AutonomousWork';
import { getTaskStatus } from './task-status';
import { getTaskWork, taskWorkResumeDetail } from './task-work';
import { isArchivedTask, TaskArchiveButton, TaskArchiveReason } from './TaskArchive';

const recoveryStatuses = ['failed', 'stopped', 'interrupted'];
const TaskDetailsContext = createContext<((taskId: string) => void) | null>(null);

/** Keep an open detail independent of task cards that can move to history during a live update. */
export function TaskDetailsProvider({
  roomId,
  children,
}: {
  roomId?: string;
  children: ReactNode;
}) {
  const [selection, setSelection] = useState<{ roomId: string; taskId: string }>();
  const open = useCallback(
    (taskId: string) => {
      if (roomId) setSelection({ roomId, taskId });
    },
    [roomId],
  );
  useEffect(() => {
    setSelection((current) => (current?.roomId === roomId ? current : undefined));
  }, [roomId]);
  return (
    <TaskDetailsContext.Provider value={open}>
      {children}
      {selection && selection.roomId === roomId && (
        <TaskDetailsDialog
          key={selection.taskId}
          taskId={selection.taskId}
          onClose={() => setSelection(undefined)}
        />
      )}
    </TaskDetailsContext.Provider>
  );
}

function TaskResumeButton({
  task,
  className,
  label,
}: {
  task: Task;
  className?: string;
  label?: string;
}) {
  const { data, t, mutate, connected } = useApp();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const room = data.rooms.find((item) => item.id === task.roomId);
  if (
    !recoveryStatuses.includes(task.status) ||
    isArchivedTask(task) ||
    (task.workId && getTaskWork(task, data)?.status !== 'active')
  )
    return null;
  return (
    <Button
      type="button"
      variant="ghost"
      className={className}
      icon={Play}
      busy={busy}
      disabled={connected === false}
      data-task-resume-action={task.id}
      aria-label={label || t('この作業を再開', 'Resume this task')}
      title={
        room?.paused
          ? t(
              '待ち行列に戻します。ルームの再開後に実行します。',
              'Return this task to the queue. It runs after the room resumes.',
            )
          : t('この作業を再開', 'Resume this task')
      }
      onClick={async () => {
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        try {
          await mutate(`/tasks/${task.id}/resume`, 'POST');
        } catch {
          // The application mutation handler shows the error and permits retry.
        } finally {
          lock.current = false;
          setBusy(false);
        }
      }}
    >
      {t('再開', 'Resume')}
    </Button>
  );
}

/** Used by both the chat run and the room's bot activity, only for the latest run. */
export function TaskRecoveryActions({
  task,
  className,
  resumeLabel,
}: {
  task: Task;
  className?: string;
  resumeLabel?: string;
}) {
  const { t } = useApp();
  const openSharedDetails = useContext(TaskDetailsContext);
  const [open, setOpen] = useState(false);
  return (
    <>
      <span className="task-recovery-actions">
        <Button
          type="button"
          variant="ghost"
          className={className}
          icon={FileText}
          data-task-details-action={task.id}
          onClick={() => (openSharedDetails ? openSharedDetails(task.id) : setOpen(true))}
        >
          {task.workId ? t('仕事を確認', 'Review work') : t('内容を確認', 'View task')}
        </Button>
        <TaskResumeButton task={task} className={className} label={resumeLabel} />
        <TaskArchiveButton task={task} className={className} />
      </span>
      {!openSharedDetails && open && (
        <TaskDetailsDialog taskId={task.id} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

export function TaskDetailsDialog({
  taskId,
  onClose,
  onOpenRoom = onClose,
}: {
  taskId: string;
  onClose: () => void;
  onOpenRoom?: () => void;
}) {
  const { data, t, locale, navigate, connected } = useApp();
  const task = data.tasks.find((item) => item.id === taskId);
  const work = task && getTaskWork(task, data);
  const bot = task && data.bots.find((item) => item.id === task.botId);
  const source = getTaskRequestSource(task, new Map(data.tasks.map((item) => [item.id, item])));
  const wakeup =
    task?.wakeupId &&
    data.wakeups?.find(
      (item) =>
        item.id === task.wakeupId &&
        item.workId === task.workId &&
        item.roomId === task.roomId &&
        item.botId === task.botId,
    );
  const sourceLabel =
    wakeup && source.kind === 'automation'
      ? t('自律予約による起床', 'Autonomous wake-up')
      : source.kind === 'user'
        ? t('ユーザーからの依頼', 'User request')
        : source.kind === 'bot'
          ? t(
              `${data.bots.find((item) => item.id === source.botId)?.name || source.botId}からの依頼`,
              `Request from ${data.bots.find((item) => item.id === source.botId)?.name || source.botId}`,
            )
          : source.kind === 'automation'
            ? t('自動実行', 'Automation')
            : source.kind === 'learning'
              ? t('学習', 'Learning')
              : t('記録からは特定できません', 'Not established by the stored record');
  const recoveryDetail = task && taskWorkResumeDetail(task, data, locale);
  return (
    <Modal
      title={t('作業内容と関連する仕事', 'Task details and associated work')}
      description={t(
        '当初の指示と現在の進捗を比べて、未完了の作業か確認できます。',
        'Compare the original instruction with current progress to decide whether this task is still needed.',
      )}
      onClose={onClose}
      wide
    >
      <div className="task-details" data-task-details={taskId}>
        {!task ? (
          <p>{t('作業の情報を確認できません。', 'Task information is unavailable.')}</p>
        ) : (
          <>
            <div className="task-details-meta">
              <strong>{bot?.name || task.botId}</strong>
              <Status
                status={task.status}
                presentation={getTaskStatus(task, data, locale, connected)}
              />
              <span>{sourceLabel}</span>
              {isArchivedTask(task) && (
                <span className="task-archived-label">{t('履歴へ移動済み', 'Archived')}</span>
              )}
              <span>
                {t('作成', 'Created')}: {dateLabel(task.createdAt, locale, true)}
              </span>
              <span>
                {t('更新', 'Updated')}: {dateLabel(task.updatedAt, locale, true)}
              </span>
            </div>
            <TaskArchiveReason task={task} />
            {connected === false && (
              <p className="task-recovery-note" role="status">
                {t(
                  '再接続中のため、最新の状態を確認できません。',
                  'Reconnecting. The current state cannot be confirmed.',
                )}
              </p>
            )}
            <details className="task-original-instruction" open>
              <summary>{t('この作業への当初の指示', 'Original instruction for this task')}</summary>
              <p>
                {work
                  ? t(
                      '作成時に保存された指示です。その後の進捗は下の仕事で確認してください。',
                      'This instruction was saved when the task was created. Check the work below for later progress.',
                    )
                  : t(
                      '作成時に保存された指示です。その後の結果はルームで確認してください。',
                      'This instruction was saved when the task was created. Check the room for later results.',
                    )}
              </p>
              <pre data-task-original-prompt="" tabIndex={0}>
                {task.prompt}
              </pre>
            </details>
            {task.error && <p className="run-error task-details-error">{task.error}</p>}
            {recoveryDetail && (
              <p className="task-recovery-note" data-task-work-hold="">
                {recoveryDetail}
              </p>
            )}
            {work && (
              <section
                className="task-details-work"
                aria-label={t('仕事の現在の状況', 'Current work status')}
              >
                <h3>{t('仕事の現在の状況', 'Current work status')}</h3>
                <p className="task-recovery-note">
                  {t(
                    '現在の進捗・次の行動・予約を確認してください。すでに済んだ作業は再開せず、停止したまま残せます。仕事を再開しても、この古い作業は自動では再開しません。',
                    'Review current progress, next steps and wake-ups. If this task is already covered, it can stay stopped. Resuming the work does not automatically resume this old task.',
                  )}
                </p>
                <WorkCard work={work} onOpenRoom={onOpenRoom} />
              </section>
            )}
            <div className="task-details-identifiers">
              <span>
                Task ID: <code>{task.id}</code>
              </span>
              {task.workId && (
                <span>
                  Work ID: <code>{task.workId}</code>
                </span>
              )}
            </div>
            <footer className="task-details-actions">
              {!work && (
                <Button
                  variant="ghost"
                  icon={ArrowUpRight}
                  onClick={() => {
                    onOpenRoom();
                    navigate('chat', task.roomId);
                  }}
                >
                  {t('ルームで結果を見る', 'View results in room')}
                </Button>
              )}
              <TaskResumeButton task={task} />
              <TaskArchiveButton task={task} />
              <Button onClick={onClose}>{t('閉じる', 'Close')}</Button>
            </footer>
          </>
        )}
      </div>
    </Modal>
  );
}
