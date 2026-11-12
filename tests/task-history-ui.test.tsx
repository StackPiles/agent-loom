import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Approval, Message, Snapshot, Task, TaskStatus } from '../src/shared/types';
import { DEFAULT_AUTONOMOUS_WAKEUP_POLICY } from '../src/shared/work';

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
const { RoomActivity } = await import('../src/client/RoomActivity');
const { RunProgress } = await import('../src/client/RunProgress');
const { TaskHistoryControls } = await import('../src/client/TaskHistory');

const stamp = '2026-11-11T11:00:00.000Z';
const later = '2026-11-11T12:00:00.000Z';
const roomId = 'room_history';
const primaryId = 'task_history_primary';
const secondaryId = 'task_history_secondary';
const outputId = 'task_history_output';
const archivedId = 'task_history_archived';
const originalPrompt =
  'ORIGINAL_HISTORY_INSTRUCTION\n保存した当初の指示。\n<script>notExecutable()</script>';
const originalError = 'SAVED_HISTORY_ERROR: the previous connection was interrupted.';

function task(id = primaryId, status: TaskStatus = 'failed'): Task {
  return {
    id,
    roomId,
    botId: 'bot_aster',
    rootTaskId: id,
    depth: 0,
    kind: 'automation',
    status,
    prompt: originalPrompt,
    output: '',
    error: originalError,
    createdAt: stamp,
    startedAt: stamp,
    updatedAt: later,
    completedAt: later,
    inputTokens: 5,
    outputTokens: 3,
  };
}
function message(): Message {
  return {
    id: 'message_history_output',
    roomId,
    taskId: outputId,
    authorType: 'bot',
    authorId: 'bot_aster',
    body: 'PRESERVED_HISTORY_OUTPUT: the previous partial result.',
    status: 'error',
    createdAt: later,
  };
}
function approval(taskId = primaryId): Approval {
  return {
    id: 'approval_history',
    roomId,
    taskId,
    botId: 'bot_aster',
    toolName: 'shell',
    summary: 'An unissued operation awaits approval.',
    target: '/tmp/history',
    args: {},
    status: 'pending',
    createdAt: later,
  };
}
function fixture(): Snapshot {
  const room = {
    id: roomId,
    name: 'History room',
    description: 'Keep the saved results.',
    botIds: ['bot_aster'],
    pinned: false,
    archived: false,
    createdAt: stamp,
    updatedAt: stamp,
    autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room' as const },
  };
  return {
    version: 'test',
    settings: {
      model: {
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'fixture',
        apiKeyConfigured: false,
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
        temperature: 0.7,
      },
      demoMode: false,
      autoLearn: false,
      maxHandoffs: 6,
      workspacePath: '/tmp/history',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: [
      {
        id: 'bot_aster',
        name: 'Aster',
        handle: 'aster',
        role: 'Review',
        systemPrompt: 'Review.',
        avatar: 'sparkles',
        color: '#829479',
        enabled: true,
        createdAt: stamp,
      },
    ],
    rooms: [room, { ...room, id: 'room_foreign', name: 'Other room' }],
    tasks: [
      { ...task(), workId: 'work_history', workRunId: 'run_history', wakeupId: 'wake_history' },
      task(secondaryId, 'stopped'),
      task(outputId),
      task('task_history_completed', 'completed'),
      { ...task(archivedId, 'interrupted'), archivedAt: stamp },
      task('task_history_active', 'running'),
      { ...task('task_history_foreign'), roomId: 'room_foreign' },
    ],
    messages: [message()],
    workItems: [
      {
        id: 'work_history',
        roomId,
        name: 'Current linked work',
        purpose: 'Review the accepted result.',
        kind: 'task',
        status: 'blocked',
        createdByBotId: 'bot_aster',
        sourceTaskId: primaryId,
        scope: 'Keep the saved results.',
        workspacePath: '/tmp/history',
        revision: 3,
        createdAt: stamp,
        updatedAt: later,
        checkpoint: {
          summary: 'CURRENT_HISTORY_WORK_STATE',
          completed: 'Submission accepted.',
          nextStep: 'Check the later result.',
          references: ['results/receipt.md'],
          doneWhen: 'The result is recorded.',
          pendingChecks: ['Check the service review later.'],
          uncertainActions: [],
        },
      },
    ],
    wakeups: [
      {
        id: 'wake_history',
        roomId,
        workId: 'work_history',
        workRunId: 'run_history',
        botId: 'bot_aster',
        createdByBotId: 'bot_aster',
        sourceTaskId: primaryId,
        key: 'history-later',
        reason: 'Wait for the service result.',
        prompt: 'NEW_WAKEUP_INSTRUCTION',
        schedule: {
          type: 'once',
          dateTime: '2026-11-12T09:00',
          timeZone: 'Asia/Tokyo',
          missedRunPolicy: 'run_once',
        },
        status: 'scheduled',
        nextRunAt: '2026-11-12T00:00:00.000Z',
        revision: 2,
        createdAt: stamp,
        updatedAt: later,
      },
    ],
    activities: [],
    approvals: [],
    skills: [],
    memories: [],
    automations: [],
    notifications: [],
    queue: { active: 1, waiting: 0 },
  };
}

type Mutation = { path: string; method?: string; body?: unknown };
let root: ReturnType<typeof createRoot> | undefined;
let state: Snapshot;
let context: AppContextValue;
let children: () => React.ReactNode;
let respond: (mutation: Mutation) => Promise<void>;
const mutations: Mutation[] = [];
const focusedTasks: string[] = [];
const navigations: { view: string; roomId?: string }[] = [];
async function mount(
  data = fixture(),
  surface: 'chat' | 'room' | 'run' | 'history' = 'chat',
  connected = true,
) {
  if (root) await act(async () => root!.unmount());
  localStorage.clear();
  localStorage.setItem('loom.activity', 'false');
  mutations.length = 0;
  focusedTasks.length = 0;
  navigations.length = 0;
  respond = async () => {};
  state = data;
  context = {
    data,
    connected,
    locale: 'ja',
    t: (ja) => ja,
    view: 'chat',
    roomId,
    navigate(view, targetRoomId) {
      navigations.push({ view, roomId: targetRoomId });
    },
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string, method?: string, body?: unknown) {
      const mutation = { path, method, body };
      mutations.push(mutation);
      await respond(mutation);
      return {} as T;
    },
  };
  children = () =>
    surface === 'chat' ? (
      <Chat room={state.rooms.find((room) => room.id === roomId)} />
    ) : surface === 'room' ? (
      <RoomActivity roomId={roomId} onFocusTask={(id) => focusedTasks.push(id)} />
    ) : surface === 'history' ? (
      <TaskHistoryControls
        roomId={roomId}
        pendingTaskIds={state.tasks.filter((task) => task.roomId === roomId).map((task) => task.id)}
      />
    ) : (
      <RunProgress taskId={primaryId} />
    );
  root = createRoot(document.getElementById('root')!);
  await render();
}
async function render() {
  context = { ...context, data: state };
  await act(async () =>
    root!.render(<AppContext.Provider value={context}>{children()}</AppContext.Provider>),
  );
}
function element<T extends HTMLElement = HTMLButtonElement>(
  selector: string,
  scope: ParentNode = document,
): T {
  const found = scope.querySelector<T>(selector);
  assert.ok(found, `Missing ${selector}`);
  return found;
}
async function click(target: HTMLElement) {
  await act(async () => target.click());
}
function rows(scope: ParentNode = document) {
  return [...scope.querySelectorAll('[data-history-task-id]')]
    .map((row) => row.getAttribute('data-history-task-id'))
    .sort();
}
function namedButton(label: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === label || button.getAttribute('aria-label') === label,
  );
  assert.ok(found, `Missing button ${label}`);
  return found;
}
async function openHistory(mode: 'review' | 'archived') {
  await click(
    element(
      mode === 'review'
        ? `[data-task-review-list="${roomId}"]`
        : `[data-task-history-open="${roomId}"]`,
    ),
  );
  const dialog = element<HTMLElement>(`[data-task-history="${roomId}"]`);
  assert.equal(dialog.getAttribute('data-history-mode'), mode);
  return dialog;
}
function archiveMutation(ids: string[], archived: boolean): Mutation {
  return { path: '/tasks/archive', method: 'POST', body: { roomId, taskIds: ids, archived } };
}
function assertArchiveMutation(actual: Mutation, ids: string[], archived: boolean) {
  const body = actual.body as { roomId: string; taskIds: string[]; archived: boolean };
  assert.deepEqual(
    { ...actual, body: { ...body, taskIds: [...body.taskIds].sort() } },
    archiveMutation([...ids].sort(), archived),
  );
}
after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});

