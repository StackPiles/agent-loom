import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ReactNode } from 'react';
import type { Snapshot } from '../src/shared/types';
import type { MailAccount, MailDraft, MailMessage } from '../src/shared/mail-accounts';
import type { AppContextValue } from '../src/client/context';

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
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: (dom.window as unknown as Record<string, unknown>)[name],
  });
}
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
const { AccountsPage } = await import('../src/client/AccountsPage');
const { MailAccountEditor } = await import('../src/client/MailAccountEditor');
const { MailComposer, MailMessageDialog, MailPanel } = await import('../src/client/MailPanel');
const { ServiceAccountEditor } = await import('../src/client/ServiceAccounts');
const stamp = '2026-11-01T00:00:00.000Z';

function account(id = 'mail_one'): MailAccount {
  return {
    id,
    name: id === 'mail_one' ? 'Aster mail' : 'Nova mail',
    address: id === 'mail_one' ? 'aster@example.com' : 'nova@example.com',
    provider: 'imap',
    enabled: true,
    botIds: ['bot_aster'],
    sendPolicy: 'ask',
    revision: 4,
    createdAt: stamp,
    updatedAt: stamp,
    imap: {
      host: 'imap.example.com',
      port: 993,
      secure: true,
      user: 'aster@example.com',
      mailbox: 'INBOX',
      passwordConfigured: true,
    },
    smtp: {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'aster@example.com',
      passwordConfigured: true,
    },
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
        systemPrompt: 'Research carefully.',
        avatar: 'character:aster',
        color: '#829479',
        enabled: true,
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
    mailAccounts: [account()],
    serviceAccounts: [],
  };
}
function savedDraft(overrides: Partial<MailDraft> = {}): MailDraft {
  return {
    id: 'draft_one',
    accountId: 'mail_one',
    accountRevision: 4,
    revision: 1,
    from: 'aster@example.com',
    to: ['friend@example.com'],
    cc: [],
    bcc: [],
    subject: 'Reviewed subject',
    text: 'Reviewed body',
    status: 'draft',
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}
function message(id = 'message_one', accountId = 'mail_one'): MailMessage {
  return {
    id,
    accountId,
    folder: 'INBOX',
    subject: id,
    from: [{ address: 'sender@example.com' }],
    to: [{ address: 'aster@example.com' }],
    date: stamp,
    text: 'Message body',
    truncated: false,
  };
}
type Request = { path: string; method: string; body: any; signal?: AbortSignal | null };
const requests: Request[] = [];
let respond: ((request: Request) => Promise<Response>) | undefined;
let root: ReturnType<typeof createRoot> | undefined;
let closed = 0;
Object.assign(globalThis, {
  fetch: async (path: string, init: RequestInit = {}) => {
    const request = {
      path,
      method: init.method || 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      signal: init.signal,
    };
    requests.push(request);
    if (respond) return respond(request);
    if (path.endsWith('/test'))
      return Response.json({
        ok: true,
        provider: 'imap',
        address: 'aster@example.com',
        receive: true,
        send: true,
      });
    if (path.includes('/messages?')) return Response.json({ messages: [] });
    if (path.includes('/mail/drafts?')) return Response.json([]);
    return Response.json({});
  },
});
async function mount(
  element: ReactNode,
  data = fixture(),
  locale: 'ja' | 'en' = 'en',
  responder?: typeof respond,
) {
  if (root) await act(async () => root!.unmount());
  requests.length = 0;
  respond = responder;
  closed = 0;
  localStorage.clear();
  const context: AppContextValue = {
    data,
    locale,
    t: (ja, en) => (locale === 'ja' ? ja : en),
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
  root = createRoot(document.getElementById('root')!);
  await act(async () =>
    root!.render(<AppContext.Provider value={context}>{element}</AppContext.Provider>),
  );
}
function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  assert.ok(result, 'Missing button: ' + label);
  return result;
}
function field<
  T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement = HTMLInputElement,
>(label: string): T {
  const container = [...document.querySelectorAll('label.field')].find(
    (item) => item.querySelector('.field-label')?.textContent === label,
  );
  const result = container?.querySelector('input,select,textarea');
  assert.ok(result, 'Missing field: ' + label);
  return result as T;
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
after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});

