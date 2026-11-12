import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import type {
  BrowserCommand,
  BrowserCredentialBinding,
  BrowserControl,
  BrowserPlan,
  BrowserResult,
} from '../src/server/browser.js';
import {
  browserUploadReceipts,
  type PreparedBrowserUploads,
} from '../src/server/browser-uploads.js';
import { createTools, operationKey } from '../src/server/runtime/tools.js';
import { readGeneratedImage } from '../src/server/runtime/images.js';
import type { ToolContext } from '../src/server/runtime/contract.js';
import { RoomTaskScheduler } from '../src/server/runtime/pause.js';
import { DEFAULT_BROWSER_SETTINGS } from '../src/shared/browser.js';
import { saveServiceAccount } from '../src/server/service-accounts.js';
import type {
  Approval,
  BrowserSettings,
  BrowserStatus,
  Message,
  Task,
} from '../src/shared/types.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6cAAAAASUVORK5CYII=',
  'base64',
);
const pageUrl = 'https://example.com/editor';
const stateId = '6986526e-a2de-4fd2-99b1-f0b6cf76dbf2';
const click: BrowserCommand = { operation: 'click', pageId: 7, uid: '7_4', stateId };
const upload: BrowserCommand = {
  operation: 'upload_file',
  pageId: 7,
  uid: '7_9',
  stateId,
  filePaths: ['reports/report.pdf'],
};
const uploadBytes = Buffer.from('%PDF-1.7\nLOOM_PRIVATE_UPLOAD_CONTENT_83491\n%%EOF\n');

async function writeUpload(root: string, name = 'reports/report.pdf', data = uploadBytes) {
  await mkdir(dirname(join(root, name)), { recursive: true });
  await writeFile(join(root, name), data);
}

/** The fake stops at the service boundary: these tests never launch or contact Chrome. */
class FakeBrowser implements BrowserControl {
  state: BrowserStatus['state'] = 'disconnected';
  connectCalls = 0;
  disconnectCalls = 0;
  shutdownCalls = 0;
  readonly protectedOrigins = new Set<string>();
  readonly prepared: BrowserCommand[] = [];
  readonly preparedUploads: Array<PreparedBrowserUploads | undefined> = [];
  readonly executed: BrowserCommand[] = [];
  readonly resolvedCredentials: string[] = [];
  readonly credentials = new WeakMap<BrowserPlan, BrowserCredentialBinding>();
  getSettings = (): BrowserSettings => ({ ...DEFAULT_BROWSER_SETTINGS });
  onChange = () => {};
  beforeExecute?: (plan: BrowserPlan, signal: AbortSignal) => Promise<void> | void;
  failure?: Error;

  status(): BrowserStatus {
    return {
      state: this.state,
      mode: this.getSettings().mode,
      platform: process.platform,
      busy: false,
      tabs: this.state === 'connected' ? [{ pageId: 7, url: pageUrl, title: 'Report editor' }] : [],
    };
  }

  async connect(signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.connectCalls++;
    if (!this.getSettings().enabled || this.getSettings().permission === 'deny')
      throw new Error('Chrome control is disabled or denied.');
    this.state = 'connected';
    this.onChange();
    return this.status();
  }

  async disconnect() {
    this.disconnectCalls++;
    this.state = 'disconnected';
    this.onChange();
    return this.status();
  }

  async suspend() {
    this.state = 'disconnected';
    this.onChange();
  }

  prepare(
    command: BrowserCommand,
    uploads?: PreparedBrowserUploads,
    credential?: BrowserCredentialBinding,
  ): BrowserPlan {
    if (this.state !== 'connected') throw new Error('Chrome is not connected.');
    this.prepared.push({ ...command });
    this.preparedUploads.push(uploads);
    if (credential && credential.origin !== new URL(pageUrl).origin)
      throw new Error('The saved credential does not match this page origin.');
    const plan: BrowserPlan = {
      command: { ...command },
      summary:
        command.operation === 'upload_file'
          ? 'Upload the reviewed files to Report editor. The site may send their bytes immediately.'
          : `${command.operation}: button “Publish report” in Report editor`,
      target: command.url ?? pageUrl,
      args: {
        ...command,
        pageTitle: 'Report editor',
        ...(command.uid ? { element: { role: 'button', name: 'Publish report' } } : {}),
        ...(uploads ? { uploads: browserUploadReceipts(uploads) } : {}),
      },
    };
    if (credential) this.credentials.set(plan, credential);
    return plan;
  }

  async execute(
    plan: BrowserPlan,
    signal: AbortSignal,
    assertAllowed?: () => void,
  ): Promise<BrowserResult> {
    await this.beforeExecute?.(plan, signal);
    assertAllowed?.();
    signal.throwIfAborted();
    if (this.state !== 'connected') throw new Error('Chrome is not connected.');
    const credential = this.credentials.get(plan);
    if (credential) this.resolvedCredentials.push(credential.resolve());
    this.executed.push({ ...plan.command });
    if (this.failure) throw this.failure;
    return {
      text: `${plan.command.operation} completed; observation ${this.executed.length}`,
      ...(plan.command.operation === 'screenshot'
        ? { image: { data: png.toString('base64'), mimeType: 'image/png' as const } }
        : {}),
    };
  }

  protectOrigin(origin: string) {
    this.protectedOrigins.add(origin);
  }

  async shutdown() {
    this.shutdownCalls++;
    this.state = 'disconnected';
  }
}

async function fixture(
  t: TestContext,
  options: { browser?: Partial<BrowserSettings>; apiToken?: string; realRuntime?: boolean } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-browser-tools-'));
  const fake = new FakeBrowser();
  const dedicated = new Map<string, FakeBrowser>();
  const f = await createApp({
    dataDir,
    apiToken: options.apiToken,
    scheduler: false,
    browserFactory: (config) => {
      const instance = config.profileDir ? new FakeBrowser() : fake;
      if (config.profileDir) dedicated.set(config.profileDir, instance);
      instance.getSettings = config.getSettings;
      instance.onChange = config.onChange;
      return instance;
    },
    ...(options.realRuntime
      ? {}
      : {
          runtimeFactory: () => ({
            start() {},
            async stop() {},
            async shutdown() {},
            queueState: () => ({ active: 0, waiting: 0 }),
          }),
        }),
  });
  t.after(async () => {
    await f.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    demoMode: !options.realRuntime,
    autoLearn: false,
    model: {
      ...f.store.settings().model,
      imageInput: options.browser?.includeScreenshotsInModel === true,
    },
    browser: { ...DEFAULT_BROWSER_SETTINGS, enabled: true, ...options.browser },
  });
  // These existing tool-policy fixtures exercise the legacy shared connection.
  f.store.patch('bots', 'bot_aster', { browser: { mode: 'shared' } });
  const make = (kind: Task['kind'] = 'chat', botId = 'bot_aster') => {
    const task = f.controller.enqueueTask({
      roomId: 'room_lounge',
      botId,
      prompt: 'Inspect the report in Chrome',
      kind,
    });
    const message = f.controller.addMessage({
      roomId: task.roomId,
      authorType: 'bot',
      authorId: task.botId,
      taskId: task.id,
      body: '',
      status: 'streaming',
    });
    const abort = new AbortController();
    const context: ToolContext = {
      host: f.controller,
      task,
      settings: f.store.settings(),
      signal: abort.signal,
      operationKeys: new Set(),
    };
    return { task, message, abort, context, tools: createTools(context) };
  };
  const patch = (browser: Partial<BrowserSettings>) =>
    f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      ...(options.apiToken ? { headers: { authorization: `Bearer ${options.apiToken}` } } : {}),
      payload: { browser },
    });
  return { ...f, dataDir, fake, dedicated, make, patch };
}

