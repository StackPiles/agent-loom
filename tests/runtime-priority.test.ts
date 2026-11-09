import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { InferenceGate } from '../src/server/runtime/gate.js';
import { RoomTaskScheduler } from '../src/server/runtime/pause.js';
import { WorkSchedulingLedger } from '../src/server/runtime/scheduling.js';
import type { SchedulingGrant } from '../src/shared/scheduling.js';

function fixture() {
  let now = Date.parse('2026-11-09T00:00:00Z');
  const groups = new Map<string, string>();
  const grants = new Map<string, SchedulingGrant>();
  const consumed: string[] = [];
  const ledger = new WorkSchedulingLedger({
    now: () => now,
    resolve: (taskId) => {
      const groupId = groups.get(taskId) ?? taskId;
      return { groupId, grant: grants.get(groupId) };
    },
    consume: (taskId, grantId) => {
      const grant = grants.get(groups.get(taskId) ?? taskId);
      if (!grant || grant.id !== grantId || !grant.remainingRequests) return false;
      grant.remainingRequests--;
      consumed.push(taskId);
      return true;
    },
  });
  return {
    ledger,
    groups,
    grants,
    consumed,
    advance(ms: number) {
      now += ms;
    },
    grant(groupId: string, source: 'owner' | 'bot' = 'owner') {
      const remainingRequests = source === 'owner' ? 3 : 1;
      const grant: SchedulingGrant = {
        id: `grant-${groupId}`,
        source,
        reason: 'An explicit time-sensitive request.',
        requestedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 300_000).toISOString(),
        remainingRequests,
        grantedRequests: remainingRequests,
      };
      grants.set(groupId, grant);
      return grant;
    },
  };
}

test('every task kind gets a fair turn without interrupting an issued request', async () => {
  const f = fixture();
  const gate = new InferenceGate(undefined, 1, f.ledger);
  const releaseActive = await gate.acquire(undefined, 'automation', { taskId: 'active' });
  const order: string[] = [];
  const queued = new Map<string, Promise<() => void>>();
  for (const [id, kind] of [
    ['learning', 'learning'],
    ['auto-one', 'automation'],
    ['chat-one', 'chat'],
    ['auto-two', 'automation'],
    ['chat-two', 'chat'],
  ] as const)
    queued.set(
      id,
      gate.acquire(undefined, kind, { taskId: id }).then((release) => {
        order.push(id);
        return release;
      }),
    );
  await nextTurn();
  assert.deepEqual(order, []);
  releaseActive();
  for (const id of ['learning', 'auto-one', 'chat-one', 'auto-two', 'chat-two']) {
    const release = await queued.get(id)!;
    assert.equal(order.at(-1), id);
    release();
  }
  assert.deepEqual(gate.state, { active: 0, waiting: 0 });
});

test('background and compaction work can use all slots while a blocked room is skipped', async () => {
  const gate = new InferenceGate(undefined, 2);
  const first = await gate.acquire(undefined, 'automation', {
    taskId: 'summary',
    roomId: 'busy',
    serialRoom: true,
    purpose: 'compaction',
  });
  const other = await gate.acquire(undefined, 'learning', { taskId: 'other', roomId: 'other' });
  assert.equal(gate.state.active, 2, 'there is no reserved model slot');
  const chat = gate.acquire(undefined, 'chat', {
    taskId: 'chat',
    roomId: 'busy',
    serialRoom: true,
  });
  const automation = gate.acquire(undefined, 'automation', {
    taskId: 'auto',
    roomId: 'independent',
  });
  assert.equal(gate.blockingTaskId('chat'), 'summary');
  other();
  const next = await automation;
  first();
  const user = await chat;
  next();
  user();
  assert.deepEqual(gate.state, { active: 0, waiting: 0 });
});

