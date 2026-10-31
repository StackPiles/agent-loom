import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { BrowserStatus, Snapshot, Task } from '../src/shared/types';
import { DEFAULT_BROWSER_SETTINGS } from '../src/shared/browser';

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
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('../src/client/context');
const { SettingsPage } = await import('../src/client/SettingsPage');

function fixture(): Snapshot {
  return {
    version: 'test',
    settings: {
      model: {
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'local-text-model',
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
    bots: [],
    rooms: [],
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
const disconnected = (): BrowserStatus => ({
  state: 'disconnected',
  mode: 'existing',
  platform: 'win32',
  busy: false,
  tabs: [],
});
const connected = (): BrowserStatus => ({
  ...disconnected(),
  state: 'connected',
  tabs: [
    { pageId: 1, title: 'Agent Loom', url: 'http://localhost:3210', protected: true },
    {
      pageId: 2,
      title: 'Research ' + 'long '.repeat(100),
      url: 'https://example.com/' + 'long-path/'.repeat(100),
    },
    { pageId: 3, title: 'Docs', url: 'https://example.org/docs' },
    { pageId: 4, title: 'Another tab', url: 'https://example.net' },
  ],
});
let root: ReturnType<typeof createRoot> | undefined;
let state: Snapshot;
let context: AppContextValue;
let browserStatus = disconnected();
let read: ((init: RequestInit) => Promise<BrowserStatus>) | undefined;
let post: ((init: RequestInit) => Promise<Response>) | undefined;
let mutation: ((body: any) => Promise<void>) | undefined;
const requests: { path: string; method: string; body?: any; signal?: AbortSignal | null }[] = [];
const mutations: { path: string; method?: string; body?: any }[] = [];
let strict = false;

function render() {
  context = { ...context, data: state };
  const view = (
    <AppContext.Provider value={context}>
      <SettingsPage />
    </AppContext.Provider>
  );
  root!.render(strict ? <React.StrictMode>{view}</React.StrictMode> : view);
}
Object.assign(globalThis, {
  fetch: async (path: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    requests.push({
      path,
      method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      signal: init.signal,
    });
    if (path === '/api/auth') return Response.json({ required: false });
    if (path === '/api/workspace-picker')
      return Response.json({ available: false, platform: 'win32', reason: 'disabled' });
    if (path === '/api/browser') return Response.json(read ? await read(init) : browserStatus);
    assert.equal(path, '/api/browser/connect');
    if (method === 'POST') {
      if (post) return post(init);
      browserStatus = connected();
      browserStatus.mode = state.settings.browser?.mode ?? 'existing';
    } else {
      assert.equal(method, 'DELETE');
      browserStatus = disconnected();
    }
    return Response.json(browserStatus);
  },
});
async function mount(data = fixture(), strictMode = false) {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  state = data;
  browserStatus = disconnected();
  read = undefined;
  post = undefined;
  mutation = undefined;
  requests.length = 0;
  mutations.length = 0;
  strict = strictMode;
  localStorage.clear();
  context = {
    data,
    locale: 'en',
    t: (_ja, en) => en,
    view: 'settings',
    roomId: '',
    navigate() {},
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string, method?: string, body?: any) {
      mutations.push({ path, method, body });
      if (mutation) await mutation(body);
      state = { ...state, settings: { ...state.settings, ...body } };
      render();
      return state.settings as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await act(async () => render());
}
function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === label || node.getAttribute('aria-label') === label,
  );
  assert.ok(result, 'Missing button: ' + label);
  return result;
}
function toggle(label: string) {
  const row = [...document.querySelectorAll('label.toggle-row')].find(
    (node) => node.querySelector('strong')?.textContent === label,
  );
  const result = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(result, 'Missing toggle: ' + label);
  return result;
}
function select(label: string) {
  const result = document.querySelector<HTMLSelectElement>('select[aria-label="' + label + '"]');
  assert.ok(result, 'Missing select: ' + label);
  return result;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function save() {
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}

test('Chrome is opt-in, enabling only reads status, and ordinary settings save persists its draft', async () => {
  await mount();
  assert.equal(toggle('Enable Chrome control').checked, false);
  assert.equal(
    requests.some((request) => request.path.startsWith('/api/browser')),
    false,
  );
  await click(toggle('Enable Chrome control'));
  assert.equal(requests.filter((request) => request.path === '/api/browser').length, 1);
  assert.equal(
    requests.some((request) => request.method !== 'GET'),
    false,
  );
  assert.equal(select('Chrome connection mode').value, 'existing');
  assert.match(
    document.getElementById('browser-settings')!.textContent!,
    /chrome:\/\/inspect\/#remote-debugging/,
  );
  assert.equal(toggle('Send screenshots to the model').checked, false);
  await choose(select('Browser permission'), 'ask');
  await click(toggle('Send screenshots to the model'));
  await save();
  assert.deepEqual(mutations.at(-1)!.body.browser, {
    ...DEFAULT_BROWSER_SETTINGS,
    enabled: true,
    permission: 'ask',
    includeScreenshotsInModel: true,
  });
  assert.equal(
    requests.some((request) => request.method === 'POST'),
    false,
  );
});

test('Save and connect persists only Chrome fields while retaining unrelated unsaved model edits', async () => {
  await mount();
  await input(
    document.querySelector<HTMLInputElement>('input[list="model-ids"]')!,
    'edited-but-unsaved-model',
  );
  await click(toggle('Enable Chrome control'));
  await choose(select('Chrome connection mode'), 'dedicated');
  await click(button('Save and connect'));
  assert.deepEqual(mutations[0].body, {
    browser: { ...DEFAULT_BROWSER_SETTINGS, enabled: true, mode: 'dedicated' },
  });
  assert.equal(
    requests.filter(
      (request) => request.path === '/api/browser/connect' && request.method === 'POST',
    ).length,
    1,
  );
  assert.equal(state.settings.model.modelId, 'local-text-model');
  assert.equal(
    document.querySelector<HTMLInputElement>('input[list="model-ids"]')!.value,
    'edited-but-unsaved-model',
  );
  assert.equal(button('Save changes').disabled, false);
  assert.equal(select('Chrome connection mode').disabled, true);
  assert.match(document.getElementById('browser-settings')!.textContent!, /Connected/);
  assert.equal(document.querySelectorAll('.chrome-tab-summary li').length, 3);
  assert.match(document.querySelector('.chrome-tab-summary')!.textContent!, /Protected.*1 more/s);
  assert.equal(
    document.querySelector('.chrome-tab-summary a'),
    null,
    'A tab summary must not navigate or operate Chrome',
  );
  await save();
  assert.equal(mutations.at(-1)!.body.model.modelId, 'edited-but-unsaved-model');
  assert.equal(
    'browser' in mutations.at(-1)!.body,
    false,
    'The already saved browser section is not sent again',
  );
});

test('Chrome-only Save and connect clears only its pending changes; disconnect unlocks mode', async () => {
  await mount();
  await click(toggle('Enable Chrome control'));
  assert.equal(button('Save changes').disabled, false);
  await click(button('Save and connect'));
  assert.equal(button('Save changes').disabled, true);
  assert.equal(button('Save and connect').disabled, true);
  const before = requests.filter((request) => request.method === 'POST').length;
  await click(button('Refresh status'));
  assert.equal(requests.filter((request) => request.method === 'POST').length, before);
  await click(button('Disconnect'));
  assert.equal(select('Chrome connection mode').disabled, false);
  assert.equal(button('Save and connect').disabled, false);
  assert.match(document.getElementById('browser-settings')!.textContent!, /Disconnected/);
  assert.equal(requests.filter((request) => request.method === 'DELETE').length, 1);
});

test('connection errors are visible, retry is explicit, and Deny does not launch Chrome', async () => {
  const data = fixture();
  data.settings.browser = { ...DEFAULT_BROWSER_SETTINGS, enabled: true };
  await mount(data);
  post = async () =>
    Response.json({ error: 'Chrome permission was not granted.' }, { status: 409 });
  await click(button('Save and connect'));
  assert.match(
    document.querySelector('#browser-settings [role="alert"]')!.textContent!,
    /Chrome permission was not granted/,
  );
  assert.equal(button('Save and connect').disabled, false);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  await choose(select('Browser permission'), 'deny');
  assert.equal(button('Save and connect').disabled, true);
  await click(button('Save and connect'));
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  await save();
  assert.equal(mutations.at(-1)!.body.browser.permission, 'deny');
});

test('Disconnect cancels a pending connection and a late connect result cannot revive it', async () => {
  const data = fixture();
  data.settings.browser = { ...DEFAULT_BROWSER_SETTINGS, enabled: true };
  await mount(data);
  let finish!: (response: Response) => void;
  post = async () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await click(button('Save and connect'));
  await click(button('Save and connect'));
  const request = requests.find(
    (item) => item.path === '/api/browser/connect' && item.method === 'POST',
  )!;
  assert.ok(request.signal);
  assert.equal(requests.filter((item) => item.method === 'POST').length, 1);
  assert.match(document.getElementById('browser-settings')!.textContent!, /Connecting/);
  await click(button('Disconnect'));
  assert.equal(request.signal.aborted, true);
  await act(async () => finish(Response.json(connected())));
  assert.match(document.querySelector('.chrome-connection-state')!.textContent!, /^Disconnected$/);
  assert.equal(document.querySelector('.chrome-tab-summary'), null);
});

test('active tasks lock mode and model image capability but permit permission changes and disabling', async () => {
  const data = fixture();
  data.settings.browser = { ...DEFAULT_BROWSER_SETTINGS, enabled: true };
  data.tasks = [{ id: 'task', botId: 'bot', roomId: 'room', status: 'running' } as Task];
  await mount(data);
  assert.equal(select('Chrome connection mode').disabled, true);
  assert.equal(toggle('Send screenshots to the model').disabled, true);
  assert.equal(select('Browser permission').disabled, false);
  assert.equal(toggle('Enable Chrome control').disabled, false);
  await click(toggle('Enable Chrome control'));
  await save();
  assert.equal(mutations.at(-1)!.body.browser.enabled, false);
});

test('unmount aborts status observers without implicitly disconnecting the user browser', async () => {
  const data = fixture();
  data.settings.browser = { ...DEFAULT_BROWSER_SETTINGS, enabled: true };
  await mount(data, true);
  read = async () => new Promise(() => {});
  await click(button('Refresh status'));
  const request = requests.filter((item) => item.path === '/api/browser').at(-1)!;
  assert.ok(request.signal);
  await act(async () => {
    root!.unmount();
    root = undefined;
  });
  assert.equal(request.signal.aborted, true);
  assert.equal(
    requests.some((item) => item.method === 'DELETE'),
    false,
  );
});

after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});
