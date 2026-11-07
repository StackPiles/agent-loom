import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import { DEFAULT_IMAGE_SETTINGS } from '../src/shared/model-settings';
import type {
  Bot,
  FolderPickerStatus,
  GeneratedImage,
  Message,
  Room,
  Snapshot,
  Task,
} from '../src/shared/types';

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
Object.defineProperty(dom.window, 'innerWidth', { value: 1440, writable: true });
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('../src/client/context');
const { RoomDialog } = await import('../src/client/RoomDialog');
const { SettingsPage } = await import('../src/client/SettingsPage');
const { Chat } = await import('../src/client/Chat');
const { default: App } = await import('../src/client/App');
const { applyEvent } = await import('../src/client/api');
class FakeEventSource {
  onopen?: () => void;
  constructor() {
    queueMicrotask(() => this.onopen?.());
  }
  close() {}
}
Object.assign(globalThis, { EventSource: FakeEventSource });

const now = '2026-10-30T10:00:00.000Z';
const makeBot = (id: string, name: string, avatar: string): Bot => ({
  id,
  name,
  handle: name.toLowerCase(),
  role: 'Research',
  avatar,
  color: '#829479',
  systemPrompt: 'Synthetic test bot.',
  enabled: true,
  createdAt: now,
});
const room: Room = {
  id: 'room_a',
  name: 'Research',
  description: '',
  botIds: ['bot_aster', 'bot_nova'],
  pinned: false,
  archived: false,
  createdAt: now,
  updatedAt: now,
};
function fixture(): Snapshot {
  return {
    version: 'test',
    settings: {
      images: { ...DEFAULT_IMAGE_SETTINGS },
      inference: { maxConcurrentRequests: 1 },
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
    bots: [makeBot('bot_aster', 'Aster', 'sparkles'), makeBot('bot_nova', 'Nova', 'compass')],
    rooms: [
      { ...room, botIds: [...room.botIds] },
      { ...room, id: 'room_b', name: 'Other', workspacePath: 'D:\\Other' },
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
const task = (roomId: string): Task => ({
  id: 'task_1',
  roomId,
  botId: 'bot_aster',
  prompt: 'Test',
  status: 'running',
  rootTaskId: 'task_1',
  depth: 0,
  kind: 'chat',
  output: '',
  createdAt: now,
  updatedAt: now,
  inputTokens: 0,
  outputTokens: 0,
});
let state: Snapshot;
let context: AppContextValue;
let root: ReturnType<typeof createRoot> | undefined;
let status: FolderPickerStatus = { available: true, platform: 'win32' };
let chosen: (string | null)[] = [];
let postPicker: ((init: RequestInit) => Promise<Response>) | undefined;
const requests: { path: string; method: string; body?: any; signal?: AbortSignal | null }[] = [];
const mutations: { path: string; method?: string; body?: any }[] = [];
Object.assign(globalThis, {
  fetch: async (path: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    requests.push({
      path,
      method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      signal: init.signal,
    });
    if (path === '/api/state') return Response.json(state);
    if (path === '/api/auth') return new Response(JSON.stringify({ required: false }));
    assert.equal(path, '/api/workspace-picker');
    if (method === 'GET') return new Response(JSON.stringify(status));
    if (postPicker) return postPicker(init);
    return new Response(JSON.stringify({ path: chosen.shift() ?? null }));
  },
});
async function mount(
  render: (data: Snapshot) => React.ReactNode,
  data = fixture(),
  capability: FolderPickerStatus = { available: true, platform: 'win32' },
) {
  if (root) await act(async () => root!.unmount());
  localStorage.clear();
  localStorage.setItem('loom.locale', 'en');
  localStorage.setItem('loom.activity', 'true');
  state = data;
  status = capability;
  chosen = [];
  postPicker = undefined;
  requests.length = 0;
  mutations.length = 0;
  context = {
    data,
    connected: true,
    locale: 'en',
    t: (_ja, en) => en,
    view: 'chat',
    roomId: room.id,
    navigate() {},
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string, method?: string, body?: unknown) {
      mutations.push({ path, method, body });
      return { ...room, ...(body as object), id: room.id } as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root!.render(<AppContext.Provider value={context}>{render(data)}</AppContext.Provider>);
  });
}
function button(text: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text,
  );
  assert.ok(found, `Missing button ${text}`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function save() {
  await act(async () => {
    document
      .querySelector('form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  return mutations.at(-1)!;
}

const image: GeneratedImage = {
  id: `img_${'a'.repeat(64)}`,
  type: 'image',
  mimeType: 'image/png',
  filename: 'generated.png',
  byteLength: 2048,
  prompt: 'A quiet garden, <script>plain text</script>',
  model: 'local-image-model',
  createdAt: now,
};
function job(id: string, botId = 'bot_aster', status: Task['status'] = 'running'): Task {
  return { ...task('room_a'), id, rootTaskId: id, botId, status };
}
function message(task: Task): Message {
  return {
    id: `message_${task.id}`,
    taskId: task.id,
    roomId: task.roomId,
    authorId: task.botId,
    authorType: 'bot',
    body: '',
    status: 'streaming',
    createdAt: now,
  };
}
async function rerenderChat(data: Snapshot) {
  state = data;
  context = { ...context, data };
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        <Chat room={data.rooms[0]} />
      </AppContext.Provider>,
    ),
  );
}
async function rerenderSettings(data: Snapshot, overrides: Partial<AppContextValue> = {}) {
  state = data;
  context = { ...context, data, ...overrides };
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        <SettingsPage />
      </AppContext.Provider>,
    ),
  );
}
function select(label: string) {
  const result = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  assert.ok(result, `Missing select ${label}`);
  return result;
}
function field(label: string) {
  const result = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  assert.ok(result, `Missing field ${label}`);
  return result;
}
function toggle(label: string) {
  const row = [...document.querySelectorAll('label.toggle-row')].find(
    (item) => item.querySelector('strong')?.textContent === label,
  );
  const result = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(result, `Missing toggle ${label}`);
  return result;
}
async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
}

test('the sidebar describes the current model without a fake workspace switch', async () => {
  await mount(() => <App />);
  const summary = document.querySelector('.instance-summary')!;
  assert.ok(summary);
  assert.equal(summary.tagName, 'DIV');
  assert.equal(summary.querySelector('button, [role="button"], .lucide-chevron-down'), null);
  assert.match(summary.textContent || '', /Language model.*fixture/);
  assert.equal(document.querySelector('.workspace-switch'), null);
  await click(summary as HTMLElement);
  assert.equal(document.querySelector('#model-settings'), null);
  const settings = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.querySelector('span')?.textContent === 'Settings',
  );
  assert.ok(settings);
  await click(settings);
  assert.ok(document.querySelector('#model-settings'));
});

test('image configuration uses separate credentials and all explicit reasoning values save without remapping', async () => {
  const data = fixture();
  data.settings.images!.shareInferenceSlot = true;
  await mount(() => <SettingsPage />, data);
  assert.equal(toggle('Enable image generation').checked, false);
  assert.equal(document.querySelector('[aria-label="Image API base URL"]'), null);
  await click(toggle('Enable image generation'));
  await input(field('Image API base URL'), 'http://localhost:8001/v1/');
  await input(field('Image model ID'), 'local-flux');
  await input(field('Image API key'), 'synthetic-image-key');
  await input(field('Default image size'), '1536x1024');
  await input(field('Sampling steps'), '40');
  await choose(select('Sampling-step format'), 'num_inference_steps');
  await input(field('Generation timeout (seconds)'), '300');
  await click(toggle('Share generation slots with the language model'));
  await choose(select('Maximum concurrent generations'), '4');
  await choose(select('Reasoning mode'), 'openai');
  assert.deepEqual(
    [...select('Reasoning effort').options].map((option) => option.value),
    ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
  assert.match(
    document.querySelector('#model-settings')?.textContent || '',
    /Ultra is a server extension/,
  );
  await choose(select('Reasoning effort'), 'ultra');
  const saved = await save();
  assert.equal(saved.path, '/settings');
  assert.equal(saved.body.model.reasoningEffort, 'ultra');
  assert.equal(saved.body.model.reasoningMode, 'openai');
  assert.equal(
    saved.body.model.apiKey,
    undefined,
    'The image secret must never become the language model secret',
  );
  assert.deepEqual(saved.body.inference, { maxConcurrentRequests: 4 });
  assert.deepEqual(saved.body.images, {
    enabled: true,
    permission: 'inherit',
    baseUrl: 'http://localhost:8001/v1',
    modelId: 'local-flux',
    size: '1536x1024',
    steps: 40,
    stepsParameter: 'num_inference_steps',
    responseFormat: 'auto',
    timeoutSeconds: 300,
    shareInferenceSlot: false,
    apiKey: 'synthetic-image-key',
  });
  assert.equal(field('Image API key').value, '', 'A submitted key is cleared from the form');
});

test('editing image options preserves saved credentials unless clearing is explicit', async () => {
  const data = fixture();
  data.settings.images = {
    ...DEFAULT_IMAGE_SETTINGS,
    enabled: true,
    baseUrl: 'http://localhost:8001/v1',
    modelId: 'images',
    apiKeyConfigured: true,
  };
  await mount(() => <SettingsPage />, data);
  assert.equal(field('Image API key').value, '');
  assert.match(field('Image API key').placeholder, /•/);
  await input(field('Default image size'), '512x512');
  assert.equal((await save()).body.images.apiKey, undefined);
  await click(button('Clear image API key'));
  assert.equal((await save()).body.images.apiKey, '');
});

test('sampling steps retain server defaults, validate integers and explicitly clear a saved count', async () => {
  const data = fixture();
  data.settings.images = {
    ...DEFAULT_IMAGE_SETTINGS,
    enabled: true,
    baseUrl: 'http://localhost:8001/v1',
    modelId: 'images',
  };
  delete data.settings.images.steps;
  delete data.settings.images.stepsParameter;
  await mount(() => <SettingsPage />, data);
  assert.equal(field('Sampling steps').value, '');
  assert.equal(field('Sampling steps').placeholder, 'Server default');
  assert.equal(field('Sampling steps').min, '1');
  assert.equal(field('Sampling steps').max, '1000');
  assert.equal(field('Sampling steps').step, '1');
  assert.equal(select('Sampling-step format').value, 'sd_cpp_extra_args');
  assert.deepEqual(
    [...select('Sampling-step format').options].map((option) => option.value),
    ['sd_cpp_extra_args', 'steps', 'num_inference_steps', 'sample_steps'],
  );
  assert.equal(
    select('Sampling-step format').closest('details'),
    null,
    'The format choice is visible next to the sampling count.',
  );
  for (const invalid of ['0', '1001', '40.5']) {
    await input(field('Sampling steps'), invalid);
    assert.equal(button('Save changes').disabled, true, invalid);
    assert.equal(button('Generate 1 test image').disabled, true, invalid);
    await save();
    assert.equal(mutations.length, 0, 'Invalid steps cannot be submitted programmatically.');
  }
  await input(field('Sampling steps'), '40');
  await choose(select('Sampling-step format'), 'sample_steps');
  assert.equal(button('Save changes').disabled, false);
  let saved = await save();
  assert.equal(saved.body.images.steps, 40);
  assert.equal(saved.body.images.stepsParameter, 'sample_steps');
  assert.equal(data.settings.images.steps, undefined, 'Editing must not mutate the snapshot.');

  await input(field('Sampling steps'), '');
  assert.equal(button('Generate 1 test image').disabled, false);
  saved = await save();
  assert.equal(
    saved.body.images.steps,
    null,
    'Clearing sends an explicit reset to server default.',
  );
  assert.equal(saved.body.images.stepsParameter, 'sample_steps');
  assert.equal(saved.body.images.apiKey, undefined);
});

test('the 2K parallel preset changes only draft generation choices until the settings are saved', async () => {
  const data = fixture();
  data.settings.images = {
    ...DEFAULT_IMAGE_SETTINGS,
    enabled: true,
    permission: 'ask',
    baseUrl: 'https://configured-image.example/v1',
    modelId: 'configured-image-model',
    apiKeyConfigured: true,
    size: '1536x1024',
    steps: 24,
    stepsParameter: 'steps',
    responseFormat: 'b64_json',
    timeoutSeconds: 5400,
    shareInferenceSlot: true,
  };
  const before = structuredClone(data.settings.images);
  await mount(() => <SettingsPage />, data);
  assert.equal(field('Default image size').value, '1536x1024');
  assert.equal(field('Generation timeout (seconds)').value, '5400');
  assert.equal(field('Generation timeout (seconds)').min, '10');
  assert.equal(field('Generation timeout (seconds)').max, '86400');
  assert.equal(toggle('Share generation slots with the language model').checked, true);
  assert.match(document.querySelector('#image-settings')!.textContent!, /With a limit of 1/);
  await input(field('Image API key'), 'synthetic-preserved-preset-key');

  await click(button('Apply 2K, 60 min and parallel LLM'));
  assert.equal(field('Default image size').value, '2048x2048');
  assert.equal(field('Generation timeout (seconds)').value, '3600');
  assert.equal(toggle('Share generation slots with the language model').checked, false);
  assert.equal(field('Image API base URL').value, before.baseUrl);
  assert.equal(field('Image model ID').value, before.modelId);
  assert.equal(field('Sampling steps').value, '24');
  assert.equal(select('Sampling-step format').value, 'steps');
  assert.equal(field('Image API key').value, 'synthetic-preserved-preset-key');
  assert.equal(select('Bot image generation').value, 'ask');
  assert.equal(select('Image response format').value, 'b64_json');
  assert.match(document.querySelector('#image-settings')!.textContent!, /same machine/);
  assert.match(document.querySelector('#image-settings')!.textContent!, /one at a time/);
  assert.match(
    document.querySelector('#image-settings')!.textContent!,
    /Leave blank.*server default/,
  );
  assert.equal(mutations.length, 0, 'Applying the preset does not submit the settings form.');
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0);
  assert.deepEqual(data.settings.images, before, 'Saved settings remain unchanged until Save.');

  const saved = await save();
  assert.deepEqual(saved.body.images, {
    enabled: true,
    permission: 'ask',
    baseUrl: before.baseUrl,
    modelId: before.modelId,
    size: '2048x2048',
    steps: 24,
    stepsParameter: 'steps',
    responseFormat: 'b64_json',
    timeoutSeconds: 3600,
    shareInferenceSlot: false,
    apiKey: 'synthetic-preserved-preset-key',
  });
  assert.equal(saved.body.permissions.network, 'allow');
});

test('live capacity remains editable while model changes are locked, and room policy requires idle work', async () => {
  const data = fixture();
  data.tasks = [job('active')];
  data.settings.images = {
    ...DEFAULT_IMAGE_SETTINGS,
    enabled: true,
    baseUrl: 'http://localhost:8001/v1',
    modelId: 'images',
    shareInferenceSlot: true,
  };
  await mount(() => <SettingsPage />, data);
  assert.equal(toggle('Enable image generation').disabled, true);
  assert.equal(document.querySelector<HTMLFieldSetElement>('.image-model-fields')!.disabled, true);
  assert.equal(field('Sampling steps').matches(':disabled'), true);
  assert.equal(select('Sampling-step format').matches(':disabled'), true);
  const preset = button('Apply 2K, 60 min and parallel LLM');
  assert.equal(preset.disabled, true);
  await click(preset);
  assert.equal(toggle('Share generation slots with the language model').checked, true);
  assert.equal(select('Maximum concurrent generations').disabled, false);
  await choose(select('Maximum concurrent generations'), '2');
  const saved = await save();
  assert.deepEqual(saved.body.inference, { maxConcurrentRequests: 2 });
  assert.equal(
    saved.body.images,
    undefined,
    'An unrelated live capacity change does not resubmit image settings',
  );
  await mount((d) => <RoomDialog room={d.rooms[0]} onClose={() => {}} />, data);
  assert.equal(toggle('Allow simultaneous responses in this room').disabled, true);
});

test('fully paused work can edit the complete image configuration and apply the preset before explicitly saving', async () => {
  const data = fixture();
  data.rooms[0].paused = true;
  data.tasks = [job('parked', 'bot_aster', 'waiting_tool'), job('queued', 'bot_nova', 'queued')];
  data.queue = {
    active: 0,
    waiting: 2,
    waitingTasks: [{ taskId: 'parked', reason: 'paused' }],
  };
  data.settings.images = {
    ...DEFAULT_IMAGE_SETTINGS,
    enabled: true,
    baseUrl: 'http://localhost:8001/v1',
    modelId: 'images',
    apiKeyConfigured: true,
    size: '1536x1024',
    timeoutSeconds: 120,
    shareInferenceSlot: true,
  };
  const before = structuredClone(data.settings);
  await mount(() => <SettingsPage />, data);
  assert.equal(toggle('Enable image input').disabled, false);
  assert.equal(toggle('Share generation slots with the language model').disabled, false);
  assert.equal(toggle('Enable image generation').disabled, false);
  for (const label of [
    'Image API base URL',
    'Image model ID',
    'Image API key',
    'Default image size',
    'Sampling steps',
    'Generation timeout (seconds)',
  ])
    assert.equal(field(label).matches(':disabled'), false, `${label} must be editable`);
  assert.equal(select('Image response format').matches(':disabled'), false);
  assert.equal(select('Sampling-step format').matches(':disabled'), false);
  assert.equal(button('Clear image API key').matches(':disabled'), false);
  assert.equal(button('Apply 2K, 60 min and parallel LLM').disabled, false);
  assert.equal(select('Bot image generation').disabled, false);

  await click(toggle('Enable image generation'));
  assert.equal(document.querySelector('[aria-label="Image API base URL"]'), null);
  await click(toggle('Enable image generation'));
  await input(field('Image API base URL'), 'http://localhost:8002/v1/');
  await input(field('Image model ID'), 'replacement-image-model');
  await input(field('Image API key'), 'synthetic-paused-image-key');
  await input(field('Default image size'), '1024x1024');
  await input(field('Sampling steps'), '40');
  await choose(select('Sampling-step format'), 'sample_steps');
  await input(field('Generation timeout (seconds)'), '7200');
  await choose(select('Image response format'), 'b64_json');
  await click(toggle('Enable image input'));
  await click(button('Apply 2K, 60 min and parallel LLM'));
  assert.equal(field('Default image size').value, '2048x2048');
  assert.equal(field('Generation timeout (seconds)').value, '3600');
  assert.equal(toggle('Share generation slots with the language model').checked, false);
  assert.equal(field('Image API key').value, 'synthetic-paused-image-key');
  assert.match(
    document.querySelector('#image-settings')!.textContent!,
    /apply to new image requests/,
  );
  assert.equal(mutations.length, 0);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0);
  assert.deepEqual(data.settings, before);
  const saved = await save();
  assert.equal(saved.body.model.imageInput, true);
  assert.equal(saved.body.model.baseUrl, before.model.baseUrl);
  assert.equal(saved.body.model.apiKey, undefined);
  assert.deepEqual(saved.body.images, {
    enabled: true,
    permission: 'inherit',
    baseUrl: 'http://localhost:8002/v1',
    modelId: 'replacement-image-model',
    size: '2048x2048',
    steps: 40,
    stepsParameter: 'sample_steps',
    responseFormat: 'b64_json',
    timeoutSeconds: 3600,
    shareInferenceSlot: false,
    apiKey: 'synthetic-paused-image-key',
  });
  assert.equal(field('Image API key').value, '');
  assert.equal(data.rooms[0].paused, true);
});

