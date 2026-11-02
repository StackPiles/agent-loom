export type MissedRunPolicy = 'run_once' | 'skip';

interface ScheduleBase {
  timeZone: string;
  missedRunPolicy: MissedRunPolicy;
}
export interface OnceSchedule extends ScheduleBase {
  type: 'once';
  /** Local wall-clock time in timeZone, with minute precision and no UTC offset. */
  dateTime: string;
}
export interface DailySchedule extends ScheduleBase {
  type: 'daily';
  time: string;
}
export interface WeeklySchedule extends ScheduleBase {
  type: 'weekly';
  time: string;
  /** Sunday is 0, Saturday is 6. Stored values are unique and sorted. */
  weekdays: number[];
}
export type AutomationSchedule = OnceSchedule | DailySchedule | WeeklySchedule;

/** Normal scheduler polling is not a missed wake-up. */
export const SCHEDULE_LATE_GRACE_MS = 60_000;

export type ScheduleValidationErrorCode =
  | 'invalid_schedule'
  | 'invalid_type'
  | 'invalid_date'
  | 'invalid_time'
  | 'invalid_time_zone'
  | 'invalid_weekdays'
  | 'invalid_missed_run_policy'
  | 'nonexistent_time'
  | 'invalid_instant';

export class ScheduleValidationError extends Error {
  constructor(
    public readonly code: ScheduleValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ScheduleValidationError';
  }
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_YEAR = 2000;
const MAX_YEAR = 9999;
const formatters = new Map<string, Intl.DateTimeFormat>();

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function invalid(code: ScheduleValidationErrorCode, message: string): never {
  throw new ScheduleValidationError(code, message);
}

function zoneFormatter(zone: unknown): Intl.DateTimeFormat {
  if (
    typeof zone !== 'string' ||
    zone.length > 100 ||
    !/^[A-Za-z_][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/.test(zone)
  )
    invalid('invalid_time_zone', 'Choose a valid IANA time zone, such as Asia/Tokyo, or UTC.');
  const cached = formatters.get(zone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    invalid('invalid_time_zone', 'Choose a time zone supported by this server or browser.');
  }
  // User-supplied zone aliases must not grow this cache without a bound.
  if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
  formatters.set(zone, formatter);
  return formatter;
}

function wallTime(instant: number, formatter: Intl.DateTimeFormat): WallTime {
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant))
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function wallEpoch(value: WallTime): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
}

function parseTime(value: unknown): { hour: number; minute: number } {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    invalid('invalid_time', 'Choose a time in HH:mm format, from 00:00 to 23:59.');
  return { hour: Number(value.slice(0, 2)), minute: Number(value.slice(3)) };
}

function parseDateTime(value: unknown): WallTime {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    invalid('invalid_date', 'Choose a local date and time in YYYY-MM-DDTHH:mm format.');
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < MIN_YEAR ||
    year > MAX_YEAR ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  )
    invalid('invalid_date', 'Choose an existing calendar date between the years 2000 and 9999.');
  return { year, month, day, ...parseTime(value.slice(11)), second: 0 };
}

/**
 * Resolve a wall-clock minute using the zone's actual offsets around that date.
 * Probes span both sides of offset transitions, including half-hour DST changes
 * and a skipped calendar date. A UTC round-trip rejects gaps. Sorting chooses
 * the first occurrence of a fold, so each local date wakes at most once.
 */
function firstInstant(value: WallTime, formatter: Intl.DateTimeFormat): number | undefined {
  const desired = wallEpoch(value);
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const probe = desired + hours * HOUR_MS;
    offsets.add(wallEpoch(wallTime(probe, formatter)) - probe);
  }
  let first: number | undefined;
  for (const offset of offsets) {
    const candidate = desired - offset;
    if (wallEpoch(wallTime(candidate, formatter)) === desired)
      if (first === undefined || candidate < first) first = candidate;
  }
  return first;
}

