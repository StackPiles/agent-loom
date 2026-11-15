import assert from 'node:assert/strict';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app.js';
import { exportDataArchive, importDataArchive } from '../src/server/data-transfer-archive.js';
import { LearningStore } from '../src/server/learning.js';
import { learningPromptContext } from '../src/server/runtime/learning-tools.js';
import type { RuntimeHost } from '../src/server/runtime/contract.js';
import { Store } from '../src/server/store.js';
import type { Memory, Room, Skill, Task } from '../src/shared/types.js';

const stamp = '2026-11-14T12:00:00.000Z';
const password = 'isolated room migration transfer fixture';
const sourceTask: Task = {
  id: 'task_room_origin',
  roomId: 'room_lounge',
  botId: 'bot_aster',
  kind: 'chat',
  status: 'completed',
  rootTaskId: 'task_room_origin',
  depth: 0,
  prompt: 'Complete this room-specific work.',
  output: 'Completed in the original room.',
  inputTokens: 0,
  outputTokens: 0,
  createdAt: stamp,
  updatedAt: stamp,
};

function legacyData(dataDir: string) {
  const store = new Store(dataDir);
  try {
    store.seed();
    store.put('rooms', { ...store.get<Room>('rooms', 'room_lounge')!, id: 'room_other' });
    store.put('tasks', sourceTask);
    const learning = new LearningStore(store);
    const actor = { kind: 'bot' as const, botId: 'bot_aster', roomId: 'room_lounge' };
    const evidence = {
      sourceTaskId: sourceTask.id,
      reason: 'Preserve the verified project result.',
      evidence: 'Observed during this room-specific task.',
    };
    const memory = learning.saveMemory(
      { botId: actor.botId, content: 'A_ONLY_MIGRATED_FACT', ...evidence },
      actor,
    );
    const skill = learning.proposeSkill(
      {
        botId: actor.botId,
        name: 'Original project procedure',
        description: 'A_ONLY_MIGRATED_SKILL',
        content: 'Retain the exact procedure in its original room.',
        ...evidence,
      },
      actor,
    );
    const unknown = learning.saveMemory({ botId: null, content: 'UNKNOWN_ORIGIN_FACT' });
    assert.equal(memory.roomId, null, 'this fixture is a pre-upgrade global record');
    return { memory, skill, unknown };
  } finally {
    store.close();
  }
}

function verifyBeforeRuntime(host: RuntimeHost) {
  const snapshot = host.getSnapshot();
  assert.ok([...snapshot.memories, ...snapshot.skills].every((item) => item.roomId));
  const inA = learningPromptContext(snapshot, sourceTask);
  const inB = learningPromptContext(snapshot, { ...sourceTask, roomId: 'room_other' });
  assert.match(inA.memories, /A_ONLY_MIGRATED_FACT/);
  assert.match(inA.skills, /A_ONLY_MIGRATED_SKILL/);
  for (const marker of ['A_ONLY_MIGRATED_FACT', 'A_ONLY_MIGRATED_SKILL', 'UNKNOWN_ORIGIN_FACT'])
    assert.ok(!JSON.stringify(inB).includes(marker));
  assert.ok(!JSON.stringify(inA).includes('UNKNOWN_ORIGIN_FACT'));
  return idleRuntime();
}

function idleRuntime() {
  return {
    start() {},
    async stop() {},
    async shutdown() {},
    queueState: () => ({ active: 0, waiting: 0 }),
  };
}

