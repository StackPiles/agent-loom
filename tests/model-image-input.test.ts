import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  collapseSystemMessages,
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
  toToolDeclaration,
  type Context,
  type Message,
  type Model,
  type Tool,
} from '@earendil-works/pi-ai';
import { Type } from '@sinclair/typebox';
import { createApp } from '../src/server/app.js';
import type { RuntimeHost, ToolContext } from '../src/server/runtime/contract.js';
import {
  projectModelImageInput,
  refreshImagePreferences,
} from '../src/server/runtime/model-image-input.js';
import { createTools } from '../src/server/runtime/tools.js';
import { DEFAULT_IMAGE_SETTINGS } from '../src/shared/model-settings.js';
import type { Settings } from '../src/shared/types.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6cAAAAASUVORK5CYII=';
const model: Model<'openai-completions'> = {
  id: 'vision-projection-fixture',
  name: 'Vision projection fixture',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'http://localhost:8080/v1',
  input: ['text', 'image'],
  reasoning: false,
  contextWindow: 32768,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const view: Tool = {
  name: 'view_image',
  description: 'Inspect a workspace image.',
  parameters: Type.Object({ path: Type.String() }),
};
const read: Tool = {
  name: 'read_file',
  description: 'Read a workspace text file.',
  parameters: Type.Object({ path: Type.String() }),
};
const removed: Tool = {
  name: 'legacy_tool',
  description: 'A tool removed earlier in the conversation.',
  parameters: Type.Object({}),
};

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) freeze(Reflect.get(value, key));
    Object.freeze(value);
  }
  return value;
}
function pixelCount(messages: Message[]): number {
  return messages.reduce(
    (count, message) =>
      count +
      ((message.role === 'user' || message.role === 'toolResult') && Array.isArray(message.content)
        ? message.content.filter((part) => part.type === 'image').length
        : 0),
    0,
  );
}
function imageHistory(): Message[] {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Compare this reference with workspace/sample.png.' },
        { type: 'image', mimeType: 'image/png', data: png },
      ],
      timestamp: 2,
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'view_sample',
          name: 'view_image',
          arguments: { path: 'sample.png' },
        },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 30,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 40,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: 3,
    },
    {
      role: 'toolResult',
      toolCallId: 'view_sample',
      toolName: 'view_image',
      content: [
        { type: 'text', text: 'Inspected sample.png (image/png).' },
        { type: 'image', mimeType: 'image/png', data: png },
      ],
      isError: false,
      timestamp: 4,
    },
  ];
}

test('image refresh replaces the full configuration without changing an earlier request snapshot', () => {
  const preparedImages = freeze({
    ...DEFAULT_IMAGE_SETTINGS,
    enabled: true,
    baseUrl: 'https://old-images.example/v1',
    modelId: 'old-image-model',
    size: '1024x1536',
    timeoutSeconds: 73,
    shareInferenceSlot: true,
  });
  const current = {
    model: { imageInput: true },
    images: freeze({
      ...DEFAULT_IMAGE_SETTINGS,
      enabled: true,
      baseUrl: 'https://new-images.example/v1',
      modelId: 'new-image-model',
      size: '2048x2048',
      timeoutSeconds: 149,
      responseFormat: 'b64_json' as const,
      apiKeyConfigured: true,
    }),
  } as Settings;
  const context = {
    host: { getSnapshot: () => ({ settings: current }) } as RuntimeHost,
    settings: { model: { imageInput: false }, images: preparedImages } as Settings,
  };
  refreshImagePreferences(context);
  assert.equal(context.settings.model.imageInput, true);
  assert.deepEqual(context.settings.images, current.images);
  assert.notEqual(context.settings.images, current.images);
  assert.notEqual(context.settings.images, preparedImages);
  assert.equal(preparedImages.modelId, 'old-image-model');
  assert.equal(preparedImages.timeoutSeconds, 73);
  context.settings.images!.baseUrl = 'https://isolated-copy.example/v1';
  assert.equal(current.images!.baseUrl, 'https://new-images.example/v1');

  current.images = undefined;
  refreshImagePreferences(context);
  assert.deepEqual(context.settings.images, DEFAULT_IMAGE_SETTINGS);
  assert.notEqual(context.settings.images, DEFAULT_IMAGE_SETTINGS);
  assert.equal(preparedImages.enabled, true);
});

