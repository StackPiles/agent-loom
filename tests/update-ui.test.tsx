import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import type { AppContextValue, Locale, View } from '../src/client/context';
import type { Snapshot } from '../src/shared/types';
import type { UpdateInfo, UpdateJob } from '../src/shared/updates';

// All update endpoints are synthetic. No repository, server process, or dependency is updated.
const browserErrors: Error[] = [];
const console = new VirtualConsole();
console.on('jsdomError', (error) => browserErrors.push(error));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3210',
  pretendToBeVisual: true,
  virtualConsole: console,
});
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Event'])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: (dom.window as unknown as Record<string, unknown>)[name],
  });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('../src/client/context');
const { AppUpdateProvider, UpdateNotice, UpdateSettings } =
  await import('../src/client/UpdateSettings');

const previousSha = 'a'.repeat(40);
const targetSha = 'b'.repeat(40);
const savedRequestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RECEIPT_KEY = 'loom.updateRequest';
function fixture(): UpdateInfo {
  return {
    current: { version: '0.6.0', commit: previousSha },
    latest: {
      version: '0.7.0',
      commit: targetSha,
      url: `https://github.com/StackPiles/agent-loom/commit/${targetSha}`,
      checks: 'passed',
      protocol: 1,
    },
    checkedAt: new Date().toISOString(),
    available: true,
    installation: { kind: 'managed-git', canUpdate: true },
  };
}
function job(id: string, phase: UpdateJob['phase'] = 'preparing'): UpdateJob {
  return {
    id,
    phase,
    targetSha,
    targetVersion: '0.7.0',
    previousSha,
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
interface RecordedRequest {
  path: string;
  method: string;
  body?: { force?: boolean; commit?: string; requestId?: string };
  signal?: AbortSignal | null;
}
const requests: RecordedRequest[] = [];
let info: UpdateInfo;
let offline = false;
let respond: (request: RecordedRequest) => Response | Promise<Response>;
function defaultResponse(request: RecordedRequest) {
  if (offline) throw new TypeError('Synthetic connection failure');
  if (request.path === '/api/updates' || request.path === '/api/updates/check')
    return Response.json(info);
  if (request.path === '/api/updates/install') {
    info = { ...info, job: job(request.body!.requestId!) };
    return Response.json(info.job, { status: 202 });
  }
  throw new Error(`Unexpected ${request.method} ${request.path}`);
}
Object.assign(globalThis, {
  fetch: async (path: string, init: RequestInit = {}) => {
    assert.match(path, /^\/api\/updates(?:\/|$)/);
    const request: RecordedRequest = {
      path,
      method: init.method || 'GET',
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      signal: init.signal,
    };
    requests.push(request);
    return respond(request);
  },
});
let root: ReturnType<typeof createRoot> | undefined;
let locale: Locale = 'en';
let pageVersion = '0.6.0';
let view: View = 'chat';
let unsaved = false;
let connected = true;
const navigation: string[] = [];
function tree() {
  const context: AppContextValue = {
    data: { version: pageVersion } as Snapshot,
    connected,
    locale,
    t: (ja, en) => (locale === 'ja' ? ja : en),
    view,
    roomId: '',
    navigate(next) {
      navigation.push(next);
      view = next;
      root!.render(tree());
    },
    async refresh() {},
    async mutate() {
      throw new Error('Checking for an app update must not mutate settings or tasks.');
    },
    toast() {},
    async signOut() {},
  };
  return (
    <AppContext.Provider value={context}>
      <AppUpdateProvider>
        <header className="topbar">
          <UpdateNotice />
        </header>
        <input aria-label="Unsent chat draft" defaultValue="Keep this draft" />
        <UpdateSettings hasChanges={unsaved} />
      </AppUpdateProvider>
    </AppContext.Provider>
  );
}
async function mount(
  options: {
    locale?: Locale;
    unsaved?: boolean;
    info?: UpdateInfo;
    respond?: typeof respond;
    receipt?: { id: string; commit: string };
    preserve?: boolean;
    strict?: boolean;
  } = {},
) {
  await unmount();
  locale = options.locale || 'en';
  unsaved = options.unsaved ?? false;
  pageVersion = options.info?.current.version || '0.6.0';
  view = 'chat';
  connected = true;
  navigation.length = 0;
  browserErrors.length = 0;
  requests.length = 0;
  if (!options.preserve) dom.window.sessionStorage.clear();
  if (options.receipt)
    dom.window.sessionStorage.setItem(RECEIPT_KEY, JSON.stringify(options.receipt));
  info = options.info ?? fixture();
  offline = false;
  respond = options.respond ?? defaultResponse;
  root = createRoot(document.getElementById('root')!);
  await act(async () =>
    root!.render(options.strict ? <React.StrictMode>{tree()}</React.StrictMode> : tree()),
  );
}
async function unmount() {
  if (!root) return;
  const previous = root;
  root = undefined;
  await act(async () => previous.unmount());
}
afterEach(unmount);
after(() => dom.window.close());
function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) =>
      element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
  );
  assert.ok(result, `Missing button: ${label}`);
  return result;
}
function installRequests() {
  return requests.filter((request) => request.path === '/api/updates/install');
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function focus() {
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
}
async function renderUnsaved(value: boolean) {
  unsaved = value;
  await act(async () => root!.render(tree()));
}

test('checks once, shows a compact update action, and opens the focused settings section', async () => {
  await mount();
  assert.deepEqual(
    requests.map((request) => [request.path, request.method]),
    [
      ['/api/updates', 'GET'],
      ['/api/updates/check', 'POST'],
    ],
  );
  assert.equal(requests[1].body?.force, false);
  assert.equal(installRequests().length, 0);
  assert.equal(document.querySelectorAll('.topbar .app-update-notice').length, 1);
  assert.match(document.querySelector('#app-updates')!.textContent!, /v0\.7\.0/);
  assert.equal(
    document.querySelector<HTMLAnchorElement>('.app-update-versions a')!.href,
    `https://github.com/StackPiles/agent-loom/commit/${targetSha}`,
  );
  await click(button('Agent Loom: Update available'));
  assert.deepEqual(navigation, ['settings']);
  assert.equal(document.activeElement?.id, 'app-updates');
});

test('same-version fixes are discoverable and unsaved settings block installation', async () => {
  const sameVersion = fixture();
  sameVersion.latest!.version = sameVersion.current.version;
  await mount({ info: sameVersion, unsaved: true });
  assert.match(document.body.textContent!, /A new revision of this version is available/);
  assert.equal(button('Update and restart').disabled, true);
  await click(button('Update and restart'));
  assert.equal(installRequests().length, 0);
  await renderUnsaved(false);
  assert.equal(button('Update and restart').disabled, false);
  await click(button('Update and restart'));
  assert.equal(installRequests().length, 1);
  assert.equal(installRequests()[0].body?.commit, targetSha);
  assert.match(installRequests()[0].body!.requestId!, /^[a-f0-9-]{36}$/);
  assert.match(document.body.textContent!, /Preparing the update/);
});

test('a pending or failed upstream check and an incompatible protocol cannot be installed', async () => {
  for (const checks of ['pending', 'failed', 'unknown'] as const) {
    const unavailable = fixture();
    unavailable.latest!.checks = checks;
    await mount({ info: unavailable });
    assert.equal(button('Update and restart').disabled, true, checks);
    await click(button('Update and restart'));
    assert.equal(installRequests().length, 0);
    assert.match(
      document.body.textContent!,
      checks === 'failed' ? /has not passed/ : /Waiting for the upstream checks/,
    );
  }
  const unsupported = fixture();
  unsupported.latest!.protocol = 2;
  await mount({ info: unsupported });
  assert.equal(button('Update and restart').disabled, true);
  assert.match(document.body.textContent!, /does not support updating from the web app/);
});

test('Docker and unsupported startup methods show manual instructions and no enabled update action', async () => {
  for (const kind of ['docker', 'git', 'development', 'standalone', 'managed-git'] as const) {
    const manual = fixture();
    manual.installation = { kind, canUpdate: false, reason: 'Synthetic installation reason.' };
    await mount({ info: manual });
    assert.equal(button('Update and restart').disabled, true, kind);
    assert.match(document.body.textContent!, /Synthetic installation reason/);
    if (kind === 'docker')
      assert.match(document.querySelector('pre')!.textContent!, /docker compose up --build -d/);
    if (kind === 'git' || kind === 'development')
      assert.match(document.querySelector('pre')!.textContent!, /npm start/);
    await click(button('Update and restart'));
    assert.equal(installRequests().length, 0);
  }
});

test('an offline check never claims the cached installation is up to date and can be checked again', async () => {
  const currentVersion = fixture();
  currentVersion.available = false;
  currentVersion.latest = { ...currentVersion.latest!, version: '0.6.0', commit: previousSha };
  await mount({
    info: currentVersion,
    respond(request) {
      if (request.path.endsWith('/check')) throw new TypeError('Synthetic network failure');
      return defaultResponse(request);
    },
  });
  assert.match(document.body.textContent!, /Updates could not be checked/);
  assert.doesNotMatch(document.body.textContent!, /You are on the current upstream version/);
  assert.ok(document.querySelector('[role="alert"]'));
  respond = defaultResponse;
  info = fixture();
  await click(button('Check for updates'));
  assert.equal(requests.at(-1)?.body?.force, true);
  assert.equal(button('Update and restart').disabled, false);
  assert.equal(installRequests().length, 0);
});

test('unknown revisions and an installed newer version are not labelled identical to upstream', async () => {
  const unknown = fixture();
  unknown.current = { version: '0.7.0' };
  unknown.available = false;
  await mount({ info: unknown });
  assert.match(document.body.textContent!, /cannot identify additional revisions/);
  assert.doesNotMatch(document.body.textContent!, /You are on the current upstream version/);
  const ahead = fixture();
  ahead.current = { version: '0.8.0', commit: previousSha };
  ahead.available = false;
  await mount({ info: ahead });
  assert.match(document.body.textContent!, /no applicable update/);
  assert.doesNotMatch(document.body.textContent!, /You are on the current upstream version/);
});

test('a rejected install displays the reason without stopping work or retrying it', async () => {
  await mount({
    respond(request) {
      if (request.path.endsWith('/install'))
        return Response.json(
          { code: 'update_unavailable', error: 'Finish active work before updating.' },
          { status: 409 },
        );
      return defaultResponse(request);
    },
  });
  await click(button('Update and restart'));
  assert.match(
    document.querySelector('[role="alert"]')!.textContent!,
    /Finish active work before updating/,
  );
  assert.equal(dom.window.sessionStorage.getItem(RECEIPT_KEY), null);
  assert.equal(installRequests().length, 1);
  await focus();
  assert.equal(installRequests().length, 1);
  assert.ok(requests.every((request) => request.path.startsWith('/api/updates')));
});

for (const language of ['ja', 'en'] as const)
  test(`a busy install explains operation completion and full pause in ${language} without repeating the server error`, async () => {
    const rawReason =
      'Wait for running tasks, generation, mail, and data transfers to finish before updating.';
    await mount({
      locale: language,
      respond(request) {
        if (request.path.endsWith('/install'))
          return Response.json({ code: 'update_busy', error: rawReason }, { status: 409 });
        return defaultResponse(request);
      },
    });
    const label = language === 'ja' ? '更新して再起動' : 'Update and restart';
    await click(button(label));
    const alert = document.querySelector('[role="alert"]')!;
    assert.match(
      alert.textContent!,
      language === 'ja'
        ? /生成・ツール実行.*メール送信.*データ転送/
        : /Generation, tools, mail sending, data transfers/,
    );
    assert.match(
      alert.textContent!,
      language === 'ja' ? /完了または完全に休止/ : /finish or fully pause/,
    );
    assert.equal(alert.textContent!.includes(rawReason), false);
    assert.equal(alert.querySelector('.app-update-error-detail'), null);
    assert.equal(dom.window.sessionStorage.getItem(RECEIPT_KEY), null);
    assert.equal(
      button(label).disabled,
      false,
      'The owner can retry after work is paused or complete.',
    );
    assert.equal(installRequests().length, 1);
    const rejectedId = installRequests()[0].body!.requestId;
    await focus();
    assert.equal(installRequests().length, 1, 'Status refresh does not retry or stop work.');
    assert.equal(document.querySelector('[role="alert"]')!.textContent, alert.textContent);

    respond = defaultResponse;
    await click(button(label));
    assert.equal(installRequests().length, 2);
    assert.notEqual(installRequests()[1].body!.requestId, rejectedId);
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.match(
      document.body.textContent!,
      language === 'ja' ? /更新の準備をしています/ : /Preparing the update/,
    );
    assert.ok(requests.every((request) => request.path.startsWith('/api/updates')));
  });

test('lost acknowledgement and restart are recovered with reads only; reload remains explicit', async () => {
  await mount({
    respond(request) {
      if (request.path.endsWith('/install')) {
        info = { ...info, job: job(request.body!.requestId!, 'installing') };
        offline = true;
        throw new TypeError('Synthetic lost acknowledgement');
      }
      return defaultResponse(request);
    },
  });
  await click(button('Update and restart'));
  assert.equal(installRequests().length, 1);
  assert.match(document.body.textContent!, /Waiting to reconnect/);
  assert.ok(dom.window.sessionStorage.getItem(RECEIPT_KEY));
  offline = false;
  info.job = { ...info.job!, phase: 'verifying' };
  await focus();
  assert.match(document.body.textContent!, /Checking the updated app/);
  assert.equal(dom.window.sessionStorage.getItem(RECEIPT_KEY), null);
  info = {
    ...info,
    current: { version: '0.7.0', commit: targetSha },
    available: false,
    job: { ...info.job!, phase: 'succeeded' },
  };
  await click(button('Check status'));
  assert.match(document.body.textContent!, /Update complete/);
  assert.ok(button('Reload page'));
  assert.equal(installRequests().length, 1);
  assert.equal(document.querySelector<HTMLInputElement>('input')!.value, 'Keep this draft');
  assert.equal(browserErrors.length, 0, 'The page must not automatically reload');
  await renderUnsaved(true);
  assert.equal(button('Reload page').disabled, true);
});

test('an unreceived request can be retried explicitly using the same idempotency key', async () => {
  let attempted = false;
  await mount({
    respond(request) {
      if (request.path.endsWith('/install') && !attempted) {
        attempted = true;
        throw new TypeError('Synthetic request never reached the server');
      }
      return defaultResponse(request);
    },
  });
  await click(button('Update and restart'));
  const firstId = installRequests()[0].body!.requestId;
  assert.match(document.body.textContent!, /request receipt is not available yet/);
  await click(button('Check status'));
  await focus();
  assert.equal(installRequests().length, 1);
  await click(button('Retry the same request'));
  assert.equal(installRequests().length, 2);
  assert.equal(installRequests()[1].body!.requestId, firstId);
  assert.match(document.body.textContent!, /Preparing the update/);
});

test('an unresolved request survives reopening the page without replaying the install', async () => {
  const receipt = { id: savedRequestId, commit: targetSha };
  await mount({
    receipt,
    respond() {
      throw new TypeError('Synthetic server restart');
    },
  });
  assert.match(document.body.textContent!, /Waiting to reconnect/);
  assert.equal(installRequests().length, 0);
  const restarted = fixture();
  restarted.job = job(savedRequestId, 'building');
  await mount({ preserve: true, info: restarted });
  assert.match(document.body.textContent!, /Building the updated app/);
  assert.equal(dom.window.sessionStorage.getItem(RECEIPT_KEY), null);
  assert.ok(requests.every((request) => request.method === 'GET'));
});

test('an update started in another tab is discovered on focus and its completion on reconnection', async () => {
  await mount();
  info.job = job(savedRequestId, 'building');
  await focus();
  assert.match(document.body.textContent!, /Building the updated app/);
  assert.equal(installRequests().length, 0);
  assert.equal(dom.window.sessionStorage.getItem(RECEIPT_KEY), null);
  connected = false;
  await act(async () => root!.render(tree()));
  info = {
    ...info,
    current: { version: '0.7.0', commit: targetSha },
    available: false,
    job: { ...info.job!, phase: 'succeeded' },
  };
  connected = true;
  await act(async () => root!.render(tree()));
  assert.match(document.body.textContent!, /Update complete/);
  assert.equal(button('Reload page').disabled, false);
  assert.equal(installRequests().length, 0);
  assert.equal(browserErrors.length, 0);
});

test('a historical successful job does not request a reload after a newer manual installation', async () => {
  const manuallyUpdated = fixture();
  const manualCommit = 'c'.repeat(40);
  manuallyUpdated.current = { version: '0.8.0', commit: manualCommit };
  manuallyUpdated.latest = {
    ...manuallyUpdated.latest!,
    version: '0.8.0',
    commit: manualCommit,
  };
  manuallyUpdated.available = false;
  manuallyUpdated.job = job(savedRequestId, 'succeeded');
  await mount({ info: manuallyUpdated });
  assert.match(document.querySelector('.app-update-versions')!.textContent!, /v0\.8\.0/);
  assert.equal(document.querySelector('.app-update-notice'), null);
  assert.equal(
    [...document.querySelectorAll('button')].some(
      (element) => element.textContent?.trim() === 'Reload page',
    ),
    false,
  );
  assert.equal(installRequests().length, 0);
});

test('active updates are polled and polling stops after a terminal result', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const active = fixture();
  active.job = job(savedRequestId, 'building');
  await mount({ info: active });
  const initialCount = requests.length;
  info.job = { ...info.job!, phase: 'verifying' };
  await act(async () => t.mock.timers.tick(2_000));
  assert.equal(requests.length, initialCount + 1);
  assert.match(document.body.textContent!, /Checking the updated app/);
  info.job = { ...info.job!, phase: 'failed', error: 'Synthetic build failed.', rolledBack: true };
  await act(async () => t.mock.timers.tick(2_000));
  assert.match(document.body.textContent!, /previous version/);
  assert.match(document.body.textContent!, /Synthetic build failed/);
  const completedCount = requests.length;
  await act(async () => t.mock.timers.tick(2_000));
  assert.equal(requests.length, completedCount);
  assert.equal(installRequests().length, 0);
});

