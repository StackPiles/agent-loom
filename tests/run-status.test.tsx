import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Message, Snapshot, Task, TaskStatus } from '../src/shared/types';
import { getTaskPresentation, getTaskStatus } from '../src/client/task-status';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3210',
  pretendToBeVisual: true,
});
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
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
});
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('../src/client/context');
const { Status } = await import('../src/client/components');
const { RunProgress } = await import('../src/client/RunProgress');

const now = '2026-11-01T00:00:00.000Z';
function task(status: TaskStatus = 'running'): Task {
  return {
    id: 'task',
    botId: 'aster',
    roomId: 'room',
    prompt: 'Inspect a fixture',
    rootTaskId: 'task',
    depth: 0,
    kind: 'chat',
    output: '',
    status,
    createdAt: now,
    updatedAt: now,
    inputTokens: 0,
    outputTokens: 0,
  };
}
function message(patch: Partial<Message> = {}): Message {
  return {
    id: 'message',
    taskId: 'task',
    roomId: 'room',
    authorId: 'aster',
    authorType: 'bot',
    status: 'streaming',
    body: '',
    createdAt: now,
    ...patch,
  };
}
function fixture(): Snapshot {
  return {
    version: 'test',
    settings: {
      model: {
        baseUrl: '',
        modelId: '',
        apiKeyConfigured: false,
        contextWindow: 32768,
        maxOutputTokens: 4096,
        temperature: 0.7,
      },
      demoMode: false,
      autoLearn: false,
      maxHandoffs: 6,
      workspacePath: '/tmp/fixture',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'ask' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: [
      {
        id: 'aster',
        name: 'Aster',
        handle: 'aster',
        role: 'Inspect',
        avatar: 'sparkles',
        color: '#829479',
        systemPrompt: '',
        enabled: true,
        createdAt: now,
      },
    ],
    rooms: [],
    messages: [message()],
    tasks: [task()],
    activities: [],
    approvals: [],
    skills: [],
    memories: [],
    automations: [],
    notifications: [],
    queue: { active: 1, waiting: 0 },
  };
}
let root: ReturnType<typeof createRoot> | undefined;
let state: Snapshot;
let context: AppContextValue;
let renderChildren: () => React.ReactNode;
const mutations: string[] = [];
async function mount(data: Snapshot, children: () => React.ReactNode, connected = true) {
  if (root) await act(async () => root!.unmount());
  state = data;
  mutations.length = 0;
  context = {
    data,
    connected,
    locale: 'en',
    t: (_ja, en) => en,
    view: 'chat',
    roomId: 'room',
    navigate() {},
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string) {
      mutations.push(path);
      return {} as T;
    },
  };
  renderChildren = children;
  root = createRoot(document.getElementById('root')!);
  await rerender();
}
async function rerender() {
  context = { ...context, data: state };
  await act(async () =>
    root!.render(<AppContext.Provider value={context}>{renderChildren()}</AppContext.Provider>),
  );
}
after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});

test('task phases separate queue admission, first output, reasoning, response and tool work', () => {
  const empty = message();
  const reasoning = message({ reasoning: 'Inspect the file.', reasoningStatus: 'streaming' });
  const text = message({ body: 'Here is the result.' });
  assert.equal(getTaskPresentation('queued', 'en', { message: text }).phase, 'queued');
  const waiting = getTaskPresentation('waiting_model', 'en', { message: text });
  assert.equal(waiting.phase, 'waiting_model');
  assert.equal(waiting.label, 'Waiting for generation slot');
  assert.equal(waiting.animated, false);
  assert.equal(getTaskPresentation('running', 'en', { message: empty }).phase, 'preparing');
  assert.equal(getTaskPresentation('running', 'en', { message: reasoning }).phase, 'thinking');
  assert.equal(getTaskPresentation('running', 'en', { message: text }).phase, 'generating');
  assert.equal(getTaskPresentation('waiting_tool', 'en', { message: reasoning }).phase, 'tool');
  assert.equal(
    getTaskPresentation('running', 'en', { message: text, hasPendingApproval: true }).phase,
    'approval',
  );
  for (const waitingReason of ['room', 'session', 'worker', 'inference'] as const) {
    const view = getTaskPresentation('running', 'en', { message: text, waitingReason });
    assert.equal(view.animated, false);
    assert.match(view.detail, /Waiting/);
  }
});

