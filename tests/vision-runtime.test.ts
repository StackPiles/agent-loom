import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import { readGeneratedImage, saveRasterImage } from '../src/server/runtime/images.js';
import { DEFAULT_IMAGE_SETTINGS } from '../src/shared/model-settings.js';
import type { GeneratedImage, Message, Permission, Room, Task } from '../src/shared/types.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQcPj/HwAEQgJfMvKOtQAAAABJRU5ErkJggg==',
  'base64',
);
const pngUrl = `data:image/png;base64,${png.toString('base64')}`;
const modelKey = 'fixture-vision-language-key';
const imageKey = 'fixture-vision-generator-key';

interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}
interface ModelRequest {
  messages: Array<{
    role: string;
    content?: string | ContentPart[];
    tool_call_id?: string;
  }>;
  tools?: Array<{ function: { name: string } }>;
}
type Reply =
  | { text: string }
  | { name: string; id: string; args: Record<string, unknown> }
  | { status: number; error: string };

async function jsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function reply(response: ServerResponse, value: Reply, index: number) {
  if ('error' in value) {
    response.writeHead(value.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: value.error } }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta =
    'text' in value
      ? { role: 'assistant', content: value.text }
      : {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: value.id,
              type: 'function',
              function: { name: value.name, arguments: JSON.stringify(value.args) },
            },
          ],
        };
  for (const choice of [
    { index: 0, delta, finish_reason: null },
    { index: 0, delta: {}, finish_reason: 'text' in value ? 'stop' : 'tool_calls' },
  ])
    response.write(
      `data: ${JSON.stringify({ id: `vision-fixture-${index}`, object: 'chat.completion.chunk', created: 1, model: 'vision-fixture', choices: [choice] })}\n\n`,
    );
  response.end('data: [DONE]\n\n');
}

function toolText(body: ModelRequest, callId: string): string {
  const result = body.messages.findLast(
    (message) => message.role === 'tool' && message.tool_call_id === callId,
  );
  assert.ok(result, `Tool result ${callId} must reach the real provider adapter`);
  assert.equal(typeof result.content, 'string');
  return result.content as string;
}

function imageUrls(body: ModelRequest): string[] {
  return body.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === 'image_url' && part.image_url ? [part.image_url.url] : [],
        )
      : [],
  );
}

async function sessionText(directory: string): Promise<string> {
  const pieces: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, item.name);
    if (item.isDirectory()) pieces.push(await sessionText(filename));
    else if (item.isFile() && item.name.endsWith('.jsonl'))
      pieces.push(await readFile(filename, 'utf8'));
  }
  return pieces.join('\n');
}

