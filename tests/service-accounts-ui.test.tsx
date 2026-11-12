import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { ServiceAccount } from '../src/shared/service-accounts';
import type { Snapshot } from '../src/shared/types';

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
const { ServiceAccountEditor, ServiceAccounts } = await import('../src/client/ServiceAccounts');

const secret = ' \tfixture-service-secret-<>&\nexact whitespace ';
const stamp = '2026-11-12T00:00:00.000Z';
function service(patch: Partial<ServiceAccount> = {}): ServiceAccount {
  return {
    id: 'service_one',
    name: 'Fixture service',
    url: 'https://service.example/login',
    login: 'bot@example.test',
    botId: 'bot_aster',
    mailAccountId: null,
    status: 'active',
    notes: '',
    credentialConfigured: true,
    revision: 4,
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
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
        contextWindow: 32768,
        maxOutputTokens: 4096,
        temperature: 0.5,
      },
      demoMode: false,
      autoLearn: false,
      maxHandoffs: 6,
      workspacePath: '/tmp/loom',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: [
      {
        id: 'bot_aster',
        name: 'Aster',
        handle: 'aster',
        role: 'Research',
        systemPrompt: 'Synthetic bot.',
        avatar: 'sparkles',
        color: '#829479',
        enabled: true,
        createdAt: stamp,
      },
      {
        id: 'bot_nova',
        name: 'Nova',
        handle: 'nova',
        role: 'Writing',
        systemPrompt: 'Synthetic bot.',
        avatar: 'sparkles',
        color: '#829479',
        enabled: true,
        createdAt: stamp,
      },
      {
        id: 'bot_cedar',
        name: 'Cedar',
        handle: 'cedar',
        role: 'Design',
        systemPrompt: 'Synthetic bot.',
        avatar: 'sparkles',
        color: '#829479',
        enabled: false,
        createdAt: stamp,
      },
    ],
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
    serviceAccounts: [service()],
  };
}
type Request = { path: string; method: string; body: any; signal?: AbortSignal | null };
let root: ReturnType<typeof createRoot> | undefined;
let context: AppContextValue;
let edited: ServiceAccount | undefined;
let open = true;
let respond: ((request: Request) => Promise<Response>) | undefined;
const requests: Request[] = [];
const copied: string[] = [];
function result(request: Request) {
  return Response.json({
    accountId: decodeURIComponent(request.path.split('/')[3]),
    revision: request.body.expectedRevision,
    credential: secret,
  });
}
Object.assign(globalThis, {
  fetch: async (path: string, options: RequestInit = {}) => {
    const request = {
      path,
      method: options.method || 'GET',
      body: options.body ? JSON.parse(String(options.body)) : undefined,
      signal: options.signal,
    };
    requests.push(request);
    return respond ? respond(request) : result(request);
  },
});
async function render() {
  await act(async () =>
    root!.render(
      <AppContext.Provider value={{ ...context }}>
        {open && (
          <ServiceAccountEditor
            key={edited?.id || 'new'}
            account={edited}
            onClose={() => {
              open = false;
              void render();
            }}
          />
        )}
      </AppContext.Provider>,
    ),
  );
}
async function mount(account: ServiceAccount | null = service()) {
  if (root) await act(async () => root!.unmount());
  requests.length = 0;
  copied.length = 0;
  respond = undefined;
  open = true;
  edited = account || undefined;
  localStorage.clear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(value: string) {
        copied.push(value);
      },
    },
  });
  context = {
    data: fixture(),
    connected: true,
    locale: 'en',
    t: (_ja, en) => en,
    view: 'accounts',
    roomId: '',
    navigate() {},
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>() {
      return {} as T;
    },
  };
  context.data.serviceAccounts = account ? [account] : [];
  root = createRoot(document.getElementById('root')!);
  await render();
  await section(true);
}
async function section(value: boolean) {
  await act(async () => {
    const details = document.querySelector('details')!;
    details.open = value;
    details.dispatchEvent(new Event('toggle'));
  });
}
function button(label: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label,
  );
  assert.ok(element, `Missing button: ${label}`);
  return element;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function value() {
  return document.querySelector<HTMLTextAreaElement>('[data-service-credential-value]')?.value;
}
function field<T extends HTMLInputElement | HTMLSelectElement>(label: string): T {
  const container = [...document.querySelectorAll('label.field')].find(
    (item) => item.querySelector('.field-label')?.textContent === label,
  );
  const element = container?.querySelector<T>('input, select');
  assert.ok(element, `Missing field: ${label}`);
  return element;
}
async function input(label: string, value: string) {
  const element = field<HTMLInputElement>(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(label: string, value: string) {
  const element = field<HTMLSelectElement>(label);
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function sharedBot(name: string) {
  const element = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (item) => item.getAttribute('aria-label') === `Share with ${name}`,
  );
  assert.ok(element, `Missing shared bot: ${name}`);
  return element;
}
async function share(name: string) {
  await act(async () => sharedBot(name).click());
}
after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});

