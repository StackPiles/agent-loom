import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { Controller, REASONING_CHAR_LIMIT } from '../src/server/controller.js';
import type { Message, ServerEvent, Snapshot } from '../src/shared/types.js';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-progress-'));
  const f = await createApp({
    dataDir,
    scheduler: false,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  t.after(async () => {
    await f.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  f.store.put('settings', { ...f.store.settings(), id: 'main', demoMode: true });
  const task = f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Test streaming',
  });
  const message = f.controller.addMessage({
    roomId: task.roomId,
    taskId: task.id,
    authorType: 'bot',
    authorId: task.botId,
    body: '',
    status: 'streaming',
  });
  return { ...f, task, message };
}

test('reasoning streams separately, is bounded and remains attached to the originating run', async (t) => {
  const f = await fixture(t);
  const deltas: unknown[] = [];
  const patches: unknown[] = [];
  f.controller.events.on('message_reasoning_delta', (event) => deltas.push(event));
  f.controller.events.on('message_updated', (event) => patches.push(event));
  f.controller.appendReasoning(f.message.id, 'Provider reasoning. ');
  f.controller.appendMessage(f.message.id, 'The answer.');
  assert.equal(f.store.get<Message>('messages', f.message.id)?.body, 'The answer.');
  assert.equal(f.store.get<Message>('messages', f.message.id)?.reasoning, 'Provider reasoning. ');
  assert.equal(deltas.length, 1);
  f.controller.appendReasoning(f.message.id, 'x'.repeat(REASONING_CHAR_LIMIT * 2));
  f.controller.appendReasoning(f.message.id, 'Must not grow further.');
  const bounded = f.store.get<Message>('messages', f.message.id)!;
  assert.equal(bounded.reasoning?.length, REASONING_CHAR_LIMIT);
  assert.equal(bounded.reasoningTruncated, true);
  assert.equal(deltas.length, 2);
  f.controller.updateMessage(f.message.id, { reasoningStatus: 'complete', status: 'complete' });
  assert.equal(patches.length, 1);
  const next = f.controller.addMessage({
    ...f.message,
    body: '',
    reasoning: undefined,
    status: 'streaming',
  });
  const step = f.controller.addActivity({
    taskId: f.task.id,
    roomId: f.task.roomId,
    botId: f.task.botId,
    kind: 'progress',
    title: 'Agent update',
    detail: 'Actual intermediate text.',
    status: 'success',
  });
  assert.equal(step.messageId, next.id);
  assert.notEqual(step.messageId, f.message.id);
});

test('SSE delivers reasoning and provisional-message updates before completion', async (t) => {
  const f = await fixture(t);
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const address = f.app.server.address();
  assert.ok(address && typeof address !== 'string');
  const stop = new AbortController();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, {
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(5_000)]),
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const events: ServerEvent[] = [];
  const readUntil = async (condition: () => boolean) => {
    while (!condition()) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      buffered += decoder.decode(chunk.value, { stream: true });
      for (let boundary; (boundary = buffered.indexOf('\n\n')) !== -1;) {
        const block = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = block.split('\n').find((line) => line.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice(6)) as ServerEvent);
      }
    }
  };
  try {
    await readUntil(() => events.some((e) => e.type === 'snapshot'));
    f.controller.appendReasoning(f.message.id, 'A real streamed fragment.');
    f.controller.updateMessage(f.message.id, { body: '', reasoningStatus: 'complete' });
    await readUntil(
      () =>
        events.some((e) => e.type === 'message_reasoning_delta') &&
        events.some((e) => e.type === 'message_updated'),
    );
    assert.deepEqual(events.find((e) => e.type === 'message_reasoning_delta')?.data, {
      messageId: f.message.id,
      delta: 'A real streamed fragment.',
      truncated: false,
    });
    assert.equal(f.controller.getSnapshot().tasks[0].status, 'queued');
  } finally {
    await reader.cancel();
    stop.abort();
  }
});

test('restart recovery keeps partial reasoning visible and marks its stream interrupted', async (t) => {
  const f = await fixture(t);
  f.controller.appendReasoning(f.message.id, 'Partial provider reasoning before interruption.');
  f.controller.addActivity({
    taskId: f.task.id,
    roomId: f.task.roomId,
    botId: f.task.botId,
    kind: 'tool',
    title: 'Read a file',
    detail: 'notes.md',
    status: 'running',
  });
  const recovered = new Controller(f.store);
  const message = recovered.getSnapshot().messages.find((m) => m.id === f.message.id)!;
  assert.equal(message.status, 'error');
  assert.equal(message.reasoningStatus, 'interrupted');
  assert.equal(message.reasoning, 'Partial provider reasoning before interruption.');
  assert.equal(recovered.getSnapshot().activities[0].messageId, message.id);
  assert.equal(recovered.getSnapshot().activities[0].status, 'error');
  await recovered.shutdown();
});

test('settings accept smart permissions and power-of-two bounds without changing a running model implicitly', async (t) => {
  const f = await fixture(t);
  const unchangedDefaults = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      model: { reasoningMode: 'server', reasoningEffort: 'medium' },
      permissions: { shell: 'auto', fileWrite: 'auto', network: 'auto' },
    },
  });
  assert.equal(unchangedDefaults.statusCode, 200);
  const changedActive = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { model: { reasoningMode: 'openai' } },
  });
  assert.equal(changedActive.statusCode, 409);
  await f.controller.stop(f.task.id);
  const updated = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      model: {
        reasoningMode: 'openai',
        reasoningEffort: 'high',
        contextWindow: 2 ** 21,
        maxOutputTokens: 2 ** 20,
      },
    },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json<Snapshot['settings']>().model.maxOutputTokens, 1_048_576);
  assert.equal(
    (
      await f.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { model: { maxOutputTokens: 1_048_577 } },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { model: { contextWindow: 2048, maxOutputTokens: 2048 } },
      })
    ).statusCode,
    400,
  );
});
