import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { SchedulingGrant } from '../src/shared/scheduling';
import type { Snapshot, Task } from '../src/shared/types';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3210',
  pretendToBeVisual: true,
});
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLDialogElement',
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
const { TaskQueue, TaskQueueButton } = await import('../src/client/TaskQueue');
const { TaskScheduling } = await import('../src/client/TaskScheduling');
const { RunProgress } = await import('../src/client/RunProgress');

const stamp = '2026-11-09T00:00:00.000Z';
function task(id: string, status: Task['status'] = 'queued', patch: Partial<Task> = {}): Task {
  return {
    id,
    roomId: 'room',
    botId: 'aster',
    rootTaskId: id,
    depth: 0,
    kind: 'chat',
    status,
    prompt: `Work ${id}`,
    output: '',
    inputTokens: 0,
    outputTokens: 0,
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  };
}
function grant(patch: Partial<SchedulingGrant> = {}): SchedulingGrant {
  return {
    id: 'grant',
    source: 'owner',
    reason: 'Please finish the response first.',
    requestedAt: new Date(Date.now()).toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    remainingRequests: 2,
    grantedRequests: 3,
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
        role: 'Research',
        systemPrompt: '',
        color: '#829479',
        avatar: 'sparkles',
        enabled: true,
        createdAt: stamp,
      },
    ],
    rooms: [
      {
        id: 'room',
        name: 'Research',
        description: '',
        botIds: ['aster'],
        archived: false,
        pinned: false,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    messages: [],
    tasks: [task('running', 'running'), task('queued')],
    activities: [],
    approvals: [],
    skills: [],
    memories: [],
    automations: [],
    notifications: [],
    queue: {
      active: 1,
      waiting: 1,
      capacity: 2,
      waitingTasks: [{ taskId: 'queued', reason: 'session' }],
      scheduling: [
        {
          taskId: 'running',
          groupId: 'running',
          purpose: 'compaction',
          occupiedMs: 1000,
          lastDispatchReason: 'fair',
        },
        {
          taskId: 'queued',
          groupId: 'queued',
          purpose: 'response',
          occupiedMs: 0,
          blockingTaskId: 'running',
        },
      ],
    },
  };
}

let root: ReturnType<typeof createRoot> | undefined;
let state: Snapshot;
let context: AppContextValue;
let renderChildren: () => React.ReactNode;
const mutations: Array<{ path: string; method?: string; body?: unknown }> = [];
let mutation: (() => Promise<unknown>) | undefined;