test('Chat history controls count only this room’s unarchived standalone stopped tasks', async () => {
  await mount();
  const controls = element(`[data-task-history-controls="${roomId}"]`);
  assert.match(
    element('[data-task-review-list]', controls).textContent || '',
    /停止した作業を整理.*2/,
  );
  assert.match(element('[data-task-history-open]', controls).textContent || '', /タスク履歴.*1/);
  const standalone = document.querySelector('.standalone-runs')!;
  assert.ok(standalone.querySelector(`[data-task-id="${primaryId}"]`));
  assert.ok(standalone.querySelector('[data-task-id="task_history_active"]'));
  assert.equal(standalone.querySelector(`[data-task-id="${archivedId}"]`), null);
  assert.equal(standalone.querySelector(`[data-task-id="${outputId}"]`), null);
  const history = await openHistory('review');
  assert.deepEqual(rows(history), [primaryId, secondaryId].sort());
  assert.deepEqual(mutations, []);
});

test('selecting visible review rows archives only those tasks and reflects the streamed result', async () => {
  await mount();
  const before = structuredClone({
    messages: state.messages,
    workItems: state.workItems,
    wakeups: state.wakeups,
  });
  let history = await openHistory('review');
  await click(element('[data-task-select-visible]', history));
  assert.equal(element('[data-task-history-apply]', history).disabled, false);
  await click(element('[data-task-history-apply]', history));
  assert.equal(mutations.length, 1);
  assertArchiveMutation(mutations[0], [primaryId, secondaryId], true);
  state = structuredClone(state);
  for (const task of state.tasks)
    if ([primaryId, secondaryId].includes(task.id)) task.archivedAt = later;
  await render();
  history = element(`[data-task-history="${roomId}"]`);
  assert.equal(history.getAttribute('data-history-mode'), 'review');
  assert.deepEqual(rows(history), [], 'The open review reflects the authoritative archived state');
  assert.equal(element('[data-task-history-apply]', history).disabled, true);
  assert.deepEqual(
    { messages: state.messages, workItems: state.workItems, wakeups: state.wakeups },
    before,
  );
  assert.match(
    element('[data-message-id="message_history_output"]').textContent || '',
    /PRESERVED_HISTORY_OUTPUT/,
  );
});

