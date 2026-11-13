import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32 } from 'node:zlib';
import { createApp } from '../src/server/app.js';
import { createTools, operationKey } from '../src/server/runtime/tools.js';
import {
  generateImage,
  imageGenerationPermission,
  imageGenerationRequest,
  imageMimeType,
  readGeneratedImage,
} from '../src/server/runtime/images.js';
import { refreshImagePreferences } from '../src/server/runtime/model-image-input.js';
import { InferenceGate, InferenceRescheduledError } from '../src/server/runtime/gate.js';
import type { OperationRecord, ToolContext } from '../src/server/runtime/contract.js';
import type { Approval, ImageSettings, Message, Permission, Task } from '../src/shared/types.js';
import { DEFAULT_IMAGE_SETTINGS, IMAGE_STEP_PARAMETERS } from '../src/shared/model-settings.js';

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
      shareInferenceSlot: true,
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
  const legacyArgs = {
    prompt: args.prompt,
    size: '2048x2048',
    model: 'local-image-fixture',
    endpoint: `${base}/v1/images/generations`,
  };
  const operation = f.store.list<OperationRecord>('operations')[0];
  assert.deepEqual(operation.args, legacyArgs, 'server-default steps preserve pre-upgrade args');
  assert.equal(operation.key, operationKey(run.task.id, 'generate_image', legacyArgs));
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

test('per-call image sampling survives preparation and overrides the saved count on the wire', async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const base = await server(t, async (req, res) => {
    requests.push(await jsonBody(req));
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  const f = await fixture(t, base);
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    images: { ...f.store.settings().images!, steps: 40, stepsParameter: 'sd_cpp_extra_args' },
  });
  const before = f.store.settings();
  const run = f.make();
  const args = { prompt: 'A small blue circle.', steps: 17 };
  const prepared = imageGenerationRequest(run.context.settings, args);
  await generateImage(run.context, prepared.args, `img_${'a'.repeat(64)}`, 'allow');
  assert.deepEqual(requests, [
    {
      model: 'local-image-fixture',
      prompt: `${args.prompt}<sd_cpp_extra_args>{"sample_params":{"sample_steps":17}}</sd_cpp_extra_args>`,
      n: 1,
      size: '2048x2048',
    },
  ]);
  assert.deepEqual(prepared.args, { ...args, size: '2048x2048' });
  assert.deepEqual(f.store.settings(), before, 'A per-call override cannot change saved settings');
});

