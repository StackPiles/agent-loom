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
  if (!task.workId) return;
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
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
