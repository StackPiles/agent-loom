import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue, Locale } from '../src/client/context';
import type { BrowserSettings, ModelSettings, Snapshot, Task } from '../src/shared/types';
import { DEFAULT_BROWSER_SETTINGS } from '../src/shared/browser';
import { MODEL_TOKEN_LIMITS } from '../src/shared/model-limits';
import { DEFAULT_MODEL_TIMEOUTS, MODEL_TIMEOUT_LIMITS } from '../src/shared/model-settings';

// Isolate the settings form: no application stream, timers, or model requests.
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: 'http://localhost:3210',
});
for (const name of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement'])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: (dom.window as unknown as Record<string, unknown>)[name],
  });
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  fetch: async (url: string) => {
    assert.equal(url, '/api/auth');
    return new Response(JSON.stringify({ required: false }));
  },
});
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('../src/client/context');
const { SettingsPage } = await import('../src/client/SettingsPage');
let root: ReturnType<typeof createRoot> | undefined;
const mutations: { path: string; method?: string; body?: unknown }[] = [];

async function mount(
  model: Partial<ModelSettings> = {},
  locale: Locale = 'en',
  maxHandoffs: number | null = 6,
  options: {
    browser?: BrowserSettings;
    tasks?: Task[];
    rooms?: Snapshot['rooms'];
    queue?: Snapshot['queue'];
    connected?: boolean;
  } = {},
) {
  if (root) await act(async () => root?.unmount());
  localStorage.clear();
  mutations.length = 0;
  const data: Snapshot = {
    version: 'test',
    settings: {
      model: {
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'synthetic-model',
        apiKeyConfigured: false,
        contextWindow: 32768,
        maxOutputTokens: 4096,
        temperature: 0.7,
        ...model,
      },
      demoMode: false,
      autoLearn: true,
      maxHandoffs,
      workspacePath: './workspace',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
      ...(options.browser ? { browser: options.browser } : {}),
    },
    bots: [],
    rooms: options.rooms ?? [],
    messages: [],
    tasks: options.tasks ?? [],
    activities: [],
    approvals: [],
    skills: [],
    memories: [],
    automations: [],
    notifications: [],
    queue: options.queue ?? { active: 0, waiting: 0 },
  };
  const context: AppContextValue = {
    data,
    connected: options.connected,
    locale,
    t: (ja, en) => (locale === 'ja' ? ja : en),
    view: 'settings',
    roomId: '',
    navigate() {},
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string, method?: string, body?: unknown) {
      mutations.push({ path, method, body });
      return {} as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root!.render(
      <AppContext.Provider value={context}>
        <SettingsPage />
      </AppContext.Provider>,
    );
  });
}
function select(label: string) {
  const element = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  assert.ok(element, `Expected select: ${label}`);
  return element;
}
function option(element: HTMLSelectElement, value: number | string) {
  const result = [...element.options].find((item) => item.value === String(value));
  assert.ok(result, `Expected option: ${value}`);
  return result;
}
async function choose(element: HTMLSelectElement, value: string | number) {
  await act(async () => {
    element.value = String(value);
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
}
function numberInput(label: string) {
  const element = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  assert.ok(element, `Expected input: ${label}`);
  return element;
}
function toggle(label: string) {
  const row = [...document.querySelectorAll('label.toggle-row')].find(
    (node) => node.querySelector('strong')?.textContent === label,
  );
  const input = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(input, 'Missing toggle: ' + label);
  return input;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function enterNumber(element: HTMLInputElement, value: number | string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      element,
      String(value),
    );
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function save() {
  await act(async () => {
    document
      .querySelector('form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  const mutation = mutations.at(-1);
  assert.equal(mutation?.path, '/settings');
  assert.equal(mutation.method, 'PUT');
  return mutation.body as {
    model: ModelSettings;
    maxHandoffs: number | null;
    permissions: Snapshot['settings']['permissions'];
  };
}

test('handoff choices save unlimited, finite and disabled without reinterpreting saved zero', async () => {
  await mount({}, 'en', null);
  assert.equal(select('Bot handoffs').value, 'unlimited');
  assert.equal(document.querySelector('input[aria-label="Maximum handoffs per task"]'), null);
  assert.equal((await save()).maxHandoffs, null);

  await choose(select('Bot handoffs'), 'limited');
  assert.equal((await save()).maxHandoffs, 6);
  await choose(select('Bot handoffs'), 'disabled');
  assert.equal((await save()).maxHandoffs, 0);
  await choose(select('Bot handoffs'), 'unlimited');
  assert.equal((await save()).maxHandoffs, null);

  await mount({}, 'ja', 0);
  assert.equal(select('ボット間の引き継ぎ').value, 'disabled');
  assert.equal((await save()).maxHandoffs, 0);
  await mount({}, 'en', 125);
  assert.equal(select('Bot handoffs').value, 'limited');
  assert.equal((await save()).maxHandoffs, 125);
});

test('image input can be enabled without Chrome and preserves legacy or explicit saved choices', async () => {
  await mount();
  assert.equal(toggle('Enable image input').checked, false);
  assert.equal((await save()).model.imageInput, false);
  assert.equal(
    document.querySelector('#model-image-input'),
    toggle('Enable image input').closest('div'),
  );
  await click(toggle('Enable image input'));
  const enabled = await save();
  assert.equal(enabled.model.imageInput, true);
  assert.equal('browser' in enabled, false, 'Image viewing does not enable Chrome');
  assert.equal('apiKey' in enabled.model, false);

  const legacyBrowser = { ...DEFAULT_BROWSER_SETTINGS, includeScreenshotsInModel: true };
  await mount({}, 'ja', 6, { browser: legacyBrowser });
  assert.equal(toggle('画像入力を有効にする').checked, true);
  assert.equal((await save()).model.imageInput, true);
  await click(toggle('画像入力を有効にする'));
  assert.equal((await save()).model.imageInput, false);

  await mount({ imageInput: false, apiKeyConfigured: true }, 'en', 6, { browser: legacyBrowser });
  assert.equal(
    toggle('Enable image input').checked,
    false,
    'Explicit off overrides old screenshot opt-in',
  );
  await click(toggle('Enable image input'));
  const edited = await save();
  assert.equal(edited.model.imageInput, true);
  assert.equal('apiKey' in edited.model, false, 'Changing capability keeps the saved credential');
});

test('image input stays pinned while a task waits for model capacity', async () => {
  await mount({ imageInput: true }, 'en', 6, {
    tasks: [{ id: 'vision-task', status: 'waiting_model' } as Task],
  });
  assert.equal(toggle('Enable image input').checked, true);
  assert.equal(toggle('Enable image input').disabled, true);
  await click(toggle('Enable image input'));
  assert.equal((await save()).model.imageInput, true);
  assert.match(
    document.body.textContent ?? '',
    /Pause work in every room and wait for the current actions to finish/,
  );
});

test('image input remains available for finished work and queued work in a paused room', async () => {
  const pausedRoom = { id: 'vision-room', paused: true } as Snapshot['rooms'][number];
  for (const status of ['stopped', 'interrupted', 'completed', 'failed', 'queued'] as const) {
    await mount({ imageInput: false }, 'en', 6, {
      connected: true,
      rooms: [pausedRoom],
      tasks: [{ id: 'vision-task', roomId: pausedRoom.id, status } as Task],
    });
    assert.equal(
      toggle('Enable image input').disabled,
      false,
      `${status} must not pin image input`,
    );
    await click(toggle('Enable image input'));
    assert.equal((await save()).model.imageInput, true);
  }
});

test('image input requires both a paused room and a confirmed pause for work that has started', async () => {
  const running = { id: 'vision-task', roomId: 'vision-room', status: 'waiting_tool' } as Task;
  for (const [paused, confirmed, locked] of [
    [true, false, true],
    [false, true, true],
    [true, true, false],
  ] as const) {
    await mount({ imageInput: false }, 'en', 6, {
      connected: true,
      rooms: [{ id: running.roomId, paused } as Snapshot['rooms'][number]],
      tasks: [running],
      queue: {
        active: 0,
        waiting: 1,
        waitingTasks: confirmed ? [{ taskId: running.id, reason: 'paused' }] : [],
      },
    });
    assert.equal(toggle('Enable image input').disabled, locked);
    await click(toggle('Enable image input'));
    assert.equal((await save()).model.imageInput, !locked);
  }
});

test('image input does not trust the last snapshot while disconnected', async () => {
  await mount({ imageInput: true }, 'en', 6, { connected: false });
  assert.equal(toggle('Enable image input').disabled, true);
  assert.match(document.body.textContent ?? '', /Reconnect before changing these options/);
  await click(toggle('Enable image input'));
  assert.equal((await save()).model.imageInput, true);
});

test('token selectors offer supported powers of two and preserve custom saved values exactly', async () => {
  await mount({ contextWindow: 123456, maxOutputTokens: 12000 });
  const context = select('Context window');
  const output = select('Max output tokens');
  assert.equal(context.value, '123456');
  assert.equal(output.value, '12000');
  assert.match(option(context, 123456).text, /Custom \(current value\).*123,456 tokens/);
  assert.match(option(output, 12000).text, /Custom \(current value\).*12,000 tokens/);
  assert.equal(option(context, 32768).text, '2^15 · 32,768 tokens');
  assert.equal(option(output, 128).text, '2^7 · 128 tokens');
  assert.equal(option(context, 2 ** 20).text, '1M · 2^20 · 1,048,576 tokens');
  assert.equal(option(context, 2 ** 21).text, '2M · 2^21 · 2,097,152 tokens');
  assert.equal(option(output, 2 ** 17).text, '2^17 · 131,072 tokens');
  assert.equal(option(output, 2 ** 20).text, '1M · 2^20 · 1,048,576 tokens');
  for (const [element, custom, range] of [
    [context, 123456, MODEL_TOKEN_LIMITS.contextWindow],
    [output, 12000, MODEL_TOKEN_LIMITS.maxOutputTokens],
  ] as const) {
    for (const entry of element.options) {
      const value = Number(entry.value);
      assert.ok(value >= range.min && value <= range.max);
      if (value !== custom) assert.ok(Number.isInteger(Math.log2(value)));
    }
  }
  await choose(context, 262144);
  assert.equal(output.value, '12000', 'Changing context does not round an existing output limit');
  assert.match(option(context, 123456).text, /Custom \(saved value\)/);
  await choose(context, 123456);
  const saved = await save();
  assert.equal(saved.model.contextWindow, 123456);
  assert.equal(saved.model.maxOutputTokens, 12000);
  assert.equal('apiKey' in saved.model, false);
  assert.equal(
    'reasoningMode' in saved.model,
    false,
    'An untouched optional setting stays omitted',
  );
});

test('token selectors require output smaller than context without silently changing either value', async () => {
  await mount();
  const context = select('Context window');
  const output = select('Max output tokens');
  assert.equal(option(context, 4096).disabled, true);
  assert.equal(option(output, 32768).disabled, true);
  assert.equal(option(output, 65536).disabled, true);
  assert.equal(option(output, 128).disabled, false);
  await choose(context, 4096);
  assert.equal(context.value, '32768', 'Even a synthetic change cannot choose an invalid context');
  await choose(output, 32768);
  assert.equal(output.value, '4096', 'Output equal to context is rejected');
  await choose(output, 1024);
  assert.equal(option(context, 2048).disabled, false);
  await choose(context, 2048);
  assert.equal(option(output, 2048).disabled, true);
  const saved = await save();
  assert.equal(saved.model.contextWindow, 2048);
  assert.equal(saved.model.maxOutputTokens, 1024);

  await mount({ contextWindow: 2_000_000, maxOutputTokens: 128_000 }, 'ja');
  assert.match(option(select('コンテキスト上限'), 2_000_000).text, /カスタム（現在の値）/);
  assert.match(option(select('出力トークン上限'), 128_000).text, /128,000 トークン/);
  const legacyCustom = await save();
  assert.equal(legacyCustom.model.contextWindow, 2_000_000);
  assert.equal(legacyCustom.model.maxOutputTokens, 128_000);
  await choose(select('コンテキスト上限'), 2 ** 21);
  await choose(select('出力トークン上限'), 2 ** 20);
  const upperBounds = await save();
  assert.equal(upperBounds.model.contextWindow, 2 ** 21);
  assert.equal(upperBounds.model.maxOutputTokens, 2 ** 20);
});

test('million-token budgets preserve room for input and save the selected powers of two exactly', async () => {
  await mount();
  const context = select('Context window');
  const output = select('Max output tokens');
  await choose(context, 2 ** 20);
  await choose(output, 2 ** 19);
  assert.equal(option(output, 2 ** 20).disabled, true);
  const millionContext = await save();
  assert.equal(millionContext.model.contextWindow, 1_048_576);
  assert.equal(millionContext.model.maxOutputTokens, 524_288);

  await choose(output, 2 ** 20);
  assert.equal(output.value, '524288', 'A synthetic change cannot select output equal to context');
  await choose(context, 2 ** 21);
  assert.equal(option(output, 2 ** 20).disabled, false);
  await choose(output, 2 ** 20);
  assert.equal(option(context, 2 ** 20).disabled, true);
  const millionOutput = await save();
  assert.equal(millionOutput.model.contextWindow, 2_097_152);
  assert.equal(millionOutput.model.maxOutputTokens, 1_048_576);
  assert.match(document.body.textContent || '', /Total budget for input, history, and output/);
});

test('smart approval and optional reasoning controls save explicitly without changing existing defaults', async () => {
  await mount();
  const mode = select('Reasoning mode');
  const effort = select('Reasoning effort');
  assert.equal(mode.value, 'server');
  assert.equal(effort.value, 'medium');
  assert.equal(effort.disabled, true);
  assert.equal(select('Shell commands').value, 'ask');
  assert.equal(select('File writes').value, 'ask');
  assert.equal(select('External network access').value, 'allow');
  assert.match(
    document.body.textContent || '',
    /Overwrites and arbitrary commands still need approval/,
  );
  assert.match(document.body.textContent || '', /Reasoning appears only when the model returns it/);
  await choose(mode, 'openai');
  assert.equal(effort.disabled, false);
  await choose(effort, 'high');
  await choose(select('File writes'), 'auto');
  const enabled = await save();
  assert.equal(enabled.model.reasoningMode, 'openai');
  assert.equal(enabled.model.reasoningEffort, 'high');
  assert.deepEqual(enabled.permissions, { shell: 'ask', fileWrite: 'auto', network: 'allow' });
  await choose(mode, 'server');
  assert.equal(effort.disabled, true);
  assert.equal(effort.value, 'high', 'Switching mode does not discard the chosen effort');
  const disabled = await save();
  assert.equal(disabled.model.reasoningMode, 'server');
  assert.equal(disabled.model.reasoningEffort, 'high');
});

test('model timeout controls show legacy defaults, preserve omission, and save exact edited or saved values', async () => {
  await mount();
  const response = numberInput('First response timeout (seconds)');
  const idle = numberInput('Output idle timeout (seconds)');
  assert.equal(response.value, String(DEFAULT_MODEL_TIMEOUTS.responseTimeoutSeconds));
  assert.equal(idle.value, String(DEFAULT_MODEL_TIMEOUTS.idleTimeoutSeconds));
  for (const element of [response, idle]) {
    assert.ok(element.closest('.advanced-settings'));
    assert.equal(element.min, String(MODEL_TIMEOUT_LIMITS.min));
    assert.equal(element.max, String(MODEL_TIMEOUT_LIMITS.max));
    assert.equal(element.step, '1');
    assert.equal(element.required, true);
  }
  const unchanged = await save();
  assert.equal('responseTimeoutSeconds' in unchanged.model, false);
  assert.equal('idleTimeoutSeconds' in unchanged.model, false);
  assert.equal('apiKey' in unchanged.model, false);
  assert.match(document.body.textContent!, /Waiting in Loom’s queue does not count/);
  assert.match(document.body.textContent!, /answer, reasoning, or tool-call output/);

  await enterNumber(response, 2345);
  const firstEdited = await save();
  assert.equal(firstEdited.model.responseTimeoutSeconds, 2345);
  assert.equal('idleTimeoutSeconds' in firstEdited.model, false);
  await enterNumber(idle, 79);
  const bothEdited = await save();
  assert.equal(bothEdited.model.responseTimeoutSeconds, 2345);
  assert.equal(bothEdited.model.idleTimeoutSeconds, 79);

  await mount(
    { responseTimeoutSeconds: 2147, idleTimeoutSeconds: 119, apiKeyConfigured: true },
    'ja',
  );
  assert.equal(numberInput('初回応答の待機上限（秒）').value, '2147');
  assert.equal(numberInput('出力中の無応答時間（秒）').value, '119');
  const saved = await save();
  assert.equal(saved.model.responseTimeoutSeconds, 2147);
  assert.equal(saved.model.idleTimeoutSeconds, 119);
  assert.equal('apiKey' in saved.model, false, 'Editing timeouts must not clear a saved key');
});

test('model timeout controls accept both boundaries and block invalid values without rounding', async () => {
  await mount();
  const response = numberInput('First response timeout (seconds)');
  const idle = numberInput('Output idle timeout (seconds)');
  await enterNumber(response, 10);
  await enterNumber(idle, 86_400);
  const boundaries = await save();
  assert.equal(boundaries.model.responseTimeoutSeconds, 10);
  assert.equal(boundaries.model.idleTimeoutSeconds, 86_400);
  for (const element of [response, idle]) {
    for (const value of [9, 86_401, 10.5, '']) {
      await enterNumber(element, value);
      const previous = mutations.length;
      await act(async () => {
        document
          .querySelector('form')!
          .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      });
      assert.equal(mutations.length, previous, `Invalid timeout ${value} must not be saved`);
      assert.match(document.querySelector('[role="alert"]')!.textContent!, /whole-number timeouts/);
      assert.equal(
        document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled,
        true,
      );
    }
    await enterNumber(element, 10);
  }
  await enterNumber(response, 86_400);
  const reversed = await save();
  assert.equal(reversed.model.responseTimeoutSeconds, 86_400);
  assert.equal(reversed.model.idleTimeoutSeconds, 10);
});

after(async () => {
  if (root) await act(async () => root?.unmount());
  dom.window.close();
});
