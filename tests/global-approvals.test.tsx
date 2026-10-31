import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { Approval, Snapshot, Task } from '../src/shared/types';

// These tests exercise navigation and live state; they do not verify browser pixels.
const dom = new JSDOM(
  '<!doctype html><html><head><title>Agent Loom</title></head><body><div id="root"></div></body></html>',
  {
    url: 'http://localhost:3210',
    pretendToBeVisual: true,
  },
);
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
Object.defineProperty(dom.window, 'innerWidth', { value: 1440, writable: true });
dom.window.HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};
dom.window.HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open');
};
dom.window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number) {
  if (typeof options === 'object') this.scrollTop = options.top || 0;
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
let root: ReturnType<typeof createRoot> | undefined;
let state: Snapshot;
const calls: Array<{ path: string; method: string }> = [];
const now = '2026-11-01T10:00:00.000Z';
const originalTitle = 'Agent Loom · Test workspace';
function fixture(): Snapshot {
  return {
    version: '0.1.8',
    settings: {
      demoMode: true,
      autoLearn: false,
      maxHandoffs: 3,
      workspacePath: './workspace',
      model: {
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'local-test',
        apiKeyConfigured: false,
        contextWindow: 32768,
        maxOutputTokens: 4096,
        temperature: 0.7,
      },
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'ask' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: ['Aster', 'Nova', 'Moss'].map((name) => ({
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
    rooms: ['Lounge', 'Research', 'Design'].map((name, index) => ({
      id: name.toLowerCase(),
      name,
      description: '',
      botIds: ['aster', 'nova', 'moss'],
      archived: false,
      pinned: index === 0,
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
function approval(id: string, roomId: string, botId: string, createdAt = now): Approval {
  return {
    id,
    roomId,
    botId,
    taskId: 'task_' + id,
    toolName: 'write_file',
    summary: `Write ${id}.txt`,
    target: `/workspace/${id}.txt`,
    args: { path: `${id}.txt`, content: 'Synthetic result' },
    status: 'pending',
    createdAt,
  };
}
function addApproval(next: Snapshot, item: Approval) {
  next.approvals.push(item);
  next.tasks.push(task(item.taskId, item.roomId, item.botId, 'awaiting_approval'));
}
Object.assign(globalThis, {
  fetch: async (url: string, options: RequestInit = {}) => {
    const path = String(url);
    const method = options.method || 'GET';
    calls.push({ path, method });
    assert.equal(method, 'GET', 'Global visibility/navigation must not approve or mutate work.');
    const result = path === '/api/state' ? structuredClone(state) : { ok: true };
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
});
async function mount(next: Snapshot, locale: 'ja' | 'en' = 'en', width = 1440) {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  state = next;
  calls.length = 0;
  localStorage.clear();
  localStorage.setItem('loom.locale', locale);
  localStorage.setItem('loom.activity', 'false');
  localStorage.setItem('loom.room', 'lounge');
  document.title = originalTitle;
  dom.window.innerWidth = width;
  root = createRoot(document.getElementById('root')!);
  await act(async () => root!.render(<App />));
}
async function click(element: Element | null) {
  assert.ok(element, 'Expected a clickable element');
  await act(async () =>
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })),
  );
}
function roomButton(name: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('.room-nav-item')].find(
    (button) => button.querySelector('.room-nav-name')?.textContent === name,
  );
}
function navButton(name: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('.main-nav button')].find(
    (button) => button.textContent?.trim() === name,
  );
}
async function snapshot(next: Snapshot) {
  state = next;
  await act(async () => {
    for (const stream of streams)
      stream.onmessage?.({ data: JSON.stringify({ id: 'fixture', type: 'snapshot', data: next }) });
  });
}
after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});

test('room approval counts remain visible while a different bot generates without duplicating the current-room banner', async () => {
  const next = fixture();
  addApproval(next, approval('older', 'lounge', 'aster'));
  addApproval(next, approval('second', 'lounge', 'nova'));
  next.tasks.push(task('working', 'lounge', 'moss', 'running'));
  await mount(next);
  const button = roomButton('Lounge');
  assert.ok(button);
  assert.equal(button.dataset.pendingApprovals, '2');
  assert.match(button.getAttribute('aria-label')!, /Lounge.*2 approvals pending/);
  assert.match(button.querySelector('.room-approval-count')!.textContent!, /Review2/);
  assert.equal(button.querySelector('.nav-dot'), null);
  assert.equal(document.querySelector('.global-approval-banner'), null);
  assert.equal(document.title, '2 approvals pending · Agent Loom');
});

test('other-room approval banner identifies and opens the oldest pending room and bot', async () => {
  const next = fixture();
  addApproval(next, approval('current', 'lounge', 'aster', '2026-11-01T09:00:00.000Z'));
  addApproval(next, approval('newer', 'research', 'nova', '2026-11-01T11:00:00.000Z'));
  addApproval(next, approval('oldest', 'design', 'moss', '2026-11-01T10:00:00.000Z'));
  await mount(next);
  const banner = document.querySelector<HTMLButtonElement>('.global-approval-banner');
  assert.ok(banner);
  assert.equal(banner.dataset.approvalId, 'oldest');
  assert.match(banner.textContent!, /2 approvals in other rooms/);
  assert.match(banner.textContent!, /Design.*Moss/);
  assert.match(banner.getAttribute('aria-label')!, /Moss in Design/);
  await click(banner);
  assert.equal(document.querySelector('.room-header h1')?.textContent, 'Design');
  assert.equal(localStorage.getItem('loom.room'), 'design');
  assert.equal(document.title, '3 approvals pending · Agent Loom');
  assert.equal(
    calls.some((call) => call.path.startsWith('/api/approvals/')),
    false,
  );
});

test('non-chat screens show every pending approval and stable ID order resolves equal timestamps', async () => {
  const next = fixture();
  addApproval(next, approval('z_request', 'design', 'moss'));
  addApproval(next, approval('a_request', 'lounge', 'aster'));
  await mount(next);
  await click(navButton('Bots')!);
  const banner = document.querySelector<HTMLButtonElement>('.global-approval-banner');
  assert.ok(banner);
  assert.equal(banner.dataset.approvalId, 'a_request');
  assert.match(banner.textContent!, /2 approvals pending/);
  assert.match(banner.textContent!, /Lounge.*Aster/);
  await click(banner);
  assert.equal(document.querySelector('.room-header h1')?.textContent, 'Lounge');
});

test('streamed approval resolution clears attention without hiding unrelated running work and unmount restores the title', async () => {
  const next = fixture();
  addApproval(next, approval('review', 'research', 'nova'));
  next.tasks.push(task('working', 'research', 'moss', 'running'));
  await mount(next);
  assert.equal(document.title, '1 approval pending · Agent Loom');
  const updated = structuredClone(next);
  updated.approvals[0].status = 'approved';
  updated.tasks[0].status = 'completed';
  await snapshot(updated);
  assert.equal(document.querySelector('.global-approval-banner'), null);
  assert.equal(document.querySelector('.room-approval-count'), null);
  assert.ok(roomButton('Research')?.querySelector('.nav-dot'));
  assert.equal(document.title, originalTitle);
  updated.approvals[0].status = 'pending';
  updated.tasks[0].status = 'awaiting_approval';
  await snapshot(updated);
  assert.equal(document.title, '1 approval pending · Agent Loom');
  await act(async () => root!.unmount());
  root = undefined;
  assert.equal(document.title, originalTitle);
  assert.equal(streams.size, 0);
});

test('queued, approval and disconnected rooms never use a generating pulse', async () => {
  const next = fixture();
  next.tasks.push(task('queued', 'lounge', 'aster', 'queued'));
  next.tasks.push(task('working', 'research', 'nova', 'running'));
  addApproval(next, approval('review', 'design', 'moss'));
  await mount(next);
  assert.equal(roomButton('Lounge')?.querySelector('.pulse'), null);
  assert.equal(roomButton('Design')?.querySelector('.pulse'), null);
  assert.ok(roomButton('Research')?.querySelector('.pulse'));
  await act(async () => {
    for (const stream of streams) stream.onerror?.();
  });
  assert.equal(document.querySelector('.room-nav-item .pulse'), null);
  assert.ok(roomButton('Research')?.querySelector('.room-status-unconfirmed'));
  assert.match(
    roomButton('Research')!.getAttribute('aria-label')!,
    /unconfirmed|reconnect|confirm/i,
  );
});

test('Japanese attention labels and mobile navigation retain the full room and bot names', async () => {
  const next = fixture();
  next.rooms[1].name = '長い名前の調査ルーム・研究開発';
  next.bots[1].name = '長い名前のリサーチ担当ボット';
  addApproval(next, approval('review', 'research', 'nova'));
  await mount(next, 'ja', 390);
  const banner = document.querySelector<HTMLButtonElement>('.global-approval-banner');
  assert.ok(banner);
  assert.match(banner.textContent!, /ほかのルームで承認待ち 1件/);
  assert.match(
    banner.getAttribute('aria-label')!,
    /長い名前の調査ルーム・研究開発.*長い名前のリサーチ担当ボット/,
  );
  const button = roomButton(next.rooms[1].name);
  assert.ok(button);
  assert.match(button.getAttribute('aria-label')!, /承認待ち 1件/);
  assert.equal(document.title, '1件の承認待ち · Agent Loom');
  await click(document.querySelector('[aria-label="メニューを開く"]'));
  assert.ok(document.querySelector('.sidebar-open'));
  await click(button);
  assert.equal(document.querySelector('.sidebar-open'), null);
  assert.equal(document.querySelector('.room-header h1')?.textContent, next.rooms[1].name);
  assert.equal(document.querySelector('.global-approval-banner'), null);
});
