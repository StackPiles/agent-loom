import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { Settings, Room, Task } from '../src/shared/types.js';
import {
  DEFAULT_IMAGE_SETTINGS,
  DEFAULT_INFERENCE_SETTINGS,
  DEFAULT_MODEL_TIMEOUTS,
  IMAGE_2K_PARALLEL_PRESET,
  modelImageInputEnabled,
  REASONING_EFFORTS,
} from '../src/shared/model-settings.js';
import { DEFAULT_BROWSER_SETTINGS } from '../src/shared/browser.js';
import { createApp } from '../src/server/app.js';
import type { Runtime } from '../src/server/runtime/contract.js';

async function fixture(t: TestContext, realRuntime = false) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-model-configuration-'));
  let configurations = 0;
  const runtimeFactory = (): Runtime => ({
    start() {},
    async stop() {},
    async shutdown() {},
    queueState: () => ({ active: 0, waiting: 0 }),
    configureInference: () => {
      configurations++;
    },
  });
  const instance = await createApp({
    dataDir: directory,
    scheduler: false,
    ...(realRuntime ? {} : { runtimeFactory }),
  });
  t.after(async () => {
    await instance.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const save = (payload: unknown) =>
    instance.app.inject({ method: 'PUT', url: '/api/settings', payload: payload as object });
  return { ...instance, directory, save, configurations: () => configurations };
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

test('legacy settings receive conservative defaults and invalid model settings reject atomically', async (t) => {
  const f = await fixture(t);
  const stored = f.store.get<Settings & { id: string }>('settings', 'main')!;
  assert.equal(stored.model.responseTimeoutSeconds, DEFAULT_MODEL_TIMEOUTS.responseTimeoutSeconds);
  assert.equal(stored.model.idleTimeoutSeconds, DEFAULT_MODEL_TIMEOUTS.idleTimeoutSeconds);
  assert.equal(stored.model.imageInput, false);
  const { inference: _inference, images: _images, ...legacy } = stored;
  const {
    responseTimeoutSeconds: _responseTimeout,
    idleTimeoutSeconds: _idleTimeout,
    ...legacyModel
  } = legacy.model;
  legacy.model = legacyModel;
  f.store.put('settings', legacy);
  assert.deepEqual(f.store.settings().inference, DEFAULT_INFERENCE_SETTINGS);
  assert.deepEqual(f.store.settings().images, DEFAULT_IMAGE_SETTINGS);
  assert.equal(f.store.settings().model.responseTimeoutSeconds, 1800);
  assert.equal(f.store.settings().model.idleTimeoutSeconds, 300);
  assert.equal(
    Object.hasOwn(f.store.get<Settings>('settings', 'main')!.model, 'responseTimeoutSeconds'),
    false,
    'reading legacy settings does not rewrite the stored record',
  );
  const baseline = f.store.get('settings', 'main');
  const invalid: Array<Record<string, Record<string, unknown>>> = [
    { inference: { maxConcurrentRequests: 0 } },
    { inference: { maxConcurrentRequests: 17 } },
    { inference: { maxConcurrentRequests: 1.5 } },
    { images: { enabled: true } },
    { images: { size: '8192x8192' } },
    { images: { size: '64x63' } },
    { images: { size: 'landscape' } },
    ...[9, 86_401, 10.5, null, '3600'].map((timeoutSeconds) => ({
      images: { timeoutSeconds },
    })),
    { images: { permission: 'auto' } },
    { images: { permission: null } },
    { images: { baseUrl: 'https://user:password@images.example.test/v1' } },
    { images: { baseUrl: 'http://169.254.169.254/v1' } },
    { images: { baseUrl: 'http://metadata.google.internal/v1' } },
    { model: { reasoningEffort: 'turbo' } },
    ...[null, 'true', 1, []].map((imageInput) => ({ model: { imageInput } })),
    ...(['responseTimeoutSeconds', 'idleTimeoutSeconds'] as const).flatMap((key) =>
      [9, 86_401, 10.5, null, '1800'].map((value) => ({ model: { [key]: value } })),
    ),
  ];
  for (const patch of invalid) {
    const response = await f.save({
      ...patch,
      model: { apiKey: 'synthetic-rejected-model-key', ...patch.model },
      images: { apiKey: 'synthetic-rejected-image-key', ...patch.images },
    });
    assert.equal(response.statusCode, 400, JSON.stringify(patch));
    assert.deepEqual(f.store.get('settings', 'main'), baseline);
    assert.equal(f.store.secret('model.apiKey'), '');
    assert.equal(f.store.secret('image.apiKey'), '');
    assert.equal(response.body.includes('synthetic-rejected-'), false);
  }
});

test('2K image defaults allow one hour and parallel LLM while explicit legacy settings and credentials remain intact', async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.settings().images!.size, '2048x2048');
  assert.equal(f.store.settings().images!.timeoutSeconds, 3600);
  assert.equal(f.store.settings().images!.shareInferenceSlot, false);
  const key = 'synthetic-retained-legacy-image-key';
  const configured = await f.save({
    images: {
      baseUrl: 'http://images.example.test:5000/v1',
      modelId: 'retained-image-provider',
      size: '1024x1024',
      timeoutSeconds: 120,
      shareInferenceSlot: true,
      apiKey: key,
    },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  const unrelated = await f.save({ autoLearn: false });
  assert.equal(unrelated.statusCode, 200, unrelated.body);
  assert.equal(f.store.settings().images!.size, '1024x1024');
  assert.equal(f.store.settings().images!.timeoutSeconds, 120);
  assert.equal(f.store.settings().images!.shareInferenceSlot, true);
  assert.equal(f.store.secret('image.apiKey'), key);

  const saved = f.store.get<Settings & { id: string }>('settings', 'main')!;
  const { timeoutSeconds: _timeout, ...legacyImages } = saved.images!;
  f.store.put('settings', { ...saved, images: legacyImages });
  assert.equal(f.store.settings().images!.timeoutSeconds, 3600);
  assert.equal(f.store.settings().images!.size, '1024x1024');
  assert.equal(f.store.settings().images!.shareInferenceSlot, true);
  assert.equal(
    Object.hasOwn(f.store.get<Settings>('settings', 'main')!.images!, 'timeoutSeconds'),
    false,
    'reading an omitted legacy timeout must not rewrite saved settings',
  );
  const { shareInferenceSlot: _sharing, ...withoutSharing } = legacyImages;
  f.store.put('settings', { ...saved, images: withoutSharing });
  assert.equal(f.store.settings().images!.shareInferenceSlot, false);
  assert.equal(f.store.settings().images!.size, '1024x1024');
  assert.equal(f.store.settings().images!.timeoutSeconds, 3600);
  assert.equal(
    Object.hasOwn(f.store.get<Settings>('settings', 'main')!.images!, 'shareInferenceSlot'),
    false,
    'reading omitted legacy sharing uses the default without rewriting the saved record',
  );
  assert.equal(f.store.secret('image.apiKey'), key);
  const applied = await f.save({ images: IMAGE_2K_PARALLEL_PRESET });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.deepEqual(
    {
      size: applied.json<Settings>().images!.size,
      timeoutSeconds: applied.json<Settings>().images!.timeoutSeconds,
      shareInferenceSlot: applied.json<Settings>().images!.shareInferenceSlot,
    },
    { size: '2048x2048', timeoutSeconds: 3600, shareInferenceSlot: false },
  );
  assert.equal(applied.json<Settings>().images!.baseUrl, 'http://images.example.test:5000/v1');
  assert.equal(applied.json<Settings>().images!.modelId, 'retained-image-provider');
  assert.equal(f.store.secret('image.apiKey'), key);
  assert.equal(applied.body.includes(key), false);
});

test('image timeout settings accept ten seconds through one day and preserve custom budgets on partial saves', async (t) => {
  const f = await fixture(t);
  for (const timeoutSeconds of [10, 3600, 86_400, 2345]) {
    const response = await f.save({ images: { timeoutSeconds } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<Settings>().images!.timeoutSeconds, timeoutSeconds);
    assert.equal(f.store.get<Settings>('settings', 'main')!.images!.timeoutSeconds, timeoutSeconds);
  }
  const omitted = await f.save({ images: { responseFormat: 'b64_json' } });
  assert.equal(omitted.statusCode, 200, omitted.body);
  assert.equal(omitted.json<Settings>().images!.timeoutSeconds, 2345);
  assert.equal(omitted.json<Settings>().images!.responseFormat, 'b64_json');
});

test('legacy screenshot opt-in is retained as model image input without rewriting saved settings', async (t) => {
  const f = await fixture(t);
  const saved = f.store.get<Settings & { id: string }>('settings', 'main')!;
  const { imageInput: _imageInput, ...legacyModel } = saved.model;
  for (const enabled of [false, true]) {
    const legacy = {
      ...saved,
      model: legacyModel,
      browser: { ...DEFAULT_BROWSER_SETTINGS, enabled, includeScreenshotsInModel: true },
    };
    f.store.put('settings', legacy);
    assert.equal(modelImageInputEnabled(legacy), true);
    assert.equal(f.store.settings().model.imageInput, true);
    assert.deepEqual(
      f.store.get('settings', 'main'),
      legacy,
      'reading does not mutate the database',
    );
    const retained = await f.save({ autoLearn: false });
    assert.equal(retained.statusCode, 200, retained.body);
    assert.equal(retained.json<Settings>().model.imageInput, true);
    assert.equal(retained.json<Settings>().browser?.enabled, enabled);
  }

  for (const imageInput of [false, true]) {
    const settings = {
      ...saved,
      model: { ...legacyModel, imageInput },
      browser: { ...DEFAULT_BROWSER_SETTINGS, includeScreenshotsInModel: !imageInput },
    };
    f.store.put('settings', settings);
    assert.equal(modelImageInputEnabled(settings), imageInput);
    assert.equal(f.store.settings().model.imageInput, imageInput, 'explicit model choice wins');
  }
  const withoutLegacyOptIn = { ...saved, model: legacyModel, browser: undefined };
  f.store.put('settings', withoutLegacyOptIn);
  assert.equal(f.store.settings().model.imageInput, false);
});

test('model image input is independent of Chrome and effective changes remain pinned during active work', async (t) => {
  const f = await fixture(t);
  const key = 'synthetic-image-input-model-key';
  const configured = await f.save({
    model: {
      baseUrl: 'http://text.example.test:4000/v1',
      modelId: 'vision-fixture',
      apiKey: key,
      imageInput: true,
    },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  assert.equal(configured.json<Settings>().model.imageInput, true);
  assert.equal(configured.json<Settings>().browser?.enabled, false);
  assert.equal(configured.json<Settings>().browser?.includeScreenshotsInModel, false);
  assert.equal(f.store.secret('model.apiKey'), key);

  // Materializing a legacy opt-in is equivalent, even while a task is queued.
  const { imageInput: _imageInput, ...legacyModel } = f.store.settings().model;
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    model: legacyModel,
    browser: { ...DEFAULT_BROWSER_SETTINGS, includeScreenshotsInModel: true },
  });
  const task = f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Keep the image-input capability stable while this task is queued.',
  });
  const equivalent = await f.save({ model: { imageInput: true }, permissions: { shell: 'allow' } });
  assert.equal(equivalent.statusCode, 200, equivalent.body);
  assert.equal(f.store.settings().permissions.shell, 'allow');
  const baseline = f.store.get('settings', 'main');
  const blocked = await f.save({ model: { imageInput: false, apiKey: 'synthetic-rejected-key' } });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.deepEqual(f.store.get('settings', 'main'), baseline);
  assert.equal(f.store.secret('model.apiKey'), key);
  f.controller.updateTask(task.id, { status: 'completed' });

  const disabled = await f.save({ model: { imageInput: false } });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json<Settings>().model.imageInput, false);
  assert.equal(disabled.json<Settings>().browser?.includeScreenshotsInModel, true);
  const unrelated = await f.save({ permissions: { network: 'deny' }, autoLearn: false });
  assert.equal(unrelated.statusCode, 200, unrelated.body);
  assert.equal(unrelated.json<Settings>().model.imageInput, false);
  assert.equal(f.store.secret('model.apiKey'), key);

  for (const kind of ['promptGenerations', 'avatarGenerations']) {
    f.store.put(kind, { id: 'active-vision-settings-job', status: 'generating' });
    const unchanged = await f.save({ model: { imageInput: false } });
    assert.equal(unchanged.statusCode, 200, unchanged.body);
    const whileGenerating = await f.save({ model: { imageInput: true } });
    assert.equal(whileGenerating.statusCode, 409, kind + ': ' + whileGenerating.body);
    assert.equal(f.store.settings().model.imageInput, false);
    f.store.patch(kind, 'active-vision-settings-job', { status: 'completed' });
  }
});

