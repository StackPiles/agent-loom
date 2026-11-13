import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../src/server/app.js';
import type { Approval, Room, Task } from '../src/shared/types.js';

async function until(
  check: () => boolean,
  label: string,
  options: { timeoutMs?: number; diagnostics?: () => unknown } = {},
): Promise<void> {
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? 15_000);
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out after ${Date.now() - started}ms: ${label}` +
          (options.diagnostics ? `\n${JSON.stringify(options.diagnostics(), null, 2)}` : ''),
      );
    await delay(10);
  }
}

test(
  'sixteen approval waiters lend a worker to urgent work without approving or replaying their tools',
  { timeout: 120_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'loom-approval-scheduling-'));
    let requestCount = 0;
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      const payload = JSON.parse(raw) as { messages: Array<{ role: string; content?: unknown }> };
      const latestUser = JSON.stringify(
        payload.messages.findLast((message) => message.role === 'user')?.content ?? '',
      );
      const index = /APPROVAL_WAIT_(\d+)/.exec(latestUser)?.[1];
      const needsApproval = index !== undefined && payload.messages.at(-1)?.role !== 'tool';
      const base = {
        id: `approval-fixture-${++requestCount}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'approval-fixture',
      };
      const send = (delta: object, finish: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (needsApproval) {
        send({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `write-${index}`,
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: `approval-${index}.txt`,
                  content: 'Explicitly approved.',
                }),
              },
            },
          ],
        });
        send({}, 'tool_calls');
      } else {
        send({
          role: 'assistant',
          content: index === undefined ? 'Urgent response completed.' : 'Approved file saved.',
        });
        send({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const instance = await createApp({ dataDir: join(directory, 'data'), scheduler: false });
    t.after(async () => {
      await instance.app.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    const configured = await instance.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        model: { baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'approval-fixture' },
        inference: { maxConcurrentRequests: 4 },
        permissions: { fileWrite: 'ask', shell: 'ask', network: 'allow' },
        autoLearn: false,
      },
    });
    assert.equal(configured.statusCode, 200, configured.body);
    const template = instance.store.get<Room>('rooms', 'room_lounge')!;
    const rooms = Array.from({ length: 17 }, (_, index) => ({
      ...template,
      id: `approval-room-${index}`,
      name: `Approval room ${index}`,
    }));
    for (const room of rooms) instance.store.put('rooms', room);
    instance.controller.changed();
    const tasks = rooms.slice(0, 16).map((room, index) =>
      instance.controller.enqueueTask({
        roomId: room.id,
        botId: 'bot_aster',
        prompt: `APPROVAL_WAIT_${index}: write the requested file after approval.`,
      }),
    );
    for (const task of tasks) instance.controller.prioritizeTask(task.id);
    const diagnostics = (watchedTasks = tasks) => ({
      requestCount,
      pendingApprovals: instance.store
        .list<Approval>('approvals')
        .filter((approval) => approval.status === 'pending').length,
      queue: instance.controller.runtime?.queueState(),
      tasks: watchedTasks.map((task) => {
        const current = instance.store.get<Task>('tasks', task.id);
        return { id: task.id, status: current?.status, error: current?.error };
      }),
    });
    await until(
      () =>
        tasks.every(
          (task) => instance.store.get<Task>('tasks', task.id)?.status === 'awaiting_approval',
        ),
      'sixteen independent tasks await approval',
      // Starting sixteen real Pi sessions competes with the rest of the suite
      // on shared CI runners. Only fixture setup gets extra time; worker lending
      // and approved-tool resumption retain their 15-second deadlines below.
      { timeoutMs: 60_000, diagnostics },
    );
    assert.equal(
      instance.store.list<Approval>('approvals').filter((approval) => approval.status === 'pending')
        .length,
      16,
    );
    assert.equal(instance.controller.runtime?.queueState().active, 0);
    const urgent = instance.controller.enqueueTask({
      roomId: rooms[16].id,
      botId: 'bot_aster',
      prompt: 'URGENT_READY: give the requested answer now.',
    });
    const grant = instance.controller.prioritizeTask(urgent.id).grant!;
    await until(
      () => instance.store.get<Task>('tasks', urgent.id)?.status === 'completed',
      'urgent work gets a worker while approvals remain pending',
      { diagnostics: () => diagnostics([...tasks, urgent]) },
    );
    assert.ok(
      (instance.controller.getTaskScheduling(urgent.id).grant?.remainingRequests ?? 0) >= 2,
    );
    assert.equal(
      instance.store.get<Task>('tasks', urgent.id)?.output,
      'Urgent response completed.',
    );
    assert.equal(
      instance.store.list<Approval>('approvals').filter((approval) => approval.status === 'pending')
        .length,
      16,
    );
    const workspace = instance.controller.roomWorkspacePath(rooms[0].id);
    assert.deepEqual(
      (await readdir(workspace)).filter((name) => name.startsWith('approval-')),
      [],
    );
    const firstApproval = instance.store
      .list<Approval>('approvals')
      .find((approval) => approval.taskId === tasks[0].id)!;
    instance.controller.decideApproval(firstApproval.id, true);
    await until(
      () => instance.store.get<Task>('tasks', tasks[0].id)?.status === 'completed',
      'approved task resumes exactly once',
      { diagnostics: () => diagnostics([...tasks, urgent]) },
    );
    assert.equal(await readFile(join(workspace, 'approval-0.txt'), 'utf8'), 'Explicitly approved.');
    assert.equal(
      instance.store.list<Approval>('approvals').filter((approval) => approval.status === 'pending')
        .length,
      15,
    );
    assert.equal(instance.controller.getTaskScheduling(urgent.id).grant?.id, grant.id);
  },
);
