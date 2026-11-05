import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import type { Snapshot, Approval, Bot, Task, Skill, Room } from '../src/shared/types.js';

async function fixture(t: TestContext, apiToken?: string) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-api-'));
  const context = await createApp({
    dataDir,
    apiToken,
    scheduler: false,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  t.after(async () => {
    await context.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    context.app.inject({
      method,
      url,
      payload: payload as object,
      headers: { host: 'localhost', ...headers },
    });
  return { ...context, call, dataDir };
}

test('first run has persistent rooms and bots, with no fabricated conversation', async (t) => {
  const { call } = await fixture(t);
  const response = await call('GET', '/api/state');
  assert.equal(response.statusCode, 200);
  const state = response.json<Snapshot>();
  assert.equal(state.bots.length, 2);
  assert.equal(state.rooms.length, 1);
  assert.equal(state.messages.length, 0);
  assert.equal(state.tasks.length, 0);
  assert.equal(state.settings.demoMode, false);
  assert.equal(state.settings.maxHandoffs, null, 'new installations allow unlimited handoffs');
  const unconfigured = await call('POST', '/api/rooms/room_lounge/messages', { body: 'hello' });
  assert.equal(unconfigured.statusCode, 409);
  assert.equal((await call('GET', '/api/state')).json<Snapshot>().messages.length, 0);
});

test('authentication protects state, permits health, creates and revokes an HttpOnly session', async (t) => {
  const { call } = await fixture(t, 'test-only-access-token-long-enough');
  assert.equal((await call('GET', '/api/health')).statusCode, 200);
  assert.equal((await call('GET', '/api/state')).statusCode, 401);
  assert.equal((await call('POST', '/api/auth', { token: 'wrong' })).statusCode, 401);
  const login = await call('POST', '/api/auth', { token: 'test-only-access-token-long-enough' });
  assert.equal(login.statusCode, 200);
  const setCookie = String(login.headers['set-cookie']);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await call('GET', '/api/state', undefined, { cookie })).statusCode, 200);
  assert.equal((await call('DELETE', '/api/auth', undefined, { cookie })).statusCode, 200);
  assert.equal((await call('GET', '/api/state', undefined, { cookie })).statusCode, 401);
  assert.equal(
    (
      await call('GET', '/api/state', undefined, {
        authorization: 'Bearer test-only-access-token-long-enough',
      })
    ).statusCode,
    200,
  );
});

test('local mode rejects DNS-rebinding hosts and cross-origin writes', async (t) => {
  const { call } = await fixture(t);
  assert.equal(
    (await call('GET', '/api/state', undefined, { host: 'attacker.example' })).statusCode,
    403,
  );
  assert.equal(
    (await call('POST', '/api/demo', { enabled: true }, { origin: 'https://attacker.example' }))
      .statusCode,
    403,
  );
  assert.equal(
    (await call('POST', '/api/demo', { enabled: true }, { origin: 'http://localhost' })).statusCode,
    200,
  );
});

test('secret settings are encrypted, omitted from snapshots, and preserved when omitted', async (t) => {
  const { call, store, dataDir } = await fixture(t);
  const apiKey = 'test-provider-secret-that-must-not-leak';
  const saved = await call('PUT', '/api/settings', {
    model: { baseUrl: 'http://localhost:1234/v1/', modelId: 'local-model', apiKey },
    search: { apiKey: 'test-search-secret' },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().model.baseUrl, 'http://localhost:1234/v1');
  assert.equal(saved.json().model.apiKeyConfigured, true);
  assert.ok(!saved.body.includes(apiKey));
  await call('PUT', '/api/settings', { autoLearn: false });
  assert.equal(store.secret('model.apiKey'), apiKey);
  const state = await call('GET', '/api/state');
  assert.ok(!state.body.includes(apiKey));
  assert.ok(!state.body.includes('test-search-secret'));
  const row = store.db.prepare('SELECT value FROM secrets WHERE key=?').get('model.apiKey') as {
    value: string;
  };
  assert.ok(!row.value.includes(apiKey));
  assert.equal((await readFile(join(dataDir, 'secret.key'))).length, 32);
  assert.equal(
    (await call('PUT', '/api/settings', { model: { apiKey: '' } })).json().model.apiKeyConfigured,
    false,
  );
});

test('partial edits preserve room description and disabled bot state', async (t) => {
  const { call } = await fixture(t);
  await call('PATCH', '/api/rooms/room_lounge', { description: 'Keep this description' });
  const room = await call('PATCH', '/api/rooms/room_lounge', { pinned: false });
  assert.equal(room.statusCode, 200);
  assert.equal(room.json<Room>().description, 'Keep this description');
  await call('PATCH', '/api/bots/bot_aster', { enabled: false });
  assert.equal(
    (await call('PATCH', '/api/bots/bot_aster', { role: 'Planner' })).json().enabled,
    false,
  );
});

test('handles resolve to short mentions and stop/resume keep the task identity', async (t) => {
  const { call } = await fixture(t);
  await call('POST', '/api/demo', { enabled: true });
  const response = await call('POST', '/api/rooms/room_lounge/messages', {
    body: '@nova Please verify this.',
  });
  assert.equal(response.statusCode, 200);
  const { tasks } = response.json<{ tasks: Task[] }>();
  assert.deepEqual(
    tasks.map((task) => task.botId),
    ['bot_nova'],
  );
  const taskId = tasks[0].id;
  assert.equal((await call('POST', `/api/tasks/${taskId}/stop`)).json<Task>().status, 'stopped');
  const resumed = (await call('POST', `/api/tasks/${taskId}/resume`)).json<Task>();
  assert.equal(resumed.id, taskId);
  assert.equal(resumed.status, 'queued');
  assert.equal((await call('POST', `/api/tasks/${taskId}/resume`)).statusCode, 409);
  assert.equal((await call('POST', '/api/demo', { enabled: false })).statusCode, 409);
  await call('POST', '/api/tasks/stop-all');
  assert.equal((await call('PATCH', '/api/rooms/room_lounge', { archived: true })).statusCode, 200);
  assert.equal(
    (
      await call('POST', '/api/rooms/room_lounge/messages', {
        body: 'Archived rooms do not run tasks',
      })
    ).statusCode,
    409,
  );
});

test('@all addresses enabled current-room members once and keeps explicit target validation', async (t) => {
  const { call, store, controller } = await fixture(t);
  const template = store.get<Bot>('bots', 'bot_aster')!;
  store.put('bots', { ...template, id: 'bot_disabled', handle: 'disabled', enabled: false });
  store.put('bots', { ...template, id: 'bot_outside', handle: 'outside' });
  store.patch<Room>('rooms', 'room_lounge', {
    botIds: ['bot_aster', 'bot_nova', 'bot_disabled'],
  });
  await call('POST', '/api/demo', { enabled: true });
  await call('PUT', '/api/settings', { maxHandoffs: 0 });
  const response = await call('POST', '/api/rooms/room_lounge/messages', {
    body: '@aLl @nova @ALL @nova Please review this together.',
  });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json<{ tasks: Task[]; message: { targetBotIds: string[] } }>();
  assert.deepEqual(result.message.targetBotIds, ['bot_aster', 'bot_nova']);
  assert.deepEqual(
    result.tasks.map((task) => task.botId),
    ['bot_aster', 'bot_nova'],
  );
  for (const task of result.tasks) {
    assert.equal(task.rootTaskId, task.id, 'each direct recipient receives an originating task');
    assert.equal(task.depth, 0);
    assert.equal(task.parentTaskId, undefined);
  }
  for (const botId of ['bot_disabled', 'bot_outside']) {
    const rejected = await call('POST', '/api/rooms/room_lounge/messages', {
      body: '@all Explicit invalid recipients still fail.',
      botIds: [botId],
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.equal(controller.getSnapshot().tasks.length, 2);
    assert.equal(controller.getSnapshot().messages.length, 1);
  }
});

test('@all uses exact parsed handles and preserves normal fallback and explicit recipient precedence', async (t) => {
  const { call, store } = await fixture(t);
  store.put('bots', {
    ...store.get<Bot>('bots', 'bot_aster')!,
    id: 'bot_allison',
    handle: 'allison',
  });
  store.patch<Room>('rooms', 'room_lounge', {
    botIds: ['bot_aster', 'bot_nova', 'bot_allison'],
  });
  await call('POST', '/api/demo', { enabled: true });
  const cases: Array<{ body: string; botIds?: string[]; expected: string[] }> = [
    { body: '@allison Please handle this.', expected: ['bot_allison'] },
    { body: 'Check owner@all.example and team@nova.example.', expected: ['bot_aster'] },
    { body: 'Continue without a mention.', expected: ['bot_aster'] },
    { body: '@unknown Continue with the default.', expected: ['bot_aster'] },
    { body: '@NOVA @nova Please review once.', expected: ['bot_nova'] },
    {
      body: '@all The explicit recipient takes precedence.',
      botIds: ['bot_nova', 'bot_nova'],
      expected: ['bot_nova'],
    },
    {
      body: '@ALL An empty explicit list still uses mentions.',
      botIds: [],
      expected: ['bot_aster', 'bot_nova', 'bot_allison'],
    },
  ];
  for (const { expected, ...payload } of cases) {
    const response = await call('POST', '/api/rooms/room_lounge/messages', payload);
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json<{ tasks: Task[]; message: { targetBotIds: string[] } }>();
    assert.deepEqual(
      result.tasks.map((task) => task.botId),
      expected,
      payload.body,
    );
    assert.deepEqual(result.message.targetBotIds, expected, payload.body);
  }
});

test('all is reserved for new handles while legacy bots retain editing and explicit-ID routing', async (t) => {
  const { call, store } = await fixture(t);
  const template = store.get<Bot>('bots', 'bot_aster')!;
  const created = await call('POST', '/api/bots', { ...template, handle: ' ALL ' });
  assert.equal(created.statusCode, 400);
  assert.match(created.json().error, /reserved/i);
  const renamed = await call('PATCH', '/api/bots/bot_nova', { handle: 'all' });
  assert.equal(renamed.statusCode, 400);
  assert.match(renamed.json().error, /reserved/i);
  assert.equal(store.get<Bot>('bots', 'bot_nova')?.handle, 'nova');

  // A legacy or imported bot keeps its data; no implicit rename is performed.
  store.put('bots', { ...template, id: 'bot_legacy_all', handle: 'all' });
  const edited = await call('PATCH', '/api/bots/bot_legacy_all', {
    handle: 'ALL',
    role: 'Updated legacy role',
  });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json<Bot>().handle, 'all');
  assert.equal(edited.json<Bot>().role, 'Updated legacy role');
  store.patch<Room>('rooms', 'room_lounge', {
    botIds: ['bot_aster', 'bot_nova', 'bot_legacy_all'],
  });
  await call('POST', '/api/demo', { enabled: true });
  const direct = await call('POST', '/api/rooms/room_lounge/messages', {
    body: '@all This request is explicitly addressed to the legacy bot.',
    botIds: ['bot_legacy_all', 'bot_legacy_all'],
  });
  assert.equal(direct.statusCode, 200, direct.body);
  assert.deepEqual(
    direct.json<{ tasks: Task[] }>().tasks.map((task) => task.botId),
    ['bot_legacy_all'],
  );
  const everyone = await call('POST', '/api/rooms/room_lounge/messages', {
    body: '@all All enabled members, including the legacy bot, receive this once.',
  });
  assert.equal(everyone.statusCode, 200, everyone.body);
  assert.deepEqual(
    everyone.json<{ tasks: Task[] }>().tasks.map((task) => task.botId),
    ['bot_aster', 'bot_nova', 'bot_legacy_all'],
  );
});

test('approval shows exact input, resolves once, and cancellation invalidates a stale card', async (t) => {
  const { call, controller } = await fixture(t);
  await call('POST', '/api/demo', { enabled: true });
  const task = controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Write a note',
  });
  const signal = new AbortController();
  const input = {
    taskId: task.id,
    roomId: task.roomId,
    botId: task.botId,
    toolName: 'file_write',
    summary: 'Write the reviewed note',
    target: 'notes/review.md',
    args: { path: 'notes/review.md', content: 'Exact content' },
  };
  const pending = controller.requestApproval(input, signal.signal);
  const card = controller.getSnapshot().approvals.at(-1)!;
  assert.equal(card.target, 'notes/review.md');
  assert.equal(card.args.content, 'Exact content');
  assert.equal(
    (await call('POST', `/api/approvals/${card.id}`, { decision: 'approve' })).json<Approval>()
      .status,
    'approved',
  );
  assert.equal(await pending, true);
  assert.equal(
    (await call('POST', `/api/approvals/${card.id}`, { decision: 'approve' })).statusCode,
    409,
  );
  const pending2 = controller.requestApproval(input, signal.signal);
  const second = controller.getSnapshot().approvals.at(-1)!;
  signal.abort();
  assert.equal(await pending2, false);
  assert.equal(
    (await call('POST', `/api/approvals/${second.id}`, { decision: 'approve' })).statusCode,
    409,
  );
  assert.equal(controller.getSnapshot().approvals.at(-1)!.status, 'cancelled');
});

test('root task handoff budget prevents bot ping-pong even with forged depth', async (t) => {
  const { call, controller } = await fixture(t);
  await call('POST', '/api/demo', { enabled: true });
  await call('PUT', '/api/settings', { maxHandoffs: 1 });
  const root = controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Start',
  });
  const child = controller.enqueueTask({
    roomId: root.roomId,
    botId: 'bot_nova',
    prompt: 'Research',
    parentTaskId: root.id,
    depth: 0,
  });
  assert.equal(child.depth, 1);
  assert.equal(child.rootTaskId, root.id);
  assert.throws(
    () =>
      controller.enqueueTask({
        roomId: root.roomId,
        botId: 'bot_aster',
        prompt: 'Again',
        parentTaskId: child.id,
        depth: 0,
      }),
    /handoff limit/,
  );
});