test('terminal states win over stale streaming, approvals, queue records and disconnected state', () => {
  for (const status of ['stopped', 'interrupted', 'failed', 'completed'] as const) {
    const view = getTaskPresentation(status, 'ja', {
      message: message({
        body: 'Old text',
        reasoning: 'Old reasoning',
        reasoningStatus: 'streaming',
      }),
      waitingReason: 'inference',
      hasPendingApproval: true,
      connected: false,
    });
    assert.equal(view.phase, status);
    assert.equal(view.animated, false);
    assert.equal(view.active, false);
    assert.equal(view.resumable, status !== 'completed');
  }
  const disconnected = getTaskPresentation('running', 'en', {
    message: message({ body: 'Partial' }),
    connected: false,
  });
  assert.equal(disconnected.phase, 'unconfirmed');
  assert.equal(disconnected.animated, false);
  assert.equal(disconnected.active, true);
  assert.match(disconnected.detail, /last received state/);
});

test('task lookup uses the latest owning bot message and keeps simultaneous bot states independent', () => {
  const data = fixture();
  data.messages = [
    message({
      id: 'old',
      body: 'Old response',
      reasoning: 'Old thought',
      reasoningStatus: 'streaming',
    }),
    message({ id: 'new', createdAt: '2026-11-01T00:01:00.000Z' }),
  ];
  assert.equal(getTaskStatus(data.tasks[0], data, 'en').phase, 'preparing');
  const second = { ...task(), id: 'second', botId: 'nova', status: 'awaiting_approval' as const };
  data.tasks.push(second);
  data.messages[1] = { ...data.messages[1], body: 'New answer' };
  data.messages.push(
    message({ id: 'other', taskId: 'second', authorId: 'nova', body: 'I will write the file.' }),
  );
  assert.equal(getTaskStatus(data.tasks[0], data, 'en').phase, 'generating');
  assert.equal(getTaskStatus(second, data, 'en').phase, 'approval');
});

test('status labels use nonanimated icons for queued, approval, stopped and connection uncertainty', async () => {
  await mount(fixture(), () => (
    <Status
      status={state.tasks[0].status}
      presentation={getTaskStatus(state.tasks[0], state, context.locale, context.connected)}
    />
  ));
  assert.equal(
    document.querySelector('[data-task-phase]')?.getAttribute('data-task-phase'),
    'preparing',
  );
  assert.ok(document.querySelector('.status .spin'));
  for (const status of [
    'queued',
    'waiting_model',
    'awaiting_approval',
    'stopped',
    'interrupted',
    'completed',
    'failed',
  ] as const) {
    state.tasks[0] = { ...state.tasks[0], status };
    await rerender();
    assert.equal(document.querySelectorAll('.status .spin, .status .pulse').length, 0);
    assert.ok(document.querySelector(`.status-${status}`));
    assert.ok(document.querySelector('.status svg'));
  }
  state.tasks[0] = { ...state.tasks[0], status: 'running' };
  context.connected = false;
  await rerender();
  assert.match(document.body.textContent || '', /Status unconfirmed/);
  assert.equal(document.querySelectorAll('.status .spin, .status .pulse').length, 0);
});

