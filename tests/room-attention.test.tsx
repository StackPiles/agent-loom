import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue, Locale } from '../src/client/context';
import type { Approval, Bot, Message, Room, Snapshot, Task } from '../src/shared/types';
import { DEFAULT_IMAGE_SETTINGS } from '../src/shared/model-settings';

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
  'KeyboardEvent',
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
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
Object.defineProperty(dom.window, 'innerWidth', { value: 720, writable: true });
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('../src/client/context');
const { Chat } = await import('../src/client/Chat');

const now = '2026-11-01T00:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
const bot = (id: string, name: string): Bot => ({
  id,
  name,
  handle: name.toLowerCase(),
  role: 'Research',
  avatar: 'sparkles',
  color: '#829479',
  systemPrompt: 'Synthetic test bot.',
  enabled: true,
  createdAt: now,
});
const room: Room = {
  id: 'room_a',
  name: 'Research',
  description: '',
  botIds: ['bot_aster', 'bot_nova'],
  parallelResponses: true,
  pinned: false,
  archived: false,
  createdAt: now,
  updatedAt: now,
};
function fixture(): Snapshot {
  return {
    version: 'test',
    settings: {
      images: { ...DEFAULT_IMAGE_SETTINGS },
      inference: { maxConcurrentRequests: 2 },
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
      workspacePath: 'C:\\Loom\\Default',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: [bot('bot_aster', 'Aster'), bot('bot_nova', 'Nova')],
    rooms: [
      { ...room, botIds: [...room.botIds] },
      { ...room, id: 'room_b', name: 'Other', botIds: ['bot_aster'] },
    ],
    messages: [],
    tasks: [],
    activities: [],
    approvals: [],
    skills: [],
    memories: [],
    automations: [],
    notifications: [],
    queue: { active: 0, waiting: 0, capacity: 2 },
  };
}
function task(id: string, botId: string, status: Task['status'], seconds = 0): Task {
  return {
    id,
    roomId: room.id,
    botId,
    prompt: `Work for ${id}`,
    status,
    rootTaskId: id,
    depth: 0,
    kind: 'chat',
    output: '',
    createdAt: at(seconds),
    updatedAt: at(seconds),
    startedAt: at(seconds),
    inputTokens: 0,
    outputTokens: 0,
  };
}
function response(item: Task, body = '', seconds = 0): Message {
  return {
    id: `message_${item.id}`,
    roomId: item.roomId,
    authorType: 'bot',
    authorId: item.botId,
    taskId: item.id,
    body,
    status: 'streaming',
    createdAt: at(seconds),
  };
}
function approval(id: string, item: Task, seconds = 1): Approval {
  return {
    id,
    taskId: item.id,
    roomId: item.roomId,
    botId: item.botId,
    toolName: 'write_file',
    summary: `Review ${id}`,
    target: `C:\\Loom\\Default\\${id}.md`,
    args: { path: `${id}.md`, content: `Exact content for ${id}` },
    status: 'pending',
    createdAt: at(seconds),
  };
}
let root: ReturnType<typeof createRoot> | undefined;
let data: Snapshot;
let context: AppContextValue;
const mutations: { path: string; method?: string; body?: unknown }[] = [];
async function mount(next = fixture(), locale: Locale = 'en') {
  if (root) await act(async () => root!.unmount());
  localStorage.clear();
  localStorage.setItem('loom.locale', locale);
  localStorage.setItem('loom.activity', 'false');
  mutations.length = 0;
  data = next;
  context = {
    data,
    locale,
    t: (ja, en) => (locale === 'ja' ? ja : en),
    view: 'chat',
    roomId: room.id,
    navigate() {},
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string, method?: string, body?: unknown) {
      mutations.push({ path, method, body });
      return {} as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await render();
}
async function render(next = data) {
  data = next;
  context = { ...context, data };
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        <Chat room={data.rooms.find((item) => item.id === context.roomId)} />
      </AppContext.Provider>,
    ),
  );
}
function button(label: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  assert.ok(found, `Missing button ${label}`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
function attention() {
  const element = document.querySelector<HTMLElement>('[data-room-activity="room_a"]');
  assert.ok(element, 'Room attention must remain available beside the composer.');
  return element;
}
function botRow(id: string) {
  const element = attention().querySelector<HTMLElement>(`[data-room-bot-id="${id}"]`);
  assert.ok(element, `Missing visible status for ${id}`);
  return element;
}
function tray() {
  const element = attention().querySelector<HTMLElement>('[data-approval-tray]');
  assert.ok(element, 'Pending actions must be reachable from the persistent header.');
  return element;
}

test('an earlier bot approval stays visible beside the composer while another bot generates', async () => {
  const next = fixture();
  const first = task('earlier', 'bot_aster', 'awaiting_approval');
  const second = task('latest', 'bot_nova', 'running', 300);
  next.tasks = [first, second];
  next.messages = [
    response(first, 'The earlier answer is outside the loaded history.'),
    ...Array.from({ length: 105 }, (_, index): Message => ({
      id: `later_user_${index}`,
      roomId: room.id,
      authorType: 'user',
      authorId: 'user',
      body: `Later message ${index}`,
      status: 'complete',
      createdAt: at(index + 2),
    })),
    response(second, 'Nova is still generating.', 300),
  ];
  next.approvals = [approval('older_write', first)];
  next.queue.active = 1;
  await mount(next);
  const summary = attention();
  assert.equal(summary.getAttribute('aria-label'), 'Room activity');
  assert.equal(summary.closest('.message-scroll'), null);
  assert.ok(summary.closest('.composer-area'));
  assert.equal(document.querySelector('#activity-panel'), null);
  assert.ok(document.querySelector('.load-earlier'));
  assert.match(botRow('bot_aster').textContent || '', /Aster.*Needs approval/s);
  assert.match(botRow('bot_nova').textContent || '', /Nova.*Generating response/s);
  assert.equal(botRow('bot_aster').getAttribute('data-room-task-id'), first.id);
  assert.match(summary.textContent || '', /1.*approval/is);
  const review = button('Review pending approvals', summary);
  assert.equal(review.getAttribute('aria-expanded'), 'false');
  assert.equal(
    summary.querySelector('.approval-card'),
    null,
    'Closed tray must not duplicate cards.',
  );
  await click(review);
  assert.equal(review.getAttribute('aria-expanded'), 'true');
  const pending = tray();
  assert.equal(review.getAttribute('aria-controls'), pending.id);
  assert.equal(pending.getAttribute('aria-label'), 'Pending actions');
  const card = pending.querySelector<HTMLElement>('[data-approval-id="older_write"]');
  assert.ok(card);
  assert.ok(card.textContent?.includes(next.approvals[0].target));
  assert.ok(card.textContent?.includes('Exact content for older_write'));
  assert.ok(button('Approve', card));
  assert.ok(button('Deny', card));
});

test('the review tray orders all pending operations and resolves only the selected approval', async () => {
  const next = fixture();
  const a = task('a', 'bot_aster', 'awaiting_approval');
  const b = task('b', 'bot_nova', 'awaiting_approval');
  next.tasks = [a, b];
  next.messages = [response(a), response(b)];
  next.approvals = [approval('later', b, 20), approval('first', a, 10)];
  await mount(next);
  await click(button('Review pending approvals', attention()));
  assert.deepEqual(
    [...tray().querySelectorAll('[data-approval-id]')].map((item) =>
      item.getAttribute('data-approval-id'),
    ),
    ['first', 'later'],
  );
  const later = tray().querySelector<HTMLElement>('[data-approval-id="later"]')!;
  await click(button('Deny', later));
  assert.deepEqual(mutations, [
    { path: '/approvals/later', method: 'POST', body: { decision: 'deny' } },
  ]);
  await render({
    ...data,
    approvals: data.approvals.map((item) =>
      item.id === 'later' ? { ...item, status: 'denied', decidedAt: at(25) } : item,
    ),
  });
  assert.equal(tray().querySelector('[data-approval-id="later"]'), null);
  assert.equal(tray().querySelectorAll('.approval-card').length, 1);
  assert.match(attention().textContent || '', /1.*approval/is);
  await click(button('Approve', tray().querySelector<HTMLElement>('[data-approval-id="first"]')!));
  assert.deepEqual(mutations.at(-1), {
    path: '/approvals/first',
    method: 'POST',
    body: { decision: 'approve' },
  });
  await render({
    ...data,
    approvals: data.approvals.map((item) =>
      item.id === 'first' ? { ...item, status: 'approved', decidedAt: at(30) } : item,
    ),
  });
  assert.equal(attention().querySelector('[data-approval-tray]'), null);
  assert.equal(
    [...attention().querySelectorAll('button')].some(
      (item) =>
        item.getAttribute('aria-label') === 'Review pending approvals' ||
        item.textContent?.trim() === 'Review pending approvals',
    ),
    false,
  );
  assert.equal(mutations.length, 2);
});

test('duplicate views of one pending approval share a decision lock', async () => {
  const next = fixture();
  const a = task('shared_decision', 'bot_aster', 'awaiting_approval');
  next.tasks = [a];
  next.messages = [response(a)];
  next.approvals = [approval('shared_permission', a)];
  await mount(next);
  await click(button('Review pending approvals', attention()));
  let settle!: () => void;
  const pendingDecision = new Promise<void>((resolve) => {
    settle = resolve;
  });
  context = {
    ...context,
    async mutate<T>(path: string, method?: string, body?: unknown) {
      mutations.push({ path, method, body });
      await pendingDecision;
      return {} as T;
    },
  };
  await render();
  try {
    const cards = [
      ...document.querySelectorAll<HTMLElement>('[data-approval-id="shared_permission"]'),
    ];
    assert.equal(
      cards.length,
      2,
      'The same pending action is shown in the message and the review tray.',
    );
    await click(button('Approve', tray()));
    for (const card of cards) {
      assert.equal(button('Approve', card).disabled, true);
      assert.equal(button('Deny', card).disabled, true);
    }
    await click(button('Deny', cards[0]));
    assert.deepEqual(mutations, [
      { path: '/approvals/shared_permission', method: 'POST', body: { decision: 'approve' } },
    ]);
  } finally {
    await act(async () => settle());
  }
});

test('incoming approval and streamed text never move a reader away from earlier messages', async () => {
  const next = fixture();
  const a = task('reading', 'bot_aster', 'running');
  const b = task('writing', 'bot_nova', 'running');
  next.tasks = [a, b];
  next.messages = [response(a, 'An earlier answer.'), response(b, 'A newer answer.')];
  await mount(next);
  const scroll = document.querySelector<HTMLDivElement>('.message-scroll')!;
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 2400 });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 });
  await act(async () => {
    scroll.scrollTop = 120;
    scroll.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  });
  await render({
    ...data,
    tasks: data.tasks.map((item) =>
      item.id === a.id ? { ...item, status: 'awaiting_approval' } : item,
    ),
    approvals: [approval('reading_permission', a)],
    messages: data.messages.map((item) =>
      item.taskId === b.id
        ? { ...item, body: 'A newer answer with another streamed paragraph.' }
        : item,
    ),
  });
  assert.equal(scroll.scrollTop, 120);
  assert.ok(document.querySelector('.jump-latest'));
  assert.match(botRow('bot_aster').textContent || '', /Needs approval/);
  assert.match(botRow('bot_nova').textContent || '', /Generating response/);
  await click(button('Review pending approvals', attention()));
  assert.equal(
    scroll.scrollTop,
    120,
    'Reviewing an approval does not require jumping the message list.',
  );
  assert.ok(tray().querySelector('[data-approval-id="reading_permission"]'));
});

