import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Automation, Snapshot } from '../src/shared/types';
import { GMAIL_CONNECTION } from '../src/shared/mail-settings';

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
const { AutomationsPage } = await import('../src/client/AutomationsPage');

const stamp = '2026-11-01T00:00:00.000Z';
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
      workspacePath: 'C:\\Loom',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: [
      {
        id: 'bot_aster',
        name: 'Aster',
        handle: 'aster',
        role: 'Research',
        systemPrompt: 'Research carefully.',
        color: '#829479',
        avatar: 'character:aster',
        enabled: true,
        createdAt: stamp,
      },
    ],
    rooms: [
      {
        id: 'room_one',
        name: 'Research',
        description: '',
        botIds: ['bot_aster'],
        archived: false,
        pinned: false,
        createdAt: stamp,
        updatedAt: stamp,
      },
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
function savedAutomation(configured = true): Automation {
  return {
    id: 'auto_mail',
    name: 'Mail watch',
    kind: 'imap',
    enabled: configured,
    roomId: 'room_one',
    botId: 'bot_aster',
    prompt: 'Notify me about important senders.',
    intervalMinutes: 5,
    sourceUrl: '',
    createdAt: stamp,
    imap: { ...GMAIL_CONNECTION, user: 'owner@gmail.com', passwordConfigured: configured },
  };
}
let root: ReturnType<typeof createRoot> | undefined;
let response: ((init: RequestInit) => Promise<Response>) | undefined;
const requests: { path: string; method: string; body: any; signal?: AbortSignal | null }[] = [];
const mutations: { path: string; method?: string; body?: any }[] = [];
Object.assign(globalThis, {
  fetch: async (path: string, init: RequestInit = {}) => {
    requests.push({
      path,
      method: init.method || 'GET',
      body: JSON.parse(String(init.body)),
      signal: init.signal,
    });
    assert.equal(path, '/api/mail/test');
    if (response) return response(init);
    return Response.json({
      ok: true,
      host: GMAIL_CONNECTION.host,
      user: 'owner@gmail.com',
      mailbox: 'INBOX',
    });
  },
});
async function mount(data = fixture(), locale: 'en' | 'ja' = 'en') {
  if (root) await act(async () => root!.unmount());
  requests.length = 0;
  mutations.length = 0;
  response = undefined;
  const context: AppContextValue = {
    data,
    locale,
    t: (ja, en) => (locale === 'ja' ? ja : en),
    view: 'automations',
    roomId: 'room_one',
    navigate() {},
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string, method?: string, body?: any) {
      mutations.push({ path, method, body });
      return {} as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        <AutomationsPage />
      </AppContext.Provider>,
    ),
  );
}
function button(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) =>
      element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
  );
  assert.ok(result, 'Missing button: ' + label);
  return result;
}
function field<
  T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement = HTMLInputElement,
>(label: string): T {
  const container = [...document.querySelectorAll('label.field')].find(
    (element) => element.querySelector('.field-label')?.textContent === label,
  );
  const result = container?.querySelector('input, select, textarea');
  assert.ok(result, 'Missing field: ' + label);
  return result as T;
}
function toggle(label: string): HTMLInputElement {
  const result = [...document.querySelectorAll('label.toggle-row')]
    .find((element) => element.querySelector('strong')?.textContent === label)
    ?.querySelector<HTMLInputElement>('input');
  assert.ok(result, 'Missing toggle: ' + label);
  return result;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element.tagName === 'TEXTAREA'
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function newEmail() {
  await click(button('New automation'));
  await choose(field<HTMLSelectElement>('Trigger'), 'imap');
  await choose(field<HTMLSelectElement>('Mail account'), 'legacy');
}
function withAutomation(automation = savedAutomation()): Snapshot {
  return { ...fixture(), automations: [automation] };
}

test('incoming-mail account placeholder is selectable and remains empty across bot and room changes', async () => {
  const data = fixture();
  data.bots.push({ ...data.bots[0], id: 'bot_nova', name: 'Nova', handle: 'nova' });
  data.rooms[0].botIds.push('bot_nova');
  data.rooms.push({ ...data.rooms[0], id: 'room_nova', name: 'Nova room', botIds: ['bot_nova'] });
  data.mailAccounts = data.bots.map((bot) => ({
    id: `mail_${bot.handle}`,
    name: `${bot.name} inbox`,
    address: `${bot.handle}@example.test`,
    provider: 'agentmail',
    enabled: true,
    botIds: [bot.id],
    sendPolicy: 'ask',
    api: { inboxId: bot.handle, apiKeyConfigured: true },
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  }));
  await mount(data, 'ja');
  await click(button('自動化をつくる'));
  await choose(field<HTMLSelectElement>('きっかけ'), 'imap');
  await input(field('名前'), '重要なメール');
  await input(field<HTMLTextAreaElement>('任せること'), '対応が必要なメールを知らせてください。');
  const selector = field<HTMLSelectElement>('受信するメールアカウント');
  const empty = [...selector.options].find((option) => option.value === '');
  assert.ok(empty);
  assert.equal(empty.textContent, 'メールアカウントを選択');
  assert.equal(empty.disabled, false, 'the empty option must be selectable in the native dropdown');
  await choose(selector, '');
  assert.equal(selector.value, '');
  assert.equal(button('保存する').disabled, true);
  assert.equal(document.querySelector('form')!.checkValidity(), false);
  await click(button('保存する'));
  assert.equal(mutations.length, 0);
  await choose(field<HTMLSelectElement>('担当する仲間'), 'bot_nova');
  assert.equal(selector.value, '', 'changing bots must not restore the first assigned mailbox');
  await choose(field<HTMLSelectElement>('結果を届けるルーム'), 'room_nova');
  assert.equal(selector.value, '', 'changing rooms must preserve the explicit empty selection');
  assert.equal(button('保存する').disabled, true);
  await choose(selector, 'mail_nova');
  assert.equal(button('保存する').disabled, false);
  await choose(selector, 'legacy');
  assert.equal(field<HTMLSelectElement>('メールサービス').value, 'gmail');
  await choose(field<HTMLSelectElement>('結果を届けるルーム'), 'room_one');
  assert.equal(selector.value, 'legacy', 'legacy setup also remains selected across bot changes');
  await choose(selector, 'mail_aster');
  assert.equal(button('保存する').disabled, false);
  await click(button('保存する'));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].body.mailAccountId, 'mail_aster');
  assert.equal(Object.hasOwn(mutations[0].body, 'imap'), false);
});

