import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Snapshot, Task } from '../src/shared/types';

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
  fetch: async (path: string) => {
    assert.equal(path, '/api/workspace-picker');
    return new Response(
      JSON.stringify({ available: false, platform: 'linux', reason: 'headless' }),
    );
  },
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
const { Chat } = await import('../src/client/Chat');

const now = '2026-11-04T00:00:00.000Z';
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
      workspacePath: 'C:\\Loom\\Default',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: ['Aster', 'Nova'].map((name, index) => ({
      id: `bot_${index}`,
      name,
      handle: name.toLowerCase(),
      role: 'Research',
      avatar: 'sparkles',
      color: '#829479',
      systemPrompt: 'Test bot.',
      enabled: index === 0,
      createdAt: now,
    })),
    rooms: ['Research', 'Planning'].map((name, index) => ({
      id: `room_${index}`,
      name,
      description: index === 0 ? 'Research a topic.\nKeep full details available.' : '',
      botIds: index === 0 ? ['bot_0', 'bot_1'] : ['bot_0'],
      workspacePath: index === 0 ? 'D:\\Projects\\Room-specific workspace' : undefined,
      parallelResponses: index === 0,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    })),
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
function task(id: string, roomId: string, status: Task['status']): Task {
  return {
    id,
    roomId,
    botId: 'bot_0',
    prompt: 'Test task',
    status,
    rootTaskId: id,
    depth: 0,
    kind: 'chat',
    output: '',
    createdAt: now,
    updatedAt: now,
    inputTokens: 0,
    outputTokens: 0,
  };
}
let root: ReturnType<typeof createRoot> | undefined;
let context: AppContextValue;
let focusMode = false;
let openActivityCalls = 0;
const mutations: { path: string; method?: string; body?: unknown }[] = [];
async function mount(data = fixture(), focused = false, width = 1440) {
  if (root) await act(async () => root!.unmount());
  localStorage.clear();
  Object.defineProperty(dom.window, 'innerWidth', { value: width, configurable: true });
  mutations.length = 0;
  openActivityCalls = 0;
  focusMode = focused;
  context = {
    data,
    locale: 'en',
    t: (_ja, en) => en,
    view: 'chat',
    roomId: data.rooms[0].id,
    connected: true,
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
async function render() {
  await act(async () => {
    root!.render(
      <AppContext.Provider value={context}>
        <Chat
          room={context.data.rooms.find((room) => room.id === context.roomId)}
          focusMode={focusMode}
          onOpenActivity={() => openActivityCalls++}
        />
      </AppContext.Provider>,
    );
  });
}
function button(label: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label,
  );
  assert.ok(found, `Missing button: ${label}`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => {
    element.focus();
    element.click();
  });
}
async function draft(value: string) {
  const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      composer,
      value,
    );
    composer.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
function dialog() {
  const found = document.querySelector<HTMLDialogElement>('dialog[open]');
  assert.ok(found, 'A room dialog must be open.');
  return found;
}
async function cancelDialog() {
  await act(async () => {
    dialog().dispatchEvent(new dom.window.Event('cancel', { cancelable: true }));
  });
}

test('normal, focused, and narrow layouts put room metadata behind one accessible details action', async () => {
  for (const [focused, width] of [
    [false, 1440],
    [true, 1440],
    [false, 390],
  ] as const) {
    const data = fixture();
    await mount(data, focused, width);
    const header = document.querySelector('.room-header')!;
    assert.equal(header.querySelector('h1')?.textContent, data.rooms[0].name);
    assert.equal(header.querySelector('h1')?.getAttribute('title'), data.rooms[0].name);
    assert.equal(document.querySelector('.room-context'), null);
    assert.equal(header.querySelector('.room-workspace-link'), null);
    assert.ok(!header.textContent?.includes(data.rooms[0].description));
    assert.ok(!header.textContent?.includes('No active tasks'));
    assert.equal(document.querySelector('dialog'), null);
    await draft('Keep this message while reading room details.');
    const trigger = button('Show room details', header);
    assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await click(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const details = dialog();
    assert.equal(details.querySelector('h2')?.textContent, 'Room details');
    assert.equal(
      details.querySelector('.room-details-description')?.textContent,
      data.rooms[0].description,
    );
    assert.equal(
      details.querySelector('.room-workspace-link')?.textContent,
      data.rooms[0].workspacePath,
    );
    assert.match(details.textContent || '', /Workspace set for this room/);
    assert.match(details.textContent || '', /Parallel responses allowed/);
    assert.deepEqual(
      [...details.querySelectorAll('.room-details-members strong')].map((item) => item.textContent),
      ['Aster', 'Nova'],
    );
    assert.match(
      details.querySelector('.room-details-members')?.textContent || '',
      /Nova.*Disabled/s,
    );
    await cancelDialog();
    assert.equal(document.querySelector('dialog'), null);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, trigger);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value,
      'Keep this message while reading room details.',
    );
    assert.equal(mutations.length, 0);
  }
});

