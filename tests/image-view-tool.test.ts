import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { createTools, roomConversationContext } from '../src/server/runtime/tools.js';
import type { ToolContext } from '../src/server/runtime/contract.js';
import type { GeneratedImage, Message, Task } from '../src/shared/types.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6cAAAAASUVORK5CYII=',
  'base64',
);

async function fixture(t: TestContext, imageInput = true) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-image-view-tool-'));
  const f = await createApp({
    dataDir: directory,
    scheduler: false,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  t.after(async () => {
    await f.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const settings = f.store.settings();
  f.store.put('settings', {
    ...settings,
    id: 'main',
    demoMode: true,
    model: { ...settings.model, imageInput },
    permissions: { shell: 'deny', fileWrite: 'deny', network: 'deny' },
  });
  await writeFile(join(settings.workspacePath, 'sample.png'), png);
  const make = (kind: Task['kind'] = 'chat') => {
    const task = f.controller.enqueueTask({
      roomId: 'room_lounge',
      botId: 'bot_aster',
      prompt: 'Inspect sample.png',
      kind,
    });
    const controller = new AbortController();
    const context: ToolContext = {
      host: f.controller,
      task,
      settings: f.store.settings(),
      signal: controller.signal,
      operationKeys: new Set(),
    };
    const registry = createTools(context);
    const view = registry.definitions.find((tool) => tool.name === 'view_image');
    const execute = (args: { path?: string; imageId?: string }) => {
      assert.ok(view);
      return view.execute(
        'image-call',
        args,
        controller.signal,
        undefined,
        {} as Parameters<typeof view.execute>[4],
      );
    };
    return { task, context, controller, registry, view, execute };
  };
  return { ...f, directory, make };
}

test('view_image is available with independent image input, but absent for text-only and learning tasks', async (t) => {
  const off = await fixture(t, false);
  assert.equal(off.make().view, undefined);
  const on = await fixture(t);
  assert.equal(on.store.settings().browser?.enabled, false);
  assert.equal(on.store.settings().images?.enabled, false);
  assert.ok(on.make().view);
  assert.equal(on.make('learning').view, undefined);
});

test('view_image sends real pixels only in the tool result and never modifies source or journals a generation', async (t) => {
  const f = await fixture(t);
  const run = f.make();
  const result = await run.execute({ path: 'sample.png' });
  assert.deepEqual(
    result.content.find((part) => part.type === 'image'),
    {
      type: 'image',
      data: png.toString('base64'),
      mimeType: 'image/png',
    },
  );
  const receipt = result.content.find((part) => part.type === 'text');
  assert.ok(receipt?.type === 'text');
  assert.match(receipt.text, /sample\.png/);
  assert.match(receipt.text, /image\/png/);
  assert.doesNotMatch(receipt.text, /data:image|base64/);
  assert.equal(f.store.list('operations').length, 0);
  assert.equal(f.store.list('images').length, 0);
  assert.equal(f.store.list('approvals').length, 0);
  assert.deepEqual(await readdir(run.context.settings.workspacePath), ['sample.png']);
  assert.deepEqual(await readFile(join(run.context.settings.workspacePath, 'sample.png')), png);
  assert.equal(f.controller.getSnapshot().activities.at(-1)?.status, 'success');
  assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes(png.toString('base64')));
  const again = await run.execute({ path: 'sample.png' });
  assert.deepEqual(again.content, result.content);
});

test('view_image respects revocation during file I/O and cancellation without publishing pixels', async (t) => {
  const f = await fixture(t);
  const run = f.make();
  const reading = run.execute({ path: 'sample.png' });
  const rejected = assert.rejects(reading, /Image input is disabled/);
  const current = f.store.settings();
  f.store.put('settings', {
    ...current,
    id: 'main',
    model: { ...current.model, imageInput: false },
  });
  await rejected;
  assert.equal(f.controller.getSnapshot().activities.at(-1)?.status, 'error');
  assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes(png.toString('base64')));

  f.store.put('settings', { ...current, id: 'main' });
  const stopped = f.make();
  stopped.controller.abort();
  await assert.rejects(stopped.execute({ path: 'sample.png' }), /abort|stopped/i);
});

test('room context includes bounded image references without prompt, pixels or provider URLs', async (t) => {
  const f = await fixture(t);
  const images: GeneratedImage[] = Array.from({ length: 10 }, (_, index) => ({
    id: `img_${String(index).padStart(64, '0')}`,
    type: 'image',
    mimeType: 'image/png',
    filename: `image-${index}.png`,
    byteLength: png.length,
    prompt: 'PRIVATE_IMAGE_PROMPT_MUST_NOT_BE_IN_HISTORY',
    model: 'fixture-image-model',
    createdAt: '2026-11-06T00:00:00.000Z',
  }));
  const message = f.controller.addMessage({
    roomId: 'room_lounge',
    authorType: 'bot',
    authorId: 'bot_nova',
    body: '',
    status: 'complete',
    attachments: images,
  });
  const text = roomConversationContext(f.controller.getSnapshot(), [message], 500, 4_000);
  const entries = JSON.parse(text) as Array<{ body: string; images: Array<{ imageId: string }> }>;
  assert.equal(entries[0].body, '');
  assert.equal(entries[0].images.length, 8);
  assert.equal(entries[0].images.at(-1)?.imageId, images[9].id);
  assert.doesNotMatch(text, /PRIVATE_IMAGE_PROMPT|base64|data:image/);
  assert.ok(text.length <= 4_000);
  const longer = { ...message, body: '長い内容'.repeat(4_000) } as Message;
  const bounded = roomConversationContext(f.controller.getSnapshot(), [longer], 20_000, 1_000);
  assert.ok(bounded.length <= 1_000);
  assert.ok(Array.isArray(JSON.parse(bounded)));
});
