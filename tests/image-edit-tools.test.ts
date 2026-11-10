import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { createTools } from '../src/server/runtime/tools.js';
import { readGeneratedImage, saveRasterImage } from '../src/server/runtime/images.js';
import type { OperationRecord, ToolContext } from '../src/server/runtime/contract.js';
import type { Approval, GeneratedImage, Message, Room, Task } from '../src/shared/types.js';
import { DEFAULT_IMAGE_SETTINGS, IMAGE_STEP_PARAMETERS } from '../src/shared/model-settings.js';
import { DEFAULT_AUTONOMOUS_WAKEUP_POLICY } from '../src/shared/work.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6cAAAAASUVORK5CYII=',
  'base64',
);
const otherPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function server(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
) {
  const http = createServer((request, response) => {
    void handler(request, response).catch((error) => response.destroy(error as Error));
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
  return `http://127.0.0.1:${address.port}/v1`;
}

async function multipart(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new Response(Buffer.concat(chunks), {
    headers: { 'content-type': request.headers['content-type']! },
  }).formData();
}

function complete(response: ServerResponse) {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
}

async function fixture(t: TestContext, baseUrl: string, realRuntime = false) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-image-edits-'));
  const f = await createApp({
    dataDir,
    scheduler: false,
    ...(realRuntime
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
  const settings = f.store.settings();
  f.store.put('settings', {
    ...settings,
    id: 'main',
    demoMode: !realRuntime,
    model: { ...settings.model, imageInput: false },
    autoLearn: false,
    images: {
      ...DEFAULT_IMAGE_SETTINGS,
      enabled: true,
      baseUrl,
      modelId: 'qwen-fixture',
      timeoutSeconds: 5,
      permission: 'allow',
    },
    permissions: { network: 'allow', shell: 'deny', fileWrite: 'deny' },
  });
  f.store.setSecret('image.apiKey', 'private-edit-key');
  await writeFile(join(settings.workspacePath, 'source.png'), png);
  await writeFile(join(settings.workspacePath, 'reference.png'), otherPng);
  await writeFile(join(settings.workspacePath, 'mask.png'), png);
  const make = (taskInput: Partial<Task> = {}) => {
    const task = f.controller.enqueueTask({
      roomId: 'room_lounge',
      botId: 'bot_aster',
      prompt: 'Edit the supplied image.',
      ...taskInput,
    });
    const message = f.controller.addMessage({
      roomId: task.roomId,
      authorType: 'bot',
      authorId: task.botId,
      taskId: task.id,
      body: '',
      status: 'streaming',
    });
    const context: ToolContext = {
      host: f.controller,
      task,
      settings: f.store.settings(),
      signal: new AbortController().signal,
      operationKeys: new Set(),
    };
    return { task, message, context, tools: createTools(context) };
  };
  const attach = async (roomId = 'room_lounge') => {
    if (!f.store.get<Room>('rooms', roomId))
      f.store.put<Room>('rooms', { ...f.store.get<Room>('rooms', 'room_lounge')!, id: roomId });
    const image: GeneratedImage = {
      id: `img_${hash(Buffer.from(`${roomId}-upload`))}`,
      type: 'image',
      source: 'uploaded',
      filename: 'source.png',
      mimeType: 'image/png',
      byteLength: png.length,
      prompt: '',
      model: '',
      createdAt: new Date().toISOString(),
    };
    await saveRasterImage(dataDir, image, png, new AbortController().signal);
    f.controller.addMessage({
      roomId,
      authorType: 'user',
      authorId: 'user',
      body: 'Source image',
      status: 'complete',
      attachments: [image],
    });
    return image;
  };
  return { ...f, dataDir, make, attach };
}

test('reference generation sends ordered real files through edits while retaining new-generation intent', async (t) => {
  const requests: { path?: string; authorization?: string; form: FormData }[] = [];
  const base = await server(t, async (req, res) => {
    requests.push({
      path: req.url,
      authorization: req.headers.authorization,
      form: await multipart(req),
    });
    complete(res);
  });
  const f = await fixture(t, base);
  const uploaded = await f.attach();
  const run = f.make();
  assert.equal(
    run.tools.definitions.some((tool) => tool.name === 'view_image'),
    false,
  );
  await run.tools.invoke('generate_image', {
    prompt: 'Make a new composition using these two references.',
    referenceImages: [{ imageId: uploaded.id }, { path: 'reference.png' }],
  });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.path, '/v1/images/edits');
  assert.equal(request.authorization, 'Bearer private-edit-key');
  assert.equal(request.form.get('model'), 'qwen-fixture');
  assert.equal(request.form.get('size'), '2048x2048');
  assert.equal(request.form.get('n'), '1');
  assert.equal(request.form.get('mask'), null);
  const files = request.form.getAll('image[]') as File[];
  assert.deepEqual(
    await Promise.all(files.map(async (file) => Buffer.from(await file.arrayBuffer()))),
    [png, otherPng],
  );
  const image = f.store.get<Message>('messages', run.message.id)!.attachments![0];
  assert.equal(image.operation, 'generate');
  assert.deepEqual(image.inputImages, [
    { role: 'reference', imageId: uploaded.id, sha256: hash(png) },
    { role: 'reference', path: 'reference.png', sha256: hash(otherPng) },
  ]);
  assert.doesNotMatch(JSON.stringify(f.controller.getSnapshot()), /private-edit-key|data:image/);
  assert.ok(!JSON.stringify(f.store.list('operations')).includes(png.toString('base64')));
});

test('editing preserves its uploaded source, sends source first plus mask, and records a separate output', async (t) => {
  let form: FormData | undefined;
  const base = await server(t, async (req, res) => {
    form = await multipart(req);
    complete(res);
  });
  const f = await fixture(t, base);
  const source = await f.attach();
  const run = f.make();
  const text = await run.tools.invoke('edit_image', {
    prompt: 'Change only the marked background.',
    sourceImage: { imageId: source.id },
    referenceImages: [{ path: 'reference.png' }],
    mask: { path: 'mask.png' },
  });
  assert.ok(form);
  assert.equal(form.get('size'), null, 'source dimensions are inferred when edit size is omitted');
  const inputs = form.getAll('image[]') as File[];
  assert.deepEqual(
    await Promise.all(inputs.map(async (file) => Buffer.from(await file.arrayBuffer()))),
    [png, otherPng],
  );
  assert.deepEqual(Buffer.from(await (form.get('mask') as File).arrayBuffer()), png);
  assert.equal(form.get('prompt'), 'Change only the marked background.');
  const edited = f.store.get<Message>('messages', run.message.id)!.attachments![0];
  assert.equal(edited.operation, 'edit');
  assert.match(edited.filename, /^edited-/);
  assert.notEqual(edited.id, source.id);
  assert.deepEqual(
    edited.inputImages?.map((image) => image.role),
    ['source', 'reference', 'mask'],
  );
  assert.equal(edited.inputImages?.[0].imageId, source.id);
  assert.deepEqual(await readGeneratedImage(f.dataDir, source), png);
  assert.deepEqual(await readFile(join(f.store.settings().workspacePath, 'source.png')), png);
  assert.match(text, /Edited image saved/);
});

for (const stepsParameter of IMAGE_STEP_PARAMETERS)
  test(`edit sampling preserves ${stepsParameter} transport, step override and explicit size`, async (t) => {
    let form: FormData | undefined;
    const base = await server(t, async (req, res) => {
      form = await multipart(req);
      complete(res);
    });
    const f = await fixture(t, base);
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      images: {
        ...f.store.settings().images!,
        steps: 40,
        stepsParameter,
        responseFormat: 'b64_json',
      },
    });
    const prompt = 'Keep the lettering.\n背景を青に。  ';
    await f.make().tools.invoke('edit_image', {
      prompt,
      sourceImage: { path: 'source.png' },
      steps: 17,
      size: '1024x1536',
    });
    assert.ok(form);
    assert.equal(form.get('size'), '1024x1536');
    assert.equal(form.get('response_format'), 'b64_json');
    assert.equal(
      form.get('prompt'),
      stepsParameter === 'sd_cpp_extra_args'
        ? `${prompt}<sd_cpp_extra_args>{"sample_params":{"sample_steps":17}}</sd_cpp_extra_args>`
        : prompt,
    );
    for (const name of IMAGE_STEP_PARAMETERS.filter((name) => name !== 'sd_cpp_extra_args'))
      assert.equal(form.get(name), name === stepsParameter ? '17' : null);
    assert.equal(f.store.settings().images?.steps, 40);
  });

test('approval reviews fingerprints and the queued edit retains the exact pre-approval pixels', async (t) => {
  let sent: Buffer | undefined;
  const base = await server(t, async (req, res) => {
    sent = Buffer.from(await ((await multipart(req)).get('image[]') as File).arrayBuffer());
    complete(res);
  });
  const f = await fixture(t, base);
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    images: { ...f.store.settings().images!, permission: 'ask' },
  });
  let reviewed: Omit<Approval, 'id' | 'createdAt' | 'status'> | undefined;
  t.mock.method(f.controller, 'requestApproval', async (approval: typeof reviewed) => {
    reviewed = approval;
    await writeFile(join(f.store.settings().workspacePath, 'source.png'), otherPng);
    return true;
  });
  await f.make().tools.invoke('edit_image', {
    prompt: 'Change the background.',
    sourceImage: { path: 'source.png' },
  });
  assert.equal(reviewed?.toolName, 'edit_image');
  assert.deepEqual(reviewed?.args.inputImages, [
    { role: 'source', path: 'source.png', sha256: hash(png) },
  ]);
  assert.equal(reviewed?.target, `${base}/images/edits`);
  assert.ok(!JSON.stringify(reviewed).includes(png.toString('base64')));
  assert.deepEqual(sent, png);
});

