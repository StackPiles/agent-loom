import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type {
  ImageStorageItem,
  ImageStorageOverview,
  ImageStorageSettings,
} from '../src/shared/image-storage';
import type { Snapshot } from '../src/shared/types';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3210',
  pretendToBeVisual: true,
});
for (const name of [
  'window',
  'document',
  'navigator',
  'localStorage',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'HTMLDialogElement',
  'Element',
  'Event',
  'MouseEvent',
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: (dom.window as unknown as Record<string, unknown>)[name],
  });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
dom.window.HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};
dom.window.HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open');
};
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('../src/client/context');
const { StorageSettings } = await import('../src/client/StorageSettings');

const stamp = '2026-09-01T00:00:00.000Z';
const ids = ['a', 'b', 'c'].map((letter) => `img_${letter.repeat(64)}`);
const image = (index: number, protectedValue = false): ImageStorageItem => ({
  id: ids[index],
  type: 'image',
  mimeType: 'image/png',
  filename: ['large-draft.png', 'small-draft.png', 'uploaded-reference.png'][index],
  byteLength: [10_485_760, 2_097_152, 1_048_576][index],
  prompt: '',
  model: 'local-image-model',
  createdAt: stamp,
  source: protectedValue ? 'uploaded' : 'generated',
  storage: { initializedAt: stamp, lastUsedAt: stamp, protected: protectedValue },
  candidate: !protectedValue,
  eligibleAt: '2026-10-01T00:00:00.000Z',
  blockedReasons: protectedValue ? ['protected'] : [],
  roomNames: ['Project images'],
});
type RequestRecord = { path: string; method: string; body: unknown };
let root: ReturnType<typeof createRoot> | undefined;
let context: AppContextValue;
let images: ImageStorageItem[];
let settings: ImageStorageSettings;
let duplicateBytes: number;
let custom: ((request: RequestRecord) => Promise<Response | undefined>) | undefined;
const requests: RequestRecord[] = [];

function overview(url: URL): ImageStorageOverview {
  let filtered = images.filter((item) => {
    const filter = url.searchParams.get('filter');
    if (filter === 'candidates') return item.candidate;
    if (filter === 'protected') return item.storage.protected && !item.storage.deletedAt;
    if (filter === 'deleted') return !!item.storage.deletedAt;
    return true;
  });
  if (url.searchParams.get('sort') === 'largest')
    filtered = filtered.toSorted((a, b) => b.byteLength - a.byteLength);
  const offset = Number(url.searchParams.get('offset') || 0);
  const limit = Number(url.searchParams.get('limit') || 25);
  return {
    settings,
    usage: {
      totalBytes: 18_874_368,
      logicalBytes: 20_971_520,
      duplicateBytes,
      categories: [
        { kind: 'originals', bytes: 13_631_488, files: 3 },
        { kind: 'history', bytes: 2_097_152, files: 2 },
        { kind: 'backups', bytes: 2_097_152, files: 1 },
        { kind: 'uploads', bytes: 1_048_576, files: 1 },
      ],
      imageCount: images.filter((item) => !item.storage.deletedAt).length,
      protectedCount: images.filter((item) => item.storage.protected).length,
      candidateCount: images.filter((item) => item.candidate).length,
      candidateBytes: images
        .filter((item) => item.candidate)
        .reduce((total, item) => total + item.byteLength, 0),
    },
    images: filtered.slice(offset, offset + limit),
    total: filtered.length,
    offset,
    limit,
    warnings: [
      '移行時のバックアップとブラウザー送信用の一時コピーは、画像原本の整理とは別に管理されます。',
    ],
  };
}