test('all image settings and the preset can change for paused queued or runtime-suspended tasks without interrupting them', async (t) => {
  const f = await fixture(t);
  const configured = await f.save({
    model: {
      baseUrl: 'http://text.example.test:4000/v1',
      modelId: 'paused-vision-fixture',
      imageInput: false,
      apiKey: 'synthetic-paused-model-key',
    },
    images: {
      enabled: true,
      baseUrl: 'http://images.example.test:5000/v1',
      modelId: 'paused-image-fixture',
      shareInferenceSlot: true,
      apiKey: 'synthetic-paused-image-key',
    },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  f.controller.pauseRoom('room_lounge');
  const task = f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Keep this paused task intact when its image provider settings change.',
  });
  f.store.put('rooms', {
    ...f.store.get<Room>('rooms', task.roomId)!,
    id: 'room_also_paused',
    paused: true,
  });
  f.controller.enqueueTask({
    roomId: 'room_also_paused',
    botId: 'bot_aster',
    prompt: 'This other paused queued task must retain its place.',
  });
  let suspensionChecks = 0;
  let stops = 0;
  f.controller.runtime!.stop = async () => {
    stops++;
  };
  for (const status of [
    'queued',
    'running',
    'waiting_model',
    'waiting_tool',
    'awaiting_approval',
  ] as const) {
    // A queued task needs no live runtime. Started work needs an authoritative
    // boundary, even though its durable task status remains nonterminal.
    f.controller.runtime!.isTaskSuspended =
      status === 'queued'
        ? undefined
        : (id) => {
            suspensionChecks++;
            return id === task.id;
          };
    f.controller.updateTask(task.id, { status });
    const beforeTasks = f.store.list<Task>('tasks');
    const current = f.store.settings();
    const nextInput = !modelImageInputEnabled(current);
    const nextImages = {
      ...current.images!,
      enabled: !current.images!.enabled,
      baseUrl: `http://images.example.test:5000/${status}/v1`,
      modelId: `paused-image-${status}`,
      size: current.images!.size === '1024x1024' ? '2048x2048' : '1024x1024',
      timeoutSeconds: current.images!.timeoutSeconds === 120 ? 3600 : 120,
      responseFormat: current.images!.responseFormat === 'auto' ? 'b64_json' : 'auto',
      shareInferenceSlot: !current.images!.shareInferenceSlot,
      apiKey: `synthetic-paused-image-key-${status}`,
    };
    const saved = await f.save({
      ...current,
      model: { ...current.model, imageInput: nextInput },
      images: nextImages,
    });
    assert.equal(saved.statusCode, 200, `${status}: ${saved.body}`);
    assert.equal(saved.json<Settings>().model.imageInput, nextInput);
    const { apiKey, ...publicImages } = nextImages;
    assert.deepEqual(saved.json<Settings>().images, { ...publicImages, apiKeyConfigured: true });
    assert.deepEqual(f.store.list<Task>('tasks'), beforeTasks);
    assert.equal(f.store.get<Room>('rooms', task.roomId)!.paused, true);
    assert.equal(f.store.secret('model.apiKey'), 'synthetic-paused-model-key');
    assert.equal(f.store.secret('image.apiKey'), apiKey);
    assert.equal(saved.body.includes(apiKey), false);
  }
  assert.equal(suspensionChecks, 4);
  const beforePreset = f.store.settings();
  const beforeTasks = f.store.list<Task>('tasks');
  const preset = await f.save({ images: IMAGE_2K_PARALLEL_PRESET });
  assert.equal(preset.statusCode, 200, preset.body);
  assert.deepEqual(preset.json<Settings>().images, {
    ...beforePreset.images,
    ...IMAGE_2K_PARALLEL_PRESET,
  });
  assert.deepEqual(f.store.list<Task>('tasks'), beforeTasks);
  assert.equal(f.store.secret('image.apiKey'), 'synthetic-paused-image-key-awaiting_approval');
  assert.equal(stops, 0, 'saving image settings must not interrupt or requeue a continuation');
});

