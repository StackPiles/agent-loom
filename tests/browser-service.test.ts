import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  chromeLaunchOptions,
  createBrowserControl,
  createChromePeer,
  type BrowserCommand,
  type BrowserMcpResult,
  type BrowserPeer,
  type BrowserPeerOptions,
} from '../src/server/browser.js';
import type { BrowserSettings } from '../src/shared/types.js';

type Call = { name: string; args: Record<string, unknown> };
type Tree = Record<string, unknown> & { children?: Tree[] };
const tinyPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMV0AAAAASUVORK5CYII=';

function tree(id = 1): Tree {
  return {
    id: `${id}_0`,
    role: 'RootWebArea',
    name: 'Fixture',
    children: [
      { id: `${id}_1`, role: 'button', name: 'Send report' },
      { id: `${id}_2`, role: 'textbox', name: 'Message', value: '', focused: true },
    ],
  };
}

class FakePeer implements BrowserPeer {
  calls: Call[] = [];
  pages = [{ id: 1, url: 'https://example.test/mail', title: 'Mailbox' }];
  trees = new Map<number, Tree>([[1, tree()]]);
  dialogs = new Map<number, Record<string, unknown>>();
  closed = 0;
  active = 0;
  maximum = 0;
  textOnly = false;
  reconnected = false;
  image: BrowserMcpResult = { content: [{ type: 'image', data: tinyPng, mimeType: 'image/png' }] };
  beforeCall?: (call: Call, signal: AbortSignal) => Promise<void> | void;
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<BrowserMcpResult> {
    const call = { name, args: structuredClone(args) };
    this.calls.push(call);
    this.maximum = Math.max(this.maximum, ++this.active);
    try {
      await this.beforeCall?.(call, signal);
      signal.throwIfAborted();
      const id = args.pageId as number;
      if (name === 'list_pages')
        return this.textOnly
          ? {
              content: [
                {
                  type: 'text',
                  text:
                    '# list_pages response\n## Pages\n' +
                    this.pages
                      .map(
                        (p) => `${p.id}: ${p.title} (${p.url})${p.id === 1 ? ' [selected]' : ''}`,
                      )
                      .join('\n'),
                },
              ],
            }
          : {
              content: [],
              structuredContent: {
                pages: structuredClone(this.pages),
                reconnected: this.reconnected,
              },
            };
      if (name === 'take_snapshot') {
        const dialog = this.dialogs.get(id);
        if (dialog)
          return {
            isError: true,
            content: [{ type: 'text', text: 'A dialog is blocking the page.' }],
            structuredContent: { dialog },
          };
        const snapshot = this.trees.get(id)!;
        return this.textOnly
          ? {
              content: [
                {
                  type: 'text',
                  text: `uid=${id}_0 RootWebArea "Fixture"\n  uid=${id}_1 button "Send report"\n  uid=${id}_2 textbox "Message" value="" focused`,
                },
              ],
            }
          : { content: [], structuredContent: { snapshot: structuredClone(snapshot) } };
      }
      if (name === 'take_screenshot') return this.image;
      if (name === 'new_page') {
        const next = Math.max(0, ...this.pages.map((p) => p.id)) + 1;
        this.pages.push({ id: next, url: String(args.url), title: 'New tab' });
        this.trees.set(next, tree(next));
      }
      if (name === 'navigate_page') this.pages.find((p) => p.id === id)!.url = String(args.url);
      if (name === 'fill') this.trees.get(id)!.children![1].value = args.value;
      if (name === 'close_page') this.pages = this.pages.filter((p) => p.id !== id);
      if (name === 'handle_dialog') this.dialogs.delete(id);
      return { content: [{ type: 'text', text: `Completed ${name}` }] };
    } finally {
      this.active--;
    }
  }
  async close() {
    this.closed++;
  }
}

async function fixture(
  t: TestContext,
  overrides: Partial<Parameters<typeof createBrowserControl>[0]> = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-browser-service-'));
  const settings: BrowserSettings = {
    enabled: true,
    mode: 'existing',
    permission: 'auto',
    includeScreenshotsInModel: false,
  };
  const peer = new FakePeer();
  let created = 0;
  let changed = 0;
  let connection: BrowserPeerOptions | undefined;
  const service = createBrowserControl({
    dataDir,
    getSettings: () => settings,
    onChange: () => changed++,
    peerFactory: async (options) => {
      created++;
      connection = options;
      return peer;
    },
    ...overrides,
  });
  t.after(async () => {
    await service.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  });
  const run = (
    command: BrowserCommand,
    signal = new AbortController().signal,
    check?: () => void,
  ) => service.execute(service.prepare(command), signal, check);
  const observe = async (pageId = 1) => {
    const result = await run({ operation: 'snapshot', pageId });
    const stateId = /State ID: ([a-f0-9-]+)/.exec(result.text)?.[1];
    assert.ok(stateId, result.text);
    return { stateId, result };
  };
  return {
    dataDir,
    settings,
    peer,
    service,
    run,
    observe,
    created: () => created,
    changed: () => changed,
    connection: () => connection!,
  };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail('Fixture condition did not become true.');
}