test('actual slot occupancy and a minimum turn charge apply to all children of one work', async () => {
  const f = fixture();
  for (const id of ['parent', 'summary', 'image']) f.groups.set(id, 'shared-work');
  const gate = new InferenceGate(undefined, 1, f.ledger);
  const original = await gate.acquire(undefined, 'chat', { taskId: 'parent' });
  const summary = gate.acquire(undefined, 'chat', { taskId: 'summary', purpose: 'compaction' });
  const image = gate.acquire(undefined, 'automation', { taskId: 'image', purpose: 'image' });
  const independent = gate.acquire(undefined, 'learning', { taskId: 'independent' });
  f.advance(20_000);
  assert.equal(f.ledger.info('parent').occupiedMs, 20_000);
  original();
  const releaseIndependent = await independent;
  assert.equal(gate.isWaiting('summary'), true);
  assert.equal(f.ledger.info('independent').lastDispatchReason, 'fair');
  releaseIndependent();
  const releaseSummary = await summary;
  assert.equal(f.ledger.info('summary').groupId, 'shared-work');
  assert.equal(f.ledger.info('summary').purpose, 'compaction');
  releaseSummary();
  const releaseImage = await image;
  assert.equal(f.ledger.info('image').purpose, 'image');
  releaseImage();
  f.ledger.wait('image');
  f.ledger.wait('fresh');
  assert.equal(
    f.ledger.choose(['image', 'fresh'])?.taskId,
    'fresh',
    'fast requests still cost a turn',
  );
});

test('two preferred admissions are followed by another fair group even when all groups are urgent', async () => {
  const f = fixture();
  for (const id of ['first', 'child', 'third']) f.groups.set(id, 'work');
  const firstGrant = f.grant('work');
  f.advance(1);
  const otherGrant = f.grant('other');
  const gate = new InferenceGate(undefined, 1, f.ledger);
  const held = await gate.acquire(undefined, 'automation', { taskId: 'held' });
  const first = gate.acquire(undefined, 'chat', { taskId: 'first', purpose: 'compaction' });
  const child = gate.acquire(undefined, 'automation', { taskId: 'child' });
  const third = gate.acquire(undefined, 'chat', { taskId: 'third' });
  const other = gate.acquire(undefined, 'learning', { taskId: 'other' });
  assert.equal(firstGrant.remainingRequests, 3, 'queueing does not consume a grant');
  held();
  (await first)();
  (await child)();
  const ordinary = await other;
  assert.equal(gate.isWaiting('third'), true);
  assert.equal(f.ledger.info('other').lastDispatchReason, 'fair');
  assert.equal(otherGrant.remainingRequests, 3, 'a fair admission does not spend priority');
  ordinary();
  (await third)();
  assert.equal(firstGrant.remainingRequests, 0);
  assert.deepEqual(f.consumed, ['first', 'child', 'third']);
  assert.equal(f.ledger.info('third').grant?.remainingRequests, 0, 'exhaustion remains visible');
});

test('a denied or revoked grant cannot confer preferred admission', async () => {
  let grant = fixture().grant('urgent');
  const ledger = new WorkSchedulingLedger({
    now: () => Date.parse(grant.requestedAt),
    resolve: (id) => ({ groupId: id, grant: id === 'urgent' ? grant : undefined }),
    consume: () => false,
  });
  const gate = new InferenceGate(undefined, 1, ledger);
  const held = await gate.acquire(undefined, 'chat', { taskId: 'held' });
  const ordinary = gate.acquire(undefined, 'automation', { taskId: 'ordinary' });
  const urgent = gate.acquire(undefined, 'chat', { taskId: 'urgent' });
  held();
  (await ordinary)();
  const release = await urgent;
  assert.equal(ledger.info('urgent').lastDispatchReason, 'fair');
  release();
  grant = { ...grant, remainingRequests: 0, revokedAt: grant.requestedAt };
  ledger.wait('fresh');
  ledger.wait('urgent');
  assert.equal(ledger.choose(['urgent', 'fresh'])?.taskId, 'fresh');
});

test('aging admits an eligible long waiter despite its bounded recent service debt', () => {
  const f = fixture();
  f.ledger.wait('heavy');
  const release = f.ledger.dispatch(f.ledger.choose(['heavy'])!)!;
  f.advance(90_000);
  release();
  f.ledger.wait('heavy');
  f.advance(30_000);
  f.ledger.wait('new');
  assert.equal(f.ledger.choose(['new', 'heavy'])?.taskId, 'heavy');
  assert.equal(f.ledger.choose(['new', 'heavy'])?.reason, 'waiting');
});

test('many old children earn one aging turn for their work rather than draining ahead of another work', () => {
  const f = fixture();
  for (let index = 0; index < 20; index++) {
    f.groups.set(`child-${index}`, 'fanout');
    f.ledger.wait(`child-${index}`);
  }
  f.advance(1);
  f.ledger.wait('independent');
  f.advance(30_000);
  const children = Array.from({ length: 20 }, (_, index) => `child-${index}`);
  const first = f.ledger.choose([...children, 'independent'])!;
  assert.equal(first.groupId, 'fanout');
  f.ledger.dispatch(first)!();
  const next = f.ledger.choose([...children.slice(1), 'independent'])!;
  assert.equal(next.taskId, 'independent');
  assert.equal(next.reason, 'waiting');
});

