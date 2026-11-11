import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Bot, Room, Snapshot, Task } from '../src/shared/types';
import type { Wakeup, WorkItem } from '../src/shared/work';
import { DEFAULT_AUTONOMOUS_WAKEUP_POLICY } from '../src/shared/work';

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
  'HTMLSelectElement',
  'HTMLDialogElement',
  'Element',
  'SVGElement',
  'Event',
  'MouseEvent',
  'MutationObserver',
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: (dom.window as unknown as Record<string, unknown>)[name],
  });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  fetch: async () =>
    new Response(JSON.stringify({ available: false, platform: 'linux', reason: 'headless' })),
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
const { RoomDialog } = await import('../src/client/RoomDialog');
const { AutonomousWorkSection, RoomWorkSummary } = await import('../src/client/AutonomousWork');
const { AutomationsPage } = await import('../src/client/AutomationsPage');

const now = '2026-11-09T09:00:00.000Z';
const next = '2026-11-10T00:30:00.000Z';
const bot = (id: string, name: string): Bot => ({
  id,
  name,
  handle: name.toLowerCase(),
  role: 'Research',
  systemPrompt: 'Research carefully.',
  avatar: 'sparkles',
  color: '#829479',
  enabled: true,
  createdAt: now,
});
const room: Room = {
  id: 'room_research',
  name: 'Research',
  description: 'Keep research current.',
  botIds: ['bot_aster', 'bot_nova'],
  archived: false,
  pinned: false,
  createdAt: now,
  updatedAt: now,
};
const work = (id = 'work_research'): WorkItem => ({
  id,
  roomId: room.id,
  name: 'Weekly source review',
  purpose: 'Keep the published facts up to date.',
  kind: 'standing',
  status: 'active',
  createdByBotId: 'bot_aster',
  sourceTaskId: 'task_source',
  scope: 'Keep research current.',
  workspacePath: '/tmp/research',
  revision: 1,
  checkpoint: {
    summary: 'Two sources checked.',
    completed: 'Confirmed the current release.',
    nextStep: 'Ask Nova to verify the remaining source.',
    references: ['research/notes.md'],
    doneWhen: 'The weekly report is checked.',
    uncertainActions: [],
  },
  createdAt: now,
  updatedAt: now,
});
const wakeup = (id = 'wake_nova'): Wakeup => ({
  id,
  workId: 'work_research',
  roomId: room.id,
  botId: 'bot_nova',
  createdByBotId: 'bot_aster',
  sourceTaskId: 'task_source',
  key: 'source-review',
  reason: 'The source becomes available tomorrow.',
  prompt: 'Verify the primary source and update the checkpoint.',
  schedule: {
    type: 'once',
    dateTime: '2026-11-10T09:30',
    timeZone: 'Asia/Tokyo',
    missedRunPolicy: 'run_once',
  },
  status: 'scheduled',
  nextRunAt: next,
  workRunId: 'run_research',
  revision: 1,
  createdAt: now,
  updatedAt: now,
});
const task = (): Task => ({
  id: 'task_active',
  roomId: room.id,
  botId: 'bot_aster',
  prompt: 'Continue review.',
  status: 'running',
  rootTaskId: 'task_active',
  depth: 0,
  kind: 'chat',
  output: '',
  createdAt: now,
  updatedAt: now,
  inputTokens: 0,
  outputTokens: 0,
  workId: 'work_research',
  workRunId: 'run_research',
});
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
      workspacePath: '/tmp/loom',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: [bot('bot_aster', 'Aster'), bot('bot_nova', 'Nova')],
    rooms: [{ ...room }, { ...room, id: 'room_other', name: 'Other' }],
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
function activeFixture(): Snapshot {
  const data = fixture();
  data.rooms[0].autonomousWakeups = { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room' };
  data.workItems = [work()];
  data.wakeups = [wakeup()];
  return data;
}
let root: ReturnType<typeof createRoot> | undefined;
const mutations: { path: string; method?: string; body?: any }[] = [];
const navigations: { view: string; roomId?: string }[] = [];
let respond: (() => Promise<void>) | undefined;
async function mount(
  render: (data: Snapshot) => React.ReactNode,
  data = fixture(),
  locale: 'ja' | 'en' = 'en',
  connected = true,
) {
  if (root) await act(async () => root!.unmount());
  mutations.length = 0;
  navigations.length = 0;
  respond = undefined;
  localStorage.clear();
  const context: AppContextValue = {
    data,
    locale,
    t: (ja, en) => (locale === 'ja' ? ja : en),
    view: 'automations',
    roomId: room.id,
    connected,
    navigate(view, roomId) {
      navigations.push({ view, roomId });
    },
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string, method?: string, body?: unknown) {
      mutations.push({ path, method, body });
      await respond?.();
      return { ...room, ...(body as object) } as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await act(async () =>
    root!.render(<AppContext.Provider value={context}>{render(data)}</AppContext.Provider>),
  );
}
function button(label: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) =>
      element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
  );
  assert.ok(found, `Missing button: ${label}`);
  return found;
}
function field<
  T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement = HTMLInputElement,