for (const stepsParameter of IMAGE_STEP_PARAMETERS) {
  test(`image sampling uses only the selected ${stepsParameter} format and keeps the original prompt`, async (t) => {
    const requests: Array<Record<string, unknown>> = [];
    const base = await server(t, async (req, res) => {
      requests.push(await jsonBody(req));
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
    const f = await fixture(t, base);
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      images: { ...f.store.settings().images!, steps: 40, stepsParameter },
    });
    const run = f.make();
    const prompt = 'A blue circle, a "white" border.\n背景は淡い灰色。  ';
    await run.tools.invoke('generate_image', { prompt });
    assert.equal(requests.length, 1);
    const expected: Record<string, unknown> = {
      model: 'local-image-fixture',
      prompt,
      n: 1,
      size: '2048x2048',
    };
    if (stepsParameter === 'sd_cpp_extra_args') {
      const wirePrompt = requests[0].prompt as string;
      const tags = [...wirePrompt.matchAll(/<sd_cpp_extra_args>(.*?)<\/sd_cpp_extra_args>/g)];
      assert.equal(tags.length, 1, 'upstream first-match parser receives one extension');
      assert.deepEqual(JSON.parse(tags[0][1]), { sample_params: { sample_steps: 40 } });
      assert.equal(
        wirePrompt.replace(/<sd_cpp_extra_args>(.*?)<\/sd_cpp_extra_args>/g, ''),
        prompt,
      );
      expected.prompt = wirePrompt;
    } else expected[stepsParameter] = 40;
    assert.deepEqual(requests[0], expected, 'no other step aliases or body extensions are sent');
    const operation = f.store.list<OperationRecord>('operations')[0];
    assert.equal(operation.args.prompt, prompt);
    assert.equal(operation.args.steps, 40);
    assert.equal(operation.args.stepsParameter, stepsParameter);
    const image = f.store.get<Message>('messages', run.message.id)!.attachments![0];
    assert.equal(image.prompt, prompt, 'saved image metadata keeps the owner-reviewed prompt');
    await createTools(run.context).invoke('generate_image', { prompt });
    assert.equal(requests.length, 1, 'an exact completed step request is restored on resume');
  });

  test(`per-call image steps override saved and server-default counts using only ${stepsParameter}`, async (t) => {
    const requests: Array<Record<string, unknown>> = [];
    const base = await server(t, async (req, res) => {
      requests.push(await jsonBody(req));
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
    const f = await fixture(t, base);
    for (const [savedSteps, steps] of [
      [40, 17],
      [null, 23],
    ] as const) {
      f.store.put('settings', {
        ...f.store.settings(),
        id: 'main',
        images: { ...f.store.settings().images!, steps: savedSteps, stepsParameter },
      });
      const before = f.store.settings();
      const run = f.make();
      const prompt = 'A blue circle, with a "white" border.\n背景は淡い灰色。  ';
      const index = requests.length;
      await run.tools.invoke('generate_image', { prompt, steps });
      const expected: Record<string, unknown> = {
        model: 'local-image-fixture',
        prompt,
        n: 1,
        size: '2048x2048',
      };
      if (stepsParameter === 'sd_cpp_extra_args')
        expected.prompt = `${prompt}<sd_cpp_extra_args>${JSON.stringify({ sample_params: { sample_steps: steps } })}</sd_cpp_extra_args>`;
      else expected[stepsParameter] = steps;
      assert.deepEqual(requests[index], expected, 'Only the owner-selected format is sent');
      const operationArgs = {
        prompt,
        size: '2048x2048',
        model: 'local-image-fixture',
        endpoint: `${base}/v1/images/generations`,
        steps,
        stepsParameter,
      };
      const key = operationKey(run.task.id, 'generate_image', operationArgs);
      assert.deepEqual(f.controller.getOperation(key)?.args, operationArgs);
      const image = f.store.get<Message>('messages', run.message.id)!.attachments![0];
      assert.equal(image.prompt, prompt);
      assert.deepEqual(f.store.settings(), before, 'The override does not change saved settings');
      await createTools(run.context).invoke('generate_image', { prompt, steps });
      assert.equal(requests.length, index + 1, 'An exact completed override is not sent twice');
    }
  });
}

test('image receipts identify effective step counts while omission retains saved and legacy defaults', async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const base = await server(t, async (req, res) => {
    requests.push(await jsonBody(req));
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  const f = await fixture(t, base);
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    images: { ...f.store.settings().images!, steps: 40, stepsParameter: 'sd_cpp_extra_args' },
  });
  const run = f.make();
  const prompt = 'One prompt with inherited and explicit sampling.';
  const generate = (steps?: number) =>
    createTools(run.context).invoke('generate_image', { prompt, steps });
  await generate();
  assert.equal(requests.length, 1);
  assert.match(String(requests[0].prompt), /"sample_steps":40/);
  await generate(40);
  assert.equal(
    requests.length,
    1,
    'An explicit count equal to the saved default reuses the receipt',
  );
  await generate(17);
  assert.equal(requests.length, 2, 'A distinct effective count creates a distinct image request');
  assert.match(String(requests[1].prompt), /"sample_steps":17/);
  run.context.settings.images!.steps = 17;
  await generate();
  assert.equal(requests.length, 2, 'A newly matching saved default also reuses the exact receipt');
  run.context.settings.images!.steps = null;
  await generate();
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2], { model: 'local-image-fixture', prompt, n: 1, size: '2048x2048' });
  const legacyArgs = {
    prompt,
    size: '2048x2048',
    model: 'local-image-fixture',
    endpoint: `${base}/v1/images/generations`,
  };
  const legacyKey = operationKey(run.task.id, 'generate_image', legacyArgs);
  assert.deepEqual(f.controller.getOperation(legacyKey)?.args, legacyArgs);
  assert.deepEqual(
    imageGenerationRequest(run.context.settings, { prompt, steps: undefined }).args,
    { prompt, size: '2048x2048' },
  );
  delete run.context.settings.images!.steps;
  await generate();
  assert.equal(requests.length, 3, 'Legacy omitted defaults retain their exact request identity');
  assert.equal(f.store.list<OperationRecord>('operations').length, 3);
});

