import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { ChatImageUpload } from '../src/shared/image-inputs';
import type { Message, Snapshot, Task, TaskInput, TaskInputResult } from '../src/shared/types';

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
const { ApiError } = await import('../src/client/api');
const nativeReader = dom.window.FileReader;
const stamp = '2026-11-10T00:00:00.000Z';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aixkAAAAASUVORK5CYII=';

function fixture(): Snapshot {
  const room = {
    id: 'room_a',
    name: 'Room A',
    description: '',
    botIds: ['bot_a'],
    pinned: false,
    archived: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
  return {
    version: 'test',
    settings: {
      model: {
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'image-capable-model',
        imageInput: true,
        apiKeyConfigured: false,
        contextWindow: 32768,
        maxOutputTokens: 4096,
        temperature: 0.7,
      },
      demoMode: false,
      autoLearn: false,
      maxHandoffs: 6,
      workspacePath: '/test',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: [
      {
        id: 'bot_a',
        name: 'Aster',
        handle: 'aster',
        role: 'Research',
        systemPrompt: 'Test bot.',
        avatar: 'sparkles',
        color: '#829479',
        enabled: true,
        createdAt: stamp,
      },
    ],
    rooms: [room, { ...room, id: 'room_b', name: 'Room B' }],
    messages: [],
    tasks: [],
    taskInputs: [],
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
let context: AppContextValue;
const requests: Array<{
  path: string;
  body: { body: string; images?: ChatImageUpload[]; requestId?: string; mode?: string };
}> = [];
let respond: () => Promise<void> = async () => {};
let selectedRoom = 0;
const navigation: string[] = [];
async function mount(clear = true, prepare?: (data: Snapshot) => void) {
  if (clear) localStorage.clear();
  localStorage.setItem('loom.activity', 'false');
  requests.length = 0;
  navigation.length = 0;
  selectedRoom = 0;
  respond = async () => {};
  context = {
    data: fixture(),
    locale: 'en',
    t: (_, en) => en,
    view: 'chat',
    roomId: 'room_a',
    navigate(view) {
      navigation.push(view);
    },
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string, _method?: string, body?: unknown) {
      requests.push({ path, body: body as (typeof requests)[number]['body'] });
      await respond();
      return {} as T;
    },
  };
  const task = activeTask('task_a');
  context.data.tasks.push(task);
  context.data.messages.push(response(task));
  prepare?.(context.data);
  root = createRoot(document.getElementById('root')!);
  await render();
}
async function render() {
  context = { ...context, data: { ...context.data } };
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        <Chat room={context.data.rooms[selectedRoom]} />
      </AppContext.Provider>,
    ),
  );
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  Object.defineProperty(dom.window, 'FileReader', { configurable: true, value: nativeReader });
});
after(() => dom.window.close());

