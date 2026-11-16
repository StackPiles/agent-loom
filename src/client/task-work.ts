import type { Snapshot, Task } from '../shared/types';

/** A persisted work ID alone must not direct recovery into another room. */
export function getTaskWork(task: Task, data: Pick<Snapshot, 'workItems'>) {
  return data.workItems?.find((work) => work.id === task.workId && work.roomId === task.roomId);
}

export function taskWorkResumeDetail(
  task: Task,
  data: Pick<Snapshot, 'workItems'>,
  locale: 'ja' | 'en',
): string | undefined {
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  switch (task.stopContext?.reason) {
    case 'work_deferred': {
      const followUp = data.workItems?.find(
        (work) =>
          work.roomId === task.roomId &&
          work.deferredFromWorkId === task.workId &&
          work.deferredItems?.some((item) => item.taskId === task.id),
      );
      return followUp
        ? t(
            `続きは「${followUp.name}」に保存されています。元のタスクは再開せず、後続の仕事と保存済みの結果を確認してください。`,
            `The remaining scope is saved in “${followUp.name}”. Review that follow-up and the saved results instead of resuming the original task.`,
          )
        : t(
            '続きは後続の仕事に保存されています。元のタスクは再開せず、関連する仕事で引き継ぎ先と保存済みの結果を確認してください。',
            'The remaining scope was saved as follow-up work. Review the associated work for that follow-up and saved results; the original task cannot resume.',
          );
    }
    case 'work_superseded':
      return t(
        '不要になった依頼として取りやめたため、このタスクは再開できません。関連する仕事で判断の理由を確認でき、過去の記録として残せます。',
        'This task was dismissed as no longer needed and cannot resume. Review the recorded decision in the associated work; the task can remain in history.',
      );
    case 'work_completed':
      return t(
        '関連する仕事の完了に伴い終了したため、このタスクは再開できません。完了結果を確認し、過去の記録として残せます。',
        'This task ended when its associated work completed and cannot resume. Review the completed results; the task can remain in history.',
      );
    case 'work_cancelled':
      return t(
        '関連する仕事の中止に伴い終了したため、このタスクは再開できません。中止の記録を確認できます。',
        'This task ended when its associated work was cancelled and cannot resume. You can review the cancellation record.',
      );
  }
  if (!task.workId) return;
  const work = getTaskWork(task, data);
  if (!work)
    return t(
      '関連する仕事の情報を確認できないため、この作業は再開できません。',
      'This task cannot resume because its associated work is unavailable.',
    );
  switch (work.status) {
    case 'blocked':
      return t(
        '関連する仕事が再開待ちです。仕事の内容と結果を確認し、先に仕事を再開してください。',
        'The associated work is on hold. Review its progress and results, then resume the work first.',
      );
    case 'paused':
      return t(
        '関連する仕事が一時停止中です。仕事の内容を確認し、先に仕事を再開してください。',
        'The associated work is paused. Review it and resume the work first.',
      );
    case 'completed':
      return t(
        '関連する仕事は完了済みのため、この作業は再開できません。過去の記録として残せます。',
        'The associated work is complete, so this task cannot resume. It can remain as a historical record.',
      );
    case 'cancelled':
      return t(
        '関連する仕事は中止済みのため、この作業は再開できません。過去の記録として残せます。',
        'The associated work was cancelled, so this task cannot resume. It can remain as a historical record.',
      );
  }
}