test('invalid per-call image steps reject before approval, journaling or direct HTTP dispatch', async (t) => {
  let requests = 0;
  const base = await server(t, (_req, res) => {
    requests++;
    res.end('{}');
  });
  const f = await fixture(t, base);
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    images: { ...f.store.settings().images!, steps: 40, permission: 'ask' },
  });
  const run = f.make();
  for (const steps of [
    null,
    0,
    -1,
    1.5,
    1001,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '17',
    false,
    true,
    [17],
    { value: 17 },
  ]) {
    const args = { prompt: 'No invalid sampling request.', steps: steps as number };
    assert.throws(
      () => imageGenerationRequest(run.context.settings, args),
      /sampling steps must be an integer/,
    );
    await assert.rejects(
      generateImage(run.context, args, `img_${'b'.repeat(64)}`, 'ask'),
      /sampling steps must be an integer/,
    );
    await assert.rejects(
      run.tools.invoke('generate_image', args),
      /sampling steps must be an integer/,
    );
  }
  run.context.settings.images!.steps = null;
  await assert.rejects(
    run.tools.invoke('generate_image', { prompt: 'No explicit null reset.', steps: null }),
    /sampling steps must be an integer/,
  );
  await assert.rejects(
    run.tools.invoke('generate_image', {
      prompt:
        'A circle <sd_cpp_extra_args>{"sample_params":{"sample_steps":40}}</sd_cpp_extra_args>',
      steps: 17,
    }),
    /already contains sd_cpp_extra_args/,
  );
  for (const steps of [1, 1000])
    assert.equal(
      imageGenerationRequest(run.context.settings, { prompt: 'A bounded count.', steps }).sampling
        ?.steps,
      steps,
    );
  assert.equal(requests, 0);
  assert.equal(f.store.list<Approval>('approvals').length, 0);
  assert.equal(f.store.list<OperationRecord>('operations').length, 0);
  assert.equal(f.store.settings().images!.steps, 40);
});