function file(name = 'example.png') {
  return new dom.window.File([Buffer.from(png, 'base64')], name, { type: 'image/png' });
}
function button(label: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label,
  );
  assert.ok(element, `Missing button ${label}`);
  return element;
}
async function paste(files: File[] = [], text = '') {
  const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, getData: () => text } });
  await act(async () => document.querySelector('textarea')!.dispatchEvent(event));
  return event;
}
async function choose(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
}
async function ready(count = 1) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (document.querySelectorAll('.composer-image-thumb img').length === count) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  assert.equal(document.querySelectorAll('.composer-image-thumb img').length, count);
}
async function submit() {
  await act(async () =>
    document
      .querySelector('form.composer')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  );
}
async function write(value: string) {
  const input = document.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

function activeTask(id: string, status: Task['status'] = 'running', roomId = 'room_a'): Task {
  return {
    id,
    roomId,
    botId: 'bot_a',
    prompt: `Original work ${id}`,
    status,
    kind: 'chat',
    rootTaskId: id,
    depth: 0,
    output: '',
    createdAt: stamp,
    updatedAt: stamp,
    startedAt: stamp,
    inputTokens: 0,
    outputTokens: 0,
  };
}
function response(task: Task, suffix = '') {
  return {
    id: `message_${task.id}${suffix}`,
    roomId: task.roomId,
    taskId: task.id,
    authorType: 'bot' as const,
    authorId: task.botId,
    body: 'Working on the original request.',
    status: 'streaming' as const,
    createdAt: stamp,
  };
}
async function selectTask(taskId = 'task_a') {
  const action = document.querySelector<HTMLButtonElement>(`[data-task-input-action="${taskId}"]`);
  assert.ok(action, `Instruction action for ${taskId}`);
  await act(async () => action.click());
}
function inputTarget() {
  return document.querySelector<HTMLElement>('[data-task-input-target]');
}
async function click(label: string) {
  await act(async () => button(label).click());
}

function receiptFor(request = requests.at(-1)!): TaskInputResult {
  const taskId = decodeURIComponent(request.path.split('/')[2]);
  const task = context.data.tasks.find((item) => item.id === taskId)!;
  const input: TaskInput = {
    id: 'taskinput_' + request.body.requestId!.replaceAll('-', ''),
    requestId: request.body.requestId!,
    taskId,
    roomId: task.roomId,
    botId: task.botId,
    messageId: 'instruction_' + request.body.requestId,
    sequence: 1,
    body: request.body.body,
    mode: request.body.mode as TaskInput['mode'],
    status: 'pending',
    createdAt: stamp,
    ...(request.body.images?.length
      ? { inputImageIds: request.body.images.map((_, index) => 'img_' + String(index).repeat(64)) }
      : {}),
  };
  const message: Message = {
    id: input.messageId,
    taskId,
    roomId: input.roomId,
    taskInputId: input.id,
    authorType: 'user',
    authorId: 'user',
    targetBotIds: [input.botId],
    body: input.body,
    status: 'complete',
    createdAt: stamp,
    ...(request.body.images?.length
      ? {
          attachments: request.body.images.map((image, index) => ({
            id: input.inputImageIds![index],
            type: 'image',
            source: 'uploaded',
            filename: image.filename
              .split(/[\\/]/)
              .at(-1)!
              .replace(/[\x00-\x1f\x7f]/g, '')
              .trim(),
            mimeType: image.mimeType,
            byteLength: Buffer.from(image.data, 'base64').length,
            prompt: '',
            model: '',
            createdAt: stamp,
          })),
        }
      : {}),
  };
  return { input, message, duplicate: false };
}

function publishReceipt(receipt: TaskInputResult, data = context.data) {
  data.taskInputs = [
    ...data.taskInputs.filter((item) => item.id !== receipt.input.id),
    receipt.input,
  ];
  data.messages = [
    ...data.messages.filter((item) => item.id !== receipt.message.id),
    receipt.message,
  ];
}

test('normal sending keeps new-task semantics while an explicit instruction targets only its chosen task', async () => {
  await mount();
  await write('A separate request');
  await submit();
  assert.equal(requests[0].path, '/rooms/room_a/messages');
  assert.equal(requests[0].body.requestId, undefined);
  await selectTask();
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a');
  assert.match(inputTarget()?.textContent || '', /Aster.*Original work task_a/);
  await write('@all @nova use the newer specification');
  await submit();
  assert.equal(requests[1].path, '/tasks/task_a/inputs');
  assert.equal(requests[1].body.mode, 'boundary');
  assert.match(requests[1].body.requestId!, /^[a-f0-9-]{36}$/);
  assert.equal(requests[1].body.body, '@all @nova use the newer specification');
  assert.equal('botIds' in requests[1].body, false);
  assert.equal(context.data.tasks.length, 1, 'the UI does not enqueue another task');
  assert.equal(document.querySelector<HTMLTextAreaElement>('textarea')!.value, '');
  assert.equal(inputTarget(), null);
  assert.deepEqual(JSON.parse(localStorage.getItem('loom.task-input-targets')!), {});
  await write('The next separate request');
  await submit();
  assert.equal(requests[2].path, '/rooms/room_a/messages');
});

test('immediate mode is explicit, remains scoped to the task, and tools and paused rooms explain their boundary', async () => {
  await mount();
  await selectTask();
  const checkbox = document.querySelector<HTMLInputElement>('.task-input-immediate input')!;
  assert.equal(checkbox.checked, false);
  assert.equal(checkbox.disabled, false);
  await act(async () => checkbox.click());
  await write('Change the output format now');
  await submit();
  assert.equal(requests[0].body.mode, 'immediate');
  assert.equal(inputTarget(), null);
  context.data.tasks[0].status = 'waiting_tool';
  await render();
  await selectTask();
  assert.equal(
    document.querySelector<HTMLInputElement>('.task-input-immediate input')!.disabled,
    true,
  );
  assert.match(inputTarget()?.textContent || '', /after the current action finishes/);
  context.data.rooms[0].paused = true;
  await render();
  assert.match(inputTarget()?.textContent || '', /delivered after the room resumes/);
  await write('Save this until resume');
  await submit();
  assert.equal(requests.at(-1)?.path, '/tasks/task_a/inputs');
  assert.equal(
    requests.some((request) => /\/resume$/.test(request.path)),
    false,
  );
});

test('an uncertain send reuses its request ID across room switches and changes it only for a different submission', async () => {
  await mount();
  await selectTask();
  await write('Use the corrected source');
  respond = async () => {
    throw new Error('Response lost');
  };
  await submit();
  const firstId = requests.at(-1)!.body.requestId;
  selectedRoom = 1;
  await render();
  assert.equal(inputTarget(), null);
  assert.equal(document.querySelector<HTMLTextAreaElement>('textarea')!.value, '');
  await write('Room B draft');
  selectedRoom = 0;
  await render();
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a');
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('textarea')!.value,
    'Use the corrected source',
  );
  await submit();
  assert.equal(requests.at(-1)!.body.requestId, firstId);
  await write('Use a different source');
  await submit();
  assert.notEqual(requests.at(-1)!.body.requestId, firstId);
  assert.match(document.body.textContent || '', /Receipt could not be confirmed/);
});