test('a stale check response cannot replace an accepted update receipt', async () => {
  await mount();
  let finishCheck: (response: Response) => void = () => {};
  respond = (request) =>
    request.path.endsWith('/check')
      ? new Promise((resolve) => {
          finishCheck = resolve;
        })
      : defaultResponse(request);
  const check = button('Check for updates');
  const install = button('Update and restart');
  await act(async () => {
    check.click();
    install.click();
  });
  assert.equal(installRequests().length, 1);
  assert.match(document.body.textContent!, /Preparing the update/);
  const outdated = fixture();
  outdated.available = false;
  await act(async () => finishCheck(Response.json(outdated)));
  assert.match(document.body.textContent!, /Preparing the update/);
  assert.equal(
    requests.findLast((request) => request.path.endsWith('/check'))!.signal?.aborted,
    true,
  );
});

test('install acceptance and overlapping status reads preserve the accepted job in either response order', async () => {
  for (const order of ['post-first', 'get-first']) {
    await mount();
    let finishInstall: (response: Response) => void = () => {};
    let finishStatus: (response: Response) => void = () => {};
    respond = (request) =>
      request.path.endsWith('/install')
        ? new Promise((resolve) => {
            finishInstall = resolve;
          })
        : request.path === '/api/updates'
          ? new Promise((resolve) => {
              finishStatus = resolve;
            })
          : defaultResponse(request);
    const install = button('Update and restart');
    await act(async () => {
      install.click();
      install.click();
    });
    assert.equal(installRequests().length, 1, 'A repeated click cannot send a second request');
    await focus();
    const accepted = job(installRequests()[0].body!.requestId!);
    if (order === 'post-first') {
      await act(async () => finishInstall(Response.json(accepted, { status: 202 })));
      await act(async () => finishStatus(Response.json(fixture())));
      assert.match(document.body.textContent!, /Preparing the update/);
    } else {
      await act(async () =>
        finishStatus(Response.json({ ...info, job: { ...accepted, phase: 'building' } })),
      );
      await act(async () => finishInstall(Response.json(accepted, { status: 202 })));
      assert.match(document.body.textContent!, /Building the updated app/);
    }
    assert.equal(dom.window.sessionStorage.getItem(RECEIPT_KEY), null);
    assert.equal(installRequests().length, 1);
  }
});

