import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Activity, Message, Snapshot, Task, WorkItem } from '../src/shared/types';
import { RUNTIME_SHUTDOWN_REASONS, taskInterruptionMessage } from '../src/shared/task-interruption';
import {
  activityDiagnostic,
  formatTaskDiagnostic,
  taskDiagnostic,
  taskErrorPresentation,
} from '../src/client/task-diagnostics';

const oldTime = '2026-11-06T09:00:00.000Z';
const newTime = '2026-11-06T10:00:00.000Z';
const connectionError =
  'The connection to the model server timed out after 10.6 seconds (UND_ERR_CONNECT_TIMEOUT). This request was not retried automatically.';
const legacyStop =
  'Stopped. You can resume explicitly; completed side effects will not be replayed automatically.';

function task(): Task {
  return {
    id: 'task',
    roomId: 'room',
    botId: 'bot',
    rootTaskId: 'task',
    depth: 0,
    kind: 'chat',
    status: 'failed',
    prompt: 'PRIVATE_PROMPT',
    output: 'PRIVATE_OUTPUT',
    error: connectionError,
    createdAt: oldTime,
    startedAt: oldTime,
    completedAt: oldTime,
    updatedAt: newTime,
    inputTokens: 1,
    outputTokens: 2,
  };
}
function work(patch: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'work',
    roomId: 'room',
    name: 'PRIVATE_WORK_NAME',
    purpose: 'PRIVATE_WORK_PURPOSE',
    kind: 'task',
    status: 'blocked',
    createdByBotId: 'bot',
    sourceTaskId: 'task',
    scope: 'PRIVATE_WORK_SCOPE',
    workspacePath: '/tmp/fixture',
    checkpoint: {
      summary: 'PRIVATE_WORK_SUMMARY',
      completed: 'PRIVATE_WORK_COMPLETED',
      nextStep: 'PRIVATE_WORK_NEXT_STEP',
      references: ['PRIVATE_WORK_REFERENCE'],
      doneWhen: 'PRIVATE_WORK_DONE_WHEN',
      pendingChecks: ['PRIVATE_WORK_PENDING_CHECK'],
      uncertainActions: ['PRIVATE_WORK_UNCERTAIN_ACTION'],
    },
    revision: 1,
    createdAt: oldTime,
    updatedAt: newTime,
    ...patch,
  };
}
function message(patch: Partial<Message> = {}): Message {
  return {
    id: 'message',
    taskId: 'task',
    roomId: 'room',
    authorType: 'bot',
    authorId: 'bot',
    body: 'A partial response',
    reasoning: 'PRIVATE_REASONING',
    reasoningStatus: 'interrupted',
    status: 'error',
    createdAt: oldTime,
    ...patch,
  };
}
function activity(patch: Partial<Activity> = {}): Activity {
  return {
    id: 'activity',
    taskId: 'task',
    roomId: 'room',
    botId: 'bot',
    messageId: 'message',
    kind: 'status',
    title: 'Starting Pi agent session',
    status: 'error',
    detail: legacyStop,
    createdAt: oldTime,
    ...patch,
  };
}

test('current diagnostic copy is an explicit allowlist and preserves raw error text', () => {
  const item = { ...task(), error: 'An error\nwith an exact second line.' };
  const result = formatTaskDiagnostic(taskDiagnostic('0.8.2', item, 'message'));
  assert.equal(
    result,
    [
      'Agent Loom version (current): 0.8.2',
      'Task ID: task',
      'Room ID: room',
      'Bot ID: bot',
      'Message ID: message',
      'Task status: failed',
      `Task updated at: ${newTime}`,
      'Error:',
      item.error,
    ].join('\n'),
  );
  assert.doesNotMatch(result, /PRIVATE_|inputTokens|outputTokens/);
  assert.doesNotMatch(result, new RegExp(oldTime.replaceAll('.', '\\.')));
  assert.doesNotMatch(formatTaskDiagnostic(taskDiagnostic('0.8.2', item)), /Message ID/);
});