test('unlimited handoffs pass the former count and depth limits and remain distinct from disabled', async (t) => {
  const { call, controller } = await fixture(t);
  await call('POST', '/api/demo', { enabled: true });
  let parent = controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Start an extended review.',
  });
  const rootId = parent.id;
  for (let index = 1; index <= 32; index++) {
    parent = controller.enqueueTask({
      roomId: parent.roomId,
      botId: parent.botId === 'bot_aster' ? 'bot_nova' : 'bot_aster',
      prompt: `Review ${index}`,
      parentTaskId: parent.id,
    });
    assert.equal(parent.depth, index);
    assert.equal(parent.rootTaskId, rootId);
  }
  assert.equal((await call('PUT', '/api/settings', { maxHandoffs: 0 })).statusCode, 200);
  assert.equal(controller.getSnapshot().settings.maxHandoffs, 0);
  assert.throws(
    () =>
      controller.enqueueTask({
        roomId: parent.roomId,
        botId: 'bot_nova',
        prompt: 'Disabled handoff',
        parentTaskId: parent.id,
      }),
    /handoff limit/,
  );
  assert.equal((await call('PUT', '/api/settings', { maxHandoffs: null })).statusCode, 200);
  assert.equal(controller.getSnapshot().settings.maxHandoffs, null);
  assert.doesNotThrow(() =>
    controller.enqueueTask({
      roomId: parent.roomId,
      botId: 'bot_nova',
      prompt: 'Continue after removing the cap.',
      parentTaskId: parent.id,
    }),
  );
});

