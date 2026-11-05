import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Message, Snapshot, Task } from '../src/shared/types';

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
  fetch: async (path: string) => {
    assert.equal(path, '/api/workspace-picker');
    return new Response(
      JSON.stringify({ available: false, platform: 'linux', reason: 'headless' }),
    );
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
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('../src/client/context');
const { Chat } = await import('../src/client/Chat');

const now = '2026-11-04T00:00:00.000Z';
function fixture(): Snapshot {
  return {
    version: 'test',
    settings: {
      model: {
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'fixture',
        apiKeyConfigured: false,
        contextWindow: 32768,
        maxOutputTokens: 4096,
        temperature: 0.7,
      },
      demoMode: false,
      autoLearn: false,
      maxHandoffs: 6,
      workspacePath: 'C:\\Loom\\Default',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: ['Aster', 'Nova'].map((name, index) => ({
      id: `bot_${index}`,
      name,
      handle: name.toLowerCase(),
      role: 'Research',
      avatar: 'sparkles',
      color: '#829479',
      systemPrompt: 'Test bot.',
      enabled: index === 0,
      createdAt: now,
    })),
    rooms: ['Research', 'Planning'].map((name, index) => ({
      id: `room_${index}`,
      name,
      description: index === 0 ? 'Research a topic.\nKeep full details available.' : '',
      botIds: index === 0 ? ['bot_0', 'bot_1'] : ['bot_0'],
      workspacePath: index === 0 ? 'D:\\Projects\\Room-specific workspace' : undefined,
      parallelResponses: index === 0,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    })),
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
function task(id: string, roomId: string, status: Task['status']): Task {
  return {
    id,
    roomId,
    botId: 'bot_0',
    prompt: 'Test task',
    status,
    rootTaskId: id,
    depth: 0,
    kind: 'chat',
    output: '',
    createdAt: now,
    updatedAt: now,
    inputTokens: 0,
    outputTokens: 0,
  };
}
function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    roomId: 'room_0',
    authorType: 'bot',
    authorId: 'bot_0',
    body: `Response ${id}`,
    status: 'complete',
    createdAt: now,
    ...overrides,
  };
}
function messageHeader(id: string) {
  const found = document.querySelector<HTMLElement>(
    `[data-message-id="${id}"] > .message-main > .message-header`,
  );
  assert.ok(found, `Missing message header: ${id}`);
  return found;
}
function contextLabel(id: string) {
  return messageHeader(id).querySelector('.message-context-label')?.textContent;
}
let root: ReturnType<typeof createRoot> | undefined;
let context: AppContextValue;
let focusMode = false;
let openActivityCalls = 0;
const mutations: { path: string; method?: string; body?: unknown }[] = [];
async function mount(data = fixture(), focused = false, width = 1440) {
  if (root) await act(async () => root!.unmount());
  localStorage.clear();
  Object.defineProperty(dom.window, 'innerWidth', { value: width, configurable: true });
  mutations.length = 0;
  openActivityCalls = 0;
  focusMode = focused;
  context = {
    data,
    locale: 'en',
    t: (_ja, en) => en,
    view: 'chat',
    roomId: data.rooms[0].id,
    connected: true,
    navigate() {},
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string, method?: string, body?: unknown) {
      mutations.push({ path, method, body });
      return {} as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await render();
}
async function render() {
  await act(async () => {
    root!.render(
      <AppContext.Provider value={context}>
        <Chat
          room={context.data.rooms.find((room) => room.id === context.roomId)}
          focusMode={focusMode}
          onOpenActivity={() => openActivityCalls++}
        />
      </AppContext.Provider>,
    );
  });
}
function button(label: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label,
  );
  assert.ok(found, `Missing button: ${label}`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => {
    element.focus();
    element.click();
  });
}
async function draft(value: string) {
  const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      composer,
      value,
    );
    composer.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
function dialog() {
  const found = document.querySelector<HTMLDialogElement>('dialog[open]');
  assert.ok(found, 'A room dialog must be open.');
  return found;
}
async function cancelDialog() {
  await act(async () => {
    dialog().dispatchEvent(new dom.window.Event('cancel', { cancelable: true }));
  });
}

test('normal, focused, and narrow layouts put room metadata behind one accessible details action', async () => {
  for (const [focused, width] of [
    [false, 1440],
    [true, 1440],
    [false, 390],
  ] as const) {
    const data = fixture();
    await mount(data, focused, width);
    const header = document.querySelector('.room-header')!;
    assert.equal(header.querySelector('h1')?.textContent, data.rooms[0].name);
    assert.equal(header.querySelector('h1')?.getAttribute('title'), data.rooms[0].name);
    assert.equal(document.querySelector('.room-context'), null);
    assert.equal(header.querySelector('.room-workspace-link'), null);
    assert.ok(!header.textContent?.includes(data.rooms[0].description));
    assert.ok(!header.textContent?.includes('No active tasks'));
    assert.equal(document.querySelector('dialog'), null);
    await draft('Keep this message while reading room details.');
    const trigger = button('Show room details', header);
    assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await click(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const details = dialog();
    assert.equal(details.querySelector('h2')?.textContent, 'Room details');
    assert.equal(
      details.querySelector('.room-details-description')?.textContent,
      data.rooms[0].description,
    );
    assert.equal(
      details.querySelector('.room-workspace-link')?.textContent,
      data.rooms[0].workspacePath,
    );
    assert.match(details.textContent || '', /Workspace set for this room/);
    assert.match(details.textContent || '', /Parallel responses allowed/);
    assert.deepEqual(
      [...details.querySelectorAll('.room-details-members strong')].map((item) => item.textContent),
      ['Aster', 'Nova'],
    );
    assert.match(
      details.querySelector('.room-details-members')?.textContent || '',
      /Nova.*Disabled/s,
    );
    await cancelDialog();
    assert.equal(document.querySelector('dialog'), null);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, trigger);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value,
      'Keep this message while reading room details.',
    );
    assert.equal(mutations.length, 0);
  }
});

test('workspace, simultaneous-response, and edit actions transfer to the existing room editor', async () => {
  await mount();
  await draft('Unsent draft');
  for (const label of [
    'Change this room’s workspace',
    'Configure simultaneous responses in this room',
    'Edit room',
  ]) {
    await click(button('Show room details'));
    await click(button(label, dialog()));
    assert.equal(document.querySelectorAll('dialog[open]').length, 1);
    assert.equal(dialog().querySelector('h2')?.textContent, 'Edit room');
    assert.equal(dialog().querySelector<HTMLInputElement>('input')?.value, 'Research');
    assert.equal(
      dialog().querySelector('.workspace-path')?.textContent,
      context.data.rooms[0].workspacePath,
    );
    assert.equal(
      dialog().querySelector('.room-generation-field input')?.getAttribute('type'),
      'checkbox',
    );
    await cancelDialog();
    assert.equal(
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value,
      'Unsent draft',
    );
    assert.equal(document.activeElement, button('Show room details'));
  }
  assert.equal(mutations.length, 0);
});

test('member avatars open full details and switching rooms closes stale metadata while retaining drafts', async () => {
  await mount();
  await draft('Research draft');
  await click(button('Show 2 room members'));
  assert.equal(dialog().querySelectorAll('.room-details-members li').length, 2);
  context = { ...context, roomId: 'room_1' };
  await render();
  assert.equal(document.querySelector('dialog'), null);
  assert.equal(button('Show room details').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('.room-header h1')?.textContent, 'Planning');
  await click(button('Show room details'));
  assert.equal(
    dialog().querySelector('.room-workspace-link')?.textContent,
    context.data.settings.workspacePath,
  );
  assert.match(dialog().textContent || '', /Using the default workspace/);
  assert.match(dialog().textContent || '', /One response at a time/);
  assert.match(dialog().textContent || '', /No room purpose set/);
  assert.equal(dialog().querySelectorAll('.room-details-members li').length, 1);
  await click(button('Close', dialog()));
  context = { ...context, roomId: 'room_0' };
  await render();
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value,
    'Research draft',
  );
});