>(label: string): T {
  const wrapper = [...document.querySelectorAll('label.field')].find(
    (element) => element.querySelector('.field-label')?.textContent === label,
  );
  const found = wrapper?.querySelector<T>('input, select, textarea');
  assert.ok(found, `Missing field: ${label}`);
  return found;
}
async function input(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    const isSelect = element instanceof dom.window.HTMLSelectElement;
    const prototype = isSelect
      ? dom.window.HTMLSelectElement.prototype
      : element instanceof dom.window.HTMLTextAreaElement
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event(isSelect ? 'change' : 'input', { bubbles: true }));
  });
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function save() {
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  );
  return mutations.at(-1)!;
}

test('legacy and new rooms stay opted out until the owner explicitly changes the scope', async () => {
  await mount((data) => <RoomDialog room={data.rooms[0]} onClose={() => {}} />);
  assert.equal(field<HTMLSelectElement>('Who bots may schedule').value, 'off');
  await input(field('Room name'), 'Renamed research');
  const renamed = await save();
  assert.equal(renamed.method, 'PATCH');
  assert.equal('autonomousWakeups' in renamed.body, false);
  await mount(() => <RoomDialog onClose={() => {}} />);
  await input(field('Room name'), 'New research');
  const created = await save();
  assert.equal(created.method, 'POST');
  assert.deepEqual(created.body.autonomousWakeups, DEFAULT_AUTONOMOUS_WAKEUP_POLICY);
});

test('scope and room-wide bounds save together; revocation remains available during an active task', async () => {
  await mount((data) => <RoomDialog room={data.rooms[0]} onClose={() => {}} />);
  await input(field<HTMLSelectElement>('Who bots may schedule'), 'room');
  await click(document.querySelector('.autonomous-wake-limits > summary')!);
  const interval = field('Minimum interval (minutes)');
  assert.equal(interval.min, '1');
  assert.equal(interval.max, '1440');
  await input(interval, '0');
  assert.equal(interval.checkValidity(), false);
  await input(interval, '10');
  await input(field('Maximum pending wake-ups'), '8');
  await input(field('Maximum task starts per hour'), '4');
  assert.deepEqual((await save()).body.autonomousWakeups, {
    mode: 'room',
    minIntervalMinutes: 10,
    maxPendingWakeups: 8,
    maxRunsPerHour: 4,
  });
  const data = activeFixture();
  data.tasks = [task()];
  await mount((value) => <RoomDialog room={value.rooms[0]} onClose={() => {}} />, data);
  assert.equal(document.querySelector('fieldset')?.disabled, false);
  assert.equal(document.querySelector<HTMLInputElement>('.member-picker input')?.disabled, true);
  await input(field<HTMLSelectElement>('Who bots may schedule'), 'off');
  assert.match(
    document.querySelector('.autonomous-work-notice')?.textContent || '',
    /Saving pauses autonomous work/,
  );
  const revoked = await save();
  assert.equal(revoked.body.autonomousWakeups.mode, 'off');
  assert.equal('botIds' in revoked.body, false);
  assert.equal('workspacePath' in revoked.body, false);
});

test('work cards expose purpose, handoff progress, creator, pending target and explicit local time', async () => {
  const data = activeFixture();
  data.tasks = [task()];
  data.workItems!.push({ ...work('work_finished'), name: 'Finished report', status: 'completed' });
  await mount(() => <AutomationsPage />, data);
  const card = document.querySelector('[data-work-id="work_research"]')!;
  for (const content of [
    'Keep the published facts up to date.',
    'Two sources checked.',
    'Confirmed the current release.',
    'Ask Nova to verify the remaining source.',
    'The weekly report is checked.',
    'Created by @aster',
    '@nova',
    'Asia/Tokyo',
    '09:30',
    'Running',
  ])
    assert.ok(card.textContent?.includes(content), `Missing work detail: ${content}`);
  assert.equal(document.querySelector('[data-work-id="work_finished"]'), null);
  await click(button('Show finished work (1)'));
  const finished = document.querySelector('[data-work-id="work_finished"]')!;
  assert.ok(finished);
  assert.equal(finished.querySelector('.button-danger'), null);
  await click(button('View results in room', card));
  assert.deepEqual(navigations.at(-1), { view: 'chat', roomId: room.id });
  await click(button('Configure autonomous work in Research'));
  assert.equal(field<HTMLSelectElement>('Who bots may schedule').value, 'room');
});