test('a retained text draft and target recover the same uncertain request after the chat remounts', async () => {
  await mount();
  await selectTask();
  await write('Keep this instruction');
  respond = async () => {
    throw new Error('Response lost');
  };
  await submit();
  const firstId = requests.at(-1)!.body.requestId;
  await act(async () => root!.unmount());
  root = undefined;
  await mount(false);
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a');
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('textarea')!.value,
    'Keep this instruction',
  );
  await submit();
  assert.equal(requests.at(-1)!.body.requestId, firstId);
});

test('a task finishing during send keeps the draft and requires explicit new-request fallback', async () => {
  await mount();
  await selectTask();
  await write('Please correct the plan');
  respond = async () => {
    context.data.tasks[0].status = 'completed';
    throw new ApiError('Task finished', 409);
  };
  await submit();
  await render();
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a');
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('textarea')!.value,
    'Please correct the plan',
  );
  assert.match(document.body.textContent || '', /The task changed and could not accept/);
  assert.equal(requests[0].path, '/tasks/task_a/inputs');
  await click('Clear instruction target and start a new request');
  respond = async () => {};
  await submit();
  assert.equal(requests[1].path, '/rooms/room_a/messages');
  assert.equal(requests[1].body.body, 'Please correct the plan');
});

test('an uncertain request can retrieve its receipt after completion without changing its identity', async () => {
  await mount();
  await selectTask();
  await write('Additional constraint');
  respond = async () => {
    throw new Error('Response lost after acceptance');
  };
  await submit();
  const firstId = requests[0].body.requestId;
  context.data.tasks[0].status = 'completed';
  await render();
  respond = async () => {};
  await submit();
  assert.equal(requests[1].path, '/tasks/task_a/inputs');
  assert.equal(requests[1].body.requestId, firstId);
  assert.equal(document.querySelector<HTMLTextAreaElement>('textarea')!.value, '');
  assert.equal(inputTarget(), null);
  await write('A new request after completion');
  await submit();
  assert.equal(requests[2].path, '/rooms/room_a/messages');
  assert.equal(requests[2].body.requestId, undefined);
});

test('image-only task instructions preserve real bytes and retry identity without saving pixels in browser storage', async () => {
  await mount();
  await selectTask();
  await choose([file('変更図.png')]);
  await ready();
  respond = async () => {
    throw new Error('Response lost');
  };
  await submit();
  assert.equal(requests[0].body.body, '');
  assert.equal(requests[0].body.images?.[0].filename, '変更図.png');
  assert.equal(requests[0].body.images?.[0].data, png);
  const firstId = requests[0].body.requestId;
  assert.equal(document.querySelectorAll('.composer-image-thumb img').length, 1);
  for (let index = 0; index < localStorage.length; index++)
    assert.equal(localStorage.getItem(localStorage.key(index)!)!.includes(png), false);
  respond = async () => {};
  await submit();
  assert.equal(requests[1].body.requestId, firstId);
  assert.equal(document.querySelectorAll('.composer-image-thumb img').length, 0);
  assert.equal(inputTarget(), null);
});