test('the compact header pauses the room as a whole without cancelling active or queued tasks', async () => {
  const data = fixture();
  data.tasks = [
    task('running', 'room_0', 'running'),
    task('queued', 'room_0', 'queued'),
    task('done', 'room_0', 'completed'),
    task('other', 'room_1', 'running'),
  ];
  await mount(data, true, 390);
  await click(
    button('Pause this room after current tasks finish', document.querySelector('.room-header')!),
  );
  assert.deepEqual(mutations, [{ path: '/rooms/room_0/pause', method: 'POST', body: undefined }]);
  assert.equal(document.querySelector('.composer-area [data-room-activity]'), null);
  assert.deepEqual(
    data.tasks.map((item) => item.status),
    ['running', 'queued', 'completed', 'running'],
  );
  context = {
    ...context,
    data: {
      ...data,
      rooms: data.rooms.map((item) => (item.id === 'room_0' ? { ...item, paused: true } : item)),
    },
  };
  await render();
  assert.equal(document.querySelector('.room-pause-state')?.textContent, 'Pausing');
  assert.ok(button('Resume this room'));
  context = {
    ...context,
    data: {
      ...context.data,
      tasks: data.tasks.map((item) =>
        item.id === 'running' ? { ...item, status: 'completed' } : item,
      ),
    },
  };
  await render();
  assert.equal(
    document.querySelector('.room-pause-state')?.textContent,
    'Paused',
    'Queued work and another room’s generation do not prevent the room from resting.',
  );
  await click(button('Resume this room'));
  assert.deepEqual(
    mutations.map((item) => item.path),
    ['/rooms/room_0/pause', '/rooms/room_0/resume'],
  );
  assert.equal(
    document.querySelector('.room-header button[aria-label="Stop work in this room"]'),
    null,
  );
});