/** Validate only persisted schedule fields, without imposing a current-time cutoff. */
export function normalizeSchedule(value: unknown): AutomationSchedule {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('invalid_schedule', 'Provide a wake-up schedule.');
  const input = value as Record<string, unknown>;
  if (input.type !== 'once' && input.type !== 'daily' && input.type !== 'weekly')
    invalid('invalid_type', 'Choose a one-time, daily or weekly wake-up schedule.');
  const keys = new Set([
    'type',
    'timeZone',
    'missedRunPolicy',
    ...(input.type === 'once' ? ['dateTime'] : ['time']),
    ...(input.type === 'weekly' ? ['weekdays'] : []),
  ]);
  if (Object.keys(input).some((key) => !keys.has(key)))
    invalid('invalid_schedule', 'The schedule contains fields that do not belong to its type.');
  if (input.missedRunPolicy !== 'run_once' && input.missedRunPolicy !== 'skip')
    invalid('invalid_missed_run_policy', 'Choose whether to run once or skip a missed wake-up.');
  const formatter = zoneFormatter(input.timeZone);
  const base: ScheduleBase = {
    timeZone: formatter.resolvedOptions().timeZone,
    missedRunPolicy: input.missedRunPolicy,
  };
  if (input.type === 'once') {
    const local = parseDateTime(input.dateTime);
    if (firstInstant(local, formatter) === undefined)
      invalid(
        'nonexistent_time',
        'This local date and time does not exist in the selected time zone. Choose another time.',
      );
    return { type: 'once', dateTime: input.dateTime as string, ...base };
  }
  parseTime(input.time);
  if (input.type === 'daily') return { type: 'daily', time: input.time as string, ...base };
  if (
    !Array.isArray(input.weekdays) ||
    !input.weekdays.length ||
    input.weekdays.length > 7 ||
    input.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  )
    invalid('invalid_weekdays', 'Choose at least one weekday, using Sunday 0 through Saturday 6.');
  return {
    type: 'weekly',
    time: input.time as string,
    weekdays: [...new Set(input.weekdays as number[])].sort((a, b) => a - b),
    ...base,
  };
}

export function onceScheduleAt(schedule: OnceSchedule): string {
  const normalized = normalizeSchedule(schedule);
  if (normalized.type !== 'once') invalid('invalid_type', 'A one-time wake-up is required.');
  const instant = firstInstant(
    parseDateTime(normalized.dateTime),
    zoneFormatter(normalized.timeZone),
  );
  // normalizeSchedule has already rejected a missing wall-clock minute.
  return new Date(instant!).toISOString();
}

/** Find the next occurrence strictly after after; a fold's second occurrence is never used. */
export function nextScheduleAt(schedule: AutomationSchedule, after: number): string | undefined {
  if (typeof after !== 'number' || !Number.isFinite(new Date(after).getTime()))
    invalid('invalid_instant', 'Provide a valid reference timestamp.');
  const normalized = normalizeSchedule(schedule);
  if (normalized.type === 'once') {
    const occurrence = onceScheduleAt(normalized);
    return Date.parse(occurrence) > after ? occurrence : undefined;
  }
  const formatter = zoneFormatter(normalized.timeZone);
  const start = wallTime(after, formatter);
  if (start.year > MAX_YEAR) return undefined;
  const startDate =
    start.year < MIN_YEAR
      ? Date.UTC(MIN_YEAR, 0, 1)
      : Date.UTC(start.year, start.month - 1, start.day);
  const time = parseTime(normalized.time);
  // Daily/weekly recurrences need at most two weeks, even if a selected date
  // disappears during a zone change. This is bounded calendar-day work.
  for (let day = 0; day <= 14; day++) {
    const date = new Date(startDate + day * DAY_MS);
    if (date.getUTCFullYear() > MAX_YEAR) return undefined;
    if (normalized.type === 'weekly' && !normalized.weekdays.includes(date.getUTCDay())) continue;
    const instant = firstInstant(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        ...time,
        second: 0,
      },
      formatter,
    );
    if (instant !== undefined && instant > after) return new Date(instant).toISOString();
  }
  invalid('invalid_schedule', 'No valid wake-up occurrence was found within the next two weeks.');
}

export function defaultTimeZone(): string {
  try {
    return zoneFormatter(Intl.DateTimeFormat().resolvedOptions().timeZone).resolvedOptions()
      .timeZone;
  } catch {
    return 'UTC';
  }
}

export function scheduleDescription(schedule: AutomationSchedule, locale: 'ja' | 'en'): string {
  const value = normalizeSchedule(schedule);
  const zone = ` (${value.timeZone})`;
  if (value.type === 'once') {
    const [date, time] = value.dateTime.split('T');
    return locale === 'ja'
      ? `${date.replaceAll('-', '/')} ${time}に一度${zone}`
      : `Once on ${date} at ${time}${zone}`;
  }
  if (value.type === 'daily')
    return locale === 'ja' ? `毎日 ${value.time}${zone}` : `Every day at ${value.time}${zone}`;
  const labels =
    locale === 'ja'
      ? ['日', '月', '火', '水', '木', '金', '土']
      : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = value.weekdays.map((day) => labels[day]).join(locale === 'ja' ? '・' : ', ');
  return locale === 'ja'
    ? `毎週 ${days} ${value.time}${zone}`
    : `Every ${days} at ${value.time}${zone}`;
}

export function formatScheduleInstant(iso: string, timeZone: string, locale: 'ja' | 'en'): string {
  const instant = Date.parse(iso);
  if (!Number.isFinite(instant)) invalid('invalid_instant', 'Provide a valid scheduled instant.');
  const zone = zoneFormatter(timeZone).resolvedOptions().timeZone;
  const formatted = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    timeZone: zone,
    calendar: 'iso8601',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
  return `${formatted} (${zone})`;
}