/** Every provider response is synthetic and all HTTP traffic stays on loopback. */
async function fixture(
  t: TestContext,
  options: { imagesEnabled?: boolean; network?: Permission } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-vision-runtime-'));
  const modelRequests: ModelRequest[] = [];
  const imageRequests: Array<Record<string, unknown>> = [];
  const failures: unknown[] = [];
  let plan: (request: ModelRequest, index: number) => Reply = () => ({ text: 'Fixture reply.' });
  const language = createServer((request, response) => {
    void (async () => {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${modelKey}`);
      const body = (await jsonBody(request)) as unknown as ModelRequest;
      modelRequests.push(body);
      reply(response, plan(body, modelRequests.length), modelRequests.length);
    })().catch((error) => {
      failures.push(error);
      response.destroy(error as Error);
    });
  });
  const images = createServer((request, response) => {
    void (async () => {
      assert.equal(request.url, '/v1/images/generations');
      assert.equal(request.headers.authorization, `Bearer ${imageKey}`);
      imageRequests.push(await jsonBody(request));
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    })().catch((error) => {
      failures.push(error);
      response.destroy(error as Error);
    });
  });
  let instance: Awaited<ReturnType<typeof createApp>> | undefined;
  t.after(async () => {
    await instance?.app.close();
    for (const server of [language, images]) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all(
    [language, images].map(
      (server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)),
    ),
  );
  const languageAddress = language.address();
  const imageAddress = images.address();
  assert.ok(languageAddress && typeof languageAddress !== 'string');
  assert.ok(imageAddress && typeof imageAddress !== 'string');
  instance = await createApp({ dataDir: directory, scheduler: false });
  const settings = instance.store.settings();
  instance.store.put('settings', {
    ...settings,
    id: 'main',
    demoMode: false,
    autoLearn: false,
    model: {
      ...settings.model,
      baseUrl: `http://127.0.0.1:${languageAddress.port}/v1`,
      modelId: 'vision-fixture',
      imageInput: true,
    },
    browser: { ...settings.browser!, enabled: false, includeScreenshotsInModel: false },
    images: {
      ...DEFAULT_IMAGE_SETTINGS,
      enabled: options.imagesEnabled ?? true,
      baseUrl: `http://127.0.0.1:${imageAddress.port}/v1`,
      modelId: 'image-fixture',
      permission: 'allow',
      timeoutSeconds: 5,
    },
    permissions: { shell: 'deny', fileWrite: 'deny', network: options.network ?? 'allow' },
  });
  instance.store.setSecret('model.apiKey', modelKey);
  instance.store.setSecret('image.apiKey', imageKey);
  const completed = async (taskId: string, expected = 'completed') => {
    const deadline = Date.now() + 15_000;
    while (
      !['completed', 'failed', 'stopped'].includes(
        instance!.store.get<Task>('tasks', taskId)!.status,
      )
    ) {
      if (failures.length) assert.deepEqual(failures, []);
      assert.ok(Date.now() < deadline, `Timed out: ${taskId}`);
      await delay(10);
    }
    assert.deepEqual(failures, []);
    const done = instance!.store.get<Task>('tasks', taskId)!;
    assert.equal(done.status, expected, done.error);
    return done;
  };
  return {
    directory,
    modelRequests,
    imageRequests,
    get app() {
      return instance!.app;
    },
    get store() {
      return instance!.store;
    },
    get controller() {
      return instance!.controller;
    },
    respond(next: typeof plan) {
      plan = next;
    },
    completed,
    async run(prompt: string, botId = 'bot_aster') {
      const task = instance!.controller.enqueueTask({ roomId: 'room_lounge', botId, prompt });
      return completed(task.id);
    },
    async restart() {
      await instance!.app.close();
      instance = await createApp({ dataDir: directory, scheduler: false });
    },
  };
}

test(
  'real Pi sees owner-uploaded pixels immediately without calling an image-generation tool',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, { imagesEnabled: false, network: 'deny' });
    f.respond((body, index) => {
      assert.deepEqual(
        imageUrls(body),
        [pngUrl],
        JSON.stringify(body.messages.findLast((message) => message.role === 'user')),
      );
      const current = body.messages.findLast((message) => message.role === 'user')!;
      assert.ok(Array.isArray(current.content));
      if (index === 1) {
        assert.ok(current.content.some((part) => part.type === 'image_url'));
        assert.match(JSON.stringify(current.content), /Image 1: imageId=img_[a-f0-9]{64}/);
        assert.match(JSON.stringify(current.content), /この画像を説明して/);
      } else {
        assert.equal(index, 2);
        assert.equal(
          current.content.some((part) => part.type === 'image_url'),
          false,
        );
      }
      return { text: 'Fixture: the uploaded image reached the conversation model.' };
    });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/rooms/room_lounge/messages',
      payload: {
        body: 'この画像を説明して',
        images: [{ filename: '画面.png', mimeType: 'image/png', data: png.toString('base64') }],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const accepted = response.json<{ tasks: Task[]; message: Message }>();
    await f.completed(accepted.tasks[0].id);
    assert.equal(accepted.message.attachments![0].source, 'uploaded');
    assert.equal(f.imageRequests.length, 0);
    assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes(png.toString('base64')));
    await f.run('その画像について詳しく説明して');
    assert.equal(f.imageRequests.length, 0);

    await f.restart();
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      model: { ...f.store.settings().model, imageInput: false },
    });
    f.respond((body) => {
      assert.deepEqual(imageUrls(body), [], 'live settings strip even persisted uploaded pixels');
      assert.equal(
        body.tools?.some((tool) => tool.function.name === 'view_image'),
        false,
      );
      return { text: 'Fixture: image input is now disabled.' };
    });
    await f.run('文章だけで答えて');
  },
);