test('a delayed successful send never clears a newer draft or changes another room target', async () => {
  await mount();
  await selectTask();
  await write('First instruction');
  let resolve!: () => void;
  respond = () =>
    new Promise<void>((done) => {
      resolve = done;
    });
  await act(async () => {
    document
      .querySelector('form.composer')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await write('Newer draft');
  selectedRoom = 1;
  context.data.tasks.push(activeTask('task_b', 'running', 'room_b'));
  context.data.messages.push(response(context.data.tasks[1]));
  await render();
  await selectTask('task_b');
  await write('Other room instruction');
  await act(async () => resolve());
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_b');
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('textarea')!.value,
    'Other room instruction',
  );
  selectedRoom = 0;
  await render();
  assert.equal(document.querySelector<HTMLTextAreaElement>('textarea')!.value, 'Newer draft');
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a');
});

test('an accepted pending receipt clears a response-loss error and composer target without hiding its history', async () => {
  await mount();
  await selectTask();
  await write('Use the updated reference');
  respond = async () => {
    throw new Error('Response lost');
  };
  await submit();
  assert.match(
    document.querySelector('.task-input-error')!.textContent!,
    /Receipt could not be confirmed/,
  );
  const receipt = receiptFor();
  publishReceipt(receipt);
  await render();
  assert.equal(inputTarget(), null);
  assert.equal(document.querySelector<HTMLTextAreaElement>('textarea')!.value, '');
  assert.equal(document.querySelector('.task-input-error'), null);
  assert.deepEqual(JSON.parse(localStorage.getItem('loom.task-input-attempts')!), {});
  const history = document.querySelector(`[data-task-input-id="${receipt.input.id}"]`)!;
  assert.equal(history.getAttribute('data-task-input-status'), 'pending');
  assert.doesNotMatch(history.textContent!, /Delivered to the bot/);
  assert.ok(document.querySelector(`[data-message-id="${receipt.message.id}"]`));
});

test('an SSE receipt arriving before a lost HTTP response settles once and keeps subsequently typed text', async () => {
  await mount();
  await selectTask();
  const body = 'The accepted instruction';
  await write(body);
  let reject!: (error: Error) => void;
  respond = () =>
    new Promise<void>((_, fail) => {
      reject = fail;
    });
  await submit();
  publishReceipt(receiptFor());
  await render();
  assert.equal(inputTarget(), null);
  // Even identical text entered after acceptance belongs to a new draft.
  await write(body);
  await act(async () => reject(new Error('POST response lost after SSE')));
  assert.equal(inputTarget(), null);
  assert.equal(document.querySelector<HTMLTextAreaElement>('textarea')!.value, body);
  assert.equal(document.querySelector('.task-input-error'), null);
  assert.deepEqual(JSON.parse(localStorage.getItem('loom.task-input-attempts')!), {});
});

test('an accepted receipt preserves a newer draft and never restores its failure when HTTP rejects later', async () => {
  await mount();
  await selectTask();
  await write('The sent draft');
  let reject!: (error: Error) => void;
  respond = () =>
    new Promise<void>((_, fail) => {
      reject = fail;
    });
  await submit();
  await write('A newer unsent draft');
  publishReceipt(receiptFor());
  await render();
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a');
  await act(async () => reject(new Error('POST response lost')));
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('textarea')!.value,
    'A newer unsent draft',
  );
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a');
  assert.equal(document.querySelector('.task-input-error'), null);
});

test('an HTTP response from an unmounted composer cannot overwrite a newer saved attempt', async () => {
  await mount();
  await selectTask();
  await write('The first instruction');
  let resolve!: () => void;
  respond = () =>
    new Promise<void>((done) => {
      resolve = done;
    });
  await submit();
  await act(async () => root!.unmount());
  root = undefined;
  await mount(false);
  await write('The newer instruction');
  respond = async () => {
    throw new Error('New response lost');
  };
  await submit();
  const newerRequestId = requests[0].body.requestId;
  await act(async () => resolve());
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('textarea')!.value,
    'The newer instruction',
  );
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a');
  assert.equal(
    JSON.parse(localStorage.getItem('loom.task-input-attempts')!).room_a.requestId,
    newerRequestId,
  );
});