test('image journal identity distinguishes step counts and formats but ignores unused default formats', async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const base = await server(t, async (req, res) => {
    requests.push(await jsonBody(req));
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  const f = await fixture(t, base);
  const run = f.make();
  const args = { prompt: 'An identical prompt at different sampling settings.' };
  const generate = () => createTools(run.context).invoke('generate_image', args);
  delete run.context.settings.images!.steps;
  delete run.context.settings.images!.stepsParameter;
  await generate();
  assert.equal(requests.length, 1);
  run.context.settings.images!.steps = 40;
  await generate();
  assert.equal(
    requests.length,
    2,
    'an omitted explicit format uses the stable-diffusion.cpp default',
  );
  assert.match(requests[1].prompt as string, /<sd_cpp_extra_args>/);
  run.context.settings.images!.steps = 20;
  await generate();
  assert.equal(requests.length, 3, 'a different count is not mistaken for a completed request');
  run.context.settings.images!.stepsParameter = 'num_inference_steps';
  await generate();
  assert.equal(requests.length, 4, 'a different wire format is a distinct exact request');
  assert.equal(requests[3].num_inference_steps, 20);
  run.context.settings.images!.steps = null;
  await generate();
  assert.equal(requests.length, 4, 'explicit server default restores the legacy request');
  run.context.settings.images!.stepsParameter = 'sample_steps';
  await generate();
  assert.equal(requests.length, 4, 'an unused format cannot change a server-default journal key');
  const operations = f.store.list<OperationRecord>('operations');
  assert.equal(operations.length, 4);
  assert.equal(new Set(operations.map((operation) => operation.key)).size, 4);
});

test('explicit image sampling rejects conflicting prompt tags and invalid settings before review or dispatch', async (t) => {
  let requests = 0;
  const base = await server(t, (_req, res) => {
    requests++;
    res.end('{}');
  });
  const f = await fixture(t, base);
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    images: {
      ...f.store.settings().images!,
      permission: 'ask',
      steps: 40,
      stepsParameter: 'sd_cpp_extra_args',
    },
  });
  const run = f.make();
  for (const prompt of [
    'A circle <sd_cpp_extra_args>{"seed":7}</sd_cpp_extra_args>',
    'A circle <sd_cpp_extra_args>',
    'A circle </sd_cpp_extra_args>',
    'A circle <SD_CPP_EXTRA_ARGS >',
  ])
    await assert.rejects(
      run.tools.invoke('generate_image', { prompt }),
      /already contains sd_cpp_extra_args/,
    );
  for (const steps of [0, -1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY, '40', false]) {
    run.context.settings.images!.steps = steps as number;
    await assert.rejects(
      run.tools.invoke('generate_image', { prompt: 'Invalid sampling settings.' }),
      /sampling steps must be an integer/,
    );
  }
  run.context.settings.images!.steps = 40;
  run.context.settings.images!.stepsParameter = 'unsupported' as ImageSettings['stepsParameter'];
  await assert.rejects(
    run.tools.invoke('generate_image', { prompt: 'Invalid sampling format.' }),
    /supported image sampling-step format/,
  );
  assert.equal(requests, 0);
  assert.equal(f.store.list<Approval>('approvals').length, 0);
  assert.equal(f.store.list<OperationRecord>('operations').length, 0);
});