test('checks on focus respect the six-hour interval and never trigger installation', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await mount();
  await focus();
  assert.equal(requests.filter((request) => request.path.endsWith('/check')).length, 1);
  now += 6 * 60 * 60_000;
  await focus();
  assert.equal(requests.filter((request) => request.path.endsWith('/check')).length, 2);
  assert.equal(requests.at(-1)?.body?.force, false);
  assert.equal(installRequests().length, 0);
});

test('pending and unknown CI checks refresh after one minute without overlapping requests or installing', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const checks of ['pending', 'unknown'] as const) {
    const awaitingChecks = fixture();
    awaitingChecks.latest!.checks = checks;
    await mount({ info: awaitingChecks });
    const checkCount = () => requests.filter((request) => request.path.endsWith('/check')).length;
    assert.equal(checkCount(), 1);
    now += 59_000;
    await focus();
    assert.equal(checkCount(), 1);
    let finishCheck: (response: Response) => void = () => {};
    respond = (request) =>
      request.path.endsWith('/check')
        ? new Promise((resolve) => {
            finishCheck = resolve;
          })
        : defaultResponse(request);
    now += 1_000;
    await act(async () => t.mock.timers.tick(60_000));
    assert.equal(checkCount(), 2);
    now += 60_000;
    await act(async () => t.mock.timers.tick(60_000));
    assert.equal(checkCount(), 2, 'An in-flight check is shared instead of starting a loop');
    info.latest!.checks = 'passed';
    await act(async () => finishCheck(Response.json(info)));
    assert.equal(button('Update and restart').disabled, false);
    respond = defaultResponse;
    now += 60_000;
    await act(async () => t.mock.timers.tick(60_000));
    assert.equal(checkCount(), 2, 'Verified updates return to the normal six-hour interval');
    assert.equal(installRequests().length, 0);
  }
});

test('strict-mode initialization and Japanese labels remain read-only until the update button is pressed', async () => {
  await mount({ strict: true, locale: 'ja' });
  assert.match(document.body.textContent!, /Agent Loomの更新/);
  assert.match(document.body.textContent!, /更新して再起動/);
  assert.equal(requests.filter((request) => request.path.endsWith('/check')).length, 1);
  assert.equal(installRequests().length, 0);
  assert.equal(button('更新して再起動').disabled, false);
});