test('run progress stops reasoning animation on tools, approval, stopping and connection loss', async () => {
  const data = fixture();
  data.messages[0] = message({ reasoning: 'Inspect the fixture.', reasoningStatus: 'streaming' });
  await mount(data, () => <RunProgress taskId="task" message={state.messages[0]} />);
  assert.ok(document.querySelector('.reasoning-phase .spin'));
  assert.match(
    document.querySelector('.run-status-line')?.textContent || '',
    /Generating reasoning/,
  );
  state.tasks[0] = { ...state.tasks[0], status: 'waiting_tool' };
  await rerender();
  assert.equal(document.querySelector('.reasoning-phase .spin'), null);
  assert.match(document.querySelector('.run-state-detail')?.textContent || '', /tool/);
  state.tasks[0] = { ...state.tasks[0], status: 'awaiting_approval' };
  await rerender();
  assert.equal(document.querySelectorAll('.run-progress .spin, .run-progress .pulse').length, 0);
  assert.match(document.querySelector('.run-state-detail')?.textContent || '', /approve or deny/);
  state.tasks[0] = { ...state.tasks[0], status: 'running' };
  context.connected = false;
  await rerender();
  assert.match(document.querySelector('.run-status-line')?.textContent || '', /Status unconfirmed/);
  assert.equal(document.querySelectorAll('.run-progress .spin, .run-progress .pulse').length, 0);
  state.tasks[0] = { ...state.tasks[0], status: 'stopped' };
  await rerender();
  assert.match(document.querySelector('.run-status-line')?.textContent || '', /Stopped/);
  assert.match(document.querySelector('.run-status-line')?.textContent || '', /Resume/);
  assert.doesNotMatch(document.querySelector('.reasoning-phase')?.textContent || '', /Streaming/);
  state.tasks[0] = { ...state.tasks[0], status: 'completed' };
  await rerender();
  assert.match(document.querySelector('.run-status-line')?.textContent || '', /Completed/);
  assert.equal(document.querySelector('.reasoning-phase'), null);
  assert.equal(document.querySelectorAll('.run-progress .spin, .run-progress .pulse').length, 0);
});

test('resumed runs retain history while only the latest run can animate or stop', async () => {
  const data = fixture();
  data.messages = [
    message({
      id: 'old',
      status: 'error',
      reasoning: 'Interrupted reasoning',
      reasoningStatus: 'streaming',
    }),
    message({
      id: 'new',
      createdAt: '2026-11-01T00:01:00.000Z',
      reasoning: 'Fresh reasoning',
      reasoningStatus: 'streaming',
    }),
  ];
  data.activities = [
    {
      id: 'old-step',
      taskId: 'task',
      roomId: 'room',
      botId: 'aster',
      messageId: 'old',
      title: 'Previous tool',
      detail: '',
      kind: 'tool',
      status: 'running',
      createdAt: now,
    },
  ];
  await mount(data, () => (
    <>
      {state.messages.map((item) => (
        <RunProgress key={item.id} taskId="task" message={item} />
      ))}
    </>
  ));
  const previous = document.querySelector('[data-run-message-id="old"]')!;
  const current = document.querySelector('[data-run-message-id="new"]')!;
  assert.match(previous.textContent || '', /Previous run interrupted/);
  assert.equal(previous.querySelectorAll('.spin, .pulse').length, 0);
  assert.equal(previous.querySelector('button'), null);
  assert.match(previous.querySelector('.run-step-status')?.textContent || '', /Interrupted/);
  assert.ok(current.querySelector('.reasoning-phase .spin'));
  const stop = [...current.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Stop',
  )!;
  await act(async () => stop.click());
  assert.deepEqual(mutations, ['/tasks/task/stop']);
  state.tasks[0] = { ...state.tasks[0], status: 'stopped' };
  await rerender();
  assert.equal(document.querySelectorAll('.spin, .pulse').length, 0);
  const resumes = [...document.querySelectorAll('button')].filter(
    (button) => button.textContent?.trim() === 'Resume',
  );
  assert.equal(resumes.length, 1);
  await act(async () => resumes[0].click());
  assert.deepEqual(mutations, ['/tasks/task/stop', '/tasks/task/resume']);
});

test('queue reasons and disconnected state are not presented as active generation', async () => {
  const data = fixture();
  data.tasks[0] = task('waiting_model');
  data.messages[0] = message({
    body: 'Previous turn content',
    reasoning: 'Previous turn thought',
    reasoningStatus: 'streaming',
  });
  data.queue.waitingTasks = [{ taskId: 'task', reason: 'room' }];
  await mount(data, () => <RunProgress taskId="task" message={state.messages[0]} />);
  assert.match(
    document.querySelector('.run-status-line')?.textContent || '',
    /Waiting for this room/,
  );
  assert.ok(document.querySelector('[data-queue-reason="room"]'));
  assert.equal(document.querySelectorAll('.spin, .pulse').length, 0);
  context.connected = false;
  await rerender();
  assert.equal(document.querySelector('[data-queue-reason]'), null);
  assert.match(
    document.querySelector('.run-state-detail')?.textContent || '',
    /last received state/,
  );
});