test('completed edits restore without rereading a removed source or making another request', async (t) => {
  let requests = 0;
  const base = await server(t, async (req, res) => {
    await multipart(req);
    requests++;
    complete(res);
  });
  const f = await fixture(t, base);
  const run = f.make();
  const args = { prompt: 'Change the background.', sourceImage: { path: 'source.png' } };
  await run.tools.invoke('edit_image', args);
  const output = f.store.get<Message>('messages', run.message.id)!.attachments![0];
  await rm(join(f.store.settings().workspacePath, 'source.png'));
  const restored = await createTools(run.context).invoke('edit_image', args);
  assert.match(restored, /without another request/);
  assert.ok(restored.includes(output.id));
  assert.equal(requests, 1);
  assert.equal(f.store.get<Message>('messages', run.message.id)!.attachments!.length, 1);
});

test('a prepared but unissued edit rejects changed workspace pixels on restart', async (t) => {
  let requests = 0;
  const base = await server(t, async (req, res) => {
    await multipart(req);
    requests++;
    complete(res);
  });
  const f = await fixture(t, base);
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    images: { ...f.store.settings().images!, permission: 'ask' },
  });
  let reviews = 0;
  t.mock.method(f.controller, 'requestApproval', async () => {
    reviews++;
    return false;
  });
  const run = f.make();
  const args = { prompt: 'Change the background.', sourceImage: { path: 'source.png' } };
  await assert.rejects(run.tools.invoke('edit_image', args), /denied or cancelled/);
  await writeFile(join(f.store.settings().workspacePath, 'source.png'), otherPng);
  await assert.rejects(createTools(run.context).invoke('edit_image', args), /input image changed/i);
  assert.equal(reviews, 1);
  assert.equal(requests, 0);
});