test('an idle room can be paused and messages sent while paused do not implicitly resume it', async () => {
  const data = fixture();
  await mount(data);
  await click(button('Pause this room after current tasks finish'));
  assert.equal(mutations.at(-1)?.path, '/rooms/room_0/pause');
  context = {
    ...context,
    data: { ...data, rooms: data.rooms.map((item) => ({ ...item, paused: true })) },
  };
  await render();
  const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
  assert.equal(composer.rows, 1);
  assert.match(composer.placeholder, /resumes/);
  assert.match(button('Send message').title, /after the room resumes/);
  await draft('Keep this request until I resume.');
  await click(button('Send message'));
  assert.deepEqual(mutations.at(-1), {
    path: '/rooms/room_0/messages',
    method: 'POST',
    body: { body: 'Keep this request until I resume.' },
  });
  assert.equal(
    mutations.some((item) => item.path.endsWith('/resume')),
    false,
  );
  assert.equal(document.querySelector('.room-pause-state')?.textContent, 'Paused');
});

test('welcome and Activity selections add visible mentions without hidden recipient state', async () => {
  const data = fixture();
  data.bots.forEach((bot) => (bot.enabled = true));
  await mount(data);
  await draft('Please review this idea.');
  const composer = document.querySelector<HTMLTextAreaElement>('.composer textarea')!;
  const aster = [...document.querySelectorAll<HTMLButtonElement>('.welcome-members button')].find(
    (item) => item.textContent?.includes('Aster'),
  )!;
  await click(aster);
  const firstSelection = composer.value;
  assert.match(firstSelection, /Please review this idea\./);
  assert.match(firstSelection, /@aster\b/);
  await click(aster);
  assert.equal(composer.value, firstSelection, 'Repeated selection does not duplicate a mention');
  await click(button('Nova: Idle', document.querySelector('.activity-panel')!));
  assert.match(composer.value, /@aster\b/);
  assert.match(composer.value, /@nova\b/);
  assert.equal(mutations.length, 0, 'Selecting a teammate does not submit the draft');
  const body = composer.value.trim();
  await click(button('Send message'));
  assert.deepEqual(mutations, [{ path: '/rooms/room_0/messages', method: 'POST', body: { body } }]);
});