test('fixed Chrome launch configuration isolates profile, disables telemetry and does not inherit model credentials', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-browser-launch-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const previous = process.env.LOOM_MODEL_API_KEY;
  process.env.LOOM_MODEL_API_KEY = 'should-not-reach-chrome';
  t.after(() => {
    if (previous === undefined) delete process.env.LOOM_MODEL_API_KEY;
    else process.env.LOOM_MODEL_API_KEY = previous;
  });
  const options: BrowserPeerOptions = {
    dataDir,
    mode: 'existing',
    protectedOrigins: ['http://localhost:3210'],
    onClose() {},
  };
  const launch = chromeLaunchOptions(options);
  assert.equal(launch.command, process.execPath);
  assert.match(
    launch.args[0],
    /chrome-devtools-mcp[/\\]build[/\\]src[/\\]bin[/\\]chrome-devtools-mcp\.js$/,
  );
  for (const flag of [
    '--auto-connect',
    '--no-usage-statistics',
    '--no-performance-crux',
    '--no-javascript-evaluation',
    '--no-file-navigations',
    '--page-id-routing',
    '--experimental-structured-content',
  ])
    assert.ok(launch.args.includes(flag), flag);
  assert.ok(
    !launch.args.some((arg) => /(?:blocked|allowed)-url-pattern/.test(arg)),
    'Owner tabs must not inherit browser-wide URL interception.',
  );
  assert.equal(launch.env.LOOM_MODEL_API_KEY, undefined);
  assert.equal(launch.env.NODE_OPTIONS, undefined);
  assert.equal(launch.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS, '1');
  assert.equal(launch.env.CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY, '1');
  const dedicated = chromeLaunchOptions({ ...options, mode: 'dedicated' });
  assert.ok(dedicated.args.includes('--user-data-dir=' + join(dataDir, 'browser-profile')));
  assert.ok(dedicated.args.includes('--no-headless'));
  assert.ok(!dedicated.args.includes('--auto-connect'));
  assert.ok(!dedicated.args.some((arg) => arg.includes('--no-sandbox')));
  assert.ok(!dedicated.args.some((arg) => /(?:blocked|allowed)-url-pattern/.test(arg)));
});

test(
  'pinned MCP initializes and advertises the required tool schemas without launching Chrome',
  { timeout: 20_000 },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'loom-browser-handshake-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const peer = await createChromePeer(
      { dataDir, mode: 'existing', protectedOrigins: ['http://localhost:3210'], onClose() {} },
      AbortSignal.timeout(15_000),
    );
    await peer.close();
    await peer.close();
  },
);

test('prepare and status do no I/O; disabled/denied settings and explicit disconnect prevent lazy connection', async (t) => {
  const f = await fixture(t);
  f.service.prepare({ operation: 'tabs' });
  f.service.status();
  assert.equal(f.created(), 0);
  f.settings.enabled = false;
  assert.throws(() => f.service.prepare({ operation: 'tabs' }), /disabled/);
  await assert.rejects(f.service.connect(), /disabled/);
  f.settings.enabled = true;
  f.settings.permission = 'deny';
  assert.throws(
    () => f.service.prepare({ operation: 'open', url: 'https://example.test' }),
    /disabled/,
  );
  f.settings.permission = 'auto';
  const tabs = await f.run({ operation: 'tabs' });
  assert.match(tabs.text, /Mailbox/);
  assert.equal(f.created(), 1);
  assert.equal(f.service.status().state, 'connected');
  const stale = f.service.prepare({ operation: 'snapshot', pageId: 1 });
  await f.service.disconnect();
  assert.equal(f.peer.closed, 1);
  assert.equal(f.service.status().tabs.length, 0);
  assert.throws(() => f.service.prepare({ operation: 'tabs' }), /disconnected by the user/);
  await f.service.connect();
  await assert.rejects(f.service.execute(stale, new AbortController().signal), /reconnected/);
  await f.service.disconnect();
  f.settings.enabled = false;
  f.service.status();
  f.settings.enabled = true;
  await f.run({ operation: 'tabs' });
  assert.equal(f.created(), 3);
});

