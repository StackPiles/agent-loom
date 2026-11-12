import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: 'http://localhost:3210',
});
for (const name of ['window', 'document', 'navigator', 'HTMLElement'])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: (dom.window as unknown as Record<string, unknown>)[name],
  });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('../src/client/context');
const { ModelPicker } = await import('../src/client/ModelPicker');
type Props = Omit<React.ComponentProps<typeof ModelPicker>, 'onChange'>;
const context = { t: (_ja: string, en: string) => en } as AppContextValue;
let root: ReturnType<typeof createRoot> | undefined;
let props: Props;
const calls: { body: Record<string, unknown>; signal?: AbortSignal | null }[] = [];
let response: () => Promise<Response>;
Object.assign(globalThis, {
  fetch: async (path: string, init: RequestInit) => {
    assert.equal(path, '/api/settings/test');
    assert.equal(init.method, 'POST');
    calls.push({ body: JSON.parse(String(init.body)), signal: init.signal });
    return response();
  },
});
function list(models: string[]) {
  return Response.json({ ok: true, models, message: 'Fixture models' });
}
function render() {
  root!.render(
    <AppContext.Provider value={context}>
      <ModelPicker
        {...props}
        onChange={(value) => {
          props = { ...props, value };
          render();
        }}
      />
    </AppContext.Provider>,
  );
}
async function mount(target: Props['target'] = 'images') {
  if (root) await act(async () => root!.unmount());
  props = {
    target,
    baseUrl: 'http://localhost:8080/v1',
    value: 'saved-model',
    apiKey: '',
    keyDirty: false,
    disabled: false,
  };
  calls.length = 0;
  response = async () => list(['model-a', 'model-b']);
  root = createRoot(document.getElementById('root')!);
  await act(async () => render());
}
async function update(values: Partial<Props>) {
  await act(async () => {
    props = { ...props, ...values };
    render();
  });
}
async function load() {
  await act(async () => document.querySelector<HTMLButtonElement>('button')!.click());
}
function selection() {
  return document.querySelector<HTMLSelectElement>('select');
}
function input() {
  return document.querySelector<HTMLInputElement>('input')!;
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => (resolve = done));
  return { promise, resolve };
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
});
after(() => dom.window.close());

test('both model pickers retain custom IDs and expose every discovered model without auto-selecting', async () => {
  for (const target of ['model', 'images'] as const) {
    await mount(target);
    const models = Array.from({ length: 20 }, (_, index) => `candidate-${index}`);
    response = async () => list(models);
    await load();
    assert.deepEqual(calls[0].body, {
      target,
      baseUrl: props.baseUrl,
      modelId: 'saved-model',
    });
    assert.equal(input().value, 'saved-model');
    assert.equal(selection()!.value, 'saved-model');
    assert.match(selection()!.selectedOptions[0].textContent!, /current ID, not listed/);
    assert.deepEqual(
      [...selection()!.options].slice(2).map((option) => option.value),
      models,
    );
    await act(async () => {
      selection()!.value = 'candidate-19';
      selection()!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.equal(input().value, 'candidate-19');
    assert.equal(selection()!.value, 'candidate-19');
    assert.equal(selection()!.options.length, 21, 'Selecting an ID keeps the complete list.');
    await update({ value: 'custom-after-discovery' });
    assert.equal(selection()!.value, 'custom-after-discovery');
    assert.equal(calls.length, 1, 'Manual changes never fetch or save automatically.');
  }
});

test('discovery uses only explicit draft credentials and keeps manual entry available after empty or failed lists', async () => {
  await mount();
  await load();
  assert.equal(Object.hasOwn(calls[0].body, 'apiKey'), false);
  await update({ apiKey: 'draft-image-key', keyDirty: true });
  assert.equal(selection(), null, 'Editing credentials invalidates the previous list.');
  await load();
  assert.equal(calls.at(-1)!.body.apiKey, 'draft-image-key');
  await update({ apiKey: '' });
  response = async () => list([]);
  await load();
  assert.equal(calls.at(-1)!.body.apiKey, '');
  assert.match(document.body.textContent!, /model list is empty/);
  assert.match(document.body.textContent!, /enter a model ID manually/);
  assert.equal(input().value, 'saved-model');
  assert.equal(input().disabled, false);
  response = async () => Response.json({ ok: false, models: [], message: 'HTTP 404' });
  await load();
  assert.match(document.body.textContent!, /Could not load.*HTTP 404/s);
  await update({ value: 'manually-configured-image' });
  assert.equal(input().value, 'manually-configured-image');
  response = async () => {
    throw new Error('Offline fixture');
  };
  await load();
  assert.match(document.body.textContent!, /Offline fixture/);
  assert.equal(document.querySelector<HTMLButtonElement>('button')!.disabled, false);
});

test('endpoint and key edits discard late responses while model-only edits retain discovery', async () => {
  for (const target of ['model', 'images'] as const) {
    await mount(target);
    const old = deferred();
    response = () => old.promise;
    await load();
    assert.equal(document.querySelector<HTMLButtonElement>('button')!.disabled, true);
    await update({ value: 'typed-while-loading' });
    assert.equal(calls[0].signal!.aborted, false);
    await update({ baseUrl: 'http://localhost:9000/v1' });
    assert.equal(calls[0].signal!.aborted, true);
    assert.equal(document.querySelector<HTMLButtonElement>('button')!.disabled, false);
    response = async () => list(['new-endpoint-model']);
    await load();
    await act(async () => old.resolve(list(['stale-endpoint-model'])));
    assert.equal(selection()!.options[2].value, 'new-endpoint-model');
    assert.equal(input().value, 'typed-while-loading');
    assert.doesNotMatch(document.body.textContent!, /stale-endpoint-model/);

    const oldKey = deferred();
    response = () => oldKey.promise;
    await load();
    const oldCall = calls.at(-1)!;
    await update({ apiKey: 'replacement-key', keyDirty: true });
    assert.equal(oldCall.signal!.aborted, true);
    await act(async () => oldKey.resolve(list(['stale-key-model'])));
    assert.equal(selection(), null);
    assert.equal(document.querySelector<HTMLButtonElement>('button')!.disabled, false);
  }
});

test('locking and unmounting invalidate in-flight lists without changing the draft ID', async () => {
  await mount();
  const pending = deferred();
  response = () => pending.promise;
  await load();
  await update({ disabled: true });
  assert.equal(calls[0].signal!.aborted, true);
  assert.equal(input().disabled, true);
  await load();
  assert.equal(calls.length, 1, 'A locked discovery control cannot send another request.');
  await update({ disabled: false });
  await act(async () => pending.resolve(list(['late-locked-model'])));
  assert.equal(selection(), null);
  assert.equal(input().value, 'saved-model');
  const unmounted = deferred();
  response = () => unmounted.promise;
  await load();
  const lastCall = calls.at(-1)!;
  await act(async () => root!.unmount());
  root = undefined;
  assert.equal(lastCall.signal!.aborted, true);
  await act(async () => unmounted.resolve(list(['late-unmounted-model'])));
  assert.equal(document.getElementById('root')!.textContent, '');
});