test('service registration selects several shared bots explicitly, including a clearly marked disabled bot', async () => {
  await mount(null);
  await input('Service name', 'Shared fixture');
  await input('Service URL', 'https://shared.example/login');
  await input('Login name', 'shared@example.test');
  await choose('Managing bot', 'bot_aster');
  assert.equal(document.querySelector('input[aria-label="Share with Aster"]'), null);
  assert.equal(sharedBot('Nova').checked, false);
  assert.equal(sharedBot('Cedar').checked, false);
  assert.equal(sharedBot('Cedar').disabled, false);
  assert.match(sharedBot('Cedar').closest('label')!.textContent!, /Disabled/);
  assert.match(document.body.textContent!, /after they are enabled/);
  await share('Nova');
  await share('Cedar');
  await input('Password or API key', 'new-registration-secret');
  assert.equal(requests.length, 0, 'selecting access never requests saved credentials');
  await click('Save service');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/service-accounts');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, {
    name: 'Shared fixture',
    url: 'https://shared.example/login',
    login: 'shared@example.test',
    botId: 'bot_aster',
    sharedBotIds: ['bot_nova', 'bot_cedar'],
    mailAccountId: null,
    status: 'pending',
    notes: '',
    credential: 'new-registration-secret',
  });
});

test('legacy services start private to their manager and editing sharing preserves saved credentials', async () => {
  await mount();
  assert.equal(sharedBot('Nova').checked, false);
  assert.equal(sharedBot('Cedar').checked, false);
  await share('Nova');
  await share('Cedar');
  assert.equal(requests.length, 0);
  await click('Save service');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'PUT');
  assert.equal(requests[0].body.botId, 'bot_aster');
  assert.deepEqual(requests[0].body.sharedBotIds, ['bot_nova', 'bot_cedar']);
  assert.equal(requests[0].body.expectedRevision, 4);
  assert.equal(Object.hasOwn(requests[0].body, 'credential'), false);

  await mount();
  await click('Save service');
  assert.deepEqual(requests[0].body.sharedBotIds, [], 'opening and saving grants no new access');
});

test('editing existing shares can revoke every shared bot without removing the manager or credential', async () => {
  await mount(service({ sharedBotIds: ['bot_nova', 'bot_cedar'] }));
  assert.equal(sharedBot('Nova').checked, true);
  assert.equal(sharedBot('Cedar').checked, true);
  await share('Nova');
  await share('Cedar');
  await click('Save service');
  assert.deepEqual(requests[0].body.sharedBotIds, []);
  assert.equal(requests[0].body.botId, 'bot_aster');
  assert.equal(Object.hasOwn(requests[0].body, 'credential'), false);
});

test('changing the managing bot deduplicates its share and does not grant the old manager access', async () => {
  await mount(service({ sharedBotIds: ['bot_nova', 'bot_cedar'] }));
  await choose('Managing bot', 'bot_nova');
  assert.equal(document.querySelector('input[aria-label="Share with Nova"]'), null);
  assert.equal(sharedBot('Aster').checked, false);
  assert.equal(sharedBot('Cedar').checked, true);
  await click('Save service');
  assert.equal(requests[0].body.botId, 'bot_nova');
  assert.deepEqual(requests[0].body.sharedBotIds, ['bot_cedar']);
  assert.equal(Object.hasOwn(requests[0].body, 'credential'), false);

  await mount(service({ sharedBotIds: ['bot_nova', 'bot_cedar'] }));
  await choose('Managing bot', '');
  assert.equal(sharedBot('Aster').checked, false);
  assert.equal(sharedBot('Nova').checked, true);
  await click('Save service');
  assert.equal(requests[0].body.botId, null);
  assert.deepEqual(requests[0].body.sharedBotIds, ['bot_nova', 'bot_cedar']);
});