test('draining work, another active room and a lost connection lock image settings without discarding the draft', async () => {
  const data = fixture();
  data.rooms[0].paused = true;
  data.tasks = [job('parked')];
  data.queue = {
    active: 0,
    waiting: 1,
    waitingTasks: [{ taskId: 'parked', reason: 'paused' }],
  };
  data.settings.images = {
    ...DEFAULT_IMAGE_SETTINGS,
    enabled: true,
    baseUrl: 'http://localhost:8001/v1',
    modelId: 'images',
    shareInferenceSlot: true,
  };
  await mount(() => <SettingsPage />, data);
  await input(field('Image model ID'), 'pending-image-model');
  await input(field('Default image size'), '1536x1024');

  const draining = structuredClone(data);
  draining.queue.waitingTasks = [];
  const mixed = structuredClone(data);
  mixed.tasks.push({ ...job('other-room'), roomId: 'room_b' });
  const resumed = structuredClone(data);
  resumed.rooms[0].paused = false;
  for (const next of [draining, mixed, resumed]) {
    await rerenderSettings(next);
    assert.equal(toggle('Enable image input').disabled, true);
    assert.equal(toggle('Share generation slots with the language model').disabled, true);
    assert.equal(toggle('Enable image generation').disabled, true);
    assert.equal(field('Image model ID').matches(':disabled'), true);
    assert.equal(field('Default image size').matches(':disabled'), true);
    assert.equal(button('Apply 2K, 60 min and parallel LLM').disabled, true);
    assert.equal(button('Save changes').disabled, true);
    assert.match(document.body.textContent ?? '', /Pause work in every room/);
    await save();
    assert.equal(mutations.length, 0, 'A draft cannot be submitted after work resumes.');
    assert.equal(field('Image model ID').value, 'pending-image-model');
    assert.equal(field('Default image size').value, '1536x1024');
  }

  await rerenderSettings(data, { connected: false });
  assert.equal(toggle('Enable image input').disabled, true);
  assert.equal(toggle('Share generation slots with the language model').disabled, true);
  assert.equal(field('Image model ID').matches(':disabled'), true);
  assert.equal(button('Apply 2K, 60 min and parallel LLM').disabled, true);
  assert.equal(button('Save changes').disabled, true);
  assert.match(document.body.textContent ?? '', /Reconnect before changing these options/);
  await save();
  assert.equal(mutations.length, 0);

  await rerenderSettings(data, { connected: true });
  assert.equal(toggle('Enable image input').disabled, false);
  assert.equal(toggle('Share generation slots with the language model').disabled, false);
  assert.equal(field('Image model ID').matches(':disabled'), false);
  assert.equal(button('Save changes').disabled, false);
  const saved = await save();
  assert.equal(saved.body.images.modelId, 'pending-image-model');
  assert.equal(saved.body.images.size, '1536x1024');
});

