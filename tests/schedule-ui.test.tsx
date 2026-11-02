import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Automation, Snapshot } from '../src/shared/types';
import { defaultTimeZone, onceScheduleAt } from '../src/shared/schedules';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3210',
  pretendToBeVisual: true,
});
for (const name of [
  'window',
  'document',
  'navigator',
  'localStorage',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLDialogElement',
  'Element',
  'SVGElement',
  'Event',
  'MouseEvent',
  'MutationObserver',
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: (dom.window as unknown as Record<string, unknown>)[name],
  });
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});
Object.defineProperty(dom.window, 'matchMedia', {
  value: (query: string) => ({
    matches: query.includes('reduced-motion'),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }),
});
dom.window.HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};
dom.window.HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open');
};
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('../src/client/context');
const { AutomationsPage } = await import('../src/client/AutomationsPage');

const stamp = '2026-11-01T00:00:00.000Z';
function fixture(): Snapshot {
  return {
    version: 'test',
    settings: {
      model: {
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'fixture',
        apiKeyConfigured: false,
        contextWindow: 32768,
        maxOutputTokens: 4096,
        temperature: 0.7,
      },
      demoMode: false,
      autoLearn: false,
      maxHandoffs: 6,
      workspacePath: 'C:\\Loom',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: [
      {
        id: 'bot_aster',
        name: 'Aster',
        handle: 'aster',
        role: 'Research',
        systemPrompt: 'Research carefully.',
        color: '#829479',
        avatar: 'character:aster',
        enabled: true,
        createdAt: stamp,
      },
    ],
    rooms: [
      {
        id: 'room_one',
        name: 'Research',
        description: '',
        botIds: ['bot_aster'],
        archived: false,
        pinned: false,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    messages: [],
    tasks: [],
    activities: [],
    approvals: [],
    skills: [],
    memories: [],
    automations: [],
    notifications: [],
    queue: { active: 0, waiting: 0 },
  };
}
let root: ReturnType<typeof createRoot> | undefined;
const mutations: { path: string; method?: string; body?: any }[] = [];
async function mount(data = fixture(), locale: 'en' | 'ja' = 'en') {
  if (root) await act(async () => root!.unmount());
  mutations.length = 0;
  const context: AppContextValue = {
    data,
    locale,
    t: (ja, en) => (locale === 'ja' ? ja : en),
    view: 'automations',
    roomId: 'room_one',
    navigate() {},
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string, method?: string, body?: any) {
      mutations.push({ path, method, body });
      return {} as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        <AutomationsPage />
      </AppContext.Provider>,
    ),
  );
}
function button(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) =>
      element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
  );
  assert.ok(result, 'Missing button: ' + label);
  return result;
}
function field<
  T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement = HTMLInputElement,