test('sharing and manager drafts preserve explicit credential reads and an entered replacement separately', async () => {
  await mount();
  await click('Show saved credential');
  await input('Password or API key', 'explicit-replacement');
  await share('Nova');
  await choose('Managing bot', 'bot_cedar');
  assert.equal(value(), secret);
  assert.equal(field<HTMLInputElement>('Password or API key').value, 'explicit-replacement');
  assert.equal(requests.length, 1);
  await click('Copy saved credential');
  assert.deepEqual(copied, [secret]);
  assert.deepEqual(
    requests.slice(0, 2).map((request) => request.body),
    [{ expectedRevision: 4 }, { expectedRevision: 4 }],
  );
  assert.equal(sharedBot('Aster').checked, false);
  assert.equal(sharedBot('Nova').checked, true);
  await click('Save service');
  assert.equal(requests.length, 3);
  assert.equal(requests[2].body.credential, 'explicit-replacement');
  assert.deepEqual(requests[2].body.sharedBotIds, ['bot_nova']);
  assert.equal(value(), undefined);
});

test('service sharing leaves mailbox permissions separate and validates only the managing bot', async () => {
  await mount(service({ mailAccountId: 'mail_one' }));
  context.data.mailAccounts = [
    {
      id: 'mail_one',
      name: 'Aster mail',
      address: 'aster@example.test',
      provider: 'agentmail',
      enabled: true,
      botIds: ['bot_aster'],
      sendPolicy: 'ask',
      api: { inboxId: 'fixture-inbox', apiKeyConfigured: true },
      revision: 2,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];
  await render();
  await share('Nova');
  await share('Cedar');
  assert.equal(button('Save service').disabled, false);
  assert.deepEqual(context.data.mailAccounts[0].botIds, ['bot_aster']);
  assert.match(document.body.textContent!, /Email permissions are configured separately/);
  await choose('Managing bot', 'bot_nova');
  assert.equal(button('Save service').disabled, true);
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /managing bot/);
  await choose('Managing bot', 'bot_aster');
  assert.equal(button('Save service').disabled, false);
  await click('Save service');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/service-accounts/service_one');
  assert.equal(requests[0].body.mailAccountId, 'mail_one');
  assert.deepEqual(requests[0].body.sharedBotIds, ['bot_cedar']);
  assert.deepEqual(context.data.mailAccounts[0].botIds, ['bot_aster']);
});

test('service cards identify manager and shared bots without repeating the manager', async () => {
  await mount(service({ sharedBotIds: ['bot_aster', 'bot_nova', 'bot_cedar', 'bot_nova'] }));
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        <ServiceAccounts editor={null} onEdit={() => {}} />
      </AppContext.Provider>,
    ),
  );
  const details = [...document.querySelectorAll('.service-card-details dt')];
  assert.equal(
    details.find((item) => item.textContent === 'Managing bot')?.nextElementSibling?.textContent,
    'Aster',
  );
  assert.equal(
    details.find((item) => item.textContent === 'Shared bots')?.nextElementSibling?.textContent,
    'Nova, Cedar',
  );
  assert.equal(requests.length, 0);
});

test('saved service credentials are fetched only for show/copy, preserve bytes, and never populate the replacement input', async () => {
  await mount();
  assert.equal(requests.length, 0);
  assert.equal(value(), undefined);
  await click('Show saved credential');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, { expectedRevision: 4 });
  assert.equal(value(), secret);
  assert.equal(document.querySelector<HTMLInputElement>('input[type="password"]')!.value, '');
  assert.equal(
    document.querySelector('[data-service-credential-value]')?.getAttribute('readonly'),
    '',
  );
  await click('Hide saved credential');
  assert.equal(value(), undefined);
  await click('Copy saved credential');
  assert.deepEqual(copied, [secret]);
  assert.equal(requests.length, 2);
  assert.equal(value(), undefined);
  assert.equal(document.querySelector('[role="status"]')?.textContent, 'Copied');
  assert.equal(document.body.textContent!.includes('fixture-service-secret'), false);
  assert.equal(JSON.stringify(context.data).includes('fixture-service-secret'), false);
  assert.equal(
    Object.values(localStorage).some((item) => String(item).includes(secret)),
    false,
  );
});

