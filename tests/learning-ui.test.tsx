import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AppContextValue } from '../src/client/context';
import type { Memory, Skill, Snapshot, Task } from '../src/shared/types';

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
  'HTMLTextAreaElement',
  'HTMLDialogElement',
  'Element',
  'SVGElement',
  'Event',
  'MouseEvent',
  'MutationObserver',
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: (dom.window as unknown as Record<string, unknown>)[name],
  });
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});
Object.defineProperty(dom.window, 'matchMedia', {
  value: (query: string) => ({
    matches: query.includes('reduced-motion'),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }),
});
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
const { ApiError } = await import('../src/client/api');
const { LearningPage } = await import('../src/client/LearningPage');

const stamp = '2026-11-06T00:00:00.000Z';
const botActor = { kind: 'bot' as const, botId: 'bot_aster', roomId: 'room_one' };
function fixture(): Snapshot {
  return {
    version: 'test',
    settings: {
      model: {
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'fixture',
        apiKeyConfigured: false,
        contextWindow: 32768,
        maxOutputTokens: 4096,
        temperature: 0.7,
      },
      demoMode: false,
      autoLearn: false,
      maxHandoffs: 6,
      workspacePath: 'C:\\Loom',
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: ['Aster', 'Nova'].map((name) => ({
      id: 'bot_' + name.toLowerCase(),
      name,
      handle: name.toLowerCase(),
      role: 'Research',
      systemPrompt: 'Research carefully.',
      color: '#829479',
      avatar: 'sparkles',
      enabled: true,
      createdAt: stamp,
    })),
    rooms: [
      {
        id: 'room_one',
        name: 'Research',
        description: '',
        botIds: ['bot_aster'],
        archived: false,
        pinned: false,
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'room_two',
        name: 'Delivery',
        description: '',
        botIds: ['bot_aster', 'bot_nova'],
        archived: false,
        pinned: false,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
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
function memory(patch: Partial<Memory> = {}): Memory {
  return {
    id: 'memory_one',
    botId: 'bot_aster',
    roomId: 'room_one',
    version: 2,
    status: 'active',
    locked: false,
    content: 'Use detailed research notes for this project.',
    evidence: 'The user requested detailed technical explanations.',
    sourceTaskId: 'task_source',
    createdAt: stamp,
    updatedAt: stamp,
    revisions: [
      {
        version: 1,
        content: 'Use short research notes.',
        createdAt: stamp,
        reason: 'Initial preference',
        actor: botActor,
        botId: 'bot_aster',
        roomId: 'room_one',
        locked: false,
        status: 'active',
        evidence: 'Original user preference.',
        sourceTaskId: 'task_source',
      },
      {
        version: 2,
        content: 'Use detailed research notes for this project.',
        createdAt: stamp,
        reason: 'Apply the user correction',
        actor: { kind: 'user' },
        botId: 'bot_aster',
        roomId: 'room_one',
        locked: false,
        status: 'active',
        evidence: 'The user requested detailed technical explanations.',
        sourceTaskId: 'task_source',
      },
    ],
    ...patch,
  };
}
function skill(patch: Partial<Skill> = {}): Skill {
  return {
    id: 'skill_one',
    name: 'Release review',
    description: 'Use for changes before publishing a release.',
    content: '# Release review\n\nCheck the build and the release notes.',
    botId: 'bot_aster',
    roomId: 'room_one',
    status: 'active',
    locked: false,
    autoActivated: true,
    version: 2,
    evidence: 'The build passed in the source task.',
    sourceTaskId: 'task_source',
    useCount: 4,
    createdAt: stamp,
    updatedAt: stamp,
    revisions: [
      {
        version: 1,
        name: 'Build review',
        description: 'Use for release builds.',
        content: '# Build review\n\nCheck the build.',
        createdAt: stamp,
        reason: 'Created after a real build',
        actor: botActor,
        sourceTaskId: 'task_source',
        evidence: 'Observed build success.',
        botId: 'bot_aster',
        roomId: 'room_one',
        locked: false,
        status: 'active',
      },
      {
        version: 2,
        name: 'Release review',
        description: 'Use for changes before publishing a release.',
        content: '# Release review\n\nCheck the build and the release notes.',
        createdAt: stamp,
        reason: 'Add the release note check',
        actor: botActor,
        sourceTaskId: 'task_source',
        evidence: 'The build passed in the source task.',
        botId: 'bot_aster',
        roomId: 'room_one',
        locked: false,
        status: 'active',
      },
    ],
    ...patch,
  };
}
function task(patch: Partial<Task> = {}): Task {
  return {
    id: 'task_source',
    roomId: 'room_one',
    botId: 'bot_aster',
    prompt: 'Review the synthetic release.',
    status: 'completed',
    kind: 'chat',
    rootTaskId: 'task_source',
    depth: 0,
    output: 'Checked the build.',
    createdAt: stamp,
    updatedAt: stamp,
    inputTokens: 0,
    outputTokens: 0,
    ...patch,
  };
}
let root: ReturnType<typeof createRoot> | undefined;
let context: AppContextValue;
let serverSnapshot: Snapshot;
let reloadError: Error | undefined;
let mutationHandler: (() => Promise<unknown>) | undefined;
const mutations: { path: string; method?: string; body?: any }[] = [];
const reads: string[] = [];
const navigations: { view: string; roomId?: string }[] = [];
Object.assign(globalThis, {
  fetch: async (path: string, init: RequestInit = {}) => {
    assert.equal(path, '/api/state');
    assert.equal(init.method ?? 'GET', 'GET');
    reads.push(path);
    if (reloadError) throw reloadError;
    return Response.json(serverSnapshot);
  },
});
async function mount(data = fixture(), locale: 'en' | 'ja' = 'en') {
  if (root) await act(async () => root!.unmount());
  mutations.length = 0;
  reads.length = 0;
  navigations.length = 0;
  mutationHandler = undefined;
  reloadError = undefined;
  serverSnapshot = structuredClone(data);
  context = {
    data,
    connected: true,
    locale,
    t: (ja, en) => (locale === 'ja' ? ja : en),
    view: 'learning',
    roomId: 'room_one',
    navigate(view, roomId) {
      navigations.push({ view, roomId });
    },
    async refresh() {},
    toast() {},
    async signOut() {},
    async mutate<T>(path: string, method?: string, body?: unknown) {
      mutations.push({ path, method, body });
      return (mutationHandler ? await mutationHandler() : {}) as T;
    },
  };
  root = createRoot(document.getElementById('root')!);
  await rerender(data);
}
async function rerender(data: Snapshot, patch: Partial<AppContextValue> = {}) {
  context = { ...context, data, ...patch };
  await act(async () =>
    root!.render(
      <AppContext.Provider value={context}>
        <LearningPage />
      </AppContext.Provider>,
    ),
  );
}
function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) =>
      element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
  );
  assert.ok(result, 'Missing button: ' + label);
  return result;
}
function startingButton(label: string, scope: ParentNode = document): HTMLButtonElement {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
    element.textContent?.trim().startsWith(label),
  );
  assert.ok(result, 'Missing button starting with: ' + label);
  return result;
}
function dialog() {
  const result = document.querySelector<HTMLDialogElement>('dialog[open]');
  assert.ok(result, 'Expected an open editor');
  return result;
}
function field<
  T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement = HTMLInputElement,
>(label: string): T {
  const container = [...dialog().querySelectorAll('label.field')].find(
    (element) => element.querySelector('.field-label')?.textContent === label,
  );
  const result = container?.querySelector('input, select, textarea');
  assert.ok(result, 'Missing field: ' + label);
  return result as T;
}
function fixedToggle(): HTMLInputElement {
  const result = dialog().querySelector<HTMLInputElement>('.toggle-row input[type="checkbox"]');
  assert.ok(result);
  return result;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element.tagName === 'TEXTAREA'
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    dialog()
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}
async function openMemory(archived = false) {
  await click(startingButton('Memories', document.querySelector('.page-tabs')!));
  if (archived) await click(button('Archived', document.querySelector('.filter-buttons')!));
  await click(button('Edit and history'));
}
async function openRevision(version: number) {
  const found = [...dialog().querySelectorAll<HTMLDetailsElement>('.learning-revision')].find(
    (element) => element.querySelector('summary > strong')?.textContent === 'v' + version,
  );
  assert.ok(found);
  await act(async () => {
    found.open = true;
    found.dispatchEvent(new Event('toggle'));
  });
  return found;
}

test('learning lists distinguish automatic skills, fixed content and archived memories', async () => {
  const data = fixture();
  data.skills = [
    skill(),
    skill({
      id: 'skill_old',
      name: 'Outdated release procedure',
      status: 'archived',
      locked: true,
    }),
    skill({ id: 'skill_draft', name: 'Manual candidate', status: 'candidate', locked: true }),
  ];
  data.memories = [
    memory(),
    memory({ id: 'memory_old', content: 'Outdated research preference.', status: 'archived' }),
  ];
  await mount(data);
  assert.match(document.querySelector('.learning-banner')!.textContent!, /automatically activate/);
  assert.match(document.querySelector('.learning-banner')!.textContent!, /Post-task review OFF/);
  assert.equal(document.querySelectorAll('.skill-card').length, 2);
  assert.match(button('Open skill: Release review').textContent!, /Auto-active.*4 reads/s);
  assert.match(button('Open skill: Manual candidate').textContent!, /Fixed.*Candidate/s);
  await click(button('Archived', document.querySelector('.filter-buttons')!));
  assert.equal(document.querySelectorAll('.skill-card').length, 1);
  assert.match(document.querySelector('.skill-card')!.textContent!, /Outdated release procedure/);
  await click(startingButton('Memories', document.querySelector('.page-tabs')!));
  assert.equal(document.querySelectorAll('.memory-card').length, 1);
  assert.doesNotMatch(document.querySelector('.memory-list')!.textContent!, /Outdated/);
  assert.equal(document.querySelector('[aria-label="Delete"]'), null);
  await click(button('Archived', document.querySelector('.filter-buttons')!));
  assert.match(
    document.querySelector('.memory-list')!.textContent!,
    /Outdated research preference/,
  );
  assert.equal(mutations.length, 0);
});

test('new owner memory is fixed by default and saves its chosen bot and room', async () => {
  await mount();
  await click(startingButton('Memories', document.querySelector('.page-tabs')!));
  await click(button('New memory'));
  assert.equal(fixedToggle().checked, true);
  await input(field<HTMLTextAreaElement>('Content'), 'A verified project preference.');
  await choose(field<HTMLSelectElement>('Bot scope'), 'bot_aster');
  await choose(field<HTMLSelectElement>('Room scope'), 'room_one');
  await input(
    field<HTMLTextAreaElement>('Evidence and checks'),
    'The user explicitly requested this.',
  );
  await submit();
  assert.deepEqual(mutations, [
    {
      path: '/memories',
      method: 'POST',
      body: {
        content: 'A verified project preference.',
        botId: 'bot_aster',
        roomId: 'room_one',
        locked: true,
        evidence: 'The user explicitly requested this.',
      },
    },
  ]);
  assert.equal(document.querySelector('dialog[open]'), null);
});

test('legacy memory remains editable and scope changes cannot keep an incompatible room', async () => {
  const data = fixture();
  data.memories = [
    {
      id: 'legacy_memory',
      botId: 'bot_aster',
      roomId: 'room_one',
      content: 'Legacy context.',
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];
  await mount(data);
  await openMemory();
  assert.equal(fixedToggle().checked, false);
  await choose(field<HTMLSelectElement>('Bot scope'), 'bot_nova');
  assert.equal(field<HTMLSelectElement>('Room scope').value, '');
  assert.deepEqual(
    [...field<HTMLSelectElement>('Room scope').options].map((option) => option.value),
    ['', 'room_two'],
  );
  await input(field<HTMLTextAreaElement>('Content'), 'Updated context.');
  await submit();
  assert.equal(mutations[0].body.baseVersion, 1);
  assert.equal(mutations[0].body.locked, false);
  assert.equal(mutations[0].body.botId, 'bot_nova');
  assert.equal(mutations[0].body.roomId, null);
});

test('live memory changes preserve the draft and require an explicit current-version reload', async () => {
  const data = fixture();
  data.memories = [memory()];
  await mount(data);
  await openMemory();
  await input(field<HTMLTextAreaElement>('Content'), 'My unsaved correction.');
  await input(field('Reason for change (optional)'), 'Clarify the project preference.');
  const next = structuredClone(data);
  next.memories[0] = memory({
    version: 3,
    content: 'A concurrent saved correction.',
    locked: true,
    roomId: 'room_two',
  });
  await rerender(next);
  assert.equal(field<HTMLTextAreaElement>('Content').value, 'My unsaved correction.');
  assert.equal(field('Reason for change (optional)').value, 'Clarify the project preference.');
  assert.match(dialog().textContent!, /Editing v2/);
  assert.match(dialog().textContent!, /Latest saved version: v3/);
  assert.equal(button('Save', dialog()).disabled, true);
  assert.equal(button('Save and archive', dialog()).disabled, true);
  await submit();
  assert.equal(mutations.length, 0);
  serverSnapshot = next;
  await click(button('Load latest content', dialog()));
  assert.deepEqual(reads, ['/api/state']);
  assert.equal(field<HTMLTextAreaElement>('Content').value, 'A concurrent saved correction.');
  assert.equal(field('Reason for change (optional)').value, '');
  assert.equal(field<HTMLSelectElement>('Room scope').value, 'room_two');
  assert.equal(fixedToggle().checked, true);
  assert.equal(button('Save', dialog()).disabled, false);
  await input(field<HTMLTextAreaElement>('Content'), 'A correction based on version three.');
  await submit();
  assert.equal(mutations[0].body.baseVersion, 3);
});

test('a server conflict and failed reload keep every draft field until a successful explicit reload', async () => {
  const data = fixture();
  data.skills = [skill()];
  await mount(data);
  await click(button('Open skill: Release review'));
  await input(field('Name'), 'Draft release review');
  await input(field('Description & when to use'), 'Draft applicability.');
  await input(field<HTMLTextAreaElement>('Procedure (Markdown)'), 'Draft procedure.');
  await input(field<HTMLTextAreaElement>('Evidence and checks'), 'Draft evidence.');
  await input(field('Reason for change (optional)'), 'Draft reason.');
  await click(fixedToggle());
  mutationHandler = async () => {
    throw new ApiError('Reload the latest version.', 409);
  };
  await submit();
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].body.baseVersion, 2);
  assert.match(dialog().textContent!, /Your draft is preserved/);
  assert.equal(field('Name').value, 'Draft release review');
  assert.equal(field('Description & when to use').value, 'Draft applicability.');
  assert.equal(field<HTMLTextAreaElement>('Procedure (Markdown)').value, 'Draft procedure.');
  assert.equal(field<HTMLTextAreaElement>('Evidence and checks').value, 'Draft evidence.');
  assert.equal(field('Reason for change (optional)').value, 'Draft reason.');
  assert.equal(fixedToggle().checked, true);
  assert.equal(button('Save', dialog()).disabled, true);
  await submit();
  assert.equal(mutations.length, 1);
  reloadError = new Error('Temporary connection problem');
  await click(button('Load latest content', dialog()));
  assert.equal(field('Name').value, 'Draft release review');
  assert.match(dialog().textContent!, /Temporary connection problem/);
  assert.equal(button('Save', dialog()).disabled, true);
  reloadError = undefined;
  serverSnapshot.skills = [
    skill({
      version: 4,
      name: 'Current release procedure',
      content: 'The latest checked procedure.',
      locked: true,
    }),
  ];
  await click(button('Load latest content', dialog()));
  assert.equal(field('Name').value, 'Current release procedure');
  assert.equal(
    field<HTMLTextAreaElement>('Procedure (Markdown)').value,
    'The latest checked procedure.',
  );
  assert.equal(button('Save', dialog()).disabled, false);
  mutationHandler = undefined;
  await input(field<HTMLTextAreaElement>('Procedure (Markdown)'), 'A version-four follow-up.');
  await submit();
  assert.equal(mutations.at(-1)!.body.baseVersion, 4);
});

