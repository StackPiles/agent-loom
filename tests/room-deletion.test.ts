import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createApp, type AppOptions } from '../src/server/app.js';
import { createScheduler } from '../src/server/scheduler.js';
import { planRoomDeletion } from '../src/server/room-deletion-data.js';
import type { RuntimeHost } from '../src/server/runtime/contract.js';
import type { Approval, Automation, Memory, Room, Snapshot, Task } from '../src/shared/types.js';
import { DEFAULT_AUTONOMOUS_WAKEUP_POLICY } from '../src/shared/work.js';
import type { ServiceAccount } from '../src/shared/service-accounts.js';

const stamp = '2026-11-15T10:00:00.000Z';
const diskKey = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

type Instance = Awaited<ReturnType<typeof createApp>>;

async function room(f: Instance, name: string) {
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/rooms',
    payload: {
      name,
      botIds: ['bot_aster', 'bot_nova'],
      parallelResponses: true,
      autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room' },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Room>();
}

async function automation(f: Instance, roomId: string) {
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/automations',
    payload: {
      name: 'Room watcher',
      kind: 'interval',
      roomId,
      botId: 'bot_aster',
      prompt: 'Check.',
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Automation>();
}

function reservation(f: Instance, task: Task) {
  return f.controller.work.manageWakeup(task.id, {
    operation: 'upsert',
    key: 'delete-lifecycle-check',
    name: 'Follow up the assigned room',
    purpose: 'Continue the work in the original room.',
    reason: 'Review this room later.',
    prompt: 'Continue the same room.',
    checkpoint: {
      summary: 'A current room task is running.',
      completed: 'Setup complete.',
      nextStep: 'Review the result.',
      references: [],
      doneWhen: 'The requested work is done.',
      pendingChecks: [],
      uncertainActions: [],
    },
    schedule: {
      type: 'once',
      dateTime: '2099-11-15T12:00',
      timeZone: 'UTC',
      missedRunPolicy: 'run_once',
    },
  });
}

async function controlledFixture(t: TestContext, apiToken?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-room-deletion-'));
  const barriers = new Map<string, ReturnType<typeof deferred>>();
  const stopFailures = new Set<string>();
  const stopped: string[] = [];
  const startupRooms: string[][] = [];
  let shutdowns = 0;
  let host!: RuntimeHost;
  const options: AppOptions = {
    dataDir: join(directory, 'data'),
    scheduler: false,
    apiToken,
    runtimeFactory(runtimeHost) {
      host = runtimeHost;
      startupRooms.push(runtimeHost.getSnapshot().rooms.map((item) => item.id));
      return {
        start(task) {
          runtimeHost.updateTask(task.id, { status: 'running' });
        },
        async stop(taskId) {
          stopped.push(taskId);
          await barriers.get(taskId)?.promise;
          if (stopFailures.has(taskId)) throw new Error('Simulated runtime stop failure.');
        },
        async shutdown() {
          shutdowns += 1;
        },
        setRoomPaused() {},
        queueState: () => ({ active: 0, waiting: 0 }),
      };
    },
  };
  let instance = await createApp(options);
  instance.store.put('settings', { ...instance.store.settings(), id: 'main', demoMode: true });
  t.after(async () => {
    for (const barrier of barriers.values()) barrier.resolve();
    await instance.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get f() {
      return instance;
    },
    get host() {
      return host;
    },
    directory,
    stopped,
    startupRooms,
    stopFailures,
    get shutdowns() {
      return shutdowns;
    },
    hold(taskId: string) {
      const barrier = deferred();
      barriers.set(taskId, barrier);
      return barrier;
    },
    async restart() {
      for (const barrier of barriers.values()) barrier.resolve();
      await instance.app.close();
      barriers.clear();
      stopFailures.clear();
      instance = await createApp(options);
    },
  };
}

test('room deletion waits for its jobs and rejects fresh work without stopping another room', async (t) => {
  const fixture = await controlledFixture(t);
  const { f } = fixture;
  const a = await room(f, 'Delete A');
  const b = await room(f, 'Keep B');
  const taskA = f.controller.enqueueTask({ roomId: a.id, botId: 'bot_aster', prompt: 'A work' });
  const taskB = f.controller.enqueueTask({ roomId: b.id, botId: 'bot_aster', prompt: 'B work' });
  await until(() => f.store.get<Task>('tasks', taskA.id)?.status === 'running', 'A starts');
  const ruleA = await automation(f, a.id);
  const ruleB = await automation(f, b.id);
  const workA = reservation(f, taskA);
  const workB = reservation(f, taskB);
  const memoryResponse = await f.app.inject({
    method: 'POST',
    url: '/api/memories',
    payload: { roomId: a.id, botId: 'bot_aster', content: 'A private note.' },
  });
  assert.equal(memoryResponse.statusCode, 200, memoryResponse.body);
  const memory = memoryResponse.json<Memory>();
  const serviceResponse = await f.app.inject({
    method: 'POST',
    url: '/api/service-accounts',
    payload: {
      name: 'A service',
      url: 'https://a.example.test/login',
      login: 'owner',
      roomId: a.id,
      botId: 'bot_aster',
      sharedBotIds: [],
      mailAccountId: null,
      status: 'active',
      notes: '',
      credential: 'private-A-credential',
    },
  });
  assert.equal(serviceResponse.statusCode, 200, serviceResponse.body);
  const service = serviceResponse.json<ServiceAccount>();
  const gate = fixture.hold(taskA.id);
  let resolved = false;
  const deletion = f.app
    .inject({ method: 'DELETE', url: `/api/rooms/${a.id}` })
    .then((response) => {
      resolved = true;
      return response;
    });
  await until(() => fixture.stopped.includes(taskA.id), 'deletion reaches the stop boundary');
  assert.equal(resolved, false, 'the delete response must wait for the running job');
  assert.equal(f.store.get<Room>('rooms', a.id)?.deletion?.status, 'deleting');
  assert.equal(fixture.shutdowns, 0, 'deleting one room must not shut down the runtime');
  assert.ok(!fixture.stopped.includes(taskB.id));
  const repeatedDeletion = f.app.inject({ method: 'DELETE', url: `/api/rooms/${a.id}` });

  const writes = [
    { method: 'PATCH' as const, url: `/api/rooms/${a.id}`, payload: { name: 'Escape deletion' } },
    { method: 'POST' as const, url: `/api/rooms/${a.id}/messages`, payload: { body: 'New work' } },
    { method: 'POST' as const, url: `/api/rooms/${a.id}/resume` },
    { method: 'POST' as const, url: `/api/tasks/${taskA.id}/resume` },
    {
      method: 'POST' as const,
      url: '/api/memories',
      payload: { roomId: a.id, content: 'Late private memory.' },
    },
    {
      method: 'PATCH' as const,
      url: `/api/memories/${memory.id}`,
      payload: { roomId: b.id, baseVersion: memory.version ?? 1, reason: 'Move during deletion.' },
    },
    {
      method: 'POST' as const,
      url: '/api/skills',
      payload: { roomId: a.id, name: 'Late skill', description: '', content: 'Do this.' },
    },
    {
      method: 'PATCH' as const,
      url: `/api/automations/${ruleA.id}`,
      payload: { roomId: b.id },
    },
    {
      method: 'PUT' as const,
      url: `/api/service-accounts/${service.id}`,
      payload: {
        name: service.name,
        url: service.url,
        login: service.login,
        botId: service.botId,
        sharedBotIds: service.sharedBotIds,
        mailAccountId: service.mailAccountId,
        status: service.status,
        notes: service.notes,
        roomId: b.id,
        expectedRevision: service.revision,
      },
    },
  ];
  for (const request of writes) {
    const response = await f.app.inject(request);
    assert.equal(response.statusCode, 409, `${request.method} ${request.url}: ${response.body}`);
  }
  const bMessage = await f.app.inject({
    method: 'POST',
    url: `/api/rooms/${b.id}/messages`,
    payload: { body: 'B remains usable.' },
  });
  assert.equal(bMessage.statusCode, 200, bMessage.body);
  gate.resolve();
  const result = await deletion;
  assert.equal(result.statusCode, 200, result.body);
  const repeatedResult = await repeatedDeletion;
  assert.equal(repeatedResult.statusCode, 200, repeatedResult.body);
  assert.equal(result.json().ok, true);
  assert.equal(f.store.get('rooms', a.id), undefined);
  assert.equal(f.store.get('tasks', taskA.id), undefined);
  assert.equal(f.store.get('automations', ruleA.id), undefined);
  assert.equal(f.store.get('workItems', workA.work.id), undefined);
  assert.equal(f.store.get('wakeups', workA.wakeup.id), undefined);
  assert.equal(f.store.get('memories', memory.id), undefined);
  assert.equal(f.store.get('serviceAccounts', service.id), undefined);
  assert.equal(f.store.secret(`service.${service.id}.credential`), '');
  assert.ok(f.store.get('rooms', b.id));
  assert.ok(f.store.get('tasks', taskB.id));
  assert.ok(f.store.get('automations', ruleB.id));
  assert.ok(f.store.get('workItems', workB.work.id));
  assert.ok(f.store.get('wakeups', workB.wakeup.id));
  assert.equal(fixture.shutdowns, 0);
  assert.ok(fixture.stopped.every((id) => id === taskA.id));
});

test('late runtime callbacks cannot recreate deleted room data, even after restart', async (t) => {
  const fixture = await controlledFixture(t);
  const a = await room(fixture.f, 'Late callbacks');
  const task = fixture.f.controller.enqueueTask({
    roomId: a.id,
    botId: 'bot_aster',
    prompt: 'Run.',
  });
  await until(
    () => fixture.f.store.get<Task>('tasks', task.id)?.status === 'running',
    'task starts',
  );
  const deletion = await fixture.f.app.inject({ method: 'DELETE', url: `/api/rooms/${a.id}` });
  assert.equal(deletion.statusCode, 200, deletion.body);
  async function tryLateWrites() {
    const { host, f } = fixture;
    const attempts = [
      () =>
        host.addMessage({
          roomId: a.id,
          authorType: 'bot',
          authorId: 'bot_aster',
          body: 'Late output.',
          status: 'complete',
          taskId: task.id,
        }),
      () =>
        host.addActivity({
          roomId: a.id,
          taskId: task.id,
          botId: 'bot_aster',
          kind: 'tool',
          title: 'Late result',
          detail: 'Late details.',
          status: 'success',
        }),
      () =>
        host.saveOperation({
          key: 'late-deleted-operation',
          taskId: task.id,
          toolName: 'test',
          args: {},
          result: 'Late result',
          status: 'completed',
          updatedAt: stamp,
        }),
      () =>
        host.notify({
          title: 'Late notice',
          body: 'Late notice body.',
          roomId: a.id,
          taskId: task.id,
        }),
      () =>
        host.saveMemory(
          { content: 'Late learning.', botId: 'bot_aster', roomId: a.id },
          { kind: 'bot' as const, botId: 'bot_aster', roomId: a.id },
        ),
      () =>
        host.enqueueTask({
          roomId: a.id,
          botId: 'bot_aster',
          prompt: 'Late handoff.',
          parentTaskId: task.id,
        }),
    ];
    for (const attempt of attempts) {
      try {
        await attempt();
      } catch {
        /* Rejecting stale work is an allowed outcome. */
      }
    }
    for (const kind of ['rooms', 'tasks', 'messages', 'activities', 'notifications', 'memories']) {
      assert.ok(
        !f.store
          .list<{ id: string; roomId?: string }>(kind)
          .some((item) => item.id === a.id || item.roomId === a.id),
        `${kind} must stay deleted`,
      );
    }
    assert.equal(f.store.get('operations', 'late-deleted-operation'), undefined);
  }
  await tryLateWrites();
  await fixture.restart();
  await tryLateWrites();
  const retry = await fixture.f.app.inject({ method: 'DELETE', url: `/api/rooms/${a.id}` });
  assert.equal(retry.statusCode, 200, retry.body);
});

test('a failed stop keeps the room inert and an explicit retry completes deletion', async (t) => {
  const fixture = await controlledFixture(t);
  const a = await room(fixture.f, 'Retry deletion');
  const task = fixture.f.controller.enqueueTask({
    roomId: a.id,
    botId: 'bot_aster',
    prompt: 'Run.',
  });
  await until(
    () => fixture.f.store.get<Task>('tasks', task.id)?.status === 'running',
    'task starts',
  );
  fixture.stopFailures.add(task.id);
  const failed = await fixture.f.app.inject({ method: 'DELETE', url: `/api/rooms/${a.id}` });
  assert.ok(failed.statusCode >= 400, failed.body);
  assert.equal(fixture.f.store.get<Room>('rooms', a.id)?.deletion?.status, 'failed');
  const resume = await fixture.f.app.inject({ method: 'POST', url: `/api/rooms/${a.id}/resume` });
  assert.equal(resume.statusCode, 409, resume.body);
  const message = await fixture.f.app.inject({
    method: 'POST',
    url: `/api/rooms/${a.id}/messages`,
    payload: { body: 'Do not restart.' },
  });
  assert.equal(message.statusCode, 409, message.body);
  fixture.stopFailures.delete(task.id);
  const retried = await fixture.f.app.inject({ method: 'DELETE', url: `/api/rooms/${a.id}` });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(fixture.f.store.get('rooms', a.id), undefined);
});

test('startup completes interrupted deletion before runtime can observe or restart the room', async (t) => {
  const fixture = await controlledFixture(t);
  const a = await room(fixture.f, 'Delete across restart');
  const task = fixture.f.controller.enqueueTask({
    roomId: a.id,
    botId: 'bot_aster',
    prompt: 'Run.',
  });
  await until(
    () => fixture.f.store.get<Task>('tasks', task.id)?.status === 'running',
    'task starts',
  );
  fixture.stopFailures.add(task.id);
  const failed = await fixture.f.app.inject({ method: 'DELETE', url: `/api/rooms/${a.id}` });
  assert.ok(failed.statusCode >= 400, failed.body);
  await fixture.restart();
  assert.ok(
    !fixture.startupRooms.at(-1)!.includes(a.id),
    'recovery must finish before runtime construction',
  );
  const state = fixture.host.getSnapshot();
  assert.ok(!state.rooms.some((item) => item.id === a.id));
  assert.ok(!state.tasks.some((item) => item.roomId === a.id));
  assert.ok(!state.automations.some((item) => item.roomId === a.id));
});

test('a saved deletion plan for another room cannot remove or stop that room on retry or startup', async (t) => {
  const fixture = await controlledFixture(t);
  const { f } = fixture;
  const a = await room(f, 'Invalid deletion A');
  const b = await room(f, 'Protected room B');
  const taskB = f.controller.enqueueTask({
    roomId: b.id,
    botId: 'bot_aster',
    prompt: 'Keep working.',
  });
  await until(() => f.store.get<Task>('tasks', taskB.id)?.status === 'running', 'B starts');
  const memory = f.controller.saveMemory({
    roomId: b.id,
    botId: 'bot_aster',
    content: 'Keep room B private data.',
  });
  const planForB = planRoomDeletion(f.store, b.id);
  f.store.put('roomDeletions', {
    id: a.id,
    roomId: a.id,
    startedAt: stamp,
    stoppingTaskIds: [taskB.id],
    plan: planForB,
  });
  f.store.patch<Room>('rooms', a.id, {
    deletion: { status: 'failed', startedAt: stamp },
    paused: true,
  });
  const retry = await f.app.inject({ method: 'DELETE', url: `/api/rooms/${a.id}` });
  assert.equal(retry.statusCode, 409, retry.body);
  assert.ok(!fixture.stopped.includes(taskB.id), 'invalid saved IDs must not stop B');
  assert.ok(f.store.get('rooms', b.id));
  assert.ok(f.store.get('tasks', taskB.id));
  assert.equal(f.store.get<Memory>('memories', memory.id)?.content, memory.content);
  await fixture.restart();
  assert.ok(
    fixture.startupRooms.at(-1)!.includes(b.id),
    'B survives recovery before runtime construction',
  );
  assert.ok(fixture.f.store.get('rooms', b.id));
  assert.ok(fixture.f.store.get('tasks', taskB.id));
  assert.equal(fixture.f.store.get<Memory>('memories', memory.id)?.content, memory.content);
  assert.equal(fixture.f.store.get<Room>('rooms', a.id)?.deletion?.status, 'failed');
  const resume = await fixture.f.app.inject({ method: 'POST', url: `/api/rooms/${a.id}/resume` });
  assert.equal(resume.statusCode, 409, resume.body);
});

test('saved stop-task identifiers are restricted to their original room before a retry', async (t) => {
  const fixture = await controlledFixture(t);
  const { f } = fixture;
  const a = await room(f, 'Stop IDs A');
  const b = await room(f, 'Stop IDs B');
  const taskB = f.controller.enqueueTask({
    roomId: b.id,
    botId: 'bot_aster',
    prompt: 'Keep working.',
  });
  await until(() => f.store.get<Task>('tasks', taskB.id)?.status === 'running', 'B starts');
  f.store.put('roomDeletions', {
    id: a.id,
    roomId: a.id,
    startedAt: stamp,
    stoppingTaskIds: [taskB.id],
  });
  f.store.patch<Room>('rooms', a.id, {
    deletion: { status: 'failed', startedAt: stamp },
    paused: true,
  });
  const retry = await f.app.inject({ method: 'DELETE', url: `/api/rooms/${a.id}` });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(f.store.get('rooms', a.id), undefined);
  assert.ok(f.store.get('rooms', b.id));
  assert.equal(f.store.get<Task>('tasks', taskB.id)?.status, 'running');
  assert.ok(!fixture.stopped.includes(taskB.id));
});

for (const corruption of ['foreign-room-id', 'invalid-stop-list'] as const) {
  test(`an invalid deletion header (${corruption}) keeps only its own room inert during startup`, async (t) => {
    const fixture = await controlledFixture(t);
    const a = await room(fixture.f, 'Corrupted header A');
    const b = await room(fixture.f, 'Unrelated room B');
    fixture.f.store.put('roomDeletions', {
      id: a.id,
      roomId: corruption === 'foreign-room-id' ? b.id : a.id,
      startedAt: stamp,
      stoppingTaskIds: corruption === 'invalid-stop-list' ? 'invalid-saved-list' : [],
    });
    fixture.f.store.patch<Room>('rooms', a.id, {
      deletion: { status: 'deleting', startedAt: stamp },
      paused: true,
    });
    await fixture.restart();
    assert.equal(fixture.f.store.get<Room>('rooms', a.id)?.deletion?.status, 'failed');
    assert.equal(fixture.f.store.get<Room>('rooms', b.id)?.deletion, undefined);
    const response = await fixture.f.app.inject({
      method: 'POST',
      url: `/api/rooms/${b.id}/messages`,
      payload: { body: 'B is still available after recovering A.' },
    });
    assert.equal(response.statusCode, 200, response.body);
  });
}

test('file cleanup failure before child deletion keeps restart and another room available', async (t) => {
  const fixture = await controlledFixture(t);
  const { f } = fixture;
  const a = await room(f, 'Blocked files A');
  const b = await room(f, 'Available B');
  const task = f.controller.enqueueTask({
    roomId: a.id,
    botId: 'bot_aster',
    prompt: 'Legacy saved task.',
  });
  await until(() => f.store.get<Task>('tasks', task.id)?.status === 'running', 'A starts');
  f.store.patch<Task>('tasks', task.id, { workspacePath: undefined });
  const message = f.controller.addMessage({
    roomId: a.id,
    taskId: task.id,
    authorType: 'bot',
    authorId: 'bot_aster',
    body: 'An unfinished historical response.',
    status: 'streaming',
  });
  const botDirectory = join(f.store.dataDir, 'sessions', diskKey('bot_aster'));
  const roomDirectory = join(botDirectory, diskKey(a.id));
  const savedDirectory = `${botDirectory}-saved`;
  await mkdir(roomDirectory, { recursive: true });
  await writeFile(join(roomDirectory, 'fixture.jsonl'), '{"type":"session","id":"fixture"}\n');
  const fence = f.store.fenceRoomDeletion.bind(f.store);
  f.store.fenceRoomDeletion = (roomId, records) => {
    fence(roomId, records);
    // A file-system change after signing the plan makes its parent unsafe,
    // before purge has removed any child rows. This is portable on Windows too.
    renameSync(botDirectory, savedDirectory);
    writeFileSync(botDirectory, 'A parent path is temporarily unavailable.');
    f.store.fenceRoomDeletion = fence;
  };
  const failed = await f.app.inject({ method: 'DELETE', url: `/api/rooms/${a.id}` });
  assert.equal(failed.statusCode, 409, failed.body);
  assert.ok(f.store.get('tasks', task.id), 'the failure occurs before child records are removed');
  assert.ok(f.store.get('messages', message.id));
  await fixture.restart();
  assert.equal(fixture.f.store.get<Room>('rooms', a.id)?.deletion?.status, 'failed');
  assert.ok(fixture.f.store.get('tasks', task.id));
  assert.ok(fixture.f.store.get('messages', message.id));
  const response = await fixture.f.app.inject({
    method: 'POST',
    url: `/api/rooms/${b.id}/messages`,
    payload: { body: 'B continues after the failed cleanup.' },
  });
  assert.equal(response.statusCode, 200, response.body);
  await unlink(botDirectory);
  await rename(savedDirectory, botDirectory);
  const retried = await fixture.f.app.inject({ method: 'DELETE', url: `/api/rooms/${a.id}` });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(fixture.f.store.get('rooms', a.id), undefined);
  assert.equal(fixture.f.store.get('tasks', task.id), undefined);
  assert.ok(fixture.f.store.get('rooms', b.id));
});

test('archived and final rooms can be deleted without removing shared bots or workspace files', async (t) => {
  const fixture = await controlledFixture(t);
  const { f } = fixture;
  const workspace = f.store.settings().workspacePath;
  const artifact = join(workspace, 'keep-project.txt');
  await writeFile(artifact, 'Keep this user project.');
  const archived = await f.app.inject({
    method: 'PATCH',
    url: '/api/rooms/room_lounge',
    payload: { archived: true },
  });
  assert.equal(archived.statusCode, 200, archived.body);
  const deleted = await f.app.inject({ method: 'DELETE', url: '/api/rooms/room_lounge' });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(f.store.list('rooms').length, 0);
  assert.equal(f.store.list('bots').length, 2);
  assert.equal(await readFile(artifact, 'utf8'), 'Keep this user project.');
  await fixture.restart();
  assert.equal(fixture.f.store.list('rooms').length, 0, 'startup must not recreate the final room');
  assert.equal(fixture.f.store.list('bots').length, 2);
  assert.equal(await readFile(artifact, 'utf8'), 'Keep this user project.');
  await room(fixture.f, 'A new start');
  assert.equal(fixture.f.store.list('rooms').length, 1);
});

test('room deletion uses the existing authentication and origin protections', async (t) => {
  const token = 'delete-room-test-auth-token-only';
  const fixture = await controlledFixture(t, token);
  const url = '/api/rooms/room_lounge';
  assert.equal((await fixture.f.app.inject({ method: 'DELETE', url })).statusCode, 401);
  assert.equal(
    (
      await fixture.f.app.inject({
        method: 'DELETE',
        url,
        headers: { authorization: `Bearer ${token}`, origin: 'https://foreign.example.test' },
      })
    ).statusCode,
    403,
  );
  assert.ok(fixture.f.store.get('rooms', 'room_lounge'));
  const allowed = await fixture.f.app.inject({
    method: 'DELETE',
    url,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(allowed.statusCode, 200, allowed.body);
});

for (const removeRuleBeforeStop of [false, true]) {
  test(
    removeRuleBeforeStop
      ? 'room scheduler shutdown retains ownership of a poll whose automation was removed'
      : 'room scheduler shutdown aborts only matching polls and fences their future admissions',
    { timeout: 15000 },
    async (t) => {
      const fixture = await controlledFixture(t);
      const { f } = fixture;
      const a = await room(f, 'Polling A');
      const b = await room(f, 'Polling B');
      const rules: Automation[] = [];
      for (const target of [a, b]) {
        const response = await f.app.inject({
          method: 'POST',
          url: '/api/automations',
          payload: {
            name: target.name,
            kind: 'url_watch',
            roomId: target.id,
            botId: 'bot_aster',
            prompt: 'Report changes.',
            sourceUrl: `https://example.test/${target.id}`,
          },
        });
        assert.equal(response.statusCode, 200, response.body);
        rules.push(response.json<Automation>());
      }
      const held = new Map<string, { signal: AbortSignal; complete: () => void }>();
      const scheduler = createScheduler(
        {
          store: f.store,
          enqueueTask: f.controller.enqueueTask,
          notify: f.controller.notify,
          changed: f.controller.changed,
        },
        {
          fetchText: (url, options) =>
            new Promise((resolve, reject) => {
              const signal = options?.signal;
              assert.ok(signal);
              signal.addEventListener('abort', () => reject(new Error('poll aborted')), {
                once: true,
              });
              held.set(url, {
                signal,
                complete: () =>
                  resolve({ url, status: 200, contentType: 'text/plain', text: 'A baseline.' }),
              });
            }),
        },
      );
      try {
        const first = scheduler.run(rules[0].id);
        const firstStopped = assert.rejects(first, /aborted/);
        const second = scheduler.run(rules[1].id);
        void second.catch(() => {});
        await until(() => held.size === 2, 'both room polls start');
        if (removeRuleBeforeStop) f.store.remove('automations', rules[0].id);
        await scheduler.stopRoom(a.id);
        await firstStopped;
        assert.equal(held.get(rules[0].sourceUrl)!.signal.aborted, true);
        assert.equal(held.get(rules[1].sourceUrl)!.signal.aborted, false);
        await assert.rejects(scheduler.run(rules[0].id));
        f.store.remove('automations', rules[0].id);
        f.store.remove('automationState', rules[0].id);
        held.get(rules[0].sourceUrl)!.complete();
        held.get(rules[1].sourceUrl)!.complete();
        await second;
        assert.equal(f.store.get('automationState', rules[0].id), undefined);
        assert.ok(f.store.get('automationState', rules[1].id));
        assert.ok(
          !f.store.list<{ roomId?: string }>('notifications').some((item) => item.roomId === a.id),
        );
        assert.ok(!f.store.list<Task>('tasks').some((item) => item.roomId === a.id));
        assert.equal(fixture.shutdowns, 0);
      } finally {
        await scheduler.stop();
      }
    },
  );
}

interface HeldStream {
  marker: string;
  response: ServerResponse;
  closed: boolean;
  complete(output?: string): void;
  tool(name: string, args: Record<string, unknown>): void;
}

async function streamingFixture(t: TestContext, autoLearn = false) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-delete-real-runtime-'));
  const streams: HeldStream[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const marker = body.messages
      .filter((message) => message.role === 'user')
      .flatMap((message) => [...JSON.stringify(message.content).matchAll(/DELETE_[A-Z_]+/g)])
      .at(-1)?.[0];
    assert.ok(marker, 'every fixture request has its task marker');
    const index = streams.length;
    const send = (delta: object, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: `delete-${index}`, object: 'chat.completion.chunk', model: 'delete-fixture', created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const stream: HeldStream = {
      marker,
      response,
      closed: false,
      complete(output) {
        assert.equal(stream.closed, false);
        send({ content: output ?? `done-${marker}` }, 'stop');
        response.end('data: [DONE]\n\n');
      },
      tool(name, args) {
        send(
          {
            tool_calls: [
              {
                index: 0,
                id: `delete-call-${index}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          'tool_calls',
        );
        response.end('data: [DONE]\n\n');
      },
    };
    response.once('close', () => {
      stream.closed = true;
    });
    streams.push(stream);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    send({ role: 'assistant', content: `partial-${marker} ` });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const f = await createApp({ dataDir: join(directory, 'data'), scheduler: false });
  t.after(async () => {
    await f.app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const configured = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      model: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'delete-fixture',
        contextWindow: 65536,
        maxOutputTokens: 1024,
      },
      inference: { maxConcurrentRequests: 2 },
      autoLearn,
    },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  return {
    f,
    streams,
    async stream(marker: string, count = 1) {
      await until(
        () => streams.filter((item) => item.marker === marker).length >= count,
        `${marker} request ${count}`,
      );
      return streams.filter((item) => item.marker === marker)[count - 1];
    },
  };
}

test(
  'real Pi deletion aborts only its room, cancels queued learning, and removes only its session',
  { timeout: 30000 },
  async (t) => {
    const { f, streams, stream } = await streamingFixture(t);
    const a = await room(f, 'Runtime A');
    const b = await room(f, 'Runtime B');
    const taskA = f.controller.enqueueTask({
      roomId: a.id,
      botId: 'bot_aster',
      prompt: 'DELETE_RUNNING_A',
    });
    const taskB = f.controller.enqueueTask({
      roomId: b.id,
      botId: 'bot_aster',
      prompt: 'DELETE_RUNNING_B',
    });
    const [requestA, requestB] = await Promise.all([
      stream('DELETE_RUNNING_A'),
      stream('DELETE_RUNNING_B'),
    ]);
    const queued = f.controller.enqueueTask({
      roomId: a.id,
      botId: 'bot_aster',
      kind: 'learning',
      prompt: 'DELETE_QUEUED_LEARNING',
    });
    await until(
      () =>
        f.controller.getSnapshot().queue.waitingTasks?.some((item) => item.taskId === queued.id) ===
        true,
      'learning queues behind A',
    );
    const sessionA = join(f.store.dataDir, 'sessions', diskKey('bot_aster'), diskKey(a.id));
    const sessionB = join(f.store.dataDir, 'sessions', diskKey('bot_aster'), diskKey(b.id));
    assert.ok(existsSync(sessionA));
    assert.ok(existsSync(sessionB));
    const deleted = await f.app.inject({ method: 'DELETE', url: `/api/rooms/${a.id}` });
    assert.equal(deleted.statusCode, 200, deleted.body);
    await until(() => requestA.closed, 'A stream is aborted');
    assert.equal(requestB.closed, false, 'the same bot in B keeps its live model stream');
    assert.equal(f.store.get('tasks', taskA.id), undefined);
    assert.equal(f.store.get('tasks', queued.id), undefined);
    assert.ok(!streams.some((item) => item.marker === 'DELETE_QUEUED_LEARNING'));
    assert.equal(existsSync(sessionA), false);
    assert.equal(existsSync(sessionB), true);
    requestB.complete();
    await until(
      () => f.store.get<Task>('tasks', taskB.id)?.status === 'completed',
      'B completes normally',
    );
    assert.match(f.store.get<Task>('tasks', taskB.id)!.output, /done-DELETE_RUNNING_B/);
    const state = (await f.app.inject({ url: '/api/state' })).json<Snapshot>();
    assert.ok(!state.rooms.some((item) => item.id === a.id));
    assert.ok(!state.messages.some((item) => item.roomId === a.id));
    assert.ok(state.messages.some((item) => item.roomId === b.id));
  },
);

test(
  'deleting a real approval-waiting room cancels its approval and never performs the tool',
  { timeout: 30000 },
  async (t) => {
    const { f, stream } = await streamingFixture(t);
    const a = await room(f, 'Approval A');
    const workspace = f.store.settings().workspacePath;
    const task = f.controller.enqueueTask({
      roomId: a.id,
      botId: 'bot_aster',
      prompt: 'DELETE_APPROVAL_A',
    });
    const request = await stream('DELETE_APPROVAL_A');
    request.tool('write_file', { path: 'must-not-exist.txt', content: 'Unapproved write.' });
    await until(
      () =>
        f.store
          .list<Approval>('approvals')
          .some((item) => item.taskId === task.id && item.status === 'pending'),
      'tool awaits owner approval',
    );
    const approval = f.store.list<Approval>('approvals').find((item) => item.taskId === task.id)!;
    const deleted = await f.app.inject({ method: 'DELETE', url: `/api/rooms/${a.id}` });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(f.store.get('approvals', approval.id), undefined);
    assert.equal(existsSync(join(workspace, 'must-not-exist.txt')), false);
    const staleApproval = await f.app.inject({
      method: 'POST',
      url: `/api/approvals/${approval.id}`,
      payload: { decision: 'approve' },
    });
    assert.equal(staleApproval.statusCode, 404, staleApproval.body);
  },
);

test(
  'deletion drains automatically created learning without leaving its private session or new memory',
  { timeout: 30000 },
  async (t) => {
    const { f, stream } = await streamingFixture(t, true);
    const a = await room(f, 'Automatic learning');
    const marker = 'DELETE_LEARNING_SOURCE';
    const source = f.controller.enqueueTask({ roomId: a.id, botId: 'bot_aster', prompt: marker });
    (await stream(marker)).tool('room_context', { limit: 8 });
    (await stream(marker, 2)).tool('room_context', { limit: 9 });
    (await stream(marker, 3)).complete('The requested review is complete. '.repeat(8));
    const learningRequest = await stream(marker, 4);
    const learning = f.store
      .list<Task>('tasks')
      .find((task) => task.kind === 'learning' && task.parentTaskId === source.id);
    assert.ok(learning, 'the runtime automatically enqueued a learning review');
    const learningSession = join(f.store.dataDir, 'sessions', 'learning', diskKey(learning.id));
    assert.ok(existsSync(learningSession));
    const deleted = await f.app.inject({ method: 'DELETE', url: `/api/rooms/${a.id}` });
    assert.equal(deleted.statusCode, 200, deleted.body);
    await until(() => learningRequest.closed, 'learning stream closes');
    assert.equal(existsSync(learningSession), false);
    assert.ok(!f.store.list<Task>('tasks').some((task) => task.roomId === a.id));
    assert.ok(!f.store.list<Memory>('memories').some((memory) => memory.roomId === a.id));
  },
);