test('mail account identity changes clear entered credentials and never send saved secrets to a different endpoint', async () => {
  await mount(<MailAccountEditor account={account()} onClose={() => closed++} />);
  assert.equal(field('IMAP password').value, '');
  assert.equal(field('IMAP password').required, false);
  await input(field('IMAP password'), 'private-imap-secret');
  await input(field('SMTP password'), 'private-smtp-secret');
  await input(field('IMAP host'), 'new.example.com');
  assert.equal(field('IMAP password').value, '');
  assert.equal(field('IMAP password').required, true);
  assert.equal(field('SMTP password').value, 'private-smtp-secret');
  await input(field('Email address'), 'another@example.com');
  assert.equal(field('SMTP password').value, '');
  assert.equal(field('SMTP password').required, true);
  assert.equal(button('Test connection').disabled, true);
  await choose(field<HTMLSelectElement>('Connection type'), 'agentmail');
  await input(field('Inbox ID'), 'inbox_first');
  await input(field('API key'), 'private-api-key');
  await input(field('Inbox ID'), 'inbox_second');
  assert.equal(field('API key').value, '');
  assert.equal(button('Test connection').disabled, true);
  assert.equal(requests.length, 0);
});

test('editing account settings aborts a connection test and suppresses its late success', async () => {
  await mount(<MailAccountEditor account={account()} onClose={() => closed++} />);
  let complete!: (response: Response) => void;
  respond = async () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  await click(button('Test connection'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.existingId, 'mail_one');
  assert.equal(Object.hasOwn(requests[0].body.input.imap, 'password'), false);
  await input(field('Receiving folder'), 'Projects');
  assert.equal(requests[0].signal?.aborted, true);
  await act(async () => complete(Response.json({ ok: true, send: true })));
  assert.equal(document.querySelector('[role="status"]'), null);
  assert.equal(button('Test connection').disabled, false);
  respond = undefined;
  await click(button('Test connection'));
  assert.equal(requests[1].body.input.imap.mailbox, 'Projects');
  assert.match(document.querySelector('[role="status"]')!.textContent!, /No email was sent/);
});

test('dismissing the account editor aborts its test and clears unsaved credentials on reopen', async () => {
  await mount(<AccountsPage />);
  await click(button('Edit Aster mail'));
  await input(field('IMAP password'), 'unsaved-secret');
  let complete!: (response: Response) => void;
  respond = async () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  await click(button('Test connection'));
  const pending = requests.at(-1)!;
  const dialog = document.querySelector('dialog')!;
  dialog.getBoundingClientRect = () => ({
    left: 100,
    top: 100,
    right: 600,
    bottom: 600,
    width: 500,
    height: 500,
    x: 100,
    y: 100,
    toJSON() {},
  });
  await act(async () =>
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 20 })),
  );
  assert.equal(document.querySelector('dialog'), null);
  assert.equal(pending.signal?.aborted, true);
  await act(async () => complete(Response.json({ ok: true, send: true })));
  respond = undefined;
  await click(button('Edit Aster mail'));
  assert.equal(field('IMAP password').value, '');
  assert.equal(document.querySelector('[role="status"]'), null);
  assert.equal(
    Object.values(localStorage).some((value) => String(value).includes('unsaved-secret')),
    false,
  );
});

