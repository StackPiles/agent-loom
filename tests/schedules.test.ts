import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultTimeZone,
  formatScheduleInstant,
  nextScheduleAt,
  normalizeSchedule,
  onceScheduleAt,
  scheduleDescription,
  ScheduleValidationError,
  SCHEDULE_LATE_GRACE_MS,
  type AutomationSchedule,
  type DailySchedule,
  type OnceSchedule,
  type ScheduleValidationErrorCode,
  type WeeklySchedule,
} from '../src/shared/schedules.js';

const once = (dateTime: string, timeZone = 'Asia/Tokyo'): OnceSchedule => ({
  type: 'once',
  dateTime,
  timeZone,
  missedRunPolicy: 'run_once',
});
const daily = (time: string, timeZone = 'Asia/Tokyo'): DailySchedule => ({
  type: 'daily',
  time,
  timeZone,
  missedRunPolicy: 'run_once',
});
const weekly = (time: string, weekdays: number[], timeZone = 'Asia/Tokyo'): WeeklySchedule => ({
  type: 'weekly',
  time,
  weekdays,
  timeZone,
  missedRunPolicy: 'skip',
});
function rejects(value: unknown, code: ScheduleValidationErrorCode) {
  assert.throws(
    () => normalizeSchedule(value),
    (error) => error instanceof ScheduleValidationError && error.code === code,
  );
}

test('wake-up schedule validation preserves exact calendar fields and canonicalizes only timezone and weekdays', () => {
  const input = weekly('09:05', [5, 1, 3, 1], 'Etc/UTC');
  const normalized = normalizeSchedule(input);
  assert.deepEqual(normalized, {
    type: 'weekly',
    time: '09:05',
    weekdays: [1, 3, 5],
    timeZone: 'UTC',
    missedRunPolicy: 'skip',
  });
  assert.deepEqual(
    input.weekdays,
    [5, 1, 3, 1],
    'normalizing does not mutate a form or saved rule',
  );
  assert.deepEqual(normalizeSchedule(once('2028-02-29T00:00')), once('2028-02-29T00:00'));
  assert.equal(SCHEDULE_LATE_GRACE_MS, 60_000);
});

test('wake-up validation rejects unknown or irrelevant fields, missing policy, invalid times and calendar dates', () => {
  rejects(null, 'invalid_schedule');
  rejects([], 'invalid_schedule');
  rejects({ ...daily('09:00'), type: 'monthly' }, 'invalid_type');
  rejects({ ...daily('09:00'), dateTime: '2026-11-02T09:00' }, 'invalid_schedule');
  rejects({ ...once('2026-11-02T09:00'), weekdays: [1] }, 'invalid_schedule');
  rejects({ ...daily('09:00'), timeZone: '+09:00' }, 'invalid_time_zone');
  rejects({ ...daily('09:00'), timeZone: 'Asia/Not_A_Zone' }, 'invalid_time_zone');
  rejects({ ...daily('09:00'), timeZone: '' }, 'invalid_time_zone');
  rejects({ ...daily('09:00'), missedRunPolicy: undefined }, 'invalid_missed_run_policy');
  rejects({ ...daily('09:00'), missedRunPolicy: 'replay_everything' }, 'invalid_missed_run_policy');
  for (const time of ['9:00', '24:00', '09:60', '09:00:00', '09:00Z', ' 09:00', ''])
    rejects(daily(time), 'invalid_time');
  for (const date of [
    '2026-02-29T09:00',
    '2026-04-31T09:00',
    '2026-00-01T09:00',
    '2026-13-01T09:00',
    '2026-01-00T09:00',
    '1999-12-31T09:00',
    '10000-01-01T09:00',
    '2026-11-02T09:00Z',
    '2026-11-02T09:00:00',
  ])
    rejects(once(date), 'invalid_date');
  rejects(once('2026-11-02T25:00'), 'invalid_time');
  for (const days of [[], [-1], [7], [1.5], ['1'], [true], Array(8).fill(1)])
    rejects({ ...weekly('09:00', [1]), weekdays: days }, 'invalid_weekdays');
});

