import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { Approval, Snapshot, Task } from '../src/shared/types';

// Test navigation and disclosure with synthetic data. Layout measurements belong in a browser.
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
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
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
Object.defineProperty(dom.window, 'innerWidth', {
  configurable: true,
  writable: true,
  value: 1440,
});
dom.window.HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};
dom.window.HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open');
};
dom.window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number) {
  if (typeof options === 'object') this.scrollTop = options.top ?? 0;
};
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { default: App } = await import('../src/client/App');

const streams = new Set<FakeEventSource>();
class FakeEventSource {
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor() {
    streams.add(this);
    queueMicrotask(() => this.onopen?.());
  }
  close() {
    streams.delete(this);
  }
}
Object.assign(globalThis, { EventSource: FakeEventSource });
const now = '2026-11-04T10:00:00.000Z';
function task(id: string, roomId: string, botId: string, status: Task['status']): Task {
  return {
    id,
    roomId,
    botId,
    status,
    rootTaskId: id,
    depth: 0,
    kind: 'chat',
    prompt: 'Synthetic work',
    output: '',
    inputTokens: 0,
    outputTokens: 0,
    createdAt: now,
    updatedAt: now,
  };
}
function approval(id: string, roomId: string, botId: string): Approval {
  return {
    id,
    roomId,
    botId,
    taskId: `task_${id}`,
    toolName: 'write_file',
    summary: `Write ${id}.txt`,
    target: `/workspace/${id}.txt`,
    args: { path: `${id}.txt`, content: 'Synthetic result' },
    status: 'pending',
    createdAt: now,
  };
}
function fixture(): Snapshot {
  const approvals = [approval('current', 'lounge', 'nova'), approval('other', 'research', 'aster')];
  return {
    version: 'test',
    settings: {
      demoMode: true,
      autoLearn: false,
      maxHandoffs: 6,
      workspacePath: './workspace',
      model: {
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'layout-test',
        apiKeyConfigured: false,
        contextWindow: 32768,
        maxOutputTokens: 4096,
        temperature: 0.7,
      },
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'ask' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: ['Aster', 'Nova'].map((name) => ({
      id: name.toLowerCase(),
      name,
      handle: name.toLowerCase(),
      role: 'Research',
      systemPrompt: 'Synthetic test bot.',
      avatar: 'sparkles',
      color: '#829479',
      enabled: true,
      createdAt: now,
    })),
    rooms: ['Lounge', 'Research'].map((name, index) => ({
      id: name.toLowerCase(),
      name,
      description: `${name} description`,
      botIds: ['aster', 'nova'],
      archived: false,
      pinned: index === 0,
      createdAt: now,
      updatedAt: now,
    })),
    messages: [
      {
        id: 'message_initial',
        roomId: 'lounge',
        authorType: 'user',
        authorId: 'user',
        body: 'The conversation stays mounted.',
        status: 'complete',
        createdAt: now,
      },
    ],
    tasks: [
      task('working', 'lounge', 'aster', 'running'),
      ...approvals.map((item) => task(item.taskId, item.roomId, item.botId, 'awaiting_approval')),
    ],
    activities: [],
    approvals,
    skills: [],
    memories: [],
    automations: [],
    notifications: [
      { id: 'notice', title: 'Synthetic update', body: '', read: false, createdAt: now },
    ],
    queue: { active: 1, waiting: 0, capacity: 1 },
  };
}
let state: Snapshot;
let root: ReturnType<typeof createRoot> | undefined;
const calls: { path: string; method: string }[] = [];
Object.assign(globalThis, {
  fetch: async (url: string, options: RequestInit = {}) => {
    const path = String(url),
      method = options.method ?? 'GET';
    calls.push({ path, method });
    assert.equal(
      method,
      'GET',
      'Changing the layout must not mutate server data or act on approvals.',
    );
    return new Response(
      JSON.stringify(path === '/api/state' ? structuredClone(state) : { ok: true }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  },
});
async function mount(
  options: { width?: number; focus?: boolean; activity?: boolean; preserve?: boolean } = {},
) {
  if (root) await act(async () => root!.unmount());
  state = fixture();
  calls.length = 0;
  if (!options.preserve) {
    localStorage.clear();
    localStorage.setItem('loom.locale', 'en');
    localStorage.setItem('loom.room', 'lounge');
    localStorage.setItem('loom.activity', String(options.activity ?? true));
    if (options.focus !== undefined) localStorage.setItem('loom.chatFocus', String(options.focus));
  }
  dom.window.innerWidth = options.width ?? 1440;
  root = createRoot(document.getElementById('root')!);
  await act(async () => root!.render(<App />));
}
function focusToggle() {
  const button = document.querySelector<HTMLButtonElement>('.chat-focus-toggle');
  assert.ok(button, 'Expected the focus-view control');
  return button;
}
function roomButton(name: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.room-nav-item')].find(
    (item) => item.querySelector('.room-nav-name')?.textContent === name,
  );
  assert.ok(button, `Expected room: ${name}`);
  return button;
}
async function click(element: Element | null) {
  assert.ok(element, 'Expected a clickable element');
  await act(async () => {
    (element as HTMLElement).focus();
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}
async function key(key: string, shiftKey = false) {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
    );
  });
}
async function typeDraft(value: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>('.composer textarea');
  assert.ok(textarea);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  return textarea;
}
async function resize(width: number) {
  await act(async () => {
    dom.window.innerWidth = width;
    window.dispatchEvent(new dom.window.Event('resize'));
  });
}

test('focus view expands the conversation while retaining live work, approval signals, and named room navigation', async () => {
  await mount();
  assert.equal(focusToggle().getAttribute('aria-pressed'), 'true');
  assert.ok(document.querySelector('.sidebar-compact'));
  assert.equal(document.querySelector('.activity-panel'), null);
  assert.equal(
    localStorage.getItem('loom.activity'),
    'true',
    'Focus does not erase the preferred activity layout',
  );
  assert.match(roomButton('Research').getAttribute('aria-label')!, /Research.*approval/);
  assert.equal(
    roomButton('Research').querySelector('.room-approval-count strong')?.textContent,
    '1',
  );
  assert.ok(document.querySelector('[data-room-bot-id="aster"][data-room-task-id="working"]'));
  assert.ok(document.querySelector('[aria-label="Stop Aster\'s task"]'));
  assert.ok(document.querySelector('[aria-label="Review pending approvals"]'));
  assert.ok(document.querySelector('.global-approval-banner'));
  const textarea = await typeDraft('Keep this draft while changing the layout.');
  await click(focusToggle());
  assert.equal(focusToggle().getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector('.sidebar-compact'), null);
  assert.ok(document.querySelector('.activity-panel'));
  assert.equal(document.querySelector('.composer textarea'), textarea);
  assert.equal(textarea.value, 'Keep this draft while changing the layout.');
  await click(focusToggle());
  assert.equal(document.querySelector('.activity-panel'), null);
  assert.equal(document.querySelector('.composer textarea'), textarea);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('activity and the rail restore button deliberately return to the full layout', async () => {
  await mount({ activity: false });
  await click(document.querySelector('[aria-label="Toggle activity"]'));
  assert.equal(focusToggle().getAttribute('aria-pressed'), 'false');
  assert.ok(document.querySelector('.activity-panel'));
  await click(focusToggle());
  await click(document.querySelector('.sidebar-expand'));
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  assert.equal(focusToggle().getAttribute('aria-pressed'), 'false');
  assert.equal(
    document.activeElement,
    focusToggle(),
    'Removing the rail control restores keyboard focus to the layout control',
  );
  assert.ok(document.querySelector('.activity-panel'));
});

test('room changes keep focus view and drafts, with approval targets still reachable from the rail', async () => {
  await mount();
  await typeDraft('Lounge draft');
  await click(roomButton('Research'));
  assert.equal(document.querySelector('.room-header h1')?.textContent, 'Research');
  assert.equal(roomButton('Research').getAttribute('aria-current'), 'page');
  assert.equal(focusToggle().getAttribute('aria-pressed'), 'true');
  assert.equal(localStorage.getItem('loom.room'), 'research');
  await typeDraft('Research draft');
  await click(document.querySelector('.global-approval-banner'));
  assert.equal(document.querySelector('.room-header h1')?.textContent, 'Lounge');
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('.composer textarea')?.value,
    'Lounge draft',
  );
  assert.equal(focusToggle().getAttribute('aria-pressed'), 'true');
  await click(roomButton('Research'));
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('.composer textarea')?.value,
    'Research draft',
  );
});

test('other pages restore full navigation and an explicit layout preference survives reopening', async () => {
  await mount();
  await click(document.querySelector('.main-nav button[aria-label="Bots"]'));
  assert.ok(document.querySelector('.view-team'));
  assert.equal(document.querySelector('.sidebar-compact'), null);
  assert.equal(document.querySelector('.chat-focus-toggle'), null);
  assert.equal(localStorage.getItem('loom.chatFocus'), 'true');
  await click(roomButton('Lounge'));
  assert.equal(focusToggle().getAttribute('aria-pressed'), 'true');
  await click(focusToggle());
  assert.equal(localStorage.getItem('loom.chatFocus'), 'false');
  await mount({ preserve: true });
  assert.equal(focusToggle().getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector('.sidebar-compact'), null);
});

test('small-screen navigation traps focus, closes with Escape, and restores the desktop preference on resize', async () => {
  await mount({ width: 390 });
  const navigation = document.getElementById('loom-navigation')!;
  const workspace = document.querySelector('.workspace-main')!;
  const menu = document.querySelector<HTMLButtonElement>('[aria-label="Open menu"]')!;
  assert.equal(document.querySelector('.chat-focus-toggle'), null);
  assert.equal(navigation.getAttribute('aria-hidden'), 'true');
  assert.ok(navigation.hasAttribute('inert'));
  const textarea = await typeDraft('Draft through responsive changes');
  await click(menu);
  assert.equal(navigation.getAttribute('role'), 'dialog');
  assert.equal(navigation.getAttribute('aria-modal'), 'true');
  assert.ok(workspace.hasAttribute('inert'));
  const close = navigation.querySelector<HTMLButtonElement>('[aria-label="Close menu"]')!;
  const last = [...navigation.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].at(-1)!;
  assert.equal(document.activeElement, close);
  await key('Tab', true);
  assert.equal(document.activeElement, last);
  await key('Tab');
  assert.equal(document.activeElement, close);
  await key('Escape');
  assert.equal(document.querySelector('.sidebar-open'), null);
  assert.equal(document.activeElement, menu);
  assert.ok(!workspace.hasAttribute('inert'));
  await click(menu);
  await resize(1440);
  assert.equal(document.querySelector('.sidebar-open'), null);
  assert.ok(!navigation.hasAttribute('inert'));
  assert.ok(!workspace.hasAttribute('inert'));
  assert.equal(focusToggle().getAttribute('aria-pressed'), 'true');
  assert.equal(document.activeElement, focusToggle());
  assert.equal(document.querySelector('.composer textarea'), textarea);
  assert.equal(textarea.value, 'Draft through responsive changes');
  await resize(390);
  assert.ok(navigation.hasAttribute('inert'));
  await click(document.querySelector('[aria-label="Toggle activity"]'));
  assert.ok(document.querySelector('.activity-panel'));
  assert.equal(
    localStorage.getItem('loom.chatFocus'),
    'true',
    'Opening a mobile drawer does not change the desktop preference',
  );
});

after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});