async function pending(f: Awaited<ReturnType<typeof fixture>>): Promise<Approval> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const approval = f.store.list<Approval>('approvals').find((item) => item.status === 'pending');
    if (approval) return approval;
    await delay(10);
  }
  throw new Error('Expected a specific Chrome approval request.');
}

test('browser tools are absent when disabled and during learning, and never connect implicitly', async (t) => {
  const f = await fixture(t, { browser: { enabled: false } });
  assert.ok(!f.make().tools.definitions.some((tool) => tool.name === 'browser_use'));
  assert.equal((await f.patch({ enabled: true })).statusCode, 200);
  assert.ok(!f.make('learning').tools.definitions.some((tool) => tool.name === 'browser_use'));
  const run = f.make();
  assert.ok(run.tools.definitions.some((tool) => tool.name === 'browser_use'));
  await assert.rejects(run.tools.invoke('browser_use', { operation: 'tabs' }), /not connected/i);
  assert.equal(f.fake.connectCalls, 0);
});

test('auto reads fresh Chrome state without journaling; interactions show target and element before approval', async (t) => {
  const f = await fixture(t);
  await f.fake.connect();
  const run = f.make();
  const first = await run.tools.invoke('browser_use', { operation: 'snapshot', pageId: 7 });
  const second = await run.tools.invoke('browser_use', { operation: 'snapshot', pageId: 7 });
  assert.notEqual(first, second);
  await run.tools.invoke('browser_use', { operation: 'tabs' });
  assert.equal(f.fake.executed.length, 3);
  assert.equal(run.context.operationKeys.size, 0);
  assert.equal(f.store.list('approvals').length, 0);
  assert.ok(
    f.controller.getSnapshot().activities.some((item) => item.approvalRule === 'browser_read'),
  );

  const action = run.tools.invoke('browser_use', { ...click });
  const approval = await pending(f);
  assert.equal(approval.toolName, 'browser_use');
  assert.equal(approval.target, pageUrl);
  assert.match(approval.summary, /Publish report/);
  assert.match(JSON.stringify(approval.args), /Publish report/);
  assert.equal(approval.args.uid, click.uid);
  assert.equal(approval.args.stateId, stateId);
  assert.equal(f.fake.executed.length, 3);
  f.controller.decideApproval(approval.id, true);
  await action;
  assert.deepEqual(f.fake.executed.at(-1), click);
  const receipt = f.controller.getOperation(operationKey(run.task.id, 'browser_use', { ...click }));
  assert.equal(receipt?.status, 'completed');
  assert.deepEqual(receipt?.args, click);
});

test('browser uploads prepare real workspace bytes before Auto approval and expose only file receipts', async (t) => {
  const f = await fixture(t);
  await f.fake.connect();
  const run = f.make();
  await writeUpload(run.task.workspacePath!);
  const csv = Buffer.from('name,total\n月次,42\n');
  await writeUpload(run.task.workspacePath!, 'reports/totals.csv', csv);
  const command = { ...upload, filePaths: [...upload.filePaths!, 'reports/totals.csv'] };
  const action = run.tools.invoke('browser_use', command);
  void action.catch(() => {});
  const approval = await pending(f);
  assert.equal(approval.target, pageUrl);
  assert.match(approval.summary, /bytes immediately/);
  assert.deepEqual(approval.args.filePaths, command.filePaths);
  assert.deepEqual(
    approval.args.uploads,
    [
      { path: 'reports/report.pdf', name: 'report.pdf', data: uploadBytes },
      { path: 'reports/totals.csv', name: 'totals.csv', data: csv },
    ].map(({ data, ...file }) => ({
      ...file,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    })),
  );
  assert.deepEqual(
    f.fake.preparedUploads[0]?.files.map((file) => file.data),
    [uploadBytes, csv],
  );
  assert.equal(f.fake.executed.length, 0);
  f.controller.decideApproval(approval.id, true);
  await action;
  assert.deepEqual(f.fake.executed, [command]);
  const receipt = f.controller.getOperation(operationKey(run.task.id, 'browser_use', command));
  assert.equal(receipt?.status, 'completed');
  assert.deepEqual(receipt?.args, command);
  const persisted = JSON.stringify({ snapshot: f.controller.getSnapshot(), receipt });
  assert.ok(!persisted.includes('LOOM_PRIVATE_UPLOAD_CONTENT_83491'));
  assert.ok(!persisted.includes(uploadBytes.toString('base64')));
  assert.ok(!persisted.includes(JSON.stringify(uploadBytes)));
});

test('invalid browser upload sources are rejected before any approval or browser plan', async (t) => {
  const f = await fixture(t);
  await f.fake.connect();
  const run = f.make();
  await writeUpload(run.task.workspacePath!);
  await writeUpload(run.task.workspacePath!, '.env', Buffer.from('fixture_secret=value'));
  await writeUpload(run.task.workspacePath!, 'empty.txt', Buffer.alloc(0));
  const outside = join(f.dataDir, 'outside.txt');
  await writeFile(outside, 'An existing file outside the workspace.');
  for (const [label, filePaths, error] of [
    ['missing list', undefined, /file|upload/i],
    ['empty list', [], /file|upload/i],
    ['empty file', ['empty.txt'], /empty|0 bytes/i],
    ['missing file', ['missing.pdf'], /exist|ENOENT/i],
    ['outside traversal', ['../outside.txt'], /outside|relative|traversal/i],
    ['absolute path', [outside], /relative|absolute/i],
    ['secret file', ['.env'], /credential|private/i],
    ['too many files', Array.from({ length: 11 }, () => 'reports/report.pdf'), /10|files/i],
  ] as const) {
    await assert.rejects(run.tools.invoke('browser_use', { ...upload, filePaths }), error, label);
  }
  assert.equal(f.store.list('approvals').length, 0);
  assert.equal(f.store.list('operations').length, 0);
  assert.equal(f.fake.prepared.length, 0);
  assert.equal(f.fake.executed.length, 0);
});

test('Allow uploads without another approval and restores a completed upload after its source disappears', async (t) => {
  const f = await fixture(t, { browser: { permission: 'allow' } });
  await f.fake.connect();
  const run = f.make();
  await writeUpload(run.task.workspacePath!);
  const result = await run.tools.invoke('browser_use', { ...upload });
  assert.equal(f.store.list('approvals').length, 0);
  assert.equal(f.fake.executed.length, 1);
  await rm(join(run.task.workspacePath!, upload.filePaths![0]));
  await f.fake.disconnect();
  await f.patch({ permission: 'deny' });
  const resumed = createTools({ ...run.context, operationKeys: new Set() });
  const receipt = await resumed.invoke('browser_use', { ...upload });
  assert.match(receipt, /already completed.*not repeated/i);
  assert.ok(receipt.includes(result));
  assert.equal(
    f.fake.prepared.length,
    1,
    'restoring a receipt never rereads or uploads the source',
  );
  assert.equal(f.fake.executed.length, 1);
  const denied = f.make();
  await assert.rejects(denied.tools.invoke('browser_use', { ...upload }), /disabled|denied/i);
  assert.equal(f.fake.prepared.length, 1);
  assert.equal(f.store.list('approvals').length, 0);
});

