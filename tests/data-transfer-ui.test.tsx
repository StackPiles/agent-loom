import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Snapshot } from '../src/shared/types';
import type {
  DataTransferInfo,
  DataTransferJob,
  DataTransferPreview,
} from '../src/shared/data-transfer';

// All transfer endpoints are fake. These tests never copy or replace a running Loom's data.
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost:3210' });
for (const name of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement'])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: (dom.window as unknown as Record<string, unknown>)[name],
  });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('../src/client/context');
const { DataTransferSettings } = await import('../src/client/DataTransferSettings');
const {
  captureTransferBrowserState,
  restoreTransferBrowserState,
  transferPasswordProblem,
  uploadTransferFile,
  waitForDataTransferJob,
  DataTransferPendingError,
} = await import('../src/client/data-transfer');

const password = 'a-transfer-secret-2026';
const id = '0123456789abcdef0123456789abcdef';
const jobBase = {
  id,
  createdAt: '2026-11-04T10:00:00Z',
  updatedAt: '2026-11-04T10:00:00Z',
  expiresAt: '2026-11-05T10:00:00Z',
};
const info: DataTransferInfo = {
  available: true,
  busy: false,
  maxArchiveBytes: 1024,
  chunkBytes: 4,
};
const preview: DataTransferPreview = {
  token: 'preview-only-token',
  version: '0.3.6',
  createdAt: jobBase.createdAt,
  platform: 'linux',
  counts: { bots: 4, rooms: 2, messages: 18, automations: 2, _internal_record_kind: 3 },
  currentCounts: { bots: 1, rooms: 1, messages: 3 },
  fileCount: 12,
  totalBytes: 123456,
  workspaces: [{ sourcePath: '/source/workspace', destinationPath: '/destination/workspace' }],
  warnings: ['Review the local model connection on this computer.'],
  disabledAutomations: 2,
  browserState: { 'loom.locale': 'ja', 'loom.room': 'imported-room' },
};
type Request = { url: string; method: string; body?: BodyInit | null; headers?: HeadersInit };
const requests: Request[] = [];
let handler: (request: Request) => Response | Promise<Response> = () => {
  throw new Error('Unexpected request');
};
globalThis.fetch = async (input, options) => {
  const request = {
    url: String(input),
    method: options?.method ?? 'GET',
    body: options?.body,
    headers: options?.headers,
  };
  requests.push(request);
  return handler(request);
};
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
const context: AppContextValue = {
  data: {} as Snapshot,
  locale: 'en',
  t: (_ja, en) => en,
  view: 'settings',
  roomId: '',
  navigate() {},
  async refresh() {},
  toast() {},
  async signOut() {},
  async mutate<T>() {
    return {} as T;
  },
};
let root: ReturnType<typeof createRoot> | undefined;
async function mount(hasChanges = false) {
  if (root) await act(async () => root?.unmount());
  root = createRoot(document.getElementById('root')!);
  requests.length = 0;
  localStorage.clear();
  await render(hasChanges);
}
async function render(hasChanges: boolean) {
  await act(async () => {
    root!.render(
      <AppContext.Provider value={context}>
        <DataTransferSettings hasChanges={hasChanges} />
      </AppContext.Provider>,
    );
  });
}
function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label,
  );
  assert.ok(result, `Expected button: ${label}`);
  return result;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}
