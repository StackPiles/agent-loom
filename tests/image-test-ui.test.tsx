import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue, Locale } from '../src/client/context';
import type { ImageSettingsValue } from '../src/client/ImageSettings';
import type { ImageTestJob, ImageTestRequest } from '../src/shared/image-tests';
import { DEFAULT_IMAGE_SETTINGS } from '../src/shared/model-settings';
import type { Snapshot } from '../src/shared/types';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3210',
});
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'Element',
  'Event',
  'MouseEvent',
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: (dom.window as unknown as Record<string, unknown>)[name],
  });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('../src/client/context');
const { ImageSettings } = await import('../src/client/ImageSettings');

const savedImages: ImageSettingsValue = {
  ...DEFAULT_IMAGE_SETTINGS,
  enabled: true,
  baseUrl: 'http://localhost:8000/v1',
  modelId: 'saved-image-model',
  apiKeyConfigured: true,
};
function fixture(denied: boolean): Snapshot {
  return {
    version: 'test',
    settings: {
      images: { ...savedImages },
      model: {
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'saved-language-model',
        apiKeyConfigured: true,
        contextWindow: 32768,
        maxOutputTokens: 4096,
        temperature: 0.7,
      },
      demoMode: false,
      autoLearn: false,
      maxHandoffs: 6,
      workspacePath: '/workspace',
      permissions: { shell: 'ask', fileWrite: 'ask', network: denied ? 'deny' : 'allow' },
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
}
function job(id: string, status: ImageTestJob['status'] = 'completed'): ImageTestJob {
  const stamp = new Date().toISOString();
  return {
    id,
    status,
    baseUrl: savedImages.baseUrl,
    modelId: savedImages.modelId,
    size: savedImages.size,
    createdAt: stamp,
    updatedAt: stamp,
    ...(status === 'queued' ? {} : { deadlineAt: new Date(Date.now() + 120_000).toISOString() }),
    previewAvailable: status === 'completed',
    ...(status === 'completed'
      ? {
          image: {
            id: `img_${'a'.repeat(64)}`,
            type: 'image',
            mimeType: 'image/png',
            filename: 'image-test.png',
            byteLength: 2048,
            prompt: 'A blue circle.',
            model: savedImages.modelId,
            createdAt: stamp,
          },
          previewExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        }
      : {}),
  };
}
interface RecordedRequest {
  path: string;
  method: string;
  body?: ImageTestRequest;
  signal?: AbortSignal | null;
}
const requests: RecordedRequest[] = [];
function defaultResponse(request: RecordedRequest): Response {
  if (request.method === 'POST') return Response.json(job(request.body!.requestId));
  if (request.method === 'DELETE')
    return Response.json(job(request.path.split('/').at(-1)!, 'cancelled'));
  throw new Error(`Unexpected ${request.method} ${request.path}`);
}
let respond: (request: RecordedRequest) => Response | Promise<Response> = defaultResponse;
Object.assign(globalThis, {
  fetch: async (path: string, init: RequestInit = {}) => {
    assert.match(path, /^\/api\/image-tests(?:\/|$)/);
    const request: RecordedRequest = {
      path,
      method: init.method || 'GET',
      ...(init.body ? { body: JSON.parse(String(init.body)) as ImageTestRequest } : {}),
      signal: init.signal,
    };
    requests.push(request);
    return respond(request);
  },
});
let root: ReturnType<typeof createRoot> | undefined;
let data: Snapshot;
let submits = 0;
function Harness() {
  const [images, setImages] = React.useState<ImageSettingsValue>(() => ({
    ...data.settings.images!,
  }));
  const [apiKey, setApiKey] = React.useState('');
  const [keyDirty, setKeyDirty] = React.useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submits++;
      }}
    >
      <ImageSettings
        value={images}
        onChange={(patch) => setImages((value) => ({ ...value, ...patch }))}
        apiKey={apiKey}
        keyDirty={keyDirty}
        onKeyChange={(value) => {
          setApiKey(value);
          setKeyDirty(true);
        }}
      />
    </form>
  );
}
async function mount({
  locale = 'en',
  denied = false,
  images,
}: { locale?: Locale; denied?: boolean; images?: Partial<ImageSettingsValue> } = {}) {
  data = fixture(denied);
  if (images) data.settings.images = { ...data.settings.images!, ...images };
  submits = 0;
  requests.length = 0;
  respond = defaultResponse;
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
    async mutate() {
      throw new Error('An image test must not save the settings.');
    },
  };
  root = createRoot(document.getElementById('root')!);
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        <Harness />
      </AppContext.Provider>,
    ),
  );
}
async function unmount() {
  if (!root) return;
  const previous = root;
  root = undefined;
  await act(async () => previous.unmount());
}
afterEach(unmount);
after(() => dom.window.close());