>(label: string): T {
  const container = [...document.querySelectorAll('label.field')].find(
    (element) => element.querySelector('.field-label')?.textContent === label,
  );
  const result = container?.querySelector('input, select, textarea');
  assert.ok(result, 'Missing field: ' + label);
  return result as T;
}
function toggle(label: string): HTMLInputElement {
  const result = [...document.querySelectorAll('label.toggle-row')]
    .find((element) => element.querySelector('strong')?.textContent === label)
    ?.querySelector<HTMLInputElement>('input');
  assert.ok(result, 'Missing toggle: ' + label);
  return result;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element.tagName === 'TEXTAREA'
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function scheduled(patch: Partial<Automation> = {}): Automation {
  return {
    id: 'wake_once',
    name: 'Review release',
    kind: 'schedule',
    enabled: true,
    roomId: 'room_one',
    botId: 'bot_aster',
    prompt: 'Review the release and report progress.',
    intervalMinutes: 60,
    sourceUrl: '',
    createdAt: stamp,
    schedule: {
      type: 'once',
      dateTime: '2099-01-02T09:30',
      timeZone: 'Asia/Tokyo',
      missedRunPolicy: 'run_once',
    },
    nextRunAt: '2099-01-02T00:30:00.000Z',
    ...patch,
  };
}
async function newWake(locale: 'ja' | 'en' = 'en') {
  await click(button(locale === 'ja' ? '自動化をつくる' : 'New automation'));
  await choose(field<HTMLSelectElement>(locale === 'ja' ? 'きっかけ' : 'Trigger'), 'schedule');
  await input(field(locale === 'ja' ? '名前' : 'Name'), 'Review release');
  await input(
    field<HTMLTextAreaElement>(locale === 'ja' ? '任せること' : 'Instructions'),
    'Review the release and report progress.',
  );
}

test('one-time wake-up starter uses the selected local date and explicit zone with an exact save payload', async () => {
  await mount();
  const starter = [...document.querySelectorAll<HTMLButtonElement>('.starter-grid button')].find(
    (item) => item.querySelector('h3')?.textContent === 'Scheduled wake-up',
  );
  assert.ok(starter);
  await click(starter);
  await input(field('Name'), 'Review release');
  await input(
    field<HTMLTextAreaElement>('Instructions'),
    'Review the release and report progress.',
  );
  assert.equal(field<HTMLSelectElement>('Time zone').value, defaultTimeZone());
  const suggested = field('Wake-up date and time').value;
  assert.ok(
    Date.parse(
      onceScheduleAt({
        type: 'once',
        dateTime: suggested,
        timeZone: defaultTimeZone(),
        missedRunPolicy: 'run_once',
      }),
    ) > Date.now(),
  );
  assert.equal(document.querySelector('input[type="number"]'), null);
  await choose(field<HTMLSelectElement>('Time zone'), 'Asia/Tokyo');
  await input(field('Wake-up date and time'), '2099-01-02T09:30');
  const preview = document.querySelector('.schedule-preview')!.textContent!;
  assert.match(preview, /2099/);
  assert.match(preview, /09:30/);
  assert.match(preview, /Asia\/Tokyo/);
  assert.equal(button('Save automation').disabled, false);
  await click(button('Save automation'));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].path, '/automations');
  assert.deepEqual(mutations[0].body.schedule, {
    type: 'once',
    dateTime: '2099-01-02T09:30',
    timeZone: 'Asia/Tokyo',
    missedRunPolicy: 'run_once',
  });
  assert.equal(mutations[0].body.kind, 'schedule');
  assert.equal(mutations[0].body.enabled, true);
  assert.equal(Object.hasOwn(mutations[0].body, 'scheduleStatus'), false);
  assert.equal(Object.hasOwn(mutations[0].body, 'imap'), false);
});

test('weekly wake-up validates weekday choices and retains its zone and policy through room changes', async () => {
  const data = fixture();
  data.bots.push({ ...data.bots[0], id: 'bot_nova', name: 'Nova', handle: 'nova' });
  data.rooms[0].botIds.push('bot_nova');
  data.rooms.push({ ...data.rooms[0], id: 'room_two', name: 'Design', botIds: ['bot_nova'] });
  await mount(data, 'ja');
  await newWake('ja');
  await choose(field<HTMLSelectElement>('繰り返し'), 'weekly');
  await choose(field<HTMLSelectElement>('タイムゾーン'), 'America/New_York');
  await input(field('起床する時刻'), '18:45');
  for (const name of ['月曜日', '火曜日', '水曜日', '木曜日', '金曜日']) await click(button(name));
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /1つ以上/);
  assert.equal(button('保存する').disabled, true);
  await click(button('水曜日'));
  await click(button('日曜日'));
  await choose(field<HTMLSelectElement>('予定より遅れた場合'), 'skip');
  await choose(field<HTMLSelectElement>('結果を届けるルーム'), 'room_two');
  assert.equal(field<HTMLSelectElement>('タイムゾーン').value, 'America/New_York');
  assert.equal(field('起床する時刻').value, '18:45');
  assert.equal(button('水曜日').getAttribute('aria-pressed'), 'true');
  assert.equal(button('日曜日').getAttribute('aria-pressed'), 'true');
  assert.equal(button('保存する').disabled, false);
  await click(button('保存する'));
  assert.deepEqual(mutations[0].body.schedule, {
    type: 'weekly',
    time: '18:45',
    weekdays: [0, 3],
    timeZone: 'America/New_York',
    missedRunPolicy: 'skip',
  });
  assert.equal(mutations[0].body.roomId, 'room_two');
  assert.equal(mutations[0].body.botId, 'bot_nova');
});

