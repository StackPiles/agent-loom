import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getMessageContext,
  getTaskRequestSource,
  isTaskOutputMessage,
} from '../src/shared/message-context.js';
import type { Message, Task } from '../src/shared/types.js';

const root: Task = {
  id: 'root',
  roomId: 'room',
  botId: 'aster',
  prompt: 'Review this work.',
  status: 'completed',
  rootTaskId: 'root',
  depth: 0,
  kind: 'chat',
  output: 'Reviewed.',
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
  inputTokens: 0,
  outputTokens: 0,
};
const child: Task = {
  ...root,
  id: 'child',
  botId: 'nova',
  parentTaskId: root.id,
  depth: 1,
};
const tasks = new Map([root, child].map((task) => [task.id, task]));
const message: Message = {
  id: 'message',
  roomId: root.roomId,
  authorType: 'bot',
  authorId: root.botId,
  body: 'Here is the result.',
  taskId: root.id,
  status: 'complete',
  createdAt: root.createdAt,
};

test('an explicit owner post is distinct from an answer to an owner request', () => {
  assert.deepEqual(getMessageContext({ ...message, targetUser: true }, tasks), {
    audience: 'user',
    targetBotIds: [],
    source: { kind: 'unknown' },
  });
  assert.equal(getMessageContext(message, tasks).audience, 'room');
  assert.deepEqual(getMessageContext(message, tasks).source, { kind: 'user' });
  for (const patch of [
    { authorType: 'user' as const },
    { authorType: 'system' as const },
    { targetBotIds: ['nova'] },
  ])
    assert.deepEqual(getMessageContext({ ...message, targetUser: true, ...patch }, tasks), {
      audience: 'room',
      targetBotIds: [],
      source: { kind: 'unknown' },
    });
});

test('directed posts keep their task link without becoming a generation attempt', () => {
  assert.equal(isTaskOutputMessage(message), true);
  assert.equal(isTaskOutputMessage({ ...message, targetUser: false }), true);
  assert.equal(isTaskOutputMessage({ ...message, targetBotIds: [] }), true);
  assert.equal(isTaskOutputMessage({ ...message, targetUser: true }), false);
  assert.equal(isTaskOutputMessage({ ...message, targetBotIds: ['nova'] }), false);
  assert.equal(isTaskOutputMessage({ ...message, authorType: 'user' }), false);
  assert.equal(isTaskOutputMessage({ ...message, authorType: 'system' }), false);
});

test('persisted bot targets take priority over the sending task and mentions in prose', () => {
  const directed = getMessageContext(
    { ...message, body: '@other is quoted context.', targetBotIds: ['nova', 'nova', 'removed'] },
    tasks,
  );
  assert.deepEqual(directed, {
    audience: 'bots',
    targetBotIds: ['nova', 'removed'],
    source: { kind: 'unknown' },
  });
  assert.deepEqual(getMessageContext({ ...message, body: '@nova please review.' }, tasks), {
    audience: 'room',
    targetBotIds: [],
    source: { kind: 'user' },
  });
});

test('root owner replies and handoff results remain room-visible with distinct request sources', () => {
  assert.deepEqual(getMessageContext(message, tasks), {
    audience: 'room',
    targetBotIds: [],
    source: { kind: 'user' },
  });
  assert.deepEqual(
    getMessageContext({ ...message, authorId: child.botId, taskId: child.id }, tasks),
    { audience: 'room', targetBotIds: [], source: { kind: 'bot', botId: root.botId } },
  );
});

test('automation and learning sources do not become owner replies', () => {
  const automation = { ...root, kind: 'automation' as const };
  const automationChild = { ...child, kind: 'automation' as const };
  const map = new Map([automation, automationChild].map((task) => [task.id, task]));
  assert.deepEqual(getTaskRequestSource(automation, map), { kind: 'automation' });
  assert.deepEqual(getTaskRequestSource(automationChild, map), { kind: 'bot', botId: root.botId });
  assert.deepEqual(getTaskRequestSource({ ...child, kind: 'learning' }, tasks), {
    kind: 'learning',
  });
});

test('missing or inconsistent task ownership leaves a message as room sharing', () => {
  const shared = { audience: 'room', targetBotIds: [], source: { kind: 'unknown' } };
  for (const patch of [
    { taskId: undefined },
    { taskId: 'missing' },
    { roomId: 'other-room' },
    { authorId: 'other-bot' },
    { authorType: 'user' as const },
    { authorType: 'system' as const, targetBotIds: ['nova'] },
  ])
    assert.deepEqual(getMessageContext({ ...message, ...patch }, tasks), shared);
});

test('orphaned and inconsistent parent relationships do not invent a requesting bot', () => {
  const patches: Partial<Task>[] = [
    { parentTaskId: 'missing' },
    { parentTaskId: child.id },
    { roomId: 'other-room' },
    { botId: root.botId },
    { kind: 'automation' },
    { rootTaskId: 'other-root' },
    { depth: 0 },
    { depth: 2 },
  ];
  for (const patch of patches)
    assert.deepEqual(getTaskRequestSource({ ...child, ...patch }, tasks), { kind: 'unknown' });
});

test('broken root metadata and missing tasks are not attributed to the owner', () => {
  assert.deepEqual(getTaskRequestSource(undefined, tasks), { kind: 'unknown' });
  assert.deepEqual(getTaskRequestSource({ ...root, rootTaskId: 'other' }, tasks), {
    kind: 'unknown',
  });
  assert.deepEqual(getTaskRequestSource({ ...root, depth: 1 }, tasks), { kind: 'unknown' });
});
