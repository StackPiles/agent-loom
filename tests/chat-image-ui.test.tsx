import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { ChatImageUpload } from '../src/shared/image-inputs';
import type { GeneratedImage, Snapshot } from '../src/shared/types';

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
const { GeneratedImages } = await import('../src/client/GeneratedImages');
const nativeReader = dom.window.FileReader;
const stamp = '2026-11-10T00:00:00.000Z';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aixkAAAAASUVORK5CYII=';

function fixture(): Snapshot {
  const room = {
    id: 'room_a',
    name: 'Room A',
    description: '',
    botIds: ['bot_a'],
    pinned: false,
    archived: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
  return {
    version: 'test',
    settings: {
      model: {
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'image-capable-model',
        imageInput: true,
        apiKeyConfigured: false,
        contextWindow: 32768,
        maxOutputTokens: 4096,
        temperature: 0.7,
      },
      demoMode: false,
      autoLearn: false,
      maxHandoffs: 6,
      workspacePath: '/test',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: [
      {
        id: 'bot_a',
        name: 'Aster',
        handle: 'aster',
        role: 'Research',
        systemPrompt: 'Test bot.',
        avatar: 'sparkles',
        color: '#829479',
        enabled: true,
        createdAt: stamp,
      },
    ],
    rooms: [room, { ...room, id: 'room_b', name: 'Room B' }],
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
let context: AppContextValue;
const requests: Array<{ path: string; body: { body: string; images?: ChatImageUpload[] } }> = [];
let respond: () => Promise<void> = async () => {};
let selectedRoom = 0;
const navigation: string[] = [];
async function mount() {
  localStorage.clear();
  localStorage.setItem('loom.activity', 'false');
  requests.length = 0;
  navigation.length = 0;
  selectedRoom = 0;
  respond = async () => {};
  context = {
    data: fixture(),
    locale: 'en',
    t: (_, en) => en,
    view: 'chat',
    roomId: 'room_a',
    navigate(view) {
      navigation.push(view);
    },
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string, _method?: string, body?: unknown) {
      requests.push({ path, body: body as (typeof requests)[number]['body'] });
      await respond();
      return {} as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await render();
}
async function render() {
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        <Chat room={context.data.rooms[selectedRoom]} />
      </AppContext.Provider>,
    ),
  );
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  Object.defineProperty(dom.window, 'FileReader', { configurable: true, value: nativeReader });
});
after(() => dom.window.close());

function file(name = 'example.png') {
  return new dom.window.File([Buffer.from(png, 'base64')], name, { type: 'image/png' });
}
function button(label: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label,
  );
  assert.ok(element, `Missing button ${label}`);
  return element;
}
async function paste(files: File[] = [], text = '') {
  const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, getData: () => text } });
  await act(async () => document.querySelector('textarea')!.dispatchEvent(event));
  return event;
}
async function choose(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
}
async function ready(count = 1) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (document.querySelectorAll('.composer-image-thumb img').length === count) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  assert.equal(document.querySelectorAll('.composer-image-thumb img').length, count);
}
async function submit() {
  await act(async () =>
    document
      .querySelector('form.composer')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  );
}
async function write(value: string) {
  const input = document.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

test('pasted image-only messages send real bytes and retain their drafts after a failed request', async () => {
  await mount();
  const event = await paste([file()]);
  assert.equal(event.defaultPrevented, true);
  await ready();
  assert.equal(button('Send message').disabled, false);
  assert.ok(
    !localStorage.getItem('loom.drafts')!.includes(png),
    'image bytes are never persisted in browser drafts',
  );
  respond = async () => {
    throw new Error('Fixture request failed');
  };
  await submit();
  assert.equal(document.querySelectorAll('.composer-image-item').length, 1);
  assert.deepEqual(requests[0], {
    path: '/rooms/room_a/messages',
    body: { body: '', images: [{ filename: 'example.png', mimeType: 'image/png', data: png }] },
  });
  respond = async () => {};
  await submit();
  assert.equal(document.querySelectorAll('.composer-image-item').length, 0);
  assert.equal(button('Send message').disabled, true);
});

test('image input off explains how to enable it, while ordinary text paste keeps browser behavior', async () => {
  await mount();
  context = {
    ...context,
    data: {
      ...context.data,
      settings: {
        ...context.data.settings,
        model: { ...context.data.settings.model, imageInput: false },
      },
    },
  };
  await render();
  assert.equal((await paste([], 'Ordinary text')).defaultPrevented, false);
  await paste([file()]);
  assert.equal(document.querySelectorAll('.composer-image-item').length, 0);
  assert.match(document.querySelector('.composer-image-hint')!.textContent!, /Enable image input/);
  await act(async () => button('Open settings').click());
  assert.deepEqual(navigation, ['settings']);
  await write('A text-only question');
  await submit();
  assert.deepEqual(requests[0].body, { body: 'A text-only question' });
});

test('dragged images can be removed, invalid files are reported, and disabling image input retains staged images', async () => {
  await mount();
  const dropped = new dom.window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(dropped, 'dataTransfer', {
    value: { files: [file('drop.png')], types: ['Files'] },
  });
  await act(async () => document.querySelector('form.composer')!.dispatchEvent(dropped));
  assert.equal(dropped.defaultPrevented, true);
  await ready();
  await choose([new dom.window.File(['<svg/>'], 'unsafe.svg', { type: 'image/svg+xml' })]);
  assert.match(document.querySelector('.composer-image-error')!.textContent!, /PNG, JPEG or WebP/);
  assert.equal(document.querySelectorAll('.composer-image-item').length, 1);
  const oversize = file('large.png');
  Object.defineProperty(oversize, 'size', { value: 21 * 1024 * 1024 });
  await choose([oversize]);
  assert.match(document.querySelector('.composer-image-error')!.textContent!, /20 MiB/);
  await choose(Array.from({ length: 10 }, () => file()));
  assert.match(document.querySelector('.composer-image-error')!.textContent!, /10 images/);
  context.data.settings.model.imageInput = false;
  await render();
  assert.equal(button('Send message').disabled, true);
  assert.equal(document.querySelectorAll('.composer-image-item').length, 1);
  await act(async () => button('Remove drop.png').click());
  assert.equal(document.querySelectorAll('.composer-image-item').length, 0);
  assert.equal(document.querySelector('.composer-image-error'), null);
});

test('reading and sending keep their original room, and a late success preserves a newer text draft', async () => {
  const readers: ControlledReader[] = [];
  class ControlledReader {
    result: string | null = null;
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    readAsDataURL() {
      readers.push(this);
    }
    abort() {
      this.onabort?.();
    }
    complete() {
      this.result = `data:image/png;base64,${png}`;
      this.onload?.();
    }
  }
  Object.defineProperty(dom.window, 'FileReader', { configurable: true, value: ControlledReader });
  await mount();
  await choose([file('room-a.png')]);
  assert.equal(button('Send message').disabled, true, 'sending waits for file reading');
  selectedRoom = 1;
  await render();
  assert.equal(document.querySelectorAll('.composer-image-item').length, 0);
  await choose([file('room-b.png')]);
  await act(async () => readers[0].complete());
  assert.equal(
    document.querySelectorAll('.composer-image-thumb img').length,
    0,
    'another room finishing does not fill this draft',
  );
  await act(async () => readers[1].complete());
  await ready();
  let finish!: () => void;
  respond = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  await submit();
  assert.equal(requests[0].path, '/rooms/room_b/messages');
  assert.equal(requests[0].body.images![0].filename, 'room-b.png');
  selectedRoom = 0;
  await render();
  assert.equal(document.querySelector('.composer-image-item > span')!.textContent, 'room-a.png');
  await write('New text in room A');
  await act(async () => finish());
  assert.equal(document.querySelectorAll('.composer-image-item').length, 1);
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('textarea')!.value,
    'New text in room A',
  );
  respond = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  await submit();
  await write('A newer draft while sending');
  await act(async () => finish());
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('textarea')!.value,
    'A newer draft while sending',
  );
  assert.equal(document.querySelectorAll('.composer-image-item').length, 0);
});