test('unsupported edit requests fail honestly without text-only fallback or uncertain retries', async (t) => {
  const paths: string[] = [];
  const base = await server(t, async (req, res) => {
    paths.push(req.url!);
    await multipart(req);
    res.statusCode = 404;
    res.end('unsupported');
  });
  const f = await fixture(t, base);
  const run = f.make();
  const args = { prompt: 'Edit this image.', sourceImage: { path: 'source.png' } };
  await assert.rejects(
    run.tools.invoke('edit_image', args),
    /HTTP 404.*\/images\/edits.*vision weights/,
  );
  await rm(join(f.store.settings().workspacePath, 'source.png'));
  await assert.rejects(createTools(run.context).invoke('edit_image', args), /uncertain or failed/);
  assert.deepEqual(paths, ['/v1/images/edits']);
});

test('edit input validation keeps room and workspace boundaries before any image request', async (t) => {
  let requests = 0;
  const base = await server(t, async (req, res) => {
    requests++;
    req.resume();
    complete(res);
  });
  const f = await fixture(t, base);
  const foreign = await f.attach('another-room');
  const run = f.make();
  for (const args of [
    { prompt: 'Edit.' },
    { prompt: 'Edit.', sourceImage: { imageId: foreign.id } },
    { prompt: 'Edit.', sourceImage: { path: '../outside.png' } },
    { prompt: 'Edit.', sourceImage: { path: '/absolute.png' } },
    { prompt: 'Edit.', sourceImage: { path: 'https://example.test/image.png' } },
    { prompt: 'Edit.', sourceImage: { imageId: `img_${'a'.repeat(64)}`, path: 'source.png' } },
    { prompt: 'Edit.', sourceImage: { path: 'source.png', data: png.toString('base64') } },
    {
      prompt: 'Edit.',
      sourceImage: { path: 'source.png' },
      referenceImages: Array.from({ length: 10 }, () => ({ path: 'reference.png' })),
    },
  ])
    await assert.rejects(run.tools.invoke('edit_image', args));
  await assert.rejects(
    run.tools.invoke('generate_image', {
      prompt: 'Generate.',
      sourceImage: { path: 'source.png' },
    }),
    /Unrecognized/,
  );
  assert.equal(requests, 0);
  assert.equal(f.store.list('operations').length, 0);
  assert.ok(!JSON.stringify(f.store.list('activities')).includes(png.toString('base64')));
});