test(
  'recovering an interrupted upload task reuses saved pixels without a second image attachment',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    f.respond((body, index) => {
      assert.deepEqual(imageUrls(body), [pngUrl]);
      return index === 1
        ? { status: 503, error: 'Synthetic provider interruption after receiving pixels.' }
        : { text: 'Fixture: resumed with the original uploaded pixels.' };
    });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/rooms/room_lounge/messages',
      payload: {
        body: '',
        images: [
          { filename: 'reference.png', mimeType: 'image/png', data: png.toString('base64') },
        ],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const taskId = response.json<{ tasks: Task[] }>().tasks[0].id;
    await f.completed(taskId, 'failed');
    await f.restart();
    f.controller.resume(taskId);
    await f.completed(taskId);
    assert.equal(f.modelRequests.length, 2);
    assert.equal(f.imageRequests.length, 0);
    assert.equal(
      f.store.list<Message>('messages').filter((message) => message.authorType === 'user').length,
      1,
    );
    assert.equal((await readdir(join(f.directory, 'generated-images'))).length, 1);
  },
);

test(
  'real Pi generates then views an image without Chrome, and disabling vision filters persisted pixels after restart',
  { timeout: 45_000 },
  async (t) => {
    const f = await fixture(t);
    let generatedId: string | undefined;
    f.respond((body, index) => {
      assert.ok(body.tools?.some((tool) => tool.function.name === 'view_image'));
      assert.equal(
        body.tools?.some((tool) => tool.function.name === 'browser_use'),
        false,
      );
      if (index === 1) {
        assert.deepEqual(imageUrls(body), []);
        return {
          name: 'generate_image',
          id: 'vision_generate',
          args: { prompt: 'One blue circle for a synthetic vision fixture.' },
        };
      }
      if (index === 2) {
        const receipt = toolText(body, 'vision_generate');
        generatedId = receipt.match(/img_[a-f0-9]{64}/)?.[0];
        assert.ok(generatedId, 'Generation must provide the identifier for an explicit read');
        assert.match(receipt, /view_image/);
        assert.deepEqual(imageUrls(body), [], 'Generation does not automatically send pixels');
        assert.ok(!JSON.stringify(body).includes(png.toString('base64')));
        return { name: 'view_image', id: 'vision_read', args: { imageId: generatedId } };
      }
      assert.equal(index, 3, 'One explicit image read needs one subsequent language request');
      assert.ok(toolText(body, 'vision_read').includes(generatedId!));
      assert.deepEqual(imageUrls(body), [pngUrl]);
      return { text: 'Synthetic fixture: image pixels reached this model request.' };
    });
    const task = await f.run('Generate one image and inspect the generated image with view_image.');
    assert.equal(f.modelRequests.length, 3);
    assert.equal(f.imageRequests.length, 1);
    const message = f.store.list<Message>('messages').find((item) => item.taskId === task.id)!;
    const image = message.attachments![0];
    assert.equal(image.id, generatedId);
    assert.deepEqual(await readGeneratedImage(f.directory, image), png);
    assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes(png.toString('base64')));
    assert.ok((await sessionText(join(f.directory, 'sessions'))).includes(png.toString('base64')));

    await f.restart();
    const configured = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { model: { imageInput: false } },
    });
    assert.equal(configured.statusCode, 200, configured.body);
    f.respond((body, index) => {
      assert.equal(index, 4);
      assert.equal(
        body.tools?.some((tool) => tool.function.name === 'view_image'),
        false,
      );
      assert.ok(
        toolText(body, 'vision_read').includes(generatedId!),
        'The prior session is restored',
      );
      assert.deepEqual(
        imageUrls(body),
        [],
        'Turning image input off also filters historical tool images',
      );
      assert.ok(!JSON.stringify(body).includes(png.toString('base64')));
      return { text: 'Synthetic fixture: the saved receipt remains, with image input disabled.' };
    });
    await f.run('Continue the same conversation using only text.');
    assert.equal(f.modelRequests.length, 4);
    assert.equal(
      f.imageRequests.length,
      1,
      'Reading or restoring a session never regenerates an image',
    );
  },
);