test('current diagnostics identify linked work without copying its private contents', () => {
  const item = { ...task(), workId: 'work' };
  const result = formatTaskDiagnostic(taskDiagnostic('0.14.4', item, 'message', work()));
  assert.equal(
    result,
    [
      'Agent Loom version (current): 0.14.4',
      'Task ID: task',
      'Room ID: room',
      'Bot ID: bot',
      'Work ID: work',
      'Work status (current): blocked',
      'Message ID: message',
      'Task status: failed',
      `Task updated at: ${newTime}`,
      'Error:',
      connectionError,
    ].join('\n'),
  );
  assert.doesNotMatch(result, /PRIVATE_|checkpoint|inputTokens|outputTokens/);
});

test('missing or mismatched work never supplies a current status to task diagnostics', () => {
  const item = { ...task(), workId: 'work' };
  for (const related of [undefined, work({ id: 'other-work' }), work({ roomId: 'other-room' })]) {
    const record = taskDiagnostic('0.14.4', item, undefined, related);
    assert.equal(record.workId, 'work');
    assert.equal(record.workStatus, undefined);
    const copied = formatTaskDiagnostic(record);
    assert.match(copied, /Work ID: work/);
    assert.doesNotMatch(copied, /Work status|other-work|other-room|PRIVATE_/);
  }
  const unlinked = formatTaskDiagnostic(taskDiagnostic('0.14.4', task(), undefined, work()));
  assert.doesNotMatch(unlinked, /Work ID|Work status|PRIVATE_/);
});

test('historical diagnostics use activity identifiers, original detail, and creation time', () => {
  const original = activity({
    taskId: 'old-task',
    roomId: 'old-room',
    botId: 'old-bot',
    messageId: 'old-message',
  });
  const result = formatTaskDiagnostic(activityDiagnostic('0.8.2', original, 'new-message'));
  assert.match(
    result,
    /Task ID: old-task\nRoom ID: old-room\nBot ID: old-bot\nMessage ID: old-message/,
  );
  assert.match(result, /Activity status: error/);
  assert.ok(result.includes(`Activity ID: ${original.id}`));
  assert.ok(result.includes(`Activity created at: ${oldTime}`));
  assert.ok(result.endsWith(legacyStop));
  assert.doesNotMatch(result, /new-message|Task status|Task updated|Work ID|Work status|10\.6/);
  assert.equal(
    activityDiagnostic('0.8.2', { ...original, messageId: undefined }, 'legacy-owner').messageId,
    'legacy-owner',
  );
});

test('known interruption messages have Japanese reasons while old or lookalike text remains unknown', () => {
  for (const reason of [...RUNTIME_SHUTDOWN_REASONS, 'owner_stop', 'unexpected'] as const) {
    const text = taskInterruptionMessage(reason);
    const presentation = taskErrorPresentation(text, 'ja');
    assert.equal(presentation.reason, reason);
    assert.match(presentation.title, /停止|中断/);
    assert.match(presentation.detail || '', /自動で再実行しません/);
    assert.equal(taskErrorPresentation(`${text} Provider note.`, 'ja').reason, 'unknown');
  }
  assert.equal(
    taskErrorPresentation(taskInterruptionMessage('owner_stop', true), 'ja').reason,
    'owner_stop',
  );
  for (const text of [
    legacyStop,
    'Request timed out.',
    'Stopped by the user.',
    'An unknown failure.',
  ]) {
    const presentation = taskErrorPresentation(text, 'ja');
    assert.equal(presentation.reason, 'unknown');
    assert.equal(presentation.title, '記録されたエラー');
    assert.equal(presentation.detail, undefined);
  }
});