test('edit uses the bot image permission with network denial as the ceiling', async (t) => {
  const f = await fixture(t, 'http://127.0.0.1:1/v1');
  for (const [network, permission] of [
    ['allow', 'deny'],
    ['deny', 'allow'],
  ] as const) {
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      permissions: { ...f.store.settings().permissions, network },
      images: { ...f.store.settings().images!, permission },
    });
    // Denial is checked before reading even this nonexistent input.
    await assert.rejects(
      f
        .make()
        .tools.invoke('edit_image', { prompt: 'Edit.', sourceImage: { path: 'missing.png' } }),
      /disabled/,
    );
  }
  assert.equal(f.store.list('operations').length, 0);
});

test('an edit waiting behind generation shares its queue and checks a revoked image permission', async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(release);
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paths: string[] = [];
  const base = await server(t, async (req, res) => {
    paths.push(req.url!);
    req.resume();
    entered();
    await held;
    complete(res);
  });
  const f = await fixture(t, base);
  const generating = f.make().tools.invoke('generate_image', { prompt: 'First image.' });
  await firstEntered;
  const editing = f
    .make()
    .tools.invoke('edit_image', { prompt: 'Next edit.', sourceImage: { path: 'source.png' } });
  const rejected = assert.rejects(editing, /current bot image permission/);
  const deadline = Date.now() + 5_000;
  while (
    !f.store
      .list<OperationRecord>('operations')
      .some((record) => record.toolName === 'edit_image' && record.status === 'started')
  ) {
    if (Date.now() > deadline) throw new Error('Edit did not enter its shared image queue.');
    await delay(5);
  }
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    images: { ...f.store.settings().images!, permission: 'deny' },
  });
  release();
  await Promise.all([generating, rejected]);
  assert.deepEqual(paths, ['/v1/images/generations']);
});