test('switching mail accounts aborts an old inbox request and ignores its late response', async () => {
  const data = fixture();
  data.mailAccounts = [account(), account('mail_two')];
  await mount(<AccountsPage />, data);
  let complete!: (response: Response) => void;
  respond = async (request) =>
    request.path.includes('/mail_one/')
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : Response.json({ messages: [message('Nova latest email', 'mail_two')] });
  await click(button('Refresh'));
  const stale = requests.at(-1)!;
  await click(button('Open email for Nova mail'));
  assert.equal(stale.signal?.aborted, true);
  assert.match(document.querySelector('.mail-message-list')!.textContent!, /Nova latest email/);
  await act(async () => complete(Response.json({ messages: [message('Aster stale email')] })));
  assert.doesNotMatch(
    document.querySelector('.mail-message-list')!.textContent!,
    /Aster stale email/,
  );
  assert.match(document.querySelector('.mail-panel-address')!.textContent!, /nova@example.com/);
});

test('email review shows the saved recipients and body, blocks duplicate sends, and offers no resend after an uncertain result', async () => {
  await mount(<MailComposer account={account()} onClose={() => closed++} onChanged={() => {}} />);
  await input(field('To'), 'friend@example.com, second@example.com');
  await input(field('Cc'), 'copy@example.com');
  await input(field('Bcc'), 'private@example.com');
  await input(field('Subject'), 'Exact subject');
  await input(field<HTMLTextAreaElement>('Message'), 'First line\nSecond <line>');
  let reviewed = savedDraft();
  let complete!: (response: Response) => void;
  respond = async (request) => {
    if (request.path.endsWith('/send'))
      return new Promise((resolve) => {
        complete = resolve;
      });
    if (request.path.includes('/drafts?'))
      return Response.json([{ ...reviewed, status: 'unknown' }]);
    reviewed = savedDraft({ ...request.body });
    return Response.json(reviewed);
  };
  await click(button('Review email'));
  assert.deepEqual(reviewed.to, ['friend@example.com', 'second@example.com']);
  assert.equal(
    document.querySelector('.mail-plain-text')!.textContent,
    'First line\nSecond <line>',
  );
  const review = document.querySelector('.mail-review')!.textContent!;
  for (const value of [
    'aster@example.com',
    'friend@example.com, second@example.com',
    'copy@example.com',
    'private@example.com',
    'Exact subject',
  ])
    assert.ok(review.includes(value));
  const send = button('Send this email');
  // HTTP LAN origins do not have randomUUID; secure randomness must still work.
  const uuidDescriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  try {
    await act(async () => {
      send.click();
      send.click();
    });
  } finally {
    if (uuidDescriptor) Object.defineProperty(crypto, 'randomUUID', uuidDescriptor);
    else Reflect.deleteProperty(crypto, 'randomUUID');
  }
  assert.equal(requests.filter((item) => item.path.endsWith('/send')).length, 1);
  const payload = requests.at(-1)!.body;
  assert.match(
    payload.requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(payload.expectedRevision, 1);
  assert.equal(payload.expectedAccountRevision, 4);
  assert.equal(button('Sending…').disabled, true);
  await act(async () => complete(Response.json({ ...reviewed, status: 'unknown' })));
  assert.match(document.querySelector('[role="status"]')!.textContent!, /result is uncertain/);
  assert.equal(
    [...document.querySelectorAll('button')].some((item) => item.textContent === 'Send this email'),
    false,
  );
  await click(button('Check status'));
  assert.equal(requests.filter((item) => item.path.endsWith('/send')).length, 1);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /will not resend/);
});

test('a lost send response stays uncertain until a status check confirms provider acceptance', async () => {
  const draft = savedDraft();
  await mount(
    <MailComposer
      account={account()}
      initial={draft}
      onClose={() => closed++}
      onChanged={() => {}}
    />,
  );
  respond = async (request) => {
    if (request.path.endsWith('/send')) throw new TypeError('Failed to fetch');
    if (request.path.includes('/drafts?')) return Response.json([{ ...draft, status: 'sent' }]);
    return Response.json(draft);
  };
  await click(button('Review email'));
  await click(button('Send this email'));
  assert.match(document.querySelector('[role="status"]')!.textContent!, /result is uncertain/);
  await click(button('Check status'));
  assert.match(document.querySelector('[role="status"]')!.textContent!, /provider accepted/);
  assert.equal(requests.filter((item) => item.path.endsWith('/send')).length, 1);
  assert.equal(
    [...document.querySelectorAll('button')].some((item) => item.textContent === 'Check status'),
    false,
  );
});