test('handoff settings preserve explicit caps and reject invalid numeric limits', async (t) => {
  const { call, store } = await fixture(t);
  for (const limit of [0, 6, 100, 10_000, null]) {
    assert.equal((await call('PUT', '/api/settings', { maxHandoffs: limit })).statusCode, 200);
    store.seed();
    assert.equal(store.settings().maxHandoffs, limit, 'seeding never replaces a saved choice');
    await call('PUT', '/api/settings', { autoLearn: false });
    assert.equal(store.settings().maxHandoffs, limit, 'unrelated edits preserve the choice');
  }
  for (const invalid of [-1, 1.5, 10_001, 'unlimited', '6']) {
    assert.equal((await call('PUT', '/api/settings', { maxHandoffs: invalid })).statusCode, 400);
    assert.equal(store.settings().maxHandoffs, null);
  }
});

test('skills require activation and revisions can be restored without losing history', async (t) => {
  const { call } = await fixture(t);
  const created = await call('POST', '/api/skills', {
    name: 'review-checklist',
    description: 'A reusable review',
    content: 'Version one',
  });
  const skill = created.json<Skill>();
  assert.equal(skill.status, 'candidate');
  const edited = (
    await call('PATCH', `/api/skills/${skill.id}`, { content: 'Version two', status: 'active' })
  ).json<Skill>();
  assert.equal(edited.version, 2);
  assert.equal(edited.status, 'active');
  const restored = (
    await call('POST', `/api/skills/${skill.id}/restore`, { version: 1 })
  ).json<Skill>();
  assert.equal(restored.version, 3);
  assert.equal(restored.content, 'Version one');
  assert.equal(restored.revisions.length, 3);
  const exported = await call('GET', `/api/skills/${skill.id}/export`);
  assert.match(exported.body, /name: "review-checklist"/);
  assert.match(exported.headers['content-disposition'] as string, /attachment/);
  await call('POST', '/api/memories', { content: 'Prefers concise updates.' });
  await call('POST', '/api/memories', { content: '  Prefers   concise updates. ' });
  assert.equal((await call('GET', '/api/state')).json<Snapshot>().memories.length, 1);
});

