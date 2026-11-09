import { useRef, useState } from 'react';
import {
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronRight,
  Pause,
  Play,
  Settings2,
  Square,
  X,
} from 'lucide-react';
import type { Room } from '../shared/types';
import type { Wakeup, WorkCheckpoint, WorkItem } from '../shared/work';
import { formatScheduleInstant, scheduleDescription } from '../shared/schedules';
import { activeStatuses, dateLabel, useApp } from './context';
import { Button, Field, IconButton, Modal } from './components';
import { RoomDialog } from './RoomDialog';

function isSettled(work: WorkItem) {
  return work.status === 'completed' || work.status === 'cancelled';
}
function pendingWakeups(wakeups: Wakeup[], workId: string) {
  return wakeups
    .filter((wakeup) => wakeup.workId === workId && wakeup.status === 'scheduled')
    .sort(
      (a, b) => (a.nextRunAt || '').localeCompare(b.nextRunAt || '') || a.id.localeCompare(b.id),
    );
}
function wakeTime(wakeup: Wakeup, locale: 'ja' | 'en') {
  if (!wakeup.nextRunAt)
    return locale === 'ja' ? '次回時刻を確認してください' : 'Review the next time';
  try {
    return formatScheduleInstant(wakeup.nextRunAt, wakeup.schedule.timeZone, locale);
  } catch {
    return dateLabel(wakeup.nextRunAt, locale, true);
  }
}
function wakeSchedule(wakeup: Wakeup, locale: 'ja' | 'en') {
  try {
    return scheduleDescription(wakeup.schedule, locale);
  } catch {
    return '';
  }
}

