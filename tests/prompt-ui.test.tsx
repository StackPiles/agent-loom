import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import { DEFAULT_IMAGE_SETTINGS } from '../src/shared/model-settings';
import type { Bot, PromptGeneration, PromptGenerationRequest, Snapshot } from '../src/shared/types';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3210',
  pretendToBeVisual: true,
});
for (const name of [
  'window',
  'document',
  'navigator',
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
const { TeamPage } = await import('../src/client/TeamPage');

const stamp = '2026-10-31T06:00:00.000Z';
const bot: Bot = {
  id: 'bot_aster',
  name: 'Aster',
  handle: 'aster',
  role: 'Research and planning',
  systemPrompt: 'Verify sources and explain uncertainty.',
  color: '#829479',
  avatar: 'character:aster',
  enabled: true,
  createdAt: stamp,
};
const generated =
  'You are a research assistant. Verify evidence, cite sources, and describe uncertainty.';
function fixture(): Snapshot {
  return {
    version: 'test',
    settings: {
      model: {
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'local-prompt-model',
        apiKeyConfigured: false,
        contextWindow: 32768,
        maxOutputTokens: 4096,
        temperature: 0.7,
      },
      images: { ...DEFAULT_IMAGE_SETTINGS },
      inference: { maxConcurrentRequests: 1 },
      demoMode: false,
      autoLearn: false,
      maxHandoffs: 6,
      workspacePath: 'C:\\Loom',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: [{ ...bot }],
    rooms: [],
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
function job(status: PromptGeneration['status'] = 'queued'): PromptGeneration {
  return {
    id: '88b06d48-b7d1-4bb9-8cfb-40a03834a01f',
    status,
    request: {
      name: bot.name,
      role: bot.role,
      instructions: 'Research technical decisions and give concise recommendations.',
      currentPrompt: bot.systemPrompt,
      locale: 'en',
    },
    output: status === 'completed' ? generated : '',
    createdAt: stamp,
    updatedAt: stamp,
  };
}
type RequestBody = PromptGenerationRequest & { requestId: string };
let root: ReturnType<typeof createRoot> | undefined;
let history: PromptGeneration[] = [];
let post: ((body: RequestBody) => Promise<PromptGeneration>) | undefined;
let read: ((id: string, signal?: AbortSignal | null) => Promise<PromptGeneration>) | undefined;
const requests: {
  path: string;
  method: string;
  body?: RequestBody;
  signal?: AbortSignal | null;
}[] = [];
const mutations: { path: string; method?: string; body?: Partial<Bot> }[] = [];
Object.assign(globalThis, {
  fetch: async (path: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body, signal: init.signal });
    assert.ok(path.startsWith('/api/prompt-generations'), `Unexpected request: ${path}`);
    if (method === 'POST') {
      const { requestId, ...input } = body as RequestBody;
      const result = post ? await post(body) : { ...job(), id: requestId, request: input };
      history = [result, ...history.filter((item) => item.id !== result.id)];
      return Response.json(result, { status: result.status === 'completed' ? 200 : 202 });
    }
    if (method === 'DELETE') {
      const id = path.split('/').at(-1)!;
      const result: PromptGeneration = {
        ...history.find((item) => item.id === id)!,
        status: 'cancelled',
        updatedAt: '2026-10-31T06:04:00.000Z',
      };
      history = [result, ...history.filter((item) => item.id !== id)];
      return Response.json(result);
    }
    if (path === '/api/prompt-generations') return Response.json(history);
    const id = path.split('/').at(-1)!;
    const result = read ? await read(id, init.signal) : history.find((item) => item.id === id)!;
    history = [result, ...history.filter((item) => item.id !== id)];
    return Response.json(result);
  },
});
async function mount(data = fixture()) {
  if (root) await act(async () => root!.unmount());
  history = [];
  post = undefined;
  read = undefined;
  requests.length = 0;
  mutations.length = 0;
  const context: AppContextValue = {
    data,
    locale: 'en',
    t: (_ja, en) => en,
    view: 'team',
    roomId: '',
    navigate() {},
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string, method?: string, body?: unknown) {
      mutations.push({ path, method, body: body as Partial<Bot> });
      return { ...bot, ...(body as object) } as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        <TeamPage />
      </AppContext.Provider>,
    ),
  );
}
function findButton(label: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
}
function button(label: string, scope: ParentNode = document) {
  const value = findButton(label, scope);
  assert.ok(value, `Missing button: ${label}`);
  return value;
}
function textarea(label: string) {
  const value = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
  assert.ok(value, `Missing textarea: ${label}`);
  return value;
}
function assistant() {
  const value = document.querySelector<HTMLElement>('[aria-label="System prompt assistant"]');
  assert.ok(value, 'Missing system prompt assistant');
  return value;
}
function improveToggle() {
  const label = [...document.querySelectorAll('label')].find((element) =>
    element.textContent?.includes('Improve the current prompt'),
  );
  const value = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(value, 'Missing improve-current-prompt checkbox');
  return value;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function input(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function open() {
  await click(button('Edit'));
  assert.equal(requests.length, 0, 'Opening a profile alone must not fetch prompt history');
  await click(button('Help write'));
}
async function save() {
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  );
  return mutations.at(-1)!;
}
async function poll() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1350));
  });
}
after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});