test('timeout summaries distinguish Loom deadlines, transport stages, gateways and unknown sources', () => {
  const cases = [
    [
      'response_timeout',
      'The model did not begin responding within 1800 seconds after starting the request. More detail.',
      '1800',
    ],
    [
      'idle_timeout',
      'The model stopped producing output for 300 seconds. The partial response is preserved.',
      '300',
    ],
    ['connect_timeout', connectionError, '10.6'],
    [
      'headers_timeout',
      'The model server response headers timed out after 15.4 seconds (UND_ERR_HEADERS_TIMEOUT). More detail.',
      '15.4',
    ],
    [
      'body_timeout',
      'The model response stream timed out after 81.7 seconds (UND_ERR_BODY_TIMEOUT). More detail.',
      '81.7',
    ],
    [
      'http_408',
      'The model server or its gateway returned HTTP 408 after 7.1 seconds. More detail.',
      '7.1',
    ],
    [
      'http_504',
      'The model server or its gateway returned HTTP 504 after 8.2 seconds. More detail.',
      '8.2',
    ],
    [
      'unknown_timeout',
      'The model request timed out after 3.2 seconds, but its timeout source was not reported. More detail.',
      '3.2',
    ],
    [
      'transport_timeout',
      'The model transport reported a timeout after 6.5 seconds (ETIMEDOUT). The failing connection stage was not reported.',
      '6.5',
    ],
    [
      'transport_timeout',
      'The model transport reported a timeout after 6.5 seconds (ESOCKETTIMEDOUT). The failing connection stage was not reported.',
      '6.5',
    ],
  ] as const;
  for (const [reason, text, seconds] of cases) {
    for (const locale of ['ja', 'en'] as const) {
      const presentation = taskErrorPresentation(text, locale);
      assert.equal(presentation.reason, reason);
      assert.ok(presentation.detail?.includes(seconds));
    }
    assert.equal(taskErrorPresentation(`Provider quoted: ${text}`, 'ja').reason, 'unknown');
  }
  assert.match(taskErrorPresentation(cases[8][1], 'ja').title, /段階は未報告/);
  assert.equal(
    taskErrorPresentation(
      'The model server or its gateway returned HTTP 500 after 8.2 seconds.',
      'ja',
    ).reason,
    'unknown',
  );
});

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
const { RunProgress } = await import('../src/client/RunProgress');

function fixture(): Snapshot {
  return {
    version: '0.8.2-test',
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
    bots: [],
    rooms: [],
    messages: [message()],
    tasks: [task()],
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
let data: Snapshot;
let context: AppContextValue;
const copied: string[] = [];
const mutations: string[] = [];
function clipboard(writeText?: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}
async function mount(next = fixture()) {
  if (root) await act(async () => root!.unmount());
  data = next;
  copied.length = 0;
  mutations.length = 0;
  clipboard(async (text) => {
    copied.push(text);
  });
  context = {
    data,
    connected: true,
    locale: 'ja',
    t: (ja) => ja,
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
  root = createRoot(document.getElementById('root')!);
  await render();
}
async function render() {
  context = { ...context, data };
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        {data.messages.map((item) => (
          <RunProgress key={item.id} taskId={item.taskId!} message={item} />
        ))}
      </AppContext.Provider>,
    ),
  );
}
async function copy(panel: Element) {
  const button = panel.querySelector<HTMLButtonElement>('button[data-copy-task-diagnostics]')!;
  assert.ok(button);
  await act(async () => button.click());
}
function currentPanel() {
  const panel = document.querySelector('[data-task-diagnostics="current"]');
  assert.ok(panel);
  return panel;
}
after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});

