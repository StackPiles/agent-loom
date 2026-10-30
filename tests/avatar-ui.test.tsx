import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import { DEFAULT_IMAGE_SETTINGS } from '../src/shared/model-settings';
import { CHARACTER_AVATARS } from '../src/shared/avatars';
import type { AvatarGeneration, Bot, GeneratedImage, Snapshot } from '../src/shared/types';

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
const { renderToStaticMarkup } = await import('react-dom/server');
const { AppContext } = await import('../src/client/context');
const { Avatar } = await import('../src/client/components');
const { TeamPage } = await import('../src/client/TeamPage');

const now = '2026-10-31T04:00:00.000Z';
const bot: Bot = {
  id: 'bot_aster',
  name: 'Aster',
  handle: 'aster',
  role: 'Planning',
  systemPrompt: 'A synthetic test bot.',
  color: '#829479',
  avatar: 'character:aster',
  enabled: true,
  createdAt: now,
};
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
      images: {
        ...DEFAULT_IMAGE_SETTINGS,
        enabled: true,
        baseUrl: 'http://localhost:9090/v1',
        modelId: 'local-character-model',
      },
      demoMode: false,
      autoLearn: false,
      maxHandoffs: 6,
      workspacePath: 'C:\\Loom',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'ask' },
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
const image: GeneratedImage = {
  id: `img_${'a'.repeat(64)}`,
  type: 'image',
  mimeType: 'image/png',
  filename: 'character.png',
  byteLength: 1024,
  prompt: 'A smiling fox character.',
  model: 'local-character-model',
  createdAt: now,
};
function job(status: AvatarGeneration['status'] = 'queued'): AvatarGeneration {
  return {
    id: '09e06376-58d3-41fa-94ef-0cf2335aff1e',
    prompt: image.prompt,
    status,
    ...(status === 'completed' ? { image } : {}),
    createdAt: now,
    updatedAt: now,
  };
}
let root: ReturnType<typeof createRoot> | undefined;
let history: AvatarGeneration[] = [];
let post: ((body: { requestId: string; prompt: string }) => Promise<AvatarGeneration>) | undefined;
let read: ((id: string, signal?: AbortSignal | null) => Promise<AvatarGeneration>) | undefined;
const requests: { path: string; method: string; body?: any; signal?: AbortSignal | null }[] = [];
const mutations: { path: string; method?: string; body?: any }[] = [];
Object.assign(globalThis, {
  fetch: async (path: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body, signal: init.signal });
    assert.ok(path.startsWith('/api/avatar-generations'));
    if (method === 'POST') {
      const result = post
        ? await post(body)
        : { ...job(), id: body.requestId, prompt: body.prompt };
      history = [result, ...history.filter((item) => item.id !== result.id)];
      return Response.json(result, { status: 202 });
    }
    if (method === 'DELETE') {
      const id = path.split('/').at(-1)!;
      const result = {
        ...history.find((item) => item.id === id)!,
        status: 'cancelled',
        updatedAt: '2026-10-31T04:02:00.000Z',
      };
      history = [result as AvatarGeneration];
      return Response.json(result);
    }
    if (path === '/api/avatar-generations') return Response.json(history);
    const id = path.split('/').at(-1)!;
    return Response.json(
      read ? await read(id, init.signal) : history.find((item) => item.id === id),
    );
  },
});
async function mount(render: () => React.ReactNode = () => <TeamPage />, data = fixture()) {
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
      mutations.push({ path, method, body });
      return { ...bot, ...(body as object) } as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await act(async () =>
    root!.render(<AppContext.Provider value={context}>{render()}</AppContext.Provider>),
  );
}
function button(label: string) {
  const value = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  assert.ok(value, `Missing button: ${label}`);
  return value;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function edit() {
  await click(button('Edit'));
}
async function generator() {
  await click(button('Generate image'));
}
async function appearance(value: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Appearance description"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function save() {
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  );
  return mutations.at(-1)!;
}

after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});

test('character and managed image avatars use safe sources, fall back on errors, and recover after a source change', async () => {
  for (const size of ['small', 'normal', 'large'] as const) {
    for (const character of CHARACTER_AVATARS) {
      const html = renderToStaticMarkup(
        <Avatar size={size} bot={{ ...bot, avatar: character.value }} />,
      );
      const avatar = new JSDOM(html).window.document.querySelector('.avatar')!;
      assert.equal(avatar.querySelector('img')?.getAttribute('src'), character.src);
      assert.equal(avatar.textContent, '');
    }
  }
  for (const value of [
    'https://example.com/avatar.png',
    'data:image/svg+xml,<svg/>',
    'image:../../secret',
    'character:__proto__',
  ]) {
    const html = renderToStaticMarkup(<Avatar bot={{ ...bot, avatar: value }} />);
    const avatar = new JSDOM(html).window.document.querySelector('.avatar')!;
    assert.equal(avatar.querySelector('img'), null);
    assert.equal(avatar.textContent, 'A');
  }
  await mount(() => <Avatar bot={bot} />);
  const renderAvatar = async (value: string) => {
    await act(async () => root!.render(<Avatar bot={{ ...bot, avatar: value }} />));
  };
  await renderAvatar(`image:${image.id}`);
  assert.equal(document.querySelector('img')?.getAttribute('src'), `/api/images/${image.id}`);
  await act(async () =>
    document.querySelector('img')!.dispatchEvent(new dom.window.Event('error')),
  );
  assert.equal(document.querySelector('.avatar')?.textContent, 'A');
  await renderAvatar('character:nova');
  assert.equal(document.querySelector('img')?.getAttribute('src'), '/avatars/nova.webp');
  await renderAvatar(`image:${image.id}`);
  assert.equal(document.querySelector('img')?.getAttribute('src'), `/api/images/${image.id}`);
});