test('live active, pending approval and archived changes cannot submit stale review selections', async () => {
  await mount();
  let history = await openHistory('review');
  await click(element(`[data-task-history-select="${primaryId}"]`, history));
  state = structuredClone(state);
  state.tasks.find((task) => task.id === primaryId)!.status = 'running';
  await render();
  history = element(`[data-task-history="${roomId}"]`);
  assert.equal(history.querySelector(`[data-history-task-id="${primaryId}"]`), null);
  assert.equal(element('[data-task-history-apply]', history).disabled, true);
  await click(element(`[data-task-history-select="${secondaryId}"]`, history));
  state = { ...state, approvals: [approval(secondaryId)] };
  await render();
  history = element(`[data-task-history="${roomId}"]`);
  assert.ok(
    history.querySelector(`[data-history-task-id="${secondaryId}"]`),
    'Pending approval remains visible for review',
  );
  assert.equal(
    element<HTMLInputElement>(`[data-task-history-select="${secondaryId}"]`, history).disabled,
    true,
  );
  assert.equal(element('[data-task-history-apply]', history).disabled, true);
  await click(element('[data-task-history-apply]', history));
  assert.deepEqual(mutations, []);
  state = structuredClone(state);
  state.approvals = [];
  state.tasks.find((task) => task.id === secondaryId)!.archivedAt = later;
  await render();
  assert.deepEqual(rows(element(`[data-task-history="${roomId}"]`)), []);
});

