import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Snapshot, Task } from '../src/shared/types';
import type { WorkItem, WorkCompletionReview } from '../src/shared/work';
import { getTaskStatus } from '../src/client/task-status';
import {
  taskDiagnostic,
  taskErrorPresentation,
  formatTaskDiagnostic,
} from '../src/client/task-diagnostics';
import { taskInterruptionMessage } from '../src/shared/task-interruption';

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
  'HTMLSelectElement',
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
const { WorkCard } = await import('../src/client/AutonomousWork');
const { WorkSummary } = await import('../src/client/WorkSummary');

const stamp = '2026-11-16T05:00:00.000Z';
function work(): WorkItem {
  return {
    id: 'work',
    roomId: 'room',
    name: 'Check the report',
    purpose: 'Finish the requested report.',
    kind: 'task',
    status: 'active',
    createdByBotId: 'creator',
    sourceTaskId: 'source',
    scope: 'Research',
    workspacePath: '/tmp/fixture',
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
    checkpoint: {
      summary: 'Research collected.',
      completed: 'Checked the main source.',
      nextStep: 'Check Nova’s answer.',
      references: [],
      doneWhen: 'The requested report is verified.',
      pendingChecks: [],
      uncertainActions: [],
    },
  };
}
function review(): WorkCompletionReview {
  return {
    id: 'review',
    status: 'needs_review',
    workRunId: 'run',
    requestedAt: stamp,
    attempts: 0,
    items: [
      {
        id: 'task:peer',
        kind: 'task',
        label: 'Verify the source',
        taskId: 'peer',
        status: 'queued',
      },
    ],
  };
}
function peer(): Task {
  return {
    id: 'peer',
    botId: 'nova',
    roomId: 'room',
    workId: 'work',
    workRunId: 'run',
    rootTaskId: 'source',
    depth: 1,
    kind: 'chat',
    prompt: 'Verify source',
    output: '',
    status: 'queued',
    inputTokens: 0,
    outputTokens: 0,
    createdAt: stamp,
    updatedAt: stamp,
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
        id: 'creator',
        name: '高橋',
        handle: 'takahashi',
        role: 'Research',
        systemPrompt: '',
        avatar: 'sparkles',
        color: '#829479',
        enabled: true,
        createdAt: stamp,
      },
      {
        id: 'nova',
        name: 'Nova',
        handle: 'nova',
        role: 'Review',
        systemPrompt: '',
        avatar: 'sparkles',
        color: '#829479',
        enabled: true,
        createdAt: stamp,
      },
    ],
    rooms: [
      {
        id: 'room',
        name: 'Research',
        description: '',
        botIds: ['creator', 'nova'],
        autonomousWakeups: {
          mode: 'room',
          minIntervalMinutes: 5,
          maxPendingWakeups: 24,
          maxRunsPerHour: 12,
        },
        archived: false,
        pinned: false,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    messages: [],
    tasks: [peer()],
    activities: [],
    approvals: [],
    skills: [],
    memories: [],
    automations: [],
    notifications: [],
    queue: { active: 0, waiting: 1 },
    workItems: [work()],
    wakeups: [],
  };
}
let root: ReturnType<typeof createRoot> | undefined;
let state: Snapshot;
let context: AppContextValue;
let respond: (body: any) => Promise<WorkItem>;
const mutations: { path: string; method?: string; body?: any }[] = [];
const notifications: string[] = [];
async function render() {
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        <WorkSummary work={state.workItems![0]}>
          <WorkCard work={state.workItems![0]} />
        </WorkSummary>
      </AppContext.Provider>,
    ),
  );
}
async function mount(data = fixture(), locale: 'ja' | 'en' = 'en') {
  if (root) await act(async () => root!.unmount());
  state = data;
  mutations.length = 0;
  notifications.length = 0;
  localStorage.clear();
  respond = async () => ({
    ...state.workItems![0],
    revision: state.workItems![0].revision + 1,
    completionReview: review(),
  });
  context = {
    data: state,
    locale,
    t: (ja, en) => (locale === 'ja' ? ja : en),
    view: 'automations',
    roomId: 'room',
    connected: true,
    navigate() {},
    async refresh() {},
    async signOut() {},
    toast(message) {
      notifications.push(message);
    },
    async mutate<T>(path: string, method?: string, body?: unknown, success?: string) {
      mutations.push({ path, method, body });
      const result = await respond(body);
      if (success) notifications.push(success);
      return result as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await render();
}
function button(label: string, scope: ParentNode = document) {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) =>
      element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
  );
  assert.ok(element, `Missing button: ${label}`);
  return element;
}
function field<
  T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement = HTMLTextAreaElement,
