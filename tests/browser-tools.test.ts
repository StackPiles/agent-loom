import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import type {
  BrowserCommand,
  BrowserControl,
  BrowserPlan,
  BrowserResult,
} from '../src/server/browser.js';
import { createTools, operationKey } from '../src/server/runtime/tools.js';
import { readGeneratedImage } from '../src/server/runtime/images.js';
import type { ToolContext } from '../src/server/runtime/contract.js';
import { DEFAULT_BROWSER_SETTINGS } from '../src/shared/browser.js';
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

/** The fake stops at the service boundary: these tests never launch or contact Chrome. */
class FakeBrowser implements BrowserControl {
  state: BrowserStatus['state'] = 'disconnected';
  connectCalls = 0;
  disconnectCalls = 0;
  shutdownCalls = 0;
  readonly protectedOrigins = new Set<string>();
  readonly prepared: BrowserCommand[] = [];
  readonly executed: BrowserCommand[] = [];
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

  prepare(command: BrowserCommand): BrowserPlan {
    if (this.state !== 'connected') throw new Error('Chrome is not connected.');
    this.prepared.push({ ...command });
    return {
      command: { ...command },
      summary: `${command.operation}: button “Publish report” in Report editor`,
      target: command.url ?? pageUrl,
      args: {
        ...command,
        pageTitle: 'Report editor',
        ...(command.uid ? { element: { role: 'button', name: 'Publish report' } } : {}),
      },
    };
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
  const f = await createApp({
    dataDir,
    apiToken: options.apiToken,
    scheduler: false,
    browserFactory: (config) => {
      fake.getSettings = config.getSettings;
      fake.onChange = config.onChange;
      return fake;
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
    browser: { ...DEFAULT_BROWSER_SETTINGS, enabled: true, ...options.browser },
  });
  const make = (kind: Task['kind'] = 'chat') => {
    const task = f.controller.enqueueTask({
      roomId: 'room_lounge',
      botId: 'bot_aster',
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
  return { ...f, dataDir, fake, make, patch };
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

test('enabling image input includes screenshot pixels in Pi tool results and respects live revocation', async (t) => {
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
  // Existing tools must also honor a subsequently revoked image-input setting.
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
    enabled: true,
    mode: 'dedicated',
    permission: 'deny',
    includeScreenshotsInModel: true,
  });
});