test('a denied or uncertain browser upload is never issued or automatically repeated', async (t) => {
  const f = await fixture(t);
  await f.fake.connect();
  const run = f.make();
  await writeUpload(run.task.workspacePath!);
  const rejected = assert.rejects(
    run.tools.invoke('browser_use', { ...upload }),
    /denied or cancelled/i,
  );
  const approval = await pending(f);
  f.controller.decideApproval(approval.id, false);
  await rejected;
  assert.equal(f.fake.executed.length, 0);
  assert.equal(f.store.list('operations').length, 0);

  await f.patch({ permission: 'allow' });
  f.fake.failure = new Error('The upload transport closed after possible submission.');
  await assert.rejects(run.tools.invoke('browser_use', { ...upload }), /possible submission/);
  const receipt = f.controller.getOperation(
    operationKey(run.task.id, 'browser_use', { ...upload }),
  );
  assert.equal(receipt?.status, 'failed');
  await rm(join(run.task.workspacePath!, upload.filePaths![0]));
  f.fake.failure = undefined;
  const resumed = createTools({ ...run.context, operationKeys: new Set() });
  await assert.rejects(resumed.invoke('browser_use', { ...upload }), /uncertain or failed/i);
  assert.equal(f.fake.prepared.length, 2, 'a failed receipt is checked before preparing new bytes');
  assert.equal(f.fake.executed.length, 1);
});

test('browser upload workspace scope is checked after approval and again before issuance', async (t) => {
  for (const changeAt of ['approval', 'dispatch'] as const) {
    await t.test(changeAt, async (t) => {
      const f = await fixture(t, { browser: { permission: 'ask' } });
      await f.fake.connect();
      const run = f.make();
      await writeUpload(run.task.workspacePath!);
      const changeWorkspace = () =>
        f.store.patch('settings', 'main', { workspacePath: join(f.dataDir, 'replacement') });
      const rejected = assert.rejects(
        run.tools.invoke('browser_use', { ...upload }),
        /workspace changed/i,
      );
      const approval = await pending(f);
      if (changeAt === 'approval') changeWorkspace();
      else f.fake.beforeExecute = () => void changeWorkspace();
      f.controller.decideApproval(approval.id, true);
      await rejected;
      assert.equal(f.fake.executed.length, 0);
      const receipt = f.controller.getOperation(
        operationKey(run.task.id, 'browser_use', { ...upload }),
      );
      assert.equal(receipt?.status, changeAt === 'dispatch' ? 'failed' : undefined);
    });
  }
});

test('browser uploads honor a room workspace and reject changed task or room scope', async (t) => {
  for (const scope of ['global', 'room', 'task'] as const) {
    await t.test(scope, async (t) => {
      const f = await fixture(t, { browser: { permission: 'ask' } });
      const workspace = join(f.dataDir, 'room-workspace');
      f.store.patch('rooms', 'room_lounge', { workspacePath: workspace });
      await writeUpload(workspace);
      await f.fake.connect();
      const run = f.make();
      const action = run.tools.invoke('browser_use', { ...upload });
      const checked = scope === 'global' ? action : assert.rejects(action, /workspace changed/i);
      const approval = await pending(f);
      const next = join(f.dataDir, 'replacement');
      if (scope === 'global') f.store.patch('settings', 'main', { workspacePath: next });
      else if (scope === 'room') f.store.patch('rooms', run.task.roomId, { workspacePath: next });
      else f.store.patch('tasks', run.task.id, { workspacePath: next });
      f.controller.decideApproval(approval.id, true);
      await checked;
      assert.equal(f.fake.preparedUploads[0]?.root, await realpath(workspace));
      assert.equal(f.fake.executed.length, scope === 'global' ? 1 : 0);
    });
  }
});

test('upload limit increases apply to an existing task and completed receipts survive later reductions', async (t) => {
  const f = await fixture(t, {
    browser: {
      permission: 'allow',
      uploadMaxFiles: 1,
      uploadMaxFileMiB: 1,
      uploadMaxTotalMiB: 1,
      uploadStorageMiB: 1,
    },
  });
  await f.fake.connect();
  const run = f.make();
  const names = Array.from({ length: 11 }, (_, index) => `configured-${index}.bin`);
  for (const [index, name] of names.entries())
    await writeUpload(
      run.task.workspacePath!,
      name,
      Buffer.alloc(index === 0 ? 1024 * 1024 + 1 : 1, 42),
    );
  const command = { ...upload, filePaths: names };
  await assert.rejects(run.tools.invoke('browser_use', command), /at most 1 file/);
  assert.equal(f.fake.prepared.length, 0);
  assert.equal(
    (
      await f.patch({
        uploadMaxFiles: 12,
        uploadMaxFileMiB: 2,
        uploadMaxTotalMiB: 3,
        uploadStorageMiB: 4,
      })
    ).statusCode,
    200,
  );
  const result = await run.tools.invoke('browser_use', command);
  assert.equal(f.fake.preparedUploads[0]?.files.length, 11);
  assert.equal(f.fake.preparedUploads[0]?.files[0].size, 1024 * 1024 + 1);
  assert.equal(f.fake.executed.length, 1);
  assert.equal(f.store.list('approvals').length, 0);
  for (const name of names) await rm(join(run.task.workspacePath!, name));
  assert.equal(
    (
      await f.patch({
        uploadMaxFiles: 1,
        uploadMaxFileMiB: 1,
        uploadMaxTotalMiB: 1,
        uploadStorageMiB: 1,
      })
    ).statusCode,
    200,
  );
  const resumed = createTools({ ...run.context, operationKeys: new Set() });
  const receipt = await resumed.invoke('browser_use', command);
  assert.match(receipt, /already completed.*not repeated/i);
  assert.ok(receipt.includes(result));
  assert.equal(
    f.fake.prepared.length,
    1,
    'a lower current limit cannot turn receipt restoration into another upload',
  );
  assert.equal(f.fake.executed.length, 1);
});

test('live count and byte limits are rechecked after approval and at the browser issue boundary', async (t) => {
  const cases: Array<{
    label: string;
    sizes: number[];
    change: Partial<BrowserSettings>;
    at: 'approval' | 'dispatch';
    error: RegExp;
  }> = [
    {
      label: 'count during approval',
      sizes: [8, 8],
      change: { uploadMaxFiles: 1 },
      at: 'approval',
      error: /at most 1 file/,
    },
    {
      label: 'per-file before dispatch',
      sizes: [1024 * 1024 + 1],
      change: { uploadMaxFileMiB: 1 },
      at: 'dispatch',
      error: /1 MiB.*per-file/,
    },
    {
      label: 'combined during approval',
      sizes: [768 * 1024, 768 * 1024],
      change: { uploadMaxFileMiB: 1, uploadMaxTotalMiB: 1 },
      at: 'approval',
      error: /combined 1 MiB/,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.label, async (t) => {
      const f = await fixture(t, {
        browser: {
          permission: 'ask',
          uploadMaxFiles: 2,
          uploadMaxFileMiB: 2,
          uploadMaxTotalMiB: 3,
          uploadStorageMiB: 4,
        },
      });
      await f.fake.connect();
      const run = f.make();
      const names = entry.sizes.map((_, index) => `reviewed-${index}.bin`);
      for (const [index, name] of names.entries())
        await writeUpload(run.task.workspacePath!, name, Buffer.alloc(entry.sizes[index], 42));
      const command = { ...upload, filePaths: names };
      const rejected = assert.rejects(run.tools.invoke('browser_use', command), entry.error);
      const approval = await pending(f);
      const apply = async () => assert.equal((await f.patch(entry.change)).statusCode, 200);
      if (entry.at === 'approval') await apply();
      else f.fake.beforeExecute = apply;
      f.controller.decideApproval(approval.id, true);
      await rejected;
      assert.equal(f.fake.executed.length, 0);
      assert.equal(f.fake.prepared.length, 1);
      const receipt = f.controller.getOperation(operationKey(run.task.id, 'browser_use', command));
      assert.equal(receipt?.status, entry.at === 'dispatch' ? 'failed' : undefined);
    });
  }
});

