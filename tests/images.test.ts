import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { createTools } from '../src/server/runtime/tools.js';
import {
  generateImage,
  imageGenerationPermission,
  imageGenerationRequest,
  imageMimeType,
  readGeneratedImage,
} from '../src/server/runtime/images.js';
import { InferenceGate } from '../src/server/runtime/gate.js';
import type { OperationRecord, ToolContext } from '../src/server/runtime/contract.js';
import type { Approval, ImageSettings, Message, Permission, Task } from '../src/shared/types.js';
import { DEFAULT_IMAGE_SETTINGS } from '../src/shared/model-settings.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6cAAAAASUVORK5CYII=',
  'base64',
);
const idleRuntime = () => ({
  start() {},
  async stop() {},
  async shutdown() {},
  queueState: () => ({ active: 0, waiting: 0 }),
});

async function server(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const http = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) =>
      response.destroy(error as Error),
    );
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  );
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function jsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function until(check: () => boolean, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

async function fixture(t: TestContext, baseUrl: string, realRuntime = false, apiToken?: string) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-images-'));
  const f = await createApp({
    dataDir,
    apiToken,
    scheduler: false,
    ...(realRuntime ? {} : { runtimeFactory: idleRuntime }),
  });
  t.after(async () => {
    await f.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    demoMode: !realRuntime,
    autoLearn: false,
    images: {
      ...DEFAULT_IMAGE_SETTINGS,
      enabled: true,
      baseUrl: `${baseUrl}/v1`,
      modelId: 'local-image-fixture',
      timeoutSeconds: 5,
    },
    permissions: { shell: 'deny', fileWrite: 'deny', network: 'allow' },
  });
  f.store.setSecret('image.apiKey', 'image-fixture-private-key');
  f.store.setSecret('model.apiKey', 'different-language-model-key');
  const make = (prompt = 'Draw a blue circle') => {
    const task = f.controller.enqueueTask({ roomId: 'room_lounge', botId: 'bot_aster', prompt });
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
  return { ...f, dataDir, make };
}

test('image tool uses a separate provider/key, persists attachments and restores completed results on resume', async (t) => {
  const requests: Array<{ path?: string; authorization?: string; body: Record<string, unknown> }> =
    [];
  const base = await server(t, async (req, res) => {
    requests.push({
      path: req.url,
      authorization: req.headers.authorization,
      body: await jsonBody(req),
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  const f = await fixture(t, base);
  const run = f.make();
  const args = { prompt: 'A blue circle on white, no text.' };
  const result = await run.tools.invoke('generate_image', args);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/v1/images/generations');
  assert.equal(requests[0].authorization, 'Bearer image-fixture-private-key');
  assert.deepEqual(requests[0].body, {
    model: 'local-image-fixture',
    prompt: args.prompt,
    n: 1,
    size: '2048x2048',
  });
  const image = f.store.get<Message>('messages', run.message.id)!.attachments![0];
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.byteLength, png.length);
  assert.deepEqual(await readGeneratedImage(f.dataDir, image), png);
  assert.match(result, /saved and attached/);
  assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes(png.toString('base64')));
  assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes('image-fixture-private-key'));
  assert.deepEqual(await readdir(run.context.settings.workspacePath), []);
  f.controller.updateMessage(run.message.id, { status: 'complete' });
  const resumed = f.controller.addMessage({
    roomId: run.task.roomId,
    authorType: 'bot',
    authorId: run.task.botId,
    taskId: run.task.id,
    body: '',
    status: 'streaming',
  });
  const restored = await createTools(run.context).invoke('generate_image', args);
  assert.match(restored, /without another request/);
  assert.equal(requests.length, 1);
  assert.equal(f.store.get<Message>('messages', resumed.id)!.attachments![0].id, image.id);
  await createTools(run.context).invoke('generate_image', args);
  assert.equal(f.store.get<Message>('messages', resumed.id)!.attachments!.length, 1);
});

test('automatic network policy asks for exact image prompt and model; denial makes no request', async (t) => {
  let requests = 0;
  const base = await server(t, (_req, res) => {
    requests++;
    res.end('{}');
  });
  const f = await fixture(t, base);
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    permissions: { shell: 'deny', fileWrite: 'deny', network: 'auto' },
  });
  const run = f.make();
  const generation = run.tools.invoke('generate_image', {
    prompt: 'A precise red triangle.',
    size: '1024x1536',
  });
  const denied = assert.rejects(generation, /denied or cancelled/);
  await until(
    () => f.store.list<Approval>('approvals').some((a) => a.status === 'pending'),
    'image approval',
  );
  const approval = f.store.list<Approval>('approvals').find((a) => a.status === 'pending')!;
  assert.equal(approval.toolName, 'generate_image');
  assert.equal(approval.target, `${base}/v1/images/generations`);
  assert.equal(approval.args.prompt, 'A precise red triangle.');
  assert.equal(approval.args.model, 'local-image-fixture');
  f.controller.decideApproval(approval.id, false);
  await denied;
  assert.equal(requests, 0);
  assert.equal(f.store.get<Message>('messages', run.message.id)?.attachments, undefined);
});