test('pause intent, displayed wait states, unknown runtime state and other live rooms cannot unlock any image settings', async (t) => {
  for (const state of ['unknown', 'draining', 'unpaused', 'mixed'] as const) {
    const f = await fixture(t);
    const configured = await f.save({
      model: {
        baseUrl: 'http://text.example.test:4000/v1',
        modelId: 'guarded-vision-fixture',
        imageInput: false,
        apiKey: 'synthetic-kept-model-key',
      },
      images: {
        baseUrl: 'http://images.example.test:5000/v1',
        modelId: 'guarded-image-fixture',
        shareInferenceSlot: true,
        apiKey: 'synthetic-kept-image-key',
      },
      search: { apiKey: 'synthetic-kept-search-key' },
    });
    assert.equal(configured.statusCode, 200, configured.body);
    if (state !== 'unpaused') f.controller.pauseRoom('room_lounge');
    const task = f.controller.enqueueTask({
      roomId: 'room_lounge',
      botId: 'bot_aster',
      prompt: 'An apparent pause is insufficient while an action is still draining.',
    });
    f.controller.updateTask(task.id, { status: 'waiting_tool' });
    if (state !== 'unknown')
      f.controller.runtime!.isTaskSuspended = (id) => state !== 'draining' && id === task.id;
    if (state === 'mixed') {
      f.store.put('rooms', {
        ...f.store.get<Room>('rooms', 'room_lounge')!,
        id: 'room_live',
        paused: false,
      });
      f.controller.enqueueTask({
        roomId: 'room_live',
        botId: 'bot_aster',
        prompt: 'This unpaused queued task must also hold the global settings lock.',
      });
    }
    // Presentation metadata can be stale or incomplete and never grants access.
    f.controller.runtime!.queueState = () => ({
      active: 0,
      waiting: 1,
      waitingTasks: [{ taskId: task.id, reason: 'paused' }],
    });
    const before = f.store.get('settings', 'main');
    const tasks = f.store.list<Task>('tasks');
    const configurations = f.configurations();
    for (const changes of [
      { model: { imageInput: true } },
      { images: { enabled: true } },
      { images: { baseUrl: 'http://other-images.example.test:5001/v1' } },
      { images: { modelId: 'other-image-model' } },
      { images: { size: '1024x1024' } },
      { images: { responseFormat: 'b64_json' } },
      { images: { timeoutSeconds: 2345 } },
      { images: { apiKey: 'synthetic-rejected-image-key' } },
      { images: { shareInferenceSlot: false } },
      { model: { imageInput: true }, images: { shareInferenceSlot: false } },
    ]) {
      const blocked = await f.save({
        ...changes,
        search: { apiKey: 'synthetic-rejected-search-key' },
        autoLearn: !f.store.settings().autoLearn,
      });
      assert.equal(blocked.statusCode, 409, `${state}: ${blocked.body}`);
      assert.match(blocked.json().error, /Pause all rooms/);
      assert.deepEqual(f.store.get('settings', 'main'), before);
      assert.deepEqual(f.store.list<Task>('tasks'), tasks);
      assert.equal(f.store.secret('model.apiKey'), 'synthetic-kept-model-key');
      assert.equal(f.store.secret('image.apiKey'), 'synthetic-kept-image-key');
      assert.equal(f.store.secret('search.apiKey'), 'synthetic-kept-search-key');
      assert.equal(f.configurations(), configurations);
    }
  }
});