async function mount(data = fixture(), children = () => <TaskQueue onClose={() => {}} />) {
  if (root) await act(async () => root!.unmount());
  state = data;
  mutations.length = 0;
  mutation = undefined;
  context = {
    data,
    connected: true,
    locale: 'en',
    t: (_ja, en) => en,
    view: 'chat',
    roomId: 'room',
    navigate() {},
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string, method?: string, body?: unknown) {
      mutations.push({ path, method, body });
      return (mutation ? await mutation() : {}) as T;
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
function action(id: string, kind = 'request'): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-task-scheduling="${id}"] [data-priority-action="${kind}"]`,
  );
  assert.ok(button, `${id} has a ${kind} action`);
  return button;
}
after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});

test('the global queue exposes a same-bot queued task independently from the running task', async () => {
  await mount(fixture(), () => <TaskQueueButton />);
  const trigger = document.querySelector<HTMLButtonElement>('.task-queue-trigger')!;
  assert.equal(trigger.getAttribute('aria-label'), 'Open task queue (2)');
  await act(async () => trigger.click());
  assert.ok(document.querySelector('dialog[open]'));
  assert.equal(document.querySelectorAll('[data-queue-task]').length, 2);
  assert.match(document.querySelector('[data-queue-task="queued"]')!.textContent!, /previous task/);
  assert.match(
    document.querySelector('[data-queue-task="running"]')!.textContent!,
    /Context summary/,
  );
  await act(async () => action('queued').click());
  assert.deepEqual(mutations, [{ path: '/tasks/queued/priority', method: 'POST', body: {} }]);
});

test('effective work grants show shared remaining calls and can be revoked without stopping work', async () => {
  const data = fixture();
  const allowance = grant();
  data.tasks[0].scheduling = { grant: allowance };
  data.tasks[1].rootTaskId = 'running';
  data.queue.scheduling![1].groupId = 'running';
  for (const info of data.queue.scheduling!) info.grant = allowance;
  await mount(data);
  for (const id of ['running', 'queued']) {
    const row = document.querySelector(`[data-queue-task="${id}"]`)!;
    assert.match(row.textContent!, /Your priority request · 2 remaining/);
    assert.equal(action(id).disabled, true, 'a shared owner allowance cannot be refilled');
  }
  await act(async () => action('queued', 'revoke').click());
  assert.deepEqual(mutations, [
    { path: '/tasks/queued/priority', method: 'DELETE', body: undefined },
  ]);
});

test('bot priority may be upgraded after its request is used but revoked grants keep their cooldown', async () => {
  const data = fixture();
  const allowance = grant({ source: 'bot', remainingRequests: 0, grantedRequests: 1 });
  data.queue.scheduling![1].grant = allowance;
  await mount(data);
  assert.equal(action('queued').disabled, false);
  assert.match(action('queued').title, /including requests already used/);
  await act(async () => action('queued').click());
  assert.equal(mutations[0].method, 'POST');
  allowance.revokedAt = new Date().toISOString();
  await rerender();
  assert.equal(action('queued').disabled, true);
  assert.match(
    document.querySelector('[data-queue-task="queued"]')!.textContent!,
    /Priority cancelled/,
  );
  assert.equal(
    document.querySelector('[data-task-scheduling="queued"] [data-priority-action="revoke"]'),
    null,
  );
});

test('grant expiry enables another request without requiring a server snapshot', async (t) => {
  let time = Date.now();
  t.mock.method(Date, 'now', () => time);
  let onExpiry: (() => void) | undefined;
  t.mock.method(dom.window, 'setTimeout', (callback: () => void) => {
    onExpiry = callback;
    return 12345;
  });
  t.mock.method(dom.window, 'clearTimeout', () => {});
  const data = fixture();
  const allowance = grant({ remainingRequests: 0 });
  data.queue.scheduling![1].grant = allowance;
  await mount(data, () => <TaskScheduling task={state.tasks[1]} />);
  assert.equal(action('queued').disabled, true);
  assert.ok(onExpiry);
  time = Date.parse(allowance.expiresAt) + 1;
  await act(async () => onExpiry!());
  assert.equal(action('queued').disabled, false);
  assert.doesNotMatch(document.body.textContent!, /allowance has been used/);
});

test('an unavailable earlier allowance keeps its cooldown without offering a no-op upgrade', async () => {
  const data = fixture();
  const allowance = grant({ source: 'bot', remainingRequests: 0, grantedRequests: 1 });
  data.queue.scheduling![1].grant = allowance;
  data.queue.scheduling![1].grantUnavailable = true;
  await mount(data);
  assert.equal(action('queued').disabled, true);
  assert.match(action('queued').title, /unavailable.*after it expires/);
  assert.match(
    document.querySelector('[data-queue-task="queued"]')!.textContent!,
    /This priority allowance is unavailable/,
  );
  assert.doesNotMatch(document.body.textContent!, /Priority cancelled/);
  await act(async () => action('queued').click());
  assert.deepEqual(mutations, []);
});

test('merged bot requests cannot offer an owner upgrade after all three requests were spent', async () => {
  const data = fixture();
  data.queue.scheduling![1].grant = grant({
    source: 'bot',
    grantedRequests: 1,
    remainingRequests: 0,
    consumedRequests: 3,
  });
  await mount(data);
  assert.equal(action('queued').disabled, true);
  assert.match(action('queued').title, /cannot be refilled/);
  await act(async () => action('queued').click());
  assert.deepEqual(mutations, []);
});

test('priority actions are inert while disconnected, paused, disabled, or attached to blocked work', async () => {
  await mount();
  context.connected = false;
  await rerender();
  assert.equal(action('queued').disabled, true);
  await act(async () => action('queued').click());
  context.connected = true;
  state.rooms[0].paused = true;
  await rerender();
  assert.equal(action('queued').disabled, true);
  state.rooms[0].paused = false;
  state.bots[0].enabled = false;
  await rerender();
  assert.equal(action('queued').disabled, true);
  state.bots[0].enabled = true;
  state.tasks[1].workId = 'unavailable-work';
  await rerender();
  assert.equal(action('queued').disabled, true, 'a missing or inactive work must be reviewed');
  state.tasks[1].status = 'completed';
  await rerender();
  assert.equal(document.querySelector('[data-queue-task="queued"]'), null);
  state.tasks[0].kind = 'learning';
  await rerender();
  assert.equal(
    action('running').disabled,
    false,
    'owners can explicitly prioritize a learning review',
  );
  assert.deepEqual(mutations, []);
});

test('an effective queue record without a grant never revives raw task priority metadata', async () => {
  const data = fixture();
  data.tasks[1].scheduling = { grant: grant() };
  await mount(data);
  assert.equal(action('queued').disabled, false);
  assert.doesNotMatch(
    document.querySelector('[data-queue-task="queued"]')!.textContent!,
    /2 remaining/,
  );
  data.queue.scheduling = undefined;
  data.tasks[1].scheduling.grantRedirect = {
    taskId: 'different-group',
    grantId: 'different-grant',
  };
  await rerender();
  assert.doesNotMatch(
    document.querySelector('[data-queue-task="queued"]')!.textContent!,
    /2 remaining/,
  );
});

test('one pending mutation locks every sibling action and a failed request permits retry', async () => {
  const data = fixture();
  data.tasks[1].rootTaskId = 'running';
  data.queue.scheduling![1].groupId = 'running';
  await mount(data);
  let reject: ((error: Error) => void) | undefined;
  mutation = () =>
    new Promise((_resolve, fail) => {
      reject = fail;
    });
  await act(async () => {
    action('running').click();
    action('queued').click();
  });
  assert.equal(mutations.length, 1, 'siblings cannot submit overlapping grants');
  assert.equal(action('running').disabled, true);
  assert.equal(action('queued').disabled, true);
  await act(async () => reject!(new Error('Synthetic network failure')));
  assert.equal(action('running').disabled, false);
  assert.equal(action('queued').disabled, false);
  mutation = undefined;
  await act(async () => action('queued').click());
  assert.equal(mutations.length, 2);
});

test('run progress distinguishes a blocking summary and preserves its ordinary stop control', async () => {
  const data = fixture();
  data.tasks[1].status = 'waiting_model';
  data.queue.waitingTasks![0].reason = 'inference';
  data.queue.scheduling![1].lastDispatchReason = 'waiting';
  await mount(data, () => <RunProgress taskId="queued" />);
  assert.match(document.querySelector('.run-queue-reason')!.textContent!, /Aster is summarizing/);
  assert.match(
    document.querySelector('[data-dispatch-reason="waiting"]')!.textContent!,
    /waited longer/,
  );
  assert.ok(document.querySelector('button[aria-label="Stop this task now"]'));
  assert.equal(action('queued').disabled, false);
});

test('a parked approval keeps its owner action clear in the queue and run progress', async () => {
  for (const status of ['awaiting_approval', 'waiting_tool'] as const) {
    const data = fixture();
    data.tasks[1].status = status;
    data.queue.waitingTasks![0].reason = 'worker';
    if (status === 'waiting_tool')
      data.approvals.push({
        id: 'pending-approval',
        taskId: 'queued',
        roomId: 'room',
        botId: 'aster',
        toolName: 'write_file',
        summary: 'Save the reviewed draft',
        target: 'draft.txt',
        args: {},
        status: 'pending',
        createdAt: stamp,
      });
    await mount(data, () => (
      <>
        <TaskQueue onClose={() => {}} />
        <RunProgress taskId="queued" />
      </>
    ));
    assert.match(
      document.querySelector('[data-queue-task="queued"] .task-queue-detail')!.textContent!,
      /approve or deny/,
    );
    assert.match(document.querySelector('.run-state-detail')!.textContent!, /approve or deny/);
    assert.equal(document.querySelector('.run-queue-reason'), null);
    if (status === 'waiting_tool')
      assert.ok(document.querySelector('[data-approval-id="pending-approval"]'));
  }
  state.approvals = [];
  await rerender();
  assert.match(document.querySelector('.run-queue-reason')!.textContent!, /turn to run/);
});
