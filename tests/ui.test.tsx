import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { Approval, Message, ServerEvent, Snapshot, Task } from '../src/shared/types';

// DOM interaction coverage, not a substitute for real-browser rendering checks.
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
    dispatchEvent() {
      return true;
    },
  }),
});
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
let root: ReturnType<typeof createRoot> | undefined;
let state: Snapshot;
let deferredStateResponse: Promise<Response> | null = null;
let authRequired = false;
const calls: { path: string; method: string; body: any }[] = [];
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
const now = '2026-10-30T10:00:00.000Z';
function fixture(): Snapshot {
  return {
    version: '0.1.0',
    settings: {
      demoMode: true,
      autoLearn: true,
      maxHandoffs: 3,
      workspacePath: './workspace',
      model: {
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'test-local',
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
        id: 'bot_aria',
        name: 'Aria',
        handle: 'aria',
        role: 'Research',
        systemPrompt: 'Research carefully.',
        avatar: '✦',
        color: '#829479',
        enabled: true,
        createdAt: now,
      },
      {
        id: 'bot_mira',
        name: 'Mira',
        handle: 'mira',
        role: 'Review',
        systemPrompt: 'Review carefully.',
        avatar: '◈',
        color: '#7e94aa',
        enabled: true,
        createdAt: now,
      },
    ],
    rooms: [
      {
        id: 'room_lounge',
        name: 'Lounge',
        description: 'Think together.',
        botIds: ['bot_aria', 'bot_mira'],
        archived: false,
        pinned: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'room_research',
        name: 'Research',
        description: 'Keep the evidence.',
        botIds: ['bot_aria'],
        archived: false,
        pinned: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
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
Object.assign(globalThis, {
  fetch: async (url: string, options: RequestInit = {}) => {
    const path = String(url);
    const method = options.method || 'GET';
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
    calls.push({ path, method, body });
    let result: unknown = { ok: true };
    if (path === '/api/state' && deferredStateResponse) {
      const pending = deferredStateResponse;
      deferredStateResponse = null;
      return pending;
    }
    if (path === '/api/state') result = structuredClone(state);
    else if (path === '/api/auth' && method === 'GET')
      result = { required: authRequired, authenticated: true };
    else if (path === '/api/auth' && method === 'DELETE') result = { ok: true };
    else if (path === '/api/settings/test' && method === 'POST')
      result = { ok: true, models: ['test-local'], message: 'Discovery succeeded.' };
    else if (path === '/api/rooms' && method === 'POST') {
      const room = {
        ...body,
        id: 'room_created',
        pinned: false,
        archived: false,
        createdAt: now,
        updatedAt: now,
      };
      state.rooms.push(room);
      result = room;
    } else if (/\/api\/rooms\/[^/]+\/messages$/.test(path)) {
      const message = {
        id: 'message_user',
        roomId: path.split('/')[3],
        authorType: 'user' as const,
        authorId: 'user',
        body: body.body,
        status: 'complete' as const,
        createdAt: now,
      };
      state.messages.push(message);
      result = { message, tasks: [] };
    } else if (path.startsWith('/api/approvals/')) {
      const approval = state.approvals.find((item) => item.id === path.split('/').at(-1));
      assert.ok(approval);
      approval.status = body.decision === 'approve' ? 'approved' : 'denied';
      result = approval;
    } else if (path.includes('/api/tasks/') && path.endsWith('/resume')) {
      const task = state.tasks.find((item) => item.id === path.split('/')[3]);
      assert.ok(task);
      task.status = 'queued';
      result = task;
    } else if (path.includes('/api/tasks/') && path.endsWith('/stop')) {
      const task = state.tasks.find((item) => item.id === path.split('/')[3]);
      assert.ok(task);
      task.status = 'stopped';
      result = task;
    } else if (method !== 'GET') throw new Error(`Unexpected mutation: ${method} ${path}`);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});
async function mount(next = fixture(), resetStorage = true) {
  if (root) await act(async () => root?.unmount());
  state = next;
  calls.length = 0;
  deferredStateResponse = null;
  authRequired = false;
  if (resetStorage) {
    localStorage.clear();
    localStorage.setItem('loom.locale', 'en');
    localStorage.setItem('loom.activity', 'false');
  }
  root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root!.render(<App />);
  });
}
async function click(element: Element | null) {
  assert.ok(element, 'Expected a clickable element');
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}
async function input(element: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  assert.ok(element);
  await act(async () => {
    const prototype =
      element.tagName === 'TEXTAREA'
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    if (element.tagName === 'TEXTAREA') element.setSelectionRange(value.length, value.length);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function key(element: Element, name: string, extra: KeyboardEventInit = {}) {
  await act(async () => {
    element.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: name,
        bubbles: true,
        cancelable: true,
        ...extra,
      }),
    );
  });
}
function button(label: string, scope: ParentNode = document) {
  return (
    [...scope.querySelectorAll('button')].find(
      (item) =>
        item.textContent?.trim() === label ||
        [...item.querySelectorAll(':scope > span')].some((span) => span.textContent === label),
    ) || null
  );
}
function makeTask(id: string, status: Task['status']): Task {
  return {
    id,
    status,
    roomId: 'room_lounge',
    botId: 'bot_aria',
    rootTaskId: id,
    depth: 0,
    kind: 'chat',
    prompt: `Work ${id}`,
    output: '',
    inputTokens: 0,
    outputTokens: 0,
    createdAt: now,
    updatedAt: now,
  };
}
async function emit(type: ServerEvent['type'], data: ServerEvent['data']) {
  await act(async () => {
    for (const stream of streams)
      stream.onmessage?.({ data: JSON.stringify({ id: Date.now(), type, data }) });
  });
}
function runMessage(id: string, taskId: string, createdAt = now): Message {
  return {
    id,
    taskId,
    roomId: 'room_lounge',
    authorType: 'bot',
    authorId: 'bot_aria',
    body: '',
    status: 'streaming',
    createdAt,
  };
}

test('rooms remain discoverable, persist selection, and create through the real form', async () => {
  await mount();
  assert.match(document.body.textContent || '', /No messages yet/);
  assert.equal(document.querySelectorAll('.message').length, 0, 'No fabricated production history');
  await click(button('Research', document.querySelector('.room-nav')!));
  assert.equal(document.querySelector('.room-heading h1')?.textContent, 'Research');
  assert.equal(localStorage.getItem('loom.room'), 'room_research');
  await mount(state, false);
  assert.equal(
    document.querySelector('.room-heading h1')?.textContent,
    'Research',
    'Room selection survives a remount',
  );
  await click(document.querySelector('button[aria-label="Create room"]'));
  await input(document.querySelector('dialog input'), 'Product plans');
  await act(async () => {
    document
      .querySelector('dialog form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(
    calls.filter((call) => call.path === '/api/rooms' && call.method === 'POST').length,
    1,
  );
  assert.equal(document.querySelector('.room-heading h1')?.textContent, 'Product plans');
  assert.equal(localStorage.getItem('loom.room'), 'room_created');
  assert.ok(button('Product plans', document.querySelector('.room-nav')!));
  assert.equal(document.querySelector('dialog'), null);
});

test('short-handle keyboard completion inserts a mention without sending, then sends once', async () => {
  await mount();
  const textarea = document.querySelector('textarea')!;
  await input(textarea, '@ar');
  assert.equal(document.querySelectorAll('#mention-menu [role="option"]').length, 1);
  assert.match(document.querySelector('#mention-menu')!.textContent || '', /@aria/);
  await key(textarea, 'Enter');
  assert.equal(textarea.value, '@aria ');
  assert.equal(calls.filter((call) => call.path.endsWith('/messages')).length, 0);
  await input(textarea, '@aria Check this idea');
  await key(textarea, 'Enter', { isComposing: true });
  assert.equal(
    calls.filter((call) => call.path.endsWith('/messages')).length,
    0,
    'IME composition does not send',
  );
  await key(textarea, 'Enter', { shiftKey: true });
  assert.equal(
    calls.filter((call) => call.path.endsWith('/messages')).length,
    0,
    'Shift+Enter preserves browser newline behavior rather than sending',
  );
  await key(textarea, 'Enter');
  const sends = calls.filter((call) => call.path.endsWith('/messages'));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.body, '@aria Check this idea');
  assert.equal(textarea.value, '');
  assert.match(document.querySelector('.message-user')?.textContent || '', /Check this idea/);
});

test('approval cards show the exact target and arguments and submit distinct approve/deny decisions', async () => {
  const next = fixture();
  const approval = (
    id: string,
    toolName: string,
    target: string,
    args: Record<string, unknown>,
  ): Approval => ({
    id,
    toolName,
    target,
    args,
    summary: `Review ${toolName}`,
    roomId: 'room_lounge',
    botId: 'bot_aria',
    taskId: `task_${id}`,
    status: 'pending',
    createdAt: now,
  });
  next.approvals = [
    approval('shell_action', 'shell', './workspace', { command: 'pwd', timeout: 5000 }),
    approval('write_action', 'write_file', './workspace/notes.md', {
      path: 'notes.md',
      content: '# A reviewable change',
    }),
  ];
  await mount(next);
  const cards = [...document.querySelectorAll('.approval-card')];
  assert.equal(cards.length, 2);
  assert.match(cards[0].textContent || '', /"command": "pwd"/);
  assert.match(cards[0].textContent || '', /\.\/workspace/);
  assert.match(cards[1].textContent || '', /# A reviewable change/);
  await click(button('Deny', cards[0]));
  await click(button('Approve', document.querySelector('.approval-card')!));
  const decisions = calls.filter((call) => call.path.startsWith('/api/approvals/'));
  assert.deepEqual(
    decisions.map((call) => [call.path, call.body.decision]),
    [
      ['/api/approvals/shell_action', 'deny'],
      ['/api/approvals/write_action', 'approve'],
    ],
  );
  assert.equal(document.querySelectorAll('.approval-card').length, 0);
});

test('interrupted work has an explicit resume action and queued work can be stopped', async () => {
  const next = fixture();
  next.tasks = [makeTask('resume_me', 'interrupted')];
  await mount(next);
  assert.match(document.body.textContent || '', /Interrupted · resumable/);
  await click(button('Resume'));
  assert.ok(calls.some((call) => call.path === '/api/tasks/resume_me/resume'));
  assert.match(document.querySelector('.run-progress')?.textContent || '', /Queued/);
  assert.equal(button('Resume'), null);
  await click(document.querySelector('button[aria-label="Stop work in this room"]'));
  assert.ok(calls.some((call) => call.path === '/api/tasks/resume_me/stop'));
  assert.match(document.querySelector('.run-progress')?.textContent || '', /Stopped/);
  assert.ok(button('Resume'));
});

test('SSE text deltas render live and connection loss remains visible', async () => {
  const next = fixture();
  next.messages = [
    {
      id: 'streaming_message',
      roomId: 'room_lounge',
      authorType: 'bot',
      authorId: 'bot_aria',
      body: 'First',
      status: 'streaming',
      createdAt: now,
    },
  ];
  await mount(next);
  await act(async () => {
    for (const stream of streams)
      stream.onmessage?.({
        data: JSON.stringify({
          id: 1,
          type: 'message_delta',
          data: { messageId: 'streaming_message', delta: ' and second' },
        }),
      });
  });
  assert.match(document.querySelector('.message-bot')?.textContent || '', /First and second/);
  await act(async () => {
    for (const stream of streams) stream.onerror?.();
  });
  assert.match(
    document.querySelector('.connection-banner')?.textContent || '',
    /Connection interrupted/,
  );
  assert.ok(button('Retry'));
});

test('unsent room drafts stay isolated and survive navigation and remounts', async () => {
  await mount();
  await input(document.querySelector('textarea'), 'Lounge draft');
  await click(button('Research', document.querySelector('.room-nav')!));
  assert.equal(document.querySelector('textarea')?.value, '');
  await input(document.querySelector('textarea'), 'Research draft');
  await click(button('Lounge', document.querySelector('.room-nav')!));
  assert.equal(document.querySelector('textarea')?.value, 'Lounge draft');
  await mount(state, false);
  assert.equal(document.querySelector('textarea')?.value, 'Lounge draft');
  await click(button('Research', document.querySelector('.room-nav')!));
  assert.equal(document.querySelector('textarea')?.value, 'Research draft');
});

test('command palette opens by keyboard, selects by Enter, and dialogs handle native cancel', async () => {
  await mount();
  await key(document.body, 'k', { ctrlKey: true });
  const dialog = document.querySelector('dialog');
  assert.ok(dialog?.open);
  assert.ok(
    document.getElementById(dialog.getAttribute('aria-labelledby') || ''),
    'The native dialog has an accessible title',
  );
  await input(document.querySelector('.command-search input'), 'Research');
  await key(document.querySelector('.command-search input')!, 'Enter');
  assert.equal(document.querySelector('dialog'), null);
  assert.equal(document.querySelector('.room-heading h1')?.textContent, 'Research');
  await click(document.querySelector('button[aria-label="Create room"]'));
  assert.ok(
    document.activeElement === document.querySelector('dialog input'),
    'The editable room name receives initial focus',
  );
  await act(async () => {
    document
      .querySelector('dialog')!
      .dispatchEvent(new dom.window.Event('cancel', { cancelable: true }));
  });
  assert.equal(document.querySelector('dialog'), null);
});

test('a delayed state refresh cannot rewind a newer SSE snapshot and streaming text', async () => {
  const next = fixture();
  next.messages = [
    {
      id: 'streaming_message',
      roomId: 'room_lounge',
      authorType: 'bot',
      authorId: 'bot_aria',
      body: 'Old response',
      status: 'streaming',
      createdAt: now,
    },
  ];
  await mount(next);
  const staleSnapshot = structuredClone(state);
  let release!: (response: Response) => void;
  deferredStateResponse = new Promise((resolve) => {
    release = resolve;
  });
  await act(async () => {
    for (const stream of streams) stream.onerror?.();
  });
  await click(button('Retry'));
  assert.equal(
    deferredStateResponse,
    null,
    'The refresh request is waiting on its deferred response',
  );
  state = structuredClone(state);
  state.messages[0].body = 'Newer snapshot';
  await act(async () => {
    for (const stream of streams) {
      stream.onmessage?.({ data: JSON.stringify({ id: 2, type: 'snapshot', data: state }) });
      stream.onmessage?.({
        data: JSON.stringify({
          id: 3,
          type: 'message_delta',
          data: { messageId: 'streaming_message', delta: ' and live text' },
        }),
      });
    }
  });
  assert.match(
    document.querySelector('.message-bot')?.textContent || '',
    /Newer snapshot and live text/,
  );
  await act(async () => {
    release(
      new Response(JSON.stringify(staleSnapshot), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  assert.match(
    document.querySelector('.message-bot')?.textContent || '',
    /Newer snapshot and live text/,
  );
  assert.doesNotMatch(document.querySelector('.message-bot')?.textContent || '', /Old response/);
});

test('model-key guidance explains origin binding and tests send only explicitly entered keys', async () => {
  const next = fixture();
  next.settings.model.apiKeyConfigured = true;
  await mount(next);
  await click(button('Settings', document.querySelector('.sidebar-footer')!));
  assert.match(
    document.querySelector('#model-settings')?.textContent || '',
    /same origin \(scheme, host, and port\)/,
  );
  assert.match(
    document.querySelector('#model-settings')?.textContent || '',
    /Changing origin clears it on save/,
  );
  await input(
    document.querySelector('#model-settings input[type="url"]'),
    'https://new-provider.example/v1',
  );
  await click(button('Test connection'));
  assert.equal(
    calls.filter((call) => call.path === '/api/settings/test').at(-1)?.body.apiKey,
    undefined,
  );
  await input(
    document.querySelector('#model-settings input[type="password"]'),
    'explicit-demo-key',
  );
  await click(button('Test connection'));
  assert.equal(
    calls.filter((call) => call.path === '/api/settings/test').at(-1)?.body.apiKey,
    'explicit-demo-key',
  );
});

test('protected workspaces can sign out from Settings and disconnect the live stream', async () => {
  await mount();
  authRequired = true;
  await click(button('Settings', document.querySelector('.sidebar-footer')!));
  await click(button('Sign out'));
  assert.ok(calls.some((call) => call.path === '/api/auth' && call.method === 'DELETE'));
  assert.match(document.querySelector('.auth-card')?.textContent || '', /Connect to Agent Loom/);
  assert.equal(streams.size, 0);
  await mount();
  await click(button('Settings', document.querySelector('.sidebar-footer')!));
  assert.equal(button('Sign out'), null, 'Token-free workspaces do not show sign out');
});

test('provider reasoning and tool steps update inside chat without duplicating the final answer', async () => {
  const next = fixture();
  next.tasks = [makeTask('live_run', 'running')];
  next.messages = [runMessage('live_message', 'live_run')];
  await mount(next);
  assert.equal(document.querySelector('.activity-panel'), null);
  assert.equal(
    document.querySelector('.reasoning-panel'),
    null,
    'No reasoning UI is invented before a provider supplies content',
  );
  await emit('message_reasoning_delta', {
    messageId: 'live_message',
    delta: 'Inspect the existing file first.',
  });
  assert.equal(
    document.querySelector('.reasoning-text')?.textContent,
    'Inspect the existing file first.',
  );
  assert.equal((document.querySelector('.reasoning-panel') as HTMLDetailsElement).open, true);
  assert.equal(document.querySelector('.message-answer'), null);
  await click(document.querySelector('.reasoning-panel>summary'));
  await emit('message_reasoning_delta', {
    messageId: 'live_message',
    delta: ' Then compare the results.',
  });
  assert.equal(
    (document.querySelector('.reasoning-panel') as HTMLDetailsElement).open,
    false,
    'Streaming respects the user’s collapsed section',
  );
  await emit('message_updated', {
    messageId: 'live_message',
    patch: { reasoningStatus: 'complete' },
  });
  assert.doesNotMatch(
    document.querySelector('.reasoning-panel>summary')?.textContent || '',
    /Streaming/,
  );
  state.messages[0].reasoning = 'Inspect the existing file first. Then compare the results.';
  state.messages[0].reasoningStatus = 'complete';
  state.tasks[0].status = 'waiting_tool';
  state.activities = [
    {
      id: 'inspect_step',
      messageId: 'live_message',
      roomId: 'room_lounge',
      botId: 'bot_aria',
      taskId: 'live_run',
      kind: 'tool',
      title: 'read_file',
      detail: '{"path":"notes.md"}',
      status: 'running',
      createdAt: now,
    },
    {
      id: 'auto_step',
      messageId: 'live_message',
      roomId: 'room_lounge',
      botId: 'bot_aria',
      taskId: 'live_run',
      kind: 'approval',
      title: 'Automatically approved',
      approvalRule: 'public_web_read',
      detail: 'Only reads a public page.\n{"url":"https://example.com"}',
      status: 'success',
      createdAt: now,
    },
  ];
  await emit('snapshot', state);
  const progress = document.querySelector('.message-bot .run-progress')!;
  assert.match(progress.textContent || '', /read_file/);
  assert.match(progress.textContent || '', /"path":"notes.md"/);
  assert.match(progress.textContent || '', /Automatically approved: Read a public page/);
  await emit('message_delta', { messageId: 'live_message', delta: 'I will check the page.' });
  assert.equal(document.querySelector('.message-answer')?.textContent, 'I will check the page.');
  await emit('message_updated', { messageId: 'live_message', patch: { body: '' } });
  assert.equal(
    document.querySelector('.message-answer'),
    null,
    'Intermediate tool-turn narration is cleared immediately',
  );
  state.activities.push({
    id: 'progress_step',
    messageId: 'live_message',
    roomId: 'room_lounge',
    botId: 'bot_aria',
    taskId: 'live_run',
    kind: 'progress',
    title: 'Agent update',
    detail: 'I will check the page.',
    status: 'success',
    createdAt: now,
  });
  await emit('snapshot', state);
  assert.equal(
    document.querySelector('.run-note .markdown')?.textContent,
    'I will check the page.',
  );
  await emit('message_delta', {
    messageId: 'live_message',
    delta: 'The final comparison is ready.',
  });
  await emit('message_updated', { messageId: 'live_message', patch: { status: 'complete' } });
  assert.equal(
    document.querySelector('.message-answer')?.textContent,
    'The final comparison is ready.',
  );
  assert.equal(
    (
      document
        .querySelector('.message-bot')
        ?.textContent?.match(/The final comparison is ready\./g) || []
    ).length,
    1,
  );
  assert.equal(document.querySelectorAll('.run-note').length, 1);
});

test('resumed runs keep their own tool history and show pending approvals at the current response', async () => {
  const next = fixture();
  next.tasks = [makeTask('resumed_task', 'awaiting_approval')];
  next.messages = [
    { ...runMessage('first_run', 'resumed_task', '2026-10-30T10:00:00.000Z'), status: 'error' },
    runMessage('second_run', 'resumed_task', '2026-10-30T10:03:00.000Z'),
  ];
  const activity = (id: string, messageId: string | undefined, createdAt: string) => ({
    id,
    messageId,
    createdAt,
    roomId: 'room_lounge',
    botId: 'bot_aria',
    taskId: 'resumed_task',
    kind: 'tool' as const,
    title: id,
    detail: `Exact arguments for ${id}`,
    status: 'success' as const,
  });
  next.activities = [
    activity('first_tool', 'first_run', '2026-10-30T10:01:00.000Z'),
    activity('legacy_first', undefined, '2026-10-30T10:02:00.000Z'),
    activity('second_tool', 'second_run', '2026-10-30T10:04:00.000Z'),
    activity('legacy_second', undefined, '2026-10-30T10:05:00.000Z'),
  ];
  next.approvals = [
    {
      id: 'review_current',
      roomId: 'room_lounge',
      botId: 'bot_aria',
      taskId: 'resumed_task',
      toolName: 'write_file',
      summary: 'Replace the existing notes',
      target: './workspace/' + 'very-long-folder-name/'.repeat(8) + 'notes.md',
      args: { path: 'notes.md', content: 'Reviewed replacement' },
      status: 'pending',
      createdAt: '2026-10-30T10:05:01.000Z',
    },
  ];
  await mount(next);
  const first = document.querySelector('[data-run-message-id="first_run"]')!;
  const second = document.querySelector('[data-run-message-id="second_run"]')!;
  assert.match(first.textContent || '', /first_tool/);
  assert.match(first.textContent || '', /legacy_first/);
  assert.doesNotMatch(first.textContent || '', /second_tool|legacy_second/);
  assert.match(second.textContent || '', /second_tool/);
  assert.match(second.textContent || '', /legacy_second/);
  assert.doesNotMatch(second.textContent || '', /first_tool|legacy_first/);
  assert.equal(button('Stop', first), null, 'A previous run cannot stop the current run');
  assert.ok(button('Stop', second));
  assert.equal(first.querySelector('.approval-card'), null);
  assert.equal(document.querySelectorAll('.approval-card').length, 1);
  assert.ok(second.querySelector('.approval-card'));
  assert.match(second.querySelector('.approval-card')?.textContent || '', /Reviewed replacement/);
  assert.equal(
    document.querySelector('.reasoning-panel'),
    null,
    'Tool logs do not masquerade as provider reasoning',
  );
  await click(button('Approve', second));
  assert.ok(
    calls.some(
      (call) => call.path === '/api/approvals/review_current' && call.body.decision === 'approve',
    ),
  );
  assert.equal(second.querySelector('.approval-card'), null);
  assert.match(second.querySelector('.approval-result')?.textContent || '', /Approved/);
});

test('narrow layouts do not reopen a persisted activity drawer and expose explicit dismissal', async () => {
  const originalWidth = window.innerWidth;
  try {
    await mount();
    localStorage.setItem('loom.activity', 'true');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 768 });
    await mount(state, false);
    assert.equal(document.querySelector('.activity-panel'), null);
    await click(document.querySelector('button[aria-label="Toggle activity"]'));
    assert.ok(document.querySelector('.activity-panel'));
    assert.ok(document.querySelector('.activity-scrim'));
    await key(document.body, 'Escape');
    assert.equal(document.querySelector('.activity-panel'), null);
    await click(document.querySelector('button[aria-label="Toggle activity"]'));
    await click(document.querySelector('.activity-scrim'));
    assert.equal(document.querySelector('.activity-panel'), null);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
    await click(document.querySelector('button[aria-label="Toggle activity"]'));
    assert.ok(document.querySelector('.activity-panel'));
    await act(async () => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
      window.dispatchEvent(new dom.window.Event('resize'));
    });
    assert.equal(
      document.querySelector('.activity-panel'),
      null,
      'Resizing into a narrow viewport closes the desktop panel',
    );
  } finally {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
  }
});

test('main pages use direct functional headings instead of promotional copy', async () => {
  await mount();
  assert.doesNotMatch(
    document.body.textContent || '',
    /Good ideas|good company|You and your AI teammates/,
  );
  for (const label of ['Bots', 'Automations', 'Memory & skills', 'Inbox']) {
    await click(button(label, document.querySelector('.main-nav')!));
    assert.equal(document.querySelector('.page-header h1')?.textContent, label);
    assert.equal(document.querySelector('.page-header .eyebrow'), null);
  }
  await click(document.querySelector('button[aria-label="日本語に切り替え"]'));
  assert.equal(document.querySelector('.page-header h1')?.textContent, 'お知らせ');
  assert.doesNotMatch(
    document.body.textContent || '',
    /あなたと、AIの仲間たち|それぞれの得意を|静かな時間/,
  );
});

test('pending approvals remain reachable when their original response is outside the loaded message window', async () => {
  const next = fixture();
  next.tasks = [makeTask('older_pending', 'awaiting_approval')];
  next.messages = [
    runMessage('older_response', 'older_pending'),
    ...Array.from({ length: 105 }, (_, index): Message => ({
      id: `later_${index}`,
      roomId: 'room_lounge',
      authorType: 'user',
      authorId: 'user',
      body: `Later message ${index}`,
      status: 'complete',
      createdAt: '2026-10-30T11:00:00.000Z',
    })),
  ];
  next.approvals = [
    {
      id: 'older_approval',
      roomId: 'room_lounge',
      botId: 'bot_aria',
      taskId: 'older_pending',
      toolName: 'shell',
      summary: 'Review this command',
      target: './workspace',
      args: { command: 'npm test' },
      status: 'pending',
      createdAt: '2026-10-30T10:01:00.000Z',
    },
  ];
  await mount(next);
  assert.ok(document.querySelector('.load-earlier'));
  assert.equal(document.querySelectorAll('.approval-card').length, 1);
  assert.match(
    document.querySelector('.standalone-runs .approval-card')?.textContent || '',
    /npm test/,
  );
  assert.ok(button('Approve', document.querySelector('.standalone-runs')!));
});

test('streamed reasoning preserves the reading position when the user has scrolled upward', async () => {
  const next = fixture();
  next.tasks = [makeTask('reading_task', 'running')];
  next.messages = [runMessage('reading_response', 'reading_task')];
  await mount(next);
  const scroll = document.querySelector('.message-scroll') as HTMLDivElement;
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 2000 });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 });
  await act(async () => {
    scroll.scrollTop = 100;
    scroll.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  });
  await emit('message_reasoning_delta', {
    messageId: 'reading_response',
    delta: 'Provider reasoning while the user reads an earlier message.',
  });
  assert.equal(scroll.scrollTop, 100);
  assert.ok(document.querySelector('.jump-latest'));
});

after(async () => {
  if (root) await act(async () => root?.unmount());
  dom.window.close();
});