test('paused image settings edits cannot change pinned text connections, text budgets, browser input, workspace or demo mode', async (t) => {
  const f = await fixture(t);
  const configured = await f.save({
    model: {
      baseUrl: 'http://text.example.test:4000/v1',
      modelId: 'pinned-text-fixture',
      imageInput: false,
      apiKey: 'synthetic-pinned-model-key',
    },
    images: {
      baseUrl: 'http://images.example.test:5000/v1',
      modelId: 'pinned-image-fixture',
      shareInferenceSlot: true,
      apiKey: 'synthetic-pinned-image-key',
    },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  f.controller.pauseRoom('room_lounge');
  const task = f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt:
      'Image settings can change while text connections and other execution settings stay pinned.',
  });
  f.controller.updateTask(task.id, { status: 'waiting_tool' });
  f.controller.runtime!.isTaskSuspended = (id) => id === task.id;
  const before = f.store.get('settings', 'main');
  const pinned: Array<{
    model?: object;
    browser?: object;
    workspacePath?: string;
    demoMode?: boolean;
  }> = [
    { model: { baseUrl: 'http://other-text.example.test/v1' } },
    { model: { modelId: 'other-model' } },
    { model: { responseTimeoutSeconds: 2345 } },
    { model: { apiKey: 'synthetic-rejected-model-key' } },
    { browser: { includeScreenshotsInModel: true } },
    { workspacePath: join(f.directory, 'different-workspace') },
    { demoMode: !f.store.settings().demoMode },
  ];
  for (const patch of pinned) {
    const blocked = await f.save({
      ...patch,
      model: { imageInput: true, ...patch.model },
      images: {
        baseUrl: 'http://other-images.example.test/v1',
        modelId: 'new-paused-image-model',
        size: '1024x1024',
        timeoutSeconds: 2345,
        shareInferenceSlot: false,
        apiKey: 'synthetic-rejected-image-key',
      },
    });
    assert.equal(blocked.statusCode, 409, JSON.stringify(patch) + ': ' + blocked.body);
    assert.deepEqual(f.store.get('settings', 'main'), before);
    assert.equal(f.store.secret('model.apiKey'), 'synthetic-pinned-model-key');
    assert.equal(f.store.secret('image.apiKey'), 'synthetic-pinned-image-key');
  }
});

