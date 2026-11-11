import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import type { Message } from '../src/shared/types.js';

test('same-millisecond messages keep the instruction before its continuation through upserts and restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-message-order-'));
  let store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-10T12:00:00.000Z') });
  const original: Message = {
    id: 'msg_ffffffffffffffff',
    roomId: 'room_order',
    taskId: 'task_order',
    authorType: 'bot',
    authorId: 'bot_aster',
    body: 'The original partial response.',
    status: 'complete',
    createdAt: new Date().toISOString(),
  };
  const instruction: Message = {
    ...original,
    id: 'msg_8888888888888888',
    authorType: 'user',
    authorId: 'user',
    taskInputId: 'input_order',
    targetBotIds: ['bot_aster'],
    body: 'Use the corrected specification.',
  };
  const continuation: Message = {
    ...original,
    id: 'msg_0000000000000000',
    body: 'Continuing with the corrected specification.',
    status: 'streaming',
  };
  // IDs intentionally sort in reverse. Clock resolution must not reverse the
  // conversation or make the original response appear to be the current run.
  for (const message of [original, instruction, continuation]) store.put('messages', message);
  const expected = [original.id, instruction.id, continuation.id];
  const assertOrder = () => {
    const messages = store.list<Message>('messages');
    assert.deepEqual(
      messages.map((message) => message.id),
      expected,
    );
    assert.equal(messages.findLast((message) => message.authorType === 'bot')?.id, continuation.id);
  };
  assertOrder();

  t.mock.timers.tick(1000);
  store.put('messages', { ...original, body: 'Preserved original response.' });
  store.patch<Message>('messages', continuation.id, { status: 'complete' });
  assertOrder();
  assert.equal(store.get<Message>('messages', original.id)?.body, 'Preserved original response.');

  store.close();
  store = new Store(directory);
  assertOrder();
  assert.equal(store.get<Message>('messages', continuation.id)?.status, 'complete');
});

test('non-message records retain their existing identifier order for equal timestamps', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-object-order-'));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-10T12:00:00.000Z') });
  store.put('tasks', { id: 'task_z' });
  store.put('tasks', { id: 'task_a' });
  assert.deepEqual(
    store.list<{ id: string }>('tasks').map((task) => task.id),
    ['task_a', 'task_z'],
  );
});
