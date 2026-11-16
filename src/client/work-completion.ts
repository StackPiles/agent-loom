import type { WorkItem } from '../shared/work';

/** Completion review is ordinary progress, separate from uncertain-action review. */
export function workCompletionLabel(work: WorkItem, locale: 'ja' | 'en'): string | undefined {
  if (work.status !== 'active') return;
  const labels = {
    needs_review: ['完了前の整理待ち', 'Review remaining work'],
    waiting: ['必要な結果を待機中', 'Waiting for required results'],
    review_queued: ['完了を再確認中', 'Reassessing completion'],
    resolved: undefined,
  } as const;
  const label = work.completionReview && labels[work.completionReview.status];
  return label?.[locale === 'ja' ? 0 : 1];
}