>(label: string): T {
  const wrapper = [...document.querySelectorAll('label.field')].find(
    (element) => element.querySelector('.field-label')?.textContent === label,
  );
  const element = wrapper?.querySelector<T>('input,select,textarea');
  assert.ok(element, `Missing field: ${label}`);
  return element;
}
async function input(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    const select = element instanceof dom.window.HTMLSelectElement;
    const prototype = select
      ? dom.window.HTMLSelectElement.prototype
      : element instanceof dom.window.HTMLInputElement
        ? dom.window.HTMLInputElement.prototype
        : dom.window.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event(select ? 'change' : 'input', { bubbles: true }));
  });
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
function localDate(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
async function choose(action: 'wait' | 'dismiss' | 'defer', index = 1) {
  await input(field<HTMLSelectElement>(`Decision for item ${index}`), action);
  await input(
    field(`Reason for item ${index}`),
    action === 'wait'
      ? 'This answer is required to verify the report.'
      : 'The source is verified; this is an optional improvement.',
  );
}

test('initial completion returns an unselected review, preserves the queued peer and never reports success', async () => {
  await mount();
  await click(button('Mark complete'));
  assert.deepEqual(mutations, [
    { path: '/work-items/work/complete', method: 'POST', body: { baseRevision: 1 } },
  ]);
  assert.ok(document.querySelector('dialog[open]'));
  assert.equal(field<HTMLSelectElement>('Decision for item 1').value, '');
  assert.equal(button('Apply decisions').disabled, true);
  assert.equal(state.tasks[0].status, 'queued');
  assert.equal(document.activeElement, field('Progress and evidence for this decision'));
  assert.equal(notifications.includes('Work marked complete'), false);
  assert.match(
    document.querySelector('[data-work-id="work"]')?.textContent || '',
    /Verify the source/,
  );
});

test('wait requires evidence and a future bounded review time and then shows normal waiting', async () => {
  await mount();
  await click(button('Mark complete'));
  await choose('wait');
  assert.equal(button('Apply decisions').disabled, true);
  await input(
    field('Progress and evidence for this decision'),
    'The report still needs the source verification.',
  );
  await input(
    field<HTMLInputElement>('Reassess no later than'),
    localDate(new Date(Date.now() - 60_000)),
  );
  assert.equal(button('Apply decisions').disabled, true);
  await input(
    field<HTMLInputElement>('Reassess no later than'),
    localDate(new Date(Date.now() + 8 * 86_400_000)),
  );
  assert.equal(button('Apply decisions').disabled, true);
  const deadline = localDate(new Date(Date.now() + 3_600_000));
  await input(field<HTMLInputElement>('Reassess no later than'), deadline);
  assert.equal(button('Apply decisions').disabled, false);
  respond = async (body) => ({
    ...work(),
    revision: 3,
    completionReview: { ...review(), ...body.completion, status: 'waiting' },
  });
  await click(button('Apply decisions'));
  assert.deepEqual(mutations.at(-1)?.body, {
    baseRevision: 2,
    completion: {
      summary: 'The report still needs the source verification.',
      decisions: [
        {
          itemId: 'task:peer',
          action: 'wait',
          reason: 'This answer is required to verify the report.',
        },
      ],
      waitUntil: new Date(deadline).toISOString(),
    },
  });
  assert.equal(document.querySelector('dialog'), null);
  assert.equal(
    document.querySelector('[data-work-id="work"] .autonomous-work-status')?.textContent,
    'Waiting for required results',
  );
  assert.equal(notifications.includes('Work marked complete'), false);
  assert.match(document.body.textContent || '', /reassessment deadline/);
});

test('dismiss and defer require individual reasons and follow-up scope, then expose a saved follow-up', async () => {
  const data = fixture();
  const items = [
    ...review().items,
    { id: 'check:next', kind: 'check' as const, label: 'Optional later improvements' },
  ];
  data.workItems![0] = { ...work(), revision: 4, completionReview: { ...review(), items } };
  await mount(data);
  await click(button('Review remaining work', document.querySelector('[data-work-id="work"]')!));
  await input(
    field('Progress and evidence for this decision'),
    'Required source verification is complete. Preserve the optional improvements.',
  );
  await choose('dismiss');
  await choose('defer', 2);
  assert.equal(button('Apply decisions').disabled, true);
  await input(field<HTMLInputElement>('Follow-up name'), 'Improve the next report');
  await input(field('Follow-up purpose'), 'Review the optional presentation improvements later.');
  assert.equal(button('Apply decisions').disabled, false);
  const followUp: WorkItem = {
    ...work(),
    id: 'follow-up',
    name: 'Improve the next report',
    purpose: 'Review optional improvements later.',
    deferredFromWorkId: 'work',
  };
  state.workItems!.push(followUp);
  respond = async (body) => ({
    ...work(),
    status: 'completed',
    revision: 5,
    completionReview: {
      ...review(),
      items,
      ...body.completion,
      status: 'resolved',
      followUpWorkId: followUp.id,
    },
  });
  await click(button('Apply decisions'));
  assert.equal(mutations.at(-1)?.body.baseRevision, 4);
  assert.deepEqual(mutations.at(-1)?.body.completion.followUp, {
    name: 'Improve the next report',
    purpose: 'Review the optional presentation improvements later.',
  });
  assert.equal(
    document.querySelector('[data-work-id="work"] .autonomous-work-status')?.textContent,
    'Completed',
  );
  assert.ok(notifications.includes('Work marked complete'));
  await click(button('Improve the next report'));
  assert.equal(
    document.querySelector('dialog [data-work-id="follow-up"] .autonomous-work-status')
      ?.textContent,
    'Saved follow-up',
  );
  assert.match(
    document.querySelector('dialog')?.textContent || '',
    /no task or wake-up has been started/,
  );
});

test('concurrent work revisions preserve the draft and require the owner to review the latest version', async () => {
  const data = fixture();
  data.workItems![0] = { ...work(), revision: 2, completionReview: review() };
  await mount(data);
  await click(button('Review remaining work', document.querySelector('[data-work-id="work"]')!));
  await input(field('Progress and evidence for this decision'), 'Keep this unsaved explanation.');
  await choose('dismiss');
  const next = {
    ...state.workItems![0],
    revision: 3,
    checkpoint: { ...work().checkpoint, summary: 'New source result arrived.' },
  };
  state.workItems![0] = next;
  await render();
  assert.equal(
    field('Progress and evidence for this decision').value,
    'Keep this unsaved explanation.',
  );
  assert.equal(button('Apply decisions').disabled, true);
  assert.match(
    document.querySelector('dialog [role="status"]')?.textContent || '',
    /New results or changes/,
  );
  assert.equal(mutations.length, 0);
  await click(button('Review the latest work'));
  assert.equal(field('Progress and evidence for this decision').value, '');
  assert.equal(button('Apply decisions').disabled, true);
});

test('reopening a mixed wait edits only unresolved items without repeating an earlier deferral', async () => {
  const data = fixture();
  data.workItems![0] = {
    ...work(),
    completionReview: {
      ...review(),
      status: 'waiting',
      items: [
        ...review().items,
        { id: 'check:optional', kind: 'check', label: 'Optional future improvement' },
      ],
      decisions: [
        { itemId: 'task:peer', action: 'wait', reason: 'Required answer.' },
        { itemId: 'check:optional', action: 'defer', reason: 'Save optional work for later.' },
      ],
      waitUntil: new Date(Date.now() + 3_600_000).toISOString(),
      followUpWorkId: 'saved-follow-up',
    },
  };
  await mount(data);
  await click(button('Review remaining work', document.querySelector('[data-work-id="work"]')!));
  assert.equal(
    document.querySelectorAll('dialog .autonomous-work-completion-items fieldset').length,
    1,
  );
  assert.equal(field<HTMLSelectElement>('Decision for item 1').value, 'wait');
  assert.equal(document.querySelector('dialog input[maxlength="160"]'), null);
  await input(
    field('Progress and evidence for this decision'),
    'The answer is now available from another verified source.',
  );
  await choose('dismiss');
  respond = async (body) => ({
    ...work(),
    status: 'completed',
    revision: 2,
    completionReview: {
      ...review(),
      status: 'resolved',
      summary: body.completion.summary,
      decisions: body.completion.decisions,
      followUpWorkId: 'saved-follow-up',
    },
  });
  await click(button('Apply decisions'));
  assert.deepEqual(
    mutations
      .at(-1)
      ?.body.completion.decisions.map((decision: { itemId: string }) => decision.itemId),
    ['task:peer'],
  );
  assert.equal(mutations.at(-1)?.body.completion.followUp, undefined);
});

test('failed completion resolution retains inputs, locks duplicate requests and remains retryable', async () => {
  await mount();
  await click(button('Mark complete'));
  await input(
    field('Progress and evidence for this decision'),
    'The primary source is now verified.',
  );
  await choose('dismiss');
  let reject!: (error: Error) => void;
  respond = () =>
    new Promise((_resolve, fail) => {
      reject = fail;
    });
  const submit = button('Apply decisions');
  await act(async () => {
    submit.click();
    submit.click();
  });
  assert.equal(mutations.length, 2);
  assert.equal(submit.disabled, true);
  assert.equal(field('Progress and evidence for this decision').disabled, true);
  await act(async () => reject(new Error('The work changed before this decision was saved.')));
  assert.equal(
    field('Progress and evidence for this decision').value,
    'The primary source is now verified.',
  );
  assert.match(document.querySelector('dialog [role="alert"]')?.textContent || '', /work changed/);
  assert.equal(submit.disabled, false);
  assert.equal(notifications.includes('Work marked complete'), false);
});

test('structured work stops name their actor and retain stopped status without inventing success', () => {
  const data = fixture();
  const context = {
    reason: 'work_completed' as const,
    actorType: 'bot' as const,
    actorId: 'creator',
    workId: 'work',
    causeTaskId: 'source',
    at: stamp,
    detail: 'PRIVATE_DECISION_NOTES',
  };
  const stopped = {
    ...peer(),
    status: 'stopped' as const,
    error: taskInterruptionMessage('work_completed', true),
    stopContext: context,
  };
  data.workItems![0].status = 'completed';
  const shown = getTaskStatus(stopped, data, 'ja');
  assert.equal(shown.phase, 'stopped');
  assert.equal(shown.resumable, false);
  assert.match(shown.label, /仕事完了/);
  assert.match(shown.detail, /高橋/);
  assert.doesNotMatch(shown.detail, /ユーザーの操作/);
  const diagnostic = taskDiagnostic('0.20.0', stopped, undefined, data.workItems![0]);
  const copied = formatTaskDiagnostic(diagnostic);
  assert.match(copied, /Stop reason: work_completed\nStop actor: bot \(creator\)/);
  assert.match(copied, /Cause task ID: source/);
  assert.doesNotMatch(copied, /PRIVATE_DECISION_NOTES/);
  assert.match(
    taskErrorPresentation(stopped.error, 'ja', diagnostic.stopContext, '高橋').title,
    /高橋/,
  );
  const legacy = taskErrorPresentation(taskInterruptionMessage('owner_stop', true), 'ja');
  assert.match(legacy.title, /理由未確認/);
  assert.match(
    taskErrorPresentation(taskInterruptionMessage('owner_stop'), 'ja', {
      ...context,
      reason: 'owner_stop',
      actorType: 'owner',
      actorId: undefined,
    }).title,
    /ユーザーの操作/,
  );
});

test('a saved follow-up exposes every deferred item beyond the short checkpoint summary', async () => {
  const data = fixture();
  data.workItems![0] = {
    ...work(),
    deferredFromWorkId: 'earlier-work',
    deferredItems: Array.from({ length: 30 }, (_, index) => ({
      id: `task:saved-${index}`,
      kind: 'task',
      label: `Optional follow-up ${index + 1}`,
      reason: `Saved reason ${index + 1}`,
    })),
  };
  await mount(data);
  assert.equal(document.querySelectorAll('.autonomous-work-deferred-scope li').length, 30);
  assert.match(
    document.querySelector('.autonomous-work-deferred-scope')?.textContent || '',
    /Optional follow-up 30/,
  );
  assert.match(
    document.querySelector('.autonomous-work-deferred-scope')?.textContent || '',
    /Saved reason 30/,
  );
  assert.equal(mutations.length, 0);
});

after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});