test('a bot status opens its own pending action and dismissing the dialog preserves the notice', async () => {
  const next = fixture();
  const a = task('a_direct', 'bot_aster', 'awaiting_approval');
  const b = task('b_direct', 'bot_nova', 'awaiting_approval');
  next.tasks = [a, b];
  next.messages = [response(a), response(b)];
  next.approvals = [approval('first_direct', a, 10), approval('nova_direct', b, 20)];
  await mount(next);
  await click(button('Nova: Needs approval', botRow('bot_nova')));
  assert.equal(document.activeElement?.getAttribute('data-approval-id'), 'nova_direct');
  assert.ok(document.querySelector('dialog[open]'));
  await act(async () => {
    document
      .querySelector('dialog[open]')!
      .dispatchEvent(new dom.window.Event('cancel', { bubbles: true, cancelable: true }));
  });
  assert.equal(attention().querySelector('[data-approval-tray]'), null);
  assert.match(attention().textContent || '', /2 pending approvals/);
  assert.equal(mutations.length, 0);
  await click(button('Review pending approvals', attention()));
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')!;
  dialog.getBoundingClientRect = () => ({
    left: 100,
    top: 100,
    right: 600,
    bottom: 600,
    width: 500,
    height: 500,
    x: 100,
    y: 100,
    toJSON() {},
  });
  await act(async () =>
    dialog.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true, clientX: 50, clientY: 50 }),
    ),
  );
  assert.equal(attention().querySelector('[data-approval-tray]'), null);
  assert.equal(
    button('Review pending approvals', attention()).getAttribute('aria-expanded'),
    'false',
  );
  assert.match(attention().textContent || '', /2 pending approvals/);
  assert.equal(mutations.length, 0);
});