test('room pause uses one request at a time and cannot be changed while disconnected', async () => {
  await mount();
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  context = {
    ...context,
    async mutate<T>(path: string, method?: string, body?: unknown) {
      mutations.push({ path, method, body });
      await waiting;
      return {} as T;
    },
  };
  await render();
  const pause = button('Pause this room after current tasks finish');
  await act(async () => {
    pause.click();
    pause.click();
  });
  assert.equal(mutations.length, 1);
  assert.equal(pause.disabled, true);
  await act(async () => finish());
  assert.equal(pause.disabled, false);
  context = { ...context, connected: false };
  await render();
  assert.equal(pause.disabled, true);
  await click(pause);
  assert.equal(mutations.length, 1);
  await draft('Wait for the connection.');
  assert.equal(button('Send message').disabled, true);
});

test('message headers distinguish persisted recipients from shared replies and retain sender roles', async () => {
  const data = fixture();
  const rootTask = task('root_request', 'room_0', 'completed');
  const childTask: Task = {
    ...task('child_request', 'room_0', 'completed'),
    botId: 'bot_1',
    parentTaskId: rootTask.id,
    rootTaskId: rootTask.id,
    depth: 1,
  };
  const automation: Task = {
    ...task('automation', 'room_0', 'completed'),
    kind: 'automation',
  };
  data.tasks = [rootTask, childTask, automation];
  data.messages = [
    message('user_request', {
      authorType: 'user',
      authorId: 'user',
      targetBotIds: ['bot_0', 'bot_1', 'bot_0'],
    }),
    message('directed_request', { taskId: rootTask.id, targetBotIds: ['bot_1'] }),
    message('user_reply', { taskId: rootTask.id }),
    message('child_reply', { authorId: 'bot_1', taskId: childTask.id }),
    message('automation_reply', { taskId: automation.id }),
    message('legacy_reply', { body: '@nova please review this. These are only words.' }),
  ];
  await mount(data);
  for (const [id, kind, label] of [
    ['user_request', 'directed', '→ 2 bots'],
    ['directed_request', 'directed', '→ Nova'],
    ['user_reply', 'user-reply', 'Reply to your request'],
    ['child_reply', 'bot-reply', 'Bot request reply · Aster'],
    ['automation_reply', 'automation', 'Automation report'],
    ['legacy_reply', 'room', 'Shared with room'],
  ]) {
    const header = messageHeader(id);
    const badge = header.querySelector<HTMLElement>('.message-context-badge')!;
    assert.equal(contextLabel(id), label);
    assert.equal(badge.dataset.messageContext, kind);
    assert.match(badge.title, /shared with the room/);
    assert.equal(badge.querySelector('.visually-hidden')?.textContent, badge.title);
    assert.equal(header.querySelector('.message-role'), null);
  }
  const targets =
    messageHeader('user_request').querySelector<HTMLElement>('.message-context-badge')!;
  assert.match(targets.title, /Aster \(@aster\), Nova \(@nova\)/);
  assert.equal(data.bots[1].enabled, false, 'Historical recipients remain named when disabled');
  const child = messageHeader('child_reply');
  assert.match(
    child.querySelector('.message-context-badge')!.getAttribute('title')!,
    /not an automatic message back to the requester/,
  );
  assert.equal(child.querySelector('strong')?.title, 'Nova (@nova) · Research');
  assert.equal(child.querySelector('strong')?.textContent, 'Nova');
  assert.equal(mutations.length, 0);
});