test('owner generation guards still cover image input and all image-model settings while room tasks are safely paused', async (t) => {
  const f = await fixture(t);
  const configured = await f.save({
    model: {
      baseUrl: 'http://text.example.test:4000/v1',
      modelId: 'owner-vision-fixture',
      imageInput: false,
    },
    images: {
      baseUrl: 'http://images.example.test:5000/v1',
      modelId: 'owner-image-fixture',
      shareInferenceSlot: true,
      apiKey: 'synthetic-owner-image-key',
    },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  f.controller.pauseRoom('room_lounge');
  f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Owner generation jobs must keep their existing model guards.',
  });
  const before = f.store.get('settings', 'main');
  for (const kind of ['promptGenerations', 'avatarGenerations']) {
    f.store.put(kind, { id: 'active-owner-generation', status: 'generating' });
    const blocked = await f.save({ model: { imageInput: true } });
    assert.equal(blocked.statusCode, 409, `${kind}: ${blocked.body}`);
    assert.deepEqual(f.store.get('settings', 'main'), before);
    if (kind === 'avatarGenerations') {
      for (const images of [
        { enabled: true },
        { baseUrl: 'http://other-images.example.test/v1' },
        { modelId: 'another-image-model' },
        { size: '1024x1024' },
        { responseFormat: 'b64_json' },
        { timeoutSeconds: 2345 },
        { apiKey: 'synthetic-rejected-image-key' },
        { shareInferenceSlot: false },
      ]) {
        const blockedImage = await f.save({ images });
        assert.equal(blockedImage.statusCode, 409, blockedImage.body);
        assert.deepEqual(f.store.get('settings', 'main'), before);
        assert.equal(f.store.secret('image.apiKey'), 'synthetic-owner-image-key');
      }
    }
    f.store.patch(kind, 'active-owner-generation', { status: 'completed' });
  }
});