export function AutonomousWorkSection({
  roomId,
  showSettings = true,
}: {
  roomId?: string;
  showSettings?: boolean;
}) {
  const { data, t } = useApp();
  const [history, setHistory] = useState(false);
  const [settingsRoom, setSettingsRoom] = useState<Room>();
  const works = (data.workItems || [])
    .filter((work) => !roomId || work.roomId === roomId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const settled = works.filter(isSettled);
  const current = works.filter((work) => !isSettled(work));
  const rooms = data.rooms.filter((room) => !room.archived && (!roomId || room.id === roomId));
  return (
    <section
      className="autonomous-work-section"
      aria-label={t('自律予約の仕事', 'Autonomous work')}
    >
      <header className="autonomous-work-heading">
        <div>
          <h2>{t('自律予約の仕事', 'Autonomous work')}</h2>
          <p>
            {t(
              '目的や進捗を引き継ぎ、次に動く時刻と担当をボットが決めます。',
              'Bots carry work forward and decide when they or a teammate should return to it.',
            )}
          </p>
        </div>
      </header>
      {showSettings && rooms.length > 0 && (
        <div
          className="autonomous-work-policy-list"
          aria-label={t('ルームの許可範囲', 'Room permissions')}
        >
          {rooms.map((room) => {
            const mode = room.autonomousWakeups?.mode || 'off';
            return (
              <button
                key={room.id}
                type="button"
                onClick={() => setSettingsRoom(room)}
                aria-label={t(
                  `${room.name}の自律予約を設定`,
                  `Configure autonomous work in ${room.name}`,
                )}
              >
                <Settings2 size={13} aria-hidden="true" />
                {room.name}
                <span>
                  {mode === 'room'
                    ? t('参加ボットへの予約を許可', 'Room teammates allowed')
                    : mode === 'self'
                      ? t('自分の予約を許可', 'Self only')
                      : t('無効', 'Off')}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {current.length ? (
        <div className="autonomous-work-list">
          {current.map((work) => (
            <WorkCard key={work.id} work={work} />
          ))}
        </div>
      ) : (
        <p className="autonomous-work-empty">
          {rooms.some(
            (room) => room.autonomousWakeups?.mode && room.autonomousWakeups.mode !== 'off',
          )
            ? t(
                '継続中の仕事はありません。ルームでボットに任せる仕事を伝えると、ここに目的と次回の起床が表示されます。',
                'No ongoing work. Give a bot an assignment in its room to see its purpose and next wake-up here.',
              )
            : t(
                'ルームの設定で自律予約を許可すると、その範囲でボットが仕事の続きを予約できます。',
                'Enable autonomous wake-ups in a room to let its bots schedule follow-up work within that scope.',
              )}
        </p>
      )}
      {settled.length > 0 && (
        <div className="autonomous-work-history">
          <Button
            variant="ghost"
            aria-expanded={history}
            onClick={() => setHistory((value) => !value)}
          >
            {history
              ? t('終了した仕事を隠す', 'Hide finished work')
              : t(
                  `終了した仕事を表示（${settled.length}件）`,
                  `Show finished work (${settled.length})`,
                )}
          </Button>
          {history && (
            <div className="autonomous-work-list">
              {settled.map((work) => (
                <WorkCard key={work.id} work={work} />
              ))}
            </div>
          )}
        </div>
      )}
      {settingsRoom && (
        <RoomDialog room={settingsRoom} onClose={() => setSettingsRoom(undefined)} />
      )}
    </section>
  );
}

function WorkCard({ work }: { work: WorkItem }) {
  const { data, t, locale, mutate, navigate, connected } = useApp();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const [review, setReview] = useState(false);
  const lock = useRef(false);
  const room = data.rooms.find((item) => item.id === work.roomId);
  const creator = data.bots.find((bot) => bot.id === work.createdByBotId);
  const wakeups = pendingWakeups(data.wakeups || [], work.id);
  const missed = (data.wakeups || []).filter(
    (wakeup) => wakeup.workId === work.id && wakeup.status === 'missed',
  );
  const active = data.tasks.filter(
    (task) => task.workId === work.id && activeStatuses.includes(task.status),
  );
  const label = {
    active: active.length
      ? t('実行中', 'Running')
      : wakeups.length
        ? t('起床待ち', 'Waiting for wake-up')
        : t('継続中', 'Ongoing'),
    paused: t('一時停止', 'Paused'),
    blocked: t('確認が必要', 'Needs review'),
    completed: t('完了', 'Completed'),
    cancelled: t('中止', 'Cancelled'),
  }[work.status];
  const disabled = Boolean(busy) || connected === false;
  async function perform(
    action: 'pause' | 'resume' | 'stop' | 'complete',
    wakeup?: Wakeup,
    checkpoint?: WorkCheckpoint,
  ) {
    if (lock.current) return false;
    lock.current = true;
    setBusy(wakeup?.id || action);
    setError('');
    try {
      await mutate(
        wakeup
          ? `/wakeups/${encodeURIComponent(wakeup.id)}/cancel`
          : `/work-items/${encodeURIComponent(work.id)}/${action}`,
        'POST',
        checkpoint ? { checkpoint } : undefined,
        wakeup
          ? t('起床予約を取り消しました', 'Wake-up cancelled')
          : {
              pause: t('仕事を一時停止しました', 'Work paused'),
              resume: t('仕事を再開しました', 'Work resumed'),
              complete: t('仕事を完了にしました', 'Work marked complete'),
              stop: t('仕事を中止しました', 'Work cancelled'),
            }[action],
      );
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t(
              '変更できませんでした。もう一度お試しください。',
              'Could not update this work. Please try again.',
            ),
      );
      return false;
    } finally {
      lock.current = false;
      setBusy(undefined);
    }
  }
  const checkpoint = work.checkpoint;
  return (
    <article className="autonomous-work-card" data-work-id={work.id}>
      <header>
        <div>
          <div className="autonomous-work-identity">
            <h3>{work.name}</h3>
            <span className="subtle-tag">
              {work.kind === 'standing'
                ? t('継続担当', 'Standing responsibility')
                : t('個別の仕事', 'Assignment')}
            </span>
          </div>
          <div className="autonomous-work-meta">
            <button type="button" onClick={() => navigate('chat', work.roomId)}>
              #{room?.name || t('ルーム', 'Room')}
            </button>
            <span>
              {t('作成：', 'Created by ')}
              {creator ? `@${creator.handle}` : t('削除されたボット', 'Removed bot')}
            </span>
            <span>
              {t('更新：', 'Updated ')}
              {dateLabel(work.updatedAt, locale, true)}
            </span>
          </div>
        </div>
        <span className={`autonomous-work-status autonomous-work-status-${work.status}`}>
          {label}
        </span>
      </header>
      <p className="autonomous-work-purpose">{work.purpose}</p>
      {(checkpoint.summary ||
        checkpoint.completed ||
        checkpoint.nextStep ||
        checkpoint.doneWhen) && (
        <dl className="autonomous-work-progress">
          {checkpoint.summary && (
            <>
              <dt>{t('現在の状況', 'Current state')}</dt>
              <dd>{checkpoint.summary}</dd>
            </>
          )}
          {checkpoint.completed && (
            <>
              <dt>{t('完了したこと', 'Done so far')}</dt>
              <dd>{checkpoint.completed}</dd>
            </>
          )}
          {checkpoint.nextStep && (
            <>
              <dt>{t('次に行うこと', 'Next step')}</dt>
              <dd>{checkpoint.nextStep}</dd>
            </>
          )}
          {checkpoint.doneWhen && (
            <>
              <dt>{t('終了条件', 'Done when')}</dt>
              <dd>{checkpoint.doneWhen}</dd>
            </>
          )}
        </dl>
      )}
      {checkpoint.references.length > 0 && (
        <details className="autonomous-work-detail">
          <summary>
            {t(
              `引き継ぐ資料（${checkpoint.references.length}件）`,
              `References (${checkpoint.references.length})`,
            )}
          </summary>
          <ul>
            {checkpoint.references.map((reference, index) => (
              <li key={index}>{reference}</li>
            ))}
          </ul>
        </details>
      )}
      {checkpoint.uncertainActions.length > 0 && (
        <div className="autonomous-work-notice">
          <strong>{t('結果の確認が必要な操作', 'Actions with an uncertain result')}</strong>
          <ul>
            {checkpoint.uncertainActions.map((action, index) => (
              <li key={index}>{action}</li>
            ))}
          </ul>
          <p>
            {t(
              'ルームで前回のタスクの結果を確認してください。失敗・中断したタスクの再開は、仕事の再開とは別に行います。',
              'Review the previous task’s results in the room. Failed or interrupted tasks must be resumed separately; resuming work does not retry them.',
            )}
          </p>
        </div>
      )}
      {work.lastError && <p className="autonomous-work-notice">{work.lastError}</p>}
      {work.status === 'paused' && (
        <p className="autonomous-work-notice">
          {t(
            '予約を保留しています。再開する前に直前の実行結果を確認してください。失敗・中断した処理は自動でやり直しません。',
            'Wake-ups are on hold. Review the latest results before resuming; failed or interrupted actions are not retried automatically.',
          )}
        </p>
      )}
      {work.status === 'blocked' && checkpoint.uncertainActions.length === 0 && (
        <p className="autonomous-work-notice">
          {t(
            'ルームで前回のタスクの結果を確認してください。仕事の再開だけでは、失敗・中断したタスクを再実行しません。',
            'Review the previous task’s results in the room. Resuming this work does not retry failed or interrupted tasks.',
          )}
        </p>
      )}
      {!isSettled(work) && room?.paused && (
        <p className="autonomous-work-notice">
          {t(
            'ルームが休止中のため、起床は保留されます。',
            'Wake-ups are held while this room is paused.',
          )}
        </p>
      )}
      {!isSettled(work) && (room?.autonomousWakeups?.mode || 'off') === 'off' && (
        <p className="autonomous-work-notice">
          {t(
            'このルームの自律予約は無効です。ルーム設定で許可し、続ける仕事を再開してください。',
            'Autonomous wake-ups are off in this room. Enable them in room settings, then resume the work you want to continue.',
          )}
        </p>
      )}
      {missed.length > 0 && (
        <div className="autonomous-work-notice">
          <strong>{t('実行されなかった予約', 'Wake-ups that did not run')}</strong>
          <ul>
            {missed.map((wakeup) => {
              const bot = data.bots.find((item) => item.id === wakeup.botId);
              return (
                <li key={wakeup.id}>
                  {bot ? `@${bot.handle} · ` : ''}
                  {wakeSchedule(wakeup, locale)}
                  {wakeup.lastError && <p>{wakeup.lastError}</p>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {wakeups.length > 0 && !isSettled(work) && (
        <div className="autonomous-work-wakeups" aria-label={t('次の起床', 'Upcoming wake-ups')}>
          {wakeups.map((wakeup) => {
            const bot = data.bots.find((item) => item.id === wakeup.botId);
            return (
              <div className="autonomous-work-wakeup" key={wakeup.id} data-wakeup-id={wakeup.id}>
                <div>
                  <p className="autonomous-work-wake-time">
                    <span>{wakeTime(wakeup, locale)}</span>
                    <span>
                      {bot ? `@${bot.handle}` : t('対象ボットを確認', 'Review target bot')}
                    </span>
                  </p>
                  <p>{wakeup.reason}</p>
                  <small>{wakeSchedule(wakeup, locale)}</small>
                  <details className="autonomous-work-detail">
                    <summary>{t('起床時の指示', 'Wake-up instructions')}</summary>
                    <p>{wakeup.prompt}</p>
                  </details>
                  {wakeup.lastError && <p className="form-error">{wakeup.lastError}</p>}
                </div>
                <IconButton
                  icon={X}
                  label={t(
                    `${bot?.name || 'ボット'}の起床予約を取り消す`,
                    `Cancel wake-up for ${bot?.name || 'bot'}`,
                  )}
                  disabled={disabled}
                  aria-busy={busy === wakeup.id}
                  onClick={() => void perform('stop', wakeup)}
                />
              </div>
            );
          })}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!isSettled(work) && (
        <footer className="autonomous-work-actions">
          {work.status === 'active' ? (
            <Button
              icon={Pause}
              disabled={disabled}
              busy={busy === 'pause'}
              onClick={() => void perform('pause')}
            >
              {t('仕事を一時停止', 'Pause work')}
            </Button>
          ) : (
            <Button
              icon={Play}
              disabled={
                disabled || room?.paused || (room?.autonomousWakeups?.mode || 'off') === 'off'
              }
              busy={busy === 'resume'}
              onClick={() => {
                if (checkpoint.uncertainActions.length) {
                  setError('');
                  setReview(true);
                } else void perform('resume');
              }}
            >
              {checkpoint.uncertainActions.length
                ? t('確認して再開', 'Review and resume')
                : t('仕事を再開', 'Resume work')}
            </Button>
          )}
          <Button
            variant="ghost"
            icon={Check}
            disabled={disabled}
            busy={busy === 'complete'}
            onClick={() => void perform('complete')}
          >
            {t('完了にする', 'Mark complete')}
          </Button>
          <Button
            variant="danger"
            icon={Square}
            disabled={disabled}
            busy={busy === 'stop'}
            onClick={() => void perform('stop')}
          >
            {t('仕事を中止', 'Cancel work')}
          </Button>
          <small>
            {t(
              '一時停止・中止は、この仕事の予約と実行待ち・実行中の作業にも適用されます。',
              'Pause and cancel also apply to this work’s wake-ups and queued or active tasks.',
            )}
          </small>
        </footer>
      )}
      <div className="autonomous-work-actions">
        <Button variant="ghost" icon={ArrowUpRight} onClick={() => navigate('chat', work.roomId)}>
          {t('ルームで結果を見る', 'View results in room')}
        </Button>
      </div>
      {review && (
        <WorkReview
          work={work}
          disabled={disabled || room?.paused || (room?.autonomousWakeups?.mode || 'off') === 'off'}
          busy={busy === 'resume'}
          error={error}
          onClose={() => setReview(false)}
          onSubmit={async (checkpoint) => {
            if (await perform('resume', undefined, checkpoint)) setReview(false);
          }}
        />
      )}
    </article>
  );
}

function WorkReview({
  work,
  disabled,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  work: WorkItem;
  disabled: boolean | undefined;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (checkpoint: WorkCheckpoint) => Promise<void>;
}) {
  const { t } = useApp();
  const [previous, setPrevious] = useState(work.checkpoint.summary);
  const [result, setResult] = useState('');
  const [nextStep, setNextStep] = useState(work.checkpoint.nextStep);
  const [confirmed, setConfirmed] = useState(false);
  const summary = [previous.trim(), `${t('確認結果：', 'Reviewed result: ')}${result.trim()}`]
    .filter(Boolean)
    .join('\n\n');
  const tooLong = summary.length > 4000;
  const valid = Boolean(result.trim() && nextStep.trim() && confirmed && !tooLong);
  return (
    <Modal
      title={t('結果を確認して仕事を再開', 'Review outcomes and resume work')}
      description={t(
        '操作の実際の結果を確認し、続けてよいと判断した内容を記録してください。',
        'Verify what the actions actually did, then record why this work can continue.',
      )}
      onClose={onClose}
    >
      <form
        className="autonomous-work-review"
        onSubmit={async (event) => {
          event.preventDefault();
          if (disabled || !valid) return;
          await onSubmit({
            ...work.checkpoint,
            summary,
            nextStep: nextStep.trim(),
            uncertainActions: [],
          });
        }}
      >
        <div className="autonomous-work-notice">
          <strong>{t('確認する操作', 'Actions to review')}</strong>
          <ul>
            {work.checkpoint.uncertainActions.map((action, index) => (
              <li key={index}>{action}</li>
            ))}
          </ul>
        </div>
        <details className="autonomous-work-detail" open={tooLong || undefined}>
          <summary>
            {t(
              'これまでの状況（確認結果を追記します）',
              'Previous state (your review is appended)',
            )}
          </summary>
          <Field label={t('これまでの状況', 'Previous state')}>
            <textarea
              rows={3}
              maxLength={4000}
              value={previous}
              disabled={busy}
              onChange={(event) => setPrevious(event.target.value)}
            />
          </Field>
          {work.checkpoint.completed && (
            <p>
              {t('完了したこと：', 'Done so far: ')}
              {work.checkpoint.completed}
            </p>
          )}
        </details>
        <Field label={t('確認した結果', 'Reviewed result')}>
          <textarea
            autoFocus
            rows={3}
            required
            maxLength={4000}
            value={result}
            disabled={busy}
            onChange={(event) => setResult(event.target.value)}
            placeholder={t(
              '例：下書きが保存済みと確認したため、再作成せず確認から続ける。',
              'e.g. Confirmed the draft was saved; continue by reviewing it without creating it again.',
            )}
          />
        </Field>
        <Field label={t('次に行うこと', 'Next step')}>
          <textarea
            rows={3}
            required
            maxLength={4000}
            value={nextStep}
            disabled={busy}
            onChange={(event) => setNextStep(event.target.value)}
          />
        </Field>
        {tooLong && (
          <p className="form-error" role="alert">
            {t(
              'これまでの状況と確認結果を合わせて4,000文字以内にしてください。上の「これまでの状況」で整理できます。',
              'Keep the previous state and review within 4,000 characters. You can shorten the previous state above.',
            )}
          </p>
        )}
        <label className="autonomous-work-review-confirm">
          <input
            type="checkbox"
            required
            checked={confirmed}
            disabled={busy}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>
            {t(
              '上記すべての操作結果を確認し、仕事を続けてよいと判断しました。',
              'I have verified all the outcomes above and confirmed this work can continue.',
            )}
          </span>
        </label>
        <p className="field-hint">
          {t(
            '確認待ちを解除し、今後の予約を有効にします。失敗・中断したタスクは、必要に応じてルームで個別に再開してください。',
            'This clears the unresolved outcomes and allows future wake-ups. Resume any failed or interrupted task separately in the room if needed.',
          )}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="form-actions">
          <Button type="button" onClick={onClose} disabled={busy}>
            {t('キャンセル', 'Cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={disabled || !valid} busy={busy}>
            {t('確認を記録して再開', 'Save review and resume')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

export function RoomWorkSummary({ roomId }: { roomId: string }) {
  const { data, t, locale } = useApp();
  const [open, setOpen] = useState(false);
  const work = (data.workItems || []).filter((item) => item.roomId === roomId && !isSettled(item));
  const workIds = new Set(work.map((item) => item.id));
  const next = (data.wakeups || [])
    .filter((item) => workIds.has(item.workId) && item.status === 'scheduled' && item.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];
  const room = data.rooms.find((item) => item.id === roomId);
  const held =
    next &&
    (room?.paused ||
      (room?.autonomousWakeups?.mode || 'off') === 'off' ||
      work.find((item) => item.id === next.workId)?.status !== 'active');
  if (!work.length) return null;
  return (
    <>
      <button
        type="button"
        className="room-work-summary"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <CalendarClock size={15} aria-hidden="true" />
        <span>
          {t(
            `継続中の仕事 ${work.length}件`,
            `${work.length} ongoing work item${work.length === 1 ? '' : 's'}`,
          )}
          {next && (
            <>
              {' '}
              · {held ? t('保留中の予約 ', 'Held wake-up ') : t('次回 ', 'Next ')}
              {wakeTime(next, locale)}
            </>
          )}
        </span>
        <small>{t('確認', 'View')}</small>
        <ChevronRight size={13} aria-hidden="true" />
      </button>
      {open && (
        <Modal
          title={t('このルームの継続業務', 'Ongoing work in this room')}
          onClose={() => setOpen(false)}
          wide
        >
          <div className="autonomous-work-modal">
            <AutonomousWorkSection roomId={roomId} showSettings={false} />
          </div>
        </Modal>
      )}
    </>
  );
}