test('image permission inherits legacy policy and network deny remains a ceiling for every image choice', async (t) => {
  const f = await fixture(t, 'http://images.example.test');
  const settings = f.store.settings();
  for (const network of ['allow', 'auto', 'ask', 'deny'] satisfies Permission[]) {
    for (const permission of [undefined, 'inherit', 'allow', 'ask', 'deny'] satisfies Array<
      ImageSettings['permission']
    >) {
      const expected =
        network === 'deny'
          ? 'deny'
          : permission && permission !== 'inherit'
            ? permission
            : network === 'allow'
              ? 'allow'
              : 'ask';
      assert.equal(
        imageGenerationPermission({
          ...settings,
          images: { ...settings.images!, permission },
          permissions: { ...settings.permissions, network },
        }),
        expected,
        `image=${permission ?? 'legacy'} network=${network}`,
      );
    }
  }
});

test('explicit image allow applies live without approving other network tools, and completed images still replay exactly', async (t) => {
  let requests = 0;
  const base = await server(t, (_req, res) => {
    requests++;
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  const f = await fixture(t, base);
  const run = f.make();
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    images: { ...f.store.settings().images!, permission: 'allow' },
    permissions: { shell: 'deny', fileWrite: 'deny', network: 'ask' },
  });
  const args = { prompt: 'One exact blue circle, permitted only for image generation.' };
  await run.tools.invoke('generate_image', args);
  assert.equal(requests, 1);
  assert.equal(f.store.list<Approval>('approvals').length, 0);
  assert.equal(f.store.settings().permissions.network, 'ask');

  const web = run.tools.invoke('web_fetch', { url: 'https://public.example.test/fixture' });
  const rejected = assert.rejects(web, /denied or cancelled/);
  await until(
    () => f.store.list<Approval>('approvals').some((approval) => approval.status === 'pending'),
    'unrelated network tool still needs approval',
  );
  const approval = f.store.list<Approval>('approvals').find((item) => item.status === 'pending')!;
  assert.equal(approval.toolName, 'web_fetch');
  f.controller.decideApproval(approval.id, false);
  await rejected;
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    images: { ...f.store.settings().images!, permission: 'deny' },
    permissions: { shell: 'deny', fileWrite: 'deny', network: 'deny' },
  });
  assert.match(
    await createTools(run.context).invoke('generate_image', args),
    /without another request/,
  );
  assert.equal(requests, 1, 'permission changes never repeat an already completed operation');
});

test('explicit image ask and deny override network allow, while network deny blocks explicit image allow', async (t) => {
  let requests = 0;
  const base = await server(t, (_req, res) => {
    requests++;
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  const f = await fixture(t, base);
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    images: { ...f.store.settings().images!, permission: 'ask' },
  });
  const generation = f
    .make()
    .tools.invoke('generate_image', { prompt: 'Approve this exact image.' });
  await until(
    () => f.store.list<Approval>('approvals').some((approval) => approval.status === 'pending'),
    'explicit image approval',
  );
  const approval = f.store.list<Approval>('approvals').find((item) => item.status === 'pending')!;
  assert.equal(approval.args.prompt, 'Approve this exact image.');
  assert.equal(approval.args.model, 'local-image-fixture');
  assert.equal(requests, 0);
  f.controller.decideApproval(approval.id, true);
  await generation;
  assert.equal(requests, 1);
  for (const policy of [
    { network: 'allow', image: 'deny' },
    { network: 'deny', image: 'allow' },
  ] as const) {
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      images: { ...f.store.settings().images!, permission: policy.image },
      permissions: { shell: 'deny', fileWrite: 'deny', network: policy.network },
    });
    await assert.rejects(
      f.make().tools.invoke('generate_image', { prompt: 'This image is blocked.' }),
      /disabled/,
    );
  }
  assert.equal(requests, 1);
  assert.equal(f.store.list<Approval>('approvals').length, 1);
});