test('model timeout settings accept exact boundaries and partial updates preserve values and credentials', async (t) => {
  const f = await fixture(t);
  const key = 'synthetic-preserved-timeout-key';
  for (const model of [
    { responseTimeoutSeconds: 10, idleTimeoutSeconds: 86_400, apiKey: key },
    { responseTimeoutSeconds: 86_400, idleTimeoutSeconds: 10 },
    { responseTimeoutSeconds: 2345, idleTimeoutSeconds: 79 },
  ]) {
    const response = await f.save({ model });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(
      response.json<Settings>().model.responseTimeoutSeconds,
      model.responseTimeoutSeconds,
    );
    assert.equal(response.json<Settings>().model.idleTimeoutSeconds, model.idleTimeoutSeconds);
    assert.equal(f.store.secret('model.apiKey'), key);
    assert.equal(response.body.includes(key), false);
  }
  const omitted = await f.save({ model: { temperature: 0.6 }, autoLearn: false });
  assert.equal(omitted.statusCode, 200, omitted.body);
  assert.equal(omitted.json<Settings>().model.responseTimeoutSeconds, 2345);
  assert.equal(omitted.json<Settings>().model.idleTimeoutSeconds, 79);
  assert.equal(f.store.secret('model.apiKey'), key);
  assert.equal(f.store.settings().model.apiKeyConfigured, true);

  // Runtime fixtures can seed a smaller budget directly without changing the
  // public API's integer validation or having Store silently clamp the value.
  f.store.put('settings', {
    ...f.store.settings(),
    id: 'main',
    model: { ...f.store.settings().model, responseTimeoutSeconds: 0.05, idleTimeoutSeconds: 0.02 },
  });
  assert.equal(f.store.settings().model.responseTimeoutSeconds, 0.05);
  assert.equal(f.store.settings().model.idleTimeoutSeconds, 0.02);
});