test('character selection edits only the draft, preserves legacy symbols, and new bots start with a character', async () => {
  await mount();
  await edit();
  await click(button('Avatar Nova'));
  assert.equal(
    document.querySelector('.profile-customization > .avatar img')?.getAttribute('src'),
    '/avatars/nova.webp',
  );
  assert.equal(mutations.length, 0);
  assert.equal(requests.length, 0);
  await click(button('Avatar Compass'));
  assert.ok(document.querySelector('.profile-customization > .avatar svg.lucide-compass'));
  await click(button('Avatar Nova'));
  assert.equal((await save()).body.avatar, 'character:nova');
  await click(button('Add bot'));
  assert.equal(
    document.querySelector('.profile-customization > .avatar img')?.getAttribute('src'),
    '/avatars/aster.webp',
  );
});

test('accent color previews immediately for built-in and generated portraits, keeps custom colors available, and saves only with the profile', async () => {
  for (const avatar of ['character:aster', `image:${image.id}`]) {
    const data = fixture();
    data.bots[0] = { ...data.bots[0], avatar, color: '#4d6980' };
    await mount(undefined, data);
    await edit();
    const preview = () => document.querySelector<HTMLElement>('.profile-customization > .avatar')!;
    const originalSource = preview().querySelector('img')!.getAttribute('src');
    const saved = button('Accent color Saved color');
    assert.equal(saved.getAttribute('aria-pressed'), 'true');
    assert.ok(saved.querySelector('svg.lucide-check'));
    assert.match(document.querySelector('.avatar-color-picker')?.textContent || '', /Accent color/);
    assert.equal(preview().style.getPropertyValue('--avatar-color'), '#4d6980');
    assert.ok(preview().classList.contains('avatar-with-image'));

    await click(button('Accent color Purple'));
    assert.equal(preview().style.getPropertyValue('--avatar-color'), '#a38dba');
    assert.equal(preview().querySelector('img')!.getAttribute('src'), originalSource);
    assert.equal(button('Accent color Purple').getAttribute('aria-pressed'), 'true');
    assert.ok(button('Accent color Purple').querySelector('svg.lucide-check'));
    assert.equal(saved.getAttribute('aria-pressed'), 'false');
    assert.equal(
      document
        .querySelector<HTMLElement>('.team-card .avatar')!
        .style.getPropertyValue('--avatar-color'),
      '#4d6980',
    );
    assert.equal(mutations.length, 0);
    assert.equal(requests.filter((item) => item.method === 'POST').length, 0);

    await click(saved);
    assert.equal(preview().style.getPropertyValue('--avatar-color'), '#4d6980');
    await click(button('Accent color Blue'));
    const result = await save();
    assert.equal(result.path, '/bots/bot_aster');
    assert.equal(result.body.avatar, avatar);
    assert.equal(result.body.color, '#7e94aa');
    assert.equal(result.body.name, 'Aster');
  }
});

test('image generation discloses model, deduplicates clicks, previews a result, and saves only after selection', async () => {
  await mount();
  await edit();
  await generator();
  assert.match(
    document.querySelector('.avatar-model-summary')?.textContent || '',
    /local-character-model.*1024x1024.*http:\/\/localhost:9090\/v1/,
  );
  await appearance('A smiling fox character.');
  let finish!: (value: AvatarGeneration) => void;
  post = async () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await act(async () => {
    button('Generate').click();
    button('Generate').click();
  });
  const sends = requests.filter((item) => item.method === 'POST');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.prompt, 'A smiling fox character.');
  assert.deepEqual(Object.keys(sends[0].body).sort(), ['prompt', 'requestId']);
  await act(async () => finish({ ...job('completed'), id: sends[0].body.requestId }));
  assert.equal(
    document.querySelector('.avatar-result-picture img')?.getAttribute('src'),
    `/api/images/${image.id}`,
  );
  assert.equal(
    document.querySelector('.profile-customization > .avatar img')?.getAttribute('src'),
    '/avatars/aster.webp',
  );
  assert.equal(mutations.length, 0);
  await click(button('Use this image'));
  assert.equal(
    document.querySelector('.profile-customization > .avatar img')?.getAttribute('src'),
    `/api/images/${image.id}`,
  );
  assert.equal(mutations.length, 0);
  assert.equal((await save()).body.avatar, `image:${image.id}`);
});