function field(label: string) {
  const result = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  assert.ok(result, `Expected input: ${label}`);
  return result;
}
async function type(label: string, value: string) {
  await act(async () => {
    const input = field(label);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function chooseFile(file: File) {
  await act(async () => {
    const input = field('Transfer file');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
}
function useImportEndpoints() {
  let current: DataTransferJob = {
    ...jobBase,
    kind: 'import',
    status: 'uploading',
    totalBytes: 10,
    uploadedBytes: 0,
  };
  let inspections = 0;
  handler = (request) => {
    if (request.url === '/api/data-transfer') return json(info);
    if (request.url === '/api/data-transfer/import') {
      assert.deepEqual(JSON.parse(request.body as string), { size: 10 });
      return json(current, 201);
    }
    if (request.url === `/api/data-transfer/jobs/${id}/upload`) {
      const headers = new Headers(request.headers);
      assert.equal(headers.get('content-type'), 'application/octet-stream');
      assert.equal(Number(headers.get('x-loom-offset')), current.uploadedBytes);
      const chunk = request.body as Blob;
      assert.ok(chunk instanceof Blob);
      assert.ok(chunk.size <= 4);
      current = { ...current, uploadedBytes: (current.uploadedBytes ?? 0) + chunk.size };
      return json(current);
    }
    if (request.url === `/api/data-transfer/jobs/${id}/inspect`) {
      inspections++;
      current = {
        ...current,
        status: 'ready',
        preview: { ...preview, token: `preview-${inspections}` },
      };
      return json({ ...current, status: 'working' }, 202);
    }
    if (request.url === `/api/data-transfer/jobs/${id}/apply`) {
      assert.deepEqual(JSON.parse(request.body as string), {
        previewToken: current.preview!.token,
      });
      current = {
        ...current,
        status: 'completed',
        backupPath: '/destination/backups/before-import',
      };
      return json({ ...current, status: 'applying' }, 202);
    }
    if (request.url === `/api/data-transfer/jobs/${id}`) {
      if (request.method === 'DELETE') return json({ ok: true });
      return json(current);
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

test('the collapsed section does not request data; unsaved settings block transfer starts', async () => {
  handler = () => json(info);
  await mount(true);
  assert.equal(requests.length, 0);
  await click('Open');
  assert.deepEqual(
    requests.map((item) => item.url),
    ['/api/data-transfer'],
  );
  assert.equal(button('Create encrypted file').disabled, true);
  await click('Import from another Loom');
  assert.equal(button('Inspect file').disabled, true);
  assert.match(document.body.textContent!, /Save your settings changes/);
  await render(false);
  assert.equal(button('Inspect file').disabled, false);
});

test('export validates confirmation, captures only allowed browser state, and uses an authenticated file URL', async () => {
  handler = (request) => {
    if (request.url === '/api/data-transfer') return json(info);
    if (request.url === '/api/data-transfer/export')
      return json({ ...jobBase, kind: 'export', status: 'queued' }, 202);
    if (request.url === `/api/data-transfer/jobs/${id}`)
      return json({ ...jobBase, kind: 'export', status: 'ready', summary: preview });
    throw new Error(`Unexpected request: ${request.url}`);
  };
  await mount();
  localStorage.setItem('loom.drafts', '{"room-1":"draft"}');
  localStorage.setItem('loom.locale', 'en');
  localStorage.setItem('unrelated.secret', 'must-not-export');
  await click('Open');
  await type('Transfer file password', password);
  await type('Confirm password', 'different-password');
  await click('Create encrypted file');
  assert.match(document.body.textContent!, /passwords do not match/);
  assert.equal(requests.filter((item) => item.method === 'POST').length, 0);
  await type('Confirm password', password);
  await click('Create encrypted file');
  const create = requests.find((item) => item.url.endsWith('/export'))!;
  assert.deepEqual(JSON.parse(create.body as string), {
    password,
    browserState: { 'loom.drafts': '{"room-1":"draft"}', 'loom.locale': 'en' },
  });
  const download = document.querySelector<HTMLAnchorElement>('a[download]');
  assert.ok(download);
  assert.equal(download.getAttribute('href'), `/api/data-transfer/jobs/${id}/download`);
  assert.ok(requests.every((item) => !item.url.includes(password)));
  assert.ok(
    [...Array(localStorage.length)].every(
      (_, index) => !localStorage.getItem(localStorage.key(index)!)!.includes(password),
    ),
  );
});

test('import sends bounded binary chunks, previews without applying, and requires a saved destination before replacement', async () => {
  useImportEndpoints();
  await mount();
  await click('Open');
  await click('Import from another Loom');
  await chooseFile(new File(['0123456789'], 'copy.loom'));
  await type('Transfer file password', password);
  await click('Inspect file');
  assert.deepEqual(
    requests
      .filter((item) => item.url.endsWith('/upload'))
      .map((item) => new Headers(item.headers).get('X-Loom-Offset')),
    ['0', '4', '8'],
  );
  assert.equal(requests.filter((item) => item.url.endsWith('/apply')).length, 0);
  assert.match(document.body.textContent!, /Review the incoming data/);
  assert.match(document.body.textContent!, /Current Loom/);
  assert.match(document.body.textContent!, /Other stored data/);
  assert.doesNotMatch(document.body.textContent!, /_internal_record_kind/);
  assert.match(document.body.textContent!, /source\/workspace/);
  assert.match(document.body.textContent!, /All imported automations will be disabled/);
  await render(true);
  assert.equal(button('Back up and replace').disabled, true);
  await click('Back up and replace');
  assert.equal(requests.filter((item) => item.url.endsWith('/apply')).length, 0);
  await render(false);
  await click('Back up and replace');
  assert.equal(requests.filter((item) => item.url.endsWith('/apply')).length, 1);
  assert.match(document.body.textContent!, /Import complete/);
  assert.match(document.body.textContent!, /destination\/backups\/before-import/);
  assert.equal(
    localStorage.getItem('loom.room'),
    null,
    'Browser state waits until the user opens Loom again',
  );
});

test('changing a password invalidates the preview and reinspects without uploading again; changing the file discards it', async () => {
  useImportEndpoints();
  await mount();
  await click('Open');
  await click('Import from another Loom');
  await chooseFile(new File(['0123456789'], 'first.loom'));
  await type('Transfer file password', password);
  await click('Inspect file');
  const uploaded = requests.filter((item) => item.url.endsWith('/upload')).length;
  await type('Transfer file password', `${password}-changed`);
  assert.doesNotMatch(document.body.textContent!, /Review the incoming data/);
  assert.ok(
    ![...document.querySelectorAll('button')].some(
      (item) => item.textContent === 'Back up and replace',
    ),
  );
  await click('Inspect file');
  assert.equal(requests.filter((item) => item.url.endsWith('/upload')).length, uploaded);
  assert.equal(requests.filter((item) => item.url.endsWith('/inspect')).length, 2);
  assert.match(document.body.textContent!, /Review the incoming data/);
  await chooseFile(new File(['abcdefghij'], 'second.loom'));
  assert.doesNotMatch(document.body.textContent!, /Review the incoming data/);
  assert.equal(requests.filter((item) => item.method === 'DELETE').length, 1);
  assert.equal(requests.filter((item) => item.url.endsWith('/apply')).length, 0);
});

test('a failed password inspection can be retried using the uploaded file', async () => {
  useImportEndpoints();
  const normal = handler;
  let inspected = false;
  handler = (request) => {
    if (request.url.endsWith('/inspect') && !inspected) {
      inspected = true;
      return json(
        { ...jobBase, kind: 'import', status: 'working', totalBytes: 10, uploadedBytes: 10 },
        202,
      );
    }
    if (
      request.url === `/api/data-transfer/jobs/${id}` &&
      inspected &&
      !requests.some(
        (item) =>
          item.url.endsWith('/inspect') &&
          JSON.parse(item.body as string).password === `${password}-correct`,
      )
    )
      return json({
        ...jobBase,
        kind: 'import',
        status: 'failed',
        totalBytes: 10,
        uploadedBytes: 10,
        error: 'The password is incorrect.',
      });
    return normal(request);
  };
  await mount();
  await click('Open');
  await click('Import from another Loom');
  await chooseFile(new File(['0123456789'], 'copy.loom'));
  await type('Transfer file password', password);
  await click('Inspect file');
  assert.match(document.body.textContent!, /password is incorrect/);
  await type('Transfer file password', `${password}-correct`);
  await click('Inspect file');
  assert.match(document.body.textContent!, /Review the incoming data/);
  assert.equal(requests.filter((item) => item.url.endsWith('/upload')).length, 3);
});

test('an upload with a lost acknowledgement resumes at the server-confirmed offset', async () => {
  useImportEndpoints();
  const normal = handler;
  let lost = false;
  handler = async (request) => {
    const result = await normal(request);
    if (
      request.url.endsWith('/upload') &&
      new Headers(request.headers).get('X-Loom-Offset') === '4' &&
      !lost
    ) {
      lost = true;
      throw new TypeError('The acknowledgement was lost');
    }
    return result;
  };
  await mount();
  await click('Open');
  await click('Import from another Loom');
  await chooseFile(new File(['0123456789'], 'copy.loom'));
  await type('Transfer file password', password);
  await click('Inspect file');
  assert.match(document.body.textContent!, /result is not confirmed/);
  await click('Inspect file');
  assert.match(document.body.textContent!, /Review the incoming data/);
  assert.deepEqual(
    requests
      .filter((item) => item.url.endsWith('/upload'))
      .map((item) => new Headers(item.headers).get('X-Loom-Offset')),
    ['0', '4', '8'],
  );
});

test('a lost apply response is reconciled by polling without repeating replacement', async () => {
  useImportEndpoints();
  const normal = handler;
  handler = async (request) => {
    const result = await normal(request);
    if (request.url.endsWith('/apply')) throw new TypeError('Loom is restarting');
    return result;
  };
  await mount();
  await click('Open');
  await click('Import from another Loom');
  await chooseFile(new File(['0123456789'], 'copy.loom'));
  await type('Transfer file password', password);
  await click('Inspect file');
  await click('Back up and replace');
  assert.match(document.body.textContent!, /Import complete/);
  assert.equal(requests.filter((item) => item.url.endsWith('/apply')).length, 1);
  assert.equal(document.querySelector('[role="alert"]'), null);
});

test('retrying a failed replacement uses a fresh upload job instead of reusing the committed job ID', async () => {
  const retryId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  let creations = 0;
  let current: DataTransferJob;
  handler = (request) => {
    if (request.url === '/api/data-transfer') return json(info);
    if (request.url === '/api/data-transfer/import') {
      creations++;
      current = {
        ...jobBase,
        id: creations === 1 ? id : retryId,
        kind: 'import',
        status: 'uploading',
        totalBytes: 10,
        uploadedBytes: 0,
      };
      return json(current, 201);
    }
    if (request.method === 'DELETE') return json({ ok: true });
    assert.ok(request.url.startsWith(`/api/data-transfer/jobs/${current.id}`));
    if (request.url.endsWith('/upload')) {
      assert.equal(
        Number(new Headers(request.headers).get('X-Loom-Offset')),
        current.uploadedBytes,
      );
      current = {
        ...current,
        uploadedBytes: (current.uploadedBytes ?? 0) + (request.body as Blob).size,
      };
      return json(current);
    }
    if (request.url.endsWith('/inspect')) {
      current = { ...current, status: 'ready', preview };
      return json({ ...current, status: 'working' }, 202);
    }
    if (request.url.endsWith('/apply')) {
      current =
        creations === 1
          ? {
              ...current,
              status: 'failed',
              requiresNewUpload: true,
              error: 'The previous data was restored. Start with a new upload.',
            }
          : { ...current, status: 'completed', backupPath: '/destination/backups/retry' };
      return json({ ...current, status: 'applying' }, 202);
    }
    return json(current);
  };
  await mount();
  await click('Open');
  await click('Import from another Loom');
  await chooseFile(new File(['0123456789'], 'copy.loom'));
  await type('Transfer file password', password);
  await click('Inspect file');
  await click('Back up and replace');
  assert.match(document.body.textContent!, /Start with a new upload/);
  await click('Inspect file');
  assert.equal(creations, 2);
  assert.equal(
    requests.filter((item) => item.method === 'DELETE' && item.url.endsWith(id)).length,
    1,
  );
  assert.deepEqual(
    requests
      .filter((item) => item.url === `/api/data-transfer/jobs/${retryId}/upload`)
      .map((item) => new Headers(item.headers).get('X-Loom-Offset')),
    ['0', '4', '8'],
  );
  await click('Back up and replace');
  assert.match(document.body.textContent!, /Import complete/);
});

test('discarding a recovered transfer finds the next saved job instead of stranding it', async () => {
  const olderId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const saved: DataTransferJob[] = [
    { ...jobBase, kind: 'export', status: 'ready', summary: preview },
    {
      ...jobBase,
      id: olderId,
      kind: 'import',
      status: 'failed',
      totalBytes: 10,
      uploadedBytes: 10,
      error: 'Check the password again.',
    },
  ];
  handler = (request) => {
    if (request.url === '/api/data-transfer') return json({ ...info, activeJob: saved[0] });
    if (request.method === 'DELETE') {
      saved.shift();
      return json({ ok: true });
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };
  await mount();
  await click('Open');
  assert.ok(document.querySelector('a[download]'));
  await click('Discard temporary file');
  assert.equal(saved.length, 1);
  assert.match(document.body.textContent!, /Check the password again/);
  assert.equal(button('Import from another Loom').getAttribute('aria-pressed'), 'true');
  assert.ok(field('Transfer file password'));
});

test('reopening an old completed import does not automatically overwrite newer browser drafts', async () => {
  handler = () =>
    json({
      ...info,
      activeJob: {
        ...jobBase,
        kind: 'import',
        status: 'completed',
        preview,
        backupPath: '/destination/backups/original',
      },
    });
  await mount();
  localStorage.setItem('loom.drafts', 'a newer draft');
  await click('Open');
  assert.match(document.body.textContent!, /Showing the saved status/);
  assert.match(document.body.textContent!, /Import complete/);
  const restore = document.querySelector<HTMLInputElement>(
    '.transfer-result input[type="checkbox"]',
  );
  assert.ok(restore);
  assert.equal(restore.checked, false);
  assert.equal(localStorage.getItem('loom.drafts'), 'a newer draft');
});

test('polling tolerates restart errors and reports an unknown result when reconnection expires', async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  let attempts = 0;
  const connectionStates: boolean[] = [];
  handler = () => {
    attempts++;
    if (attempts === 1) return json({ error: 'Restarting' }, 503);
    if (attempts === 2) throw new TypeError('Failed to fetch');
    return json({ ...jobBase, kind: 'import', status: 'completed' });
  };
  const result = await waitForDataTransferJob(id, {
    intervalMs: 0,
    timeoutMs: 1000,
    onReconnect: (value) => connectionStates.push(value),
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(connectionStates, [true, true, false]);
  handler = () => json({ error: 'Restarting' }, 503);
  await assert.rejects(
    waitForDataTransferJob(id, { intervalMs: 0, timeoutMs: 5 }),
    DataTransferPendingError,
  );
  handler = () => json({ error: 'Authentication required' }, 401);
  await assert.rejects(
    waitForDataTransferJob(id, { intervalMs: 0 }),
    (error: unknown) => (error as { status: number }).status === 401,
  );
});

test('upload refuses an unconfirmed server offset instead of silently skipping file bytes', async () => {
  handler = () =>
    json({ ...jobBase, kind: 'import', status: 'uploading', totalBytes: 6, uploadedBytes: 2 });
  await assert.rejects(
    uploadTransferFile(
      { ...jobBase, kind: 'import', status: 'uploading', totalBytes: 6, uploadedBytes: 0 },
      new File(['abcdef'], 'copy.loom'),
      4,
    ),
    /confirm the uploaded bytes/,
  );
});

test('browser state transfer is restricted to the allowlist and validates password bytes', () => {
  localStorage.clear();
  localStorage.setItem('loom.locale', 'en');
  localStorage.setItem('loom.drafts', 'old-drafts');
  localStorage.setItem('unrelated.secret', 'keep-me');
  assert.deepEqual(captureTransferBrowserState(), {
    'loom.drafts': 'old-drafts',
    'loom.locale': 'en',
  });
  restoreTransferBrowserState({
    'loom.locale': 'ja',
    'loom.room': 'copied-room',
    'unrelated.secret': 'do-not-write',
  } as Parameters<typeof restoreTransferBrowserState>[0]);
  assert.equal(localStorage.getItem('loom.locale'), 'ja');
  assert.equal(localStorage.getItem('loom.room'), 'copied-room');
  assert.equal(localStorage.getItem('loom.drafts'), null);
  assert.equal(localStorage.getItem('unrelated.secret'), 'keep-me');
  assert.equal(transferPasswordProblem('short'), 'short');
  assert.equal(transferPasswordProblem('🔑'.repeat(6)), 'short');
  assert.equal(transferPasswordProblem('界'.repeat(342)), 'long');
  assert.equal(transferPasswordProblem(password), null);
});

after(async () => {
  if (root) await act(async () => root?.unmount());
  dom.window.close();
});
