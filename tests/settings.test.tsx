import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue, Locale } from '../src/client/context';
import type { ModelSettings, Snapshot } from '../src/shared/types';
import { MODEL_TOKEN_LIMITS } from '../src/shared/model-limits';

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

async function mount(model: Partial<ModelSettings> = {}, locale: Locale = 'en') {
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
      maxHandoffs: 6,
      workspacePath: './workspace',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: [],
    rooms: [],
    messages: [],
    tasks: [],
    activities: [],
    approvals: [],
    skills: [],
    memories: [],
    automations: [],
    notifications: [],
    queue: { active: 0, waiting: 0 },
  };
  const context: AppContextValue = {
    data,
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
    permissions: Snapshot['settings']['permissions'];
  };
}

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
  assert.equal(option(context, 2 ** 21).text, '2^21 · 2,097,152 tokens');
  assert.equal(option(output, 2 ** 17).text, '2^17 · 131,072 tokens');
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
  await choose(select('出力トークン上限'), 2 ** 17);
  const upperBounds = await save();
  assert.equal(upperBounds.model.contextWindow, 2 ** 21);
  assert.equal(upperBounds.model.maxOutputTokens, 2 ** 17);
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

after(async () => {
  if (root) await act(async () => root?.unmount());
  dom.window.close();
});