test('switching recurrence preserves drafts while saving only fields belonging to the selected mode', async () => {
  await mount();
  await newWake();
  await input(field('Wake-up date and time'), '2099-04-15T10:15');
  await choose(field<HTMLSelectElement>('Repeat'), 'daily');
  await input(field('Wake-up time'), '07:20');
  await choose(field<HTMLSelectElement>('Time zone'), 'UTC');
  await choose(field<HTMLSelectElement>('Repeat'), 'weekly');
  await click(button('All days'));
  assert.equal(document.querySelectorAll('.schedule-day-buttons [aria-pressed="true"]').length, 7);
  await click(button('Mon–Fri'));
  assert.equal(document.querySelectorAll('.schedule-day-buttons [aria-pressed="true"]').length, 5);
  await choose(field<HTMLSelectElement>('Repeat'), 'once');
  assert.equal(field('Wake-up date and time').value, '2099-04-15T10:15');
  await choose(field<HTMLSelectElement>('Repeat'), 'daily');
  assert.equal(field('Wake-up time').value, '07:20');
  await click(button('Save automation'));
  assert.deepEqual(mutations[0].body.schedule, {
    type: 'daily',
    time: '07:20',
    timeZone: 'UTC',
    missedRunPolicy: 'run_once',
  });

  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-11-01T06:10:00Z');
    const daily = scheduled({
      schedule: {
        type: 'daily',
        time: '09:00',
        timeZone: 'America/New_York',
        missedRunPolicy: 'run_once',
      },
    });
    await mount({ ...fixture(), automations: [daily] });
    await click(button('Edit'));
    await choose(field<HTMLSelectElement>('Repeat'), 'once');
    assert.equal(
      button('Save automation').disabled,
      false,
      'suggested one-shot remains future during a repeated clock hour',
    );
    assert.ok(
      Date.parse(
        onceScheduleAt({
          type: 'once',
          dateTime: field('Wake-up date and time').value,
          timeZone: 'America/New_York',
          missedRunPolicy: 'run_once',
        }),
      ) > Date.now(),
    );
  } finally {
    Date.now = originalNow;
  }
});

test('past one-time dates block enabling but allow a disabled draft; submit checks a date that expires while open', async () => {
  await mount();
  await newWake();
  await choose(field<HTMLSelectElement>('Time zone'), 'UTC');
  await input(field('Wake-up date and time'), '2001-01-01T09:00');
  assert.equal(button('Save automation').disabled, true);
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /future/);
  await click(toggle('Enable after saving'));
  assert.equal(button('Save automation').disabled, false);
  await click(button('Save automation'));
  assert.equal(mutations[0].body.enabled, false);
  assert.equal(mutations[0].body.schedule.dateTime, '2001-01-01T09:00');

  await mount();
  await newWake();
  await choose(field<HTMLSelectElement>('Time zone'), 'UTC');
  await input(field('Wake-up date and time'), '2099-01-02T09:30');
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse('2099-01-02T10:00:00Z');
    await click(button('Save automation'));
    assert.equal(mutations.length, 0);
    assert.equal(button('Save automation').disabled, true);
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /future/);
  } finally {
    Date.now = originalNow;
  }
});

test('a nonexistent daylight-saving local time is explained before saving', async () => {
  await mount(undefined, 'ja');
  await newWake('ja');
  await choose(field<HTMLSelectElement>('タイムゾーン'), 'America/New_York');
  await input(field('起床する日時'), '2027-03-14T02:30');
  assert.equal(button('保存する').disabled, true);
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /存在しません/);
  await input(field('起床する日時'), '2099-01-02T09:30');
  assert.equal(button('保存する').disabled, false);
});

test('dispatched one-time cards cannot rerun or resume, and a genuinely new future instant can be scheduled', async () => {
  const rule = scheduled({
    enabled: false,
    scheduleStatus: 'fired',
    nextRunAt: undefined,
    lastRunAt: '2026-11-02T01:00:00Z',
  });
  await mount({ ...fixture(), automations: [rule] });
  assert.equal(document.querySelector('.schedule-result')?.textContent, 'Dispatched');
  assert.equal(document.querySelector('button[aria-label="Run now"]'), null);
  assert.equal(document.querySelector('.automation-actions .toggle-row'), null);
  assert.match(document.querySelector('.automation-schedule-summary')!.textContent!, /Asia\/Tokyo/);
  await click(button('Edit'));
  await input(field('Name'), 'Renamed wake-up');
  assert.equal(button('Save automation').disabled, false);
  await click(toggle('Enable after saving'));
  assert.equal(button('Save automation').disabled, true);
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /finished/);
  await choose(field<HTMLSelectElement>('Time zone'), 'UTC');
  await input(field('Wake-up date and time'), '2099-01-02T00:30');
  assert.equal(
    button('Save automation').disabled,
    true,
    'same instant in another zone stays consumed',
  );
  await input(field('Wake-up date and time'), '2099-01-03T09:30');
  assert.equal(button('Save automation').disabled, false);
  await click(button('Save automation'));
  assert.equal(mutations[0].body.enabled, true);
  assert.equal(mutations[0].body.schedule.dateTime, '2099-01-03T09:30');
  assert.equal(Object.hasOwn(mutations[0].body, 'scheduleStatus'), false);
});