test('only an exact accepted receipt settles an uncertain request', async () => {
  await mount();
  await selectTask();
  await write('Keep this until its receipt is confirmed');
  respond = async () => {
    throw new Error('Response lost');
  };
  await submit();
  const receipt = receiptFor();
  const mismatches: Partial<TaskInput>[] = [
    { requestId: '00000000-0000-4000-8000-000000000000' },
    { taskId: 'task_other' },
    { roomId: 'room_b' },
    { botId: 'bot_other' },
    { body: 'Different instruction' },
    { mode: 'immediate' },
    { inputImageIds: ['img_' + 'a'.repeat(64)] },
    { status: 'cancelled', cancelledAt: stamp },
  ];
  for (const mismatch of mismatches) {
    context.data.taskInputs = [{ ...receipt.input, ...mismatch }];
    await render();
    assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a', JSON.stringify(mismatch));
    assert.equal(
      document.querySelector<HTMLTextAreaElement>('textarea')!.value,
      receipt.input.body,
    );
    assert.ok(document.querySelector('.task-input-error'));
  }
  publishReceipt({
    ...receipt,
    input: { ...receipt.input, status: 'delivered', deliveredAt: stamp },
  });
  await render();
  assert.equal(inputTarget(), null);
  assert.equal(document.querySelector<HTMLTextAreaElement>('textarea')!.value, '');
});

test('a late receipt does not consume a draft after its target is reselected', async () => {
  await mount();
  context.data.tasks.push(activeTask('task_other'));
  context.data.messages.push(response(context.data.tasks[1]));
  await render();
  await selectTask();
  await write('Retarget this draft');
  respond = async () => {
    throw new Error('Response lost');
  };
  await submit();
  const receipt = receiptFor();
  await selectTask('task_other');
  await selectTask('task_a');
  publishReceipt(receipt);
  await render();
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a');
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('textarea')!.value,
    'Retarget this draft',
  );
  assert.equal(document.querySelector('.task-input-error'), null);
  assert.deepEqual(JSON.parse(localStorage.getItem('loom.task-input-attempts')!), {});
});

test('image receipts require their linked attachment identity and preserve newly attached images', async () => {
  await mount();
  await selectTask();
  await choose([file('same-name.png')]);
  await ready();
  respond = async () => {
    throw new Error('Response lost');
  };
  await submit();
  const receipt = receiptFor();
  await choose([file('same-name.png')]);
  await ready(2);
  const attachment = receipt.message.attachments![0];
  for (const mismatch of [
    { id: 'img_' + 'f'.repeat(64) },
    { filename: 'different.png' },
    { byteLength: attachment.byteLength + 1 },
    { mimeType: 'image/jpeg' as const },
  ]) {
    publishReceipt({
      ...receipt,
      message: { ...receipt.message, attachments: [{ ...attachment, ...mismatch }] },
    });
    await render();
    assert.equal(document.querySelectorAll('.composer-image-thumb img').length, 2);
    assert.ok(document.querySelector('.task-input-error'));
  }
  publishReceipt(receipt);
  await render();
  assert.equal(document.querySelectorAll('.composer-image-thumb img').length, 1);
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a');
  assert.equal(document.querySelector('.task-input-error'), null);
});

test('an old image receipt cannot consume a reattached image after remount', async () => {
  await mount();
  await selectTask();
  await choose([file()]);
  await ready();
  respond = async () => {
    throw new Error('Response lost');
  };
  await submit();
  const receipt = receiptFor();
  await act(async () => root!.unmount());
  root = undefined;
  await mount(false);
  await choose([file()]);
  await ready();
  publishReceipt(receipt);
  await render();
  assert.equal(document.querySelectorAll('.composer-image-thumb img').length, 1);
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a');
  assert.deepEqual(JSON.parse(localStorage.getItem('loom.task-input-attempts')!), {});
});