test('rejected interactions and ask-mode reads have no browser effect; allow bypasses approval and deny blocks it', async (t) => {
  const f = await fixture(t);
  await f.fake.connect();
  const run = f.make();
  const denied = assert.rejects(
    run.tools.invoke('browser_use', { ...click }),
    /denied or cancelled/i,
  );
  const approval = await pending(f);
  f.controller.decideApproval(approval.id, false);
  await denied;
  assert.equal(f.fake.executed.length, 0);
  assert.equal(run.context.operationKeys.size, 0);

  assert.equal((await f.patch({ permission: 'ask' })).statusCode, 200);
  const read = run.tools.invoke('browser_use', { operation: 'tabs' });
  const readApproval = await pending(f);
  assert.equal(readApproval.args.operation, 'tabs');
  assert.equal(f.fake.executed.length, 0);
  f.controller.decideApproval(readApproval.id, true);
  await read;

  assert.equal((await f.patch({ permission: 'allow' })).statusCode, 200);
  await run.tools.invoke('browser_use', { ...click });
  assert.equal(f.store.list('approvals').length, 2);
  const executed = f.fake.executed.length;
  assert.equal((await f.patch({ permission: 'deny' })).statusCode, 200);
  await assert.rejects(run.tools.invoke('browser_use', { operation: 'tabs' }), /disabled|denied/i);
  assert.equal(f.fake.executed.length, executed);
  assert.equal(f.fake.state, 'disconnected');
});

test('revoking browser permission while an action waits prevents issuance and retains its uncertain receipt', async (t) => {
  const f = await fixture(t, { browser: { permission: 'allow' } });
  await f.fake.connect();
  const run = f.make();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.fake.beforeExecute = async () => {
    entered.resolve();
    await release.promise;
  };
  const rejected = assert.rejects(
    run.tools.invoke('browser_use', { ...click }),
    /disabled|denied/i,
  );
  await entered.promise;
  try {
    assert.equal((await f.patch({ permission: 'deny' })).statusCode, 200);
  } finally {
    release.resolve();
  }
  await rejected;
  assert.equal(f.fake.executed.length, 0);
  assert.equal(
    f.controller.getOperation(operationKey(run.task.id, 'browser_use', { ...click }))?.status,
    'failed',
  );
});

test('an exact completed browser mutation restores its receipt after disconnect without preparing or executing again', async (t) => {
  const f = await fixture(t, { browser: { permission: 'allow' } });
  await f.fake.connect();
  const run = f.make();
  const result = await run.tools.invoke('browser_use', { ...click });
  await f.fake.disconnect();
  await f.patch({ permission: 'deny' });
  const resumed = createTools({ ...run.context, operationKeys: new Set() });
  const replay = await resumed.invoke('browser_use', { ...click });
  assert.match(replay, /already completed.*not repeated/i);
  assert.ok(replay.includes(result));
  assert.equal(f.fake.prepared.length, 1);
  assert.equal(f.fake.executed.length, 1);
  assert.equal(f.store.list('approvals').length, 0);
});

test('a browser mutation with an uncertain error cannot be retried automatically', async (t) => {
  const f = await fixture(t, { browser: { permission: 'allow' } });
  await f.fake.connect();
  f.fake.failure = new Error('Transport closed after the click was issued.');
  const run = f.make();
  await assert.rejects(run.tools.invoke('browser_use', { ...click }), /Transport closed/);
  const receipt = f.controller.getOperation(operationKey(run.task.id, 'browser_use', { ...click }));
  assert.equal(receipt?.status, 'failed');
  assert.deepEqual(receipt?.args, click);
  f.fake.failure = undefined;
  const resumed = createTools({ ...run.context, operationKeys: new Set() });
  await assert.rejects(resumed.invoke('browser_use', { ...click }), /uncertain or failed/i);
  assert.equal(f.fake.prepared.length, 1);
  assert.equal(f.fake.executed.length, 1);
});

test('stopping a queued browser mutation records failure and resume never automatically retries it', async (t) => {
  const f = await fixture(t, { browser: { permission: 'allow' } });
  await f.fake.connect();
  const run = f.make();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.fake.beforeExecute = async () => {
    entered.resolve();
    await release.promise;
  };
  const rejected = assert.rejects(
    run.tools.invoke('browser_use', { ...click }),
    /abort|stop|cancel/i,
  );
  await entered.promise;
  run.abort.abort();
  release.resolve();
  await rejected;
  assert.equal(f.fake.executed.length, 0);
  assert.equal(
    f.controller.getOperation(operationKey(run.task.id, 'browser_use', { ...click }))?.status,
    'failed',
  );
  const resumed = createTools({
    ...run.context,
    signal: new AbortController().signal,
    operationKeys: new Set(),
  });
  await assert.rejects(resumed.invoke('browser_use', { ...click }), /uncertain or failed/i);
  assert.equal(f.fake.prepared.length, 1);
});

test('screenshots persist as authenticated attachments while text models receive no pixels', async (t) => {
  const f = await fixture(t, { apiToken: 'browser-test-token' });
  await f.fake.connect();
  const run = f.make();
  const tool = run.tools.definitions.find((candidate) => candidate.name === 'browser_use')!;
  const result = await tool.execute(
    'screenshot-test',
    { operation: 'screenshot', pageId: 7 },
    run.abort.signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );
  assert.ok(result.content.every((item) => item.type === 'text'));
  assert.match(JSON.stringify(result.content), /No pixels were sent/i);
  const attachment = f.store.get<Message>('messages', run.message.id)!.attachments![0];
  assert.equal(attachment.mimeType, 'image/png');
  assert.equal(attachment.byteLength, png.length);
  assert.deepEqual(await readGeneratedImage(f.dataDir, attachment), png);
  assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes(png.toString('base64')));
  assert.equal(
    (await f.app.inject({ method: 'GET', url: `/api/images/${attachment.id}` })).statusCode,
    401,
  );
  const image = await f.app.inject({
    method: 'GET',
    url: `/api/images/${attachment.id}`,
    headers: { authorization: 'Bearer browser-test-token' },
  });
  assert.equal(image.statusCode, 200);
  assert.match(image.headers['content-type'] ?? '', /image\/png/);
  assert.deepEqual(image.rawPayload, png);
  assert.equal(run.context.operationKeys.size, 0);
});

