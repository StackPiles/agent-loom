import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../src/server/app.js';
import { readGeneratedImage } from '../src/server/runtime/images.js';
import { DEFAULT_IMAGE_SETTINGS } from '../src/shared/model-settings.js';
import type { Message, Task } from '../src/shared/types.js';

const original = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQcPj/HwAEQgJfMvKOtQAAAABJRU5ErkJggg==',
  'base64',
);
const edited = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4P0HhPwAG8AKvocw3hgAAAABJRU5ErkJggg==',
  'base64',
);
interface ProviderRequest {
  messages: Array<{
    role: string;
    tool_call_id?: string;
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  }>;
  tools: Array<{ function: { name: string } }>;
}
async function bytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
function stream(response: ServerResponse, delta: object, tool = false) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const choice of [
    { index: 0, delta, finish_reason: null },
    { index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' },
  ])
    response.write(
      `data: ${JSON.stringify({ id: 'image-edit-flow', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [choice] })}\n\n`,
    );
  response.end('data: [DONE]\n\n');
}
function tool(response: ServerResponse, id: string, name: string, args: object) {
  stream(
    response,
    {
      role: 'assistant',
      tool_calls: [
        { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
      ],
    },
    true,
  );
}
function imageUrls(request: ProviderRequest): string[] {
  return request.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) => (part.image_url ? [part.image_url.url] : []))
      : [],
  );
}

test(
  'a pasted chat image reaches the conversation model, editing API, and visual review in one task',
  { timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'loom-chat-edit-flow-'));
    const failures: unknown[] = [];
    let modelCalls = 0;
    let editCalls = 0;
    let sourceId = '';
    let resultId = '';
    let instance: Awaited<ReturnType<typeof createApp>> | undefined;
    const language = createServer((request, response) => {
      void (async () => {
        const body = JSON.parse((await bytes(request)).toString('utf8')) as ProviderRequest;
        assert.equal(request.url, '/v1/chat/completions');
        modelCalls++;
        if (modelCalls === 1) {
          assert.ok(body.tools.some((entry) => entry.function.name === 'edit_image'));
          assert.ok(
            imageUrls(body).includes(`data:image/png;base64,${original.toString('base64')}`),
          );
          sourceId =
            /Image 1: imageId=(img_[a-f0-9]{64})/.exec(JSON.stringify(body.messages))?.[1] ?? '';
          assert.ok(sourceId, 'The initial prompt identifies the actual uploaded image.');
          tool(response, 'call_edit', 'edit_image', {
            prompt: 'Change the background to sunset.',
            sourceImage: { imageId: sourceId },
            steps: 20,
          });
        } else if (modelCalls === 2) {
          const result = body.messages.findLast(
            (message) => message.role === 'tool' && message.tool_call_id === 'call_edit',
          );
          assert.ok(result && typeof result.content === 'string');
          resultId = /Image ID: (img_[a-f0-9]{64})/.exec(result.content)?.[1] ?? '';
          assert.ok(resultId);
          assert.notEqual(resultId, sourceId);
          tool(response, 'call_review', 'view_image', { imageId: resultId });
        } else {
          assert.equal(modelCalls, 3, 'The operation finishes without another generation.');
          assert.ok(imageUrls(body).includes(`data:image/png;base64,${edited.toString('base64')}`));
          stream(response, {
            role: 'assistant',
            content: 'The edited image is saved and reviewed.',
          });
        }
      })().catch((error) => {
        failures.push(error);
        response.destroy(error as Error);
      });
    });
    const images = createServer((request, response) => {
      void (async () => {
        editCalls++;
        assert.equal(request.url, '/v1/images/edits');
        const form = await new Response(new Uint8Array(await bytes(request)), {
          headers: { 'content-type': request.headers['content-type']! },
        }).formData();
        assert.equal(form.get('size'), null, 'An edit preserves source dimensions by default.');
        assert.equal(
          form.get('prompt'),
          'Change the background to sunset.<sd_cpp_extra_args>{"sample_params":{"sample_steps":20}}</sd_cpp_extra_args>',
        );
        const inputs = form.getAll('image[]');
        assert.equal(inputs.length, 1);
        assert.ok(inputs[0] instanceof File);
        assert.deepEqual(Buffer.from(await inputs[0].arrayBuffer()), original);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ b64_json: edited.toString('base64') }] }));
      })().catch((error) => {
        failures.push(error);
        response.destroy(error as Error);
      });
    });
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
        modelId: 'fixture',
        imageInput: true,
      },
      images: {
        ...DEFAULT_IMAGE_SETTINGS,
        enabled: true,
        baseUrl: `http://127.0.0.1:${imageAddress.port}/v1`,
        modelId: 'fixture',
        permission: 'allow',
      },
      permissions: { shell: 'deny', fileWrite: 'deny', network: 'allow' },
    });
    const sent = await instance.app.inject({
      method: 'POST',
      url: '/api/rooms/room_lounge/messages',
      headers: { host: 'localhost' },
      payload: {
        body: 'Change this image to a sunset, then inspect the result.',
        images: [
          { filename: 'original.png', mimeType: 'image/png', data: original.toString('base64') },
        ],
      },
    });
    assert.equal(sent.statusCode, 200, sent.body);
    const created = sent.json<{ message: Message; tasks: Task[] }>();
    const deadline = Date.now() + 15_000;
    let task: Task;
    do {
      assert.deepEqual(failures, []);
      task = instance.store.get<Task>('tasks', created.tasks[0].id)!;
      if (['completed', 'failed', 'stopped', 'interrupted'].includes(task.status)) break;
      assert.ok(Date.now() < deadline, 'The chat/edit/review task finishes.');
      await delay(10);
    } while (true);
    assert.equal(task.status, 'completed', task.error);
    assert.equal(modelCalls, 3);
    assert.equal(editCalls, 1);
    const attached = created.message.attachments![0];
    assert.equal(attached.id, sourceId);
    assert.deepEqual(await readGeneratedImage(directory, attached), original);
    const result = instance.store
      .list<Message>('messages')
      .flatMap((message) => message.attachments ?? [])
      .find((image) => image.id === resultId)!;
    assert.equal(result.operation, 'edit');
    assert.equal(result.inputImages?.[0].imageId, sourceId);
    assert.deepEqual(await readGeneratedImage(directory, result), edited);
  },
);