test('missing timeout fields equal the defaults while active tasks pin changes to either budget', async (t) => {
  const f = await fixture(t);
  const configured = await f.save({
    model: { baseUrl: 'http://text.example.test:4000/v1', modelId: 'timeout-fixture' },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  const {
    responseTimeoutSeconds: _responseTimeout,
    idleTimeoutSeconds: _idleTimeout,
    ...legacyModel
  } = f.store.settings().model;
  f.store.put('settings', { ...f.store.settings(), id: 'main', model: legacyModel });
  const task = f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Remain queued while equivalent defaults are saved.',
  });
  const defaults = await f.save({ model: { ...DEFAULT_MODEL_TIMEOUTS } });
  assert.equal(defaults.statusCode, 200, defaults.body);
  const baseline = f.store.get('settings', 'main');
  for (const model of [{ responseTimeoutSeconds: 1801 }, { idleTimeoutSeconds: 301 }]) {
    const blocked = await f.save({ model });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.deepEqual(f.store.get('settings', 'main'), baseline);
  }
  f.controller.updateTask(task.id, { status: 'completed' });
  const changed = await f.save({
    model: { responseTimeoutSeconds: 2400, idleTimeoutSeconds: 600 },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json<Settings>().model.responseTimeoutSeconds, 2400);
  assert.equal(changed.json<Settings>().model.idleTimeoutSeconds, 600);
});

test('paused image edits retain encrypted credentials only on the same origin and preserve queued work', async (t) => {
  const f = await fixture(t);
  const modelKey = 'synthetic-text-provider-secret';
  const imageKey = 'synthetic-image-provider-secret';
  const initial = await f.save({
    model: {
      baseUrl: 'http://text.example.test:4000/v1',
      modelId: 'text-fixture',
      apiKey: modelKey,
    },
    images: {
      baseUrl: 'http://images.example.test:5000/v1',
      modelId: 'image-fixture',
      enabled: true,
      apiKey: imageKey,
    },
  });
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(f.store.secret('model.apiKey'), modelKey);
  assert.equal(f.store.secret('image.apiKey'), imageKey);
  assert.equal(initial.json().model.apiKeyConfigured, true);
  assert.equal(initial.json().images.apiKeyConfigured, true);
  const snapshot = await f.app.inject({ method: 'GET', url: '/api/state' });
  const rawSettings = JSON.stringify(f.store.get('settings', 'main'));
  const encrypted = f.store.db.prepare('SELECT key,value FROM secrets').all() as Array<{
    key: string;
    value: string;
  }>;
  for (const key of [modelKey, imageKey]) {
    assert.equal(initial.body.includes(key), false);
    assert.equal(snapshot.body.includes(key), false);
    assert.equal(rawSettings.includes(key), false);
    assert.equal(
      encrypted.some((row) => row.value.includes(key)),
      false,
    );
  }
  assert.ok(encrypted.find((row) => row.key === 'image.apiKey')?.value.includes('.'));
  f.controller.pauseRoom('room_lounge');
  const task = f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Keep paused image work while the owner changes its provider and credentials.',
  });
  f.controller.updateTask(task.id, { status: 'waiting_tool' });
  f.controller.runtime!.isTaskSuspended = (id) => id === task.id;
  const beforeTask = f.store.get<Task>('tasks', task.id);
  const sameOrigin = await f.save({
    images: { baseUrl: 'http://IMAGES.example.test:5000/other/v1/' },
  });
  assert.equal(sameOrigin.statusCode, 200, sameOrigin.body);
  assert.equal(f.store.secret('image.apiKey'), imageKey);
  const changedOrigin = await f.save({ images: { baseUrl: 'http://images.example.test:5001/v1' } });
  assert.equal(changedOrigin.statusCode, 200, changedOrigin.body);
  assert.equal(f.store.secret('image.apiKey'), '');
  assert.equal(changedOrigin.json().images.apiKeyConfigured, false);
  assert.equal(f.store.secret('model.apiKey'), modelKey);
  const replacement = await f.save({
    images: {
      baseUrl: 'https://other-image.example.test/v1',
      apiKey: 'synthetic-replacement-image-key',
    },
  });
  assert.equal(replacement.statusCode, 200, replacement.body);
  assert.equal(f.store.secret('image.apiKey'), 'synthetic-replacement-image-key');
  assert.equal(f.store.secret('model.apiKey'), modelKey);
  const clear = await f.save({ images: { apiKey: '' } });
  assert.equal(clear.statusCode, 200, clear.body);
  assert.equal(clear.json().images.apiKeyConfigured, false);
  assert.equal(f.store.secret('image.apiKey'), '');
  assert.equal(f.store.secret('model.apiKey'), modelKey);
  assert.deepEqual(f.store.get<Task>('tasks', task.id), beforeTask);
  assert.equal(f.store.get<Room>('rooms', task.roomId)!.paused, true);
});

test('live capacity edits accept unchanged full forms while image connections and room policy stay pinned', async (t) => {
  const f = await fixture(t);
  const configured = await f.save({
    model: { baseUrl: 'http://text.example.test:4000/v1', modelId: 'text-fixture' },
    images: {
      baseUrl: 'http://images.example.test:5000/v1',
      modelId: 'image-fixture',
      apiKey: 'synthetic-pinned-key',
      shareInferenceSlot: true,
    },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  const task = f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Remain queued in the fixture.',
  });
  const before = f.configurations();
  const fullForm = await f.save({ ...f.store.settings(), inference: { maxConcurrentRequests: 4 } });
  assert.equal(fullForm.statusCode, 200, fullForm.body);
  assert.equal(fullForm.json().inference.maxConcurrentRequests, 4);
  assert.equal(f.configurations(), before + 1);
  const saved = f.store.settings();
  for (const images of [
    { enabled: true },
    { modelId: 'changed-image-model' },
    { baseUrl: 'http://images.example.test:5001/v1' },
    { shareInferenceSlot: false },
    { apiKey: 'synthetic-rejected-live-key' },
  ]) {
    const blocked = await f.save({ images });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.deepEqual(f.store.settings(), saved);
    assert.equal(f.store.secret('image.apiKey'), 'synthetic-pinned-key');
  }
  const unchanged = await f.app.inject({
    method: 'PATCH',
    url: '/api/rooms/room_lounge',
    payload: { parallelResponses: false },
  });
  assert.equal(unchanged.statusCode, 200, unchanged.body);
  const changed = await f.app.inject({
    method: 'PATCH',
    url: '/api/rooms/room_lounge',
    payload: { parallelResponses: true },
  });
  assert.equal(changed.statusCode, 409, changed.body);
  assert.equal(Boolean(f.store.get<Room>('rooms', 'room_lounge')?.parallelResponses), false);
  f.controller.updateTask(task.id, { status: 'completed' });
  const afterCompletion = await f.app.inject({
    method: 'PATCH',
    url: '/api/rooms/room_lounge',
    payload: { parallelResponses: true },
  });
  assert.equal(afterCompletion.statusCode, 200, afterCompletion.body);
  assert.equal(afterCompletion.json().parallelResponses, true);
});