test('a work group does not earn waiting-age priority while its sibling occupies a model slot', () => {
  const f = fixture();
  f.groups.set('running', 'work');
  f.groups.set('child', 'work');
  f.ledger.wait('running');
  const release = f.ledger.dispatch(f.ledger.choose(['running'])!)!;
  f.ledger.wait('child');
  f.advance(60_000);
  f.ledger.wait('independent');
  f.advance(30_000);
  assert.equal(f.ledger.choose(['child', 'independent'])?.taskId, 'independent');
  release();
  assert.equal(f.ledger.choose(['child', 'independent'])?.taskId, 'independent');
});

test('rebinding preserves debt without merging unrelated siblings or multiplying inherited history', () => {
  const f = fixture();
  for (const id of ['parent', 'child', 'sibling']) f.groups.set(id, 'root');
  f.ledger.wait('parent');
  const release = f.ledger.dispatch(f.ledger.choose(['parent'])!)!;
  f.advance(5_000);
  release();
  f.ledger.info('child');
  f.groups.set('parent', 'work');
  f.groups.set('child', 'work');
  f.groups.set('new-descendant', 'work');
  f.ledger.wait('new-descendant');
  f.ledger.wait('independent');
  assert.equal(
    f.ledger.choose(['new-descendant', 'independent', 'parent'])?.taskId,
    'independent',
    'all rebinding debt is visible before comparing an earlier-listed new child',
  );
  assert.equal(f.ledger.info('parent').groupId, 'work');
  assert.equal(f.ledger.info('child').groupId, 'work');
  assert.equal(f.ledger.info('sibling').groupId, 'root');
  f.groups.set('separate', 'other-work');
  f.ledger.wait('parent');
  f.ledger.wait('separate');
  assert.equal(f.ledger.choose(['parent', 'separate'])?.taskId, 'separate');
  f.ledger.wait('sibling');
  assert.equal(
    f.ledger.choose(['parent', 'sibling'])?.taskId,
    'parent',
    'one inherited copy per group',
  );
});

test('all workers are usable and a safe continuation lends a worker according to the shared ledger', async () => {
  const f = fixture();
  let pending: string[] = [];
  const scheduler = new RoomTaskScheduler({
    capacity: 2,
    scheduling: f.ledger,
    pendingTasks: () => pending,
  });
  assert.equal(scheduler.tryStart('auto', 'one', 'automation'), true);
  assert.equal(scheduler.tryStart('learning', 'two', 'learning'), true);
  assert.equal(scheduler.activeCount, 2, 'no fixed foreground worker is held idle');
  f.grant('urgent');
  f.ledger.wait('urgent');
  pending = ['urgent'];
  assert.equal(scheduler.shouldYield('auto'), true);
  const controller = new AbortController();
  const parked = scheduler.checkpoint('auto', controller.signal);
  const rejected = assert.rejects(parked, { name: 'AbortError' });
  assert.equal(scheduler.activeCount, 1);
  assert.equal(scheduler.tryStart('urgent', 'three', 'chat'), true);
  pending = [];
  controller.abort();
  await rejected;
  scheduler.finish('auto');
  scheduler.finish('learning');
  scheduler.finish('urgent');
  assert.equal(scheduler.activeCount, 0);
  assert.deepEqual(scheduler.waitingTasks, []);
});

test('room pause does not earn aging and parked workers share fairness with new work', async () => {
  const f = fixture();
  let pending: string[] = [];
  const scheduler = new RoomTaskScheduler({
    capacity: 1,
    scheduling: f.ledger,
    pendingTasks: () => pending,
  });
  scheduler.tryStart('paused', 'room');
  scheduler.setRoomPaused('room', true);
  const parked = scheduler.checkpoint('paused', new AbortController().signal);
  f.advance(60_000);
  assert.equal(f.ledger.info('paused').waitingSince, undefined);
  f.ledger.wait('new');
  f.advance(1);
  pending = ['new'];
  scheduler.setRoomPaused('room', false);
  await nextTurn();
  assert.equal(scheduler.isSuspended('paused'), true);
  assert.equal(scheduler.tryStart('new', 'new-room'), true);
  pending = [];
  scheduler.finish('new');
  assert.equal(await parked, true);
  scheduler.finish('paused');
});
