import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Bot, BrowserStatus, Room, Snapshot } from '../src/shared/types';
import { botBrowserMode, DEFAULT_BROWSER_SETTINGS } from '../src/shared/browser';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3210',
  pretendToBeVisual: true,
});
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Event',
  'MouseEvent',
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: (dom.window as unknown as Record<string, unknown>)[name],
  });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const React = await import('react');
const { act, useState } = React;
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { AppContext } = await import('../src/client/context');
const { BotBrowserSettings } = await import('../src/client/BotBrowserSettings');
let root: ReturnType<typeof createRoot> | undefined;
let data: Snapshot;
let context: AppContextValue;
let initialBot: Bot | undefined;
let status: BrowserStatus;
let failSave = false;
let flushSave = false;
let post: ((signal?: AbortSignal | null) => Promise<Response>) | undefined;
let remove: ((signal?: AbortSignal | null) => Promise<Response>) | undefined;
let read: ((path: string, signal?: AbortSignal | null) => Promise<Response>) | undefined;
const actions: Array<{
  path: string;
  method: string;
  body?: unknown;
  signal?: AbortSignal | null;
}> = [];

function Harness() {
  const [mode, setMode] = useState(initialBot ? botBrowserMode(initialBot) : 'dedicated');
  return (
    <AppContext.Provider value={{ ...context, data }}>
      <BotBrowserSettings bot={initialBot} mode={mode} onChange={setMode} />
    </AppContext.Provider>
  );
}
function render() {
  root!.render(<Harness />);
}
async function mount(
  options: {
    fresh?: boolean;
    enabled?: boolean;
    active?: boolean;
    savedMode?: 'disabled' | 'dedicated' | 'shared';
    noRooms?: boolean;
    secondRoom?: boolean;
    currentRoomId?: string;
  } = {},
) {
  if (root) await act(async () => root!.unmount());
  initialBot = options.fresh
    ? undefined
    : {
        id: 'bot_legacy',
        name: 'Legacy',
        handle: 'legacy',
        role: 'Research',
        systemPrompt: 'Research',
        avatar: 'character:aster',
        color: '#123456',
        enabled: true,
        createdAt: '2026-01-01',
        ...(options.savedMode ? { browser: { mode: options.savedMode } } : {}),
      };
  data = {
    settings: { browser: { ...DEFAULT_BROWSER_SETTINGS, enabled: options.enabled ?? true } },
    bots: initialBot ? [initialBot] : [],
    rooms: options.noRooms
      ? []
      : (options.secondRoom ? ['a', 'b'] : ['a']).map(
          (suffix) =>
            ({
              id: 'room-' + suffix,
              name: 'Loom ' + suffix.toUpperCase(),
              botIds: initialBot ? [initialBot.id] : [],
            }) as Room,
        ),
    tasks: options.active ? [{ id: 't', botId: initialBot!.id, status: 'running' }] : [],
  } as Snapshot;
  status = {
    state: 'disconnected',
    mode: 'existing',
    platform: 'win32',
    busy: false,
    tabs: [],
    botMode: options.savedMode ?? 'dedicated',
    pool: { active: 0, limit: 3, waiting: 0 },
  };
  failSave = false;
  flushSave = false;
  post = undefined;
  remove = undefined;
  read = undefined;
  actions.length = 0;
  context = {
    data,
    locale: 'en',
    t: (_ja, en) => en,
    roomId: options.currentRoomId ?? '',
    view: 'team',
    navigate() {},
    toast() {},
    async refresh() {},
    async signOut() {},
    async mutate<T>(path: string, method = 'POST', body?: unknown) {
      actions.push({ path: '/api' + path, method, body });
      if (failSave) throw new Error('Save refused');
      data = { ...data, bots: data.bots.map((bot) => ({ ...bot, ...(body as object) })) };
      if (flushSave) flushSync(render);
      else render();
      return data.bots[0] as T;
    },
  };
  Object.assign(globalThis, {
    fetch: async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      actions.push({ path, method, signal: init.signal });
      assert.match(path, /^\/api\/rooms\/room-[ab]\/bots\/bot_legacy\/browser(?:\/connect)?$/);
      if (method === 'POST') {
        if (post) return post(init.signal);
        status = {
          ...status,
          state: 'connected',
          mode: botBrowserMode(data.bots[0]) === 'dedicated' ? 'dedicated' : 'existing',
          botMode: botBrowserMode(data.bots[0]),
        };
      } else if (method === 'DELETE') {
        if (remove) return remove(init.signal);
        status = { ...status, state: 'disconnected', waiting: false };
      } else if (read) return read(path, init.signal);
      return Response.json(status);
    },
  });
  root = createRoot(document.getElementById('root')!);
  await act(async () => render());
}
function button(label: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === label,
  );
  assert.ok(element, 'Missing button ' + label);
  return element;
}
function select() {
  return document.querySelector<HTMLSelectElement>('select[aria-label="Browser for this bot"]')!;
}
async function choose(value: string) {
  await act(async () => {
    select().value = value;
    select().dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function roomSelect() {
  return document.querySelector<HTMLSelectElement>('select[aria-label="Loom for this Chrome"]')!;
}
async function chooseRoom(value: string) {
  await act(async () => {
    roomSelect().value = value;
    roomSelect().dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function click(label: string) {
  await act(async () => button(label).click());
}

test('bot browser UI defaults to room-specific Chrome and never connects on mount', async () => {
  await mount();
  assert.equal(select().value, 'dedicated');
  assert.deepEqual(
    [...select().options].map((option) => option.value),
    ['dedicated', 'shared', 'disabled'],
  );
  assert.equal(actions.filter((action) => action.method === 'POST').length, 0);
  assert.equal(roomSelect().value, 'room-a');
  assert.ok(actions.every((action) => action.path.includes('/rooms/room-a/')));
  assert.match(document.body.textContent!, /This bot uses a different Chrome in each Loom/);
  await mount({ savedMode: 'shared' });
  assert.equal(select().value, 'shared');
  assert.match(document.body.textContent!, /across all Looms; disconnect affects all of them/);
  await mount({ fresh: true });
  assert.equal(select().value, 'dedicated');
  assert.equal(actions.length, 0);
  assert.match(document.body.textContent!, /Save the bot and add it to a Loom/);
});

test('opening a changed browser saves the bot binding before connecting and failed saves never open Chrome', async () => {
  await mount({ savedMode: 'shared' });
  await choose('dedicated');
  await click('Save browser setting and open');
  const mutations = actions.filter((action) => action.method !== 'GET');
  assert.deepEqual(
    mutations.map(({ path, method }) => ({ path, method })),
    [
      { path: '/api/bots/bot_legacy', method: 'PATCH' },
      { path: '/api/rooms/room-a/bots/bot_legacy/browser/connect', method: 'POST' },
    ],
  );
  assert.deepEqual(mutations[0].body, { browser: { mode: 'dedicated' } });
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Connected/);
  await mount({ savedMode: 'shared' });
  failSave = true;
  await choose('dedicated');
  await click('Save browser setting and open');
  assert.equal(actions.filter((action) => action.method === 'POST').length, 0);
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /Save refused/);
});

test('active tasks lock binding changes; global disable and per-bot disable prevent manual connection', async () => {
  await mount({ active: true });
  assert.equal(select().disabled, true);
  await mount({ enabled: false });
  assert.equal(actions.length, 0, 'Disabled Chrome does not poll when an editor opens');
  assert.equal(button('Open / connect Chrome').disabled, true);
  assert.match(document.body.textContent!, /Enable Chrome control/);
  await mount();
  await choose('disabled');
  assert.equal(button('Save browser setting and open').disabled, true);
  assert.match(document.body.textContent!, /Chrome tools are unavailable/);
});

test('saving a disabled bot as dedicated restarts observation without cancelling its save-and-connect action', async () => {
  await mount({ savedMode: 'disabled' });
  assert.equal(actions.length, 0);
  flushSave = true;
  await choose('dedicated');
  await click('Save browser setting and open');
  assert.deepEqual(
    actions.filter((action) => action.method !== 'GET').map((action) => action.method),
    ['PATCH', 'POST'],
  );
  assert.equal(actions.find((action) => action.method === 'POST')!.signal!.aborted, false);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Connected/);
  assert.doesNotMatch(document.body.textContent!, /Connecting…/);
  assert.equal(button('Disconnect').disabled, false);
});

test('capacity waiting is visible and disconnect cancels a pending open without accepting a late result', async () => {
  await mount();
  let complete!: (value: Response) => void;
  post = async () =>
    new Promise<Response>((resolve) => {
      complete = resolve;
    });
  await click('Open / connect Chrome');
  status = { ...status, waiting: true, pool: { active: 3, limit: 3, waiting: 1 } };
  await click('Refresh status');
  assert.match(
    document.querySelector('[role="status"]')!.textContent!,
    /Waiting for browser capacity/,
  );
  assert.match(document.body.textContent!, /3 \/ 3 slots · 1 waiting/);
  const connectSignal = actions.find((action) => action.method === 'POST')!.signal!;
  await click('Disconnect');
  assert.equal(connectSignal.aborted, true);
  await act(async () => complete(Response.json({ ...status, state: 'connected', waiting: false })));
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Disconnected/);
  const readSignal = actions.find((action) => action.method === 'GET')!.signal!;
  await act(async () => root!.unmount());
  root = undefined;
  assert.equal(readSignal.aborted, true);
});

test('the current member Loom is selected and bots without membership cannot open or observe Chrome', async () => {
  await mount({ secondRoom: true, currentRoomId: 'room-b' });
  assert.equal(roomSelect().value, 'room-b');
  assert.deepEqual(
    [...roomSelect().options].map((option) => option.textContent),
    ['Loom A', 'Loom B'],
  );
  await click('Open / connect Chrome');
  assert.equal(
    actions.find((action) => action.method === 'POST')!.path,
    '/api/rooms/room-b/bots/bot_legacy/browser/connect',
  );

  await mount({ noRooms: true });
  assert.equal(roomSelect().disabled, true);
  assert.equal(button('Open / connect Chrome').disabled, true);
  assert.equal(button('Refresh status').disabled, true);
  assert.equal(actions.length, 0);
  assert.match(document.body.textContent!, /Add this bot to a Loom before opening Chrome/);
});

test('changing Loom cancels its pending connection and ignores a late connection result', async () => {
  await mount({ secondRoom: true });
  let complete!: (value: Response) => void;
  post = async () => new Promise<Response>((resolve) => (complete = resolve));
  await click('Open / connect Chrome');
  const request = actions.find((action) => action.method === 'POST')!;
  assert.equal(request.signal!.aborted, false);
  await chooseRoom('room-b');
  assert.equal(request.signal!.aborted, true);
  assert.equal(actions.filter((action) => action.method === 'POST').length, 1);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Disconnected/);
  await act(async () =>
    complete(
      Response.json({
        ...status,
        state: 'connected',
        tabs: [{ pageId: 1, title: 'Loom A private tab', url: 'https://example.com/a' }],
      }),
    ),
  );
  assert.doesNotMatch(document.body.textContent!, /Loom A private tab/);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Disconnected/);
  post = undefined;
  await click('Open / connect Chrome');
  assert.equal(
    actions.filter((action) => action.method === 'POST').at(-1)!.path,
    '/api/rooms/room-b/bots/bot_legacy/browser/connect',
  );
});