test('stopped and completed tasks override stale streaming flags and expose the correct task controls', async () => {
  const next = fixture();
  const a = task('state_changes', 'bot_aster', 'running');
  next.tasks = [a];
  next.messages = [response(a, 'Partial answer.')];
  next.queue.active = 1;
  await mount(next);
  assert.match(botRow('bot_aster').textContent || '', /Generating response/);
  await click(button("Stop Aster's task", botRow('bot_aster')));
  assert.equal(mutations.at(-1)?.path, '/tasks/state_changes/stop');
  await render({
    ...data,
    tasks: [{ ...a, status: 'stopped', updatedAt: at(10) }],
    queue: { ...data.queue, active: 0 },
  });
  const stopped = botRow('bot_aster');
  assert.match(stopped.textContent || '', /Stopped/);
  assert.equal(stopped.querySelector('.spin, .pulse'), null);
  assert.equal(document.querySelector('.message .stream-cursor'), null);
  await click(button("Resume Aster's task", stopped));
  assert.equal(mutations.at(-1)?.path, '/tasks/state_changes/resume');
  await render({
    ...data,
    tasks: [{ ...a, status: 'queued', updatedAt: at(20) }],
    queue: {
      active: 0,
      waiting: 1,
      capacity: 2,
      waitingTasks: [{ taskId: a.id, reason: 'worker' }],
    },
  });
  assert.match(botRow('bot_aster').textContent || '', /Queued|Waiting/);
  assert.equal(botRow('bot_aster').querySelector('.spin, .pulse'), null);
  await render({
    ...data,
    tasks: [{ ...a, status: 'completed', completedAt: at(30) }],
    queue: { active: 0, waiting: 0, capacity: 2 },
  });
  assert.match(botRow('bot_aster').textContent || '', /Completed/);
  assert.equal(botRow('bot_aster').querySelector('.spin, .pulse'), null);
  assert.equal(
    [...botRow('bot_aster').querySelectorAll('button')].some((item) =>
      /^(Stop|Resume) Aster's task$/.test(item.getAttribute('aria-label') || ''),
    ),
    false,
  );
  assert.equal(document.querySelector('.message .stream-cursor'), null);
});

