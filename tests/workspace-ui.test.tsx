import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Bot, FolderPickerStatus, Room, Snapshot, Task } from '../src/shared/types';

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
const { renderToStaticMarkup } = await import('react-dom/server');
const { AppContext } = await import('../src/client/context');
const { Avatar } = await import('../src/client/components');
const { RoomDialog } = await import('../src/client/RoomDialog');
const { SettingsPage } = await import('../src/client/SettingsPage');
const { Chat } = await import('../src/client/Chat');
const { TeamPage } = await import('../src/client/TeamPage');

const now = '2026-10-30T10:00:00.000Z';
const makeBot = (id: string, name: string, avatar: string): Bot => ({
  id,
  name,
  handle: name.toLowerCase(),
  role: 'Research',
  avatar,
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
  pinned: false,
  archived: false,
  createdAt: now,
  updatedAt: now,
};
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
      demoMode: true,
      autoLearn: false,
      maxHandoffs: 6,
      workspacePath: 'C:\\Loom\\Default',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: [makeBot('bot_aster', 'Aster', 'sparkles'), makeBot('bot_nova', 'Nova', 'compass')],
    rooms: [{ ...room }, { ...room, id: 'room_b', name: 'Other', workspacePath: 'D:\\Other' }],
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
const task = (roomId: string): Task => ({
  id: 'task_1',
  roomId,
  botId: 'bot_aster',
  prompt: 'Test',
  status: 'running',
  rootTaskId: 'task_1',
  depth: 0,
  kind: 'chat',
  output: '',
  createdAt: now,
  updatedAt: now,
  inputTokens: 0,
  outputTokens: 0,
});
let root: ReturnType<typeof createRoot> | undefined;
let status: FolderPickerStatus = { available: true, platform: 'win32' };
let chosen: (string | null)[] = [];
let postPicker: ((init: RequestInit) => Promise<Response>) | undefined;
const requests: { path: string; method: string; body?: any; signal?: AbortSignal | null }[] = [];
const mutations: { path: string; method?: string; body?: any }[] = [];
Object.assign(globalThis, {
  fetch: async (path: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    requests.push({
      path,
      method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      signal: init.signal,
    });
    if (path === '/api/auth') return new Response(JSON.stringify({ required: false }));
    assert.equal(path, '/api/workspace-picker');
    if (method === 'GET') return new Response(JSON.stringify(status));
    if (postPicker) return postPicker(init);
    return new Response(JSON.stringify({ path: chosen.shift() ?? null }));
  },
});
async function mount(
  render: (data: Snapshot) => React.ReactNode,
  data = fixture(),
  capability: FolderPickerStatus = { available: true, platform: 'win32' },
) {
  if (root) await act(async () => root!.unmount());
  localStorage.clear();
  status = capability;
  chosen = [];
  postPicker = undefined;
  requests.length = 0;
  mutations.length = 0;
  const context: AppContextValue = {
    data,
    locale: 'en',
    t: (_ja, en) => en,
    view: 'chat',
    roomId: room.id,
    navigate() {},
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string, method?: string, body?: unknown) {
      mutations.push({ path, method, body });
      return { ...room, ...(body as object), id: room.id } as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root!.render(<AppContext.Provider value={context}>{render(data)}</AppContext.Provider>);
  });
}
function button(text: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text,
  );
  assert.ok(found, `Missing button ${text}`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function save() {
  await act(async () => {
    document
      .querySelector('form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  return mutations.at(-1)!;
}

test('seeded avatar identifiers render icons in every size; unknown labels and joined emoji remain bounded', () => {
  for (const size of ['small', 'normal', 'large'] as const) {
    for (const key of ['sparkles', 'compass']) {
      const html = renderToStaticMarkup(<Avatar size={size} bot={makeBot('bot', 'Aster', key)} />);
      const el = new JSDOM(html).window.document.querySelector('.avatar')!;
      assert.ok(el.querySelector(`svg.lucide-${key}`));
      assert.equal(el.textContent, '', 'Icon keys must never appear as raw text');
    }
  }
  for (const key of ['an-unknown-long-avatar-name', '__proto__', 'constructor']) {
    const html = renderToStaticMarkup(<Avatar bot={makeBot('bot', 'Aster', key)} />);
    assert.equal(new JSDOM(html).window.document.querySelector('.avatar')?.textContent, 'A');
  }
  for (const glyph of ['👩🏽‍💻', 'e\u0301', '✦']) {
    const html = renderToStaticMarkup(<Avatar bot={makeBot('bot', 'Aster', glyph)} />);
    assert.equal(new JSDOM(html).window.document.querySelector('.avatar')?.textContent, glyph);
  }
});

test('native folder selection updates only the room draft; cancelling preserves the current folder', async () => {
  const data = fixture();
  data.rooms[0].workspacePath = 'D:\\Existing';
  await mount((d) => <RoomDialog room={d.rooms[0]} onClose={() => {}} />, data);
  assert.equal(document.querySelector('.workspace-path')?.textContent, 'D:\\Existing');
  assert.equal(document.querySelector('input[type="file"]'), null);
  chosen = [null, 'D:\\Research 日本語'];
  await click(button('Choose folder'));
  assert.equal(document.querySelector('.workspace-path')?.textContent, 'D:\\Existing');
  assert.equal(mutations.length, 0);
  await click(button('Choose folder'));
  assert.equal(document.querySelector('.workspace-path')?.textContent, 'D:\\Research 日本語');
  assert.deepEqual(requests.filter((r) => r.method === 'POST').at(-1)?.body, {
    initialPath: 'D:\\Existing',
  });
  assert.equal(mutations.length, 0, 'Picking does not save before the room form is submitted');
  const result = await save();
  assert.equal(result.path, '/rooms/room_a');
  assert.equal(result.method, 'PATCH');
  assert.equal(result.body.workspacePath, 'D:\\Research 日本語');
  assert.equal(data.rooms[1].workspacePath, 'D:\\Other');
  data.rooms[0].workspacePath = '/tmp/existing';
  await mount((d) => <RoomDialog room={d.rooms[0]} onClose={() => {}} />, data, {
    available: true,
    platform: 'linux',
  });
  chosen = ['/tmp/研究資料 '];
  await click(button('Choose folder'));
  assert.equal(document.querySelector('.workspace-path')?.textContent, '/tmp/研究資料 ');
  assert.equal(
    (await save()).body.workspacePath,
    '/tmp/研究資料 ',
    'A selected POSIX folder keeps its literal trailing space',
  );
});

test('room default inheritance, clearing an override, and new-room folder saves are explicit', async () => {
  await mount((d) => <RoomDialog room={d.rooms[0]} onClose={() => {}} />);
  assert.equal(document.querySelector('.workspace-path')?.textContent, 'C:\\Loom\\Default');
  assert.match(
    document.querySelector('.workspace-default-label')?.textContent || '',
    /Using the default/,
  );
  const unchanged = await save();
  assert.equal('workspacePath' in unchanged.body, false);
  const data = fixture();
  data.rooms[0].workspacePath = 'D:\\Research';
  await mount((d) => <RoomDialog room={d.rooms[0]} onClose={() => {}} />, data);
  await click(button('Use default folder'));
  assert.equal((await save()).body.workspacePath, null);
  await mount(() => <RoomDialog onClose={() => {}} />);
  await input(document.querySelector('dialog input')!, 'New room');
  chosen = ['E:\\Projects'];
  await click(button('Choose folder'));
  const created = await save();
  assert.equal(created.method, 'POST');
  assert.equal(created.body.workspacePath, 'E:\\Projects');
  assert.deepEqual(created.body.botIds, ['bot_aster', 'bot_nova']);
});

test('active work locks only its room folder; global default selection remains separate', async () => {
  const data = fixture();
  data.tasks = [task('room_a')];
  await mount((d) => <RoomDialog room={d.rooms[0]} onClose={() => {}} />, data);
  assert.equal(button('Choose folder').disabled, true);
  assert.equal(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled, true);
  await input(document.querySelector('dialog input')!, 'Renamed');
  const renamed = await save();
  assert.equal('workspacePath' in renamed.body, false);
  assert.equal(
    'botIds' in renamed.body,
    false,
    'An unchanged member list must not block a name-only edit',
  );
  await mount((d) => <RoomDialog room={d.rooms[1]} onClose={() => {}} />, data);
  assert.equal(button('Choose folder').disabled, false);
  await mount(() => <SettingsPage />);
  chosen = ['E:\\New default'];
  await click(button('Choose folder'));
  const setting = await save();
  assert.equal(setting.path, '/settings');
  assert.equal(setting.body.workspacePath, 'E:\\New default');
  await mount(() => <SettingsPage />, data);
  assert.equal(button('Choose folder').disabled, true);
  const customOnly = fixture();
  customOnly.tasks = [task('room_b')];
  await mount(() => <SettingsPage />, customOnly);
  assert.equal(
    button('Choose folder').disabled,
    false,
    'A custom-root room does not lock the global default',
  );
  chosen = ['E:\\Updated default'];
  await click(button('Choose folder'));
  assert.equal((await save()).body.workspacePath, 'E:\\Updated default');
});

test('unavailable native pickers explain the host boundary and expose an explicit manual fallback', async () => {
  await mount((d) => <RoomDialog room={d.rooms[0]} onClose={() => {}} />, fixture(), {
    available: false,
    platform: 'linux',
    reason: 'headless',
  });
  assert.equal(button('Choose folder').disabled, true);
  assert.match(
    document.querySelector('.workspace-picker-unavailable')?.textContent || '',
    /Docker and headless/,
  );
  assert.equal((document.querySelector('.workspace-manual') as HTMLDetailsElement).open, false);
  await click(document.querySelector('.workspace-manual > summary')!);
  const entry = document.querySelector<HTMLInputElement>(
    'input[aria-label="Folder path on the server"]',
  )!;
  await input(entry, '/mounted/projects');
  assert.equal((await save()).body.workspacePath, '/mounted/projects');
  await mount((d) => <RoomDialog room={d.rooms[0]} onClose={() => {}} />, fixture(), {
    available: false,
    platform: 'win32',
    reason: 'remote',
  });
  assert.match(
    document.querySelector('.workspace-picker-unavailable')?.textContent || '',
    /localhost on the computer running it/,
  );
});

test('closing a room dialog aborts a pending native picker and prevents a late selection update', async () => {
  await mount((d) => <RoomDialog room={d.rooms[0]} onClose={() => {}} />);
  let pickerSignal: AbortSignal | null | undefined;
  postPicker = (init) =>
    new Promise((_resolve, reject) => {
      pickerSignal = init.signal;
      init.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    });
  await click(button('Choose folder'));
  assert.equal(button('Save changes').disabled, true);
  assert.ok(pickerSignal);
  await act(async () => {
    root!.unmount();
    root = undefined;
  });
  assert.equal(pickerSignal.aborted, true);
  assert.equal(mutations.length, 0);
});

test('chat and bot editing use corrected avatars and display effective and pinned room folders', async () => {
  const data = fixture();
  data.rooms[0].workspacePath = 'D:\\Room';
  data.tasks = [{ ...task('room_a'), status: 'stopped', workspacePath: 'D:\\Previous root' }];
  await mount((d) => <Chat room={d.rooms[0]} />, data);
  assert.equal(document.querySelector('.room-workspace-link')?.textContent, 'D:\\Room');
  assert.equal(document.querySelector('.room-workspace-link')?.getAttribute('title'), 'D:\\Room');
  assert.equal(document.querySelector('.run-workspace code')?.textContent, 'D:\\Previous root');
  assert.equal(document.querySelectorAll('.avatar-stack svg.avatar-symbol').length, 2);
  assert.ok(
    [...document.querySelectorAll('.avatar-stack .avatar')].every((a) => a.textContent === ''),
  );
  await click(button('Change this room’s workspace'));
  assert.equal(document.querySelector('.workspace-path')?.textContent, 'D:\\Room');
  await mount(() => <TeamPage />);
  assert.equal(document.querySelectorAll('.team-card svg.avatar-symbol').length, 2);
  await click(button('Edit', document.querySelector('.team-card')!));
  assert.ok(document.querySelector('.profile-customization > .avatar svg.lucide-sparkles'));
  await click(button('Avatar Compass'));
  assert.ok(document.querySelector('.profile-customization > .avatar svg.lucide-compass'));
  assert.equal((await save()).body.avatar, 'compass');
});

after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});