test('control surfaces, internal URLs, credentials and browser shortcuts are blocked before Chrome acts', async (t) => {
  const f = await fixture(t);
  f.service.protectOrigin('http://localhost:4567/settings');
  for (const url of [
    'file:///tmp/secret',
    'data:text/html,hello',
    'javascript:alert(1)',
    'chrome://settings/',
    'https://user:password@example.test',
    'http://localhost:3210/',
    'http://localhost.:3210/',
    'http://127.0.0.2:3210/',
    'http://[::ffff:127.0.0.1]:3210/',
    'http://localhost:4567/#settings',
  ])
    assert.throws(() => f.service.prepare({ operation: 'open', url }));
  f.peer.pages.push(
    { id: 2, url: 'http://localhost:4567/approval', title: 'Approve bot' },
    { id: 3, url: 'https://user:password@example.test', title: 'Credential tab' },
    { id: 4, url: 'chrome://settings/', title: 'Chrome settings' },
  );
  await f.run({ operation: 'tabs' });
  assert.ok(
    f.service
      .status()
      .tabs.slice(1)
      .every((tab) => tab.protected),
  );
  assert.ok(!JSON.stringify(f.service.status()).includes('password'));
  for (const pageId of [2, 3, 4])
    assert.throws(() => f.service.prepare({ operation: 'snapshot', pageId }), /cannot be operated/);
  for (const key of ['Control+L', 'Meta+L', 'F12', 'Control+Shift+J', 'Control+V'])
    assert.throws(
      () => f.service.prepare({ operation: 'press_key', pageId: 1, key }),
      /Browser\/DevTools shortcuts/,
    );
  assert.throws(() => f.service.prepare({ operation: 'click', uid: '1_1' }), /pageId/);
  assert.throws(
    () => f.service.prepare({ operation: 'click', pageId: 1, uid: '1_1' }),
    /state is stale/,
  );
  assert.ok(f.peer.calls.every((call) => call.name === 'list_pages'));
});

test('a page that navigates to Loom during capture cannot return a snapshot or screenshot', async (t) => {
  const f = await fixture(t);
  await f.run({ operation: 'tabs' });
  for (const operation of ['snapshot', 'screenshot'] as const) {
    f.peer.beforeCall = (call) => {
      if (call.name === (operation === 'snapshot' ? 'take_snapshot' : 'take_screenshot'))
        f.peer.pages[0].url = 'http://localhost:3210/approval';
    };
    await assert.rejects(f.run({ operation, pageId: 1 }), /cannot be operated/);
    assert.equal(f.service.status().tabs[0].protected, true);
    f.peer.beforeCall = undefined;
    f.peer.pages[0].url = 'https://example.test/mail';
    await f.run({ operation: 'tabs' });
  }
});

test('snapshot IDs bind exact element actions; field values and page IDs are preserved and previous state cannot be reused', async (t) => {
  const f = await fixture(t);
  await f.run({ operation: 'tabs' });
  const first = await f.observe();
  assert.match(first.result.text, /Untrusted browser page data/);
  assert.match(first.result.text, /uid=1_1 button "Send report"/);
  const plan = f.service.prepare({
    operation: 'fill',
    pageId: 1,
    uid: '1_2',
    text: 'Hello\n"world"',
    stateId: first.stateId,
  });
  assert.match(plan.target, /Message/);
  assert.equal(plan.args.text, 'Hello\n"world"');
  let checks = 0;
  const result = await f.service.execute(plan, new AbortController().signal, () => checks++);
  assert.ok(checks >= 2);
  assert.match(result.text, /Hello/);
  assert.notEqual(/State ID: ([a-f0-9-]+)/.exec(result.text)?.[1], first.stateId);
  assert.deepEqual(f.peer.calls.find((call) => call.name === 'fill')?.args, {
    pageId: 1,
    uid: '1_2',
    value: 'Hello\n"world"',
    includeSnapshot: false,
  });
  await assert.rejects(
    f.service.execute(plan, new AbortController().signal),
    /changed this page state/,
  );
  const snapshot = await f.observe();
  const changed = f.service.prepare({
    operation: 'click',
    pageId: 1,
    uid: '1_1',
    stateId: snapshot.stateId,
  });
  changed.command.uid = '1_2';
  await assert.rejects(
    f.service.execute(changed, new AbortController().signal),
    /operation changed/,
  );
  assert.equal(f.peer.calls.filter((call) => call.name === 'click').length, 0);
});