test('queued bot images recheck a newly stricter image permission before making a request', async (t) => {
  let requests = 0;
  const base = await server(t, (_req, res) => {
    requests++;
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  const f = await fixture(t, base);
  for (const permission of ['ask', 'deny'] as const) {
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      images: { ...f.store.settings().images!, permission: 'allow' },
      permissions: { shell: 'deny', fileWrite: 'deny', network: 'ask' },
    });
    const gate = new InferenceGate();
    const release = await gate.acquire();
    t.after(release);
    const run = f.make();
    run.context.acquireInference = (signal) => gate.acquire(signal);
    const image = run.tools.invoke('generate_image', { prompt: `Recheck image ${permission}` });
    const rejected = assert.rejects(image, /[Bb]ot image permission/);
    await until(() => gate.state.waiting === 1, 'image waits for inference admission');
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      images: { ...f.store.settings().images!, permission },
    });
    release();
    await rejected;
    assert.deepEqual(gate.state, { active: 0, waiting: 0 });
  }
  assert.equal(requests, 0);
  assert.equal(f.store.list<Approval>('approvals').length, 0);
});

test('pausing a queued bot image releases both capacities and resuming never interrupts dispatched image HTTP', async (t) => {
  const requests: string[] = [];
  let finishImage: (() => void) | undefined;
  const base = await server(t, async (req, res) => {
    const body = await jsonBody(req);
    requests.push(String(body.prompt));
    const reply = () => res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    if (body.prompt === 'Pause and resume this image') finishImage = reply;
    else reply();
  });
  const f = await fixture(t, base);
  const gate = new InferenceGate();
  const releaseText = await gate.acquire();
  t.after(releaseText);
  const pauseGate = new InferenceGate();
  const resumeRoom = await pauseGate.acquire();
  t.after(resumeRoom);
  let paused = false;
  let pauseSignal = new AbortController();
  const run = f.make();
  t.after(() => run.abort.abort());
  run.context.acquireInference = (signal) => gate.acquire(signal);
  run.context.roomPauseSignal = () => pauseSignal.signal;
  run.context.waitForRoom = async (signal) => {
    if (paused) {
      const release = await pauseGate.acquire(signal);
      release();
    }
  };
  const image = generateImage(
    run.context,
    { prompt: 'Pause and resume this image' },
    `img_${'c'.repeat(64)}`,
    'allow',
  );
  await until(() => gate.state.waiting === 1, 'image holds image slot while waiting for inference');
  paused = true;
  pauseSignal.abort();
  await until(
    () => gate.state.waiting === 0 && pauseGate.state.waiting === 1,
    'room pause removes image from inference queue before waiting for resume',
  );
  assert.equal(requests.length, 0);
  const settings = f.store.settings();
  await generateImage(
    {
      host: f.controller,
      settings: { ...settings, images: { ...settings.images!, shareInferenceSlot: false } },
      signal: new AbortController().signal,
    },
    { prompt: 'An independent owner image while the bot is paused' },
    `img_${'d'.repeat(64)}`,
    'allow',
  );
  assert.equal(requests.length, 1, 'paused bot releases the image slot for unrelated work');
  assert.deepEqual(gate.state, { active: 1, waiting: 0 });
  paused = false;
  pauseSignal = new AbortController();
  resumeRoom();
  releaseText();
  await until(
    () => requests.length === 2 && Boolean(finishImage),
    'resumed image begins HTTP once',
  );
  paused = true;
  pauseSignal.abort();
  finishImage!();
  assert.equal((await image).prompt, 'Pause and resume this image');
  assert.equal(requests.length, 2);
  assert.deepEqual(gate.state, { active: 0, waiting: 0 });
});