test('skill drafts stay based on their original version across live metadata and policy changes', async () => {
  const data = fixture();
  data.skills = [skill()];
  await mount(data);
  await click(button('Open skill: Release review'));
  await input(field('Name'), 'My release draft');
  const next = structuredClone(data);
  next.skills[0] = skill({
    version: 3,
    name: 'Another author changed the name',
    status: 'archived',
    locked: true,
  });
  await rerender(next);
  assert.equal(field('Name').value, 'My release draft');
  assert.equal(fixedToggle().checked, false);
  assert.equal(button('Save', dialog()).disabled, true);
  await submit();
  await click(startingButton('History', dialog()));
  const revision = await openRevision(1);
  assert.equal(button('Restore this content', revision).disabled, true);
  assert.equal(mutations.length, 0);
  serverSnapshot = next;
  await click(button('Load latest content', dialog()));
  await click(button('Edit', dialog()));
  assert.equal(field('Name').value, 'Another author changed the name');
  assert.equal(fixedToggle().checked, true);
  assert.ok(button('Return to candidates', dialog()));
  assert.ok(button('Activate', dialog()));
});

test('a save cannot be duplicated or raced by another action while its request is pending', async () => {
  const data = fixture();
  data.skills = [skill({ status: 'candidate' })];
  await mount(data);
  await click(button('Open skill: Release review'));
  await input(field('Name'), 'Unsaved candidate');
  let rejectSave: (reason: Error) => void;
  const waiting = new Promise<never>((_resolve, reject) => {
    rejectSave = reject;
  });
  mutationHandler = () => waiting;
  await submit();
  assert.equal(mutations.length, 1);
  assert.equal(field('Name').matches(':disabled'), true);
  assert.equal(button('Save', dialog()).disabled, true);
  assert.equal(button('Activate', dialog()).disabled, true);
  assert.equal(button('Save and archive', dialog()).disabled, true);
  await submit();
  await click(button('Activate', dialog()));
  await click(button('Close', dialog()));
  assert.ok(dialog());
  assert.equal(mutations.length, 1);
  await act(async () => rejectSave!(new Error('Temporary save failure')));
  assert.equal(field('Name').value, 'Unsaved candidate');
  assert.equal(field('Name').matches(':disabled'), false);
  assert.equal(button('Save', dialog()).disabled, false);
  assert.match(dialog().textContent!, /Temporary save failure/);
});