test('one-time wakeups resolve explicit local time independently of the host timezone and support date-line offsets', () => {
  const hostZone = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = zone;
      assert.equal(onceScheduleAt(once('2026-11-03T09:00')), '2026-11-03T00:00:00.000Z');
      assert.equal(
        onceScheduleAt(once('2026-11-03T09:00', 'Asia/Kathmandu')),
        '2026-11-03T03:15:00.000Z',
      );
      assert.equal(
        onceScheduleAt(once('2026-01-01T00:05', 'Pacific/Kiritimati')),
        '2025-12-31T10:05:00.000Z',
      );
    }
  } finally {
    if (hostZone === undefined) delete process.env.TZ;
    else process.env.TZ = hostZone;
  }
});

test('one-time next occurrence is strictly after the reference, while normalization leaves past drafts readable', () => {
  const schedule = once('2026-11-03T09:00');
  const at = Date.parse('2026-11-03T00:00:00Z');
  assert.equal(nextScheduleAt(schedule, at - 1), '2026-11-03T00:00:00.000Z');
  assert.equal(nextScheduleAt(schedule, at), undefined);
  assert.equal(nextScheduleAt(schedule, at + 1), undefined);
  assert.equal(onceScheduleAt(once('2000-01-01T00:00', 'UTC')), '2000-01-01T00:00:00.000Z');
});

test('daily wakeups retain local clock time across day, month and year boundaries', () => {
  assert.equal(
    nextScheduleAt(daily('09:00'), Date.parse('2026-11-02T23:59:59.999Z')),
    '2026-11-03T00:00:00.000Z',
  );
  assert.equal(
    nextScheduleAt(daily('09:00'), Date.parse('2026-11-03T00:00:00Z')),
    '2026-11-04T00:00:00.000Z',
  );
  assert.equal(
    nextScheduleAt(daily('00:05'), Date.parse('2026-12-31T15:05:00Z')),
    '2027-01-01T15:05:00.000Z',
  );
  assert.equal(
    nextScheduleAt(daily('09:00', 'America/New_York'), Date.parse('2026-03-07T14:00:00Z')),
    '2026-03-08T13:00:00.000Z',
    'a fixed local wake-up advances by 23 hours at the spring transition',
  );
});

test('weekly wakeups use the selected timezone weekday and do not drift from the configured clock', () => {
  assert.equal(
    nextScheduleAt(weekly('09:00', [1, 2, 3, 4, 5]), Date.parse('2026-11-06T00:00:00Z')),
    '2026-11-09T00:00:00.000Z',
    'Friday at the exact wake-up advances to Monday',
  );
  assert.equal(
    nextScheduleAt(weekly('00:05', [1], 'Pacific/Kiritimati'), Date.parse('2026-11-01T09:00:00Z')),
    '2026-11-01T10:05:00.000Z',
    'the Monday wake-up can occur on Sunday in UTC',
  );
  assert.equal(
    nextScheduleAt(weekly('09:00', [0], 'America/New_York'), Date.parse('2026-03-01T14:00:00Z')),
    '2026-03-08T13:00:00.000Z',
  );
});

test('a DST gap rejects a one-time wake-up and recurring wakeups skip the nonexistent local minute', () => {
  rejects(once('2026-03-08T02:30', 'America/New_York'), 'nonexistent_time');
  assert.equal(
    nextScheduleAt(daily('02:30', 'America/New_York'), Date.parse('2026-03-07T07:30:00Z')),
    '2026-03-09T06:30:00.000Z',
  );
  assert.equal(
    nextScheduleAt(weekly('02:30', [0], 'America/New_York'), Date.parse('2026-03-01T07:30:00Z')),
    '2026-03-15T06:30:00.000Z',
    'a missing selected weekday occurrence advances to the following week',
  );
});