test('image generation shares inference slots, aborts without replay, and releases both queues', async (t) => {
  let requests = 0;
  let active = 0;
  let maximum = 0;
  const base = await server(t, async (req, res) => {
    const body = await jsonBody(req);
    requests++;
    active++;
    maximum = Math.max(maximum, active);
    res.once('close', () => active--);
    if (body.prompt === 'Cancel this image') return;
    await delay(20);
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  const f = await fixture(t, base);
  const gate = new InferenceGate();
  const textRelease = await gate.acquire();
  const first = f.make();
  first.context.acquireInference = (signal) => gate.acquire(signal);
  const cancelled = first.tools.invoke('generate_image', { prompt: 'Cancel this image' });
  const cancellation = assert.rejects(cancelled, /abort|cancel/i);
  await until(() => gate.state.waiting === 1, 'image waits for global inference slot');
  assert.equal(requests, 0);
  textRelease();
  await until(() => requests === 1, 'image request started');
  const second = f.make();
  second.context.acquireInference = (signal) => gate.acquire(signal);
  const next = second.tools.invoke('generate_image', { prompt: 'Complete the next image' });
  await delay(30);
  assert.equal(requests, 1);
  first.abort.abort();
  await cancellation;
  await next;
  assert.equal(requests, 2);
  assert.equal(maximum, 1);
  assert.deepEqual(gate.state, { active: 0, waiting: 0 });
  const replacementContext = {
    ...first.context,
    signal: new AbortController().signal,
    operationKeys: new Set<string>(),
  };
  await assert.rejects(
    createTools(replacementContext).invoke('generate_image', { prompt: 'Cancel this image' }),
    /uncertain or failed/,
  );
  assert.equal(requests, 2);
});

test('queued image cancellation and a live network denial never contact the image server', async (t) => {
  let requests = 0;
  const base = await server(t, (_req, res) => {
    requests++;
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  const f = await fixture(t, base);
  const gate = new InferenceGate();
  const releaseText = await gate.acquire();
  const first = f.make();
  first.context.acquireInference = (signal) => gate.acquire(signal);
  const waiting = first.tools.invoke('generate_image', { prompt: 'Deny before admission' });
  const denied = assert.rejects(waiting, /current network permission/);
  await until(() => gate.state.waiting === 1, 'first image waits');
  const second = f.make();
  second.context.acquireInference = (signal) => gate.acquire(signal);
  const cancelled = second.tools.invoke('generate_image', { prompt: 'Cancel before admission' });
  const stopped = assert.rejects(cancelled, /abort|cancel|stopped/i);
  await until(
    () =>
      f.store
        .list<OperationRecord>('operations')
        .some((operation) => operation.taskId === second.task.id && operation.status === 'started'),
    'second image waits in image queue',
  );
  assert.equal(gate.state.waiting, 1);
  second.abort.abort();
  await stopped;
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    permissions: { shell: 'deny', fileWrite: 'deny', network: 'deny' },
  });
  releaseText();
  await denied;
  assert.equal(requests, 0);
  assert.deepEqual(gate.state, { active: 0, waiting: 0 });
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    permissions: { shell: 'deny', fileWrite: 'deny', network: 'allow' },
  });
  await f.make().tools.invoke('generate_image', { prompt: 'Allowed fresh image' });
  assert.equal(requests, 1);
});

test('separate hardware may overlap a text slot while image requests remain serial and timeout is finite', async (t) => {
  const payloads: Array<Record<string, unknown>> = [];
  const base = await server(t, async (req, res) => {
    const body = await jsonBody(req);
    payloads.push(body);
    if (body.prompt === 'Timeout fixture') return;
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  const f = await fixture(t, base);
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    images: {
      ...f.store.settings().images!,
      shareInferenceSlot: false,
      responseFormat: 'b64_json',
      timeoutSeconds: 5,
    },
  });
  const run = f.make();
  run.context.acquireInference = async () => {
    throw new Error('Must not use shared hardware slot');
  };
  await run.tools.invoke('generate_image', { prompt: 'Independent image', size: 'auto' });
  assert.equal(payloads[0].response_format, 'b64_json');
  assert.equal(payloads[0].size, 'auto');
  run.context.settings.images!.timeoutSeconds = 1;
  await assert.rejects(
    run.tools.invoke('generate_image', { prompt: 'Timeout fixture' }),
    /abort|cancel|timeout/i,
  );
  run.context.settings.images!.timeoutSeconds = 5;
  await run.tools.invoke('generate_image', { prompt: 'Queue recovers' });
  assert.equal(payloads.length, 3);
});