test('per-bot status prioritizes unresolved approvals and active tasks over newer historical records', async () => {
  const next = fixture();
  const pending = task('pending_old', 'bot_aster', 'awaiting_approval', 0);
  const newerDone = task('done_newer', 'bot_aster', 'completed', 60);
  const active = task('active', 'bot_nova', 'running', 20);
  const otherRoom = {
    ...task('other_room', 'bot_nova', 'awaiting_approval', 80),
    roomId: 'room_b',
  };
  next.tasks = [pending, newerDone, active, otherRoom];
  next.messages = [
    response(pending),
    { ...response(newerDone, 'Finished.', 60), status: 'complete' },
    response(active, 'Current work.', 20),
  ];
  next.approvals = [
    approval('current_room_permission', pending),
    approval('other_room_permission', otherRoom),
  ];
  await mount(next);
  assert.equal(botRow('bot_aster').getAttribute('data-room-task-id'), pending.id);
  assert.match(botRow('bot_aster').textContent || '', /Needs approval/);
  assert.equal(botRow('bot_nova').getAttribute('data-room-task-id'), active.id);
  assert.match(botRow('bot_nova').textContent || '', /Generating response/);
  await click(button('Review pending approvals', attention()));
  assert.deepEqual(
    [...tray().querySelectorAll('[data-approval-id]')].map((item) =>
      item.getAttribute('data-approval-id'),
    ),
    ['current_room_permission'],
  );
});