test('current failures keep original text visible and copy diagnostics without prompt, output or reasoning', async () => {
  await mount();
  const panel = currentPanel();
  assert.equal(panel.getAttribute('data-task-error-reason'), 'connect_timeout');
  assert.match(panel.textContent || '', /モデルサーバーへの接続がタイムアウト/);
  const raw = panel.querySelector('[data-task-error]')!;
  assert.equal(raw.textContent, connectionError);
  assert.equal(
    raw.closest('details'),
    null,
    'Raw error must remain visible without expanding diagnostics',
  );
  const details = panel.querySelector<HTMLDetailsElement>('details[data-task-diagnostic-details]')!;
  assert.equal(details.open, false);
  await copy(panel);
  assert.deepEqual(copied, [
    formatTaskDiagnostic(taskDiagnostic(data.version, data.tasks[0], 'message')),
  ]);
  assert.doesNotMatch(copied[0], /PRIVATE_|A partial response/);
  assert.match(panel.querySelector('button')!.textContent!, /コピーしました/);
  assert.deepEqual(mutations, []);
});

test('current diagnostic clipboard follows linked work status and omits private work details', async () => {
  const next = fixture();
  next.tasks[0] = { ...task(), workId: 'work' };
  next.workItems = [work()];
  await mount(next);
  await copy(currentPanel());
  assert.equal(
    copied[0],
    formatTaskDiagnostic(
      taskDiagnostic(data.version, data.tasks[0], 'message', data.workItems![0]),
    ),
  );
  assert.match(copied[0], /Work ID: work\nWork status \(current\): blocked/);
  assert.doesNotMatch(copied[0], /PRIVATE_|A partial response/);

  data.workItems = [work({ status: 'active' })];
  await render();
  assert.doesNotMatch(currentPanel().querySelector('button')!.textContent || '', /コピーしました/);
  await copy(currentPanel());
  assert.match(copied[1], /Work status \(current\): active/);
  assert.match(copied[1], /Task status: failed/);
  assert.doesNotMatch(copied[1], /PRIVATE_|blocked/);

  for (const items of [[], [work({ roomId: 'other-room' })]]) {
    data.workItems = items;
    await render();
    await copy(currentPanel());
    const latest = copied.at(-1)!;
    assert.match(latest, /Work ID: work/);
    assert.doesNotMatch(latest, /Work status|other-room|PRIVATE_/);
  }
  assert.deepEqual(mutations, []);
});

test('older status-error logs retain their own diagnostics after the same task resumes and fails again', async () => {
  const next = fixture();
  next.messages = [
    message({ id: 'old-message' }),
    message({ id: 'new-message', createdAt: newTime, status: 'streaming' }),
  ];
  next.tasks[0] = { ...task(), workId: 'work', status: 'running', error: undefined };
  next.workItems = [work()];
  next.activities = [
    activity({ id: 'old-status', messageId: undefined }),
    activity({
      id: 'old-tool',
      messageId: 'old-message',
      kind: 'tool',
      detail: 'PRIVATE_TOOL_OUTPUT',
    }),
    activity({
      id: 'old-learning',
      messageId: 'old-message',
      kind: 'learning',
      detail: 'PRIVATE_LEARNING_OUTPUT',
    }),
  ];
  await mount(next);
  const older = document.querySelector('[data-run-message-id="old-message"]')!;
  const historical = older.querySelector('[data-task-diagnostics="activity"]')!;
  assert.ok(historical);
  assert.equal(older.querySelector('[data-task-diagnostics="current"]'), null);
  assert.equal(document.querySelectorAll('[data-task-diagnostics]').length, 1);
  assert.equal(
    older.querySelector('[data-activity-id="old-tool"] [data-copy-task-diagnostics]'),
    null,
  );
  assert.equal(
    older.querySelector('[data-activity-id="old-learning"] [data-copy-task-diagnostics]'),
    null,
  );
  await copy(historical);
  const originalCopy = copied[0];
  assert.ok(originalCopy.endsWith(legacyStop));
  assert.match(
    originalCopy,
    /Message ID: old-message\nActivity ID: old-status\nActivity status: error/,
  );
  assert.ok(originalCopy.includes(`Activity created at: ${oldTime}`));
  assert.doesNotMatch(originalCopy, /Task status|Work ID|Work status|new-message|PRIVATE_/);

  data.tasks[0] = {
    ...data.tasks[0],
    status: 'failed',
    error: connectionError,
    updatedAt: newTime,
  };
  data.messages[1] = { ...data.messages[1], status: 'error' };
  await render();
  await copy(historical);
  assert.equal(copied[1], originalCopy);
  await copy(currentPanel());
  assert.match(copied[2], /Work ID: work\nWork status \(current\): blocked/);
  assert.match(copied[2], /Message ID: new-message\nTask status: failed/);
  assert.ok(copied[2].endsWith(connectionError));
  assert.doesNotMatch(copied[2], /old-message|Stopped\./);
});