test('general image input and capture-time inclusion govern screenshots independently, with live revocation', async (t) => {
  const f = await fixture(t, { browser: { includeScreenshotsInModel: true } });
  await f.fake.connect();
  const run = f.make();
  const tool = run.tools.definitions.find((candidate) => candidate.name === 'browser_use')!;
  const result = await tool.execute(
    'vision-test',
    { operation: 'screenshot', pageId: 7 },
    run.abort.signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );
  assert.deepEqual(
    result.content.find((item) => item.type === 'image'),
    {
      type: 'image',
      data: png.toString('base64'),
      mimeType: 'image/png',
    },
  );
  // Capture-time inclusion can be revoked independently of explicit inspection.
  const settings = f.store.settings();
  f.store.put('settings', {
    ...settings,
    id: 'main',
    browser: { ...settings.browser!, includeScreenshotsInModel: false },
  });
  const textOnly = await tool.execute(
    'vision-revoked',
    { operation: 'screenshot', pageId: 7 },
    run.abort.signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );
  assert.ok(textOnly.content.every((item) => item.type === 'text'));
  assert.equal(f.store.get<Message>('messages', run.message.id)!.attachments!.length, 2);
  const imageId = f.store.get<Message>('messages', run.message.id)!.attachments!.at(-1)!.id;
  const view = run.tools.definitions.find((candidate) => candidate.name === 'view_image')!;
  const inspected = await view.execute(
    'inspect-saved-screenshot',
    { imageId },
    run.abort.signal,
    undefined,
    {} as Parameters<typeof view.execute>[4],
  );
  assert.deepEqual(
    inspected.content.find((item) => item.type === 'image'),
    {
      type: 'image',
      data: png.toString('base64'),
      mimeType: 'image/png',
    },
  );
  assert.equal(f.fake.executed.length, 2, 'Viewing the saved image does not contact Chrome.');

  // The global switch blocks both paths even if capture-time inclusion is on.
  f.store.put('settings', {
    ...settings,
    id: 'main',
    model: { ...settings.model, imageInput: false },
    browser: { ...settings.browser!, includeScreenshotsInModel: true },
  });
  const globallyDisabled = await tool.execute(
    'global-vision-revoked',
    { operation: 'screenshot', pageId: 7 },
    run.abort.signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );
  assert.ok(globallyDisabled.content.every((item) => item.type === 'text'));
  await assert.rejects(
    view.execute(
      'view-revoked',
      { imageId },
      run.abort.signal,
      undefined,
      {} as Parameters<typeof view.execute>[4],
    ),
    /Image input is disabled/,
  );
});

test(
  'real Pi sends screenshot pixels to the local model only with image input enabled; browser APIs never invoke inference',
  { timeout: 30_000 },
  async (t) => {
    type ContentPart = { type: string; image_url?: { url: string }; text?: string };
    type ModelBody = { messages: Array<{ role: string; content?: string | ContentPart[] }> };
    for (const includeScreenshotsInModel of [false, true]) {
      const modelBodies: ModelBody[] = [];
      const provider = createServer((request, response) => {
        void (async () => {
          assert.equal(request.url, '/v1/chat/completions');
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelBody;
          modelBodies.push(body);
          // A vision-capable adapter may append a user image message after the tool result.
          const afterTool = body.messages.some((message) => message.role === 'tool');
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const delta = afterTool
            ? { content: 'The Chrome screenshot is attached.' }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: 'chrome-screenshot-call',
                    type: 'function',
                    function: {
                      name: 'browser_use',
                      arguments: JSON.stringify({ operation: 'screenshot', pageId: 7 }),
                    },
                  },
                ],
              };
          for (const choice of [
            { index: 0, delta, finish_reason: null },
            { index: 0, delta: {}, finish_reason: afterTool ? 'stop' : 'tool_calls' },
          ])
            response.write(
              `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'chrome-fixture', choices: [choice] })}\n\n`,
            );
          response.end('data: [DONE]\n\n');
        })().catch((error) => response.destroy(error as Error));
      });
      await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
      t.after(
        () =>
          new Promise<void>((resolve) => {
            provider.closeAllConnections();
            provider.close(() => resolve());
          }),
      );
      const address = provider.address();
      assert.ok(address && typeof address !== 'string');
      const f = await fixture(t, {
        realRuntime: true,
        browser: { includeScreenshotsInModel },
      });
      f.store.put('settings', {
        ...f.store.settings(),
        id: 'main',
        model: {
          ...f.store.settings().model,
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          modelId: 'chrome-fixture',
        },
      });
      for (const method of ['GET', 'POST', 'DELETE', 'POST'] as const) {
        const result = await f.app.inject({
          method,
          url: method === 'GET' ? '/api/browser' : '/api/browser/connect',
        });
        assert.equal(result.statusCode, 200, result.body);
      }
      assert.equal(modelBodies.length, 0, 'Browser status and connection must not invoke a model.');
      const task = f.controller.enqueueTask({
        roomId: 'room_lounge',
        botId: 'bot_aster',
        prompt: 'Capture the Chrome page, then explain that its screenshot is attached.',
      });
      const deadline = Date.now() + 10_000;
      while (!['completed', 'failed'].includes(f.store.get<Task>('tasks', task.id)!.status)) {
        assert.ok(Date.now() < deadline, 'Timed out waiting for the real Pi screenshot task.');
        await delay(10);
      }
      const done = f.store.get<Task>('tasks', task.id)!;
      assert.equal(done.status, 'completed', done.error);
      assert.equal(modelBodies.length, 2);
      assert.deepEqual(f.fake.executed, [{ operation: 'screenshot', pageId: 7 }]);
      const pixels = modelBodies.flatMap((body) =>
        body.messages.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.filter((part) => part.type === 'image_url')
            : [],
        ),
      );
      if (includeScreenshotsInModel) {
        assert.equal(pixels.length, 1);
        assert.equal(pixels[0].image_url?.url, `data:image/png;base64,${png.toString('base64')}`);
      } else {
        assert.equal(pixels.length, 0);
        assert.ok(!JSON.stringify(modelBodies).includes(png.toString('base64')));
      }
      const message = f.store.list<Message>('messages').find((item) => item.taskId === task.id)!;
      assert.match(message.body, /Chrome screenshot is attached/);
      assert.deepEqual(await readGeneratedImage(f.dataDir, message.attachments![0]), png);
      await f.app.inject({ method: 'GET', url: '/api/browser' });
      await f.app.inject({ method: 'DELETE', url: '/api/browser/connect' });
      assert.equal(
        modelBodies.length,
        2,
        'Browser APIs must not start extra inference after a task.',
      );
    }
  },
);

test('browser APIs authenticate before protecting origins and only explicit connection requests connect', async (t) => {
  const f = await fixture(t, { apiToken: 'browser-test-token' });
  for (const method of ['GET', 'POST', 'DELETE'] as const) {
    const result = await f.app.inject({
      method,
      url: method === 'GET' ? '/api/browser' : '/api/browser/connect',
    });
    assert.equal(result.statusCode, 401);
  }
  assert.equal(f.fake.protectedOrigins.size, 0);
  assert.equal(f.fake.connectCalls, 0);
  assert.equal(f.fake.disconnectCalls, 0);
  const headers = { authorization: 'Bearer browser-test-token', host: 'loom.example:3210' };
  const forbidden = await f.app.inject({
    method: 'GET',
    url: '/api/browser',
    headers: { ...headers, origin: 'https://attacker.example' },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(f.fake.protectedOrigins.size, 0);
  const status = await f.app.inject({ method: 'GET', url: '/api/browser', headers });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().state, 'disconnected');
  assert.equal(f.fake.connectCalls, 0);
  assert.ok(f.fake.protectedOrigins.has('http://loom.example:3210'));
  assert.ok(!f.fake.protectedOrigins.has('https://attacker.example'));
  const connected = await f.app.inject({ method: 'POST', url: '/api/browser/connect', headers });
  assert.equal(connected.statusCode, 200);
  assert.equal(connected.json().state, 'connected');
  assert.equal(f.fake.connectCalls, 1);
  await f.app.inject({ method: 'GET', url: '/api/browser', headers });
  assert.equal(f.fake.connectCalls, 1);
  const disconnected = await f.app.inject({
    method: 'DELETE',
    url: '/api/browser/connect',
    headers,
  });
  assert.equal(disconnected.statusCode, 200);
  assert.equal(disconnected.json().state, 'disconnected');
  assert.equal(f.fake.disconnectCalls, 1);
});

test('browser settings merge partial patches, lock mode and vision changes, and permit immediate disable or denial', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.patch({ permission: 'ask' })).statusCode, 200);
  assert.deepEqual(f.store.settings().browser, {
    ...DEFAULT_BROWSER_SETTINGS,
    enabled: true,
    permission: 'ask',
  });
  const invalid = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { browser: { mode: 'remote' } },
  });
  assert.equal(invalid.statusCode, 400);
  await f.fake.connect();
  assert.equal((await f.patch({ mode: 'dedicated' })).statusCode, 409);
  assert.equal(f.store.settings().browser?.mode, 'existing');
  await f.fake.disconnect();
  const run = f.make();
  assert.equal((await f.patch({ mode: 'dedicated' })).statusCode, 409);
  assert.equal((await f.patch({ includeScreenshotsInModel: true })).statusCode, 409);
  assert.equal(f.store.settings().browser?.includeScreenshotsInModel, false);
  assert.equal((await f.patch({ permission: 'allow' })).statusCode, 200);
  await f.fake.connect();
  const beforeDisable = f.fake.disconnectCalls;
  assert.equal((await f.patch({ enabled: false })).statusCode, 200);
  assert.equal(f.fake.disconnectCalls, beforeDisable + 1);
  assert.equal(f.fake.state, 'disconnected');
  assert.equal((await f.patch({ enabled: true })).statusCode, 200);
  await f.fake.connect();
  const beforeDeny = f.fake.disconnectCalls;
  assert.equal((await f.patch({ permission: 'deny' })).statusCode, 200);
  assert.equal(f.fake.disconnectCalls, beforeDeny + 1);
  assert.equal(f.fake.state, 'disconnected');
  f.controller.updateTask(run.task.id, { status: 'completed' });
  assert.equal(
    (await f.patch({ mode: 'dedicated', includeScreenshotsInModel: true })).statusCode,
    200,
  );
  assert.deepEqual(f.store.settings().browser, {
    ...DEFAULT_BROWSER_SETTINGS,
    enabled: true,
    mode: 'dedicated',
    permission: 'deny',
    includeScreenshotsInModel: true,
  });
});