test('mail details display untrusted markup as plain text without tracking images and encode opaque message IDs', async () => {
  const mail = {
    ...message('INBOX/uid:42'),
    text: '<img src="https://tracker.invalid/pixel"><script>danger()</script>',
    attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', size: 1024 }],
  };
  let replied: MailMessage | undefined;
  await mount(
    <MailMessageDialog
      account={account()}
      summary={mail}
      onClose={() => closed++}
      onReply={(value) => {
        replied = value;
      }}
    />,
    fixture(),
    'en',
    async () => Response.json(mail),
  );
  assert.equal(requests[0].path, '/api/mail/accounts/mail_one/messages/INBOX%2Fuid%3A42');
  assert.equal(document.querySelector('.mail-plain-text')!.textContent, mail.text);
  assert.equal(document.querySelector('dialog img, dialog script, dialog iframe'), null);
  assert.match(document.querySelector('.mail-attachment-list')!.textContent!, /invoice.pdf/);
  await click(button('Reply'));
  assert.equal(replied?.id, mail.id);
});

test('service account identity changes clear unsaved secrets and explicit removal sends an empty credential', async () => {
  const service = {
    id: 'service_one',
    name: 'Example',
    url: 'https://example.com',
    login: 'aster',
    botId: 'bot_aster',
    mailAccountId: 'mail_one',
    status: 'active' as const,
    notes: '',
    credentialConfigured: true,
    revision: 2,
    createdAt: stamp,
    updatedAt: stamp,
  };
  await mount(<ServiceAccountEditor account={service} onClose={() => closed++} />);
  assert.equal(field('Password or API key').value, '');
  await input(field('Password or API key'), 'entered-secret');
  await input(field('Service URL'), 'https://different.example.com');
  assert.equal(field('Password or API key').value, '');
  await input(field('Password or API key'), 'another-secret');
  await input(field('Login name'), 'nova');
  assert.equal(field('Password or API key').value, '');
  await click(document.querySelector('.account-clear-credential input')!);
  await click(button('Save service'));
  assert.equal(requests[0].path, '/api/service-accounts/service_one');
  assert.equal(requests[0].body.credential, '');
  assert.equal(requests[0].body.expectedRevision, 2);
  assert.equal(closed, 1);
});

test('service assignments exclude mailboxes owned by other bots and block stale combinations', async () => {
  const data = fixture();
  data.bots.push({ ...data.bots[0], id: 'bot_nova', name: 'Nova', handle: 'nova' });
  const service = {
    id: 'service_one',
    name: 'Example',
    url: 'https://example.com',
    login: 'aster',
    botId: 'bot_aster',
    mailAccountId: 'mail_one',
    status: 'active' as const,
    notes: '',
    credentialConfigured: false,
    revision: 2,
    createdAt: stamp,
    updatedAt: stamp,
  };
  await mount(<ServiceAccountEditor account={service} onClose={() => closed++} />, data);
  await choose(field<HTMLSelectElement>('Assigned bot'), 'bot_nova');
  const mail = field<HTMLSelectElement>('Registered email account');
  assert.equal(mail.querySelector<HTMLOptionElement>('option[value="mail_one"]')!.disabled, true);
  assert.equal(button('Save service').disabled, true);
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /Assign the selected email/);
  await choose(mail, '');
  assert.equal(button('Save service').disabled, false);
});

test('failed send attempts stay immutable in the result view and disabled connections cannot save drafts', async () => {
  await mount(
    <MailComposer
      account={account()}
      initial={savedDraft({ status: 'failed' })}
      onClose={() => closed++}
      onChanged={() => {}}
    />,
  );
  assert.equal(document.querySelector('form'), null);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Sending did not complete/);
  assert.equal(requests.length, 0);
  await mount(
    <MailComposer
      account={{ ...account(), enabled: false }}
      initial={savedDraft()}
      onClose={() => closed++}
      onChanged={() => {}}
    />,
  );
  assert.equal(button('Save draft').disabled, true);
  assert.equal(button('Review email').disabled, true);
  assert.match(document.body.textContent!, /Enable it to edit or send email/);
});

