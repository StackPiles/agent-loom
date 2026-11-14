import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ReactNode } from 'react';
import type { AppContextValue } from '../src/client/context';
import type { Snapshot, Task } from '../src/shared/types';
import type { WorkItem } from '../src/shared/work';
import { DEFAULT_AUTONOMOUS_WAKEUP_POLICY } from '../src/shared/work';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3210',
  pretendToBeVisual: true,
});
for (const name of [
  'window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLDialogElement', 'Element', 'SVGElement',
  'Event', 'MouseEvent', 'MutationObserver',
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
});
Object.defineProperty(dom.window, 'matchMedia', {
  value: (query: string) => ({
    matches: query.includes('reduced-motion'), media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }),
});
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('../src/client/context');
const { AutomationsPage } = await import('../src/client/AutomationsPage');
const { RoomWorkSummary } = await import('../src/client/AutonomousWork');
const { needsWorkAttention } = await import('../src/client/WorkSummary');

const now = '2026-11-14T00:00:00.000Z';
function work(id = 'work_one', status: WorkItem['status'] = 'active'): WorkItem {
  return {
    id, status, roomId: 'room_one', name: `Work ${id}`, purpose: 'Continue source review.',
    kind: 'task', createdByBotId: 'bot_creator', sourceTaskId: 'task_source', scope: 'Research',
    workspacePath: '/tmp/work', revision: 1, createdAt: now, updatedAt: now,
    checkpoint: {
      summary: 'Reviewed the first source.', completed: 'Read one document.',
      nextStep: 'Read the second source.', references: ['notes.md'], doneWhen: 'Sources reviewed.',
      pendingChecks: ['Wait for the other bot.'], uncertainActions: [],
    },
  };
}
function task(workId: string, status: Task['status']): Task {
  return {
    id: `task_${workId}_${status}`, workId, status, botId: 'bot_next', roomId: 'room_one',
    prompt: 'Review source.', rootTaskId: 'task_source', depth: 0, kind: 'chat', output: '',
    createdAt: now, updatedAt: now, inputTokens: 0, outputTokens: 0,
  };
}
function fixture(): Snapshot {
  return {
    version: 'test',
    settings: {
      model: {
        baseUrl: 'http://localhost:8080/v1', modelId: 'fixture', apiKeyConfigured: false,
        contextWindow: 32768, maxOutputTokens: 4096, temperature: 0.7,
      },
      demoMode: false, autoLearn: false, maxHandoffs: 6, workspacePath: '/tmp/loom',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: ['creator', 'next'].map((name) => ({
      id: `bot_${name}`, name, handle: name, role: 'Research', systemPrompt: 'Research carefully.',
      avatar: 'sparkles', color: '#829479', enabled: true, createdAt: now,
    })),
    rooms: [{
      id: 'room_one', name: 'Research', description: 'Research', botIds: ['bot_creator', 'bot_next'],
      archived: false, pinned: false, createdAt: now, updatedAt: now,
      autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room' },
    }],
    workItems: [work()],
    wakeups: [{
      id: 'wake_one', workId: 'work_one', roomId: 'room_one', botId: 'bot_next',
      createdByBotId: 'bot_creator', sourceTaskId: 'task_source', key: 'next',
      reason: 'Review tomorrow.', prompt: 'Review source.', status: 'scheduled',
      schedule: { type: 'once', dateTime: '2026-11-15T09:00', timeZone: 'Asia/Tokyo', missedRunPolicy: 'run_once' },
      nextRunAt: '2026-11-15T00:00:00.000Z', workRunId: 'run_one', revision: 1,
      createdAt: now, updatedAt: now,
    }],
    messages: [], tasks: [], activities: [], approvals: [], skills: [], memories: [],
    automations: [], notifications: [], queue: { active: 0, waiting: 0 },
  };
}
let root: ReturnType<typeof createRoot> | undefined;
const mutations: string[] = [];
let mutationError = false;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function unmount() {
  if (root) await act(async () => { root!.unmount(); await tick(); });
  root = undefined;
}
async function mount(
  data = fixture(),
  content: ReactNode = <AutomationsPage />,
  connected = true,
  locale: 'ja' | 'en' = 'en',
) {
  root ??= createRoot(document.getElementById('root')!);
  const context: AppContextValue = {
    data, connected, locale, t: (ja, en) => locale === 'ja' ? ja : en,
    view: 'automations', roomId: 'room_one', navigate() {},
    async refresh() {}, toast() {}, async signOut() {},
    async mutate<T>(path: string) {
      mutations.push(path);
      if (mutationError) throw new Error('Fixture update failed');
      return {} as T;
    },
  };
  await act(async () => {
    root!.render(<AppContext.Provider value={context}>{content}</AppContext.Provider>);
    await tick();
  });
}
function tabs() { return [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]; }
function panels() { return [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')]; }
function row(id = 'work_one') {
  const result = document.querySelector<HTMLDetailsElement>(`details[data-work-summary-id="${id}"]`);
  assert.ok(result);
  return result;
}
async function click(element: HTMLElement) {
  await act(async () => { element.click(); await tick(); });
}
async function key(element: HTMLElement, key: string) {
  await act(async () => {
    element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
    await tick();
  });
}
function button(label: string, scope: ParentNode = document) {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => item.textContent?.trim() === label);
  assert.ok(result, `Missing button ${label}`);
  return result;
}
beforeEach(async () => {
  await unmount();
  localStorage.clear();
  mutations.length = 0;
  mutationError = false;
});
after(async () => { await unmount(); dom.window.close(); });

test('defaults to execution rules and leaves work details collapsed', async () => {
  await mount();
  assert.equal(tabs().length, 2);
  assert.equal(tabs()[0].textContent, 'Execution rules');
  assert.equal(tabs()[0].getAttribute('aria-selected'), 'true');
  assert.equal(panels()[0].hidden, false);
  assert.equal(panels()[1].hidden, true);
  assert.equal(row().open, false);
  assert.equal(tabs()[1].querySelector('.work-attention-badge'), null);
  await click(tabs()[1]);
  assert.equal(panels()[0].hidden, true);
  assert.equal(panels()[1].hidden, false);
  assert.equal(row().open, false);
  assert.deepEqual(mutations, []);
});

test('tab keyboard navigation keeps focus, selection and panel relationships together', async () => {
  await mount();
  tabs()[0].focus();
  await key(tabs()[0], 'ArrowRight');
  assert.equal(document.activeElement, tabs()[1]);
  assert.equal(tabs()[0].tabIndex, -1);
  assert.equal(tabs()[1].tabIndex, 0);
  assert.equal(tabs()[1].getAttribute('aria-controls'), panels()[1].id);
  assert.equal(panels()[1].getAttribute('aria-labelledby'), tabs()[1].id);
  await key(tabs()[1], 'Home');
  assert.equal(document.activeElement, tabs()[0]);
  await key(tabs()[0], 'End');
  assert.equal(document.activeElement, tabs()[1]);
  await key(tabs()[1], 'ArrowLeft');
  assert.equal(document.activeElement, tabs()[0]);
});

test('restores tab and per-work expansion after remounting without mutating work', async () => {
  await mount();
  await click(tabs()[1]);
  await click(row().querySelector('summary')!);
  assert.equal(row().open, true);
  assert.equal(localStorage.getItem('loom:work-detail:/tmp/loom:work_one'), 'open');
  await unmount();
  await mount();
  assert.equal(panels()[1].hidden, false);
  assert.equal(row().open, true);
  await click(row().querySelector('summary')!);
  assert.equal(row().open, false);
  await unmount();
  await mount();
  assert.equal(row().open, false);
  assert.deepEqual(mutations, []);
});

test('changing workspace in place does not carry tab selection into another workspace', async () => {
  const data = fixture();
  await mount(data);
  await click(tabs()[1]);
  const other = fixture();
  other.settings.workspacePath = '/tmp/other-loom';
  await mount(other);
  assert.equal(panels()[0].hidden, false);
  assert.equal(localStorage.getItem('loom:automation-tab:/tmp/other-loom'), null);
  await mount(data);
  assert.equal(panels()[1].hidden, false);
});

test('counts unfinished work once and warns only for actionable current work', async () => {
  const data = fixture();
  data.workItems = [work(), work('blocked', 'blocked'), work('paused', 'paused'),
    work('approved_later'), work('done', 'completed'), work('cancelled', 'cancelled')];
  data.tasks = [task('approved_later', 'awaiting_approval'), task('done', 'awaiting_approval'),
    task('work_one', 'failed')];
  await mount(data);
  assert.equal(tabs()[1].querySelector('.subtle-tag')?.textContent, '4');
  assert.equal(tabs()[1].querySelector('.work-attention-badge')?.textContent, '2 need attention');
  assert.equal(row().dataset.needsAttention, undefined);
  assert.equal(row('paused').dataset.needsAttention, undefined);
  assert.equal(row('blocked').dataset.needsAttention, 'true');
  assert.equal(row('approved_later').dataset.needsAttention, 'true');
  assert.match(row('approved_later').querySelector('summary')!.textContent!, /Awaiting approval/);
  assert.equal(document.querySelector('[data-work-summary-id="done"]'), null);
});

test('pending checks and historical failures do not imply owner intervention', () => {
  const item = work();
  assert.equal(needsWorkAttention(item, [task(item.id, 'failed')]), false);
  assert.equal(needsWorkAttention({ ...item, status: 'paused' }, []), false);
  item.checkpoint.uncertainActions.push('Verify an attempted submission.');
  assert.equal(needsWorkAttention(item, []), true);
  assert.equal(needsWorkAttention({ ...item, status: 'completed' }, []), false);
  assert.equal(needsWorkAttention({ ...item, status: 'cancelled' }, []), false);
});

test('summary identifies next assignee rather than creator and marks held schedules', async () => {
  const data = fixture();
  await mount(data);
  let summary = row().querySelector('summary')!.textContent!;
  assert.match(summary, /Assigned: @next/);
  assert.doesNotMatch(summary, /@creator/);
  assert.match(summary, /Next:/);
  data.rooms[0].paused = true;
  await mount(data);
  summary = row().querySelector('summary')!.textContent!;
  assert.match(summary, /Held wake-up:/);
  assert.equal(row().dataset.needsAttention, undefined);
});

test('running tasks determine assignees and duplicate bot entries are removed', async () => {
  const data = fixture();
  data.tasks = [task('work_one', 'running'), task('work_one', 'waiting_tool')];
  await mount(data);
  const summary = row().querySelector('summary')!.textContent!;
  assert.match(summary, /Running/);
  assert.equal(summary.match(/@next/g)?.length, 1);
});

test('finished work remains accessible but is not counted or flagged', async () => {
  const data = fixture();
  data.workItems!.push(work('done', 'completed'), work('cancelled', 'cancelled'));
  await mount(data);
  await click(tabs()[1]);
  await click(button('Show finished work (2)'));
  assert.equal(row('done').open, false);
  assert.equal(row('cancelled').open, false);
  assert.equal(tabs()[1].querySelector('.subtle-tag')?.textContent, '1');
  assert.equal(row('done').dataset.needsAttention, undefined);
});

test('expanded work keeps existing pause controls, errors and disconnected guards', async () => {
  const data = fixture();
  await mount(data);
  await click(tabs()[1]);
  await click(row().querySelector('summary')!);
  mutationError = true;
  await click(button('Pause work', row()));
  assert.deepEqual(mutations, ['/work-items/work_one/pause']);
  assert.match(row().querySelector('[role="alert"]')!.textContent!, /Fixture update failed/);
  await mount(data, <AutomationsPage />, false);
  assert.equal(button('Pause work', row()).disabled, true);
  assert.equal(button('Mark complete', row()).disabled, true);
  assert.equal(button('Cancel work', row()).disabled, true);
});

test('room dialog uses the same compact rows and excludes other rooms', async () => {
  const data = fixture();
  data.workItems![0].status = 'blocked';
  data.workItems!.push({ ...work('other'), roomId: 'another-room' });
  await mount(data, <RoomWorkSummary roomId="room_one" />);
  const entry = document.querySelector<HTMLButtonElement>('.room-work-summary')!;
  assert.match(entry.textContent!, /1 ongoing work item/);
  assert.match(entry.textContent!, /1 need attention/);
  await click(entry);
  assert.equal(document.querySelectorAll('.compact-work').length, 1);
  assert.equal(row().open, false);
});

test('blocked browser storage does not prevent switching tabs or opening work', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(dom.window, 'localStorage')!;
  Object.defineProperty(dom.window, 'localStorage', {
    configurable: true,
    get() { throw new Error('Storage blocked'); },
  });
  try {
    await mount();
    await click(tabs()[1]);
    await click(row().querySelector('summary')!);
    assert.equal(panels()[1].hidden, false);
    assert.equal(row().open, true);
  } finally {
    Object.defineProperty(dom.window, 'localStorage', descriptor);
  }
});

test('older snapshots and invalid saved preferences keep a usable empty state', async () => {
  localStorage.setItem('loom:automation-tab:/tmp/loom', 'unknown');
  const data = fixture();
  delete data.workItems;
  delete data.wakeups;
  await mount(data, <AutomationsPage />, true, 'ja');
  assert.equal(tabs()[0].textContent, '実行ルール');
  assert.equal(panels()[0].hidden, false);
  await click(tabs()[1]);
  assert.match(panels()[1].textContent!, /継続中の仕事はありません/);
  assert.equal(tabs()[1].querySelector('.subtle-tag')?.textContent, '0');
});