test('new bots default to dedicated Chrome; existing missing bindings stay shared and invalid settings are rejected', async (t) => {
  const f = await fixture(t);
  f.store.patch('bots', 'bot_aster', { browser: undefined });
  f.store.seed();
  assert.equal(f.store.get<any>('bots', 'bot_aster')!.browser, undefined);
  assert.equal(
    (await f.app.inject({ method: 'GET', url: '/api/bots/bot_aster/browser' })).json().botMode,
    'shared',
  );
  assert.equal(
    f.store.get<any>('bots', 'bot_nova')!.browser.mode,
    'dedicated',
    'Fresh seed uses dedicated profiles',
  );
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/bots',
    payload: {
      name: 'Dedicated',
      handle: 'dedicated',
      role: 'Research',
      systemPrompt: 'Research carefully.',
      color: '#123456',
      avatar: 'character:aster',
    },
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().browser.mode, 'dedicated');
  const botId = created.json().id;
  for (const browser of [{ mode: 'remote' }, { mode: 'dedicated', profileDir: '/tmp/other' }]) {
    assert.equal(
      (await f.app.inject({ method: 'PATCH', url: `/api/bots/${botId}`, payload: { browser } }))
        .statusCode,
      400,
    );
  }
  for (const maxConcurrentBrowsers of [0, 17, 1.5])
    assert.equal((await f.patch({ maxConcurrentBrowsers })).statusCode, 400);
  assert.equal((await f.patch({ maxConcurrentBrowsers: 2 })).statusCode, 200);
  assert.equal(f.fake.connectCalls, 0);
  assert.ok([...f.dedicated.values()].every((browser) => browser.connectCalls === 0));
});

test('bot browser APIs route to the requested bot, require authentication and enforce disabled mode', async (t) => {
  const f = await fixture(t, { apiToken: 'browser-test-token' });
  for (const method of ['GET', 'POST', 'DELETE'] as const)
    assert.equal(
      (
        await f.app.inject({
          method,
          url: '/api/bots/bot_nova/browser' + (method === 'GET' ? '' : '/connect'),
        })
      ).statusCode,
      401,
    );
  const headers = { authorization: 'Bearer browser-test-token' };
  const status = await f.app.inject({ method: 'GET', url: '/api/bots/bot_nova/browser', headers });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().botMode, 'dedicated');
  assert.equal([...f.dedicated.values()][0].connectCalls, 0);
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/bots/bot_nova/browser/connect', headers }))
      .statusCode,
    200,
  );
  assert.equal([...f.dedicated.values()][0].connectCalls, 1);
  assert.equal(f.fake.connectCalls, 0);
  assert.equal(
    (
      await f.app.inject({
        method: 'PATCH',
        url: '/api/bots/bot_nova',
        headers,
        payload: { browser: { mode: 'disabled' } },
      })
    ).statusCode,
    200,
  );
  assert.equal([...f.dedicated.values()][0].shutdownCalls, 1);
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/bots/bot_nova/browser/connect', headers }))
      .statusCode,
    400,
  );
  const run = f.make('chat', 'bot_nova');
  assert.ok(!run.tools.definitions.some((tool) => tool.name === 'browser_use'));
});

test('bot disconnect, global disable and deny cancel pending browser approvals and release the capacity lease', async (t) => {
  for (const action of ['disconnect', 'disable', 'deny'] as const) {
    await t.test(action, async (t) => {
      const f = await fixture(t);
      await f.app.inject({ method: 'POST', url: '/api/bots/bot_nova/browser/connect' });
      await f.fake.connect();
      const run = f.make('chat', 'bot_nova');
      const pendingAction = run.tools.invoke('browser_use', { ...click });
      const rejected = assert.rejects(pendingAction, /stopped|cancelled/i);
      const approval = await pending(f);
      if (action === 'disconnect')
        await f.app.inject({ method: 'DELETE', url: '/api/bots/bot_nova/browser/connect' });
      else await f.patch(action === 'disable' ? { enabled: false } : { permission: 'deny' });
      await rejected;
      assert.equal(f.store.get<Approval>('approvals', approval.id)!.status, 'cancelled');
      assert.equal([...f.dedicated.values()][0].executed.length, 0);
      assert.equal(f.browser.status().pool!.waiting, 0);
      assert.equal(f.fake.state, action === 'disconnect' ? 'connected' : 'disconnected');
    });
  }
});

function attachRoomBoundary(
  t: TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
  run: ReturnType<Awaited<ReturnType<typeof fixture>>['make']>,
) {
  const workers = new RoomTaskScheduler({
    capacity: 1,
    onSuspend: (taskId) => f.browser.releaseTask(taskId),
  });
  assert.equal(workers.tryStart(run.task.id, run.task.roomId), true);
  run.context.waitForRoom = async (signal) => {
    await workers.checkpoint(run.task.id, signal);
  };
  run.context.roomPauseSignal = () => workers.pauseSignal(run.task.roomId);
  t.after(() => {
    run.abort.abort();
    workers.finish(run.task.id);
    f.browser.releaseTask(run.task.id);
  });
  return workers;
}

async function untilBrowser(check: () => boolean, description: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await delay(5);
  }
  assert.ok(check(), description);
}