test('URL outputs allow the configured private origin but block cross-origin private downloads and POST redirects', async (t) => {
  let foreignRequests = 0;
  const foreign = await server(t, (_req, res) => {
    foreignRequests++;
    res.end(png);
  });
  const requests: Array<{ url?: string; key?: string }> = [];
  const base = await server(t, async (req, res) => {
    requests.push({ url: req.url, key: req.headers.authorization });
    if (req.method === 'GET') {
      res.end(png);
      return;
    }
    const body = await jsonBody(req);
    if (body.prompt === 'Foreign private image')
      res.end(JSON.stringify({ data: [{ url: `${foreign}/private.png` }] }));
    else if (body.prompt === 'Redirect generation') {
      res.writeHead(307, { location: `${foreign}/generations` });
      res.end();
    } else res.end(JSON.stringify({ data: [{ url: '/generated/local.png' }] }));
  });
  const f = await fixture(t, base);
  const run = f.make();
  await run.tools.invoke('generate_image', { prompt: 'Local image URL' });
  assert.equal(requests[1].url, '/generated/local.png');
  assert.equal(requests[1].key, 'Bearer image-fixture-private-key');
  await assert.rejects(
    run.tools.invoke('generate_image', { prompt: 'Foreign private image' }),
    /private or reserved/,
  );
  await assert.rejects(
    run.tools.invoke('generate_image', { prompt: 'Redirect generation' }),
    /redirected/,
  );
  assert.equal(foreignRequests, 0);
});