test('image projection changes the actual Pi tool state and prior pixels without rewriting the transcript', () => {
  const transcript = freeze(
    normalizeContext({
      messages: [
        {
          role: 'system',
          content: 'You are the room research assistant.',
          sections: {
            workspace: 'Work only in the selected workspace.',
            temporary: 'This section will be removed.',
            loom_image_input: 'Old image policy.',
          },
          toolsAdded: [read, view, removed],
          timestamp: 1,
        },
        ...imageHistory(),
        {
          role: 'system',
          content: 'Cite filenames when presenting the comparison.',
          sections: { workspace: 'Keep original files unchanged.', temporary: null },
          toolsRemoved: [{ name: removed.name }, { name: view.name }],
          toolsAdded: [{ ...view, description: 'Inspect PNG, JPEG or WebP workspace images.' }],
          timestamp: 5,
        },
      ],
    }),
  );
  const original = JSON.stringify(transcript);
  const originalModel = JSON.stringify(freeze(model));
  const originalSystem = getCurrentSystemMessage(transcript.messages)!;

  for (const enabled of [true, false, true]) {
    const projected = projectModelImageInput(model, transcript, enabled, true);
    const resolved = collapseSystemMessages(projected.transcript);
    const currentSystem = getCurrentSystemMessage(resolved.messages)!;
    const tools = getCurrentTools(resolved.messages);
    assert.deepEqual(projected.model.input, enabled ? ['text', 'image'] : ['text']);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      enabled ? ['read_file', 'view_image'] : ['read_file'],
    );
    assert.equal(pixelCount(resolved.messages), enabled ? 2 : 0);
    if (!enabled) assert.equal(JSON.stringify(resolved).includes(png), false);
    assert.equal(currentSystem.content, originalSystem.content);
    assert.equal(currentSystem.sections!.workspace, 'Keep original files unchanged.');
    assert.equal(currentSystem.sections!.temporary, undefined);
    assert.match(currentSystem.sections!.loom_image_input!, enabled ? /enabled/ : /disabled/);
    assert.match(JSON.stringify(resolved), /Inspected sample.png/);
    assert.match(JSON.stringify(resolved), /view_sample/);
    assert.equal(JSON.stringify(transcript), original);
    assert.equal(JSON.stringify(model), originalModel);
  }
});

test('legacy Pi Context shorthand retains its root prompt and tool catalog through image projection', () => {
  const context: Context = freeze({
    systemPrompt: 'Preserve this legacy root instruction and its selected workspace.',
    tools: [read, view],
    messages: imageHistory(),
  });
  const original = JSON.stringify(context);
  for (const enabled of [false, true]) {
    const projected = projectModelImageInput(model, context, enabled, true);
    assert.match(getCurrentSystemPrompt(projected.transcript.messages), /legacy root instruction/);
    assert.deepEqual(
      getCurrentTools(projected.transcript.messages).map((tool) => tool.name),
      enabled ? ['read_file', 'view_image'] : ['read_file'],
    );
    assert.equal(pixelCount(projected.transcript.messages), enabled ? 2 : 0);
    assert.equal(JSON.stringify(context), original);
  }
});

test('compaction retains its own prompt and empty tool catalog with either image preference', () => {
  const context = freeze(
    normalizeContext({
      systemPrompt:
        'Summarize the transcript for the next turn. Return only the continuation summary.',
      messages: [
        {
          role: 'system',
          content: '',
          sections: { summary_format: 'Keep decisions, pending work and file paths.' },
          timestamp: 1,
        },
        ...imageHistory(),
      ],
    }),
  );
  const originalSystem = getCurrentSystemMessage(context.messages);
  const original = JSON.stringify(context);
  for (const enabled of [false, true]) {
    const projected = projectModelImageInput(model, context, enabled, false);
    assert.deepEqual(getCurrentSystemMessage(projected.transcript.messages), originalSystem);
    assert.deepEqual(getCurrentTools(projected.transcript.messages), []);
    assert.equal(projected.transcript.messages.length, context.messages.length);
    assert.equal(pixelCount(projected.transcript.messages), enabled ? 2 : 0);
    assert.equal(JSON.stringify(context), original);
  }
});

test('learning keeps its actual restricted tool catalog when image input is toggled', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-image-projection-'));
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
  settings.model.imageInput = true;
  settings.demoMode = true;
  f.store.put('settings', { ...settings, id: 'main' });
  const task = f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Save a concise lesson from the completed task.',
    kind: 'learning',
  });
  const toolContext: ToolContext = {
    host: f.controller,
    task,
    settings,
    signal: new AbortController().signal,
    operationKeys: new Set(),
  };
  const tools = createTools(toolContext).internalDefinitions.map(toToolDeclaration);
  assert.ok(tools.some((tool) => tool.name === 'save_memory'));
  assert.equal(
    tools.some((tool) => tool.name === 'view_image'),
    false,
  );
  const transcript = normalizeContext({
    systemPrompt: 'Review the completed task and retain one useful lesson.',
    tools,
    messages: [{ role: 'user', content: task.prompt, timestamp: 1 }],
  });
  for (const enabled of [false, true]) {
    const projected = projectModelImageInput(model, transcript, enabled, true);
    assert.deepEqual(getCurrentTools(projected.transcript.messages), tools);
    assert.match(getCurrentSystemPrompt(projected.transcript.messages), /retain one useful lesson/);
  }
});
