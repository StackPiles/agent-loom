import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import type { Room, Task } from '../src/shared/types.js';

const idleRuntime = () => ({
  start() {},
  async stop() {},
  async shutdown() {},
  queueState: () => ({ active: 0, waiting: 0 }),
});

async function fixture(t: TestContext, realRuntime = false) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-room-workspace-'));
  const instance = await createApp({
    dataDir: join(directory, 'data'),
    scheduler: false,
    ...(realRuntime ? {} : { runtimeFactory: idleRuntime }),
  });
  t.after(async () => {
    await instance.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  if (!realRuntime)
    instance.store.put('settings', { ...instance.store.settings(), id: 'main', demoMode: true });
  const room = async (name: string, workspacePath?: string | null) => {
    const response = await instance.app.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: { name, botIds: ['bot_aster', 'bot_nova'], workspacePath },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<Room>();
  };
  return { ...instance, directory, room };
}

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

test('rooms save independent absolute roots and clear overrides without changing other rooms', async (t) => {
  const f = await fixture(t);
  const first = await f.room('First', join(f.directory, 'first', '..', 'first'));
  const second = await f.room('Second', join(f.directory, '資料 folder'));
  const inherited = await f.room('Default');
  assert.equal(first.workspacePath, resolve(f.directory, 'first'));
  assert.equal(f.controller.roomWorkspacePath(second.id), resolve(f.directory, '資料 folder'));
  assert.equal(inherited.workspacePath, undefined);
  assert.equal(f.controller.roomWorkspacePath(inherited.id), f.store.settings().workspacePath);
  if (process.platform !== 'win32') {
    const trailing = await f.room('Literal space', join(f.directory, 'folder '));
    assert.equal(trailing.workspacePath, join(f.directory, 'folder '));
    assert.ok(existsSync(join(f.directory, 'folder ')));
    assert.equal(existsSync(join(f.directory, 'folder')), false);
  }
  const changed = await f.app.inject({
    method: 'PATCH',
    url: `/api/rooms/${first.id}`,
    payload: { workspacePath: join(f.directory, 'replacement') },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(f.store.get<Room>('rooms', second.id)?.workspacePath, second.workspacePath);
  const cleared = await f.app.inject({
    method: 'PATCH',
    url: `/api/rooms/${first.id}`,
    payload: { workspacePath: null },
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json<Room>().workspacePath, undefined);
  assert.equal(f.controller.roomWorkspacePath(first.id), f.store.settings().workspacePath);
  const file = join(f.directory, 'not-a-folder.txt');
  await writeFile(file, 'preserve this file');
  for (const workspacePath of ['', 'bad\0path', file]) {
    const invalid = await f.app.inject({
      method: 'PATCH',
      url: `/api/rooms/${first.id}`,
      payload: { workspacePath },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
  assert.equal(await readFile(file, 'utf8'), 'preserve this file');
});

test('active work blocks only affected folder changes and never creates a rejected destination', async (t) => {
  const f = await fixture(t);
  const first = await f.room('Busy', join(f.directory, 'busy'));
  const second = await f.room('Idle', join(f.directory, 'idle'));
  const task = f.controller.enqueueTask({ roomId: first.id, botId: 'bot_aster', prompt: 'Hold' });
  const rejectedPath = join(f.directory, 'must-not-be-created');
  const rejected = await f.app.inject({
    method: 'PATCH',
    url: `/api/rooms/${first.id}`,
    payload: { workspacePath: rejectedPath },
  });
  assert.equal(rejected.statusCode, 409);
  assert.equal(existsSync(rejectedPath), false);
  const unchanged = await f.app.inject({
    method: 'PATCH',
    url: `/api/rooms/${first.id}`,
    payload: {
      workspacePath: join(first.workspacePath!, '.'),
      name: 'Renamed while busy',
      botIds: first.botIds,
    },
  });
  assert.equal(unchanged.statusCode, 200, unchanged.body);
  const changedMembers = await f.app.inject({
    method: 'PATCH',
    url: `/api/rooms/${first.id}`,
    payload: { botIds: ['bot_aster'] },
  });
  assert.equal(changedMembers.statusCode, 409);
  const other = await f.app.inject({
    method: 'PATCH',
    url: `/api/rooms/${second.id}`,
    payload: { workspacePath: join(f.directory, 'other-folder') },
  });
  assert.equal(other.statusCode, 200, other.body);
  const defaultChanged = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { workspacePath: join(f.directory, 'new-default') },
  });
  assert.equal(defaultChanged.statusCode, 200, defaultChanged.body);
  assert.equal(f.store.get<Task>('tasks', task.id)?.workspacePath, first.workspacePath);
  const inheritedTask = f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Hold',
  });
  const blockedDefault = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { workspacePath: rejectedPath },
  });
  assert.equal(blockedDefault.statusCode, 409);
  assert.equal(existsSync(rejectedPath), false);
  assert.equal(
    f.store.get<Task>('tasks', inheritedTask.id)?.workspacePath,
    resolve(f.directory, 'new-default'),
  );
});

test('admission pins room roots for queued work, handoffs, learning and automation tasks', async (t) => {
  const f = await fixture(t);
  const room = await f.room('Project', join(f.directory, 'project'));
  const root = f.controller.enqueueTask({ roomId: room.id, botId: 'bot_aster', prompt: 'Start' });
  const handoff = f.controller.enqueueTask({
    roomId: room.id,
    botId: 'bot_nova',
    prompt: 'Review',
    parentTaskId: root.id,
  });
  const learning = f.controller.enqueueTask({
    roomId: room.id,
    botId: 'bot_aster',
    prompt: 'Learn',
    kind: 'learning',
    parentTaskId: root.id,
  });
  const automation = f.controller.enqueueTask({
    roomId: room.id,
    botId: 'bot_aster',
    prompt: 'Watch',
    kind: 'automation',
  });
  for (const task of [root, handoff, learning, automation])
    assert.equal(task.workspacePath, room.workspacePath);
  assert.equal(handoff.rootTaskId, root.id);
  assert.equal(learning.rootTaskId, root.id);
  assert.notEqual(automation.rootTaskId, root.id);
});

test('resume requires the original folder and new tasks adopt a changed room folder', async (t) => {
  const f = await fixture(t);
  const room = await f.room('Project', join(f.directory, 'original'));
  const task = f.controller.enqueueTask({ roomId: room.id, botId: 'bot_aster', prompt: 'Write' });
  await f.controller.stop(task.id);
  const changed = await f.app.inject({
    method: 'PATCH',
    url: `/api/rooms/${room.id}`,
    payload: { workspacePath: join(f.directory, 'next') },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  const resumed = await f.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/resume` });
  assert.equal(resumed.statusCode, 409);
  assert.match(resumed.json().error, /original folder|new message/);
  assert.equal(f.store.get<Task>('tasks', task.id)?.workspacePath, room.workspacePath);
  const fresh = f.controller.enqueueTask({
    roomId: room.id,
    botId: 'bot_aster',
    prompt: 'New write',
  });
  assert.equal(fresh.workspacePath, resolve(f.directory, 'next'));
  await f.controller.stop(fresh.id);
  await f.app.inject({
    method: 'PATCH',
    url: `/api/rooms/${room.id}`,
    payload: { workspacePath: room.workspacePath },
  });
  const restored = await f.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/resume` });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json<Task>().workspacePath, room.workspacePath);
});

