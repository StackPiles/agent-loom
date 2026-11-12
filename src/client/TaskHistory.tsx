import { useEffect, useState } from 'react';
import { Archive, FileText, History, Undo2 } from 'lucide-react';
import type { Task } from '../shared/types';
import { dateLabel, useApp } from './context';
import { Button, Modal, Status } from './components';
import { TaskDetailsDialog } from './TaskRecovery';
import { canArchiveTask, isArchivedTask, isSettledTask, useTaskArchive } from './TaskArchive';
import { getTaskStatus } from './task-status';
import { getTaskWork } from './task-work';

type Mode = 'review' | 'archived';

export function TaskHistoryControls({
  roomId,
  pendingTaskIds,
}: {
  roomId: string;
  pendingTaskIds: string[];
}) {
  const { data, t } = useApp();
  const [mode, setMode] = useState<Mode>();
  const archived = data.tasks.filter((task) => task.roomId === roomId && isArchivedTask(task));
  useEffect(() => setMode(undefined), [roomId]);
  if (!pendingTaskIds.length && !archived.length && !mode) return null;
  return (
    <>
      <div className="task-history-controls" data-task-history-controls={roomId}>
        {pendingTaskIds.length > 0 && (
          <Button
            variant="ghost"
            icon={Archive}
            data-task-review-list={roomId}
            onClick={() => setMode('review')}
          >
            {t(
              `停止した作業を整理 (${pendingTaskIds.length})`,
              `Review stopped tasks (${pendingTaskIds.length})`,
            )}
          </Button>
        )}
        {archived.length > 0 && (
          <Button
            variant="ghost"
            icon={History}
            data-task-history-open={roomId}
            onClick={() => setMode('archived')}
          >
            {t(`タスク履歴 (${archived.length})`, `Task history (${archived.length})`)}
          </Button>
        )}
      </div>
      {mode && (
        <TaskHistoryDialog
          key={roomId}
          roomId={roomId}
          pendingTaskIds={pendingTaskIds}
          initialMode={mode}
          onClose={() => setMode(undefined)}
        />
      )}
    </>
  );
}

