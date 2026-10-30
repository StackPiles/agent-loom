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
  imageGenerationRequest,
  imageMimeType,
  readGeneratedImage,
} from '../src/server/runtime/images.js';
import { InferenceGate } from '../src/server/runtime/gate.js';
import type { OperationRecord, ToolContext } from '../src/server/runtime/contract.js';
import type { Approval, Message, Task } from '../src/shared/types.js';
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
    size: '1024x1024',
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
