import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Message, NotificationReplyContext, ServerEvent, Snapshot } from '../src/shared/types';

// Semantic rendering and interaction coverage. Chrome smoke covers real layout.
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
  'HTMLDetailsElement',
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
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
Object.defineProperty(dom.window, 'innerWidth', { value: 1440, configurable: true });
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
const { applyEvent } = await import('../src/client/api');
const { Chat } = await import('../src/client/Chat');
const { InboxPage } = await import('../src/client/InboxPage');

const stamp = '2026-11-10T00:00:00.000Z';
const prose = [
  '## 調査結果',
  '',
  '**重要** と `status`',
  '',
  '- [x] 確認済み',
  '- [ ] 続きを確認',
  '',
  '| 項目 | 値 |',
  '| --- | --- |',
  '| 判定 | OK |',
  '',
  '> 元の情報',
  '',
  '[参考](https://example.com/reference)',
  '',
  '```ts',
  'const status = "**literal**";',
  '```',
].join('\n');
const rawTool = '{"path":"**literal**.md","html":"<img src=x onerror=alert(1)>"}';

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
    bots: [
      {
        id: 'bot',
        name: 'Aster',
        handle: 'aster',
        role: 'Research',
        systemPrompt: 'Use the supplied fixture.',
        avatar: 'sparkles',
        color: '#829479',
        enabled: true,
        createdAt: stamp,
      },
    ],
    rooms: [
      {
        id: 'room',
        name: 'Markdown review',
        description: '',
        botIds: ['bot'],
        archived: false,
        pinned: false,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    tasks: [
      {
        id: 'task',
        roomId: 'room',
        botId: 'bot',
        rootTaskId: 'task',
        depth: 0,
        kind: 'chat',
        prompt: 'Review the result.',
        status: 'running',
        output: '',
        inputTokens: 0,
        outputTokens: 0,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    messages: [
      {
        id: 'message',
        roomId: 'room',
        taskId: 'task',
        authorType: 'bot',
        authorId: 'bot',
        body: '',
        status: 'streaming',
        createdAt: stamp,
      },
    ],
    activities: [],
    approvals: [],
    skills: [],
    memories: [],
    automations: [],
    notifications: [
      {
        id: 'notice',
        roomId: 'room',
        taskId: 'task',
        sender: { kind: 'bot', botId: 'bot', name: 'Aster', handle: 'aster' },
        title: 'Notice **title**',
        body: prose,
        read: false,
        createdAt: stamp,
      },
    ],
    queue: { active: 1, waiting: 0 },
  };
}
let root: ReturnType<typeof createRoot> | undefined;
let state: Snapshot;
let view: 'chat' | 'inbox';
async function mount(data = fixture(), nextView: 'chat' | 'inbox' = 'chat') {
  if (root) await act(async () => root!.unmount());
  localStorage.clear();
  localStorage.setItem('loom.activity', 'true');
  view = nextView;
  state = data;
  root = createRoot(document.getElementById('root')!);
  await rerender();
}
async function rerender() {
  const context: AppContextValue = {
    data: state,
    locale: 'en',
    connected: true,
    view,
    roomId: 'room',
    t: (_ja, en) => en,
    navigate() {},
    toast() {},
    async refresh() {},
    async signOut() {},
    async mutate<T>(path: string): Promise<T> {
      throw new Error(`Unexpected mutation: ${path}`);
    },
  };
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        {view === 'chat' ? <Chat room={state.rooms[0]} /> : <InboxPage />}
      </AppContext.Provider>,
    ),
  );
}
async function emit(type: ServerEvent['type'], data: ServerEvent['data']) {
  state = applyEvent(state, { id: 1, type, data })!;
  await rerender();
}
function element<T extends HTMLElement = HTMLElement>(
  selector: string,
  scope: ParentNode = document,
) {
  const found = scope.querySelector<T>(selector);
  assert.ok(found, `Missing ${selector}`);
  return found;
}
function assertRichProse(scope: ParentNode) {
  assert.equal(element('h2', scope).textContent, '調査結果');
  assert.equal(element('strong', scope).textContent, '重要');
  assert.equal(element('p code', scope).textContent, 'status');
  const checks = [...scope.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]')];
  assert.deepEqual(
    checks.map((input) => [input.checked, input.disabled]),
    [
      [true, true],
      [false, true],
    ],
  );
  assert.deepEqual(
    [...scope.querySelectorAll('tbody td')].map((cell) => cell.textContent),
    ['判定', 'OK'],
  );
  assert.equal(element('p', element('blockquote', scope)).textContent, '元の情報');
  const link = element<HTMLAnchorElement>('a', scope);
  assert.equal(link.href, 'https://example.com/reference');
  assert.equal(link.target, '_blank');
  assert.ok(link.relList.contains('noopener'));
  assert.ok(link.relList.contains('noreferrer'));
  const code = element('pre code', scope);
  assert.equal(code.textContent, 'const status = "**literal**";\n');
  assert.equal(code.querySelector('strong'), null);
}
function quoteMessage(body: string): Message {
  const reply: NotificationReplyContext = {
    notificationId: 'notice',
    roomId: 'room',
    botId: 'bot',
    senderName: 'Aster',
    senderHandle: 'aster',
    title: 'Notice **title**',
    body,
    createdAt: stamp,
  };
  return {
    id: 'reply',
    roomId: 'room',
    authorType: 'user',
    authorId: 'user',
    body: 'Proceed with the review.',
    notificationReply: reply,
    status: 'complete',
    createdAt: stamp,
  };
}
after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});