test('server-default image sampling sends an existing prompt extension unchanged', async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const base = await server(t, async (req, res) => {
    requests.push(await jsonBody(req));
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  const f = await fixture(t, base);
  const run = f.make();
  const prompt = 'An existing request <sd_cpp_extra_args>{"seed":7}</sd_cpp_extra_args>';
  await run.tools.invoke('generate_image', { prompt });
  assert.deepEqual(requests, [{ model: 'local-image-fixture', prompt, n: 1, size: '2048x2048' }]);
});

test('a rejected sampling extension is not retried under a different format', async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const base = await server(t, async (req, res) => {
    requests.push(await jsonBody(req));
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Sampling extension unsupported by this endpoint.' }));
  });
  const f = await fixture(t, base);
  const run = f.make();
  run.context.settings.images!.steps = 40;
  run.context.settings.images!.stepsParameter = 'steps';
  await assert.rejects(
    run.tools.invoke('generate_image', { prompt: 'No automatic compatibility probing.' }),
    /400/,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].steps, 40);
  assert.equal(f.store.list<OperationRecord>('operations')[0].status, 'failed');
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

test(
  'rescheduling an image releases its image slot before parking the task worker',
  { timeout: 15_000 },
  async (t) => {
    const requests: string[] = [];
    const base = await server(t, async (req, res) => {
      requests.push(String((await jsonBody(req)).prompt));
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
    const f = await fixture(t, base);
    const run = f.make();
    t.after(() => run.abort.abort());
    const worker = new InferenceGate();
    const resumeWorker = await worker.acquire();
    t.after(resumeWorker);
    let attempts = 0;
    let checkpoints = 0;
    let releases = 0;
    run.context.acquireInference = async (_signal, purpose) => {
      assert.equal(purpose, 'image');
      if (++attempts === 1) throw new InferenceRescheduledError();
      return () => {
        releases++;
      };
    };
    run.context.waitForRoom = async (signal) => {
      if (++checkpoints > 1) (await worker.acquire(signal))();
    };
    const pending = generateImage(
      run.context,
      { prompt: 'The reviewed image request' },
      `img_${'e'.repeat(64)}`,
      'allow',
    );
    await until(
      () => worker.state.waiting === 1,
      'worker parked after inference wait was rescheduled',
    );
    assert.equal(requests.length, 0);
    const settings = f.store.settings();
    await generateImage(
      {
        host: f.controller,
        settings: { ...settings, images: { ...settings.images!, shareInferenceSlot: false } },
        signal: new AbortController().signal,
      },
      { prompt: 'Independent image while the worker waits' },
      `img_${'f'.repeat(64)}`,
      'allow',
    );
    assert.deepEqual(
      requests,
      ['Independent image while the worker waits'],
      'The waiting worker does not retain image capacity',
    );
    resumeWorker();
    assert.equal((await pending).prompt, 'The reviewed image request');
    assert.equal(attempts, 2);
    assert.equal(releases, 1);
    assert.deepEqual(requests, [
      'Independent image while the worker waits',
      'The reviewed image request',
    ]);
  },
);

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
      res.writeHead(200, { 'content-length': String(400 * 1024 * 1024) });
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
    /encoded JSON response exceeds the size limit.*100 MiB per-image limit/,
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
  'image semaphore waiters lend saturated workers without cancelling issued image generation',
  { timeout: 40_000 },
  async (t) => {
    const imageResponses: ServerResponse[] = [];
    const base = await server(t, async (req, res) => {
      const body = await jsonBody(req);
      if (req.url?.endsWith('/images/generations')) {
        imageResponses.push(res);
        return; // Keep the first actual image operation running throughout the assertion.
      }
      const messages = body.messages as Array<{ role: string; content?: unknown }>;
      const prompt = JSON.stringify(
        messages.findLast((message) => message.role === 'user')?.content,
      );
      const urgent = prompt.includes('CAPACITY_URGENT');
      const marker = prompt.match(/CAPACITY_IMAGE_\d+/)?.[0];
      assert.ok(urgent || marker);
      const delta = urgent
        ? { content: 'Urgent text completed while the image continued.' }
        : {
            tool_calls: [
              {
                index: 0,
                id: `image-${marker}`,
                type: 'function',
                function: {
                  name: 'generate_image',
                  arguments: JSON.stringify({ prompt: marker }),
                },
              },
            ],
          };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choice of [
        { index: 0, delta, finish_reason: null },
        { index: 0, delta: {}, finish_reason: urgent ? 'stop' : 'tool_calls' },
      ])
        res.write(
          `data: ${JSON.stringify({ id: 'image-capacity', object: 'chat.completion.chunk', created: 1, model: 'language-fixture', choices: [choice] })}\n\n`,
        );
      res.end('data: [DONE]\n\n');
    });
    const f = await fixture(t, base, true);
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      inference: { maxConcurrentRequests: 1 },
      model: { ...f.store.settings().model, baseUrl: `${base}/v1`, modelId: 'language-fixture' },
      images: { ...f.store.settings().images!, timeoutSeconds: 3600, shareInferenceSlot: false },
    });
    const start = async (prompt: string) => {
      const room = await f.app.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          name: prompt,
          botIds: ['bot_aster'],
          parallelResponses: true,
        },
      });
      assert.equal(room.statusCode, 200, room.body);
      return f.controller.enqueueTask({ roomId: room.json().id, botId: 'bot_aster', prompt });
    };
    const tasks: Task[] = [];
    for (let index = 0; index < 16; index++) {
      const task = await start(`CAPACITY_IMAGE_${index}`);
      f.controller.prioritizeTask(task.id);
      tasks.push(task);
    }
    await until(
      () =>
        f.store
          .list<OperationRecord>('operations')
          .filter(
            (operation) =>
              operation.toolName === 'generate_image' && operation.status === 'started',
          ).length === 16,
      'all sixteen workers reach image generation',
    );
    await until(
      () => imageResponses.length === 1,
      'one image HTTP request occupies the image semaphore',
    );
    assert.equal(
      f.runtime.queueState().active,
      0,
      'Separate image hardware leaves language capacity free',
    );
    const urgent = await start('CAPACITY_URGENT');
    f.controller.prioritizeTask(urgent.id);
    await until(
      () => ['completed', 'failed'].includes(f.store.get<Task>('tasks', urgent.id)!.status),
      'urgent task borrows a worker from an image-capacity waiter',
    );
    assert.equal(
      f.store.get<Task>('tasks', urgent.id)!.status,
      'completed',
      f.store.get<Task>('tasks', urgent.id)!.error,
    );
    assert.equal(imageResponses.length, 1, 'Image requests remain serialized');
    assert.equal(
      imageResponses[0].destroyed,
      false,
      'The issued image HTTP request is not cancelled',
    );
    assert.equal(imageResponses[0].writableEnded, false);
    assert.ok(
      tasks.every((task) => f.store.get<Task>('tasks', task.id)!.status === 'waiting_tool'),
    );
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