test('archiving saves a memory draft with its original version and preserves history for explicit reuse', async () => {
  const data = fixture();
  data.memories = [memory()];
  await mount(data);
  await openMemory();
  await input(field<HTMLTextAreaElement>('Content'), 'Final context before archival.');
  await click(button('Save and archive', dialog()));
  assert.equal(mutations[0].path, '/memories/memory_one');
  assert.equal(mutations[0].method, 'PATCH');
  assert.equal(mutations[0].body.status, 'archived');
  assert.equal(mutations[0].body.locked, true);
  assert.equal(mutations[0].body.baseVersion, 2);
  assert.equal(mutations[0].body.content, 'Final context before archival.');
  data.memories = [memory({ version: 3, status: 'archived', locked: true })];
  await mount(data);
  await openMemory(true);
  assert.match(dialog().textContent!, /Saving or restoring content does not reactivate/);
  await click(button('Use again', dialog()));
  assert.equal(mutations[0].body.status, 'active');
  assert.equal(mutations[0].body.baseVersion, 3);
  assert.equal(mutations[0].body.locked, true);
});

test('restoring an archived memory sends only the target and baseline versions without reactivation', async () => {
  const data = fixture();
  data.memories = [memory({ version: 3, status: 'archived', locked: true })];
  await mount(data);
  await openMemory(true);
  await click(startingButton('History', dialog()));
  assert.match(
    dialog().textContent!,
    /current bot, room, fixed setting and activation status stay/,
  );
  const revision = await openRevision(1);
  await click(button('Restore this content', revision));
  assert.deepEqual(mutations, [
    {
      path: '/memories/memory_one/restore',
      method: 'POST',
      body: { version: 1, baseVersion: 3 },
    },
  ]);
});