test('history details preserve the original prompt and error and restore without replaying the task', async () => {
  const data = fixture();
  data.tasks.find((task) => task.id === archivedId)!.workId = 'work_history';
  data.workItems![0].status = 'active';
  await mount(data);
  const history = await openHistory('archived');
  assert.deepEqual(rows(history), [archivedId]);
  await click(element(`[data-task-details-action="${archivedId}"]`, history));
  const details = element(`[data-task-details="${archivedId}"]`);
  assert.equal(document.querySelectorAll('dialog[open]').length, 2);
  assert.equal(element('[data-task-original-prompt]', details).textContent, originalPrompt);
  assert.equal(details.querySelector('script'), null);
  assert.ok(details.textContent?.includes(originalError));
  assert.ok(details.textContent?.includes('CURRENT_HISTORY_WORK_STATE'));
  assert.equal(
    details.querySelector('[data-task-resume-action]'),
    null,
    'Archived work is restored before any explicit rerun',
  );
  await click(element(`[data-task-restore-action="${archivedId}"]`, details));
  assert.equal(mutations.length, 1);
  assertArchiveMutation(mutations[0], [archivedId], false);
  state = structuredClone(state);
  delete state.tasks.find((task) => task.id === archivedId)!.archivedAt;
  await render();
  assert.equal(mutations.length, 1, 'Restoring an item does not issue a task resume');
  assert.equal(state.tasks.find((task) => task.id === archivedId)!.status, 'interrupted');
  assert.equal(state.tasks.find((task) => task.id === archivedId)!.updatedAt, later);
});

test('history details close independently, while viewing room results closes both dialogs', async () => {
  for (const linked of [true, false]) {
    const data = fixture();
    if (linked) data.tasks.find((task) => task.id === archivedId)!.workId = 'work_history';
    await mount(data);
    const history = await openHistory('archived');
    await click(element(`[data-task-details-action="${archivedId}"]`, history));
    let details = element(`[data-task-details="${archivedId}"]`);
    await click(namedButton('閉じる', details));
    assert.equal(document.querySelector('[data-task-details]'), null);
    assert.equal(document.querySelectorAll('dialog[open]').length, 1);
    assert.ok(document.querySelector(`[data-task-history="${roomId}"]`));
    assert.deepEqual(navigations, []);
    await click(element(`[data-task-details-action="${archivedId}"]`, history));
    details = element(`[data-task-details="${archivedId}"]`);
    await click(namedButton('ルームで結果を見る', details));
    assert.equal(document.querySelector('[data-task-details]'), null);
    assert.equal(document.querySelector('[data-task-history]'), null);
    assert.equal(document.querySelectorAll('dialog[open]').length, 0);
    assert.deepEqual(navigations, [{ view: 'chat', roomId }]);
    assert.deepEqual(mutations, []);
  }
});

test('more than 200 visible history rows retain the batch limit and an independent clear action', async () => {
  const data = fixture();
  data.tasks = Array.from({ length: 250 }, (_, index) =>
    task(`task_history_bulk_${String(index).padStart(3, '0')}`, 'stopped'),
  );
  await mount(data, 'history');
  const history = await openHistory('review');
  assert.equal(rows(history).length, 50);
  await click(element('[data-task-select-visible]', history));
  assert.equal(history.querySelectorAll('[data-task-history-select]:checked').length, 50);
  for (let count = 100; count <= 250; count += 50) {
    await click(namedButton('さらに表示', history));
    assert.equal(rows(history).length, count);
  }
  await click(element('[data-task-select-visible]', history));
  assert.equal(history.querySelectorAll('[data-task-history-select]:checked').length, 200);
  assert.equal(element('[data-task-history-clear]', history).disabled, false);
  await click(element('[data-task-history-clear]', history));
  assert.equal(history.querySelectorAll('[data-task-history-select]:checked').length, 0);
  assert.equal(element('[data-task-history-apply]', history).disabled, true);
  await click(element('[data-task-select-visible]', history));
  const selected = [...history.querySelectorAll('[data-task-history-select]:checked')].map(
    (input) => input.getAttribute('data-task-history-select')!,
  );
  assert.equal(selected.length, 200);
  await click(element('[data-task-history-apply]', history));
  assert.equal(mutations.length, 1);
  assertArchiveMutation(mutations[0], selected, true);
});

