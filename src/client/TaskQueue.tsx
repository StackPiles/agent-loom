import { useState } from 'react';
import { ArrowRight, ListTodo } from 'lucide-react';
import { activeStatuses, dateLabel, useApp } from './context';
import { Avatar, Button, Modal, Status } from './components';
import { getTaskStatus } from './task-status';
import { TaskScheduling, taskQueueDetail, taskSchedulingInfo } from './TaskScheduling';

export function TaskQueueButton() {
  const { data, t } = useApp();
  const [open, setOpen] = useState(false);
  const count = data.tasks.filter((task) => activeStatuses.includes(task.status)).length;
  return (
    <>
      <button
        type="button"
        className={`task-queue-trigger${count ? ' has-tasks' : ''}`}
        aria-label={t(`作業一覧を開く（${count}件）`, `Open task queue (${count})`)}
        title={t('実行中・待機中の作業', 'Running and waiting tasks')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <ListTodo size={16} aria-hidden="true" />
        <span className="task-queue-trigger-label">{t('作業一覧', 'Tasks')}</span>
        {!!count && <span className="task-queue-count">{count}</span>}
      </button>
      {open && <TaskQueue onClose={() => setOpen(false)} />}
    </>
  );
}

export function TaskQueue({ onClose }: { onClose: () => void }) {
  const { data, connected, locale, t, navigate } = useApp();
  const tasks = data.tasks
    .filter((task) => activeStatuses.includes(task.status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return (
    <Modal
      title={t('実行中・待機中の作業', 'Running and waiting tasks')}
      description={t(
        '空いている生成枠を仕事ごとに分け合います。先行指定は最大3回・5分間で、実行中の処理には割り込みません。',
        'Work shares the available generation capacity. Priority lasts for up to 3 requests within 5 minutes and does not interrupt an action already running.',
      )}
      onClose={onClose}
      wide
    >
      <div className="task-queue-overview" data-task-queue>
        <div className="task-queue-summary">
          <strong>{t(`${tasks.length}件の作業`, `${tasks.length} tasks`)}</strong>
          <span>
            {t(
              `生成中 ${data.queue.active} / ${data.queue.capacity ?? data.settings.inference?.maxConcurrentRequests ?? 1}`,
              `Generating ${data.queue.active} / ${data.queue.capacity ?? data.settings.inference?.maxConcurrentRequests ?? 1}`,
            )}
          </span>
        </div>
        {connected === false && (
          <p className="task-queue-unconfirmed" role="status">
            {t(
              '再接続中です。表示は最後に受け取った状態です。',
              'Reconnecting. This is the last received state.',
            )}
          </p>
        )}
        {!tasks.length && (
          <p className="task-queue-empty">
            {t('実行中・待機中の作業はありません。', 'No running or waiting tasks.')}
          </p>
        )}
        {tasks.map((task) => {
          const bot = data.bots.find((item) => item.id === task.botId);
          const room = data.rooms.find((item) => item.id === task.roomId);
          const presentation = getTaskStatus(task, data, locale, connected);
          const detail = taskQueueDetail(task, data, locale);
          const info = taskSchedulingInfo(task, data);
          const work = task.workId
            ? data.workItems?.find((item) => item.id === task.workId)
            : undefined;
          return (
            <article className="task-queue-item" key={task.id} data-queue-task={task.id}>
              <header className="task-queue-item-header">
                <Avatar bot={bot} size="small" />
                <div className="task-queue-identity">
                  <strong>{bot?.name || t('ボット', 'Bot')}</strong>
                  <span>
                    {room?.name || t('ルーム', 'Room')} · {dateLabel(task.createdAt, locale)}
                  </span>
                </div>
                <Status status={task.status} presentation={presentation} />
              </header>
              {work && <p className="task-queue-work">{work.name}</p>}
              <p className="task-queue-prompt" title={task.prompt}>
                {task.prompt}
              </p>
              <p className="task-queue-detail">
                {connected === false ? presentation.detail : detail || presentation.detail}
              </p>
              {info?.purpose === 'compaction' && (
                <span className="task-queue-purpose">{t('会話の要約', 'Context summary')}</span>
              )}
              <TaskScheduling task={task} />
              <div className="task-queue-item-footer">
                <Button
                  type="button"
                  variant="ghost"
                  icon={ArrowRight}
                  onClick={() => {
                    navigate('chat', task.roomId);
                    onClose();
                  }}
                >
                  {t('ルームを開く', 'Open room')}
                </Button>
              </div>
            </article>
          );
        })}
      </div>
    </Modal>
  );
}