test('saving paused image settings prevents duplicate submits and retains configuration and credentials after rejection', async () => {
  const data = fixture();
  data.rooms[0].paused = true;
  data.tasks = [job('parked', 'bot_aster', 'waiting_tool')];
  data.queue = {
    active: 0,
    waiting: 1,
    waitingTasks: [{ taskId: 'parked', reason: 'paused' }],
  };
  data.settings.images = {
    ...DEFAULT_IMAGE_SETTINGS,
    enabled: true,
    baseUrl: 'http://localhost:8001/v1',
    modelId: 'images',
    shareInferenceSlot: true,
  };
  await mount(() => <SettingsPage />, data);
  await click(toggle('Enable image input'));
  await click(toggle('Share generation slots with the language model'));
  await input(field('Image API base URL'), 'http://localhost:8002/v1');
  await input(field('Image API key'), 'synthetic-rejected-image-key');
  await input(field('Generation timeout (seconds)'), '7200');
  const originalMutate = context.mutate;
  let rejectSave: (reason: Error) => void;
  const pendingSave = new Promise<never>((_resolve, reject) => {
    rejectSave = reject;
  });
  await rerenderSettings(data, {
    mutate: async <T,>(path: string, method?: string, body?: unknown) => {
      mutations.push({ path, method, body });
      return pendingSave as Promise<T>;
    },
  });

  await save();
  assert.equal(toggle('Enable image input').disabled, true);
  assert.equal(toggle('Share generation slots with the language model').disabled, true);
  assert.equal(field('Image API base URL').matches(':disabled'), true);
  assert.equal(field('Image API key').matches(':disabled'), true);
  assert.equal(button('Apply 2K, 60 min and parallel LLM').disabled, true);
  assert.equal(button('Save changes').disabled, true);
  await save();
  assert.equal(mutations.length, 1);
  await act(async () => rejectSave!(new Error('Work resumed before settings could be saved')));
  assert.equal(toggle('Enable image input').disabled, false);
  assert.equal(toggle('Share generation slots with the language model').disabled, false);
  assert.equal(toggle('Enable image input').checked, true);
  assert.equal(toggle('Share generation slots with the language model').checked, false);
  assert.equal(field('Image API base URL').value, 'http://localhost:8002/v1');
  assert.equal(field('Image API key').value, 'synthetic-rejected-image-key');
  assert.equal(field('Generation timeout (seconds)').value, '7200');
  assert.equal(button('Save changes').disabled, false);
  await rerenderSettings(data, { mutate: originalMutate });
  const saved = await save();
  assert.equal(mutations.length, 2);
  assert.equal(saved.body.model.imageInput, true);
  assert.equal(saved.body.images.shareInferenceSlot, false);
  assert.equal(saved.body.images.baseUrl, 'http://localhost:8002/v1');
  assert.equal(saved.body.images.apiKey, 'synthetic-rejected-image-key');
  assert.equal(saved.body.images.timeoutSeconds, 7200);
});