test('revision details expose authors, evidence, before-and-after content and actual used versions', async () => {
  const data = fixture();
  data.skills = [skill()];
  data.tasks = [
    task({
      skillUses: [
        {
          id: 'skill_one',
          version: 1,
          name: 'Build review',
          description: 'Use for release builds.',
          content: '# Build review\n\nCheck the build.',
          botId: 'bot_aster',
          roomId: 'room_one',
          readAt: stamp,
        },
      ],
    }),
  ];
  await mount(data);
  await click(button('Open skill: Release review'));
  assert.match(
    dialog().querySelector('.learning-uses')!.textContent!,
    /v1.*Review the synthetic release/s,
  );
  await click(startingButton('History', dialog()));
  assert.equal(
    dialog().querySelector('.learning-content-diff'),
    null,
    'Closed histories stay compact',
  );
  const revision = await openRevision(2);
  assert.match(revision.querySelector('summary')!.textContent!, /Aster/);
  assert.match(
    revision.querySelector('.learning-diff-table')!.textContent!,
    /Build review.*Release review/s,
  );
  assert.match(revision.querySelector('.learning-diff-before')!.textContent!, /Check the build\./);
  assert.match(
    revision.querySelector('.learning-diff-after')!.textContent!,
    /build and the release notes/,
  );
  assert.match(revision.querySelector('.learning-evidence')!.textContent!, /build passed/);
  assert.equal(
    button('Restore this content', revision).disabled,
    true,
    'Current revision needs no restore',
  );
  await click(button('View source task', revision));
  assert.deepEqual(navigations, [{ view: 'chat', roomId: 'room_one' }]);
  assert.equal(document.querySelector('dialog[open]'), null);
});