test('prompt assistance uses explicit bot context, deduplicates clicks, and can omit the current prompt', async () => {
  await mount();
  await open();
  assert.equal(textarea('What should this bot do?').value, bot.role);
  assert.equal(improveToggle().checked, true);
  assert.match(assistant().textContent || '', /local-prompt-model/);
  for (const element of assistant().querySelectorAll('button'))
    assert.equal(element.type, 'button');
  await input(textarea('What should this bot do?'), 'Review evidence and ask concise questions.');
  let finish!: (value: PromptGeneration) => void;
  post = async () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await act(async () => {
    button('Generate draft').click();
    button('Generate draft').click();
  });
  const sends = requests.filter((item) => item.method === 'POST');
  assert.equal(sends.length, 1);
  const { requestId, ...inputContext } = sends[0].body!;
  assert.match(requestId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(inputContext, {
    name: bot.name,
    role: bot.role,
    instructions: 'Review evidence and ask concise questions.',
    currentPrompt: bot.systemPrompt,
    locale: 'en',
  });
  await act(async () => finish({ ...job('completed'), id: requestId, request: inputContext }));
  assert.equal(textarea('System prompt').value, bot.systemPrompt);
  assert.equal(mutations.length, 0);
  await click(improveToggle());
  post = async ({ requestId: id, ...request }) => ({ ...job('completed'), id, request });
  await click(button('Generate draft'));
  const last = requests.filter((item) => item.method === 'POST').at(-1)!.body!;
  assert.notEqual(last.requestId, requestId);
  assert.equal(Object.hasOwn(last, 'currentPrompt'), false);
  assert.equal(mutations.length, 0);
});

test('saved prompt drafts are editable and apply only to the profile draft with undo before saving', async () => {
  await mount();
  history = [job('completed')];
  await open();
  assert.equal(textarea('Draft system prompt').value, generated);
  assert.equal(textarea('System prompt').value, bot.systemPrompt);
  await input(textarea('Draft system prompt'), `${generated}\nUse short paragraphs.`);
  await click(button('Use this draft'));
  assert.equal(document.querySelector('[aria-label="System prompt assistant"]'), null);
  assert.equal(textarea('System prompt').value, `${generated}\nUse short paragraphs.`);
  assert.equal(mutations.length, 0);
  await click(button('Undo replacement'));
  assert.equal(textarea('System prompt').value, bot.systemPrompt);
  assert.equal(mutations.length, 0);
  await click(button('Help write'));
  assert.equal(
    textarea('Draft system prompt').value,
    generated,
    'Original model output remains in history',
  );
  await click(button('Use this draft'));
  const result = await save();
  assert.equal(result.path, '/bots/bot_aster');
  assert.equal(result.method, 'PATCH');
  assert.equal(result.body?.systemPrompt, generated);
  assert.equal(requests.filter((item) => item.method === 'POST').length, 0);
});

test('saved drafts can be previewed and applied without losing access to a generation in progress', async () => {
  await mount();
  const older: PromptGeneration = {
    ...job('completed'),
    id: '5d14c70e-8596-4942-b716-afdf8e218a45',
    request: { ...job().request, name: 'Nova', role: 'Review' },
    output: 'Review claims and identify missing evidence.',
    createdAt: '2026-10-31T05:00:00.000Z',
    updatedAt: '2026-10-31T05:01:00.000Z',
  };
  const active: PromptGeneration = {
    ...job('generating'),
    id: 'cf283add-bd4b-4560-8efa-1bd7e9b89949',
    output: 'A newer draft is still being written.',
    createdAt: '2026-10-31T06:05:00.000Z',
    updatedAt: '2026-10-31T06:05:01.000Z',
  };
  history = [active, job('completed'), older];
  await open();
  const saved = document.querySelector<HTMLSelectElement>('select[aria-label="Saved drafts"]');
  assert.ok(saved);
  assert.match(saved.textContent || '', /Aster/);
  assert.match(saved.textContent || '', /Nova/);
  assert.equal(saved.value, active.id);
  assert.equal(textarea('Draft system prompt').value, active.output);
  await act(async () => {
    saved.value = older.id;
    saved.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  assert.equal(textarea('Draft system prompt').value, older.output);
  assert.equal(textarea('System prompt').value, bot.systemPrompt);
  assert.equal(mutations.length, 0);
  assert.ok(
    [...saved.options].some(
      (option) => option.value === active.id && option.textContent === 'Draft in progress',
    ),
    'The active draft must remain reachable after switching to saved history',
  );
  await act(async () => {
    saved.value = active.id;
    saved.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  assert.equal(textarea('Draft system prompt').value, active.output);
  assert.equal(textarea('Draft system prompt').readOnly, true);
  assert.ok(!findButton('Use this draft') || button('Use this draft').disabled);
  await act(async () => {
    saved.value = older.id;
    saved.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await click(button('Use this draft'));
  const result = await save();
  assert.equal(result.path, '/bots/bot_aster');
  assert.equal(result.body?.systemPrompt, older.output);
});

test('queued and streaming prompts remain read-only until a complete draft is available', async () => {
  await mount();
  history = [job('queued')];
  await open();
  assert.match(assistant().textContent || '', /Queued/);
  assert.equal(button('Generate draft').disabled, true);
  assert.ok(!findButton('Use this draft') || button('Use this draft').disabled);
  read = async () => ({
    ...job('generating'),
    output: 'You are a research assistant.',
    updatedAt: '2026-10-31T06:01:00.000Z',
  });
  await poll();
  assert.match(assistant().textContent || '', /Generating prompt/);
  assert.equal(textarea('Draft system prompt').value, 'You are a research assistant.');
  assert.equal(textarea('Draft system prompt').readOnly, true);
  assert.ok(!findButton('Use this draft') || button('Use this draft').disabled);
  read = async () => ({ ...job('completed'), updatedAt: '2026-10-31T06:02:00.000Z' });
  await poll();
  assert.equal(textarea('Draft system prompt').value, generated);
  assert.equal(textarea('Draft system prompt').readOnly, false);
  assert.equal(button('Use this draft').disabled, false);
  assert.equal(textarea('System prompt').value, bot.systemPrompt);
  assert.equal(mutations.length, 0);
});

test('closing a profile aborts observation without cancelling its job and explicit stop permits a fresh request', async () => {
  await mount();
  history = [job('queued')];
  await open();
  await poll();
  const watched = requests.find((item) => item.path === `/api/prompt-generations/${job().id}`)!;
  assert.ok(watched.signal);
  await click(button('Close'));
  assert.equal(watched.signal.aborted, true);
  assert.equal(requests.filter((item) => item.method === 'DELETE').length, 0);
  await click(button('Edit'));
  await click(button('Help write'));
  assert.match(assistant().textContent || '', /Queued/);
  await click(button('Stop generation'));
  assert.equal(requests.filter((item) => item.method === 'DELETE').length, 1);
  assert.match(assistant().textContent || '', /stopped|cancelled/i);
  assert.equal(button('Generate draft').disabled, false);
  await click(button('Generate draft'));
  const send = requests.find((item) => item.method === 'POST')!;
  assert.notEqual(send.body!.requestId, job().id);
  assert.equal(mutations.length, 0);
});

test('an uncertain prompt request preserves its UUID and input until the same request is recovered', async () => {
  await mount();
  await open();
  let first = true;
  post = async ({ requestId, ...request }) => {
    if (first) {
      first = false;
      throw new TypeError('Connection interrupted after submission');
    }
    return { ...job('completed'), id: requestId, request };
  };
  await click(button('Generate draft'));
  assert.match(
    assistant().querySelector('[role="alert"]')?.textContent || '',
    /Connection interrupted/,
  );
  assert.equal(textarea('What should this bot do?').disabled, true);
  assert.equal(improveToggle().disabled, true);
  await click(button('Check the same request'));
  const sends = requests.filter((item) => item.method === 'POST');
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[1].body, sends[0].body);
  assert.equal(textarea('Draft system prompt').value, generated);
  assert.equal(textarea('System prompt').value, bot.systemPrompt);
  assert.equal(mutations.length, 0);
});

test('demo or missing model settings cannot generate, but existing saved drafts remain usable', async () => {
  for (const setup of ['demo', 'missing-model'] as const) {
    const data = fixture();
    if (setup === 'demo') data.settings.demoMode = true;
    else data.settings.model.modelId = '';
    await mount(data);
    history = [job('completed')];
    await open();
    assert.match(assistant().textContent || '', /Settings|demo/i);
    assert.ok(!findButton('Generate draft') || button('Generate draft').disabled);
    await click(button('Use this draft'));
    assert.equal(textarea('System prompt').value, generated);
    assert.equal(requests.filter((item) => item.method === 'POST').length, 0);
    assert.equal(mutations.length, 0);
  }
});

test('failed and interrupted drafts never apply partial output or silently replace the current prompt', async () => {
  for (const status of ['failed', 'interrupted'] as const) {
    await mount();
    history = [
      {
        ...job(status),
        output: 'Incomplete instructions',
        error: 'Synthetic interrupted response',
      },
    ];
    await open();
    assert.match(assistant().textContent || '', /interrupted|could not|failed/i);
    assert.ok(!findButton('Use this draft') || button('Use this draft').disabled);
    assert.equal(textarea('System prompt').value, bot.systemPrompt);
    assert.equal(mutations.length, 0);
  }
});