test('each image configuration or credential edit blocks saving if paused work resumes', async () => {
  const changes = [
    { key: 'enabled', value: false, edit: () => click(toggle('Enable image generation')) },
    {
      key: 'baseUrl',
      value: 'http://localhost:8002/v1',
      edit: () => input(field('Image API base URL'), 'http://localhost:8002/v1/'),
    },
    {
      key: 'modelId',
      value: 'replacement-model',
      edit: () => input(field('Image model ID'), 'replacement-model'),
    },
    {
      key: 'size',
      value: '1024x1024',
      edit: () => input(field('Default image size'), '1024x1024'),
    },
    {
      key: 'timeoutSeconds',
      value: 7200,
      edit: () => input(field('Generation timeout (seconds)'), '7200'),
    },
    {
      key: 'steps',
      value: 40,
      edit: () => input(field('Sampling steps'), '40'),
    },
    {
      key: 'stepsParameter',
      value: 'steps',
      edit: () => choose(select('Sampling-step format'), 'steps'),
    },
    {
      key: 'responseFormat',
      value: 'b64_json',
      edit: () => choose(select('Image response format'), 'b64_json'),
    },
    {
      key: 'shareInferenceSlot',
      value: false,
      edit: () => click(toggle('Share generation slots with the language model')),
    },
    {
      key: 'apiKey',
      value: 'synthetic-replacement-key',
      edit: () => input(field('Image API key'), 'synthetic-replacement-key'),
    },
    { key: 'apiKey', value: '', edit: () => click(button('Clear image API key')) },
  ];
  for (const change of changes) {
    const data = fixture();
    data.rooms[0].paused = true;
    data.tasks = [job('parked')];
    data.queue = {
      active: 0,
      waiting: 1,
      waitingTasks: [{ taskId: 'parked', reason: 'paused' }],
    };
    data.settings.images = {
      ...DEFAULT_IMAGE_SETTINGS,
      enabled: true,
      baseUrl: 'http://localhost:8001/v1',
      modelId: 'images',
      apiKeyConfigured: true,
      shareInferenceSlot: true,
    };
    await mount(() => <SettingsPage />, data);
    await change.edit();
    assert.equal(button('Save changes').disabled, false, `${change.key} can be saved during pause`);
    const resumed = structuredClone(data);
    resumed.rooms[0].paused = false;
    resumed.queue.waitingTasks = [];
    await rerenderSettings(resumed);
    assert.equal(button('Save changes').disabled, true, `${change.key} must wait for a full pause`);
    await save();
    assert.equal(mutations.length, 0);

    await rerenderSettings(data);
    assert.equal(button('Save changes').disabled, false);
    const saved = await save();
    assert.equal(saved.body.images[change.key], change.value);
    if (change.key !== 'apiKey') assert.equal(saved.body.images.apiKey, undefined);
  }
});

