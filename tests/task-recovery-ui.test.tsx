import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Message, Snapshot, Task, TaskStatus } from '../src/shared/types';
import { DEFAULT_AUTONOMOUS_WAKEUP_POLICY, type WorkItem } from '../src/shared/work';

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
const { RunProgress } = await import('../src/client/RunProgress');
const { RoomActivity } = await import('../src/client/RoomActivity');

const now = '2026-11-11T11:00:00.000Z';
const later = '2026-11-11T12:00:00.000Z';
const taskId = 'task_recovery';
const workId = 'work_recovery';
const roomId = 'room_recovery';
const originalPrompt =
  'ORIGINAL_TASK_INSTRUCTION\n当初の指示をそのまま保持する。\n{"checkpoint":"ORIGINAL_SAVED_STATE"}\n<script>doNotExecute()</script>';

function task(status: TaskStatus = 'failed'): Task {
  return {
    id: taskId,
    botId: 'bot_aster',
    roomId,
    prompt: originalPrompt,
    workId,
    workRunId: 'run_recovery',
    wakeupId: 'wake_recovery',
    rootTaskId: taskId,
    depth: 0,
    kind: 'automation',
    status,
    output: 'A partial result.',
    error: 'Fixture model connection interrupted.',
    createdAt: now,
    updatedAt: later,
    inputTokens: 5,
    outputTokens: 8,
  };
}
function message(patch: Partial<Message> = {}): Message {
  return {
    id: 'message_latest',
    taskId,
    roomId,
    authorId: 'bot_aster',
    authorType: 'bot',
    status: 'error',
    body: 'A partial result.',
    createdAt: later,
    ...patch,
  };
}
function work(id = workId): WorkItem {
  return {
    id,
    roomId,
    name: id === workId ? '対象の仕事' : 'OTHER_WORK_MUST_NOT_OPEN',
    purpose: 'Review the accepted submission.',
    kind: 'task',
    status: 'blocked',
    createdByBotId: 'bot_aster',
    sourceTaskId: taskId,
    scope: 'Review the accepted submission.',
    workspacePath: '/tmp/recovery',
    checkpoint: {
      summary: 'CURRENT_WORK_STATE',
      completed: 'The submission receipt was saved.',
      nextStep: 'Inspect the service review later.',
      references: ['review/receipt.txt'],
      doneWhen: 'The review outcome has been reported.',
      pendingChecks: ['Check the service review decision later.'],
      uncertainActions: [],
    },
    revision: 3,
    createdAt: now,
    updatedAt: later,
  };
}
function fixture(): Snapshot {
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
      workspacePath: '/tmp/recovery',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: [
      {
        id: 'bot_aster',
        name: 'Aster',
        handle: 'aster',
        role: 'Review',
        systemPrompt: 'Review the work.',
        avatar: 'sparkles',
        color: '#829479',
        enabled: true,
        createdAt: now,
      },
    ],
    rooms: [
      {
        id: roomId,
        name: 'Recovery room',
        description: 'Review the work.',
        botIds: ['bot_aster'],
        archived: false,
        pinned: false,
        autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room' },
        createdAt: now,
        updatedAt: now,
      },
    ],
    tasks: [task()],
    messages: [message()],
    workItems: [work(), work('work_unrelated')],
    wakeups: [
      {
        id: 'wake_recovery',
        workId,
        roomId,
        botId: 'bot_aster',
        createdByBotId: 'bot_aster',
        sourceTaskId: taskId,
        key: 'review-later',
        reason: 'Wait for the review decision.',
        prompt: 'FUTURE_WAKE_INSTRUCTION_DO_NOT_SUBSTITUTE',
        schedule: {
          type: 'once',
          dateTime: '2026-11-12T09:00',
          timeZone: 'Asia/Tokyo',
          missedRunPolicy: 'run_once',
        },
        status: 'scheduled',
        nextRunAt: '2026-11-12T00:00:00.000Z',
        workRunId: 'run_recovery',
        revision: 2,
        createdAt: now,
        updatedAt: later,
      },
    ],
    activities: [],
    approvals: [],
    skills: [],
    memories: [],
    automations: [],
    notifications: [],
    queue: { active: 0, waiting: 0 },
  };
}