test('old revisions report unknown authors and skill restores preserve the requested baseline', async () => {
  const data = fixture();
  const old = skill();
  delete old.revisions[0].actor;
  data.skills = [old];
  await mount(data);
  await click(button('Open skill: Release review'));
  await click(startingButton('History', dialog()));
  const revision = await openRevision(1);
  assert.match(revision.querySelector('summary')!.textContent!, /Author not recorded/);
  await click(button('Restore this content', revision));
  assert.deepEqual(mutations, [
    {
      path: '/skills/skill_one/restore',
      method: 'POST',
      body: { version: 1, baseVersion: 2 },
    },
  ]);
});

test('manual activation and deactivation keep user intent explicit and version checked', async () => {
  const data = fixture();
  data.skills = [skill({ status: 'candidate', locked: true, autoActivated: false })];
  await mount(data);
  await click(button('Open skill: Release review'));
  await click(fixedToggle());
  await click(button('Activate', dialog()));
  assert.equal(mutations[0].body.status, 'active');
  assert.equal(mutations[0].body.locked, false);
  assert.equal(mutations[0].body.baseVersion, 2);
  data.skills = [skill()];
  await mount(data);
  await click(button('Open skill: Release review'));
  await click(button('Deactivate', dialog()));
  assert.equal(mutations[0].body.status, 'candidate');
  assert.equal(mutations[0].body.locked, true);
  assert.equal(mutations[0].body.baseVersion, 2);
});