test('bot image permission can change during active work without changing image credentials or network policy', async (t) => {
  const f = await fixture(t);
  const configured = await f.save({
    model: { baseUrl: 'http://text.example.test:4000/v1', modelId: 'text-fixture' },
    images: {
      enabled: true,
      baseUrl: 'http://images.example.test:5000/v1',
      modelId: 'image-permission-fixture',
      apiKey: 'synthetic-live-image-permission-key',
    },
    permissions: { network: 'ask' },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  assert.equal(f.store.settings().images?.permission, 'inherit');
  f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Remain active while image permission changes.',
  });
  for (const permission of ['allow', 'ask', 'deny', 'inherit'] as const) {
    const response = await f.save({ images: { permission } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<Settings>().images?.permission, permission);
    assert.equal(f.store.settings().permissions.network, 'ask');
    assert.equal(f.store.secret('image.apiKey'), 'synthetic-live-image-permission-key');
    assert.equal(f.store.settings().images?.modelId, 'image-permission-fixture');
  }
});

test(
  'real Pi transmits every selected reasoning effort exactly and never silently downgrades unsupported ultra',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t, true);
    const requests: Array<{ method?: string; path?: string; body: Record<string, unknown> }> = [];
    let rejectUltra = false;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push({ method: request.method, path: request.url, body });
      if (rejectUltra && body.reasoning_effort === 'ultra') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: { message: 'Fixture does not support reasoning_effort=ultra.' },
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finishReason] of [
        [{ content: 'Fixture reasoning effort accepted.' }, null],
        [{}, 'stop'],
      ] as const) {
        response.write(
          `data: ${JSON.stringify({ id: `reasoning-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'reasoning-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
        );
      }
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const initial = await f.save({
      model: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'reasoning-fixture',
        reasoningMode: 'openai',
      },
      autoLearn: false,
    });
    assert.equal(initial.statusCode, 200, initial.body);
    const run = async (prompt: string) => {
      const task = f.controller.enqueueTask({ roomId: 'room_lounge', botId: 'bot_aster', prompt });
      await until(
        () => ['completed', 'failed'].includes(f.store.get<Task>('tasks', task.id)!.status),
        prompt,
      );
      return f.store.get<Task>('tasks', task.id)!;
    };
    for (const effort of REASONING_EFFORTS) {
      const setting = await f.save({ model: { reasoningMode: 'openai', reasoningEffort: effort } });
      assert.equal(setting.statusCode, 200, setting.body);
      const count = requests.length;
      const task = await run(`Confirm selected reasoning effort ${effort}.`);
      assert.equal(task.status, 'completed', task.error);
      assert.equal(requests.length, count + 1, effort);
      assert.equal(requests.at(-1)?.method, 'POST');
      assert.equal(requests.at(-1)?.path, '/v1/chat/completions');
      assert.equal(requests.at(-1)?.body.reasoning_effort, effort, effort);
    }
    const serverDefault = await f.save({
      model: { reasoningMode: 'server', reasoningEffort: 'ultra' },
    });
    assert.equal(serverDefault.statusCode, 200, serverDefault.body);
    const serverTask = await run('Use the inference server default.');
    assert.equal(serverTask.status, 'completed', serverTask.error);
    assert.equal(Object.hasOwn(requests.at(-1)!.body, 'reasoning_effort'), false);
    rejectUltra = true;
    const ultra = await f.save({ model: { reasoningMode: 'openai', reasoningEffort: 'ultra' } });
    assert.equal(ultra.statusCode, 200, ultra.body);
    const count = requests.length;
    const rejected = await run('Report the configured effort error.');
    assert.equal(rejected.status, 'failed');
    assert.match(rejected.error ?? '', /Fixture does not support reasoning_effort=ultra/);
    assert.equal(requests.length, count + 1);
    assert.equal(requests.at(-1)?.body.reasoning_effort, 'ultra');
  },
);