test('room pause preserves an issued browser action and its receipt, then parks the next tool', async (t) => {
  const f = await fixture(t, { browser: { permission: 'allow' } });
  await f.fake.connect();
  const run = f.make();
  const workers = attachRoomBoundary(t, f, run);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  t.after(() => finish.resolve());
  let actionSignal: AbortSignal | undefined;
  f.fake.beforeExecute = async (_plan, signal) => {
    actionSignal = signal;
    entered.resolve();
    await finish.promise;
  };
  const action = run.tools.invoke('browser_use', { ...click });
  await entered.promise;
  workers.setRoomPaused(run.task.roomId, true);
  assert.equal(actionSignal?.aborted, false);
  assert.equal(workers.activeCount, 1, 'the active browser operation retains its worker');
  finish.resolve();
  await action;
  assert.equal(actionSignal?.aborted, false, 'pause does not cancel an issued browser action');
  assert.equal(f.fake.executed.length, 1);
  assert.equal(
    f.controller.getOperation(operationKey(run.task.id, 'browser_use', { ...click }))?.status,
    'completed',
  );

  const next = run.tools.invoke('browser_use', { operation: 'tabs' });
  await untilBrowser(() => workers.isSuspended(run.task.id), 'next tool parked at its boundary');
  assert.equal(workers.activeCount, 0);
  assert.equal(f.fake.prepared.length, 1, 'the next tool is not prepared while paused');
  assert.equal(f.fake.executed.length, 1);
  assert.equal(f.browser.botStatus('bot_aster').busy, false, 'idle task residency was released');
  workers.setRoomPaused(run.task.roomId, false);
  await next;
  assert.deepEqual(f.fake.executed, [click, { operation: 'tabs' }]);
  const replay = await run.tools.invoke('browser_use', { ...click });
  assert.match(replay, /already completed.*not repeated/i);
  assert.equal(f.fake.executed.length, 2, 'the completed browser mutation is never replayed');
});

test('approving a paused browser request preserves the approval and executes the original plan only after resume', async (t) => {
  const f = await fixture(t, { browser: { permission: 'ask' } });
  await f.fake.connect();
  const run = f.make();
  const workers = attachRoomBoundary(t, f, run);
  let originalPlan: BrowserPlan | undefined;
  const prepare = f.fake.prepare.bind(f.fake);
  f.fake.prepare = (command) => {
    originalPlan = prepare(command);
    return originalPlan;
  };
  f.fake.beforeExecute = (plan) => {
    assert.equal(plan, originalPlan, 'reacquisition must not silently replace the approved plan');
  };
  const action = run.tools.invoke('browser_use', { ...click });
  const approval = await pending(f);
  const previousHandle = await f.browser.forTask(run.task.botId, run.task.id, run.abort.signal);
  workers.setRoomPaused(run.task.roomId, true);
  // Runtime parks a worker already awaiting approval; permit() later shares this checkpoint.
  const observer = workers.checkpoint(run.task.id, run.abort.signal);
  assert.equal(previousHandle.signal.aborted, true, 'residency is released while waiting');
  assert.equal(previousHandle.approvalSignal?.aborted, false);
  assert.equal(f.store.get<Approval>('approvals', approval.id)!.status, 'pending');
  f.controller.decideApproval(approval.id, true);
  await delay(20);
  assert.equal(f.store.get<Approval>('approvals', approval.id)!.status, 'approved');
  assert.equal(f.fake.executed.length, 0);
  assert.equal(workers.activeCount, 0);
  assert.equal(workers.waitingTasks.length, 1, 'observer and tool share one worker wait');
  workers.setRoomPaused(run.task.roomId, false);
  await Promise.all([observer, action]);
  assert.deepEqual(f.fake.executed, [click]);
  assert.equal(f.fake.prepared.length, 1);
  assert.equal(f.store.list<Approval>('approvals').length, 1);
  assert.equal(
    f.controller.getOperation(operationKey(run.task.id, 'browser_use', { ...click }))?.status,
    'completed',
  );
});

test('a paused upload retains its reviewed files and original browser plan until explicit resume', async (t) => {
  const f = await fixture(t, { browser: { permission: 'ask' } });
  await f.fake.connect();
  const run = f.make();
  await writeUpload(run.task.workspacePath!);
  const workers = attachRoomBoundary(t, f, run);
  let originalPlan: BrowserPlan | undefined;
  const prepare = f.fake.prepare.bind(f.fake);
  f.fake.prepare = (command, uploads) => {
    originalPlan = prepare(command, uploads);
    return originalPlan;
  };
  f.fake.beforeExecute = (plan) => assert.equal(plan, originalPlan);
  const action = run.tools.invoke('browser_use', { ...upload });
  void action.catch(() => {});
  const approval = await pending(f);
  const reviewed = f.fake.preparedUploads[0];
  workers.setRoomPaused(run.task.roomId, true);
  const observer = workers.checkpoint(run.task.id, run.abort.signal);
  f.controller.decideApproval(approval.id, true);
  await delay(20);
  assert.equal(f.fake.executed.length, 0);
  assert.equal(workers.activeCount, 0);
  assert.equal(f.store.get<Approval>('approvals', approval.id)?.status, 'approved');
  workers.setRoomPaused(run.task.roomId, false);
  await Promise.all([observer, action]);
  assert.equal(f.fake.prepared.length, 1);
  assert.equal(f.fake.preparedUploads[0], reviewed);
  assert.deepEqual(f.fake.preparedUploads[0]?.files[0].data, uploadBytes);
  assert.deepEqual(f.fake.executed, [upload]);
  assert.equal(f.store.list('approvals').length, 1);
  assert.equal(
    f.controller.getOperation(operationKey(run.task.id, 'browser_use', { ...upload }))?.status,
    'completed',
  );
});

test('paused browser approval lends a one-profile pool to another room and never silently reprepares an evicted plan', async (t) => {
  const f = await fixture(t, { browser: { permission: 'ask', maxConcurrentBrowsers: 1 } });
  await f.browser.connectBot('bot_nova');
  const dedicated = [...f.dedicated.values()][0];
  const run = f.make('chat', 'bot_nova');
  const workers = attachRoomBoundary(t, f, run);
  const action = run.tools.invoke('browser_use', { ...click });
  const rejected = assert.rejects(action, /not connected|reconnected|fresh snapshot/i);
  const approval = await pending(f);
  const previousHandle = await f.browser.forTask(run.task.botId, run.task.id, run.abort.signal);
  const otherSignal = new AbortController().signal;
  const other = f.browser.forTask('bot_aster', 'another-room-task', otherSignal);
  await untilBrowser(() => f.browser.status().pool!.waiting > 0, 'other room waits for Chrome');
  workers.setRoomPaused(run.task.roomId, true);
  const observer = workers.checkpoint(run.task.id, run.abort.signal);
  const independent = await other;
  await f.fake.connect();
  const result = await independent.execute(independent.prepare({ operation: 'tabs' }), otherSignal);
  assert.match(result.text, /tabs completed/);
  f.browser.releaseTask('another-room-task');
  assert.equal(previousHandle.signal.aborted, true);
  assert.equal(
    previousHandle.approvalSignal?.aborted,
    false,
    'idle eviction is not user cancellation',
  );
  assert.equal(f.store.get<Approval>('approvals', approval.id)!.status, 'pending');
  f.controller.decideApproval(approval.id, true);
  await delay(20);
  assert.equal(dedicated.executed.length, 0);
  workers.setRoomPaused(run.task.roomId, false);
  await Promise.all([observer, rejected]);
  assert.equal(dedicated.prepared.length, 1, 'a stale approved plan is not prepared again');
  assert.equal(dedicated.executed.length, 0);
  assert.equal(f.store.list<Approval>('approvals').length, 1);
  assert.equal(f.store.get<Approval>('approvals', approval.id)!.status, 'approved');
  assert.equal(f.browser.status().pool!.waiting, 0);
});