test('single-task archive keeps its existing output and error in the conversation', async () => {
  const data = fixture();
  data.tasks = [data.tasks.find((task) => task.id === outputId)!];
  await mount(data);
  const originalMessage = structuredClone(state.messages[0]);
  await click(element(`[data-task-archive-action="${outputId}"]`));
  assert.equal(mutations.length, 1);
  assertArchiveMutation(mutations[0], [outputId], true);
  state = structuredClone(state);
  state.tasks[0].archivedAt = later;
  await render();
  const output = element('[data-message-id="message_history_output"]');
  assert.match(output.textContent || '', /PRESERVED_HISTORY_OUTPUT/);
  assert.ok(output.textContent?.includes(originalError));
  assert.equal(output.querySelector('[data-task-resume-action]'), null);
  assert.deepEqual(state.messages[0], originalMessage);
  assert.equal(state.tasks[0].status, 'failed');
  assert.equal(state.tasks[0].completedAt, later);
});

test('single-task archive is unavailable for active tasks and tasks with pending approval', async () => {
  for (const status of [
    'queued',
    'running',
    'waiting_model',
    'waiting_tool',
    'awaiting_approval',
  ] as const) {
    const data = fixture();
    data.tasks = [task(primaryId, status)];
    await mount(data, 'run');
    const action = document.querySelector<HTMLButtonElement>(
      `[data-task-archive-action="${primaryId}"]`,
    );
    assert.ok(!action || action.disabled, `${status} cannot be moved to history`);
  }
  const data = fixture();
  data.tasks = [task()];
  data.approvals = [approval()];
  await mount(data, 'run');
  const action = document.querySelector<HTMLButtonElement>(
    `[data-task-archive-action="${primaryId}"]`,
  );
  assert.ok(!action || action.disabled);
  assert.deepEqual(mutations, []);
});

test('the activity panel skips archived terminal tasks but keeps active tasks visible', async () => {
  const data = fixture();
  data.tasks = [
    { ...task(), updatedAt: stamp },
    { ...task(archivedId), archivedAt: later },
  ];
  await mount(data, 'room');
  assert.ok(document.querySelector(`[data-task-details-action="${primaryId}"]`));
  assert.equal(document.querySelector(`[data-task-details-action="${archivedId}"]`), null);
  state = structuredClone(state);
  state.tasks[1].status = 'running';
  await render();
  await click(element('.room-bot-state-main'));
  assert.deepEqual(
    focusedTasks,
    [archivedId],
    'An active task is never hidden by a stale archive marker',
  );
  assert.equal(document.querySelector('[data-task-archive-action]'), null);
});

test('disconnected history and nested details stay readable while mutations and selection are disabled', async () => {
  await mount(fixture(), 'chat', false);
  assert.equal(element(`[data-task-archive-action="${primaryId}"]`).disabled, true);
  let history = await openHistory('review');
  for (const selector of [
    '[data-task-select-visible]',
    '[data-task-history-select]',
    '[data-task-history-apply]',
  ]) {
    for (const control of history.querySelectorAll<HTMLInputElement>(selector)) {
      assert.equal(control.disabled, true, selector);
      await click(control);
    }
  }
  await click(element(`[data-task-details-action="${primaryId}"]`, history));
  const details = element(`[data-task-details="${primaryId}"]`);
  assert.equal(element('[data-task-original-prompt]', details).textContent, originalPrompt);
  assert.equal(element(`[data-task-archive-action="${primaryId}"]`, details).disabled, true);
  assert.deepEqual(mutations, []);
  await mount(fixture(), 'chat', false);
  history = await openHistory('archived');
  await click(element(`[data-task-details-action="${archivedId}"]`, history));
  assert.equal(
    element(
      `[data-task-restore-action="${archivedId}"]`,
      element(`[data-task-details="${archivedId}"]`),
    ).disabled,
    true,
  );
  assert.deepEqual(mutations, []);
});

test('a pending archive request disables selection and prevents a second batch submission', async () => {
  await mount();
  const history = await openHistory('review');
  await click(element('[data-task-select-visible]', history));
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  respond = () => pending;
  try {
    await click(element('[data-task-history-apply]', history));
    assert.equal(mutations.length, 1);
    assert.equal(element('[data-task-history-apply]', history).disabled, true);
    assert.equal(element('[data-task-select-visible]', history).disabled, true);
    assert.equal(element('[data-task-history-clear]', history).disabled, true);
    for (const control of history.querySelectorAll<HTMLInputElement>('[data-task-history-select]'))
      assert.equal(control.disabled, true);
    await click(element('[data-task-history-apply]', history));
    assert.equal(mutations.length, 1);
  } finally {
    await act(async () => {
      finish();
      await pending;
    });
  }
});