test('reverting image configuration edits keeps permission-only saves available after work resumes', async () => {
  const data = fixture();
  data.rooms[0].paused = true;
  data.tasks = [job('parked')];
  data.queue = {
    active: 0,
    waiting: 1,
    waitingTasks: [{ taskId: 'parked', reason: 'paused' }],
  };
  data.settings.images = {
    ...DEFAULT_IMAGE_SETTINGS,
    enabled: true,
    baseUrl: 'http://localhost:8001/v1',
    modelId: 'images',
  };
  await mount(() => <SettingsPage />, data);
  await input(field('Image model ID'), 'temporary-model');
  await input(field('Image model ID'), 'images');
  await input(field('Image API key'), 'synthetic-temporary-key');
  await input(field('Image API key'), '');
  await choose(select('Bot image generation'), 'deny');

  const resumed = structuredClone(data);
  resumed.rooms[0].paused = false;
  resumed.queue.waitingTasks = [];
  await rerenderSettings(resumed);
  assert.equal(field('Image model ID').matches(':disabled'), true);
  assert.equal(select('Bot image generation').disabled, false);
  assert.equal(button('Save changes').disabled, false);
  const saved = await save();
  assert.equal(saved.body.images.permission, 'deny');
  assert.equal(saved.body.images.modelId, data.settings.images.modelId);
  assert.equal(saved.body.images.apiKey, '');
  assert.equal(saved.body.permissions.network, 'allow');
});