test('removing a pending read prevents its completion from restoring the image', async () => {
  let pending: { complete(): void };
  class ControlledReader {
    result: string | null = null;
    onload?: () => void;
    onabort?: () => void;
    readAsDataURL() {
      pending = this;
    }
    abort() {
      this.onabort?.();
    }
    complete() {
      this.result = `data:image/png;base64,${png}`;
      this.onload?.();
    }
  }
  Object.defineProperty(dom.window, 'FileReader', { configurable: true, value: ControlledReader });
  await mount();
  await choose([file('pending.png')]);
  await act(async () => button('Remove pending.png').click());
  await act(async () => pending!.complete());
  assert.equal(document.querySelectorAll('.composer-image-item').length, 0);
  assert.equal(button('Send message').disabled, true);
});

test('uploaded and edited attachments have accurate labels and link to the original image', async () => {
  await mount();
  const original: GeneratedImage = {
    id: `img_${'a'.repeat(64)}`,
    type: 'image',
    mimeType: 'image/png',
    filename: 'reference.png',
    byteLength: 100,
    prompt: '',
    model: '',
    createdAt: stamp,
    source: 'uploaded',
  };
  const edited: GeneratedImage = {
    ...original,
    id: `img_${'b'.repeat(64)}`,
    source: 'generated',
    operation: 'edit',
    prompt: 'Make the background blue.',
    model: 'image-model',
    filename: 'edited.png',
    inputImages: [{ role: 'source', imageId: original.id, sha256: 'c'.repeat(64) }],
  };
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        <GeneratedImages images={[original, edited]} />
      </AppContext.Provider>,
    ),
  );
  const cards = document.querySelectorAll('.generated-image');
  assert.match(cards[0].textContent!, /Uploaded image/);
  assert.equal(cards[0].querySelector('details'), null);
  assert.match(cards[1].textContent!, /Edited image/);
  assert.equal(cards[1].querySelector('summary')!.textContent, 'Edit instruction');
  assert.equal(
    cards[1].querySelector('.image-source-meta a')!.getAttribute('href'),
    `/api/images/${original.id}`,
  );
});