test('a skill with an empty optional description can still be archived', async () => {
  const data = fixture();
  data.skills = [skill({ description: '' })];
  await mount(data);
  await click(button('Open skill: Release review'));
  assert.equal(button('Archive', dialog()).disabled, false);
  await click(button('Archive', dialog()));
  assert.equal(mutations[0].body.description, '');
  assert.equal(mutations[0].body.status, 'archived');
  assert.equal(mutations[0].body.baseVersion, 2);
});

test('unrelated snapshots do not discard drafts and a disconnected editor waits to save', async () => {
  const data = fixture();
  data.skills = [skill()];
  await mount(data);
  await click(button('Open skill: Release review'));
  await input(field<HTMLTextAreaElement>('Procedure (Markdown)'), 'Draft to keep through updates.');
  const next = structuredClone(data);
  next.skills[0].useCount++;
  await rerender(next);
  assert.equal(button('Save', dialog()).disabled, false);
  assert.equal(
    field<HTMLTextAreaElement>('Procedure (Markdown)').value,
    'Draft to keep through updates.',
  );
  await rerender(next, { connected: false });
  assert.equal(button('Save', dialog()).disabled, true);
  assert.match(dialog().textContent!, /Disconnected.*draft is kept/);
  await submit();
  assert.equal(mutations.length, 0);
  await rerender(next, { connected: true });
  await submit();
  assert.equal(mutations[0].body.baseVersion, 2);
  assert.equal(mutations[0].body.content, 'Draft to keep through updates.');
});