test('answer, reasoning and progress surfaces render Markdown while tool records stay literal', async () => {
  const data = fixture();
  data.messages[0] = {
    ...data.messages[0],
    body: prose,
    reasoning: prose,
    reasoningStatus: 'complete',
  };
  data.activities = [
    {
      id: 'progress',
      messageId: 'message',
      taskId: 'task',
      roomId: 'room',
      botId: 'bot',
      kind: 'progress',
      title: 'Progress note',
      detail: prose,
      status: 'success',
      createdAt: stamp,
    },
    {
      id: 'tool',
      messageId: 'message',
      taskId: 'task',
      roomId: 'room',
      botId: 'bot',
      kind: 'tool',
      title: 'Read exact arguments',
      detail: rawTool,
      status: 'success',
      createdAt: stamp,
    },
  ];
  await mount(data);
  for (const selector of [
    '.message-answer',
    '.reasoning-text',
    '.run-note',
    '.activity-timeline .markdown',
  ])
    assertRichProse(element(selector));
  const tool = element('[data-activity-id="tool"]');
  assert.equal(element('pre', tool).textContent, rawTool);
  assert.equal(tool.querySelector('.markdown, img'), null);
  const timelineLogs = document.querySelectorAll('.activity-timeline pre');
  assert.ok([...timelineLogs].some((log) => log.textContent === rawTool));
  assert.equal(document.querySelector('.activity-timeline img'), null);
});

test('incremental reasoning parses unfinished Markdown and preserves scrolling and collapse choices', async () => {
  await mount();
  assert.equal(document.querySelector('.reasoning-panel'), null);
  await emit('message_reasoning_delta', { messageId: 'message', delta: '## 検討\n\n**調査' });
  const panel = element<HTMLDetailsElement>('.reasoning-panel');
  const text = element('.reasoning-text');
  assert.equal(panel.open, true);
  assert.equal(element('h2', text).textContent, '検討');
  assert.equal(text.querySelector('strong'), null);
  assert.match(text.textContent!, /\*\*調査/);
  Object.defineProperty(text, 'scrollHeight', { configurable: true, value: 900 });
  Object.defineProperty(text, 'clientHeight', { configurable: true, value: 100 });
  text.scrollTop = 800;
  await act(async () => text.dispatchEvent(new Event('scroll', { bubbles: true })));
  await emit('message_reasoning_delta', {
    messageId: 'message',
    delta: '済み**\n\n```ts\nconst value = 1;',
  });
  assert.equal(element('strong', text).textContent, '調査済み');
  assert.equal(element('pre code', text).textContent, 'const value = 1;\n');
  assert.equal(text.scrollTop, 900, 'following readers continue to the latest reasoning');
  text.scrollTop = 120;
  await act(async () => text.dispatchEvent(new Event('scroll', { bubbles: true })));
  await act(async () => element('summary', panel).click());
  assert.equal(panel.open, false);
  await emit('message_reasoning_delta', { messageId: 'message', delta: '\n```\n\n- 続きを確認' });
  assert.equal(
    document.querySelector('.reasoning-text'),
    text,
    'streaming retains the scroll container',
  );
  assert.equal(text.scrollTop, 120, 'reading earlier reasoning does not jump to the latest output');
  assert.equal(panel.open, false, 'incoming tokens do not reopen the user-collapsed section');
  assert.equal(element('li', text).textContent, '続きを確認');
  await emit('message_updated', { messageId: 'message', patch: { reasoningStatus: 'complete' } });
  assert.doesNotMatch(element('summary', panel).textContent!, /Streaming/);
  assert.equal(
    document.querySelector('.message-answer'),
    null,
    'reasoning does not become an answer',
  );
});

test('notification bodies and their chat reply quotes use the same Markdown rendering', async () => {
  const data = fixture();
  await mount(data, 'inbox');
  const notice = element('[data-notification-id="notice"]');
  assert.equal(element('.notification-body', notice).tagName, 'DIV');
  assertRichProse(element('.notification-body', notice));
  assert.equal(element('.notification-content > h2', notice).textContent, 'Notice **title**');
  data.messages = [quoteMessage(prose)];
  data.tasks = [];
  await mount(data);
  const quote = element<HTMLDetailsElement>('[data-notification-reply-quote="notice"]');
  assert.equal(quote.open, false);
  await act(async () => element('summary', quote).click());
  assert.equal(quote.open, true);
  assertRichProse(element(':scope > blockquote .markdown', quote));
});

test('rendered bot prose does not turn raw HTML or unsafe links into active content', async () => {
  const unsafe = [
    '[unsafe](javascript:alert%281%29)',
    '',
    '<script>window.untrusted = true</script>',
    '',
    '<img src="x" onerror="window.untrusted = true">',
    '',
    '[safe](https://example.com/reference)',
  ].join('\n');
  function assertInert(scope: ParentNode) {
    assert.equal(scope.querySelector('script, img, iframe, [onerror], [onclick]'), null);
    for (const link of scope.querySelectorAll<HTMLAnchorElement>('a'))
      assert.doesNotMatch(link.getAttribute('href') ?? '', /^javascript:/i);
    assert.ok(scope.querySelector('a[href="https://example.com/reference"]'));
  }
  const data = fixture();
  data.messages[0] = {
    ...data.messages[0],
    body: unsafe,
    reasoning: unsafe,
    reasoningStatus: 'streaming',
  };
  data.messages.push(quoteMessage(unsafe));
  await mount(data);
  for (const selector of [
    '.message-bot .message-answer',
    '.reasoning-text',
    '.notification-reply-quote > blockquote',
  ])
    assertInert(element(selector));
  data.notifications[0].body = unsafe;
  await mount(data, 'inbox');
  assertInert(element('.notification-body'));
});
