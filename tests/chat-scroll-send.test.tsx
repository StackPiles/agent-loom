import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Snapshot } from '../src/shared/types';
import { DEFAULT_IMAGE_SETTINGS } from '../src/shared/model-settings';

// Exercise the real Chat send handler, including the pending network request.
// The geometry-only controller tests cannot detect a late followLatest call here.
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
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('../src/client/context');
const { Chat } = await import('../src/client/Chat');

test('sending follows immediately, but its delayed completion respects a reader who scrolls away', async (t) => {
  const now = '2026-11-01T00:00:00.000Z';
  const room = {
    id: 'room_a',
    name: 'Research',
    description: '',
    botIds: ['bot_a'],
    parallelResponses: true,
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  let data: Snapshot = {
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
      demoMode: true,
      autoLearn: false,
      maxHandoffs: 6,
      workspacePath: 'C:\\Loom\\Default',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: [
      {
        id: 'bot_a',
        name: 'Aster',
        handle: 'aster',
        role: 'Research',
        avatar: 'sparkles',
        color: '#829479',
        systemPrompt: 'Test bot.',
        enabled: true,
        createdAt: now,
      },
    ],
    rooms: [room],
    messages: [
      {
        id: 'message_a',
        roomId: room.id,
        authorType: 'bot',
        authorId: 'bot_a',
        body: 'A previous answer.',
        status: 'complete',
        createdAt: now,
      },
    ],
    tasks: [],
    activities: [],
    approvals: [],
    skills: [],
    memories: [],
    automations: [],
    notifications: [],
    queue: { active: 0, waiting: 0, capacity: 2 },
  };
  localStorage.clear();
  localStorage.setItem('loom.activity', 'false');
  localStorage.setItem('loom.drafts', JSON.stringify({ [room.id]: 'Please continue.' }));
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: string[] = [];
  const context: AppContextValue = {
    data,
    locale: 'en',
    t: (_, en) => en,
    view: 'chat',
    roomId: room.id,
    navigate() {},
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string) {
      calls.push(path);
      await pending;
      return {} as T;
    },
  };
  const root = createRoot(document.getElementById('root')!);
  t.after(async () => {
    finish();
    await act(async () => root.unmount());
    dom.window.close();
  });
  const render = async () => {
    await act(async () =>
      root.render(
        <AppContext.Provider value={{ ...context, data }}>
          <Chat room={room} />
        </AppContext.Provider>,
      ),
    );
  };
  await render();
  const viewport = document.querySelector<HTMLElement>('.message-scroll')!;
  assert.ok(viewport);
  let total = 2000;
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, get: () => total },
    clientHeight: { configurable: true, value: 400 },
  });
  const scroll = () => viewport.dispatchEvent(new dom.window.Event('scroll'));
  const upward = () =>
    viewport.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -80, bubbles: true }));
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    scroll();
  });
  assert.equal(viewport.scrollTop, 1600);
  await act(async () => {
    upward();
    viewport.scrollTop = 1000;
    scroll();
  });
  assert.ok(document.querySelector('.jump-latest'));
  await act(async () =>
    document
      .querySelector('form.composer')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  );
  assert.deepEqual(calls, ['/rooms/room_a/messages']);
  assert.equal(viewport.scrollTop, 1600, 'The explicit send gesture immediately resumes the tail.');
  assert.equal(document.querySelector('.jump-latest'), null);
  await act(async () => {
    scroll();
    upward();
    viewport.scrollTop = 800;
    scroll();
  });
  assert.ok(document.querySelector('.jump-latest'));
  await act(async () => {
    finish();
    await pending;
  });
  assert.equal(document.querySelector<HTMLTextAreaElement>('textarea')!.value, '');
  assert.equal(
    viewport.scrollTop,
    800,
    'Resolving the request must not override a later reading gesture.',
  );
  total += 400;
  data = {
    ...data,
    messages: [
      ...data.messages,
      {
        id: 'message_new',
        roomId: room.id,
        authorType: 'bot',
        authorId: 'bot_a',
        body: 'The next answer is streaming.',
        status: 'streaming',
        createdAt: now,
      },
    ],
  };
  await render();
  assert.equal(viewport.scrollTop, 800);
  const latest = document.querySelector<HTMLButtonElement>('.jump-latest')!;
  assert.match(latest.textContent!, /New activity/);
  await act(async () => latest.click());
  assert.equal(viewport.scrollTop, 2000);
  assert.equal(document.querySelector('.jump-latest'), null);
});