function TaskHistoryDialog({
  roomId,
  pendingTaskIds,
  initialMode,
  onClose,
}: {
  roomId: string;
  pendingTaskIds: string[];
  initialMode: Mode;
  onClose: () => void;
}) {
  const { data, t, locale, connected } = useApp();
  const [mode, setMode] = useState(initialMode);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(50);
  const [detailId, setDetailId] = useState<string>();
  const { change, busy, error } = useTaskArchive();
  const pending = new Set(pendingTaskIds);
  const inRoom = data.tasks.filter((task) => task.roomId === roomId && isSettledTask(task));
  const archived = inRoom.filter(isArchivedTask);
  const review = inRoom.filter((task) => !isArchivedTask(task) && pending.has(task.id));
  const rows = [...(mode === 'archived' ? archived : review)].sort(
    (a, b) =>
      (b.archivedAt || b.createdAt).localeCompare(a.archivedAt || a.createdAt) ||
      a.id.localeCompare(b.id),
  );
  const eligible = (task: Task) => mode === 'archived' || canArchiveTask(task, data);
  const eligibleIds = rows.filter(eligible).map((task) => task.id);
  const selectionKey = JSON.stringify(eligibleIds);
  useEffect(() => {
    const available = new Set<string>(JSON.parse(selectionKey));
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => available.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [selectionKey]);
  const visible = rows.slice(0, limit);
  const visibleEligible = visible.filter(eligible);
  const selectedIds = eligibleIds.filter((id) => selected.has(id));
  const allVisibleSelected =
    visibleEligible.length > 0 && visibleEligible.every((task) => selected.has(task.id));
  const disabled = busy || connected === false;
  const switchMode = (next: Mode) => {
    setMode(next);
    setSelected(new Set());
    setLimit(50);
  };
  return (
    <Modal
      title={t('停止した作業とタスク履歴', 'Stopped tasks and history')}
      onClose={onClose}
      wide
    >
      <div className="task-history" data-task-history={roomId} data-history-mode={mode}>
        <p className="task-history-description">
          {t(
            '再開が不要な作業を履歴へ移すと、チャット下部とボットの現在の状況から片づきます。記録は保存され、いつでも一覧に戻せます。',
            'Move tasks that no longer need recovery to history to clear the chat footer and current bot activity. Records are kept and can be restored to the list.',
          )}
        </p>
        <p className="task-history-note">
          {t(
            'この操作では、関連する仕事や起床予約の状態は変わりません。仕事の再開・完了・中止は「内容を確認」から行えます。',
            'This changes task visibility only. Use task details to review, resume or end the associated work and its wake-ups.',
          )}
        </p>
        <div
          className="task-history-tabs"
          role="group"
          aria-label={t('表示する作業', 'Tasks to show')}
        >
          <Button
            variant="ghost"
            aria-pressed={mode === 'review'}
            disabled={busy}
            onClick={() => switchMode('review')}
          >
            {t(`整理する作業 (${review.length})`, `To review (${review.length})`)}
          </Button>
          <Button
            variant="ghost"
            aria-pressed={mode === 'archived'}
            disabled={busy}
            onClick={() => switchMode('archived')}
          >
            {t(`タスク履歴 (${archived.length})`, `History (${archived.length})`)}
          </Button>
        </div>
        {connected === false && (
          <p className="task-history-note" role="status">
            {t(
              '再接続中です。履歴の変更は接続が戻ってから行えます。',
              'Reconnecting. History can be changed when the connection returns.',
            )}
          </p>
        )}
        {rows.length > 0 ? (
          <>
            <div className="task-history-selection">
              <Button
                variant="ghost"
                data-task-select-visible={roomId}
                disabled={disabled || !visibleEligible.length}
                onClick={() => {
                  setSelected((previous) => {
                    const next = new Set(previous);
                    for (const task of visibleEligible) {
                      if (allVisibleSelected) next.delete(task.id);
                      else if (next.size < 200) next.add(task.id);
                    }
                    return next;
                  });
                }}
              >
                {allVisibleSelected
                  ? t('表示中の選択を解除', 'Clear visible selection')
                  : t('表示中をすべて選択', 'Select visible tasks')}
              </Button>
              {selectedIds.length > 0 && (
                <Button
                  variant="ghost"
                  data-task-history-clear=""
                  disabled={disabled}
                  onClick={() => setSelected(new Set())}
                >
                  {t('選択を解除', 'Clear selection')}
                </Button>
              )}
              <span>{t(`${selectedIds.length}件を選択`, `${selectedIds.length} selected`)}</span>
            </div>
            <ul className="task-history-list">
              {visible.map((task) => {
                const bot = data.bots.find((item) => item.id === task.botId);
                const work = getTaskWork(task, data);
                const canSelect = eligible(task);
                const checked = selected.has(task.id) && canSelect;
                return (
                  <li key={task.id} data-history-task-id={task.id}>
                    <label className="task-history-select">
                      <input
                        type="checkbox"
                        data-task-history-select={task.id}
                        checked={checked}
                        disabled={disabled || !canSelect || (!checked && selectedIds.length >= 200)}
                        aria-label={t(
                          `${bot?.name || task.botId}の作業を選択: ${task.prompt.slice(0, 80)}`,
                          `Select ${bot?.name || task.botId}'s task: ${task.prompt.slice(0, 80)}`,
                        )}
                        onChange={(event) => {
                          const next = new Set(selected);
                          if (event.currentTarget.checked) next.add(task.id);
                          else next.delete(task.id);
                          setSelected(next);
                        }}
                      />
                      <span className="task-history-row-content">
                        <span className="task-history-row-meta">
                          <strong>{bot?.name || task.botId}</strong>
                          <Status
                            status={task.status}
                            presentation={getTaskStatus(task, data, locale, connected)}
                          />
                          <time>{dateLabel(task.createdAt, locale, true)}</time>
                        </span>
                        {work && <strong className="task-history-work-name">{work.name}</strong>}
                        <span className="task-history-prompt">
                          {task.prompt || t('指示の記録がありません', 'No recorded instruction')}
                        </span>
                        {task.error && (
                          <span className="task-history-error-preview">{task.error}</span>
                        )}
                        {!canSelect && (
                          <span className="task-history-note">
                            {t(
                              '承認待ちの操作を先に確認してください。',
                              'Review the pending action first.',
                            )}
                          </span>
                        )}
                      </span>
                    </label>
                    <Button
                      variant="ghost"
                      icon={FileText}
                      data-task-details-action={task.id}
                      onClick={() => setDetailId(task.id)}
                    >
                      {t('内容を確認', 'View details')}
                    </Button>
                  </li>
                );
              })}
            </ul>
            {visible.length < rows.length && (
              <Button variant="ghost" onClick={() => setLimit((value) => value + 50)}>
                {t('さらに表示', 'Show more')}
              </Button>
            )}
          </>
        ) : (
          <p className="task-history-empty">
            {mode === 'archived'
              ? t('履歴へ移した作業はありません。', 'No archived tasks.')
              : t('整理する停止済みの作業はありません。', 'No stopped tasks to put away.')}
          </p>
        )}
        {selectedIds.length >= 200 && (
          <p className="task-history-note">
            {t('一度に200件まで整理できます。', 'You can organize up to 200 tasks at a time.')}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="task-history-actions">
          <Button onClick={onClose}>{t('閉じる', 'Close')}</Button>
          <Button
            variant="primary"
            icon={mode === 'archived' ? Undo2 : Archive}
            data-task-history-apply=""
            busy={busy}
            disabled={disabled || !selectedIds.length}
            onClick={async () => {
              if (await change(roomId, selectedIds, mode !== 'archived')) setSelected(new Set());
            }}
          >
            {mode === 'archived'
              ? t(
                  `選択した${selectedIds.length}件を一覧に戻す`,
                  `Restore ${selectedIds.length} selected`,
                )
              : t(
                  `選択した${selectedIds.length}件を履歴へ`,
                  `Archive ${selectedIds.length} selected`,
                )}
          </Button>
        </footer>
        {detailId && (
          <TaskDetailsDialog
            taskId={detailId}
            onClose={() => setDetailId(undefined)}
            onOpenRoom={onClose}
          />
        )}
      </div>
    </Modal>
  );
}