test('unsupported and denied clipboard writes reveal a selectable fallback without leaking their errors', async () => {
  for (const clipboard of [
    undefined,
    {
      async writeText() {
        throw new Error(secret);
      },
    },
  ]) {
    await mount();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    await click('Copy saved credential');
    assert.equal(value(), secret);
    const alert = document.querySelector('[role="alert"]')!.textContent!;
    assert.match(alert, /copy it manually/);
    assert.equal(alert.includes('fixture-service-secret'), false);
    assert.equal(document.querySelector('[role="status"]'), null);
    const field = document.querySelector<HTMLTextAreaElement>('[data-service-credential-value]')!;
    await act(async () => field.focus());
    assert.equal(field.selectionStart, 0);
    assert.equal(field.selectionEnd, secret.length);
  }
});

test('closing, collapsing, identity changes, service revisions, deletion and disconnection discard pending reads', async () => {
  const changes = [
    async () => {
      open = false;
      await render();
    },
    async () => section(false),
    async () => input('Login name', 'changed@example.test'),
    async () => input('Service URL', 'https://other.example/login'),
    async () => {
      context.data = { ...context.data, serviceAccounts: [service({ revision: 5 })] };
      await render();
    },
    async () => {
      context.data = { ...context.data, serviceAccounts: [] };
      await render();
    },
    async () => {
      context.connected = false;
      await render();
    },
  ];
  for (const change of changes) {
    await mount();
    let resolve!: (response: Response) => void;
    respond = () =>
      new Promise((done) => {
        resolve = done;
      });
    await click('Copy saved credential');
    const pending = requests[0];
    await change();
    assert.equal(pending.signal?.aborted, true);
    await act(async () => resolve(result(pending)));
    assert.equal(value(), undefined);
    assert.deepEqual(copied, []);
    assert.equal(document.querySelector('[role="status"]'), null);
  }
});

test('hiding and returning to the same identity require another explicit read', async () => {
  await mount();
  await click('Show saved credential');
  await input('Login name', 'changed@example.test');
  assert.equal(value(), undefined);
  await input('Login name', 'bot@example.test');
  assert.equal(value(), undefined);
  assert.equal(requests.length, 1);
  await click('Show saved credential');
  assert.equal(requests.length, 2);
  await section(false);
  await section(true);
  assert.equal(value(), undefined);
  assert.equal(requests.length, 2);
});

test('displayed credentials clear after one minute and when the page becomes hidden', async (t) => {
  await mount();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await click('Show saved credential');
  assert.equal(value(), secret);
  await act(async () => t.mock.timers.tick(60_000));
  assert.equal(value(), undefined);
  t.mock.timers.reset();
  await click('Show saved credential');
  const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  try {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(value(), undefined);
  } finally {
    if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
    else Reflect.deleteProperty(document, 'visibilityState');
  }
});

test('late clipboard results after a close do not reopen credentials or claim success', async () => {
  await mount();
  let reject!: (error: Error) => void;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    },
  });
  await click('Copy saved credential');
  open = false;
  await render();
  await act(async () => reject(new Error(secret)));
  open = true;
  await render();
  await section(true);
  assert.equal(value(), undefined);
  assert.equal(document.querySelector('[role="status"]'), null);
  assert.equal(document.querySelector('[role="alert"]'), null);
});

test('failed and mismatched credential responses leave no secret or misleading copy success', async () => {
  for (const response of [
    Response.json({ error: secret }, { status: 401 }),
    Response.json({ error: secret }, { status: 409 }),
    Response.json({ error: secret }, { status: 404 }),
    Response.json({ accountId: 'other_service', revision: 4, credential: secret }),
  ]) {
    await mount();
    respond = async () => response;
    await click('Copy saved credential');
    assert.equal(value(), undefined);
    assert.deepEqual(copied, []);
    assert.equal(
      document.querySelector('[role="alert"]')!.textContent!.includes('fixture-service-secret'),
      false,
    );
    assert.equal(document.querySelector('[role="status"]'), null);
  }
});