test('invalid image output, oversized responses and symlink attachment paths are rejected', async (t) => {
  const base = await server(t, async (req, res) => {
    const body = await jsonBody(req);
    if (body.prompt === 'Oversized response') {
      res.writeHead(200, { 'content-length': String(40 * 1024 * 1024) });
      res.end('{}');
    } else if (body.prompt === 'Invalid base64')
      res.end(JSON.stringify({ data: [{ b64_json: 'not!base64' }] }));
    else if (body.prompt === 'SVG response')
      res.end(
        JSON.stringify({
          data: [
            {
              b64_json: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString(
                'base64',
              ),
            },
          ],
        }),
      );
    else res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  const f = await fixture(t, base);
  const run = f.make();
  await assert.rejects(
    run.tools.invoke('generate_image', { prompt: 'Invalid base64' }),
    /invalid base64/,
  );
  await assert.rejects(
    run.tools.invoke('generate_image', { prompt: 'SVG response' }),
    /PNG, JPEG, or WebP/,
  );
  await assert.rejects(
    run.tools.invoke('generate_image', { prompt: 'Oversized response' }),
    /size limit/,
  );
  assert.throws(
    () =>
      imageGenerationRequest(run.context.settings, { prompt: 'Invalid size', size: '8192x8192' }),
    /dimensions/,
  );
  assert.throws(() => imageMimeType(Buffer.from('not an image')), /PNG, JPEG, or WebP/);
  await run.tools.invoke('generate_image', { prompt: 'Valid image' });
  const image = f.store.get<Message>('messages', run.message.id)!.attachments![0];
  await assert.rejects(
    readGeneratedImage(f.dataDir, { ...image, id: '../secret.key' }),
    /Invalid generated image/,
  );
  if (process.platform !== 'win32') {
    const stored = join(f.dataDir, 'generated-images', `${image.id}.png`);
    const outside = join(f.dataDir, 'outside.png');
    await writeFile(outside, png);
    await rm(stored);
    await symlink(outside, stored);
    await assert.rejects(readGeneratedImage(f.dataDir, image), /symbolic links/);
  }
});

test(
  'co-resident image and language endpoints let another bot finish text while image requests remain serial',
  { timeout: 30_000 },
  async (t) => {
    let firstImageResponse: ServerResponse | undefined;
    let activeImages = 0;
    let maximumImages = 0;
    const imageBodies: Record<string, unknown>[] = [];
    const modelRequests: Array<{ marker: string; afterTool: boolean }> = [];
    // Both endpoints live on the same origin: independent admission depends on
    // the saved overlap setting, not a claim that a second machine is present.
    const base = await server(t, async (req, res) => {
      const body = await jsonBody(req);
      if (req.url === '/v1/images/generations') {
        assert.equal(req.headers.authorization, 'Bearer image-fixture-private-key');
        imageBodies.push(body);
        activeImages++;
        maximumImages = Math.max(maximumImages, activeImages);
        res.once('finish', () => activeImages--);
        if (body.prompt === 'FIRST_HELD_IMAGE') firstImageResponse = res;
        else {
          assert.equal(body.prompt, 'SECOND_QUEUED_IMAGE');
          res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
        }
        return;
      }
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer different-language-model-key');
      const messages = body.messages as Array<{ role: string; content?: unknown }>;
      const content = messages.findLast((message) => message.role === 'user')!.content;
      const text =
        typeof content === 'string'
          ? content
          : (content as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
      const marker = text.split('\n\nCurrent request:\n').at(-1)!;
      const afterTool = messages.at(-1)?.role === 'tool';
      modelRequests.push({ marker, afterTool });
      const textOnly = marker === 'PARALLEL_TEXT_ONLY';
      assert.ok(textOnly || ['PARALLEL_FIRST_IMAGE', 'PARALLEL_SECOND_IMAGE'].includes(marker));
      const answer = textOnly || afterTool;
      const delta = answer
        ? {
            content: textOnly
              ? 'Text finished while the image was still generating.'
              : 'Image finished.',
          }
        : {
            tool_calls: [
              {
                index: 0,
                id: `image-${marker}`,
                type: 'function',
                function: {
                  name: 'generate_image',
                  arguments: JSON.stringify({
                    prompt:
                      marker === 'PARALLEL_FIRST_IMAGE'
                        ? 'FIRST_HELD_IMAGE'
                        : 'SECOND_QUEUED_IMAGE',
                  }),
                },
              },
            ],
          };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choice of [
        { index: 0, delta, finish_reason: null },
        { index: 0, delta: {}, finish_reason: answer ? 'stop' : 'tool_calls' },
      ])
        res.write(
          `data: ${JSON.stringify({ id: 'co-resident-fixture', object: 'chat.completion.chunk', created: 1, model: 'language-fixture', choices: [choice] })}\n\n`,
        );
      res.end('data: [DONE]\n\n');
    });
    const f = await fixture(t, base, true);
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      inference: { maxConcurrentRequests: 1 },
      model: {
        ...f.store.settings().model,
        baseUrl: `${base}/v1`,
        modelId: 'language-fixture',
        responseTimeoutSeconds: 2,
        idleTimeoutSeconds: 2,
      },
      images: { ...f.store.settings().images!, timeoutSeconds: 3600, shareInferenceSlot: false },
    });
    f.store.patch('rooms', 'room_lounge', { parallelResponses: true });
    const start = (botId: string, prompt: string) =>
      f.controller.enqueueTask({ roomId: 'room_lounge', botId, prompt });
    const current = (task: Task) => f.store.get<Task>('tasks', task.id)!;
    const done = async (task: Task) => {
      await until(() => ['completed', 'failed'].includes(current(task).status), task.prompt);
      assert.equal(current(task).status, 'completed', current(task).error);
    };
    const first = start('bot_aster', 'PARALLEL_FIRST_IMAGE');
    await until(() => Boolean(firstImageResponse), 'first image request is held');
    assert.equal(current(first).status, 'waiting_tool');
    const text = start('bot_nova', 'PARALLEL_TEXT_ONLY');
    await done(text);
    assert.match(current(text).output!, /Text finished while the image was still generating/);
    assert.equal(firstImageResponse!.writableEnded, false);
    assert.equal(imageBodies.length, 1);

    const second = start('bot_nova', 'PARALLEL_SECOND_IMAGE');
    await until(
      () =>
        f.store
          .list<OperationRecord>('operations')
          .some((operation) => operation.taskId === second.id && operation.status === 'started'),
      'second bot reaches the shared image queue',
    );
    // A tool wait can exceed a model response/idle budget; those budgets apply
    // only while its own model request is active, not to the image operation.
    await delay(2100);
    assert.equal(current(first).status, 'waiting_tool');
    assert.equal(imageBodies.length, 1);
    assert.equal(f.runtime.queueState().active, 0, 'waiting images occupy no language slot');
    firstImageResponse!.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    await Promise.all([done(first), done(second)]);
    assert.equal(maximumImages, 1);
    assert.deepEqual(
      imageBodies,
      ['FIRST_HELD_IMAGE', 'SECOND_QUEUED_IMAGE'].map((prompt) => ({
        model: 'local-image-fixture',
        prompt,
        n: 1,
        size: '2048x2048',
      })),
    );
    assert.equal(modelRequests.filter((request) => request.marker === first.prompt).length, 2);
    assert.equal(modelRequests.filter((request) => request.marker === text.prompt).length, 1);
    assert.equal(modelRequests.filter((request) => request.marker === second.prompt).length, 2);
    assert.equal(f.store.list<OperationRecord>('operations').length, 2);
    assert.ok(
      f.store
        .list<OperationRecord>('operations')
        .every((operation) => operation.status === 'completed'),
    );
    assert.equal(f.runtime.queueState().active, 0);
    assert.equal(f.runtime.queueState().waiting, 0);
  },
);