test('pending checks remain ordinary progress while active work waits for its scheduled wake-up', async () => {
  const data = activeFixture();
  const checks = [
    'Check whether the service review has finished.',
    'Ask Nova whether the source ledger was corrected.',
    'Wait for the user to supply the remaining title.',
  ];
  data.workItems![0].checkpoint.pendingChecks = checks;
  for (const locale of ['ja', 'en'] as const) {
    await mount(() => <AutonomousWorkSection />, data, locale);
    const card = document.querySelector('[data-work-id="work_research"]')!;
    const pending = card.querySelector('.autonomous-work-pending-checks')!;
    assert.ok(pending);
    assert.equal(
      pending.previousElementSibling?.textContent,
      locale === 'ja' ? '次回以降に確認すること' : 'Pending checks',
    );
    assert.deepEqual(
      [...pending.querySelectorAll('li')].map((item) => item.textContent),
      checks,
    );
    assert.ok(pending.closest('.autonomous-work-progress'));
    assert.equal(
      card.querySelector('.autonomous-work-status')?.textContent,
      locale === 'ja' ? '起床待ち' : 'Waiting for wake-up',
    );
    assert.ok(card.querySelector('[data-wakeup-id="wake_nova"]'));
    assert.equal(card.querySelector('.autonomous-work-notice'), null);
    assert.equal(card.querySelector('[role="alert"]'), null);
    assert.equal(
      [...card.querySelectorAll('button')].some((item) =>
        /仕事を再開|確認して再開|Resume work|Review and resume/.test(item.textContent || ''),
      ),
      false,
    );
    assert.equal(button(locale === 'ja' ? '仕事を一時停止' : 'Pause work', card).disabled, false);
    assert.equal(mutations.length, 0);
  }
});

test('legacy checkpoints without pending checks keep their active display and distinguish blocked reasons', async () => {
  const data = activeFixture();
  assert.equal('pendingChecks' in data.workItems![0].checkpoint, false);
  await mount(() => <AutonomousWorkSection />, data);
  assert.equal(document.querySelector('.autonomous-work-pending-checks'), null);
  assert.equal(document.querySelector('.autonomous-work-notice'), null);
  assert.equal(
    document.querySelector('.autonomous-work-status')?.textContent,
    'Waiting for wake-up',
  );
  data.workItems![0].status = 'blocked';
  for (const locale of ['ja', 'en'] as const) {
    data.workItems![0].checkpoint.uncertainActions = [];
    await mount(() => <AutonomousWorkSection />, data, locale);
    assert.equal(
      document.querySelector('.autonomous-work-status')?.textContent,
      locale === 'ja' ? '再開待ち' : 'Awaiting resumption',
    );
    assert.equal(button(locale === 'ja' ? '仕事を再開' : 'Resume work').disabled, false);
    data.workItems![0].checkpoint.uncertainActions = [
      'A submitted draft may have been saved before the connection was lost.',
    ];
    await mount(() => <AutonomousWorkSection />, data, locale);
    assert.equal(
      document.querySelector('.autonomous-work-status')?.textContent,
      locale === 'ja' ? '操作結果の確認待ち' : 'Awaiting outcome review',
    );
    assert.equal(button(locale === 'ja' ? '確認して再開' : 'Review and resume').disabled, false);
    assert.equal(document.querySelector('.autonomous-work-pending-checks'), null);
    assert.equal('pendingChecks' in data.workItems![0].checkpoint, false);
  }
});

test('cancel work is one bounded action; duplicate clicks are locked and failures remain retryable', async () => {
  await mount(() => <AutonomousWorkSection />, activeFixture());
  let fail!: (reason: Error) => void;
  respond = () =>
    new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
  const cancel = button('Cancel work');
  await act(async () => {
    cancel.click();
    cancel.click();
  });
  assert.deepEqual(mutations, [
    { path: '/work-items/work_research/stop', method: 'POST', body: undefined },
  ]);
  assert.equal(cancel.disabled, true);
  assert.equal(button('Cancel wake-up for Nova').disabled, true);
  await act(async () => fail(new Error('The connection was interrupted.')));
  assert.match(
    document.querySelector('[role="alert"]')?.textContent || '',
    /connection was interrupted/,
  );
  assert.equal(button('Cancel work').disabled, false);
  respond = undefined;
  await click(button('Cancel work'));
  assert.equal(mutations.length, 2);
  assert.equal(document.querySelector('[role="alert"]'), null);
});