test('Gmail preset tests exact TLS settings with a normalized app password and never saves or starts a rule', async () => {
  await mount();
  await newEmail();
  assert.equal(field<HTMLSelectElement>('Email service').value, 'gmail');
  assert.equal(field('App password').required, true);
  assert.equal(field('Email address').type, 'email');
  assert.equal(document.querySelector('input[placeholder="imap.example.com"]'), null);
  assert.ok(document.querySelector('a[href="https://myaccount.google.com/apppasswords"]'));
  assert.ok(
    document.querySelector(
      'a[href="https://myaccount.google.com/signinoptions/two-step-verification"]',
    ),
  );
  assert.match(document.body.textContent!, /not your regular Google account password/);
  await input(field('Email address'), 'owner@gmail.com');
  await input(field('App password'), 'abcd efgh ijkl mnop');
  assert.equal(field('App password').value, 'abcdefghijklmnop');
  await click(button('Test connection'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, {
    imap: { ...GMAIL_CONNECTION, user: 'owner@gmail.com', password: 'abcdefghijklmnop' },
  });
  assert.equal(mutations.length, 0);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Connected to the mailbox/);
  await input(field('Email address'), 'different@gmail.com');
  assert.equal(field('App password').value, '');
  assert.equal(document.querySelector('[role="status"]'), null);
  assert.equal(button('Test connection').disabled, true);
});

test('editing an existing Gmail account reuses its saved password only for the same account', async () => {
  await mount(withAutomation());
  await click(button('Edit'));
  assert.equal(field<HTMLSelectElement>('Email service').value, 'gmail');
  assert.equal(field('App password').required, false);
  assert.match(document.body.textContent!, /Already configured/);
  await input(field('Mailbox'), 'Projects');
  await click(button('Test connection'));
  assert.deepEqual(requests[0].body, {
    automationId: 'auto_mail',
    imap: { ...GMAIL_CONNECTION, user: 'owner@gmail.com', mailbox: 'Projects' },
  });
  await input(field('Email address'), 'another@gmail.com');
  assert.equal(field('App password').required, true);
  assert.doesNotMatch(document.body.textContent!, /Already configured/);
  assert.equal(button('Test connection').disabled, true);
});

test('changing provider or transport clears entered credentials while generic passwords remain literal', async () => {
  await mount(withAutomation());
  await click(button('Edit'));
  await input(field('App password'), 'abcdefghijklmnop');
  await choose(field<HTMLSelectElement>('Email service'), 'imap');
  assert.equal(field('Host').value, '');
  assert.equal(field('App password').value, '');
  assert.equal(field('App password').required, true);
  await input(field('Host'), 'mail.example.com');
  await input(field('App password'), 'space separated password');
  await click(button('Test connection'));
  assert.equal(requests[0].body.imap.password, 'space separated password');
  await input(field('Host'), 'other.example.com');
  assert.equal(field('App password').value, '');
  await input(field('App password'), 'another value');
  await choose(field<HTMLSelectElement>('Email service'), 'gmail');
  assert.equal(field('App password').value, '');
  assert.equal(
    field('App password').required,
    false,
    'the original saved Gmail account is available again',
  );
});