test('equivalent image URLs keep permission-only saves available after resume and after a canonical save', async () => {
  for (const saveBeforeResume of [false, true]) {
    const data = fixture();
    data.rooms[0].paused = true;
    data.tasks = [job('parked')];
    data.queue = {
      active: 0,
      waiting: 1,
      waitingTasks: [{ taskId: 'parked', reason: 'paused' }],
    };
    data.settings.images = {
      ...DEFAULT_IMAGE_SETTINGS,
      enabled: true,
      baseUrl: 'https://images.example.test/v1',
      modelId: 'images',
      apiKeyConfigured: true,
    };
    await mount(() => <SettingsPage />, data);
    await input(field('Image API base URL'), 'https://');
    await input(field('Image API base URL'), 'https://IMAGES.example.test:443/v1/');
    if (saveBeforeResume) {
      assert.equal((await save()).body.images.baseUrl, data.settings.images.baseUrl);
      await rerenderSettings(structuredClone(data));
      assert.equal(field('Image API base URL').value, 'https://IMAGES.example.test:443/v1/');
    }
    await choose(select('Bot image generation'), 'deny');

    const resumed = structuredClone(data);
    resumed.rooms[0].paused = false;
    resumed.queue.waitingTasks = [];
    await rerenderSettings(resumed);
    assert.equal(field('Image API base URL').matches(':disabled'), true);
    assert.equal(button('Save changes').disabled, false);
    const saved = await save();
    assert.equal(mutations.length, saveBeforeResume ? 2 : 1);
    assert.equal(saved.body.images.baseUrl, data.settings.images.baseUrl);
    assert.equal(saved.body.images.permission, 'deny');
    assert.equal(saved.body.images.apiKey, undefined);
  }
});