test('changing Loom clears old tabs immediately and ignores an old status response', async () => {
  await mount({ secondRoom: true });
  status = {
    ...status,
    state: 'connected',
    tabs: [{ pageId: 1, title: 'Loom A private tab', url: 'https://example.com/a' }],
  };
  await click('Refresh status');
  assert.match(document.body.textContent!, /Loom A private tab/);
  const oldStatus = status;
  let complete!: (value: Response) => void;
  read = async (path) =>
    path.includes('/room-a/')
      ? new Promise<Response>((resolve) => (complete = resolve))
      : Response.json({ ...status, state: 'disconnected', tabs: [] });
  await click('Refresh status');
  const pendingRead = actions.at(-1)!;
  await chooseRoom('room-b');
  assert.equal(pendingRead.signal!.aborted, true);
  assert.doesNotMatch(document.body.textContent!, /Loom A private tab/);
  await act(async () => complete(Response.json(oldStatus)));
  assert.doesNotMatch(document.body.textContent!, /Loom A private tab/);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Disconnected/);

  await act(async () => {
    data = { ...data, rooms: [] };
    render();
  });
  assert.equal(roomSelect().disabled, true);
  assert.equal(button('Open / connect Chrome').disabled, true);
  assert.doesNotMatch(document.body.textContent!, /Loom A private tab/);
});