test('work continuations restore image-input bindings and edited output after mutable sources change', async (t) => {
  let requests = 0;
  const base = await server(t, async (req, res) => {
    await multipart(req);
    requests++;
    complete(res);
  });
  const f = await fixture(t, base);
  f.store.patch<Room>('rooms', 'room_lounge', {
    autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room' },
  });
  const first = f.make();
  const work = f.controller.manageWakeup(first.task.id, {
    operation: 'upsert',
    key: 'image-review',
    name: 'Review image',
    purpose: 'Review the revised image.',
    reason: 'Review the result later.',
    prompt: 'Review the saved image.',
    schedule: {
      type: 'once',
      dateTime: '2099-06-15T09:00',
      timeZone: 'Asia/Tokyo',
      missedRunPolicy: 'run_once',
    },
    checkpoint: {
      summary: 'Preparing the revised image.',
      completed: 'Selected the source.',
      nextStep: 'Review the result.',
      references: ['source.png'],
      doneWhen: 'The image is reviewed.',
      uncertainActions: [],
    },
  }).work;
  const args = { prompt: 'Change the background.', sourceImage: { path: 'source.png' } };
  await first.tools.invoke('edit_image', args);
  await writeFile(join(f.store.settings().workspacePath, 'source.png'), otherPng);
  const next = f.make({ parentTaskId: first.task.id });
  assert.equal(f.store.get<Task>('tasks', next.task.id)?.workId, work.id);
  assert.match(await next.tools.invoke('edit_image', args), /without another request/);
  assert.equal(requests, 1);
});

test(
  'real Pi calls edit_image with an uploaded source and receives a saved revision receipt',
  { timeout: 25_000 },
  async (t) => {
    let imageRequests = 0;
    const imageBase = await server(t, async (req, res) => {
      assert.equal(req.url, '/v1/images/edits');
      const form = await multipart(req);
      assert.deepEqual(Buffer.from(await (form.get('image[]') as File).arrayBuffer()), png);
      imageRequests++;
      complete(res);
    });
    let sourceId = '';
    const modelBodies: Array<Record<string, unknown>> = [];
    const modelBase = await server(t, async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      modelBodies.push(body);
      const messages = body.messages as Array<{ role: string; content?: unknown }>;
      const afterTool = messages.at(-1)?.role === 'tool';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = afterTool
        ? { content: 'The edited image is attached.' }
        : {
            tool_calls: [
              {
                index: 0,
                id: 'edit-fixture',
                type: 'function',
                function: {
                  name: 'edit_image',
                  arguments: JSON.stringify({
                    prompt: 'Change the background.',
                    sourceImage: { imageId: sourceId },
                  }),
                },
              },
            ],
          };
      for (const choice of [
        { index: 0, delta, finish_reason: null },
        { index: 0, delta: {}, finish_reason: afterTool ? 'stop' : 'tool_calls' },
      ])
        res.write(
          `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'edit-language-fixture', choices: [choice] })}\n\n`,
        );
      res.end('data: [DONE]\n\n');
    });
    const f = await fixture(t, imageBase, true);
    sourceId = (await f.attach()).id;
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      model: { ...f.store.settings().model, baseUrl: modelBase, modelId: 'edit-language-fixture' },
    });
    const task = f.controller.enqueueTask({
      roomId: 'room_lounge',
      botId: 'bot_aster',
      prompt: `Edit image ${sourceId}.`,
    });
    const deadline = Date.now() + 15_000;
    while (!['completed', 'failed'].includes(f.store.get<Task>('tasks', task.id)!.status)) {
      if (Date.now() > deadline) throw new Error('Real Pi edit task did not complete.');
      await delay(10);
    }
    const done = f.store.get<Task>('tasks', task.id)!;
    assert.equal(done.status, 'completed', done.error);
    assert.equal(imageRequests, 1);
    assert.equal(modelBodies.length, 2);
    assert.ok(!JSON.stringify(modelBodies).includes(png.toString('base64')));
    const reply = f.store.list<Message>('messages').find((message) => message.taskId === task.id)!;
    assert.match(reply.body, /edited image is attached/);
    assert.equal(reply.attachments?.[0].operation, 'edit');
    assert.equal(reply.attachments?.[0].inputImages?.[0].imageId, sourceId);
  },
);
