import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import type { Automation, Snapshot, Task } from '../src/shared/types.js';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-wake-api-'));
  const context = await createApp({
    dataDir,
    scheduler: false,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  t.after(async () => {
    await context.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    context.app.inject({ method, url, payload: payload as object, headers: { host: 'localhost' } });
  const enableDemo = () =>
    context.store.put('settings', { ...context.store.settings(), id: 'main', demoMode: true });
  return { ...context, call, enableDemo };
}

const oneTime = {
  name: '日本時間の予約',
  kind: 'schedule',
  roomId: 'room_lounge',
  botId: 'bot_aster',
  prompt: 'Review the pending work and report the next step.',
  schedule: {
    type: 'once',
    dateTime: '2100-01-02T09:30',
    timeZone: 'Asia/Tokyo',
    missedRunPolicy: 'run_once',
  },
};

test('scheduled wake-up routes persist the explicit timezone and protect runtime-owned status', async (t) => {
  const f = await fixture(t);
  const response = await f.call('POST', '/api/automations', {
    ...oneTime,
    scheduleStatus: 'fired',
    nextRunAt: '2000-01-01T00:00:00.000Z',
  });
  assert.equal(response.statusCode, 200, response.body);
  const rule = response.json<Automation>();
  assert.equal(rule.kind, 'schedule');
  assert.deepEqual(rule.schedule, oneTime.schedule);
  assert.equal(rule.nextRunAt, '2100-01-02T00:30:00.000Z');
  assert.equal(rule.enabled, true);
  assert.equal(rule.scheduleStatus, undefined);
  const state = (await f.call('GET', '/api/state')).json<Snapshot>();
  assert.deepEqual(
    state.automations.find((item) => item.id === rule.id),
    rule,
  );
});

test('partial calendar-rule edits preserve an overdue occurrence and existing interval rules still work', async (t) => {
  const f = await fixture(t);
  const created = await f.call('POST', '/api/automations', {
    ...oneTime,
    schedule: {
      type: 'weekly',
      time: '09:30',
      timeZone: 'Asia/Tokyo',
      weekdays: [5, 1, 3],
      missedRunPolicy: 'run_once',
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  const rule = created.json<Automation>();
  assert.equal(rule.schedule?.type, 'weekly');
  assert.deepEqual(rule.schedule?.type === 'weekly' && rule.schedule.weekdays, [1, 3, 5]);
  assert.equal(new Date(rule.nextRunAt!).getUTCHours(), 0);
  assert.equal(new Date(rule.nextRunAt!).getUTCMinutes(), 30);
  const overdue = '2000-01-03T00:30:00.000Z';
  f.store.patch<Automation>('automations', rule.id, { nextRunAt: overdue });
  const edited = await f.call('PATCH', `/api/automations/${rule.id}`, { name: 'Renamed wake-up' });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json<Automation>().nextRunAt, overdue);
  assert.deepEqual(edited.json<Automation>().schedule, rule.schedule);
  const interval = await f.call('POST', '/api/automations', {
    name: 'Existing interval workflow',
    kind: 'interval',
    roomId: oneTime.roomId,
    botId: oneTime.botId,
    prompt: oneTime.prompt,
    intervalMinutes: 30,
  });
  assert.equal(interval.statusCode, 200, interval.body);
  assert.equal(interval.json<Automation>().intervalMinutes, 30);
  assert.equal(interval.json<Automation>().schedule, undefined);
});

test('schedule routes reject invalid local dates, zones, incomplete repeats and unsupported fields before saving', async (t) => {
  const f = await fixture(t);
  const invalid = [
    undefined,
    { ...oneTime.schedule, dateTime: '2100-02-30T09:30' },
    { ...oneTime.schedule, timeZone: 'Not/A_Timezone' },
    { ...oneTime.schedule, dateTime: '2000-01-02T09:30' },
    {
      type: 'weekly',
      time: '09:30',
      weekdays: [],
      timeZone: 'Asia/Tokyo',
      missedRunPolicy: 'run_once',
    },
    { type: 'daily', time: '25:00', timeZone: 'Asia/Tokyo', missedRunPolicy: 'run_once' },
    {
      type: 'daily',
      time: '09:30',
      timeZone: 'Asia/Tokyo',
      missedRunPolicy: 'run_once',
      cron: '* * * * *',
    },
  ];
  for (const schedule of invalid) {
    const response = await f.call('POST', '/api/automations', { ...oneTime, schedule });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(f.store.list('automations').length, 0);
  assert.equal(f.store.list('tasks').length, 0);
});

test('run-now consumes a one-time reservation once and only a changed future date rearms it', async (t) => {
  const f = await fixture(t);
  f.enableDemo();
  const created = await f.call('POST', '/api/automations', oneTime);
  assert.equal(created.statusCode, 200, created.body);
  const rule = created.json<Automation>();
  const result = await f.call('POST', `/api/automations/${rule.id}/run`);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json<Automation>().scheduleStatus, 'fired');
  assert.equal(result.json<Automation>().enabled, false);
  assert.equal(result.json<Automation>().nextRunAt, undefined);
  assert.equal(f.store.list<Task>('tasks').length, 1);
  assert.equal((await f.call('POST', `/api/automations/${rule.id}/run`)).statusCode, 409);
  const resurrect = await f.call('PATCH', `/api/automations/${rule.id}`, { enabled: true });
  assert.ok([400, 409].includes(resurrect.statusCode), resurrect.body);
  assert.equal(f.store.list<Task>('tasks').length, 1);
  const renamed = await f.call('PATCH', `/api/automations/${rule.id}`, {
    name: 'Already dispatched',
  });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json<Automation>().scheduleStatus, 'fired');
  const rearmed = await f.call('PATCH', `/api/automations/${rule.id}`, {
    schedule: { ...oneTime.schedule, dateTime: '2100-01-03T09:30' },
    enabled: true,
  });
  assert.equal(rearmed.statusCode, 200, rearmed.body);
  assert.equal(rearmed.json<Automation>().scheduleStatus, undefined);
  assert.equal(rearmed.json<Automation>().nextRunAt, '2100-01-03T00:30:00.000Z');
  assert.equal(f.store.list<Task>('tasks').length, 1);
});

test('a failed wake-up admission retains its one-time reservation for an explicit retry', async (t) => {
  const f = await fixture(t);
  const created = await f.call('POST', '/api/automations', oneTime);
  assert.equal(created.statusCode, 200, created.body);
  const rule = created.json<Automation>();
  const failed = await f.call('POST', `/api/automations/${rule.id}/run`);
  assert.equal(failed.statusCode, 409, failed.body);
  const retained = f.store.get<Automation>('automations', rule.id)!;
  assert.equal(retained.enabled, true);
  assert.equal(retained.nextRunAt, rule.nextRunAt);
  assert.equal(retained.scheduleStatus, undefined);
  assert.equal(f.store.list('tasks').length, 0);
  f.enableDemo();
  const retry = await f.call('POST', `/api/automations/${rule.id}/run`);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json<Automation>().scheduleStatus, 'fired');
  assert.equal(retry.json<Automation>().lastError, undefined);
  assert.equal(f.store.list('tasks').length, 1);
});