/** A valid PNG with an uncompressed ancillary text chunk of an exact total size. */
function sizedPng(byteLength: number): Buffer {
  const chunk = Buffer.alloc(byteLength - png.length, 97);
  chunk.writeUInt32BE(chunk.length - 12, 0);
  chunk.write('tEXt', 4, 'ascii');
  chunk.write('Comment\0', 8, 'ascii');
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}

test('a generated image above 20 MiB can be saved, viewed and reused in an edit with the raised defaults', async (t) => {
  const large = sizedPng(21 * 1024 * 1024);
  let edits = 0;
  const base = await server(t, async (req, res) => {
    if (req.url === '/v1/images/edits') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'content-type': req.headers['content-type']! },
      }).formData();
      const source = form.get('image[]') as File;
      assert.equal(source.size, large.length);
      assert.deepEqual(Buffer.from(await source.arrayBuffer()), large);
      edits++;
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    } else {
      await jsonBody(req);
      res.end(JSON.stringify({ data: [{ b64_json: large.toString('base64') }] }));
    }
  });
  const f = await fixture(t, base);
  const settings = f.store.settings();
  f.store.put('settings', {
    ...settings,
    id: 'main',
    model: { ...settings.model, imageInput: true },
  });
  const run = f.make();
  await run.tools.invoke('generate_image', { prompt: 'A detailed original.' });
  const original = f.store.get<Message>('messages', run.message.id)!.attachments![0];
  assert.equal(original.byteLength, large.length);
  assert.deepEqual(await readGeneratedImage(f.dataDir, original), large);
  const view = run.tools.definitions.find((tool) => tool.name === 'view_image')!;
  const viewed = await view.execute(
    'large-image-view',
    { imageId: original.id },
    run.abort.signal,
    undefined,
    {} as Parameters<typeof view.execute>[4],
  );
  const pixels = viewed.content.find((part) => part.type === 'image');
  assert.ok(pixels?.type === 'image');
  assert.deepEqual(Buffer.from(pixels.data, 'base64'), large);
  await run.tools.invoke('edit_image', {
    prompt: 'Keep the original and change one detail.',
    sourceImage: { imageId: original.id },
  });
  assert.equal(edits, 1);
  assert.equal(f.store.get<Message>('messages', run.message.id)!.attachments!.length, 2);

  const current = f.store.settings();
  f.store.put('settings', {
    ...current,
    id: 'main',
    images: { ...current.images!, maxImageMiB: 1, maxTotalMiB: 2 },
  });
  refreshImagePreferences(run.context);
  assert.match(view.description, /limited to 1 MiB/);
  assert.match(view.description, /a 2 MiB budget/);
  assert.equal(run.context.imageInputBudget!.remainingBytes, 0, 'lowering retains consumed bytes');
  await assert.rejects(run.tools.invoke('view_image', { imageId: original.id }), /1 MiB/);
  await assert.rejects(
    run.tools.invoke('edit_image', {
      prompt: 'A new edit after lowering the limit.',
      sourceImage: { imageId: original.id },
    }),
    /1 MiB/,
  );
  assert.equal(edits, 1, 'an oversized source is rejected before another image-server request');
  const download = await f.app.inject({
    method: 'GET',
    url: `/api/images/${original.id}?download=1`,
    headers: { host: 'localhost' },
  });
  assert.equal(download.statusCode, 200, 'existing originals remain downloadable');
  assert.deepEqual(download.rawPayload, large);
});