test(
  'another bot discovers an image-only room attachment in task and room context before explicitly viewing it',
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t, { imagesEnabled: false });
    const visible: GeneratedImage = {
      id: `img_${'a'.repeat(64)}`,
      type: 'image',
      mimeType: 'image/png',
      filename: 'room-reference.png',
      byteLength: png.length,
      prompt: 'Current-room reference image.',
      model: 'fixture-image',
      createdAt: new Date().toISOString(),
    };
    await saveRasterImage(f.directory, visible, png, new AbortController().signal);
    f.controller.addMessage({
      roomId: 'room_lounge',
      authorType: 'bot',
      authorId: 'bot_aster',
      body: '',
      status: 'complete',
      attachments: [visible],
    });
    const other = await f.app.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: { name: 'Other image room', botIds: ['bot_aster', 'bot_nova'] },
    });
    assert.equal(other.statusCode, 200, other.body);
    const hidden = {
      ...visible,
      id: `img_${'b'.repeat(64)}`,
      filename: 'other-room-reference.png',
    };
    await saveRasterImage(f.directory, hidden, png, new AbortController().signal);
    f.controller.addMessage({
      roomId: other.json<Room>().id,
      authorType: 'bot',
      authorId: 'bot_aster',
      body: '',
      status: 'complete',
      attachments: [hidden],
    });
    f.respond((body, index) => {
      const serialized = JSON.stringify(body.messages);
      assert.ok(serialized.includes(visible.id));
      assert.ok(
        !serialized.includes(hidden.id),
        'Other-room attachment metadata stays outside context',
      );
      if (index === 1) {
        assert.deepEqual(
          imageUrls(body),
          [],
          'Initial context includes identifiers, not automatic pixels',
        );
        return { name: 'room_context', id: 'vision_room_context', args: { limit: 20 } };
      }
      if (index === 2) {
        const recent = toolText(body, 'vision_room_context');
        assert.ok(recent.includes(visible.id));
        assert.ok(recent.includes(visible.filename));
        assert.ok(!recent.includes(hidden.id));
        assert.deepEqual(imageUrls(body), []);
        return { name: 'view_image', id: 'vision_shared_read', args: { imageId: visible.id } };
      }
      assert.equal(index, 3);
      assert.ok(toolText(body, 'vision_shared_read').includes(visible.id));
      assert.deepEqual(imageUrls(body), [pngUrl]);
      return { text: 'Synthetic fixture: the teammate image is available for inspection.' };
    });
    const task = await f.run('Inspect the image that Aster attached to this room.', 'bot_nova');
    assert.equal(task.botId, 'bot_nova');
    assert.equal(f.modelRequests.length, 3);
    assert.equal(f.imageRequests.length, 0);
  },
);

test(
  'real Pi can view a workspace image with image generation and agent network tools disabled',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, { imagesEnabled: false, network: 'deny' });
    const filename = join(f.store.settings().workspacePath, 'images', 'reference.png');
    await mkdir(join(f.store.settings().workspacePath, 'images'), { recursive: true });
    await writeFile(filename, png);
    f.respond((body, index) => {
      assert.ok(body.tools?.some((tool) => tool.function.name === 'view_image'));
      if (index === 1)
        return {
          name: 'view_image',
          id: 'vision_file_read',
          args: { path: 'images/reference.png' },
        };
      assert.equal(index, 2);
      assert.match(toolText(body, 'vision_file_read'), /reference\.png/);
      assert.deepEqual(imageUrls(body), [pngUrl]);
      return {
        text: 'Synthetic fixture: the workspace PNG was passed through the vision adapter.',
      };
    });
    await f.run('Inspect the reference image at images/reference.png.');
    assert.equal(f.modelRequests.length, 2);
    assert.equal(f.imageRequests.length, 0);
    assert.equal(f.store.settings().permissions.network, 'deny');
    assert.equal(f.store.settings().images?.enabled, false);
    assert.equal(f.store.settings().browser?.enabled, false);
  },
);