test(
  'real Pi calls the image model, then answers with a durable authenticated image attachment',
  { timeout: 25_000 },
  async (t) => {
    let imageRequests = 0;
    const imageBase = await server(t, async (req, res) => {
      await jsonBody(req);
      imageRequests++;
      assert.equal(req.headers.authorization, 'Bearer image-fixture-private-key');
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
    const modelBodies: Array<Record<string, unknown>> = [];
    const modelBase = await server(t, async (req, res) => {
      assert.equal(req.headers.authorization, 'Bearer different-language-model-key');
      const body = await jsonBody(req);
      modelBodies.push(body);
      const messages = body.messages as Array<{ role: string; content?: unknown }>;
      const afterTool = messages.at(-1)?.role === 'tool';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = afterTool
        ? { content: 'The generated image is attached.' }
        : {
            tool_calls: [
              {
                index: 0,
                id: 'image-call',
                type: 'function',
                function: {
                  name: 'generate_image',
                  arguments: JSON.stringify({ prompt: 'A tiny test image' }),
                },
              },
            ],
          };
      for (const choice of [
        { index: 0, delta, finish_reason: null },
        { index: 0, delta: {}, finish_reason: afterTool ? 'stop' : 'tool_calls' },
      ])
        res.write(
          `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'language-fixture', choices: [choice] })}\n\n`,
        );
      res.end('data: [DONE]\n\n');
    });
    const f = await fixture(t, imageBase, true, 'test-app-token');
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      model: {
        ...f.store.settings().model,
        baseUrl: `${modelBase}/v1`,
        modelId: 'language-fixture',
      },
    });
    const task = f.controller.enqueueTask({
      roomId: 'room_lounge',
      botId: 'bot_aster',
      prompt: 'Generate an image, then explain that it is attached.',
    });
    await until(
      () => ['completed', 'failed'].includes(f.store.get<Task>('tasks', task.id)!.status),
      'real Pi image task',
    );
    const done = f.store.get<Task>('tasks', task.id)!;
    assert.equal(done.status, 'completed', done.error);
    assert.equal(imageRequests, 1);
    assert.equal(modelBodies.length, 2);
    assert.ok(!JSON.stringify(modelBodies).includes(png.toString('base64')));
    const message = f.store.list<Message>('messages').find((m) => m.taskId === task.id)!;
    assert.match(message.body, /generated image is attached/);
    const image = message.attachments![0];
    assert.deepEqual(await readGeneratedImage(f.dataDir, image), png);
    const unauthenticated = await f.app.inject({ method: 'GET', url: `/api/images/${image.id}` });
    assert.equal(unauthenticated.statusCode, 401);
    const authenticated = await f.app.inject({
      method: 'GET',
      url: `/api/images/${image.id}`,
      headers: { authorization: 'Bearer test-app-token' },
    });
    assert.equal(authenticated.statusCode, 200, authenticated.body);
    assert.equal(authenticated.headers['content-type'], 'image/png');
    assert.deepEqual(authenticated.rawPayload, png);
    assert.equal(authenticated.headers['x-content-type-options'], 'nosniff');
  },
);
