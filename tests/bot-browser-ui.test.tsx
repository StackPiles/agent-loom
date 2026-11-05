import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Bot, BrowserStatus, Snapshot } from '../src/shared/types';
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
    savedMode?: 'disabled' | 'dedicated';
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
    tasks: options.active ? [{ id: 't', botId: initialBot!.id, status: 'running' }] : [],
  } as Snapshot;
  status = {
    state: 'disconnected',
    mode: 'existing',
    platform: 'win32',
    busy: false,
    tabs: [],
    botMode: 'shared',
    pool: { active: 0, limit: 3, waiting: 0 },
  };
  failSave = false;
  flushSave = false;
  post = undefined;
  actions.length = 0;
  context = {
    data,
    locale: 'en',
    t: (_ja, en) => en,
    roomId: '',
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
      assert.ok(path.startsWith('/api/bots/bot_legacy/browser'));
      if (method === 'POST') {
        if (post) return post(init.signal);
        status = {
          ...status,
          state: 'connected',
          mode: data.bots[0].browser?.mode === 'dedicated' ? 'dedicated' : 'existing',
          botMode: data.bots[0].browser?.mode ?? 'shared',
        };
      } else if (method === 'DELETE') status = { ...status, state: 'disconnected', waiting: false };
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
async function click(label: string) {
  await act(async () => button(label).click());
}

test('bot browser UI preserves legacy sharing and never connects on mount; new bots show dedicated mode', async () => {
  await mount();
  assert.equal(select().value, 'shared');
  assert.deepEqual(
    [...select().options].map((option) => option.value),
    ['dedicated', 'shared', 'disabled'],
  );
  assert.equal(actions.filter((action) => action.method === 'POST').length, 0);
  assert.match(document.body.textContent!, /disconnect affects all of them/);
  await mount({ fresh: true });
  assert.equal(select().value, 'dedicated');
  assert.equal(actions.length, 0);
  assert.match(document.body.textContent!, /Save the bot, then open its Chrome to sign in/);
});

test('opening a changed browser saves the bot binding before connecting and failed saves never open Chrome', async () => {
  await mount();
  await choose('dedicated');
  await click('Save browser setting and open');
  const mutations = actions.filter((action) => action.method !== 'GET');
  assert.deepEqual(
    mutations.map(({ path, method }) => ({ path, method })),
    [
      { path: '/api/bots/bot_legacy', method: 'PATCH' },
      { path: '/api/bots/bot_legacy/browser/connect', method: 'POST' },
    ],
  );
  assert.deepEqual(mutations[0].body, { browser: { mode: 'dedicated' } });
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Connected/);
  await mount();
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

after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});