type Surface = 'run' | 'room';
let root: ReturnType<typeof createRoot> | undefined;
let state: Snapshot;
let context: AppContextValue;
let renderChildren: () => React.ReactNode;
const mutations: { path: string; method?: string; body?: unknown }[] = [];
const navigations: { view: string; roomId?: string }[] = [];
async function mount(
  data = fixture(),
  surface: Surface = 'run',
  connected = true,
  children?: () => React.ReactNode,
) {
  if (root) await act(async () => root!.unmount());
  localStorage.clear();
  state = data;
  mutations.length = 0;
  navigations.length = 0;
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
      mutations.push({ path, method, body });
      return {} as T;
    },
  };
  renderChildren =
    children ??
    (() =>
      surface === 'run' ? (
        <RunProgress taskId={taskId} message={state.messages.at(-1)} />
      ) : (
        <RoomActivity roomId={roomId} />
      ));
  root = createRoot(document.getElementById('root')!);
  await rerender();
}
async function rerender() {
  context = { ...context, data: state };
  await act(async () =>
    root!.render(<AppContext.Provider value={context}>{renderChildren()}</AppContext.Provider>),
  );
}
function button(selector: string, scope: ParentNode = document): HTMLButtonElement {
  const found = scope.querySelector<HTMLButtonElement>(selector);
  assert.ok(found, `Missing button ${selector}`);
  return found;
}
function namedButton(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  assert.ok(found, `Missing button ${label}`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function openDetails() {
  const trigger = button(`[data-task-details-action="${taskId}"]`);
  assert.equal(trigger.disabled, false, 'Details can be read before taking any recovery action');
  await click(trigger);
  const details = document.querySelector<HTMLElement>(`[data-task-details="${taskId}"]`);
  assert.ok(details, 'The details belong to the selected task');
  return details;
}
async function inputField(label: string, value: string, scope: ParentNode = document) {
  const wrapper = [...scope.querySelectorAll('label.field')].find(
    (item) => item.querySelector('.field-label')?.textContent === label,
  );
  const input = wrapper?.querySelector<HTMLTextAreaElement>('textarea');
  assert.ok(input, `Missing textarea ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});

for (const surface of ['run', 'room'] as const) {
  test(`${surface}: stopped tasks with unavailable or held work offer details without a direct task resume`, async () => {
    for (const status of [
      'blocked',
      'paused',
      'completed',
      'cancelled',
      'missing',
      'mismatch',
    ] as const) {
      const data = fixture();
      if (status === 'missing') data.workItems = [work('work_unrelated')];
      else if (status === 'mismatch') data.workItems![0].roomId = 'room_other';
      else data.workItems![0].status = status;
      await mount(data, surface);
      assert.equal(document.querySelector('[data-task-resume-action]'), null, status);
      const details = await openDetails();
      assert.equal(details.querySelector('[data-task-resume-action]'), null, status);
      assert.equal(
        details.querySelector('[data-task-original-prompt]')?.textContent,
        originalPrompt,
      );
      assert.equal(details.querySelector('[data-work-id="work_unrelated"]'), null);
      if (status === 'missing' || status === 'mismatch') {
        assert.equal(
          details.querySelector('[data-work-id]'),
          null,
          'No other room or unrelated work is substituted',
        );
      } else {
        assert.equal(details.querySelectorAll('[data-work-id]').length, 1);
        assert.equal(details.querySelector('[data-work-id]')?.getAttribute('data-work-id'), workId);
      }
      assert.deepEqual(mutations, []);
    }
  });

  test(`${surface}: eligible stopped, failed and interrupted tasks can be explicitly resumed from their details`, async () => {
    for (const status of ['stopped', 'failed', 'interrupted'] as const) {
      for (const linked of [true, false]) {
        const data = fixture();
        data.tasks[0].status = status;
        data.workItems![0].status = 'active';
        if (!linked) {
          delete data.tasks[0].workId;
          delete data.tasks[0].workRunId;
          delete data.tasks[0].wakeupId;
        }
        await mount(data, surface);
        assert.equal(button(`[data-task-resume-action="${taskId}"]`).disabled, false);
        const details = await openDetails();
        assert.deepEqual(mutations, [], 'Opening details never starts the task');
        await click(button(`[data-task-resume-action="${taskId}"]`, details));
        assert.deepEqual(mutations, [
          { path: `/tasks/${taskId}/resume`, method: 'POST', body: undefined },
        ]);
      }
    }
  });
}

test('the original task instruction stays exact while the current work and reservation refresh', async () => {
  await mount();
  let details = await openDetails();
  assert.match(details.textContent || '', /この作業への当初の指示/);
  assert.match(details.textContent || '', /仕事の現在の状況/);
  assert.equal(details.querySelector('[data-task-original-prompt]')?.textContent, originalPrompt);
  assert.equal(details.querySelector('script'), null, 'Saved instructions are shown as text');
  assert.match(details.querySelector('[data-work-id]')?.textContent || '', /CURRENT_WORK_STATE/);
  state = structuredClone(state);
  state.workItems![0].checkpoint.summary = 'UPDATED_WORK_STATE_FROM_SNAPSHOT';
  state.wakeups![0].prompt = 'UPDATED_FUTURE_WAKE_INSTRUCTION';
  await rerender();
  details = document.querySelector<HTMLElement>(`[data-task-details="${taskId}"]`)!;
  assert.match(
    details.querySelector('[data-work-id]')?.textContent || '',
    /UPDATED_WORK_STATE_FROM_SNAPSHOT/,
  );
  assert.equal(details.querySelector('[data-task-original-prompt]')?.textContent, originalPrompt);
  assert.deepEqual(mutations, []);
});

test('resuming the linked work never silently resumes the failed task', async () => {
  await mount();
  let details = await openDetails();
  await click(namedButton('仕事を再開', details));
  assert.deepEqual(mutations, [
    { path: `/work-items/${workId}/resume`, method: 'POST', body: undefined },
  ]);
  assert.equal(
    details.querySelector('[data-task-resume-action]'),
    null,
    'Wait for the authoritative work state',
  );
  state = structuredClone(state);
  state.workItems![0].status = 'active';
  await rerender();
  details = document.querySelector<HTMLElement>(`[data-task-details="${taskId}"]`)!;
  assert.ok(details, 'The task details remain available after the work resumes');
  assert.equal(mutations.length, 1, 'A refreshed active work does not replay its failed task');
  await click(button(`[data-task-resume-action="${taskId}"]`, details));
  assert.deepEqual(
    mutations.map(({ path }) => path),
    [`/work-items/${workId}/resume`, `/tasks/${taskId}/resume`],
  );
});

test('linked uncertainty uses the existing work review and preserves its pending checks', async () => {
  const data = fixture();
  data.workItems![0].checkpoint.uncertainActions = [
    'The previous submission may have reached the service.',
  ];
  await mount(data);
  const details = await openDetails();
  await click(namedButton('確認して再開', details));
  const review = document.querySelector<HTMLFormElement>('form.autonomous-work-review');
  assert.ok(review, 'Use the existing outcome review form');
  assert.equal(document.querySelectorAll('dialog').length, 2);
  assert.equal(namedButton('確認を記録して再開', review).disabled, true);
  await inputField('確認した結果', 'The recorded submission receipt confirms acceptance.', review);
  await inputField('次に行うこと', 'Inspect its later review result.', review);
  await click(review.querySelector<HTMLInputElement>('.autonomous-work-review-confirm input')!);
  await click(namedButton('確認を記録して再開', review));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].path, `/work-items/${workId}/resume`);
  const body = mutations[0].body as { checkpoint: WorkItem['checkpoint'] };
  assert.deepEqual(body.checkpoint.uncertainActions, []);
  assert.deepEqual(body.checkpoint.pendingChecks, data.workItems![0].checkpoint.pendingChecks);
  assert.ok(document.querySelector(`[data-task-details="${taskId}"]`));
  assert.equal(document.querySelector('form.autonomous-work-review'), null);
  assert.equal(
    mutations.some(({ path }) => path.startsWith('/tasks/')),
    false,
  );
});

test('disconnected details remain readable while both task and work mutations are disabled', async () => {
  for (const status of ['blocked', 'active'] as const) {
    const data = fixture();
    data.workItems![0].status = status;
    await mount(data, 'run', false);
    const details = await openDetails();
    assert.equal(details.querySelector('[data-task-original-prompt]')?.textContent, originalPrompt);
    const workCard = details.querySelector<HTMLElement>(`[data-work-id="${workId}"]`)!;
    for (const label of status === 'blocked'
      ? ['仕事を再開', '完了にする', '仕事を中止']
      : ['仕事を一時停止', '完了にする', '仕事を中止']) {
      const action = namedButton(label, workCard);
      assert.equal(action.disabled, true, label);
      await click(action);
    }
    for (const action of document.querySelectorAll<HTMLButtonElement>(
      '[data-task-resume-action]',
    )) {
      assert.equal(action.disabled, true);
      await click(action);
    }
    assert.deepEqual(mutations, []);
  }
});

test('only the current run and the room bot latest task expose recovery actions', async () => {
  const data = fixture();
  data.workItems![0].status = 'active';
  data.messages = [message({ id: 'message_old', createdAt: now }), message()];
  await mount(data, 'run', true, () => (
    <>
      <RunProgress taskId={taskId} message={state.messages[0]} />
      <RunProgress taskId={taskId} message={state.messages[1]} />
    </>
  ));
  const oldRun = document.querySelector('[data-run-message-id="message_old"]')!;
  const currentRun = document.querySelector('[data-run-message-id="message_latest"]')!;
  assert.equal(oldRun.querySelector('[data-task-details-action]'), null);
  assert.equal(oldRun.querySelector('[data-task-resume-action]'), null);
  assert.ok(currentRun.querySelector('[data-task-details-action]'));
  assert.ok(currentRun.querySelector('[data-task-resume-action]'));
  const olderTask = { ...task('stopped'), id: 'task_older', updatedAt: now };
  data.tasks.push(olderTask);
  await mount(data, 'room');
  assert.ok(document.querySelector(`[data-task-details-action="${taskId}"]`));
  assert.equal(document.querySelector('[data-task-details-action="task_older"]'), null);
});

test('viewing room results closes task details and navigates to the selected work room', async () => {
  await mount();
  const details = await openDetails();
  await click(
    namedButton('ルームで結果を見る', details.querySelector(`[data-work-id="${workId}"]`)!),
  );
  assert.deepEqual(navigations, [{ view: 'chat', roomId }]);
  assert.equal(document.querySelector('[data-task-details]'), null);
  assert.deepEqual(mutations, []);
});