test('an uncertain request retries the same UUID instead of issuing a duplicate generation', async () => {
  await mount();
  await edit();
  await generator();
  let first = true;
  post = async (body) => {
    if (first) {
      first = false;
      throw new TypeError('Connection interrupted after request');
    }
    return { ...job('completed'), id: body.requestId, prompt: body.prompt };
  };
  await click(button('Generate'));
  assert.match(
    document.querySelector('[role="alert"]')?.textContent || '',
    /Connection interrupted/,
  );
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Appearance description"]')
      ?.disabled,
    true,
  );
  await click(button('Check the same request'));
  const sends = requests.filter((item) => item.method === 'POST');
  assert.equal(sends.length, 2);
  assert.equal(sends[0].body.requestId, sends[1].body.requestId);
  assert.equal(sends[0].body.prompt, sends[1].body.prompt);
  assert.ok(document.querySelector('.avatar-result-picture img'));
  assert.equal(mutations.length, 0);
});

test('running generations survive closing the editor, poll real state, cancel explicitly, and allow a fresh retry', async () => {
  await mount();
  await edit();
  history = [job('queued')];
  await generator();
  assert.match(document.querySelector('.avatar-generation-status')?.textContent || '', /Queued/);
  assert.equal(button('Generate').disabled, true);
  read = async () => ({ ...job('generating'), updatedAt: '2026-10-31T04:01:00.000Z' });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1350));
  });
  assert.match(
    document.querySelector('.avatar-generation-status')?.textContent || '',
    /Generating image/,
  );
  const polled = requests.find((item) => item.path === `/api/avatar-generations/${job().id}`)!;
  await click(button('Close'));
  assert.equal(polled.signal?.aborted, true);
  assert.equal(requests.filter((item) => item.method === 'DELETE').length, 0);
  await edit();
  await generator();
  assert.match(document.querySelector('.avatar-generation-status')?.textContent || '', /Queued/);
  await click(button('Stop generation'));
  assert.match(
    document.querySelector('.avatar-job-message')?.textContent || '',
    /Generation stopped/,
  );
  assert.equal(requests.filter((item) => item.method === 'DELETE').length, 1);
  await click(button('Generate'));
  const send = requests.find((item) => item.method === 'POST')!;
  assert.notEqual(send.body.requestId, job().id);
  assert.equal(mutations.length, 0);
});

test('disabled models and denied network access block generation while saved images remain usable', async () => {
  const data = fixture();
  data.settings.images!.enabled = false;
  await mount(undefined, data);
  await edit();
  history = [job('completed')];
  await generator();
  assert.match(
    document.querySelector('.avatar-setup-note')?.textContent || '',
    /Enable an image model/,
  );
  assert.equal(
    [...document.querySelectorAll('button')].find((item) => item.textContent === 'Generate'),
    undefined,
  );
  await click(button('Use this image'));
  assert.equal((await save()).body.avatar, `image:${image.id}`);
  const denied = fixture();
  denied.settings.permissions.network = 'deny';
  await mount(undefined, denied);
  await edit();
  await generator();
  assert.equal(button('Generate').disabled, true);
  assert.match(
    document.querySelector('.avatar-generator')?.textContent || '',
    /Network access is denied/,
  );
  assert.equal(requests.filter((item) => item.method === 'POST').length, 0);
});

test('failed and interrupted jobs remain visible and image failures do not apply an unavailable avatar', async () => {
  await mount();
  await edit();
  history = [{ ...job('failed'), error: 'The image model is offline.' }];
  await generator();
  assert.match(
    document.querySelector('.avatar-job-message')?.textContent || '',
    /could not be generated.*offline/,
  );
  history = [{ ...job('interrupted'), updatedAt: '2026-10-31T04:01:00.000Z' }];
  await click(button('Refresh'));
  assert.match(
    document.querySelector('.avatar-job-message')?.textContent || '',
    /interrupted by a restart/,
  );
  history = [{ ...job('completed'), updatedAt: '2026-10-31T04:02:00.000Z' }];
  await click(button('Refresh'));
  await act(async () =>
    document
      .querySelector('.avatar-result-picture img')!
      .dispatchEvent(new dom.window.Event('error')),
  );
  assert.match(
    document.querySelector('.avatar-result-picture')?.textContent || '',
    /Image unavailable/,
  );
  assert.equal(button('Use this image').disabled, true);
  assert.equal(
    document.querySelector('.profile-customization > .avatar img')?.getAttribute('src'),
    '/avatars/aster.webp',
  );
});