test('workspace, simultaneous-response, and edit actions transfer to the existing room editor', async () => {
  await mount();
  await draft('Unsent draft');
  for (const label of [
    'Change this room’s workspace',
    'Configure simultaneous responses in this room',
    'Edit room',
  ]) {
    await click(button('Show room details'));
    await click(button(label, dialog()));
    assert.equal(document.querySelectorAll('dialog[open]').length, 1);
    assert.equal(dialog().querySelector('h2')?.textContent, 'Edit room');
    assert.equal(dialog().querySelector<HTMLInputElement>('input')?.value, 'Research');
    assert.equal(
      dialog().querySelector('.workspace-path')?.textContent,
      context.data.rooms[0].workspacePath,
    );
    assert.equal(
      dialog().querySelector('.room-generation-field input')?.getAttribute('type'),
      'checkbox',
    );
    await cancelDialog();
    assert.equal(
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value,
      'Unsent draft',
    );
    assert.equal(document.activeElement, button('Show room details'));
  }
  assert.equal(mutations.length, 0);
});

test('member avatars open full details and switching rooms closes stale metadata while retaining drafts', async () => {
  await mount();
  await draft('Research draft');
  await click(button('Show 2 room members'));
  assert.equal(dialog().querySelectorAll('.room-details-members li').length, 2);
  context = { ...context, roomId: 'room_1' };
  await render();
  assert.equal(document.querySelector('dialog'), null);
  assert.equal(button('Show room details').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('.room-header h1')?.textContent, 'Planning');
  await click(button('Show room details'));
  assert.equal(
    dialog().querySelector('.room-workspace-link')?.textContent,
    context.data.settings.workspacePath,
  );
  assert.match(dialog().textContent || '', /Using the default workspace/);
  assert.match(dialog().textContent || '', /One response at a time/);
  assert.match(dialog().textContent || '', /No room purpose set/);
  assert.equal(dialog().querySelectorAll('.room-details-members li').length, 1);
  await click(button('Close', dialog()));
  context = { ...context, roomId: 'room_0' };
  await render();
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value,
    'Research draft',
  );
});

test('the compact header pauses the room as a whole without cancelling active or queued tasks', async () => {
  const data = fixture();
  data.tasks = [
    task('running', 'room_0', 'running'),
    task('queued', 'room_0', 'queued'),
    task('done', 'room_0', 'completed'),
    task('other', 'room_1', 'running'),
  ];
  await mount(data, true, 390);
  await click(
    button('Pause this room after current tasks finish', document.querySelector('.room-header')!),
  );
  assert.deepEqual(mutations, [{ path: '/rooms/room_0/pause', method: 'POST', body: undefined }]);
  assert.equal(document.querySelector('.composer-area [data-room-activity]'), null);
  assert.deepEqual(
    data.tasks.map((item) => item.status),
    ['running', 'queued', 'completed', 'running'],
  );
  context = {
    ...context,
    data: {
      ...data,
      rooms: data.rooms.map((item) => (item.id === 'room_0' ? { ...item, paused: true } : item)),
    },
  };
  await render();
  assert.equal(document.querySelector('.room-pause-state')?.textContent, 'Pausing');
  assert.ok(button('Resume this room'));
  context = {
    ...context,
    data: {
      ...context.data,
      tasks: data.tasks.map((item) =>
        item.id === 'running' ? { ...item, status: 'completed' } : item,
      ),
    },
  };
  await render();
  assert.equal(
    document.querySelector('.room-pause-state')?.textContent,
    'Paused',
    'Queued work and another room’s generation do not prevent the room from resting.',
  );
  await click(button('Resume this room'));
  assert.deepEqual(
    mutations.map((item) => item.path),
    ['/rooms/room_0/pause', '/rooms/room_0/resume'],
  );
  assert.equal(
    document.querySelector('.room-header button[aria-label="Stop work in this room"]'),
    null,
  );
});