test('individual reservations, pauses and completion call distinct owner actions', async () => {
  await mount(() => <AutonomousWorkSection />, activeFixture());
  await click(button('Cancel wake-up for Nova'));
  await click(button('Pause work'));
  await click(button('Mark complete'));
  assert.deepEqual(
    mutations.map(({ path, method }) => ({ path, method })),
    [
      { path: '/wakeups/wake_nova/cancel', method: 'POST' },
      { path: '/work-items/work_research/pause', method: 'POST' },
      { path: '/work-items/work_research/complete', method: 'POST' },
    ],
  );
});

test('a missed one-time wake-up remains visible after it leaves the pending list', async () => {
  const data = activeFixture();
  data.wakeups![0] = {
    ...wakeup(),
    status: 'missed',
    nextRunAt: undefined,
    lastError: 'The reserved time was missed and the selected policy skipped it.',
  };
  await mount(() => <AutonomousWorkSection />, data);
  assert.match(document.body.textContent || '', /Wake-ups that did not run/);
  assert.match(document.body.textContent || '', /selected policy skipped it/);
  assert.match(document.body.textContent || '', /Asia\/Tokyo/);
  assert.equal(document.querySelector('[data-wakeup-id="wake_nova"]'), null);
  assert.equal(button('Cancel work').disabled, false);
});

test('paused work explains review; resuming is blocked when the room, policy or connection is off', async () => {
  const data = activeFixture();
  data.workItems![0].status = 'paused';
  await mount(() => <AutonomousWorkSection />, data);
  assert.match(
    document.body.textContent || '',
    /failed or interrupted actions are not retried automatically/,
  );
  await click(button('Resume work'));
  assert.equal(mutations.at(-1)?.path, '/work-items/work_research/resume');
  data.rooms[0].autonomousWakeups!.mode = 'off';
  await mount(() => <AutonomousWorkSection />, data);
  assert.equal(button('Resume work').disabled, true);
  assert.equal(button('Cancel work').disabled, false);
  data.rooms[0].autonomousWakeups!.mode = 'room';
  data.rooms[0].paused = true;
  await mount(() => <AutonomousWorkSection />, data);
  assert.equal(button('Resume work').disabled, true);
  data.rooms[0].paused = false;
  data.workItems![0].status = 'blocked';
  await mount(() => <AutonomousWorkSection />, data, 'en', false);
  assert.equal(button('Resume work').disabled, true);
  assert.equal(button('Cancel work').disabled, true);
  assert.match(
    document.querySelector('.autonomous-work-status')?.textContent || '',
    /Awaiting resumption/,
  );
});

test('uncertain action review preserves pending checks; failed saves keep the review draft', async () => {
  const data = activeFixture();
  data.workItems![0].status = 'blocked';
  data.workItems![0].checkpoint.uncertainActions = ['A draft may already have been saved.'];
  data.workItems![0].checkpoint.pendingChecks = ['Check the later service review decision.'];
  const original = structuredClone(data.workItems![0].checkpoint);
  await mount(() => <AutonomousWorkSection />, data);
  await click(button('Review and resume'));
  assert.equal(mutations.length, 0);
  const dialog = document.querySelector('dialog')!;
  assert.match(dialog.textContent || '', /A draft may already have been saved/);
  assert.doesNotMatch(dialog.textContent || '', /Check the later service review decision/);
  assert.match(dialog.textContent || '', /Verify whether the attempted actions took effect/);
  assert.equal(button('Save review and resume').disabled, true);
  await input(
    field<HTMLTextAreaElement>('Reviewed result'),
    'Verified the saved draft; do not recreate it.',
  );
  await input(field<HTMLTextAreaElement>('Next step'), 'Review the saved draft.');
  assert.equal(button('Save review and resume').disabled, true);
  await click(document.querySelector<HTMLInputElement>('.autonomous-work-review-confirm input')!);
  let fail!: (reason: Error) => void;
  respond = () =>
    new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
  const submit = button('Save review and resume');
  await act(async () => {
    submit.click();
    submit.click();
  });
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0], {
    path: '/work-items/work_research/resume',
    method: 'POST',
    body: {
      checkpoint: {
        ...original,
        summary: `${original.summary}\n\nReviewed result: Verified the saved draft; do not recreate it.`,
        nextStep: 'Review the saved draft.',
        uncertainActions: [],
      },
    },
  });
  assert.deepEqual(mutations[0].body.checkpoint.pendingChecks, original.pendingChecks);
  assert.equal(submit.disabled, true);
  assert.equal(field<HTMLTextAreaElement>('Reviewed result').disabled, true);
  await act(async () => fail(new Error('Review could not be saved.')));
  assert.match(
    dialog.querySelector('[role="alert"]')?.textContent || '',
    /Review could not be saved/,
  );
  assert.equal(
    field<HTMLTextAreaElement>('Reviewed result').value,
    'Verified the saved draft; do not recreate it.',
  );
  assert.equal(button('Save review and resume').disabled, false);
  assert.deepEqual(
    data.workItems![0].checkpoint,
    original,
    'An unsaved review never changes the snapshot',
  );
  respond = undefined;
  await click(button('Save review and resume'));
  assert.equal(mutations.length, 2);
  assert.equal(document.querySelector('dialog'), null);
});