test('legacy tasks are bound before folder changes and retain that root after restart', async (t) => {
  const f = await fixture(t);
  const originalDefault = f.store.settings().workspacePath;
  const task = f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Legacy work',
  });
  await f.controller.stop(task.id);
  f.store.patch<Task>('tasks', task.id, { workspacePath: undefined });
  const changed = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { workspacePath: join(f.directory, 'new-default') },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(f.store.get<Task>('tasks', task.id)?.workspacePath, originalDefault);
  await f.app.close();
  const reopened = await createApp({
    dataDir: f.store.dataDir,
    scheduler: false,
    runtimeFactory: idleRuntime,
  });
  try {
    assert.equal(reopened.store.get<Task>('tasks', task.id)?.workspacePath, originalDefault);
    const resumed = await reopened.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/resume`,
    });
    assert.equal(resumed.statusCode, 409);
    assert.equal(
      reopened.controller.roomWorkspacePath('room_lounge'),
      resolve(f.directory, 'new-default'),
    );
  } finally {
    await reopened.app.close();
  }
});

test(
  'real Pi writes identical relative paths in separate rooms and continues only matching-folder sessions',
  { timeout: 25_000 },
  async (t) => {
    const requests: Array<{
      marker: string;
      messages: Array<{ role: string; content?: unknown }>;
    }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const messages = body.messages as Array<{ role: string; content?: unknown }>;
      const newestUser = messages.findLast((message) => message.role === 'user');
      const marker = JSON.stringify(newestUser?.content).match(/WRITE_([ABCD])/)?.[1] ?? 'unknown';
      requests.push({ marker, messages });
      const toolResult = messages.at(-1)?.role === 'tool';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = toolResult
        ? { content: `Completed folder ${marker}.` }
        : {
            tool_calls: [
              {
                index: 0,
                id: `call-${marker}`,
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'shared.md', content: `Folder ${marker}` }),
                },
              },
            ],
          };
      for (const choice of [
        { index: 0, delta, finish_reason: null },
        { index: 0, delta: {}, finish_reason: toolResult ? 'stop' : 'tool_calls' },
      ])
        response.write(
          `data: ${JSON.stringify({ id: `response-${marker}`, object: 'chat.completion.chunk', created: 1, model: 'workspace-fixture', choices: [choice] })}\n\n`,
        );
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const f = await fixture(t, true);
    const first = await f.room('First', join(f.directory, 'first'));
    const second = await f.room('Second', join(f.directory, 'second'));
    const configured = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        model: { baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'workspace-fixture' },
        autoLearn: false,
        permissions: { fileWrite: 'ask' },
      },
    });
    assert.equal(configured.statusCode, 200, configured.body);
    const start = (roomId: string, marker: string) =>
      f.controller.enqueueTask({ roomId, botId: 'bot_aster', prompt: `WRITE_${marker}` });
    const approve = async (task: Task, expectedRoot: string) => {
      await until(
        () =>
          f.controller
            .getSnapshot()
            .approvals.some((a) => a.taskId === task.id && a.status === 'pending'),
        `approval ${task.prompt}`,
      );
      const approval = f.controller
        .getSnapshot()
        .approvals.find((a) => a.taskId === task.id && a.status === 'pending')!;
      assert.equal(approval.target, join(expectedRoot, 'shared.md'));
      f.controller.decideApproval(approval.id, true);
      await until(
        () => ['completed', 'failed'].includes(f.store.get<Task>('tasks', task.id)!.status),
        `completion ${task.prompt}`,
      );
      const done = f.store.get<Task>('tasks', task.id)!;
      assert.equal(done.status, 'completed', done.error);
    };
    const a = start(first.id, 'A');
    const b = start(second.id, 'B');
    await Promise.all([approve(a, first.workspacePath!), approve(b, second.workspacePath!)]);
    assert.equal(await readFile(join(first.workspacePath!, 'shared.md'), 'utf8'), 'Folder A');
    assert.equal(await readFile(join(second.workspacePath!, 'shared.md'), 'utf8'), 'Folder B');
    assert.equal(existsSync(join(f.store.settings().workspacePath, 'shared.md')), false);
    for (const [marker, root] of [
      ['A', first.workspacePath!],
      ['B', second.workspacePath!],
    ])
      assert.ok(
        requests
          .filter((r) => r.marker === marker)
          .every((r) => String(r.messages[0].content).includes(root)),
      );

    const thirdRoot = join(f.directory, 'third');
    assert.equal(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `/api/rooms/${first.id}`,
          payload: { workspacePath: thirdRoot },
        })
      ).statusCode,
      200,
    );
    const c = start(first.id, 'C');
    await approve(c, thirdRoot);
    assert.ok(
      requests
        .filter((r) => r.marker === 'C')
        .every(
          (r) =>
            !JSON.stringify(r.messages.filter((m) => m.role === 'assistant')).includes(
              'Completed folder A.',
            ),
        ),
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `/api/rooms/${first.id}`,
          payload: { workspacePath: first.workspacePath },
        })
      ).statusCode,
      200,
    );
    const d = start(first.id, 'D');
    await approve(d, first.workspacePath!);
    assert.ok(
      requests.some(
        (r) =>
          r.marker === 'D' &&
          JSON.stringify(r.messages.filter((m) => m.role === 'assistant')).includes(
            'Completed folder A.',
          ),
      ),
    );
    assert.ok(
      requests
        .filter((r) => r.marker === 'D')
        .every(
          (r) =>
            !JSON.stringify(r.messages.filter((m) => m.role === 'assistant')).includes(
              'Completed folder C.',
            ),
        ),
    );
    assert.equal(await readFile(join(first.workspacePath!, 'shared.md'), 'utf8'), 'Folder D');
    assert.equal(await readFile(join(thirdRoot, 'shared.md'), 'utf8'), 'Folder C');
  },
);