test('a late mail save cannot dismiss a newly opened editor or replace its selected account', async () => {
  const data = fixture();
  data.mailAccounts = [account(), account('mail_two')];
  await mount(<AccountsPage />, data);
  await click(button('Edit Aster mail'));
  let complete!: (response: Response) => void;
  respond = async (request) =>
    request.method === 'PUT'
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : Response.json({ messages: [] });
  await click(button('Save connection'));
  await click(button('Cancel'));
  await click(button('Edit Nova mail'));
  await input(field('IMAP password'), 'fresh-editor-secret');
  await act(async () => complete(Response.json(account())));
  assert.equal(field('Email address').value, 'nova@example.com');
  assert.equal(field('IMAP password').value, 'fresh-editor-secret');
});

test('a late service save cannot dismiss a newly opened service editor', async () => {
  const data = fixture();
  const service = {
    id: 'service_one',
    name: 'Example',
    url: 'https://example.com',
    login: 'aster',
    botId: 'bot_aster',
    mailAccountId: 'mail_one',
    status: 'active' as const,
    notes: '',
    credentialConfigured: false,
    revision: 2,
    createdAt: stamp,
    updatedAt: stamp,
  };
  data.serviceAccounts = [service, { ...service, id: 'service_two', name: 'Second service' }];
  await mount(<AccountsPage />, data);
  await click(document.getElementById('service-accounts-tab')!);
  await click(button('Edit Example'));
  let complete!: (response: Response) => void;
  respond = async () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  await click(button('Save service'));
  await click(button('Cancel'));
  await click(button('Edit Second service'));
  await input(field('Password or API key'), 'fresh-editor-secret');
  await act(async () => complete(Response.json(service)));
  assert.equal(field('Service name').value, 'Second service');
  assert.equal(field('Password or API key').value, 'fresh-editor-secret');
});

test('account disconnect and service removal are bound to the revision that was confirmed', async () => {
  const data = fixture();
  data.serviceAccounts = [
    {
      id: 'service_one',
      name: 'Example',
      url: 'https://example.com',
      login: 'aster',
      botId: 'bot_aster',
      mailAccountId: 'mail_one',
      status: 'active',
      notes: '',
      credentialConfigured: false,
      revision: 2,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];
  await mount(<AccountsPage />, data);
  await click(button('Disconnect Aster mail'));
  await click(button('Confirm'));
  assert.equal(
    requests.find((item) => item.method === 'DELETE')?.path,
    '/api/mail/accounts/mail_one?expectedRevision=4',
  );
  await click(document.getElementById('service-accounts-tab')!);
  await click(button('Remove Example'));
  await click(button('Confirm'));
  assert.equal(
    requests.filter((item) => item.method === 'DELETE').at(-1)?.path,
    '/api/service-accounts/service_one?expectedRevision=2',
  );
});

test('editing an account connection discards pagination cursors from its previous mailbox source', async () => {
  let update!: (value: MailAccount) => void;
  function CurrentPanel() {
    const [value, setValue] = React.useState(account());
    update = setValue;
    return <MailPanel account={value} />;
  }
  await mount(<CurrentPanel />, fixture(), 'en', async () =>
    Response.json({ messages: [], nextCursor: 'old-source-cursor' }),
  );
  await click(button('Next'));
  assert.match(requests.at(-1)!.path, /cursor=old-source-cursor/);
  const before = requests.length;
  await act(async () =>
    update({ ...account(), revision: 5, imap: { ...account().imap!, mailbox: 'Projects' } }),
  );
  assert.equal(requests.length - before, 1);
  assert.doesNotMatch(requests.at(-1)!.path, /cursor=/);
});