test('switching rooms after reading earlier messages opens the new room at its latest message', async () => {
  const next = fixture();
  const a = task('a_history', 'bot_aster', 'completed');
  const b = { ...task('b_history', 'bot_aster', 'completed', 10), roomId: 'room_b' };
  next.tasks = [a, b];
  next.messages = [
    { ...response(a, 'The latest answer in room A.'), status: 'complete' },
    { ...response(b, 'The latest answer in room B.', 10), status: 'complete' },
  ];
  await mount(next);
  const scroll = document.querySelector<HTMLDivElement>('.message-scroll')!;
  let contentHeight = 2200;
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => contentHeight });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 });
  await act(async () => {
    scroll.scrollTop = 160;
    scroll.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  });
  assert.ok(document.querySelector('.jump-latest'));
  assert.equal(scroll.scrollTop, 160);
  contentHeight = 3400;
  context = { ...context, roomId: 'room_b' };
  await render();
  const switchedScroll = document.querySelector<HTMLDivElement>('.message-scroll')!;
  assert.match(switchedScroll.textContent || '', /The latest answer in room B\./);
  assert.doesNotMatch(switchedScroll.textContent || '', /The latest answer in room A\./);
  assert.ok(
    switchedScroll.scrollTop >= switchedScroll.scrollHeight - switchedScroll.clientHeight,
    'The new room must be at the bottom, not inherit the previous room’s reading offset.',
  );
  assert.equal(document.querySelector('.jump-latest'), null);
});

test('room switching closes the old review tray and leaves a stopped bot visibly stopped', async () => {
  const next = fixture();
  const a = task('pending', 'bot_aster', 'awaiting_approval');
  const b = { ...task('stopped_elsewhere', 'bot_aster', 'stopped', 10), roomId: 'room_b' };
  next.tasks = [a, b];
  next.messages = [response(a), response(b, 'Stopped partial answer.', 10)];
  next.approvals = [approval('room_a_only', a)];
  await mount(next);
  await click(button('Review pending approvals', attention()));
  context = { ...context, roomId: 'room_b' };
  await render();
  const other = document.querySelector<HTMLElement>('[data-room-activity="room_b"]');
  assert.ok(other);
  assert.equal(document.querySelector('[data-room-activity="room_a"]'), null);
  assert.equal(other.querySelector('[data-approval-tray]'), null);
  assert.doesNotMatch(other.textContent || '', /room_a_only/);
  assert.match(other.textContent || '', /Stopped/);
  assert.equal(other.querySelector('.spin, .pulse'), null);
  assert.ok(button("Resume Aster's task", other));
});

test('connection loss marks active work unconfirmed without inventing a stopped state', async () => {
  const next = fixture();
  const a = task('active_connection', 'bot_aster', 'running');
  const b = task('finished_connection', 'bot_nova', 'completed');
  next.tasks = [a, b];
  next.messages = [
    response(a, 'Active response.'),
    { ...response(b, 'Finished response.'), status: 'complete' },
  ];
  await mount(next);
  context = { ...context, connected: false };
  await render();
  assert.match(botRow('bot_aster').textContent || '', /Status unconfirmed/);
  assert.doesNotMatch(botRow('bot_aster').textContent || '', /Generating response|Stopped/);
  assert.equal(botRow('bot_aster').querySelector('.spin, .pulse'), null);
  assert.equal(document.querySelector('.message .stream-cursor'), null);
  assert.match(botRow('bot_nova').textContent || '', /Completed/);
  context = { ...context, connected: true };
  await render({ ...data, tasks: [{ ...a, status: 'stopped' }, b] });
  assert.match(botRow('bot_aster').textContent || '', /Stopped/);
  assert.doesNotMatch(botRow('bot_aster').textContent || '', /Status unconfirmed/);
});

test('latest terminal work stays distinct from idle and disabled teammates', async () => {
  const next = fixture();
  const old = task('old_stop', 'bot_aster', 'stopped', 1);
  const recent = task('recent_finish', 'bot_aster', 'completed', 30);
  next.tasks = [recent, old];
  next.messages = [
    response(old, 'Old partial text.'),
    { ...response(recent, 'Completed newer work.', 30), status: 'complete' },
  ];
  next.bots[1].enabled = false;
  next.bots.push(bot('bot_cedar', 'Cedar'));
  next.rooms[0].botIds.push('bot_cedar');
  await mount(next);
  assert.equal(botRow('bot_aster').getAttribute('data-room-task-id'), recent.id);
  assert.match(botRow('bot_aster').textContent || '', /Completed/);
  assert.doesNotMatch(botRow('bot_aster').textContent || '', /Stopped|Resume/);
  assert.match(botRow('bot_nova').textContent || '', /Disabled/);
  assert.match(botRow('bot_cedar').textContent || '', /Idle/);
  assert.equal(attention().querySelector('.spin, .pulse'), null);
});

after(async () => {
  if (root) await act(async () => root?.unmount());
  dom.window.close();
});