test('missing records cannot be resaved as a new item and Japanese controls remain explicit', async () => {
  const data = fixture();
  data.memories = [memory()];
  await mount(data);
  await openMemory();
  await input(field<HTMLTextAreaElement>('Content'), 'A draft for a now-removed record.');
  await rerender({ ...data, memories: [] });
  assert.match(dialog().textContent!, /no longer in the current list/);
  assert.equal(button('Save', dialog()).disabled, true);
  await submit();
  assert.equal(mutations.length, 0);

  await mount(fixture(), 'ja');
  await click(button('スキルを追加'));
  assert.equal(fixedToggle().checked, true);
  assert.match(dialog().textContent!, /内容を固定（ボットの更新を防ぐ）/);
  assert.match(dialog().textContent!, /候補として保存/);
  assert.ok(field('対象ボット'));
  assert.ok(field('対象ルーム'));
  await input(field('名前'), '日本語の手順');
  await input(field('説明・使うタイミング'), '日本語の確認作業に使う');
  await input(field<HTMLTextAreaElement>('手順（Markdown）'), '結果を確認して記録する。');
  await submit();
  assert.equal(mutations[0].path, '/skills');
  assert.equal(mutations[0].body.locked, true);
  assert.equal(mutations[0].body.status, undefined);
});

test('long Japanese history retains full content and labelled controls at a narrow viewport', async () => {
  Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });
  const data = fixture();
  const before = '確認前の手順。'.repeat(1000);
  const after = '確認した結果と未確認の事項を記録する。'.repeat(1000);
  const item = skill({
    name: 'とても長い案件名について繰り返し使用する確認手順'.repeat(4),
    description: 'このルームの案件だけに適用する手順です。'.repeat(20),
    content: after,
  });
  item.revisions[0].content = before;
  item.revisions[1].content = after;
  item.revisions[1].reason = '更新の根拠を詳しく記録します。'.repeat(40);
  data.skills = [item];
  await mount(data, 'ja');
  await click(button('スキルを開く: ' + item.name));
  const editor = dialog();
  assert.ok(editor.getAttribute('aria-labelledby'));
  assert.equal(
    document.getElementById(editor.getAttribute('aria-labelledby')!)?.textContent,
    item.name,
  );
  await click(startingButton('履歴', editor));
  const revision = await openRevision(2);
  assert.equal(revision.querySelector('.learning-diff-before pre')!.textContent, before);
  assert.equal(revision.querySelector('.learning-diff-after pre')!.textContent, after);
  assert.match(revision.querySelector('summary')!.textContent!, /更新の根拠を詳しく記録します/);
  assert.equal(button('この版の内容を復元', revision).disabled, true);
  await click(button('編集', editor));
  assert.equal(field<HTMLTextAreaElement>('手順（Markdown）').value, after);
  assert.ok(field('対象ルーム').closest('label'));
  assert.equal(mutations.length, 0);
  Object.defineProperty(dom.window, 'innerWidth', { value: 1440, configurable: true });
});

after(async () => {
  if (root) await act(async () => root!.unmount());
  dom.window.close();
});
