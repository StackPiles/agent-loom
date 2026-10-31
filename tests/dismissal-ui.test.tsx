import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Room, Snapshot } from '../src/shared/types';

// These interaction tests exercise native-dialog event handling, not browser geometry/rendering.
const dom = new JSDOM(
  '<!doctype html><html><body><button id="opener">Open</button><div id="root"></div></body></html>',
  { url: 'http://localhost:3210', pretendToBeVisual: true },
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
Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1440 });
dom.window.HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};
dom.window.HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open');
};
const React = await import('react');
const { act, useState } = React;
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('../src/client/context');
const { Modal } = await import('../src/client/components');
const { Chat } = await import('../src/client/Chat');

const now = '2026-10-31T00:00:00.000Z';
const room: Room = {
  id: 'room_one',
  name: 'Research',
  description: '',
  botIds: ['bot_aster'],
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
      maxHandoffs: 3,
      workspacePath: './workspace',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: [
      {
        id: 'bot_aster',
        name: 'Aster',
        handle: 'aster',
        role: 'Research',
        systemPrompt: 'Research carefully.',
        color: '#829479',
        avatar: 'character:aster',
        enabled: true,
        createdAt: now,
      },
    ],
    rooms: [room],
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
let root: ReturnType<typeof createRoot> | undefined;
const mutations: { path: string; method?: string; body?: unknown }[] = [];
async function mount(children: React.ReactNode) {
  if (root) await act(async () => root?.unmount());
  localStorage.clear();
  mutations.length = 0;
  const context: AppContextValue = {
    data: fixture(),
    locale: 'en',
    t: (_ja, en) => en,
    view: 'chat',
    roomId: room.id,
    navigate() {},
    refresh: async () => {},
    toast() {},
    signOut: async () => {},
    mutate: async <T,>(path: string, method?: string, body?: unknown) => {
      mutations.push({ path, method, body });
      return {} as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root!.render(<AppContext.Provider value={context}>{children}</AppContext.Provider>);
  });
}
async function mouse(element: Element, type = 'click', x = 200, y = 200) {
  await act(async () => {
    element.dispatchEvent(
      new dom.window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      }),
    );
  });
}
async function escape(element: Element) {
  await act(async () => {
    element.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}
async function inputMention(value: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>('.composer textarea')!;
  await act(async () => {
    textarea.focus();
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea,
      value,
    );
    textarea.setSelectionRange(value.length, value.length);
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  return textarea;
}
function setBounds(dialog: HTMLDialogElement) {
  dialog.getBoundingClientRect = () => new dom.window.DOMRect(100, 100, 400, 300);
}
function roomMenu() {
  return document.querySelector<HTMLDetailsElement>('.room-menu')!;
}
async function openRoomMenu() {
  await mouse(roomMenu().querySelector('summary')!);
  assert.equal(roomMenu().open, true);
}

test('dialog dismissal requires a backdrop click and never a border click or text-selection drag', async () => {
  let closed = 0;
  await mount(
    <Modal title="Edit" onClose={() => closed++}>
      <textarea defaultValue="Keep this draft" />
    </Modal>,
  );
  const dialog = document.querySelector('dialog')!;
  setBounds(dialog);
  await mouse(dialog.querySelector('textarea')!);
  await mouse(dialog, 'click', 100, 150);
  await mouse(dialog, 'click', 499, 200);
  assert.equal(closed, 0, 'Interior, border and scrollbar coordinates remain inside');
  await mouse(dialog.querySelector('textarea')!, 'pointerdown', 200, 200);
  await mouse(dialog, 'click', 50, 50);
  assert.equal(closed, 0, 'Dragging from an input onto the backdrop must preserve the draft');
  await mouse(dialog, 'pointerdown', 50, 50);
  await mouse(dialog, 'click', 200, 200);
  assert.equal(closed, 0, 'A gesture ending inside does not dismiss');
  await mouse(dialog, 'pointerdown', 50, 50);
  await mouse(dialog, 'click', 50, 50);
  assert.equal(closed, 1, 'A complete backdrop click dismisses');
});

test('only the clicked dialog closes and dismissal restores the prior focus', async () => {
  const opener = document.getElementById('opener')!;
  opener.focus();
  function Dialogs() {
    const [parent, setParent] = useState(true);
    const [child, setChild] = useState(true);
    return parent ? (
      <Modal title="Parent" onClose={() => setParent(false)}>
        <input aria-label="Parent input" />
        {child && (
          <Modal title="Child" onClose={() => setChild(false)}>
            <input aria-label="Child input" />
          </Modal>
        )}
      </Modal>
    ) : null;
  }
  await mount(<Dialogs />);
  const dialogs = document.querySelectorAll('dialog');
  dialogs.forEach(setBounds);
  await mouse(dialogs[1], 'pointerdown', 50, 50);
  await mouse(dialogs[1], 'click', 50, 50);
  assert.equal(document.querySelectorAll('dialog').length, 1);
  assert.match(document.querySelector('dialog')!.textContent || '', /Parent/);
  await mouse(dialogs[0], 'pointerdown', 50, 50);
  await mouse(dialogs[0], 'click', 50, 50);
  assert.equal(document.querySelectorAll('dialog').length, 0);
  assert.equal(document.activeElement, opener);
});

test('cancelling a nested native dialog does not cancel its parent', async () => {
  let parentClosed = 0;
  let childClosed = 0;
  await mount(
    <Modal title="Parent" onClose={() => parentClosed++}>
      <Modal title="Child" onClose={() => childClosed++}>
        <input aria-label="Child input" />
      </Modal>
    </Modal>,
  );
  const [parent, child] = document.querySelectorAll('dialog');
  const cancel = new dom.window.Event('cancel', { cancelable: true, bubbles: false });
  await act(async () => {
    child.dispatchEvent(cancel);
  });
  assert.equal(cancel.defaultPrevented, true, 'React owns the requested child close');
  assert.equal(childClosed, 1);
  assert.equal(parentClosed, 0, 'React synthetic bubbling must not also close the parent');
  await act(async () => {
    parent.dispatchEvent(new dom.window.Event('cancel', { cancelable: true, bubbles: false }));
  });
  assert.equal(parentClosed, 1, 'The parent still handles its own native cancel');
});

test('room actions close outside, on focus departure and Escape without closing the activity panel', async () => {
  await mount(<Chat room={room} />);
  assert.ok(document.querySelector('.activity-panel'));
  await openRoomMenu();
  await mouse(roomMenu().querySelector('.dropdown-menu')!);
  assert.equal(roomMenu().open, true, 'Empty interior space is not an outside click');
  await mouse(document.querySelector('.room-heading')!, 'pointerdown');
  assert.equal(roomMenu().open, false);
  await openRoomMenu();
  await act(async () => {
    document.querySelector<HTMLTextAreaElement>('.composer textarea')!.focus();
  });
  assert.equal(roomMenu().open, false, 'Tabbing outside dismisses the menu');
  await openRoomMenu();
  await escape(roomMenu().querySelector('summary')!);
  assert.equal(roomMenu().open, false);
  assert.equal(document.activeElement, roomMenu().querySelector('summary'));
  assert.ok(document.querySelector('.activity-panel'), 'Escape closes the menu before the panel');
});

test('selecting a room action dismisses the menu and still runs that action exactly once', async () => {
  await mount(<Chat room={room} />);
  await openRoomMenu();
  const pin = [...roomMenu().querySelectorAll('button')].find(
    (button) => button.textContent === 'Pin room',
  )!;
  await mouse(pin);
  assert.equal(roomMenu().open, false);
  assert.deepEqual(mutations, [
    { path: `/rooms/${room.id}`, method: 'PATCH', body: { pinned: true } },
  ]);
});

test('mention suggestions dismiss outside and on Escape while preserving the draft, selection and activity panel', async () => {
  await mount(<Chat room={room} />);
  const textarea = await inputMention('@ast');
  assert.ok(document.querySelector('#mention-menu'));
  await mouse(document.querySelector('.room-heading')!);
  assert.equal(document.querySelector('#mention-menu'), null);
  assert.equal(textarea.value, '@ast');
  await mouse(textarea);
  assert.ok(
    document.querySelector('#mention-menu'),
    'Returning to the mention reopens suggestions',
  );
  await escape(textarea);
  assert.equal(document.querySelector('#mention-menu'), null);
  assert.ok(
    document.querySelector('.activity-panel'),
    'Handled Escape does not dismiss another surface',
  );
  await inputMention('@as');
  await mouse(document.querySelector('#mention-menu button')!);
  assert.equal(textarea.value, '@aster ');
  assert.equal(document.querySelector('#mention-menu'), null);
  assert.equal(mutations.length, 0, 'Selecting a mention does not send the draft');
  await mouse(document.querySelector('[data-mention-trigger]')!);
  assert.ok(
    document.querySelector('#mention-menu'),
    'The trigger is part of the suggestion surface',
  );
  await act(async () => {
    document.querySelector<HTMLSelectElement>('.composer-recipient select')!.focus();
  });
  assert.equal(
    document.querySelector('#mention-menu'),
    null,
    'Focus outside dismisses suggestions',
  );
});

after(async () => {
  if (root) await act(async () => root?.unmount());
  dom.window.close();
});