test('upgrade isolates legacy learning before runtime construction and first snapshot, retaining owner reassignment', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-learning-upgrade-'));
  const old = legacyData(dataDir);
  const app = await createApp({ dataDir, scheduler: false, runtimeFactory: verifyBeforeRuntime });
  t.after(async () => {
    await app.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const first = (await app.app.inject({ url: '/api/state' })).json();
  const migrated = first.memories.find((item: Memory) => item.id === old.memory.id);
  const held = first.memories.find((item: Memory) => item.id === old.unknown.id);
  const holdingRoom = first.rooms.find((room: Room) => room.id === held.roomId);
  assert.equal(migrated.roomId, sourceTask.roomId);
  assert.equal(migrated.content, old.memory.content);
  assert.equal(holdingRoom.archived, true);
  assert.equal(holdingRoom.paused, true);
  assert.deepEqual(holdingRoom.botIds, []);
  assert.ok(
    !Object.hasOwn(first, 'learningRoomMigrationRecords'),
    'private backups stay out of snapshots',
  );
  const reassigned = await app.app.inject({
    method: 'PATCH',
    url: `/api/memories/${held.id}`,
    payload: { baseVersion: held.version, roomId: 'room_other' },
  });
  assert.equal(reassigned.statusCode, 200);
  assert.equal(reassigned.json().roomId, 'room_other');
  assert.equal(reassigned.json().content, old.unknown.content);
  assert.equal(reassigned.json().locked, old.unknown.locked);
  assert.ok(
    !learningPromptContext(app.controller.getSnapshot(), sourceTask).memories.includes(
      'UNKNOWN_ORIGIN_FACT',
    ),
  );
  assert.match(
    learningPromptContext(app.controller.getSnapshot(), { ...sourceTask, roomId: 'room_other' })
      .memories,
    /UNKNOWN_ORIGIN_FACT/,
  );
});

test('encrypted legacy imports migrate once and preserve backups, scoped records and deliberate future sharing through transfer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'loom-learning-transfer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  const old = legacyData(source);
  const archive = join(root, 'legacy.loomdata');
  const staging = join(root, 'legacy-stage');
  await exportDataArchive({ dataDir: source, archivePath: archive, password });
  await importDataArchive({
    archivePath: archive,
    stagingDir: staging,
    destinationDataDir: destination,
    password,
  });
  await rename(staging, destination);
  const upgraded = await createApp({
    dataDir: destination,
    scheduler: false,
    runtimeFactory: verifyBeforeRuntime,
  });
  let before: { memories: Memory[]; skills: Skill[]; audit: unknown[] };
  try {
    const shared = await upgraded.app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { content: 'Explicit post-upgrade general preference.', roomId: null },
    });
    assert.equal(shared.statusCode, 200);
    assert.equal(shared.json().roomId, null);
    before = {
      memories: upgraded.store.list<Memory>('memories'),
      skills: upgraded.store.list<Skill>('skills'),
      audit: upgraded.store.list('learningRoomMigrationRecords'),
    };
    assert.equal(before.audit.length, 3);
    assert.ok(JSON.stringify(before.audit).includes(old.unknown.content));
  } finally {
    await upgraded.app.close();
  }
  const currentArchive = join(root, 'upgraded.loomdata');
  const currentStage = join(root, 'current-stage');
  const restoredPath = join(root, 'restored');
  await exportDataArchive({ dataDir: destination, archivePath: currentArchive, password });
  await importDataArchive({
    archivePath: currentArchive,
    stagingDir: currentStage,
    destinationDataDir: restoredPath,
    password,
  });
  await rename(currentStage, restoredPath);
  const restored = await createApp({
    dataDir: restoredPath,
    scheduler: false,
    runtimeFactory: idleRuntime,
  });
  try {
    assert.deepEqual(restored.store.list('memories'), before.memories);
    assert.deepEqual(restored.store.list('skills'), before.skills);
    assert.deepEqual(restored.store.list('learningRoomMigrationRecords'), before.audit);
    const raw = restored.controller.getSnapshot();
    const shared = raw.memories.find(
      (item) => item.content === 'Explicit post-upgrade general preference.',
    );
    assert.equal(
      shared?.roomId,
      null,
      'a completed migration never reclassifies later explicit sharing',
    );
  } finally {
    await restored.app.close();
  }
});