test('browser approval lifetime survives residency release but explicit disconnect still cancels it', async (t) => {
  const f = await fixture(t);
  await f.fake.connect();
  const signal = new AbortController().signal;
  const task = await f.browser.forTask('bot_aster', 'signal-test', signal);
  const profile = f.browser.forBot('bot_aster');
  assert.equal(task.approvalSignal, profile.signal);
  f.browser.releaseTask('signal-test');
  assert.equal(task.signal.aborted, true);
  assert.equal(task.approvalSignal?.aborted, false);
  const resumed = await f.browser.forTask('bot_aster', 'signal-test', signal);
  assert.equal(resumed.signal.aborted, false);
  assert.equal(resumed.approvalSignal, task.approvalSignal);
  await f.browser.disconnectBot('bot_aster');
  assert.equal(task.approvalSignal?.aborted, true);
  assert.equal(resumed.signal.aborted, true);
});

test('a pause racing the transition into browser approval parks before creating a pending request', async (t) => {
  const f = await fixture(t, { browser: { permission: 'ask' } });
  await f.fake.connect();
  const run = f.make();
  const workers = attachRoomBoundary(t, f, run);
  const update = f.controller.updateTask.bind(f.controller);
  let raced = false;
  f.controller.updateTask = (taskId, patch) => {
    if (taskId === run.task.id && patch.status === 'awaiting_approval' && !raced) {
      raced = true;
      // Pause saw the prior waiting_tool status, so no approval observer exists yet.
      workers.setRoomPaused(run.task.roomId, true);
    }
    update(taskId, patch);
  };
  const action = run.tools.invoke('browser_use', { ...click });
  void action.catch(() => {}); // A failed assertion still cancels/settles this task in cleanup.
  await untilBrowser(() => workers.isSuspended(run.task.id), 'approval transition must park');
  assert.equal(workers.activeCount, 0);
  assert.equal(f.fake.executed.length, 0);
  assert.equal(f.store.list<Approval>('approvals').length, 0);
  assert.equal(f.browser.botStatus(run.task.botId).busy, false);
  workers.setRoomPaused(run.task.roomId, false);
  const approval = await pending(f);
  f.controller.decideApproval(approval.id, true);
  await action;
  assert.deepEqual(f.fake.executed, [click]);
});

const savedFill = { operation: 'fill', pageId: 7, uid: '7_4', stateId } as const;
function sharedService(f: Awaited<ReturnType<typeof fixture>>, sharedBotIds = ['bot_aster']) {
  return saveServiceAccount(f.store, {
    name: 'Shared login',
    url: 'https://example.com/login',
    login: 'member@example.test',
    botId: null,
    sharedBotIds,
    mailAccountId: null,
    status: 'active',
    notes: '',
    credential: 'LOOM_SAVED_SHARED_CREDENTIAL_93283',
  });
}

test('a shared bot applies a saved service credential after exact Chrome approval without exposing its value', async (t) => {
  const f = await fixture(t);
  await f.fake.connect();
  const account = sharedService(f);
  const run = f.make();
  const args = { ...savedFill, serviceId: account.id, expectedRevision: account.revision };
  const work = run.tools.invoke('browser_use', args);
  const approval = await pending(f);
  assert.equal(approval.toolName, 'browser_use');
  assert.equal(approval.args.serviceId, account.id);
  assert.equal(approval.args.credentialAction, 'use_saved');
  assert.equal(approval.args.expectedRevision, account.revision);
  assert.match(approval.summary, /Shared login/);
  assert.equal(f.fake.resolvedCredentials.length, 0);
  assert.ok(!JSON.stringify(approval).includes('LOOM_SAVED_SHARED'));
  f.controller.decideApproval(approval.id, true);
  assert.match(await work, /fill completed/);
  assert.deepEqual(f.fake.resolvedCredentials, ['LOOM_SAVED_SHARED_CREDENTIAL_93283']);
  const publicRecords = JSON.stringify({
    snapshot: f.controller.getSnapshot(),
    operation: f.controller.getOperation(operationKey(run.task.id, 'browser_use', args)),
  });
  assert.ok(!publicRecords.includes('LOOM_SAVED_SHARED_CREDENTIAL_93283'));
  assert.ok(!f.fake.prepared.some((command) => command.text));
  assert.match(await run.tools.invoke('browser_use', args), /already completed/);
  assert.equal(f.fake.resolvedCredentials.length, 1);
});

test('service credential use rejects unshared, stale, disabled and malformed references before Chrome approval', async (t) => {
  const f = await fixture(t);
  await f.fake.connect();
  const run = f.make();
  const account = sharedService(f, []);
  await assert.rejects(
    run.tools.invoke('browser_use', { ...savedFill, serviceId: account.id, expectedRevision: 1 }),
    /not shared/,
  );
  const shared = { ...account, sharedBotIds: ['bot_aster'], revision: account.revision + 1 };
  f.store.put('serviceAccounts', shared);
  await assert.rejects(
    run.tools.invoke('browser_use', { ...savedFill, serviceId: account.id, expectedRevision: 1 }),
    /changed/,
  );
  for (const args of [
    { ...savedFill, serviceId: account.id },
    { ...savedFill, expectedRevision: shared.revision },
    { ...savedFill, serviceId: account.id, expectedRevision: shared.revision, text: 'ignored' },
    {
      operation: 'click',
      pageId: 7,
      stateId,
      uid: '7_4',
      serviceId: account.id,
      expectedRevision: shared.revision,
    },
  ])
    await assert.rejects(run.tools.invoke('browser_use', args), /requires fill/);
  f.store.patch('serviceAccounts', account.id, { status: 'disabled' });
  await assert.rejects(
    run.tools.invoke('browser_use', {
      ...savedFill,
      serviceId: account.id,
      expectedRevision: shared.revision,
    }),
    /disabled/,
  );
  assert.equal(f.store.list('approvals').length, 0);
  assert.equal(f.fake.resolvedCredentials.length, 0);
});

test('revoking a service share while Chrome approval is pending prevents credential resolution and browser mutation', async (t) => {
  const f = await fixture(t);
  await f.fake.connect();
  const account = sharedService(f);
  const run = f.make();
  const work = run.tools.invoke('browser_use', {
    ...savedFill,
    serviceId: account.id,
    expectedRevision: account.revision,
  });
  const rejected = assert.rejects(work, /not shared|changed/);
  const approval = await pending(f);
  f.store.patch('serviceAccounts', account.id, {
    sharedBotIds: [],
    revision: account.revision + 1,
  });
  f.controller.decideApproval(approval.id, true);
  await rejected;
  assert.equal(f.fake.resolvedCredentials.length, 0);
  assert.equal(f.fake.executed.length, 0);
});

test('the final browser admission rechecks service access and never overrides Chrome deny', async (t) => {
  const f = await fixture(t, { browser: { permission: 'allow' } });
  await f.fake.connect();
  const account = sharedService(f);
  const run = f.make();
  f.fake.beforeExecute = () => {
    f.store.patch('serviceAccounts', account.id, { sharedBotIds: [] });
  };
  await assert.rejects(
    run.tools.invoke('browser_use', {
      ...savedFill,
      serviceId: account.id,
      expectedRevision: account.revision,
    }),
    /not shared/,
  );
  assert.equal(f.fake.resolvedCredentials.length, 0);
  f.fake.beforeExecute = undefined;
  f.store.patch('serviceAccounts', account.id, { sharedBotIds: ['bot_aster'] });
  await f.patch({ permission: 'deny' });
  await assert.rejects(
    f.make().tools.invoke('browser_use', {
      ...savedFill,
      serviceId: account.id,
      expectedRevision: account.revision,
    }),
    /disabled|denied|deny/i,
  );
  assert.equal(f.fake.resolvedCredentials.length, 0);
});
