import { CalendarClock } from 'lucide-react';
import type { Automation } from '../shared/types';
import {
  defaultTimeZone,
  formatScheduleInstant,
  nextScheduleAt,
  normalizeSchedule,
  onceScheduleAt,
  type AutomationSchedule,
} from '../shared/schedules';
import { Field } from './components';
import { useApp, type Locale } from './context';

export interface ScheduleDraft {
  type: AutomationSchedule['type'];
  dateTime: string;
  time: string;
  weekdays: number[];
  timeZone: string;
  missedRunPolicy: AutomationSchedule['missedRunPolicy'];
}

function localDateTime(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const value = (name: string) => parts.find((part) => part.type === name)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`;
}

export function createScheduleDraft(schedule?: AutomationSchedule): ScheduleDraft {
  const timeZone = schedule?.timeZone || defaultTimeZone();
  const now = Date.now();
  const suggested = Math.ceil((now + 15 * 60_000) / 60_000) * 60_000;
  let suggestedDateTime = localDateTime(suggested, timeZone);
  // In a repeated clock hour, a future instant can format to a local minute
  // whose first occurrence is already past. Offer a future first occurrence.
  for (let step = 0; step < 192; step++) {
    suggestedDateTime = localDateTime(suggested + step * 15 * 60_000, timeZone);
    if (
      Date.parse(
        onceScheduleAt({
          type: 'once',
          dateTime: suggestedDateTime,
          timeZone,
          missedRunPolicy: 'run_once',
        }),
      ) > now
    )
      break;
  }
  return {
    type: schedule?.type || 'once',
    dateTime: schedule?.type === 'once' ? schedule.dateTime : suggestedDateTime,
    time: schedule && schedule.type !== 'once' ? schedule.time : '09:00',
    weekdays: schedule?.type === 'weekly' ? [...schedule.weekdays] : [1, 2, 3, 4, 5],
    timeZone,
    missedRunPolicy: schedule?.missedRunPolicy || 'run_once',
  };
}

function fromDraft(draft: ScheduleDraft): AutomationSchedule {
  const common = { timeZone: draft.timeZone, missedRunPolicy: draft.missedRunPolicy };
  return normalizeSchedule(
    draft.type === 'once'
      ? { type: draft.type, dateTime: draft.dateTime, ...common }
      : draft.type === 'daily'
        ? { type: draft.type, time: draft.time, ...common }
        : { type: draft.type, time: draft.time, weekdays: draft.weekdays, ...common },
  );
}

function sameTrigger(a: AutomationSchedule, b?: AutomationSchedule): boolean {
  if (!b) return false;
  try {
    const normalized = normalizeSchedule(b);
    if (a.type === 'once' && normalized.type === 'once')
      return onceScheduleAt(a) === onceScheduleAt(normalized);
    const { missedRunPolicy: _a, ...triggerA } = a;
    const { missedRunPolicy: _b, ...triggerB } = normalized;
    return JSON.stringify(triggerA) === JSON.stringify(triggerB);
  } catch {
    return false;
  }
}

export interface SchedulePreview {
  schedule?: AutomationSchedule;
  nextRunAt?: string;
  error?: string;
  past?: boolean;
  consumed?: boolean;
}

const validationLabels: Record<string, [string, string]> = {
  invalid_date: ['有効な日時を入力してください。', 'Enter a valid date and time.'],
  invalid_time: ['有効な時刻を入力してください。', 'Enter a valid time.'],
  invalid_time_zone: ['有効なタイムゾーンを選択してください。', 'Choose a valid time zone.'],
  invalid_weekdays: ['起床する曜日を1つ以上選択してください。', 'Choose at least one weekday.'],
  nonexistent_time: [
    '夏時間の切り替えなどにより、このタイムゾーンには指定の日時が存在しません。別の時刻を選んでください。',
    'This local time does not exist because of a time-zone clock change. Choose another time.',
  ],
};

export function previewSchedule(
  draft: ScheduleDraft,
  enabled: boolean,
  existing: Automation | undefined,
  now: number,
  locale: Locale,
): SchedulePreview {
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  try {
    const schedule = fromDraft(draft);
    const unchanged = existing?.kind === 'schedule' && sameTrigger(schedule, existing.schedule);
    const consumed = Boolean(unchanged && existing?.scheduleStatus);
    if (enabled && consumed)
      return {
        schedule,
        consumed,
        error: t(
          'この予約は終了しています。再び起床するには、新しい未来の日時を指定してください。',
          'This wake-up has finished. Choose a new future date and time to schedule another.',
        ),
      };
    if (schedule.type === 'once') {
      const at = onceScheduleAt(schedule);
      const past = Date.parse(at) <= now;
      if (enabled && past && !(unchanged && existing?.enabled))
        return {
          schedule,
          past,
          error: t('未来の日時を指定してください。', 'Choose a future date and time.'),
        };
      return { schedule, nextRunAt: consumed ? undefined : at, past, consumed };
    }
    const nextRunAt =
      enabled && unchanged && existing?.enabled && existing.nextRunAt
        ? existing.nextRunAt
        : nextScheduleAt(schedule, now);
    return { schedule, nextRunAt, past: Boolean(nextRunAt && Date.parse(nextRunAt) <= now) };
  } catch (error) {
    const code = (error as { code?: string })?.code || '';
    const [ja, en] = validationLabels[code] || [
      '起床日時・曜日・タイムゾーンを確認してください。',
      'Check the wake-up date, time, weekdays and time zone.',
    ];
    return { error: t(ja, en) };
  }
}

let supportedTimeZones: string[] = [];
try {
  supportedTimeZones = Intl.supportedValuesOf('timeZone');
} catch {
  supportedTimeZones = ['America/New_York', 'Europe/London', 'Australia/Sydney'];
}

export function ScheduleFields({
  value,
  onChange,
  preview,
  enabled,
}: {
  value: ScheduleDraft;
  onChange: (value: ScheduleDraft) => void;
  preview: SchedulePreview;
  enabled: boolean;
}) {
  const { t, locale } = useApp();
  const update = (patch: Partial<ScheduleDraft>) => onChange({ ...value, ...patch });
  const zones = [
    ...new Set([value.timeZone, defaultTimeZone(), 'Asia/Tokyo', 'UTC', ...supportedTimeZones]),
  ];
  const dayNames = [
    ['日', '日曜日', 'Sun', 'Sunday'],
    ['月', '月曜日', 'Mon', 'Monday'],
    ['火', '火曜日', 'Tue', 'Tuesday'],
    ['水', '水曜日', 'Wed', 'Wednesday'],
    ['木', '木曜日', 'Thu', 'Thursday'],
    ['金', '金曜日', 'Fri', 'Friday'],
    ['土', '土曜日', 'Sat', 'Saturday'],
  ];
  return (
    <section className="schedule-fields" aria-label={t('予約起床の設定', 'Wake-up schedule')}>
      <div className="form-grid">
        <Field label={t('繰り返し', 'Repeat')}>
          <select
            value={value.type}
            onChange={(event) => update({ type: event.target.value as ScheduleDraft['type'] })}
          >
            <option value="once">{t('一度だけ', 'Once')}</option>
            <option value="daily">{t('毎日', 'Every day')}</option>
            <option value="weekly">{t('曜日を選ぶ', 'Selected weekdays')}</option>
          </select>
        </Field>
        <Field label={t('タイムゾーン', 'Time zone')}>
          <select
            value={value.timeZone}
            onChange={(event) => update({ timeZone: event.target.value })}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone === 'Asia/Tokyo' ? t('日本標準時 · Asia/Tokyo', 'Japan · Asia/Tokyo') : zone}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {value.type === 'once' ? (
        <Field label={t('起床する日時', 'Wake-up date and time')}>
          <input
            type="datetime-local"
            required
            step={60}
            min="2000-01-01T00:00"
            max="9999-12-31T23:59"
            value={value.dateTime}
            onChange={(event) => update({ dateTime: event.target.value })}
          />
        </Field>
      ) : (
        <Field label={t('起床する時刻', 'Wake-up time')}>
          <input
            type="time"
            required
            step={60}
            value={value.time}
            onChange={(event) => update({ time: event.target.value })}
          />
        </Field>
      )}
      {value.type === 'weekly' && (
        <fieldset className="schedule-weekdays">
          <legend className="field-label">{t('起床する曜日', 'Weekdays')}</legend>
          <div className="schedule-day-buttons">
            {dayNames.map(([ja, jaFull, en, enFull], day) => (
              <button
                key={day}
                type="button"
                aria-label={t(jaFull, enFull)}
                aria-pressed={value.weekdays.includes(day)}
                onClick={() =>
                  update({
                    weekdays: value.weekdays.includes(day)
                      ? value.weekdays.filter((selected) => selected !== day)
                      : [...value.weekdays, day].sort(),
                  })
                }
              >
                {t(ja, en)}
              </button>
            ))}
          </div>
          <div className="schedule-day-presets">
            <button type="button" onClick={() => update({ weekdays: [1, 2, 3, 4, 5] })}>
              {t('平日', 'Mon–Fri')}
            </button>
            <button type="button" onClick={() => update({ weekdays: [0, 1, 2, 3, 4, 5, 6] })}>
              {t('すべての曜日', 'All days')}
            </button>
          </div>
        </fieldset>
      )}
      <Field
        label={t('予定より遅れた場合', 'If a wake-up is missed')}
        hint={t(
          'サーバー停止や前の作業により、予定時刻から1分以上遅れた場合の動作です。',
          'Applies when the server is off or prior work delays a wake-up by at least one minute.',
        )}
      >
        <select
          value={value.missedRunPolicy}
          onChange={(event) =>
            update({ missedRunPolicy: event.target.value as ScheduleDraft['missedRunPolicy'] })
          }
        >
          <option value="run_once">
            {t('再開できるときに1回実行する', 'Run once when available')}
          </option>
          <option value="skip">{t('過ぎた分をスキップする', 'Skip missed wake-ups')}</option>
        </select>
      </Field>
      {preview.error ? (
        <p className="form-error schedule-error" role="alert">
          {preview.error}
        </p>
      ) : (
        <div className="schedule-preview" role="status">
          <CalendarClock size={18} aria-hidden="true" />
          <div>
            <strong>
              {preview.consumed
                ? t('終了した予約', 'Finished wake-up')
                : enabled
                  ? t('次回の起床', 'Next wake-up')
                  : t('起床日時の確認', 'Schedule preview')}
            </strong>
            {preview.nextRunAt && (
              <span>{formatScheduleInstant(preview.nextRunAt, value.timeZone, locale)}</span>
            )}
            <small>
              {preview.consumed
                ? t(
                    '再予約する場合は新しい日時を指定してください。',
                    'Choose a new date and time to schedule another.',
                  )
                : !enabled
                  ? t('停止した状態で保存します。', 'Saved disabled.')
                  : preview.past
                    ? value.missedRunPolicy === 'run_once'
                      ? t(
                          '予定時刻を過ぎています。実行できるときに1回起床します。',
                          'Overdue. Runs once when available.',
                        )
                      : t(
                          '予定時刻を過ぎています。1分以上遅れた分はスキップします。',
                          'Overdue. Wake-ups delayed by at least one minute are skipped.',
                        )
                    : t(
                        'Loomサーバーの起動中に実行します。ブラウザを閉じても動きます。',
                        'Runs while the Loom server is on, even with the browser closed.',
                      )}
            </small>
          </div>
        </div>
      )}
      {value.type !== 'once' && (
        <p className="schedule-time-note">
          {t(
            '夏時間で存在しない時刻はその日をスキップし、重複する時刻は最初の1回だけ起床します。',
            'Clock changes: nonexistent local times are skipped; repeated times run only at the first occurrence.',
          )}
        </p>
      )}
    </section>
  );
}