test('fresh URL, target and focus checks reject human edits while approval is waiting', async (t) => {
  const f = await fixture(t);
  await f.run({ operation: 'tabs' });
  let observed = await f.observe();
  let plan = f.service.prepare({
    operation: 'click',
    pageId: 1,
    uid: '1_1',
    stateId: observed.stateId,
  });
  f.peer.pages[0].url = 'https://example.test/other';
  await assert.rejects(f.service.execute(plan, new AbortController().signal), /URL changed/);
  observed = await f.observe();
  plan = f.service.prepare({
    operation: 'click',
    pageId: 1,
    uid: '1_1',
    stateId: observed.stateId,
  });
  f.peer.trees.get(1)!.children![0].name = 'Delete account';
  await assert.rejects(
    f.service.execute(plan, new AbortController().signal),
    /target element, focus, or dialog changed/,
  );
  observed = await f.observe();
  plan = f.service.prepare({
    operation: 'press_key',
    pageId: 1,
    key: 'Enter',
    stateId: observed.stateId,
  });
  f.peer.trees.get(1)!.children![1].focused = false;
  await assert.rejects(
    f.service.execute(plan, new AbortController().signal),
    /target element, focus, or dialog changed/,
  );
  assert.ok(!f.peer.calls.some((call) => ['click', 'press_key'].includes(call.name)));
});

test('MCP browser reconnection invalidates approvals and later transport closure still clears cached state', async (t) => {
  const f = await fixture(t);
  await f.run({ operation: 'tabs' });
  const { stateId } = await f.observe();
  const old = f.service.prepare({ operation: 'click', pageId: 1, uid: '1_1', stateId });
  f.peer.reconnected = true;
  await f.run({ operation: 'tabs' });
  f.peer.reconnected = false;
  await assert.rejects(f.service.execute(old, new AbortController().signal), /reconnected/);
  f.connection().onClose();
  await until(() => f.peer.closed === 1);
  assert.equal(f.service.status().state, 'error');
  assert.deepEqual(f.service.status().tabs, []);
});

test('global browser queue is serial and stale queued mutations cannot affect a newer page state', async (t) => {
  const f = await fixture(t);
  await f.run({ operation: 'tabs' });
  const { stateId } = await f.observe();
  const command: BrowserCommand = { operation: 'click', pageId: 1, uid: '1_1', stateId };
  const first = f.service.prepare(command);
  const second = f.service.prepare(command);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.peer.beforeCall = async (call) => {
    if (call.name === 'click') await blocked;
  };
  const a = f.service.execute(first, new AbortController().signal);
  await until(() => f.peer.calls.some((call) => call.name === 'click'));
  const b = f.service.execute(second, new AbortController().signal);
  const rejected = assert.rejects(b, /changed this page state/);
  assert.equal(f.service.status().busy, true);
  release();
  await a;
  await rejected;
  assert.equal(f.peer.maximum, 1);
  assert.equal(f.peer.calls.filter((call) => call.name === 'click').length, 1);
  assert.equal(f.service.status().busy, false);
});