test('a saved uncertain draft reconciles an accepted receipt during hydration even after the task finishes', async () => {
  await mount();
  await selectTask();
  await write('An instruction accepted before reload');
  respond = async () => {
    throw new Error('Response lost');
  };
  await submit();
  const receipt = receiptFor();
  await act(async () => root!.unmount());
  root = undefined;
  await mount(false, (data) => {
    data.tasks[0].status = 'completed';
    publishReceipt(receipt, data);
  });
  assert.equal(inputTarget(), null);
  assert.equal(document.querySelector<HTMLTextAreaElement>('textarea')!.value, '');
  assert.equal(requests.length, 0, 'hydration must not send the accepted instruction again');
  assert.ok(
    document.querySelector(
      `[data-task-input-id="${receipt.input.id}"][data-task-input-status="pending"]`,
    ),
  );
});

test('an empty terminal target is removed on mount while an active restored selection remains', async () => {
  localStorage.clear();
  localStorage.setItem(
    'loom.task-input-targets',
    JSON.stringify({
      room_a: { taskId: 'task_a', mode: 'boundary' },
      room_b: { taskId: 'task_b', mode: 'boundary' },
    }),
  );
  await mount(false, (data) => {
    data.tasks[0].status = 'completed';
    data.tasks.push(activeTask('task_b', 'running', 'room_b'));
  });
  assert.equal(inputTarget(), null);
  assert.equal(JSON.parse(localStorage.getItem('loom.task-input-targets')!).room_a, undefined);
  selectedRoom = 1;
  await render();
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_b');
  context.data.tasks[1].status = 'completed';
  await render();
  assert.equal(inputTarget(), null);
});

test('task completion preserves text, images and unresolved sends until their drafts are resolved', async () => {
  await mount();
  await selectTask();
  await write('Unsent correction');
  context.data.tasks[0].status = 'completed';
  await render();
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a');
  await write('');
  assert.equal(inputTarget(), null);
  context.data.tasks[0].status = 'running';
  await render();
  await selectTask();
  await choose([file()]);
  await ready();
  context.data.tasks[0].status = 'failed';
  await render();
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a');
  await click('Remove example.png');
  assert.equal(inputTarget(), null);
  context.data.tasks[0].status = 'running';
  await render();
  await selectTask();
  await write('Uncertain correction');
  respond = async () => {
    throw new Error('Response lost');
  };
  await submit();
  await write('');
  context.data.tasks[0].status = 'completed';
  await render();
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a');
  await act(async () => root!.unmount());
  root = undefined;
  await mount(false, (data) => {
    data.tasks[0].status = 'completed';
  });
  assert.equal(inputTarget()?.dataset.taskInputTarget, 'task_a');
  assert.ok(JSON.parse(localStorage.getItem('loom.task-input-attempts')!).room_a);
});

test('pending instructions show resume and tool waits while delivered instructions never claim the model obeyed them', async () => {
  await mount();
  const input: TaskInput = {
    id: 'input_a',
    requestId: '00000000-0000-4000-8000-000000000000',
    taskId: 'task_a',
    roomId: 'room_a',
    botId: 'bot_a',
    messageId: 'user_instruction',
    sequence: 1,
    body: 'Please use the updated reference',
    mode: 'boundary',
    status: 'pending',
    createdAt: stamp,
  };
  context.data.taskInputs = [input];
  context.data.messages.push({
    id: input.messageId,
    roomId: input.roomId,
    authorType: 'user',
    authorId: 'user',
    taskId: input.taskId,
    taskInputId: input.id,
    body: input.body,
    status: 'complete',
    createdAt: stamp,
  });
  context.data.tasks[0].status = 'waiting_tool';
  await render();
  assert.match(
    document.querySelector('[data-task-input-id="input_a"]')!.textContent!,
    /waiting for the current action/,
  );
  context.data.tasks[0].status = 'stopped';
  await render();
  assert.match(
    document.querySelector('[data-task-input-id="input_a"]')!.textContent!,
    /will deliver after resume/,
  );
  context.data.taskInputs[0] = { ...input, status: 'delivered', deliveredAt: stamp };
  await render();
  assert.match(
    document.querySelector('[data-task-input-id="input_a"]')!.textContent!,
    /Delivered to the bot/,
  );
  context.data.taskInputs[0] = { ...input, status: 'cancelled', cancelledAt: stamp };
  await render();
  assert.match(
    document.querySelector('[data-task-input-id="input_a"]')!.textContent!,
    /Cancelled · not delivered/,
  );
});