for (const responseFormat of ['b64_json', 'url'] as const) {
  test(`configured per-image byte boundaries apply to ${responseFormat} generation responses`, async (t) => {
    const exact = sizedPng(1024 * 1024);
    const over = sizedPng(exact.length + 1);
    const base = await server(t, async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(req.url === '/exact.png' ? exact : over);
        return;
      }
      const request = await jsonBody(req);
      const tooLarge = request.prompt === 'Over the configured limit';
      res.end(
        JSON.stringify({
          data: [
            responseFormat === 'b64_json'
              ? { b64_json: (tooLarge ? over : exact).toString('base64') }
              : { url: tooLarge ? '/over.png' : '/exact.png' },
          ],
        }),
      );
    });
    const f = await fixture(t, base);
    const settings = f.store.settings();
    f.store.put('settings', {
      ...settings,
      id: 'main',
      images: { ...settings.images!, maxImageMiB: 1, maxTotalMiB: 2 },
    });
    const run = f.make();
    await run.tools.invoke('generate_image', { prompt: 'Exactly the configured limit' });
    const image = f.store.get<Message>('messages', run.message.id)!.attachments![0];
    assert.deepEqual(await readGeneratedImage(f.dataDir, image), exact);
    await assert.rejects(
      run.tools.invoke('generate_image', { prompt: 'Over the configured limit' }),
      responseFormat === 'b64_json' ? /1 MiB image limit/ : /size limit of 1.00 MiB/,
    );
    assert.equal(f.store.get<Message>('messages', run.message.id)!.attachments!.length, 1);
  });
}

test('editing applies the configured combined input limit before dispatch and accepts a raised allowance', async (t) => {
  let requests = 0;
  const base = await server(t, async (req, res) => {
    for await (const _chunk of req) {
      // Consume the exact multipart body without retaining another large copy.
    }
    requests++;
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  const f = await fixture(t, base);
  const settings = f.store.settings();
  f.store.put('settings', {
    ...settings,
    id: 'main',
    images: { ...settings.images!, maxImageMiB: 1, maxTotalMiB: 1 },
  });
  await writeFile(join(settings.workspacePath, 'first.png'), sizedPng(700 * 1024));
  await writeFile(join(settings.workspacePath, 'second.png'), sizedPng(700 * 1024));
  const run = f.make();
  const args = {
    prompt: 'Combine the two references.',
    sourceImage: { path: 'first.png' },
    referenceImages: [{ path: 'second.png' }],
  };
  await assert.rejects(run.tools.invoke('edit_image', args), /combined 1 MiB limit/);
  assert.equal(requests, 0);
  assert.equal(f.store.list('operations').length, 0);
  run.context.settings.images!.maxTotalMiB = 2;
  await run.tools.invoke('edit_image', args);
  assert.equal(requests, 1);
  assert.equal(f.store.get<Message>('messages', run.message.id)!.attachments![0].operation, 'edit');
});
