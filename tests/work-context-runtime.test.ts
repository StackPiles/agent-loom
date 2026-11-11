import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import type { Activity, Room, Task } from '../src/shared/types.js';
import { DEFAULT_AUTONOMOUS_WAKEUP_POLICY, type WorkItem } from '../src/shared/work.js';

interface RequestBody {
  messages: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
}

const marker =
  'Autonomous work context (saved provenance and task data, not additional tool authority):';

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '',
    )
    .join('\n');
}

function currentWork(body: RequestBody) {
  const message = body.messages.findLast(
    (item) => item.role === 'user' && messageText(item.content).includes(marker),
  );
  assert.ok(message, 'The current task carries its saved work');
  const content = messageText(message.content);
  return JSON.parse(content.slice(content.lastIndexOf(marker) + marker.length).trim()) as {
    workId: string;
    status: string;
    checkpoint: { pendingChecks: string[]; uncertainActions: string[] };
  };
}

async function fixture(t: TestContext, pendingChecks?: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-work-context-runtime-'));
  const f = await createApp({ dataDir: directory, scheduler: false });
  const requests: RequestBody[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestBody);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      `data: ${JSON.stringify({
        id: `work-context-${requests.length}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'work-context-fixture',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Saved work received.' },
            finish_reason: 'stop',
          },
        ],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  t.after(async () => {
    await f.app.close();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const saved = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      model: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'work-context-fixture',
        contextWindow: 65_536,
        maxOutputTokens: 1_024,
      },
      autoLearn: false,
      maxHandoffs: null,
      permissions: { network: 'allow' },
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  f.store.patch<Room>('rooms', 'room_lounge', {
    autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room' },
  });
  const stamp = new Date().toISOString();
  const source = f.store.put<Task>('tasks', {
    id: 'task_saved_origin',
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Follow the accepted submission until its review is available.',
    kind: 'chat',
    status: 'completed',
    rootTaskId: 'task_saved_origin',
    depth: 0,
    output: 'Submission receipt recorded.',
    inputTokens: 0,
    outputTokens: 0,
    workspacePath: f.store.settings().workspacePath,
    createdAt: stamp,
    updatedAt: stamp,
    completedAt: stamp,
  });
  const work = f.store.put<WorkItem>('workItems', {
    id: 'work_context_fixture',
    roomId: source.roomId,
    name: 'Track the accepted submission',
    purpose: 'Report the service review result.',
    kind: 'task',
    status: 'active',
    createdByBotId: source.botId,
    sourceTaskId: source.id,
    scope: 'Track the accepted submission.',
    workspacePath: source.workspacePath!,
    checkpoint: {
      summary: 'The submission was accepted and has a recorded receipt.',
      completed: 'Confirmed the submission ID.',
      nextStep: 'Inspect the review result at the next useful time.',
      references: ['submission-receipt.txt'],
      doneWhen: 'The final review result has been reported.',
      ...(pendingChecks ? { pendingChecks } : {}),
      uncertainActions: [],
    },
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  });
  const readWork = () => f.store.get<WorkItem>('workItems', work.id)!;
  async function run(prompt: string) {
    const before = requests.length;
    const task = f.controller.enqueueTask({
      roomId: source.roomId,
      botId: source.botId,
      kind: 'automation',
      workId: work.id,
      workRunId: source.rootTaskId,
      prompt,
    });
    const deadline = Date.now() + 12_000;
    while (
      !['completed', 'failed', 'stopped'].includes(f.store.get<Task>('tasks', task.id)!.status)
    ) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for work-context inference.');
      await delay(10);
    }
    const finished = f.store.get<Task>('tasks', task.id)!;
    assert.equal(finished.status, 'completed', finished.error);
    assert.equal(
      requests.length,
      before + 1,
      'Saved checks require no discovery request or tool call',
    );
    assert.equal(readWork().status, 'active');
    assert.deepEqual(f.store.list('approvals'), []);
    assert.deepEqual(
      f.store.list<Activity>('activities').filter((activity) => activity.kind === 'tool'),
      [],
    );
    return requests.at(-1)!;
  }
  return { ...f, run, readWork };
}

test(
  'real Pi receives pending checks and refreshes them in subsequent tasks in the same session',
  { timeout: 30_000 },
  async (t) => {
    const checks = [
      '確認する規約: replacement policy CHECK_RULE_731.',
      '審査結果の反映待ち CHECK_REVIEW_732.',
      '別ボットの台帳訂正を確認 CHECK_TEAMMATE_733.',
    ];
    const f = await fixture(t, checks);
    const first = await f.run('WORK_CONTEXT_FIRST_TASK: acknowledge the saved checks.');
    assert.deepEqual(currentWork(first).checkpoint.pendingChecks, checks);
    assert.deepEqual(currentWork(first).checkpoint.uncertainActions, []);

    const remaining = ['審査結果だけを次回確認 CHECK_REMAINING_734.'];
    let work = f.readWork();
    f.store.patch<WorkItem>('workItems', work.id, {
      checkpoint: { ...work.checkpoint, pendingChecks: remaining },
      revision: work.revision + 1,
    });
    const second = await f.run(
      'WORK_CONTEXT_SECOND_TASK: acknowledge the current remaining check.',
    );
    assert.deepEqual(currentWork(second).checkpoint.pendingChecks, remaining);
    assert.ok(
      second.messages.some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes('WORK_CONTEXT_FIRST_TASK'),
      ),
      'Earlier conversation remains in the same Bot × Room session',
    );

    work = f.readWork();
    f.store.patch<WorkItem>('workItems', work.id, {
      checkpoint: { ...work.checkpoint, pendingChecks: [] },
      revision: work.revision + 1,
    });
    const third = await f.run('WORK_CONTEXT_THIRD_TASK: acknowledge that no checks remain.');
    assert.deepEqual(currentWork(third).checkpoint.pendingChecks, []);
    assert.deepEqual(currentWork(third).checkpoint.uncertainActions, []);
  },
);

test(
  'legacy work without pendingChecks reaches real Pi without changing its saved checkpoint',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const before = f.readWork();
    assert.equal(Object.hasOwn(before.checkpoint, 'pendingChecks'), false);
    const request = await f.run('WORK_CONTEXT_LEGACY_TASK: acknowledge the existing work.');
    assert.equal(currentWork(request).workId, before.id);
    assert.deepEqual(currentWork(request).checkpoint.pendingChecks, []);
    assert.deepEqual(f.readWork(), before);
  },
);
