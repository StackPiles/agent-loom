import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type {
  Message,
  Notification,
  NotificationReplyContext,
  NotificationReplyResult,
  Snapshot,
  Task,
} from '../src/shared/types';

// Interaction coverage. Real desktop/mobile geometry is checked by the Chrome CI smoke.
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
  'CompositionEvent',
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
const { AppContext } = await import('../src/client/context');
const { InboxPage } = await import('../src/client/InboxPage');
const { Chat } = await import('../src/client/Chat');
const { default: App } = await import('../src/client/App');
const nativeReader = dom.window.FileReader;
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aixkAAAAASUVORK5CYII=';

const stamp = '2026-11-06T09:00:00.000Z';
function task(botId = 'bot_aster'): Task {
  return {
    id: `task_${botId}`,
    roomId: 'room_original',
    botId,
    prompt: 'Synthetic request.',
    status: 'completed',
    rootTaskId: `task_${botId}`,
    depth: 0,
    kind: 'chat',
    output: 'Synthetic answer.',
    createdAt: stamp,
    updatedAt: stamp,
    inputTokens: 0,
    outputTokens: 0,
  };
}
function notice(patch: Partial<Notification> = {}): Notification {
  return {
    id: 'notice_aster',
    title: '確認のお願い',
    body: 'この案で進めますか？',
    sender: { kind: 'bot', botId: 'bot_aster', name: 'Aster', handle: 'aster' },
    roomId: 'room_original',
    taskId: 'task_bot_aster',
    read: false,
    createdAt: stamp,
    ...patch,
  };
}
function fixture(): Snapshot {
  return {
    version: 'test',
    settings: {
      demoMode: true,
      autoLearn: false,
      maxHandoffs: 6,
      workspacePath: './workspace',
      model: {
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'fixture',
        apiKeyConfigured: false,
        contextWindow: 32768,
        maxOutputTokens: 4096,
        temperature: 0.7,
      },
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'ask' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    // The notification's author deliberately is not the first bot in the room.
    bots: ['Nova', 'Aster'].map((name) => ({
      id: `bot_${name.toLowerCase()}`,
      name,
      handle: name.toLowerCase(),
      role: 'Research',
      systemPrompt: 'Synthetic bot.',
      color: '#829479',
      avatar: 'sparkles',
      enabled: true,
      createdAt: stamp,
    })),
    rooms: [
      {
        id: 'room_original',
        name: '開発の相談',
        description: '',
        botIds: ['bot_nova', 'bot_aster'],
        archived: false,
        pinned: false,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    messages: [],
    tasks: [task(), task('bot_nova')],
    activities: [],
    approvals: [],
    skills: [],
    memories: [],
    automations: [],
    notifications: [notice()],
    queue: { active: 0, waiting: 0 },
  };
}
interface Call {
  path: string;
  method: string;
  body: any;
  signal?: AbortSignal | null;
}
let root: ReturnType<typeof createRoot> | undefined;
let context: AppContextValue;
let state: Snapshot;
let replyHandler: ((call: Call) => Promise<Response> | Response) | undefined;
let refreshFailure: Error | undefined;
let refreshCount = 0;
const calls: Call[] = [];
const mutations: Call[] = [];
const navigations: { view: string; roomId?: string }[] = [];
const toasts: { message: string; kind?: string }[] = [];

function accepted(call: Call, duplicate = false): NotificationReplyResult {
  const item = state.notifications.find(
    (n) => n.id === decodeURIComponent(call.path.split('/')[3]),
  );
  assert.ok(item);
  const bot =
    item.sender?.kind === 'bot'
      ? state.bots.find((b) => b.id === item.sender!.botId)
      : state.bots.find((b) => b.id === state.tasks.find((t) => t.id === item.taskId)?.botId);
  assert.ok(bot);
  const reply: NotificationReplyContext = {
    notificationId: item.id,
    roomId: item.roomId!,
    botId: bot.id,
    senderName: bot.name,
    senderHandle: bot.handle,
    title: item.title,
    body: item.body,
    createdAt: item.createdAt,
    taskId: item.taskId,
  };
  const replyTask: Task = {
    ...task(bot.id),
    id: 'task_reply',
    rootTaskId: 'task_reply',
    status: 'queued',
    prompt: call.body.body,
    output: '',
    notificationReply: reply,
  };
  return {
    message: {
      id: 'message_reply',
      roomId: item.roomId!,
      authorType: 'user',
      authorId: 'user',
      body: call.body.body,
      status: 'complete',
      createdAt: stamp,
      targetBotIds: [bot.id],
      notificationReply: reply,
    },
    tasks: [replyTask],
    notification: { ...item, read: true },
    duplicate,
  };
}
Object.assign(globalThis, {
  fetch: async (url: string, options: RequestInit = {}) => {
    const call = {
      path: String(url),
      method: options.method ?? 'GET',
      body: typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
      signal: options.signal,
    };
    calls.push(call);
    if (call.method === 'POST' && /\/notifications\/[^/]+\/reply$/.test(call.path))
      return replyHandler ? replyHandler(call) : Response.json(accepted(call));
    if (call.path === '/api/state') return Response.json(structuredClone(state));
    if (call.method === 'GET') return Response.json({ ok: true, supported: false });
    throw new Error(`Unexpected request: ${call.method} ${call.path}`);
  },
});
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

async function mount(data = fixture(), locale: 'ja' | 'en' = 'en') {
  if (root) await act(async () => root!.unmount());
  Object.defineProperty(dom.window, 'FileReader', { configurable: true, value: nativeReader });
  state = data;
  calls.length = 0;
  mutations.length = 0;
  navigations.length = 0;
  toasts.length = 0;
  replyHandler = undefined;
  refreshFailure = undefined;
  refreshCount = 0;
  context = {
    data,
    locale,
    connected: true,
    t: (ja, en) => (locale === 'ja' ? ja : en),
    view: 'inbox',
    roomId: 'room_original',
    navigate(view, roomId) {
      navigations.push({ view, roomId });
    },
    async refresh() {
      refreshCount++;
      if (refreshFailure) throw refreshFailure;
    },
    toast(message, kind) {
      toasts.push({ message, kind });
    },
    async signOut() {},
    async mutate<T>(path: string, method = 'POST', body?: unknown) {
      mutations.push({ path, method, body });
      return {} as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await rerender(data);
}
async function rerender(data: Snapshot, patch: Partial<AppContextValue> = {}, chat = false) {
  state = data;
  context = { ...context, data, ...patch };
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        {chat ? <Chat room={data.rooms[0]} /> : <InboxPage />}
      </AppContext.Provider>,
    ),
  );
}
function card(id = 'notice_aster') {
  const value = document.querySelector<HTMLElement>(`article[data-notification-id="${id}"]`);
  assert.ok(value, `Missing notification ${id}`);
  return value;
}
function replyButton(id = 'notice_aster') {
  const value = card(id).querySelector<HTMLButtonElement>('button[data-notification-reply]');
  assert.ok(value, `Missing reply button ${id}`);
  return value;
}
function form(id = 'notice_aster') {
  const value = card(id).querySelector<HTMLFormElement>('form[data-notification-reply-form]');
  assert.ok(value, `Missing reply form ${id}`);
  return value;
}
function textarea(id = 'notice_aster') {
  return form(id).querySelector<HTMLTextAreaElement>('textarea')!;
}
function sendButton(id = 'notice_aster') {
  return form(id).querySelector<HTMLButtonElement>('button[type="submit"]')!;
}
function button(text: string, scope: ParentNode = document) {
  const value = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text,
  );
  assert.ok(value, `Missing button ${text}`);
  return value;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function input(value: string, id = 'notice_aster') {
  await act(async () => {
    const element = textarea(id);
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit(id = 'notice_aster') {
  await act(async () =>
    form(id).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}
const replies = () =>
  calls.filter((call) => call.method === 'POST' && call.path.endsWith('/reply'));

function imageFile(name = 'example.png') {
  return new dom.window.File([Buffer.from(png, 'base64')], name, { type: 'image/png' });
}
async function mountWithImages(data = fixture()) {
  data.settings.model.imageInput = true;
  await mount(data);
  await click(replyButton());
}
async function chooseImages(files: File[], id = 'notice_aster') {
  const picker = form(id).querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(picker, 'files', { configurable: true, value: files });
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
}
async function pasteImages(files: File[], text = '', id = 'notice_aster') {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, getData: () => text } });
  await act(async () => textarea(id).dispatchEvent(event));
  return event;
}
async function dropImages(files: File[], id = 'notice_aster') {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } });
  await act(async () => form(id).dispatchEvent(event));
  return event;
}
async function imagesReady(count = 1, id = 'notice_aster') {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (form(id).querySelectorAll('.composer-image-thumb img').length === count) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  assert.equal(form(id).querySelectorAll('.composer-image-thumb img').length, count);
}
function controlReaders() {
  const readers: ControlledReader[] = [];
  class ControlledReader {
    result: string | null = null;
    aborted = false;
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    readAsDataURL() {
      readers.push(this);
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
    complete() {
      this.result = `data:image/png;base64,${png}`;
      this.onload?.();
    }
    fail() {
      this.onerror?.();
    }
  }
  Object.defineProperty(dom.window, 'FileReader', { configurable: true, value: ControlledReader });
  return readers;
}

test('image-only notification replies preserve bytes and retry identity after a lost response or disconnection', async () => {
  await mountWithImages();
  assert.equal((await pasteImages([imageFile('画面.png')])).defaultPrevented, true);
  await imagesReady();
  assert.equal(textarea().required, false, 'the native form accepts an image-only reply');
  assert.equal(sendButton().disabled, false);
  replyHandler = () => {
    throw new Error('Synthetic lost response');
  };
  await submit();
  const first = replies()[0].body;
  assert.deepEqual(first.images, [{ filename: '画面.png', mimeType: 'image/png', data: png }]);
  assert.equal(first.body, '');
  assert.equal(form().querySelectorAll('.composer-image-thumb img').length, 1);
  assert.match(form().textContent!, /draft is kept/);
  assert.ok(!JSON.stringify(localStorage).includes(png), 'image bytes stay out of browser storage');
  await rerender(state, { connected: false });
  await submit();
  assert.equal(replies().length, 1);
  assert.equal(form().querySelectorAll('.composer-image-thumb img').length, 1);
  await rerender(state, { connected: true });
  replyHandler = (call) => Response.json(accepted(call, true));
  await submit();
  assert.deepEqual(replies()[1].body, first, 'retry reuses the exact accepted payload and ID');
  assert.equal(card().querySelector('form'), null);
  assert.equal(navigations.length, 1);
});

test('selection, mixed paste and drop preserve image order, and edited attachments get a new reply identity', async () => {
  await mountWithImages();
  await chooseImages([imageFile('chosen.png')]);
  assert.equal((await pasteImages([imageFile('pasted.png')], 'caption')).defaultPrevented, false);
  assert.equal((await dropImages([imageFile('dropped.png')])).defaultPrevented, true);
  await imagesReady(3);
  replyHandler = () => {
    throw new Error('Synthetic connection failure');
  };
  await input('Caption');
  await submit();
  const first = replies()[0].body.requestId;
  assert.deepEqual(
    replies()[0].body.images.map((image: { filename: string }) => image.filename),
    ['chosen.png', 'pasted.png', 'dropped.png'],
  );
  await submit();
  assert.equal(replies()[1].body.requestId, first);
  await click(button('Remove pasted.png', form()));
  await submit();
  const second = replies()[2].body.requestId;
  assert.notEqual(second, first);
  assert.deepEqual(
    replies()[2].body.images.map((image: { filename: string }) => image.filename),
    ['chosen.png', 'dropped.png'],
  );
  await input('Revised caption');
  await submit();
  assert.notEqual(replies()[3].body.requestId, second);
});

test('image setting changes and invalid files never discard existing attachments or enable an invalid send', async () => {
  await mount();
  await click(replyButton());
  await click(button('Attach images', form()));
  assert.match(form().textContent!, /Enable image input/);
  await pasteImages([imageFile()]);
  assert.equal(form().querySelectorAll('[data-draft-image]').length, 0);
  state.settings.model.imageInput = true;
  await rerender(state);
  await chooseImages([imageFile()]);
  await imagesReady();
  await chooseImages([new dom.window.File(['<svg/>'], 'unsafe.svg', { type: 'image/svg+xml' })]);
  assert.match(form().textContent!, /PNG, JPEG or WebP/);
  const oversized = imageFile('oversized.png');
  Object.defineProperty(oversized, 'size', { value: 21 * 1024 * 1024 });
  await chooseImages([oversized]);
  assert.match(form().textContent!, /20 MiB/);
  await chooseImages(Array.from({ length: 10 }, (_, i) => imageFile(`${i}.png`)));
  assert.match(form().textContent!, /10 images/);
  assert.equal(form().querySelectorAll('[data-draft-image]').length, 1);
  state.settings.model.imageInput = false;
  await rerender(state);
  await input('Keep my caption.');
  assert.equal(sendButton().disabled, true);
  await submit();
  assert.equal(replies().length, 0);
  await click(button('Remove example.png', form()));
  assert.equal(sendButton().disabled, false, 'plain text is still usable when image input is off');
  await submit();
  assert.equal(replies()[0].body.images, undefined);
});

test('pending and failed reads block sending, and removing or cancelling a read cannot restore an old image', async () => {
  await mountWithImages();
  const readers = controlReaders();
  await input('Text is ready before the image.');
  const picker = form().querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(picker, 'files', { configurable: true, value: [imageFile('pending.png')] });
  await act(async () => {
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(replies().length, 0, 'a same-batch submit cannot omit the selected image');
  assert.equal(sendButton().disabled, true);
  assert.match(form().textContent!, /Reading images/);
  await act(async () => readers[0].fail());
  assert.match(form().textContent!, /Could not read image/);
  await submit();
  assert.equal(replies().length, 0);
  await click(button('Remove pending.png', form()));
  await act(async () => readers[0].complete());
  assert.equal(form().querySelectorAll('[data-draft-image]').length, 0);
  assert.equal(sendButton().disabled, false);
  await chooseImages([imageFile('cancelled.png')]);
  await click(button('Cancel', form()));
  assert.equal(readers[1].aborted, true);
  await act(async () => readers[1].complete());
  await click(replyButton());
  assert.equal(form().querySelectorAll('[data-draft-image]').length, 0);
  assert.equal(textarea().value, '');
  await chooseImages([imageFile('unmounted.png')]);
  await act(async () => root!.unmount());
  root = undefined;
  assert.equal(readers[2].aborted, true);
  await act(async () => readers[2].complete());
  assert.equal(replies().length, 0);
});

test('attachment drafts remain bound to their notification through read filters and source changes', async () => {
  const data = fixture();
  data.notifications.push(
    notice({
      id: 'notice_nova',
      sender: { kind: 'bot', botId: 'bot_nova', name: 'Nova', handle: 'nova' },
      taskId: 'task_bot_nova',
    }),
  );
  await mountWithImages(data);
  await chooseImages([imageFile('aster-only.png')]);
  await imagesReady();
  await click(document.querySelectorAll<HTMLButtonElement>('.page-tabs button')[1]);
  await rerender({ ...data, notifications: data.notifications.map((n) => ({ ...n, read: true })) });
  assert.equal(form().querySelector('img')!.getAttribute('alt'), 'aster-only.png');
  await rerender({
    ...state,
    notifications: state.notifications.map((n) =>
      n.id === 'notice_aster'
        ? {
            ...n,
            taskId: 'task_bot_nova',
            sender: { kind: 'bot' as const, botId: 'bot_nova', name: 'Nova', handle: 'nova' },
          }
        : n,
    ),
  });
  assert.equal(sendButton().disabled, true);
  assert.equal(form().querySelector('img')!.getAttribute('alt'), 'aster-only.png');
  await submit();
  assert.equal(replies().length, 0);
  await click(button('Cancel', form()));
  await click(document.querySelectorAll<HTMLButtonElement>('.page-tabs button')[0]);
  await click(replyButton('notice_nova'));
  assert.equal(form('notice_nova').querySelectorAll('[data-draft-image]').length, 0);
});

test('in-flight image replies lock attachment and read actions, and unmount aborts UI work without reporting a send', async () => {
  await mountWithImages();
  await chooseImages([imageFile()]);
  await imagesReady();
  let release!: (response: Response) => void;
  replyHandler = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  await act(async () => {
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(replies().length, 1);
  assert.equal(button('Attach images', form()).disabled, true);
  assert.equal(button('Remove example.png', form()).disabled, true);
  assert.equal(button('Mark as read', card()).disabled, true);
  assert.equal(button('Mark all as read').disabled, true);
  assert.equal(button('Open conversation', card()).disabled, true);
  await pasteImages([imageFile('not-sent.png')]);
  await dropImages([imageFile('also-not-sent.png')]);
  assert.equal(form().querySelectorAll('[data-draft-image]').length, 1);
  assert.equal(replies()[0].body.images.length, 1);
  const signal = replies()[0].signal;
  await act(async () => root!.unmount());
  root = undefined;
  assert.equal(signal?.aborted, true);
  await act(async () => release(Response.json(accepted(replies()[0]))));
  assert.equal(navigations.length, 0);
  assert.equal(toasts.length, 0);
});

test('inbox identifies different senders even when their notification titles and bodies match', async () => {
  const data = fixture();
  data.notifications.push(
    notice({
      id: 'notice_nova',
      taskId: 'task_bot_nova',
      sender: { kind: 'bot', botId: 'bot_nova', name: 'Nova', handle: 'nova' },
    }),
  );
  await mount(data, 'ja');
  assert.match(card().querySelector('.notification-sender')!.textContent!, /送信元Aster@aster/);
  assert.match(
    card('notice_nova').querySelector('.notification-sender')!.textContent!,
    /送信元Nova@nova/,
  );
  for (const id of ['notice_aster', 'notice_nova']) {
    assert.equal(card(id).querySelector('h2')!.textContent, '確認のお願い');
    assert.equal(card(id).querySelector('.notification-body')!.textContent, 'この案で進めますか？');
    assert.match(card(id).querySelector('.notification-room')!.textContent!, /開発の相談/);
    assert.equal(card(id).querySelector('time')!.getAttribute('datetime'), stamp);
    assert.equal(replyButton(id).disabled, false);
  }
  assert.equal(mutations.length, 0, 'Viewing the inbox does not mark notices read.');
});

test('legacy responsible bots, system notices, and unknown senders remain visibly distinct', async () => {
  const data = fixture();
  data.notifications = [
    notice({ sender: undefined }),
    notice({ id: 'system', sender: { kind: 'system' } }),
    notice({
      id: 'unknown',
      sender: undefined,
      taskId: undefined,
      title: '@nova posted a message',
    }),
  ];
  await mount(data, 'ja');
  assert.match(card().querySelector('.notification-sender')!.textContent!, /担当ボットAster@aster/);
  assert.match(
    card('system').querySelector('.notification-sender')!.textContent!,
    /システムAgent Loom/,
  );
  assert.equal(card('system').querySelector('[data-notification-reply]'), null);
  assert.equal(
    card('unknown').querySelector('.notification-sender strong')!.textContent,
    '送信元不明',
  );
  assert.equal(card('unknown').querySelector('[data-notification-reply]'), null);
  assert.equal(calls.length, 0);
});

test('saved sender names survive renaming and deletion without silently changing the reply recipient', async () => {
  const data = fixture();
  const bot = data.bots.find((b) => b.id === 'bot_aster')!;
  bot.name = 'Renamed Aster';
  bot.handle = 'renamed';
  await mount(data);
  assert.equal(card().querySelector('.notification-sender strong')!.textContent, 'Aster');
  assert.equal(card().querySelector('.notification-sender-handle')!.textContent, '@aster');
  assert.match(
    card().querySelector('.notification-current-sender')!.textContent!,
    /Renamed Aster \(@renamed\)/,
  );
  await click(replyButton());
  assert.match(
    form().querySelector('.notification-reply-help')!.textContent!,
    /Renamed Aster \(@renamed\)/,
  );
  await input('Keep this reply draft.');
  await rerender({ ...data, bots: data.bots.filter((b) => b.id !== 'bot_aster') });
  assert.equal(card().querySelector('.notification-sender strong')!.textContent, 'Aster');
  assert.equal(textarea().value, 'Keep this reply draft.');
  assert.equal(sendButton().disabled, true);
  assert.match(card().textContent!, /deleted and cannot receive replies/);
  await submit();
  assert.equal(replies().length, 0);
});

test('a direct reply uses the notification endpoint, keeps mentions as text, and opens the original room', async () => {
  await mount();
  await click(replyButton());
  assert.match(
    form().querySelector('.notification-reply-help')!.textContent!,
    /Aster \(@aster\).*開発の相談.*shared in that room/,
  );
  assert.equal(textarea().value, '');
  assert.equal(sendButton().disabled, true);
  await input('  @all and @nova are quoted here. Please continue, Aster.  ');
  await submit();
  assert.equal(replies().length, 1);
  assert.equal(replies()[0].path, '/api/notifications/notice_aster/reply');
  assert.deepEqual(Object.keys(replies()[0].body).sort(), ['body', 'requestId']);
  assert.equal(replies()[0].body.body, '@all and @nova are quoted here. Please continue, Aster.');
  assert.match(
    replies()[0].body.requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.deepEqual(navigations, [{ view: 'chat', roomId: 'room_original' }]);
  assert.equal(mutations.length, 0);
  assert.equal(refreshCount, 1);
  assert.equal(card().querySelector('form'), null);
  assert.match(card().textContent!, /Reply sent/);
});

test('a successful reply stays sent when refreshing the latest snapshot fails', async () => {
  await mount();
  refreshFailure = new Error('Synthetic refresh failure');
  await click(replyButton());
  await input('Accepted before the refresh fails.');
  await submit();
  assert.equal(replies().length, 1);
  assert.deepEqual(navigations, [{ view: 'chat', roomId: 'room_original' }]);
  assert.equal(card().querySelector('form'), null);
  assert.equal(card().querySelector('[role="alert"]'), null);
  assert.ok(toasts.some((toast) => /Your reply was sent, but/.test(toast.message)));
  assert.ok(toasts.some((toast) => /Reply sent to Aster/.test(toast.message)));
});

test('failed sends preserve the draft and reuse the same request ID until the reply text changes', async () => {
  await mount();
  replyHandler = () => {
    throw new Error('Synthetic lost response');
  };
  await click(replyButton());
  await input('Please keep the first plan.');
  await submit();
  const requestId = replies()[0].body.requestId;
  assert.equal(textarea().value, 'Please keep the first plan.');
  assert.match(card().querySelector('[role="alert"]')!.textContent!, /draft is kept/);
  await rerender({
    ...state,
    notifications: state.notifications.map((n) => ({ ...n, read: true })),
  });
  await submit();
  assert.equal(replies()[1].body.requestId, requestId);
  await input('I revised the plan. Please use this reply.');
  replyHandler = (call) => Response.json(accepted(call));
  await submit();
  assert.notEqual(replies()[2].body.requestId, requestId);
  assert.equal(replies()[2].body.body, 'I revised the plan. Please use this reply.');
  assert.equal(navigations.length, 1);
});

test('a pending reply cannot be submitted twice or discarded while its request is in flight', async (t) => {
  await mount();
  let release!: (response: Response) => void;
  replyHandler = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  t.after(() => release?.(Response.json(accepted(replies()[0]))));
  await click(replyButton());
  await input('Exactly one reply.');
  await act(async () => {
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(replies().length, 1);
  assert.equal(sendButton().disabled, true);
  assert.equal(textarea().disabled, true);
  assert.equal(button('Cancel', form()).disabled, true);
  await rerender({
    ...state,
    notifications: state.notifications.map((n) => ({ ...n, read: true })),
  });
  assert.equal(textarea().value, 'Exactly one reply.');
  await act(async () => release(Response.json(accepted(replies()[0]))));
  assert.equal(navigations.length, 1);
  assert.equal(replies().length, 1);
});

test('disconnection preserves an editable draft and blocks posting until reconnection', async () => {
  await mount();
  await click(replyButton());
  await input('Before disconnect.');
  await rerender(state, { connected: false });
  assert.equal(textarea().disabled, false);
  await input('Edited while disconnected.');
  assert.equal(sendButton().disabled, true);
  await submit();
  assert.equal(replies().length, 0);
  assert.match(form().textContent!, /Reconnect to send/);
  await rerender(state, { connected: true });
  assert.equal(textarea().value, 'Edited while disconnected.');
  assert.equal(sendButton().disabled, false);
  await submit();
  assert.equal(replies()[0].body.body, 'Edited while disconnected.');
});

test('read filtering and live snapshots retain an open reply without allowing a second competing draft', async () => {
  const data = fixture();
  data.notifications.push(
    notice({
      id: 'notice_nova',
      taskId: 'task_bot_nova',
      sender: { kind: 'bot', botId: 'bot_nova', name: 'Nova', handle: 'nova' },
    }),
  );
  await mount(data);
  await click(replyButton());
  await input('Draft retained through read state changes.');
  const originalField = textarea();
  assert.equal(replyButton('notice_nova').disabled, true);
  await click(document.querySelectorAll<HTMLButtonElement>('.page-tabs button')[1]);
  const updated = { ...data, notifications: data.notifications.map((n) => ({ ...n, read: true })) };
  await rerender(updated);
  assert.equal(textarea(), originalField);
  assert.equal(textarea().value, 'Draft retained through read state changes.');
  assert.equal(document.querySelector('[data-notification-id="notice_nova"]'), null);
  assert.match(document.querySelector('.notification-filter-note')!.textContent!, /stay visible/);
  await click(document.querySelectorAll<HTMLButtonElement>('.page-tabs button')[0]);
  assert.equal(textarea().value, 'Draft retained through read state changes.');
  await click(button('Cancel', form()));
  assert.equal(replyButton('notice_nova').disabled, false);
});

test('unavailable bots and rooms cannot be replied to or replaced with another room recipient', async () => {
  const cases: { change: (data: Snapshot) => void; reason: RegExp; openRoom: boolean }[] = [
    {
      change: (data) => {
        data.bots.find((b) => b.id === 'bot_aster')!.enabled = false;
      },
      reason: /Enable this bot/,
      openRoom: true,
    },
    {
      change: (data) => {
        data.rooms[0].archived = true;
      },
      reason: /Restore the archived room/,
      openRoom: false,
    },
    {
      change: (data) => {
        data.rooms = [];
      },
      reason: /original room is unavailable/,
      openRoom: false,
    },
    {
      change: (data) => {
        data.rooms[0].botIds = ['bot_nova'];
      },
      reason: /no longer a member/,
      openRoom: true,
    },
    {
      change: (data) => {
        data.tasks[0].botId = 'bot_nova';
      },
      reason: /records do not match/,
      openRoom: true,
    },
  ];
  for (const item of cases) {
    const data = fixture();
    item.change(data);
    await mount(data);
    assert.equal(replyButton().disabled, true);
    assert.match(card().textContent!, item.reason);
    assert.equal(
      [...card().querySelectorAll('button')].some((b) => b.textContent === 'Open conversation'),
      item.openRoom,
    );
    await click(replyButton());
    assert.equal(card().querySelector('form'), null);
    assert.equal(replies().length, 0);
  }
});

test('a changed or removed notification cannot silently retarget or erase an open draft', async () => {
  await mount();
  await click(replyButton());
  await input('Keep this exact draft.');
  const changed = {
    ...state,
    notifications: state.notifications.map((n) => ({
      ...n,
      sender: { kind: 'bot' as const, botId: 'bot_nova', name: 'Nova', handle: 'nova' },
      taskId: 'task_bot_nova',
    })),
  };
  await rerender(changed);
  assert.equal(textarea().value, 'Keep this exact draft.');
  assert.equal(sendButton().disabled, true);
  assert.match(card().textContent!, /recipient or original notice changed/);
  await submit();
  assert.equal(replies().length, 0);
  await rerender({ ...changed, notifications: [] });
  assert.equal(textarea().value, 'Keep this exact draft.');
  assert.equal(sendButton().disabled, true);
  assert.match(card().textContent!, /no longer in the current data/);
  await submit();
  assert.equal(replies().length, 0);
});

test('a paused room accepts a reply into the queue without issuing a resume action', async () => {
  const data = fixture();
  data.rooms[0].paused = true;
  await mount(data);
  await click(replyButton());
  await input('Continue after I resume the room.');
  assert.match(form().textContent!, /room is paused.*reply will be saved/);
  assert.equal(sendButton().disabled, false);
  await submit();
  assert.equal(replies().length, 1);
  assert.equal(
    calls.some((call) => call.path.endsWith('/resume')),
    false,
  );
  assert.equal(mutations.length, 0);
});

test('IME composition never submits a partial reply while Ctrl Enter sends a completed draft', async () => {
  await mount();
  await click(replyButton());
  await input('日本語の返信');
  await act(async () => {
    textarea().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    textarea().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(replies().length, 0);
  await act(async () =>
    textarea().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })),
  );
  await act(async () =>
    textarea().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert.equal(replies().length, 1);
  assert.equal(replies()[0].body.body, '日本語の返信');
});

test('HTTP LAN browsers without randomUUID still send a valid stable request ID', async (t) => {
  await mount();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  const realCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) },
  });
  t.after(() => Object.defineProperty(globalThis, 'crypto', descriptor));
  await click(replyButton());
  await input('Reply from an HTTP LAN browser.');
  await submit();
  assert.equal(replies().length, 1);
  assert.match(
    replies()[0].body.requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test('long Japanese sender and room names retain full labels and accessible reply controls at a narrow viewport', async () => {
  const data = fixture();
  const name = '進行管理と品質確認を担当するボット'.repeat(4);
  data.bots.find((b) => b.id === 'bot_aster')!.name = name;
  data.notifications[0] = notice({
    sender: { kind: 'bot', botId: 'bot_aster', name, handle: 'aster' },
    body: '確認したいことがあります。'.repeat(30),
  });
  data.rooms[0].name = '設計と実装の進行状況を相談するルーム'.repeat(4);
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 390 });
  await mount(data, 'ja');
  assert.equal(card().querySelector('.notification-sender strong')!.textContent, name);
  assert.match(
    card().querySelector('.notification-room')!.textContent!,
    new RegExp(data.rooms[0].name),
  );
  await click(replyButton());
  assert.equal(form().querySelector('label')!.getAttribute('for'), textarea().id);
  assert.ok(document.getElementById(textarea().getAttribute('aria-describedby')!));
  assert.equal(textarea().maxLength, 32_000);
  assert.equal(sendButton().textContent, '返信を送信');
  await input('長い名前を省略せずに相手を確認できました。');
  assert.equal(sendButton().disabled, false);
});

test('chat preserves a collapsed notification quote and rerenders changed reply metadata', async () => {
  const data = fixture();
  const reply: NotificationReplyContext = {
    notificationId: 'notice_aster',
    roomId: 'room_original',
    botId: 'bot_aster',
    senderName: 'Aster',
    senderHandle: 'aster',
    title: 'Original question',
    body:
      'Original details\n<script>quoted text only</script>\n' + 'Additional context. '.repeat(30),
    createdAt: stamp,
  };
  const message: Message = {
    id: 'message_reply',
    roomId: 'room_original',
    authorType: 'user',
    authorId: 'user',
    body: 'Yes, please proceed.',
    status: 'complete',
    createdAt: stamp,
    targetBotIds: ['bot_aster'],
    notificationReply: reply,
  };
  data.messages = [
    message,
    {
      ...message,
      id: 'bot_message',
      authorType: 'bot',
      authorId: 'bot_aster',
      targetBotIds: undefined,
    },
  ];
  await mount(data);
  await rerender(data, { view: 'chat' }, true);
  const quote = document.querySelector<HTMLDetailsElement>(
    '[data-notification-reply-quote="notice_aster"]',
  )!;
  assert.ok(quote);
  assert.equal(document.querySelectorAll('[data-notification-reply-quote]').length, 1);
  assert.equal(quote.open, false);
  assert.match(
    quote.querySelector('summary')!.textContent!,
    /Reply to notification.*Aster.*@aster.*Original question/,
  );
  await click(quote.querySelector('summary')!);
  assert.equal(quote.open, true);
  // Markdown normalizes paragraph whitespace without changing the saved source.
  assert.equal(quote.querySelector('blockquote')!.textContent?.trimEnd(), reply.body.trimEnd());
  assert.equal(data.messages[0].notificationReply?.body, reply.body);
  assert.equal(quote.querySelector('script'), null);
  const changed = {
    ...data,
    messages: [
      { ...message, notificationReply: { ...reply, title: 'Updated stored title' } },
      data.messages[1],
    ],
  };
  await rerender(changed, {}, true);
  assert.match(
    document.querySelector('[data-notification-reply-quote] summary')!.textContent!,
    /Updated stored title/,
  );
});

test('desktop notifications identify the sender and open the inbox for direct reply', async (t) => {
  await mount(fixture());
  await act(async () => root!.unmount());
  const created: FakeNotification[] = [];
  class FakeNotification {
    static permission = 'granted';
    onclick?: () => void;
    closed = false;
    constructor(
      public title: string,
      public options: NotificationOptions,
    ) {
      created.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  const originalFocus = dom.window.focus;
  let focused = 0;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: FakeNotification,
  });
  Object.defineProperty(dom.window, 'Notification', {
    configurable: true,
    value: FakeNotification,
  });
  dom.window.focus = () => {
    focused++;
  };
  t.after(() => {
    if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
    else Reflect.deleteProperty(document, 'visibilityState');
    dom.window.focus = originalFocus;
  });
  localStorage.clear();
  localStorage.setItem('loom.notifications', 'true');
  localStorage.setItem('loom.locale', 'ja');
  root = createRoot(document.getElementById('root')!);
  await act(async () => root!.render(<App />));
  assert.equal(created.length, 0, 'Existing notices are not replayed as desktop notifications.');
  state = {
    ...state,
    notifications: [...state.notifications, notice({ id: 'desktop_notice', title: '追加の質問' })],
  };
  await act(async () => {
    for (const stream of streams)
      stream.onmessage?.({ data: JSON.stringify({ type: 'snapshot', data: state }) });
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].title, 'Aster (@aster) · 追加の質問');
  await act(async () => created[0].onclick?.());
  assert.equal(focused, 1);
  assert.equal(created[0].closed, true);
  assert.ok(document.querySelector('article[data-notification-id="desktop_notice"]'));
  assert.equal(document.querySelector('.page-header h1')!.textContent, 'お知らせ');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});