test('bot image permission remains editable during active work and saves independently of network policy', async () => {
  const data = fixture();
  data.tasks = [job('active')];
  data.settings.permissions.network = 'ask';
  data.settings.images = {
    ...DEFAULT_IMAGE_SETTINGS,
    enabled: true,
    baseUrl: 'http://localhost:8001/v1',
    modelId: 'images',
    apiKeyConfigured: true,
  };
  await mount(() => <SettingsPage />, data);
  const policy = select('Bot image generation');
  assert.equal(policy.disabled, false);
  assert.equal(policy.value, 'inherit');
  assert.deepEqual(
    [...policy.options].map((option) => option.value),
    ['inherit', 'allow', 'ask', 'deny'],
  );
  assert.equal(document.querySelector<HTMLFieldSetElement>('.image-model-fields')!.disabled, true);
  await choose(policy, 'allow');
  const saved = await save();
  assert.equal(saved.body.images.permission, 'allow');
  assert.equal(saved.body.images.apiKey, undefined);
  assert.equal(saved.body.permissions.network, 'ask');
  await choose(policy, 'inherit');
  assert.equal((await save()).body.images.permission, 'inherit');
});

test('room parallel policy is explicit, preserves unrelated fields, and explains a global limit of one', async () => {
  await mount((data) => <RoomDialog room={data.rooms[0]} onClose={() => {}} />);
  assert.equal(toggle('Allow simultaneous responses in this room').checked, false);
  assert.match(
    document.querySelector('.room-generation-field')?.textContent || '',
    /current generation limit is 1/,
  );
  await click(toggle('Allow simultaneous responses in this room'));
  const saved = await save();
  assert.equal(saved.path, '/rooms/room_a');
  assert.equal(saved.body.parallelResponses, true);
  assert.equal(saved.body.workspacePath, undefined);
  assert.equal(saved.body.botIds, undefined);
});