test('memoized message headers refresh when recipients, bot names, or request provenance change', async () => {
  const data = fixture();
  const rootTask = task('root_request', 'room_0', 'completed');
  const childTask: Task = {
    ...task('child_request', 'room_0', 'completed'),
    botId: 'bot_1',
    parentTaskId: rootTask.id,
    rootTaskId: rootTask.id,
    depth: 1,
  };
  data.tasks = [rootTask, childTask];
  data.messages = [
    message('directed_request', { targetBotIds: ['bot_1'] }),
    message('child_reply', { authorId: 'bot_1', taskId: childTask.id }),
  ];
  await mount(data);
  context = {
    ...context,
    data: {
      ...context.data,
      bots: context.data.bots.map((bot) =>
        bot.id === 'bot_1' ? { ...bot, name: 'Nova renamed', handle: 'nova-new' } : bot,
      ),
    },
  };
  await render();
  assert.equal(contextLabel('directed_request'), '→ Nova renamed');
  assert.match(
    messageHeader('directed_request').querySelector<HTMLElement>('.message-context-badge')!.title,
    /@nova-new/,
  );
  context = {
    ...context,
    data: {
      ...context.data,
      messages: context.data.messages.map((item) =>
        item.id === 'directed_request' ? { ...item, targetBotIds: ['bot_0'] } : item,
      ),
      bots: context.data.bots.map((bot) =>
        bot.id === 'bot_0' ? { ...bot, name: 'Aster renamed' } : bot,
      ),
    },
  };
  await render();
  assert.equal(contextLabel('directed_request'), '→ Aster renamed');
  assert.equal(contextLabel('child_reply'), 'Bot request reply · Aster renamed');
  context = {
    ...context,
    data: {
      ...context.data,
      tasks: context.data.tasks.filter((item) => item.id !== rootTask.id),
    },
  };
  await render();
  assert.equal(
    contextLabel('child_reply'),
    'Shared with room',
    'A missing parent is not guessed from message text',
  );
  assert.equal(
    contextLabel('directed_request'),
    '→ Aster renamed',
    'Explicit recipients do not depend on task records',
  );
});

test('explicit messages to the user stay distinct from request replies and reject ambiguous routing', async () => {
  const data = fixture();
  const rootTask = task('root_request', 'room_0', 'completed');
  data.tasks = [rootTask];
  data.messages = [message('addressed', { taskId: rootTask.id })];
  await mount(data);
  assert.equal(contextLabel('addressed'), 'Reply to your request');
  context = {
    ...context,
    data: {
      ...context.data,
      messages: context.data.messages.map((item) => ({
        ...item,
        targetUser: true,
      })),
    },
  };
  await render();
  let badge = messageHeader('addressed').querySelector<HTMLElement>('.message-context-badge')!;
  assert.equal(contextLabel('addressed'), '→ You');
  assert.equal(badge.dataset.messageContext, 'user-directed');
  assert.match(badge.title, /addressed to you/);
  assert.match(badge.title, /shared with the room/);
  context = { ...context, locale: 'ja', t: (ja) => ja };
  await render();
  assert.equal(contextLabel('addressed'), '→ あなた');
  badge = messageHeader('addressed').querySelector<HTMLElement>('.message-context-badge')!;
  assert.equal(badge.title, 'あなた宛てに送られたメッセージです。ルーム内で共有されます。');
  context = {
    ...context,
    data: {
      ...context.data,
      messages: context.data.messages.map((item) => ({ ...item, targetBotIds: ['bot_1'] })),
    },
  };
  await render();
  assert.equal(
    contextLabel('addressed'),
    'ルーム共有',
    'Conflicting target fields do not establish an audience',
  );
  context = {
    ...context,
    data: {
      ...context.data,
      messages: context.data.messages.map((item) => ({ ...item, targetUser: false })),
    },
  };
  await render();
  assert.equal(
    contextLabel('addressed'),
    '→ Nova',
    'Removing the user destination restores explicit bot recipients',
  );
  context = {
    ...context,
    data: {
      ...context.data,
      messages: context.data.messages.map((item) => ({ ...item, targetBotIds: [] })),
    },
  };
  await render();
  assert.equal(
    contextLabel('addressed'),
    'あなたの依頼への回答',
    'A normal response is not relabelled as a proactive message',
  );
});