test('a status read started during connect cannot overwrite the completed connection', async () => {
  await mount();
  let completeConnect!: (value: Response) => void;
  let completeRead!: (value: Response) => void;
  post = async () => new Promise<Response>((resolve) => (completeConnect = resolve));
  read = async () => new Promise<Response>((resolve) => (completeRead = resolve));
  await click('Open / connect Chrome');
  await click('Refresh status');
  await act(async () =>
    completeConnect(
      Response.json({
        ...status,
        state: 'connected',
        tabs: [{ pageId: 1, title: 'Current Chrome tab', url: 'https://example.com/current' }],
      }),
    ),
  );
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Connected/);
  assert.equal(select().disabled, false, 'the completed connection releases the action lock');
  assert.equal(button('Disconnect').disabled, false);
  await act(async () =>
    completeRead(
      Response.json({
        ...status,
        state: 'disconnected',
        tabs: [{ pageId: 1, title: 'Stale Chrome tab', url: 'https://example.com/stale' }],
      }),
    ),
  );
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Connected/);
  assert.match(document.body.textContent!, /Current Chrome tab/);
  assert.doesNotMatch(document.body.textContent!, /Stale Chrome tab/);
});

test('a status read started during disconnect cannot restore the closed Chrome or its tabs', async () => {
  await mount();
  await click('Open / connect Chrome');
  let completeDisconnect!: (value: Response) => void;
  let completeRead!: (value: Response) => void;
  remove = async () => new Promise<Response>((resolve) => (completeDisconnect = resolve));
  read = async () => new Promise<Response>((resolve) => (completeRead = resolve));
  await click('Disconnect');
  await click('Refresh status');
  await act(async () =>
    completeDisconnect(Response.json({ ...status, state: 'disconnected', tabs: [] })),
  );
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Disconnected/);
  assert.equal(select().disabled, false, 'the completed disconnect releases the action lock');
  assert.equal(button('Open / connect Chrome').disabled, false);
  await act(async () =>
    completeRead(
      Response.json({
        ...status,
        state: 'connected',
        tabs: [{ pageId: 1, title: 'Stale Chrome tab', url: 'https://example.com/stale' }],
      }),
    ),
  );
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Disconnected/);
  assert.doesNotMatch(document.body.textContent!, /Stale Chrome tab/);
  assert.equal(button('Open / connect Chrome').disabled, false);
});

after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});