test('permission is checked again immediately before actions and active cancellation disconnects the transport', async (t) => {
  const f = await fixture(t);
  await f.run({ operation: 'tabs' });
  const { stateId } = await f.observe();
  const plan = f.service.prepare({ operation: 'click', pageId: 1, uid: '1_1', stateId });
  let allowed = true;
  f.peer.beforeCall = (call) => {
    if (call.name === 'take_snapshot') allowed = false;
  };
  await assert.rejects(
    f.service.execute(plan, new AbortController().signal, () => {
      if (!allowed) throw new Error('Permission revoked');
    }),
    /Permission revoked/,
  );
  assert.equal(f.peer.calls.filter((call) => call.name === 'click').length, 0);
  f.peer.beforeCall = async (_call, signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const controller = new AbortController();
  const pending = f.run({ operation: 'tabs' }, controller.signal);
  const rejection = assert.rejects(pending, /cancelled/);
  await until(() => f.peer.active === 1);
  const queuedController = new AbortController();
  const queued = f.run({ operation: 'tabs' }, queuedController.signal);
  const queuedRejection = assert.rejects(queued, { name: 'AbortError' });
  queuedController.abort();
  await queuedRejection;
  controller.abort();
  await rejection;
  assert.equal(f.peer.closed, 1);
  assert.equal(f.service.status().state, 'error');
  assert.equal(f.service.status().tabs.length, 0);
  assert.equal(f.service.status().busy, false);
});

test('screenshots are bounded inline images and never expose filesystem paths to the model', async (t) => {
  const f = await fixture(t);
  await f.run({ operation: 'tabs' });
  const result = await f.run({ operation: 'screenshot', pageId: 1 });
  assert.deepEqual(result.image, { data: tinyPng, mimeType: 'image/png' });
  assert.ok(!result.text.includes(tinyPng));
  assert.deepEqual(f.peer.calls.find((call) => call.name === 'take_screenshot')?.args, {
    pageId: 1,
    format: 'jpeg',
    quality: 75,
    fullPage: false,
  });
  for (const image of [
    { content: [{ type: 'text', text: 'Saved to /private/browser-image.png' }] },
    { content: [{ type: 'image', data: 'invalid.base64', mimeType: 'image/png' }] },
    { content: [{ type: 'image', data: tinyPng, mimeType: 'image/svg+xml' }] },
    {
      content: [
        {
          type: 'image',
          data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'),
          mimeType: 'image/png',
        },
      ],
    },
  ]) {
    f.peer.image = image;
    await assert.rejects(
      f.run({ operation: 'screenshot', pageId: 1 }),
      /bounded inline screenshot|invalid or oversized/,
    );
  }
});

test('observed dialogs can be dismissed and a changed dialog must be reviewed again', async (t) => {
  const f = await fixture(t);
  await f.run({ operation: 'tabs' });
  f.peer.dialogs.set(1, { type: 'confirm', message: 'Send report?' });
  const first = await f.observe();
  assert.match(first.result.text, /Open dialog.*Send report/);
  const stale = f.service.prepare({
    operation: 'dialog',
    pageId: 1,
    accept: true,
    stateId: first.stateId,
  });
  f.peer.dialogs.set(1, { type: 'confirm', message: 'Delete account?' });
  await assert.rejects(f.service.execute(stale, new AbortController().signal), /dialog changed/);
  const fresh = await f.observe();
  await f.run({ operation: 'dialog', pageId: 1, accept: false, stateId: fresh.stateId });
  assert.deepEqual(f.peer.calls.find((call) => call.name === 'handle_dialog')?.args, {
    pageId: 1,
    action: 'dismiss',
  });
});

test('text-format compatibility and snapshot bounds expose only visible element IDs', async (t) => {
  const f = await fixture(t);
  f.peer.textOnly = true;
  await f.run({ operation: 'tabs' });
  assert.deepEqual(f.service.status().tabs[0], {
    pageId: 1,
    url: 'https://example.test/mail',
    title: 'Mailbox',
    protected: false,
  });
  const first = await f.observe();
  await f.run({ operation: 'hover', pageId: 1, uid: '1_1', stateId: first.stateId });
  f.peer.textOnly = false;
  f.peer.trees.set(1, {
    id: '1_0',
    role: 'RootWebArea',
    children: Array.from({ length: 5000 }, (_, i) => ({
      id: `9_${i}`,
      role: 'button',
      name: 'A long button label '.repeat(10),
    })),
  });
  const large = await f.observe();
  assert.ok(large.result.text.length <= 32_000);
  assert.throws(
    () =>
      f.service.prepare({ operation: 'click', pageId: 1, uid: '9_4999', stateId: large.stateId }),
    /not in the latest visible snapshot/,
  );
});

test('connection errors include actionable setup instructions and timed-out calls invalidate state', async (t) => {
  const missing = await fixture(t, {
    peerFactory: async () => {
      throw new Error('Chrome executable not found');
    },
  });
  await assert.rejects(missing.service.connect(), /Chrome 144.*remote debugging/);
  assert.equal(missing.service.status().state, 'error');
  missing.settings.mode = 'dedicated';
  await assert.rejects(missing.service.connect(), /Install Chrome.*desktop session/);
  const f = await fixture(t, { actionTimeoutMs: 20 });
  await f.run({ operation: 'tabs' });
  f.peer.beforeCall = async (_call, signal) => {
    await delay(1000, undefined, { signal });
  };
  await assert.rejects(f.run({ operation: 'tabs' }), /timed out/);
  assert.equal(f.peer.closed, 1);
  assert.equal(f.service.status().state, 'error');
});