test('long review history is not silently truncated and nested review dismissal keeps the room dialog open', async () => {
  const data = activeFixture();
  data.workItems![0].status = 'blocked';
  data.workItems![0].checkpoint.summary = 'Existing notes. '.repeat(266);
  data.workItems![0].checkpoint.uncertainActions = ['Verify the saved draft.'];
  await mount(() => <RoomWorkSummary roomId={room.id} />, data);
  await click(document.querySelector('.room-work-summary')!);
  const reviewButton = button('Review and resume');
  reviewButton.focus();
  await click(reviewButton);
  await input(
    field<HTMLTextAreaElement>('Reviewed result'),
    'Verified the draft; continue from the saved version.',
  );
  await click(document.querySelector<HTMLInputElement>('.autonomous-work-review-confirm input')!);
  assert.equal(button('Save review and resume').disabled, true);
  assert.match(document.querySelector('dialog dialog [role="alert"]')?.textContent || '', /4,000/);
  assert.equal(
    field<HTMLTextAreaElement>('Previous state').value,
    data.workItems![0].checkpoint.summary,
  );
  await input(
    field<HTMLTextAreaElement>('Previous state'),
    'The earlier notes confirm the current release.',
  );
  assert.equal(button('Save review and resume').disabled, false);
  await act(async () =>
    document
      .querySelector('dialog dialog')!
      .dispatchEvent(new dom.window.Event('cancel', { cancelable: true, bubbles: true })),
  );
  assert.equal(document.querySelectorAll('dialog').length, 1);
  assert.equal(document.activeElement, reviewButton);
  assert.equal(mutations.length, 0);
});

test('the room summary is scoped, identifies held reservations, and restores keyboard focus when dismissed', async () => {
  const data = activeFixture();
  data.workItems![0].status = 'paused';
  data.workItems!.push({
    ...work('work_other'),
    roomId: 'room_other',
    name: 'Unrelated assignment',
  });
  await mount(() => <RoomWorkSummary roomId={room.id} />, data);
  const summary = document.querySelector<HTMLButtonElement>('.room-work-summary')!;
  assert.match(summary.textContent || '', /1 ongoing work item/);
  assert.match(summary.textContent || '', /Held wake-up/);
  summary.focus();
  await click(summary);
  assert.equal(summary.getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelectorAll('[data-work-id]').length, 1);
  assert.equal(document.querySelector('[data-work-id="work_other"]'), null);
  await act(async () =>
    document
      .querySelector('dialog')!
      .dispatchEvent(new dom.window.Event('cancel', { cancelable: true })),
  );
  assert.equal(document.querySelector('dialog'), null);
  assert.equal(document.activeElement, summary);
  assert.equal(summary.getAttribute('aria-expanded'), 'false');
});

test('Japanese labels and older snapshots remain usable without work collections', async () => {
  await mount(() => <AutonomousWorkSection />, fixture(), 'ja');
  assert.match(document.body.textContent || '', /ルームの設定で自律予約を許可/);
  await click(button('Researchの自律予約を設定'));
  assert.equal(field<HTMLSelectElement>('予約を任せる範囲').value, 'off');
  await input(field<HTMLSelectElement>('予約を任せる範囲'), 'self');
  assert.match(document.body.textContent || '', /このルームの目的や任せた役割/);
  assert.equal((await save()).body.autonomousWakeups.mode, 'self');
  await mount(() => <RoomWorkSummary roomId={room.id} />);
  assert.equal(document.querySelector('.room-work-summary'), null);
});

after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});
