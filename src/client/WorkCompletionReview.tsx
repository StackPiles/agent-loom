import { useState } from 'react';
import type { WorkCompletionDecision, WorkCompletionInput, WorkItem } from '../shared/work';
import { useApp } from './context';
import { Button, Field, Modal } from './components';

function localMinute(value: Date): string {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** The draft keeps the revision displayed when it opened; concurrent results never authorize it. */
export function WorkCompletionReview({
  work,
  disabled,
  busy,
  error,
  outdated,
  onClose,
  onReload,
  onSubmit,
}: {
  work: WorkItem;
  disabled: boolean;
  busy: boolean;
  error: string;
  outdated: boolean;
  onClose: () => void;
  onReload: () => void;
  onSubmit: (completion: WorkCompletionInput) => Promise<void>;
}) {
  const { data, t } = useApp();
  const review = work.completionReview!;
  // Earlier dismissals and deferrals are already committed. Editing a wait must
  // never copy them into another follow-up or require handling them a second time.
  const items =
    review.status === 'waiting' || review.status === 'review_queued'
      ? review.items.filter((item) => {
          const decision = review.decisions?.find((decision) => decision.itemId === item.id);
          return !decision || decision.action === 'wait';
        })
      : review.items;
  const [summary, setSummary] = useState(review.summary || '');
  const [decisions, setDecisions] = useState<Record<string, Partial<WorkCompletionDecision>>>(() =>
    Object.fromEntries((review.decisions || []).map((decision) => [decision.itemId, decision])),
  );
  const [waitUntil, setWaitUntil] = useState(() =>
    localMinute(
      review.waitUntil && Date.parse(review.waitUntil) > Date.now()
        ? new Date(review.waitUntil)
        : new Date(Date.now() + 30 * 60_000),
    ),
  );
  const [name, setName] = useState(
    t(`${work.name}の続き`, `Follow-up: ${work.name}`).slice(0, 160),
  );
  const [purpose, setPurpose] = useState('');
  const selected = items.map((item) => decisions[item.id]);
  const waiting = selected.some((decision) => decision?.action === 'wait');
  const deferring = selected.some((decision) => decision?.action === 'defer');
  const validDeadline = () => {
    const stamp = Date.parse(waitUntil);
    return Number.isFinite(stamp) && stamp > Date.now() && stamp <= Date.now() + 7 * 86_400_000;
  };
  const valid = Boolean(
    summary.trim() &&
    summary.length <= 4000 &&
    items.every((item) => {
      const decision = decisions[item.id];
      return decision?.action && decision.reason?.trim() && decision.reason.length <= 4000;
    }) &&
    (!waiting || validDeadline()) &&
    (!deferring || (name.trim() && name.length <= 160 && purpose.trim() && purpose.length <= 4000)),
  );
  const unavailable = disabled || busy || outdated;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const change = (itemId: string, value: Partial<WorkCompletionDecision>) =>
    setDecisions((previous) => ({
      ...previous,
      [itemId]: { ...previous[itemId], itemId, ...value },
    }));

  return (
    <Modal
      title={t('残っている作業を整理', 'Review remaining work')}
      description={t(
        '必要な結果は待ち、不要になった依頼は理由を残して取りやめ、今後の作業は後続の仕事に引き継げます。必要な成果が揃ったと判断できる場合に仕事を完了します。',
        'Wait for required results, dismiss work that is no longer needed with a reason, or save future work as a follow-up. Complete this assignment only when its required purpose is satisfied.',
      )}
      onClose={() => !busy && onClose()}
    >
      <form
        className="autonomous-work-completion-review"
        onSubmit={async (event) => {
          event.preventDefault();
          if (unavailable || !valid || (waiting && !validDeadline())) return;
          await onSubmit({
            summary: summary.trim(),
            decisions: items.map((item) => ({
              itemId: item.id,
              action: decisions[item.id].action!,
              reason: decisions[item.id].reason!.trim(),
            })),
            ...(waiting ? { waitUntil: new Date(waitUntil).toISOString() } : {}),
            ...(deferring ? { followUp: { name: name.trim(), purpose: purpose.trim() } } : {}),
          });
        }}
      >
        <div className="autonomous-work-completion-goal">
          <strong>{work.name}</strong>
          <p>{work.checkpoint.doneWhen}</p>
        </div>
        <Field label={t('これまでの成果と判断の根拠', 'Progress and evidence for this decision')}>
          <textarea
            rows={3}
            required
            maxLength={4000}
            value={summary}
            disabled={busy}
            onChange={(event) => setSummary(event.target.value)}
            placeholder={t(
              '確認できた成果と、残った作業をこのように扱ってよい理由を記録してください。',
              'Describe the verified progress and why the remaining work can be handled this way.',
            )}
          />
        </Field>
        <div className="autonomous-work-completion-items">
          {items.map((item, index) => {
            const task = item.taskId && data.tasks.find((task) => task.id === item.taskId);
            const bot = task && data.bots.find((bot) => bot.id === task.botId);
            return (
              <fieldset key={item.id} className="autonomous-work-completion-item">
                <legend>{t(`残りの作業 ${index + 1}`, `Remaining item ${index + 1}`)}</legend>
                <p className="autonomous-work-completion-item-label">{item.label}</p>
                <p className="field-hint">
                  {item.kind === 'task'
                    ? t('ボットへの依頼', 'Teammate task')
                    : item.kind === 'wakeup'
                      ? t('起床予約', 'Scheduled wake-up')
                      : t('確認事項', 'Pending check')}
                  {bot ? ` · @${bot.handle}` : ''}
                </p>
                <Field label={t(`作業 ${index + 1} の扱い`, `Decision for item ${index + 1}`)}>
                  <select
                    required
                    value={decisions[item.id]?.action || ''}
                    disabled={busy}
                    onChange={(event) =>
                      change(item.id, {
                        action: (event.target.value || undefined) as
                          WorkCompletionDecision['action'] | undefined,
                      })
                    }
                  >
                    <option value="">{t('扱いを選択', 'Choose a decision')}</option>
                    <option value="wait">
                      {t('必要な結果を待つ', 'Wait for the required result')}
                    </option>
                    <option value="dismiss">
                      {t('不要になったため取りやめる', 'Dismiss as no longer needed')}
                    </option>
                    <option value="defer">
                      {t('後続の仕事に引き継ぐ', 'Save as follow-up work')}
                    </option>
                  </select>
                </Field>
                <Field label={t(`作業 ${index + 1} の理由`, `Reason for item ${index + 1}`)}>
                  <textarea
                    rows={2}
                    required
                    maxLength={4000}
                    value={decisions[item.id]?.reason || ''}
                    disabled={busy}
                    onChange={(event) => change(item.id, { reason: event.target.value })}
                    placeholder={t(
                      '例：別の資料で必要な確認が済んだ／今回の目的に必要な回答を待つ。',
                      'e.g. Another source resolved this check, or this answer is still required.',
                    )}
                  />
                </Field>
              </fieldset>
            );
          })}
        </div>
        {waiting && (
          <Field
            label={t('遅くとも再判断する日時', 'Reassess no later than')}
            hint={t(
              `${zone}の日時です。結果が届けば先に確認し、届かなくてもこの日時に再判断します。期限だけで完了にはしません。7日以内で指定してください。`,
              `Times use ${zone}. Results can trigger an earlier review; this deadline triggers reassessment, not automatic success. Choose a time within seven days.`,
            )}
          >
            <input
              type="datetime-local"
              required
              value={waitUntil}
              min={localMinute(new Date())}
              max={localMinute(new Date(Date.now() + 7 * 86_400_000))}
              disabled={busy}
              onChange={(event) => setWaitUntil(event.target.value)}
            />
          </Field>
        )}
        {deferring && (
          <fieldset className="autonomous-work-completion-item">
            <legend>{t('保存する後続の仕事', 'Saved follow-up work')}</legend>
            <Field label={t('後続の仕事名', 'Follow-up name')}>
              <input
                required
                maxLength={160}
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label={t('後続の仕事の目的', 'Follow-up purpose')}>
              <textarea
                required
                rows={3}
                maxLength={4000}
                value={purpose}
                disabled={busy}
                onChange={(event) => setPurpose(event.target.value)}
              />
            </Field>
            <p className="field-hint">
              {t(
                '引き継ぐ内容を保存します。以前の操作をやり直したり、新しい仕事を自動で開始したりしません。',
                'The follow-up is saved for later. Previous operations are not repeated, and the new work does not start automatically.',
              )}
            </p>
          </fieldset>
        )}
        {outdated && (
          <div className="autonomous-work-notice" role="status">
            <p>
              {t(
                'この仕事に新しい結果や変更があります。入力内容を確認し、最新の内容で整理し直してください。',
                'New results or changes are available. Review your draft, then reload the current work before applying it.',
              )}
            </p>
            <Button type="button" disabled={busy} onClick={onReload}>
              {t('最新の内容で確認し直す', 'Review the latest work')}
            </Button>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="form-actions">
          <Button type="button" disabled={busy} onClick={onClose}>
            {t('閉じる', 'Close')}
          </Button>
          <Button type="submit" variant="primary" disabled={unavailable || !valid} busy={busy}>
            {t('整理内容を適用', 'Apply decisions')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