function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) =>
      element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
  );
  assert.ok(result, `Missing button: ${label}`);
  return result;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function input(label: string, value: string) {
  const element = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  assert.ok(element, `Missing input: ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function pause(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
const posts = () => requests.filter((request) => request.method === 'POST');
const gets = () => requests.filter((request) => request.method === 'GET');
const deletes = () => requests.filter((request) => request.method === 'DELETE');
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('tests current unsaved image inputs and distinguishes saved, replacement, and cleared keys', async () => {
  await mount();
  assert.equal(requests.length, 0);
  await input('Image API base URL', 'https://draft-image.example/v1');
  await input('Image model ID', 'draft-image-model');
  await input('Default image size', '512x512');
  await input('Generation timeout (seconds)', '90');
  const responseFormat = document.querySelector<HTMLSelectElement>(
    'select[aria-label="Image response format"]',
  )!;
  await act(async () => {
    responseFormat.value = 'b64_json';
    responseFormat.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const sharing = [...document.querySelectorAll<HTMLLabelElement>('.toggle-row')]
    .find((label) => label.textContent?.includes('Share generation slots'))!
    .querySelector<HTMLInputElement>('input')!;
  await click(sharing);
  await click(button('Generate 1 test image'));
  assert.deepEqual(posts()[0].body, {
    requestId: posts()[0].body!.requestId,
    settings: {
      baseUrl: 'https://draft-image.example/v1',
      modelId: 'draft-image-model',
      size: '512x512',
      responseFormat: 'b64_json',
      timeoutSeconds: 90,
      shareInferenceSlot: false,
    },
  });
  assert.equal(
    Object.hasOwn(posts()[0].body!, 'apiKey'),
    false,
    'Untouched saved keys are omitted.',
  );
  assert.deepEqual(data.settings.images, savedImages);
  assert.equal(submits, 0, 'Testing must not submit the surrounding settings form.');
  assert.match(document.body.textContent!, /one real image.*paid provider may charge/);

  await input('Image API key', 'unsaved-image-key');
  assert.equal(
    document.querySelector('.image-test-preview'),
    null,
    'Edited inputs invalidate the old preview.',
  );
  await click(button('Generate 1 test image'));
  assert.equal(posts()[1].body!.apiKey, 'unsaved-image-key');
  await click(button('Clear image API key'));
  await click(button('Generate 1 test image'));
  assert.equal(posts()[2].body!.apiKey, '', 'Explicit clearing must not reuse the saved key.');
  assert.equal(new Set(posts().map((request) => request.body!.requestId)).size, 3);
  assert.equal(submits, 0);
});

test('the 2K parallel preset sends a 60-minute test budget without changing connection, key or response options', async () => {
  await mount();
  await input('Image API base URL', 'https://draft-2k.example/v1');
  await input('Image model ID', 'draft-2k-model');
  await input('Image API key', 'synthetic-2k-test-key');
  await input('Default image size', '512x512');
  await input('Generation timeout (seconds)', '90');
  const format = document.querySelector<HTMLSelectElement>(
    'select[aria-label="Image response format"]',
  )!;
  const permission = document.querySelector<HTMLSelectElement>(
    'select[aria-label="Bot image generation"]',
  )!;
  await act(async () => {
    format.value = 'b64_json';
    format.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    permission.value = 'ask';
    permission.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await click(button('Apply 2K, 60 min and parallel LLM'));
  assert.equal(requests.length, 0, 'A preset must not start generation.');
  assert.equal(submits, 0, 'A preset must not save the enclosing form.');
  assert.equal(permission.value, 'ask');
  assert.equal(button('Generate 1 test image').disabled, false);
  assert.match(document.body.textContent!, /Time waiting in Loom’s queues is excluded/);
  assert.match(document.body.textContent!, /navigating away cancels the test/);
  await click(button('Generate 1 test image'));
  assert.deepEqual(posts()[0].body, {
    requestId: posts()[0].body!.requestId,
    settings: {
      baseUrl: 'https://draft-2k.example/v1',
      modelId: 'draft-2k-model',
      size: '2048x2048',
      responseFormat: 'b64_json',
      timeoutSeconds: 3600,
      shareInferenceSlot: false,
    },
    apiKey: 'synthetic-2k-test-key',
  });
  assert.deepEqual(data.settings.images, savedImages);
  assert.equal(submits, 0);
});

test('image tests accept long whole-second budgets and reject invalid or non-finite limits before posting', async () => {
  await mount({ images: { timeoutSeconds: 7200 } });
  assert.equal(button('Generate 1 test image').disabled, false);
  assert.equal(
    document.querySelector<HTMLInputElement>('[aria-label="Generation timeout (seconds)"]')!.value,
    '7200',
    'Opening the form retains a saved custom budget.',
  );
  for (const value of ['9', '86401', '3600.5']) {
    await input('Generation timeout (seconds)', value);
    const generate = button('Generate 1 test image');
    assert.equal(generate.disabled, true, value);
    await click(generate);
    assert.equal(posts().length, 0);
  }
  await unmount();
  await mount({ images: { timeoutSeconds: Number.POSITIVE_INFINITY } });
  assert.equal(button('Generate 1 test image').disabled, true);
  await click(button('Generate 1 test image'));
  assert.equal(posts().length, 0);
  await input('Generation timeout (seconds)', '86400');
  assert.equal(button('Generate 1 test image').disabled, false);
  await click(button('Generate 1 test image'));
  assert.equal(posts()[0].body!.settings.timeoutSeconds, 86400);
});

test('double clicks start once and cancellation ignores a late POST result', async () => {
  await mount();
  const pending = deferred();
  respond = (request) => (request.method === 'POST' ? pending.promise : defaultResponse(request));
  const generate = button('Generate 1 test image');
  await act(async () => {
    generate.click();
    generate.click();
  });
  assert.equal(posts().length, 1);
  assert.equal(generate.disabled, true);
  const id = posts()[0].body!.requestId;
  const cancel = button('Cancel test');
  await act(async () => {
    cancel.click();
    cancel.click();
  });
  assert.equal(deletes().length, 1);
  assert.equal(deletes()[0].path, `/api/image-tests/${id}`);
  assert.equal(posts()[0].signal?.aborted, true);
  await act(async () => pending.resolve(Response.json(job(id))));
  assert.match(document.querySelector('[role="status"]')!.textContent!, /was cancelled/);
  assert.equal(document.querySelector('.image-test-preview'), null);
  assert.equal(button('Generate 1 test image').disabled, false);
});

test('editing inputs and leaving the screen abort, discard, and hide stale image tests', async () => {
  await mount();
  const first = deferred();
  const second = deferred();
  respond = (request) =>
    request.method === 'POST'
      ? posts().length === 1
        ? first.promise
        : second.promise
      : defaultResponse(request);
  await click(button('Generate 1 test image'));
  const firstRequest = posts()[0];
  await input('Image model ID', 'changed-model');
  assert.equal(firstRequest.signal?.aborted, true);
  assert.equal(deletes()[0].path, `/api/image-tests/${firstRequest.body!.requestId}`);
  assert.equal(document.querySelector('[role="status"]'), null);
  await click(button('Generate 1 test image'));
  const secondRequest = posts()[1];
  await act(async () => first.resolve(Response.json(job(firstRequest.body!.requestId))));
  assert.equal(document.querySelector('.image-test-preview'), null);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Starting the test/);
  await unmount();
  assert.equal(secondRequest.signal?.aborted, true);
  assert.equal(deletes().at(-1)!.path, `/api/image-tests/${secondRequest.body!.requestId}`);
  await act(async () => second.resolve(Response.json(job(secondRequest.body!.requestId))));
  assert.equal(document.getElementById('root')!.childElementCount, 0);
});

test('unknown results are checked with GET only and a recovered result provides a temporary preview', async () => {
  await mount();
  respond = (request) => {
    if (request.method === 'POST') throw new TypeError('Connection interrupted.');
    if (request.method === 'GET')
      return gets().length === 1
        ? Response.json({ error: 'Server is restarting.' }, { status: 503 })
        : Response.json(job(posts()[0].body!.requestId));
    return defaultResponse(request);
  };
  await click(button('Generate 1 test image'));
  assert.match(document.querySelector('[role="status"]')!.textContent!, /result is unknown/);
  assert.equal(button('Generate 1 test image').disabled, true);
  await pause(800);
  assert.equal(posts().length, 1);
  assert.equal(gets().length, 0, 'An uncertain request is not automatically retried or polled.');
  await click(button('Check result'));
  assert.match(document.querySelector('[role="status"]')!.textContent!, /result is unknown/);
  assert.equal(button('Generate 1 test image').disabled, true);
  await click(button('Check result'));
  const id = posts()[0].body!.requestId;
  assert.deepEqual(
    gets().map((request) => request.path),
    [`/api/image-tests/${id}`, `/api/image-tests/${id}`],
  );
  assert.equal(posts().length, 1);
  const preview = document.querySelector<HTMLImageElement>('.image-test-preview img')!;
  assert.ok(preview);
  assert.equal(preview.getAttribute('src'), `/api/image-tests/${id}/image`);
  const download = document.querySelector<HTMLAnchorElement>('.image-test-preview a')!;
  assert.equal(download.getAttribute('href'), `/api/image-tests/${id}/image?download=1`);
  assert.equal(download.download, 'image-test.png');
  assert.match(
    document.querySelector('figcaption')!.textContent!,
    /on this screen for up to 15 minutes/,
  );
  await act(async () => preview.dispatchEvent(new dom.window.Event('error')));
  assert.equal(document.querySelector('.image-test-preview'), null);
  assert.match(document.body.textContent!, /temporary preview is no longer available/);
});

test('queued and generating jobs are polled and a timeout stops without another generation', async () => {
  await mount();
  respond = (request) => {
    if (request.method === 'POST') return Response.json(job(request.body!.requestId, 'queued'));
    if (request.method === 'GET') {
      const id = posts()[0].body!.requestId;
      return Response.json(
        gets().length === 1
          ? job(id, 'generating')
          : {
              ...job(id, 'failed'),
              errorCode: 'timeout',
              error: 'The deadline was reached.',
            },
      );
    }
    return defaultResponse(request);
  };
  await click(button('Generate 1 test image'));
  assert.match(
    document.querySelector('[role="status"]')!.textContent!,
    /Waiting for a generation slot/,
  );
  await pause(800);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Generating one image/);
  await pause(800);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /timed out.*not resent/);
  assert.equal(posts().length, 1);
  assert.equal(gets().length, 2);
  assert.equal(button('Generate 1 test image').disabled, false);
  assert.equal(document.querySelector('.image-test-preview'), null);
});

test('queued tests ignore elapsed generation budgets and stale deadlines, then retrieve the final result', async (t) => {
  await mount();
  await input('Generation timeout (seconds)', '10');
  let time = Date.now();
  t.mock.method(Date, 'now', () => time);
  const queuedDeadline = new Date(time - 60_000).toISOString();
  let status: ImageTestJob['status'] = 'queued';
  let generationDeadline: string | undefined;
  respond = (request) => {
    if (request.method === 'POST') return Response.json(job(request.body!.requestId, 'queued'));
    if (request.method === 'GET')
      return Response.json({
        ...job(posts()[0].body!.requestId, status),
        deadlineAt: status === 'queued' ? queuedDeadline : generationDeadline,
      });
    return defaultResponse(request);
  };
  await click(button('Generate 1 test image'));
  time += 120_000;
  await pause(800);
  assert.equal(gets().length, 1, 'waiting longer than the generation budget must keep polling');
  assert.match(
    document.querySelector('[role="status"]')!.textContent!,
    /Waiting for a generation slot/,
  );
  assert.equal(button('Generate 1 test image').disabled, true);

  status = 'generating';
  generationDeadline = new Date(time + 10_000).toISOString();
  await pause(800);
  assert.equal(gets().length, 2, 'a stale deadline on a queued response must be ignored');
  assert.match(document.querySelector('[role="status"]')!.textContent!, /Generating one image/);

  status = 'completed';
  time += 120_000;
  await pause(800);
  assert.equal(gets().length, 3, 'fetch the latest state even after the last observed deadline');
  assert.ok(document.querySelector('.image-test-preview'));
  assert.equal(posts().length, 1);
  assert.equal(button('Generate 1 test image').disabled, false);
});

test('a fresh generating response beyond its server deadline stops polling and can be recovered with GET', async (t) => {
  await mount();
  let time = Date.now();
  t.mock.method(Date, 'now', () => time);
  const deadlineAt = new Date(time + 10_000).toISOString();
  respond = (request) => {
    const id = posts()[0].body!.requestId;
    if (request.method === 'POST')
      return Response.json({ ...job(request.body!.requestId, 'generating'), deadlineAt });
    if (request.method === 'GET')
      return Response.json(
        gets().length === 1 ? { ...job(id, 'generating'), deadlineAt } : job(id),
      );
    return defaultResponse(request);
  };
  await click(button('Generate 1 test image'));
  time += 30_000;
  await pause(800);
  assert.equal(
    gets().length,
    1,
    'check the server once before treating an old deadline as uncertain',
  );
  assert.match(document.querySelector('[role="status"]')!.textContent!, /result is unknown/);
  assert.equal(button('Generate 1 test image').disabled, true);
  await pause(800);
  assert.equal(gets().length, 1, 'uncertain work must not be polled or generated automatically');
  await click(button('Check result'));
  assert.equal(gets().length, 2);
  assert.equal(posts().length, 1);
  assert.ok(document.querySelector('.image-test-preview'));
});

test('the saved network deny policy blocks a test and explains how to enable it', async () => {
  await mount({ locale: 'ja', denied: true });
  const generate = button('1枚をテスト生成');
  assert.equal(generate.disabled, true);
  await click(generate);
  assert.equal(requests.length, 0);
  assert.match(document.body.textContent!, /通信の権限を許可/);
  assert.match(document.body.textContent!, /実際に画像を1枚生成.*有料サービスでは料金が発生/);
});