test('webhook tokens are distinct from app access and event IDs deduplicate delivery', async (t) => {
  const { call } = await fixture(t);
  await call('POST', '/api/demo', { enabled: true });
  const created = await call('POST', '/api/automations', {
    name: 'Review incoming events',
    kind: 'webhook',
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Summarize this event',
  });
  assert.equal(created.statusCode, 200);
  const automation = created.json();
  const key = (await call('POST', `/api/automations/${automation.id}/webhook-key`)).json<{
    token: string;
    path: string;
  }>();
  assert.equal(
    (await call('POST', key.path, { text: 'Build finished', eventId: 'event-001' })).statusCode,
    401,
  );
  const headers = { authorization: `Bearer ${key.token}` };
  assert.equal(
    (await call('POST', key.path, { text: 'Build finished', eventId: 'event-001' }, headers)).json()
      .duplicate,
    false,
  );
  assert.equal(
    (await call('POST', key.path, { text: 'Build finished', eventId: 'event-001' }, headers)).json()
      .duplicate,
    true,
  );
  const deferred = (
    await call(
      'POST',
      key.path,
      { text: 'Another event while busy', eventId: 'event-002' },
      headers,
    )
  ).json();
  assert.equal(deferred.duplicate, false);
  assert.equal(deferred.queued, true);
  assert.ok(!(await call('GET', '/api/state')).body.includes(key.token));
});