async function mount(locale: 'en' | 'ja' = 'en', connected = true) {
  images = [image(0), image(1), image(2, true)];
  settings = { autoCleanup: false, unusedDays: 30 };
  duplicateBytes = 2_097_152;
  custom = undefined;
  requests.length = 0;
  Object.assign(globalThis, {
    fetch: async (path: string, init: RequestInit = {}) => {
      const request = {
        path,
        method: init.method || 'GET',
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      requests.push(request);
      const special = await custom?.(request);
      if (special) return special;
      const url = new URL(path, 'http://localhost:3210');
      if (url.pathname === '/api/image-storage' && request.method === 'GET')
        return Response.json(overview(url));
      if (url.pathname === '/api/image-storage/settings') {
        settings = request.body;
        return Response.json(settings);
      }
      if (url.pathname === '/api/image-storage/protection') {
        const { imageIds, protected: next } = request.body;
        images = images.map((item) =>
          imageIds.includes(item.id)
            ? { ...item, storage: { ...item.storage, protected: next }, candidate: !next }
            : item,
        );
        return Response.json({ updated: imageIds.length });
      }
      if (url.pathname === '/api/image-storage/cleanup')
        return Response.json({ deletedImages: 0, freedBytes: 0, skipped: [] });
      if (url.pathname === '/api/image-storage/deduplicate') {
        duplicateBytes = 0;
        return Response.json({ consolidatedImages: 2, freedBytes: 2_097_152 });
      }
      throw new Error(`Unexpected storage request: ${request.method} ${path}`);
    },
  });
  context = {
    data: {} as Snapshot,
    connected,
    locale,
    t: (ja, en) => (locale === 'ja' ? ja : en),
    view: 'settings',
    roomId: '',
    navigate() {},
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate() {
      throw new Error('Storage uses its independent API.');
    },
  };
  root = createRoot(document.getElementById('root')!);
  await render();
}

async function render() {
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        <StorageSettings />
      </AppContext.Provider>,
    ),
  );
}