test('simultaneous streams keep text, reasoning, approvals, queue reasons and stop actions with their own tasks', async () => {
  const data = fixture();
  data.rooms[0].parallelResponses = true;
  data.bots.push(makeBot('bot_cedar', 'Cedar', 'sparkles'));
  data.rooms[0].botIds.push('bot_cedar');
  data.tasks = [
    job('a'),
    job('b', 'bot_nova'),
    job('c', 'bot_cedar', 'waiting_model'),
    job('d', 'bot_aster', 'queued'),
  ];
  data.messages = data.tasks.slice(0, 2).map(message);
  data.queue = {
    active: 2,
    waiting: 2,
    capacity: 2,
    modelWaiting: 1,
    sessionWaiting: 1,
    waitingTasks: [
      { taskId: 'c', reason: 'inference' },
      { taskId: 'd', reason: 'session' },
    ],
  };
  await mount((d) => <Chat room={d.rooms[0]} />, data);
  let next = data;
  for (const [messageId, text, reasoning] of [
    ['message_b', 'Beta answer', 'Beta reasoning'],
    ['message_a', 'Alpha answer', 'Alpha reasoning'],
  ]) {
    next = applyEvent(next, { id: 1, type: 'message_delta', data: { messageId, delta: text } })!;
    next = applyEvent(next, {
      id: 2,
      type: 'message_reasoning_delta',
      data: { messageId, delta: reasoning },
    })!;
  }
  next.approvals = ['a', 'b'].map((id) => ({
    id: `approve_${id}`,
    taskId: id,
    roomId: 'room_a',
    botId: id === 'a' ? 'bot_aster' : 'bot_nova',
    toolName: 'write_file',
    summary: `Write ${id}`,
    target: `/tmp/${id}.md`,
    args: { path: `${id}.md` },
    status: 'pending' as const,
    createdAt: now,
  }));
  await rerenderChat(next);
  const alpha = document.querySelector('[data-task-id="a"]')!.closest('.message')!;
  const beta = document.querySelector('[data-task-id="b"]')!.closest('.message')!;
  assert.match(alpha.textContent || '', /Alpha reasoning.*Alpha answer/s);
  assert.doesNotMatch(alpha.textContent || '', /Beta|Write b/);
  assert.match(beta.textContent || '', /Beta reasoning.*Beta answer/s);
  assert.doesNotMatch(beta.textContent || '', /Alpha|Write a/);
  assert.match(document.querySelector('.queue-card')?.textContent || '', /2\s*\/\s*2/);
  assert.match(document.querySelector('.queue-card')?.textContent || '', /simultaneous responses/);
  assert.match(
    document.querySelector('[data-task-id="c"]')?.textContent || '',
    /available generation slot/,
  );
  assert.match(
    document.querySelector('[data-task-id="d"]')?.textContent || '',
    /previous task in the room/,
  );
  await click(button('Approve', beta));
  assert.deepEqual(mutations.at(-1), {
    path: '/approvals/approve_b',
    method: 'POST',
    body: { decision: 'approve' },
  });
  await click(button('Stop', alpha));
  assert.equal(mutations.at(-1)?.path, '/tasks/a/stop');
  assert.equal(mutations.filter((call) => call.path === '/tasks/b/stop').length, 0);
  await rerenderChat({ ...next, queue: { ...next.queue, capacity: 1 } });
  assert.match(
    document.querySelector('.queue-draining')?.textContent || '',
    /Applying a lower limit/,
  );
});

test('generated images arrive on the correct streaming message with same-origin preview and download', async () => {
  const data = fixture();
  data.rooms[0].parallelResponses = true;
  data.tasks = [job('a'), job('b', 'bot_nova')];
  data.messages = data.tasks.map(message);
  await mount((d) => <Chat room={d.rooms[0]} />, data);
  const next = applyEvent(data, {
    id: 1,
    type: 'message_updated',
    data: {
      messageId: 'message_b',
      patch: { attachments: [image, { ...image, id: 'https://untrusted.invalid/image.png' }] },
    },
  })!;
  await rerenderChat(next);
  const beta = document.querySelector('[data-task-id="b"]')!.closest('.message')!;
  const alpha = document.querySelector('[data-task-id="a"]')!.closest('.message')!;
  assert.equal(alpha.querySelector('.generated-image'), null);
  assert.equal(beta.querySelectorAll('.generated-image').length, 1);
  const img = beta.querySelector<HTMLImageElement>('.generated-image-preview img')!;
  assert.equal(img.getAttribute('src'), `/api/images/${image.id}`);
  assert.equal(img.alt, image.prompt);
  assert.equal(beta.querySelector('script'), null);
  const link = beta.querySelector<HTMLAnchorElement>('.generated-image-download')!;
  assert.equal(link.getAttribute('href'), `/api/images/${image.id}?download=1`);
  assert.equal(link.download, 'generated.png');
  await click(button('Enlarge image', beta));
  assert.ok(document.querySelector('dialog[open] .image-lightbox img'));
  await click(button('Close', document.querySelector('dialog[open]')!));
  assert.equal(document.querySelector('dialog[open]'), null);
  await act(async () => img.dispatchEvent(new dom.window.Event('error')));
  assert.match(beta.textContent || '', /image could not be loaded/);
  assert.ok(beta.querySelector('.generated-image-download'));
});

after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});