test('validation prevents malformed endpoints and invalid members before saving messages', async (t) => {
  const { call } = await fixture(t);
  assert.equal(
    (await call('PUT', '/api/settings', { model: { baseUrl: 'file:///etc/passwd' } })).statusCode,
    400,
  );
  assert.equal(
    (await call('PUT', '/api/settings', { model: { baseUrl: 'http://169.254.169.254' } }))
      .statusCode,
    400,
  );
  assert.equal(
    (await call('PUT', '/api/settings', { model: { contextWindow: 2048, maxOutputTokens: 4096 } }))
      .statusCode,
    400,
  );
  assert.equal(
    (await call('POST', '/api/rooms', { name: 'Invalid', botIds: ['missing'] })).statusCode,
    404,
  );
  await call('POST', '/api/demo', { enabled: true });
  assert.equal(
    (
      await call('POST', '/api/rooms/room_lounge/messages', {
        body: 'Do not save this',
        botIds: ['missing'],
      })
    ).statusCode,
    404,
  );
  assert.equal((await call('GET', '/api/state')).json<Snapshot>().messages.length, 0);
});

test('restart retains navigation, secrets, and history while requiring explicit task recovery', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-recovery-'));
  const options = {
    dataDir,
    scheduler: false,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  };
  let context = await createApp(options);
  t.after(async () => {
    await context.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await context.app.ready();
  context.store.put('settings', { ...context.store.settings(), demoMode: true, id: 'main' });
  context.store.setSecret('model.apiKey', 'test-restored-secret');
  context.store.patch<Room>('rooms', 'room_lounge', { name: 'Persistent lounge', pinned: false });
  const task = context.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Recover this task',
  });
  context.controller.addMessage({
    roomId: 'room_lounge',
    authorType: 'bot',
    authorId: 'bot_aster',
    body: 'Partial response',
    taskId: task.id,
    status: 'streaming',
  });
  await context.app.close();
  context = await createApp(options);
  await context.app.ready();
  const state = context.controller.getSnapshot();
  assert.equal(state.rooms[0].name, 'Persistent lounge');
  assert.equal(state.rooms[0].pinned, false);
  assert.equal(state.tasks[0].status, 'interrupted');
  assert.equal(state.messages[0].body, 'Partial response');
  assert.equal(state.messages[0].status, 'error');
  assert.equal(context.store.secret('model.apiKey'), 'test-restored-secret');
  assert.equal(context.controller.resume(task.id).id, task.id);
});