function button(label: string, parent: ParentNode = document) {
  const found = [...parent.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
  );
  assert.ok(found, `Missing button: ${label}`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function choose(label: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
}
async function number(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function selectImage(filename: string) {
  await click(document.querySelector<HTMLInputElement>(`input[aria-label="Select ${filename}"]`)!);
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});
after(() => dom.window.close());

test('storage scans only when opened, presents usage, and batches protection for the selected images', async () => {
  await mount();
  assert.deepEqual(requests, [], 'collapsed settings do not scan disk');
  await click(button('Manage storage'));
  const text = document.getElementById('image-storage-panel')!.textContent!;
  for (const label of [
    'Original images',
    'Conversation images',
    'Earlier migration backups',
    'Temporary upload files',
    '18 MB',
    'Uploaded images are kept by default',
    'Migration backups and temporary browser upload copies are managed separately',
  ])
    assert.ok(text.includes(label), label);
  assert.equal(document.querySelector<HTMLInputElement>('.toggle-row input')!.checked, false);
  assert.equal(document.querySelector<HTMLInputElement>('input[type="number"]')!.value, '30');
  await selectImage('large-draft.png');
  await selectImage('small-draft.png');
  await click(button('Keep'));
  const mutation = requests.find((request) => request.method === 'POST')!;
  assert.deepEqual(mutation, {
    path: '/api/image-storage/protection',
    method: 'POST',
    body: { imageIds: ids.slice(0, 2), protected: true },
  });
  assert.ok(document.body.textContent!.includes('2 image(s) protected from cleanup.'));
  await choose('Filter images', 'protected');
  assert.equal(document.querySelectorAll('.storage-image-row').length, 3);
  assert.equal(
    requests.some((request) => request.path.endsWith('/cleanup')),
    false,
  );
});

test('cleanup reviews exact selected originals, supports cancellation, and reports skipped images', async () => {
  await mount();
  await click(button('Manage storage'));
  await selectImage('small-draft.png');
  await click(button('Review cleanup'));
  let modal = document.querySelector<HTMLDialogElement>('dialog[open]')!;
  assert.ok(modal.textContent!.includes('small-draft.png'));
  assert.ok(!modal.textContent!.includes('large-draft.png'));
  assert.equal(
    requests.some((request) => request.method === 'POST'),
    false,
  );
  await act(async () => modal.dispatchEvent(new dom.window.Event('cancel', { cancelable: true })));
  assert.equal(document.querySelector('dialog[open]'), null);
  assert.equal(
    requests.some((request) => request.method === 'POST'),
    false,
  );
  await click(button('Review cleanup'));
  modal = document.querySelector<HTMLDialogElement>('dialog[open]')!;
  custom = async (request) => {
    if (!request.path.endsWith('/cleanup')) return;
    assert.deepEqual(request.body, { imageIds: [ids[1]] });
    images[1] = {
      ...images[1],
      storage: { ...images[1].storage, protected: true },
      candidate: false,
    };
    return Response.json({
      deletedImages: 0,
      freedBytes: 0,
      skipped: [{ id: ids[1], reason: 'protected' }],
    });
  };
  await click(button('Clean up 1 original(s)', modal));
  assert.equal(document.querySelector('dialog[open]'), null);
  assert.match(document.body.textContent!, /Kept 1 image\(s\) whose eligibility changed/);
  assert.equal(images[0].storage.deletedAt, undefined, 'unselected originals were never submitted');
});

test('storage rules validate retention and save independently only after the explicit save action', async () => {
  await mount();
  await click(button('Manage storage'));
  await number('0');
  assert.equal(button('Save storage rules').disabled, true);
  assert.match(document.body.textContent!, /whole number from 1 to 3650/);
  await number('45');
  await click(document.querySelector<HTMLInputElement>('.toggle-row input')!);
  assert.equal(
    requests.some((request) => request.method === 'PATCH'),
    false,
  );
  await click(button('Save storage rules'));
  assert.deepEqual(
    requests.find((request) => request.method === 'PATCH'),
    {
      path: '/api/image-storage/settings',
      method: 'PATCH',
      body: { autoCleanup: true, unusedDays: 45 },
    },
  );
  assert.equal(button('Save storage rules').disabled, true);
  assert.match(document.body.textContent!, /Storage rules saved/);
});

test('filter and sort changes clear selection and show cleaned records without image requests', async () => {
  await mount();
  await click(button('Manage storage'));
  await selectImage('large-draft.png');
  await choose('Sort images', 'oldest');
  assert.equal(
    document.querySelector<HTMLInputElement>('.storage-row-select input')!.checked,
    false,
  );
  assert.ok(requests.at(-1)!.path.includes('sort=oldest'));
  images[0] = {
    ...images[0],
    candidate: false,
    storage: { ...images[0].storage, deletedAt: '2026-11-17T03:00:00.000Z' },
  };
  await choose('Filter images', 'deleted');
  const row = document.querySelector('.storage-image-row')!;
  assert.match(row.textContent!, /Original cleaned up/);
  assert.equal(row.querySelector('img'), null);
  assert.equal(row.querySelector('a'), null);
  assert.equal(row.querySelector<HTMLInputElement>('input')!.disabled, true);
});

test('storage read failures can be retried and disconnected sessions cannot mutate storage', async () => {
  await mount();
  custom = async () => Response.json({ error: 'Synthetic scan failure' }, { status: 500 });
  await click(button('Manage storage'));
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /Synthetic scan failure/);
  custom = undefined;
  await click(button('Reload'));
  await selectImage('large-draft.png');
  context = { ...context, connected: false };
  await render();
  assert.equal(button('Keep').disabled, true);
  assert.equal(button('Review cleanup').disabled, true);
  assert.equal(button('Consolidate duplicates').disabled, true);
});

test('duplicate consolidation is explicit, keeps originals, and renders Japanese controls', async () => {
  await mount('ja');
  await click(button('管理を開く'));
  assert.match(document.body.textContent!, /整理までの未使用日数/);
  assert.match(document.body.textContent!, /移行時のバックアップとブラウザー送信用の一時コピー/);
  assert.equal(
    requests.some((request) => request.method === 'POST'),
    false,
  );
  await click(button('重複をまとめる'));
  assert.deepEqual(
    requests.find((request) => request.method === 'POST'),
    {
      path: '/api/image-storage/deduplicate',
      method: 'POST',
      body: {},
    },
  );
  assert.equal(images.filter((item) => !item.storage.deletedAt).length, 3);
  assert.match(document.body.textContent!, /2件の重複をまとめ/);
  assert.equal(button('重複をまとめる').disabled, true);
});
