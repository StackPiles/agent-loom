import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../src/server/app.js';
import type { Room, Task } from '../src/shared/types.js';

test(
  'one bot keeps raw history and newly learned context in its own room when both rooms use one workspace',
  { timeout: 20_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'loom-runtime-room-isolation-'));
    const f = await createApp({ dataDir: directory, scheduler: false });
    const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
    const memoryMarker = 'ROOM_A_MEMORY_1712';
    const skillMarker = 'ROOM_A_SKILL_2743';
    const rawMarkerA = 'ROOM_A_PRIVATE_7019';
    const rawMarkerB = 'ROOM_B_PRIVATE_3892';
    const replyMarkerA = 'ROOM_A_REPLY_5413';
    const calls = [
      {
        name: 'save_memory',
        args: {
          content: `${memoryMarker}: This project’s meeting is at 17:12.`,
          reason: 'Keep the project-specific meeting time.',
          evidence: 'The owner stated this fact in the current room.',
        },
      },
      {
        name: 'propose_skill',
        args: {
          name: 'Room A meeting procedure',
          description: `${skillMarker}: Prepare the agenda for this project.`,
          content: 'Prepare this project’s agenda before its 17:12 meeting.',
          reason: 'Retain the observed project workflow.',
          evidence: 'The owner requested this workflow in the current room.',
        },
      },
    ];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const step = requests.length;
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const call = calls[step];
      const delta = call
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `room_scope_call_${step}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          }
        : { role: 'assistant', content: step === 2 ? replyMarkerA : `Completed request ${step}.` };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        `data: ${JSON.stringify({
          id: `room-scope-${step}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'room-scope-fixture',
          choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    t.after(async () => {
      await f.app.close();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      autoLearn: false,
      model: {
        ...f.store.settings().model,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'room-scope-fixture',
        contextWindow: 65_536,
        maxOutputTokens: 1_024,
      },
    });
    f.store.put('rooms', {
      ...f.store.get<Room>('rooms', 'room_lounge')!,
      id: 'room_b',
      name: 'Project B',
    });
    async function run(roomId: string, prompt: string) {
      const task = f.controller.enqueueTask({ roomId, botId: 'bot_aster', prompt });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const current = f.store.get<Task>('tasks', task.id)!;
        if (['completed', 'failed', 'interrupted', 'stopped'].includes(current.status)) {
          assert.equal(current.status, 'completed', current.error);
          return requests.at(-1)!;
        }
        if (Date.now() > deadline) throw new Error('The room isolation task did not finish.');
        await delay(10);
      }
    }
    await run('room_lounge', `${rawMarkerA}: Remember this project’s meeting and its procedure.`);
    assert.equal(requests.length, 3, 'the source room saved both records through real model tools');
    const requestB = JSON.stringify(await run('room_b', `${rawMarkerB}: Discuss only project B.`));
    for (const marker of [rawMarkerA, replyMarkerA, memoryMarker, skillMarker])
      assert.ok(!requestB.includes(marker), `room B must not receive ${marker}`);
    assert.ok(requestB.includes(rawMarkerB));
    const followupA = JSON.stringify(
      await run('room_lounge', 'Continue this room’s meeting work.'),
    );
    for (const marker of [rawMarkerA, replyMarkerA, memoryMarker, skillMarker])
      assert.ok(followupA.includes(marker), `room A must retain ${marker}`);
    assert.ok(!followupA.includes(rawMarkerB));
    assert.equal(requests.length, 5);
    const sessions = await readdir(join(directory, 'sessions'), { recursive: true });
    assert.equal(sessions.filter((filename) => filename.endsWith('.jsonl')).length, 2);
  },
);