test('directed posts do not take over a running output card or its streaming cursor', async () => {
  const data = fixture();
  const running = task('running_task', 'room_0', 'running');
  data.tasks = [running];
  data.messages = [
    message('actual_output', { taskId: running.id, status: 'streaming' }),
    message('bot_request', { taskId: running.id, targetBotIds: ['bot_1'] }),
    message('proactive', { taskId: running.id, targetUser: true }),
  ];
  await mount(data);
  const output = document.querySelector('[data-message-id="actual_output"]')!;
  const progress = output.querySelector<HTMLElement>('.run-progress')!;
  assert.ok(progress);
  assert.equal(progress.dataset.currentRun, 'true');
  assert.equal(progress.dataset.runMessageId, 'actual_output');
  assert.ok(output.querySelector('.stream-cursor'));
  for (const id of ['bot_request', 'proactive'])
    assert.equal(document.querySelector(`[data-message-id="${id}"] .run-progress`), null);
  assert.equal(document.querySelectorAll('.run-progress').length, 1);
  context = { ...context, data: { ...context.data, messages: context.data.messages.slice(1) } };
  await render();
  assert.equal(
    document.querySelectorAll('.standalone-runs .run-progress').length,
    1,
    'A directed post cannot hide the standalone task when its output is absent',
  );
});

test('unknown-context memoization still updates whether a message owns a task output card', async () => {
  const data = fixture();
  const orphaned: Task = {
    ...task('orphaned_task', 'room_0', 'completed'),
    parentTaskId: 'missing_parent',
    rootTaskId: 'missing_parent',
    depth: 1,
  };
  data.tasks = [orphaned];
  data.messages = [message('unknown', { taskId: orphaned.id })];
  await mount(data);
  assert.equal(contextLabel('unknown'), 'Shared with room');
  assert.ok(document.querySelector('[data-message-id="unknown"] .run-progress'));
  context = {
    ...context,
    data: {
      ...context.data,
      messages: context.data.messages.map((item) => ({
        ...item,
        targetUser: true,
        targetBotIds: ['bot_1'],
      })),
    },
  };
  await render();
  assert.equal(contextLabel('unknown'), 'Shared with room');
  assert.equal(document.querySelector('[data-message-id="unknown"] .run-progress'), null);
});

test('recipient labels retain missing targets and localize without guessing past audiences', async () => {
  const data = fixture();
  data.messages = [
    message('unavailable', { targetBotIds: ['removed_bot'] }),
    message('legacy', { authorType: 'user', authorId: 'user', body: '@all historical message' }),
  ];
  await mount(data, false, 390);
  assert.equal(contextLabel('unavailable'), '→ Unknown bot');
  assert.equal(contextLabel('legacy'), 'Shared with room');
  context = { ...context, locale: 'ja', t: (ja) => ja };
  await render();
  assert.equal(contextLabel('unavailable'), '→ 不明なボット');
  assert.equal(contextLabel('legacy'), 'ルーム共有');
  assert.match(
    messageHeader('unavailable').querySelector<HTMLElement>('.message-context-badge')!.title,
    /宛先: 不明なボット。ルーム内で共有される投稿です。/,
  );
});

test('activity opening retains the focus-layout callback and the room menu remains usable', async () => {
  await mount(fixture(), true);
  const toggle = button('Toggle activity');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  await click(toggle);
  assert.equal(openActivityCalls, 1);
  focusMode = false;
  await render();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(document.querySelector('#activity-panel'));
  await click(toggle);
  assert.equal(document.querySelector('#activity-panel'), null);
  assert.equal(openActivityCalls, 1);
  const menu = document.querySelector<HTMLDetailsElement>('.room-menu')!;
  await click(menu.querySelector('summary')!);
  assert.equal(menu.open, true);
  await click(button('Pin room', menu));
  assert.equal(menu.open, false);
  assert.deepEqual(mutations, [{ path: '/rooms/room_0', method: 'PATCH', body: { pinned: true } }]);
  await click(menu.querySelector('summary')!);
  await click(button('Edit room', menu));
  assert.equal(dialog().querySelector('h2')?.textContent, 'Edit room');
});

after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});