test('only the current eligible run offers instructions; demo and learning work keep their existing controls', async () => {
  await mount();
  context.data.messages.push(response(context.data.tasks[0], '_latest'));
  await render();
  assert.equal(
    document.querySelectorAll('.message-list [data-task-input-action="task_a"]').length,
    1,
  );
  assert.equal(
    document.querySelector('[data-run-message-id="message_task_a"] [data-task-input-action]'),
    null,
  );
  context.data.tasks[0].kind = 'learning';
  await render();
  assert.equal(document.querySelector('[data-task-input-action]'), null);
  context.data.tasks[0].kind = 'chat';
  context.data.settings.demoMode = true;
  await render();
  assert.equal(document.querySelector('[data-task-input-action]'), null);
});

test('approval waits explain reconsideration and a superseded approval is distinct from denial', async () => {
  await mount();
  context.data.tasks[0].status = 'awaiting_approval';
  context.data.approvals.push({
    id: 'approval_old',
    taskId: 'task_a',
    roomId: 'room_a',
    botId: 'bot_a',
    toolName: 'write_file',
    summary: 'Write the old plan',
    target: 'plan.md',
    args: { path: 'plan.md' },
    status: 'pending',
    createdAt: stamp,
  });
  await render();
  await selectTask();
  assert.match(inputTarget()?.textContent || '', /awaiting approval is withdrawn/);
  context.data.approvals[0].status = 'cancelled';
  context.data.approvals[0].cancellationReason = 'superseded';
  await render();
  assert.match(document.body.textContent || '', /Withdrawn for the new instruction/);
});

test('compaction keeps immediate delivery disabled even while the task reports running', async () => {
  await mount();
  await selectTask();
  context.data.queue.scheduling = [
    {
      taskId: 'task_a',
      groupId: 'task_a',
      purpose: 'compaction',
      occupiedMs: 10,
    },
  ];
  await render();
  assert.equal(context.data.tasks[0].status, 'running');
  assert.equal(
    document.querySelector<HTMLInputElement>('.task-input-immediate input')!.disabled,
    true,
  );
  assert.match(inputTarget()?.textContent || '', /after summarization finishes/);
  await write('Keep this correction after summarization');
  await submit();
  assert.equal(requests[0].body.mode, 'boundary');
  context.data.queue.scheduling[0].purpose = 'response';
  await render();
  await selectTask();
  assert.equal(
    document.querySelector<HTMLInputElement>('.task-input-immediate input')!.disabled,
    false,
  );
});

test('delivery notes make omitted image pixels visible instead of implying the image reached the model', async () => {
  await mount();
  const input: TaskInput = {
    id: 'input_with_omission',
    requestId: '00000000-0000-4000-8000-000000000001',
    taskId: 'task_a',
    roomId: 'room_a',
    botId: 'bot_a',
    messageId: 'user_image_instruction',
    sequence: 1,
    body: 'Use the diagram',
    inputImageIds: ['img_' + 'a'.repeat(64)],
    mode: 'boundary',
    status: 'delivered',
    createdAt: stamp,
    deliveredAt: stamp,
    reason: 'Image pixels were not included because conversation image input is disabled.',
  };
  context.data.taskInputs = [input];
  context.data.messages.push({
    id: input.messageId,
    roomId: input.roomId,
    authorType: 'user',
    authorId: 'user',
    taskId: input.taskId,
    taskInputId: input.id,
    body: input.body,
    status: 'complete',
    createdAt: stamp,
  });
  await render();
  const note = () => document.querySelector('[data-task-input-id="input_with_omission"]')!;
  assert.match(note().textContent!, /Delivered to the bot/);
  assert.match(
    note().querySelector('.task-input-delivery-note')!.textContent!,
    /Image pixels were not included/,
  );
  context.locale = 'ja';
  context.t = (ja) => ja;
  await render();
  assert.match(note().textContent!, /画像そのものは渡していません/);
  context.data.taskInputs[0] = {
    ...input,
    reason:
      'The instruction text was delivered, but its image pixels could not be included within the current image policy and task budget.',
  };
  await render();
  assert.match(note().textContent!, /文章は渡しましたが.*画像そのものは渡せませんでした/);
});