test('missed one-time cards preserve their expired date when saving a disabled metadata edit', async () => {
  const rule = scheduled({
    enabled: false,
    scheduleStatus: 'missed',
    nextRunAt: undefined,
    schedule: {
      type: 'once',
      dateTime: '2001-01-02T09:30',
      timeZone: 'Asia/Tokyo',
      missedRunPolicy: 'skip',
    },
  });
  await mount({ ...fixture(), automations: [rule] }, 'ja');
  assert.equal(document.querySelector('.schedule-result')?.textContent, '期限切れ');
  assert.equal(document.querySelector('button[aria-label="今すぐ実行"]'), null);
  await click(button('編集'));
  await input(field('名前'), '過去の予約');
  assert.equal(button('保存する').disabled, false);
  await click(button('保存する'));
  assert.equal(mutations[0].body.enabled, false);
  assert.equal(mutations[0].body.schedule.dateTime, '2001-01-02T09:30');
});

test('overdue pending reservations retain their original instant and allow recovery-policy or instruction edits', async () => {
  const rule = scheduled({
    nextRunAt: '2001-01-02T00:30:00.000Z',
    schedule: {
      type: 'once',
      dateTime: '2001-01-02T09:30',
      timeZone: 'Asia/Tokyo',
      missedRunPolicy: 'run_once',
    },
  });
  await mount({ ...fixture(), automations: [rule] });
  await click(button('Edit'));
  assert.match(document.querySelector('.schedule-preview')!.textContent!, /2001/);
  assert.match(document.querySelector('.schedule-preview')!.textContent!, /Overdue/);
  await input(field<HTMLTextAreaElement>('Instructions'), 'Report the current status.');
  await choose(field<HTMLSelectElement>('If a wake-up is missed'), 'skip');
  assert.equal(button('Save automation').disabled, false);
  await click(button('Save automation'));
  assert.equal(mutations[0].body.schedule.dateTime, '2001-01-02T09:30');
  assert.equal(mutations[0].body.schedule.missedRunPolicy, 'skip');
  assert.equal(mutations[0].body.enabled, true);

  await mount({ ...fixture(), automations: [{ ...rule, enabled: false, nextRunAt: undefined }] });
  await click(toggle('Off'));
  assert.equal(document.querySelector('.modal-header h2')?.textContent, 'Edit automation');
  assert.equal(mutations.length, 0, 'resuming an expired once rule opens its editor');
});

test('daily cards keep absolute next-date previews in their own zone and old interval editors stay unchanged', async () => {
  const daily = scheduled({
    schedule: { type: 'daily', time: '09:30', timeZone: 'Asia/Tokyo', missedRunPolicy: 'run_once' },
  });
  await mount({ ...fixture(), automations: [daily] });
  assert.match(document.querySelector('.automation-timing')!.textContent!, /2099/);
  assert.match(document.querySelector('.automation-timing')!.textContent!, /Asia\/Tokyo/);
  await click(button('Edit'));
  assert.equal(field<HTMLSelectElement>('Repeat').value, 'daily');
  assert.equal(field<HTMLSelectElement>('Time zone').value, 'Asia/Tokyo');
  assert.equal(field('Wake-up time').value, '09:30');
  await choose(field<HTMLSelectElement>('Trigger'), 'interval');
  await input(field('Interval (minutes)'), '45');
  await click(button('Save automation'));
  assert.equal(mutations[0].body.kind, 'interval');
  assert.equal(mutations[0].body.intervalMinutes, 45);
  assert.equal(Object.hasOwn(mutations[0].body, 'schedule'), false);

  const legacy = {
    ...scheduled(),
    kind: 'interval' as const,
    schedule: undefined,
    intervalMinutes: 30,
  };
  await mount({ ...fixture(), automations: [legacy] });
  await click(button('Edit'));
  assert.equal(field('Interval (minutes)').value, '30');
  assert.equal(document.querySelector('.schedule-fields'), null);
  await click(button('Save automation'));
  assert.equal(mutations[0].body.kind, 'interval');
  assert.equal(Object.hasOwn(mutations[0].body, 'schedule'), false);
});

after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});