test('an idle room can be paused and messages sent while paused do not implicitly resume it', async () => {
  const data = fixture();
  await mount(data);
  await click(button('Pause this room after current tasks finish'));
  assert.equal(mutations.at(-1)?.path, '/rooms/room_0/pause');
  context = {
    ...context,
    data: { ...data, rooms: data.rooms.map((item) => ({ ...item, paused: true })) },
  };
  await render();
  const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
  assert.equal(composer.rows, 1);
  assert.match(composer.placeholder, /resumes/);
  assert.match(button('Send message').title, /after the room resumes/);
  await draft('Keep this request until I resume.');
  await click(button('Send message'));
  assert.deepEqual(mutations.at(-1), {
    path: '/rooms/room_0/messages',
    method: 'POST',
    body: { body: 'Keep this request until I resume.' },
  });
  assert.equal(
    mutations.some((item) => item.path.endsWith('/resume')),
    false,
  );
  assert.equal(document.querySelector('.room-pause-state')?.textContent, 'Paused');
});

test('welcome and Activity selections add visible mentions without hidden recipient state', async () => {
  const data = fixture();
  data.bots.forEach((bot) => (bot.enabled = true));
  await mount(data);
  await draft('Please review this idea.');
  const composer = document.querySelector<HTMLTextAreaElement>('.composer textarea')!;
  const aster = [...document.querySelectorAll<HTMLButtonElement>('.welcome-members button')].find(
    (item) => item.textContent?.includes('Aster'),
  )!;
  await click(aster);
  const firstSelection = composer.value;
  assert.match(firstSelection, /Please review this idea\./);
  assert.match(firstSelection, /@aster\b/);
  await click(aster);
  assert.equal(composer.value, firstSelection, 'Repeated selection does not duplicate a mention');
  await click(button('Nova: Idle', document.querySelector('.activity-panel')!));
  assert.match(composer.value, /@aster\b/);
  assert.match(composer.value, /@nova\b/);
  assert.equal(mutations.length, 0, 'Selecting a teammate does not submit the draft');
  const body = composer.value.trim();
  await click(button('Send message'));
  assert.deepEqual(mutations, [{ path: '/rooms/room_0/messages', method: 'POST', body: { body } }]);
});

test('room pause uses one request at a time and cannot be changed while disconnected', async () => {
  await mount();
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  context = {
    ...context,
    async mutate<T>(path: string, method?: string, body?: unknown) {
      mutations.push({ path, method, body });
      await waiting;
      return {} as T;
    },
  };
  await render();
  const pause = button('Pause this room after current tasks finish');
  await act(async () => {
    pause.click();
    pause.click();
  });
  assert.equal(mutations.length, 1);
  assert.equal(pause.disabled, true);
  await act(async () => finish());
  assert.equal(pause.disabled, false);
  context = { ...context, connected: false };
  await render();
  assert.equal(pause.disabled, true);
  await click(pause);
  assert.equal(mutations.length, 1);
  await draft('Wait for the connection.');
  assert.equal(button('Send message').disabled, true);
});

test('activity opening retains the focus-layout callback and the room menu remains usable', async () => {
  await mount(fixture(), true);
  const toggle = button('Toggle activity');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  await click(toggle);
  assert.equal(openActivityCalls, 1);
  focusMode = false;
  await render();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(document.querySelector('#activity-panel'));
  await click(toggle);
  assert.equal(document.querySelector('#activity-panel'), null);
  assert.equal(openActivityCalls, 1);
  const menu = document.querySelector<HTMLDetailsElement>('.room-menu')!;
  await click(menu.querySelector('summary')!);
  assert.equal(menu.open, true);
  await click(button('Pin room', menu));
  assert.equal(menu.open, false);
  assert.deepEqual(mutations, [{ path: '/rooms/room_0', method: 'PATCH', body: { pinned: true } }]);
  await click(menu.querySelector('summary')!);
  await click(button('Edit room', menu));
  assert.equal(dialog().querySelector('h2')?.textContent, 'Edit room');
});

after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});