test('old stopped and unclassified timeout records never claim an owner or a particular timeout source', async () => {
  const next = fixture();
  next.tasks[0] = { ...task(), status: 'stopped', error: legacyStop };
  await mount(next);
  assert.equal(currentPanel().getAttribute('data-task-error-reason'), 'unknown');
  assert.match(currentPanel().textContent || '', /記録されたエラー/);
  assert.doesNotMatch(currentPanel().textContent || '', /停止操作|SIGTERM|初回応答|出力中の無応答/);
  data.tasks[0] = { ...data.tasks[0], status: 'failed', error: 'Request timed out.' };
  await render();
  assert.equal(currentPanel().getAttribute('data-task-error-reason'), 'unknown');
  assert.equal(
    currentPanel().querySelector('[data-task-error]')?.textContent,
    'Request timed out.',
  );
});

test('missing clipboard opens selectable diagnostics even after a previous copy succeeded', async () => {
  await mount();
  const panel = currentPanel();
  await copy(panel);
  clipboard();
  await copy(panel);
  assert.equal(
    panel.querySelector<HTMLDetailsElement>('[data-task-diagnostic-details]')?.open,
    true,
  );
  const text = panel.querySelector<HTMLElement>('[data-task-diagnostic-text]')!;
  assert.equal(text.tabIndex, 0);
  assert.equal(text.textContent, copied[0]);
  assert.match(panel.textContent || '', /診断情報を選択してコピー/);
  assert.equal(panel.querySelector('[data-task-error]')?.textContent, connectionError);
});

test('clipboard rejection leaves the historical error and manual-copy text available', async () => {
  const next = fixture();
  next.tasks[0] = { ...task(), status: 'running', error: undefined };
  next.activities = [activity()];
  await mount(next);
  clipboard(async () => {
    throw new Error('Permission denied');
  });
  const panel = document.querySelector('[data-task-diagnostics="activity"]')!;
  await copy(panel);
  assert.equal(
    panel.querySelector<HTMLDetailsElement>('[data-task-diagnostic-details]')?.open,
    true,
  );
  assert.ok(panel.querySelector('[data-task-diagnostic-text]')?.textContent?.endsWith(legacyStop));
  assert.equal(panel.querySelector('[data-task-error]')?.textContent, legacyStop);
  assert.match(panel.textContent || '', /コピーできませんでした/);
  assert.doesNotMatch(panel.textContent || '', /Permission denied/);
});

test('a pending copy cannot label a newly received error as copied', async () => {
  await mount();
  let complete!: () => void;
  clipboard(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  await copy(currentPanel());
  assert.equal(currentPanel().querySelector<HTMLButtonElement>('button')?.disabled, true);
  data.tasks[0] = {
    ...data.tasks[0],
    error: taskInterruptionMessage('process_sigterm'),
    status: 'interrupted',
  };
  await render();
  await act(async () => complete());
  assert.equal(currentPanel().getAttribute('data-task-error-reason'), 'process_sigterm');
  assert.doesNotMatch(currentPanel().querySelector('button')?.textContent || '', /コピーしました/);
  assert.equal(currentPanel().querySelector('[data-task-error]')?.textContent, data.tasks[0].error);
});