test('edits abort an outstanding test and ignore its late result without locking a new test', async () => {
  await mount(withAutomation());
  await click(button('Edit'));
  let complete!: (value: Response) => void;
  response = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  await click(button('Test connection'));
  assert.equal(button('Testing connection…').disabled, true);
  await click(button('Testing connection…'));
  assert.equal(requests.length, 1);
  await input(field('Mailbox'), 'Projects');
  assert.equal(requests[0].signal?.aborted, true);
  assert.equal(button('Test connection').disabled, false);
  await act(async () => complete(Response.json({ ok: true })));
  assert.equal(document.querySelector('[role="status"]'), null);
  response = undefined;
  await click(button('Test connection'));
  assert.equal(requests.length, 2);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Connected to the mailbox/);
});

test('closing a test aborts it and reopening does not retain an entered password or result', async () => {
  await mount(withAutomation());
  await click(button('Edit'));
  await input(field('App password'), 'abcdefghijklmnop');
  let complete!: (value: Response) => void;
  response = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  await click(button('Test connection'));
  await click(button('Cancel'));
  assert.equal(requests[0].signal?.aborted, true);
  await act(async () => complete(Response.json({ ok: true })));
  await click(button('Edit'));
  assert.equal(field('App password').value, '');
  assert.equal(document.querySelector('[role="status"]'), null);
  assert.equal(mutations.length, 0);
});

test('mail-test errors use localized guidance instead of echoing transport details', async () => {
  await mount(withAutomation(), 'ja');
  await click(button('編集'));
  response = async () =>
    Response.json(
      { error: 'opaque transport data', code: 'authentication_failed' },
      { status: 400 },
    );
  await click(button('接続をテスト'));
  assert.match(
    document.querySelector('[role="alert"]')!.textContent!,
    /Googleで発行したアプリパスワード/,
  );
  assert.doesNotMatch(document.body.textContent!, /opaque transport data/);
});

test('credentialless drafts open setup before activation and can save disabled without a password', async () => {
  await mount(withAutomation(savedAutomation(false)));
  assert.equal(button('Run now').disabled, true);
  await click(toggle('Off'));
  assert.equal(
    mutations.length,
    0,
    'activation opens setup instead of requesting an invalid enable',
  );
  assert.equal(field('App password').required, false);
  assert.match(document.body.textContent!, /save a disabled draft without a password/);
  await click(button('Save automation'));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].method, 'PATCH');
  assert.equal(mutations[0].body.enabled, false);
  assert.equal(Object.hasOwn(mutations[0].body.imap, 'password'), false);
  assert.equal(requests.length, 0);
});

test('enabling a credentialless draft requires a password and Network Deny blocks only its test button', async () => {
  const state = withAutomation(savedAutomation(false));
  state.settings.permissions.network = 'deny';
  await mount(state);
  await click(button('Set up connection'));
  await click(toggle('Enable after saving'));
  assert.equal(field('App password').required, true);
  assert.equal(document.querySelector('form')!.checkValidity(), false);
  await click(button('Save automation'));
  assert.equal(mutations.length, 0);
  await input(field('App password'), 'abcdefghijklmnop');
  assert.equal(button('Test connection').disabled, true);
  assert.match(document.body.textContent!, /Network access is denied/);
});

after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});

test('connected mail accounts save a provider-neutral watcher without asking for inline credentials', async () => {
  const data = fixture();
  data.mailAccounts = [
    {
      id: 'mail_assigned',
      name: 'Aster inbox',
      address: 'aster@example.test',
      provider: 'agentmail',
      enabled: true,
      botIds: ['bot_aster'],
      sendPolicy: 'ask',
      api: { inboxId: 'inbox', apiKeyConfigured: true },
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'mail_unassigned',
      name: 'Unassigned',
      address: 'other@example.test',
      provider: 'resend',
      enabled: true,
      botIds: [],
      sendPolicy: 'ask',
      api: { inboxId: 'other', apiKeyConfigured: true },
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];
  await mount(data);
  await click(button('New automation'));
  await choose(field<HTMLSelectElement>('Trigger'), 'imap');
  const selector = field<HTMLSelectElement>('Mail account');
  assert.equal(selector.value, 'mail_assigned');
  assert.equal(
    [...selector.options].some((item) => item.value === 'mail_unassigned'),
    false,
  );
  assert.equal(document.querySelector('input[type="password"]'), null);
  await input(field('Name'), 'Important incoming mail');
  await input(
    field<HTMLTextAreaElement>('Instructions'),
    'Read new mail and summarize actionable messages.',
  );
  await click(button('Save automation'));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].body.mailAccountId, 'mail_assigned');
  assert.equal(Object.hasOwn(mutations[0].body, 'imap'), false);
  assert.equal(requests.length, 0);
  data.automations = [{ ...savedAutomation(), imap: undefined, mailAccountId: 'mail_assigned' }];
  await mount(data);
  assert.equal(button('Run now').disabled, false);
  assert.doesNotMatch(document.body.textContent!, /Mail connection needs setup/);
  await click(button('Edit'));
  assert.equal(field<HTMLSelectElement>('Mail account').value, 'mail_assigned');
  await click(button('Manage mail accounts'));
  assert.equal(mutations.length, 0, 'navigation must not submit the editor form');
});