test('a repeated DST minute selects its first instant and cannot cause a second wake-up on that local date', () => {
  assert.equal(
    onceScheduleAt(once('2026-11-01T01:30', 'America/New_York')),
    '2026-11-01T05:30:00.000Z',
  );
  const schedule = daily('01:30', 'America/New_York');
  assert.equal(
    nextScheduleAt(schedule, Date.parse('2026-11-01T05:29:59Z')),
    '2026-11-01T05:30:00.000Z',
  );
  for (const after of ['2026-11-01T05:30:00Z', '2026-11-01T05:45:00Z', '2026-11-01T06:15:00Z'])
    assert.equal(nextScheduleAt(schedule, Date.parse(after)), '2026-11-02T06:30:00.000Z');
});

test('half-hour DST transitions are resolved without assuming one-hour gaps or folds', () => {
  assert.equal(
    onceScheduleAt(once('2026-04-05T01:45', 'Australia/Lord_Howe')),
    '2026-04-04T14:45:00.000Z',
  );
  assert.equal(
    nextScheduleAt(daily('01:45', 'Australia/Lord_Howe'), Date.parse('2026-04-04T14:45:00Z')),
    '2026-04-05T15:15:00.000Z',
  );
  rejects(once('2026-10-04T02:15', 'Australia/Lord_Howe'), 'nonexistent_time');
  assert.equal(
    nextScheduleAt(daily('02:15', 'Australia/Lord_Howe'), Date.parse('2026-10-02T15:45:00Z')),
    '2026-10-04T15:15:00.000Z',
  );
});

test('a skipped calendar date is handled for once, daily and weekly schedules', () => {
  rejects(once('2011-12-30T12:00', 'Pacific/Apia'), 'nonexistent_time');
  assert.equal(
    nextScheduleAt(daily('12:00', 'Pacific/Apia'), Date.parse('2011-12-29T22:00:00Z')),
    '2011-12-30T22:00:00.000Z',
  );
  assert.equal(
    nextScheduleAt(weekly('12:00', [5], 'Pacific/Apia'), Date.parse('2011-12-23T22:00:00Z')),
    '2012-01-05T22:00:00.000Z',
  );
});

test('invalid reference instants are rejected and recurrence stops at the supported calendar range', () => {
  for (const timestamp of [NaN, Infinity, -Infinity, 8.64e15 + 1])
    assert.throws(
      () => nextScheduleAt(daily('09:00'), timestamp),
      (error) => error instanceof ScheduleValidationError && error.code === 'invalid_instant',
    );
  assert.equal(
    nextScheduleAt(daily('23:59', 'UTC'), Date.parse('9999-12-31T23:58:59Z')),
    '9999-12-31T23:59:00.000Z',
  );
  assert.equal(
    nextScheduleAt(daily('23:59', 'UTC'), Date.parse('9999-12-31T23:59:00Z')),
    undefined,
  );
  assert.equal(nextScheduleAt(daily('09:00', 'UTC'), Date.UTC(10000, 0, 1)), undefined);
});

test('schedule summaries and next-wake formatting identify the selected timezone in both languages', () => {
  const cases: AutomationSchedule[] = [
    once('2026-11-03T09:00'),
    daily('09:00'),
    weekly('09:00', [1, 3, 5]),
  ];
  for (const schedule of cases)
    for (const locale of ['ja', 'en'] as const) {
      assert.match(scheduleDescription(schedule, locale), /Asia\/Tokyo/);
      assert.match(scheduleDescription(schedule, locale), /09:00/);
      assert.match(formatScheduleInstant('2026-11-03T00:00:00Z', 'Asia/Tokyo', locale), /09:00/);
    }
  assert.match(scheduleDescription(weekly('09:00', [1, 3, 5]), 'ja'), /月・水・金/);
  assert.match(scheduleDescription(daily('09:00'), 'en'), /Every day/);
  assert.throws(
    () => formatScheduleInstant('not a timestamp', 'Asia/Tokyo', 'ja'),
    (error) => error instanceof ScheduleValidationError && error.code === 'invalid_instant',
  );
  assert.doesNotThrow(() => normalizeSchedule(daily('09:00', defaultTimeZone())));
});
