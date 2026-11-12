import { useRef, useState } from 'react';
import { Archive, Undo2 } from 'lucide-react';
import type { Snapshot, Task } from '../shared/types';
import { useApp } from './context';
import { Button } from './components';

export function isSettledTask(task: Task) {
  return ['completed', 'failed', 'stopped', 'interrupted'].includes(task.status);
}

/** An inconsistent old record must never hide a live task. */
export function isArchivedTask(task: Task) {
  return Boolean(task.archivedAt && isSettledTask(task));
}

export function canArchiveTask(task: Task, data: Pick<Snapshot, 'approvals'>) {
  return (
    isSettledTask(task) &&
    !data.approvals.some((item) => item.taskId === task.id && item.status === 'pending')
  );
}

export function useTaskArchive() {
  const { mutate, t } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const change = async (roomId: string, taskIds: string[], archived: boolean) => {
    if (lock.current || !taskIds.length) return false;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await mutate(
        '/tasks/archive',
        'POST',
        { roomId, taskIds, archived },
        archived
          ? t(
              `${taskIds.length}件をタスク履歴へ移しました`,
              `Moved ${taskIds.length} task${taskIds.length === 1 ? '' : 's'} to history`,
            )
          : t(
              `${taskIds.length}件を一覧に戻しました`,
              `Restored ${taskIds.length} task${taskIds.length === 1 ? '' : 's'} to the list`,
            ),
      );
      return true;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : t('保存できませんでした。', 'Could not save the change.'),
      );
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { change, busy, error };
}

export function TaskArchiveButton({ task, className }: { task: Task; className?: string }) {
  const { data, t, connected } = useApp();
  const { change, busy } = useTaskArchive();
  if (!isSettledTask(task)) return null;
  const archived = isArchivedTask(task);
  const eligible = archived || canArchiveTask(task, data);
  return (
    <Button
      type="button"
      variant="ghost"
      className={className}
      icon={archived ? Undo2 : Archive}
      busy={busy}
      disabled={connected === false || !eligible}
      data-task-archive-action={archived ? undefined : task.id}
      data-task-restore-action={archived ? task.id : undefined}
      aria-label={
        archived
          ? t('この作業を一覧に戻す', 'Restore this task to the list')
          : t('この作業を履歴へ移す', 'Move this task to history')
      }
      title={
        !eligible
          ? t(
              '承認待ちの操作を確認してから整理してください。',
              'Review the pending action before archiving this task.',
            )
          : archived
            ? t(
                '実行状態を変えずに、一覧へ戻します。',
                'Restore visibility without restarting this task.',
              )
            : t(
                '再開が不要な作業を、記録を残して片づけます。',
                'Keep the record and put away a task that no longer needs recovery.',
              )
      }
      onClick={() => void change(task.roomId, [task.id], !archived)}
    >
      {archived ? t('一覧に戻す', 'Restore') : t('履歴へ', 'Archive')}
    </Button>
  );
}