test('production serves compiled assets and keeps API authorization on encoded paths', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-static-'));
  const staticDir = join(dataDir, 'static');
  await mkdir(join(staticDir, 'assets'), { recursive: true });
  await writeFile(
    join(staticDir, 'index.html'),
    '<!doctype html><title>Agent Loom static test</title>',
  );
  await writeFile(join(staticDir, 'assets', 'app.js'), 'document.title="Agent Loom";');
  const { app } = await createApp({
    dataDir,
    staticDir,
    scheduler: false,
    apiToken: 'test-access-token-for-static-app',
  });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const page = await app.inject('/');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Agent Loom static test/);
  const asset = await app.inject('/assets/app.js');
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers['content-type'] as string, /javascript/);
  assert.equal((await app.inject('/api/state')).statusCode, 401);
  for (const path of [
    '/api%2fstate',
    '/%61pi/state',
    '//api/state',
    '/./api/state',
    '/assets/../api/state',
  ]) {
    const response = await app.inject(path);
    assert.ok(!response.body.includes('bot_aster'), `Encoded URL must not reveal state: ${path}`);
  }
});

test('a second process owner cannot change the live workspace during startup recovery', async (t) => {
  const { app, dataDir, controller, call } = await fixture(t);
  await call('POST', '/api/demo', { enabled: true });
  const task = controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Still active',
  });
  const signal = new AbortController();
  const waiting = controller.requestApproval(
    {
      taskId: task.id,
      roomId: task.roomId,
      botId: task.botId,
      toolName: 'write_file',
      summary: 'Pending action',
      target: 'note.md',
      args: { path: 'note.md', content: 'Review me' },
    },
    signal.signal,
  );
  await assert.rejects(createApp({ dataDir, scheduler: false }), /already in use/);
  assert.equal(controller.getSnapshot().tasks[0].status, 'queued');
  assert.equal(controller.getSnapshot().approvals[0].status, 'pending');
  signal.abort();
  assert.equal(await waiting, false);
  await app.close();
  const reopened = await createApp({ dataDir, scheduler: false });
  await reopened.app.ready();
  await reopened.app.close();
});

test('rotating the application access token revokes saved login cookies', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-auth-rotation-'));
  let context = await createApp({
    dataDir,
    scheduler: false,
    apiToken: 'first-test-access-token-that-is-long',
  });
  t.after(async () => {
    await context.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const login = await context.app.inject({
    method: 'POST',
    url: '/api/auth',
    payload: { token: 'first-test-access-token-that-is-long' },
  });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  await context.app.close();
  context = await createApp({
    dataDir,
    scheduler: false,
    apiToken: 'second-test-access-token-that-is-long',
  });
  assert.equal(
    (await context.app.inject({ url: '/api/state', headers: { cookie } })).statusCode,
    401,
  );
});

test(
  'logout closes an already authenticated event stream before it can receive another snapshot',
  { timeout: 8_000 },
  async (t) => {
    const { app, call, controller } = await fixture(t, 'test-only-access-token-for-streams');
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const login = await call('POST', '/api/auth', { token: 'test-only-access-token-for-streams' });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const response = await fetch(`${address}/api/events`, {
      headers: { cookie },
      signal: AbortSignal.timeout(4000),
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const initial = await reader.read();
    assert.equal(initial.done, false);
    await call('DELETE', '/api/auth', undefined, { cookie });
    controller.notify({
      title: 'Private after logout',
      body: 'This must not reach the revoked stream.',
    });
    const next = await reader.read();
    assert.equal(next.done, true);
  },
);

test('multi-recipient admission is atomic at capacity and resume observes the same limit', async (t) => {
  const { call, controller } = await fixture(t);
  await call('POST', '/api/demo', { enabled: true });
  const tasks: Task[] = [];
  for (let index = 0; index < 199; index++)
    tasks.push(
      controller.enqueueTask({
        roomId: 'room_lounge',
        botId: 'bot_aster',
        prompt: `Queued fixture ${index}`,
      }),
    );
  for (const payload of [
    { body: 'Both bots, one action', botIds: ['bot_aster', 'bot_nova'] },
    { body: '@all Both bots, one action' },
  ]) {
    const rejected = await call('POST', '/api/rooms/room_lounge/messages', payload);
    assert.equal(rejected.statusCode, 429);
    assert.equal(controller.getSnapshot().tasks.length, 199);
    assert.equal(controller.getSnapshot().messages.length, 0);
  }
  controller.enqueueTask({ roomId: 'room_lounge', botId: 'bot_aster', prompt: 'Fill final slot' });
  await controller.stop(tasks[0].id);
  controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Replace stopped slot',
  });
  assert.equal((await call('POST', `/api/tasks/${tasks[0].id}/resume`)).statusCode, 429);
});
