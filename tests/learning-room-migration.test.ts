import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/server/controller.js';
import {
  LEARNING_ROOM_MIGRATION_AUDIT_KIND,
  LEARNING_ROOM_MIGRATION_ID,
  migrateLearningToRooms,
} from '../src/server/learning-room-migration.js';
import { learningPromptContext } from '../src/server/runtime/learning-tools.js';
import { createTools } from '../src/server/runtime/tools.js';
import { Store } from '../src/server/store.js';
import { normalizeMemory, normalizeSkill } from '../src/shared/learning.js';
import type { Memory, Room, Skill, Task } from '../src/shared/types.js';

const stamp = '2026-10-01T00:00:00.000Z';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-learning-room-migration-'));
  let store = new Store(dataDir);
  store.seed();
  store.put('settings', { ...store.settings(), id: 'main', demoMode: true, autoLearn: false });
  const lounge = store.get<Room>('rooms', 'room_lounge')!;
  store.put('rooms', { ...lounge, id: 'room_other', name: 'Other project' });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new Store(dataDir);
    },
  };
}

function task(store: Store, id: string, roomId = 'room_lounge', botId = 'bot_aster'): Task {
  return store.put<Task>('tasks', {
    id,
    roomId,
    botId,
    prompt: 'Retain only the observed project facts.',
    output: 'Verified project result.',
    status: 'completed',
    kind: 'chat',
    rootTaskId: id,
    depth: 0,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: stamp,
    updatedAt: stamp,
  });
}

function memory(store: Store, id: string, patch: Partial<Memory> = {}): Memory {
  return store.put<Memory>('memories', {
    id,
    botId: 'bot_aster',
    content: `Verified fact ${id}.`,
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  });
}

function skill(store: Store, id: string, patch: Partial<Skill> = {}): Skill {
  return store.put<Skill>('skills', {
    id,
    name: id,
    description: `Apply the verified procedure ${id}.`,
    botId: 'bot_aster',
    content: `Procedure ${id}.`,
    status: 'active',
    version: 1,
    revisions: [],
    evidence: 'Observed source task results.',
    useCount: 7,
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  });
}

interface Audit {
  recordId: string;
  collection: 'memories' | 'skills';
  original: Memory | Skill;
  roomId: string;
  held: boolean;
  provenance: { roomIds: string[]; sourceTaskIds: string[]; issues: string[] };
}

test('migration assigns unique source rooms, retaining IDs, content, states, controls and exact history', async (t) => {
  const { store } = await fixture(t);
  task(store, 'source_a');
  task(store, 'source_b', 'room_other');
  const originalMemory = memory(store, 'fact_a', {
    roomId: null,
    sourceTaskId: 'source_a',
    version: 3,
    status: 'archived',
    locked: true,
    evidence: 'Keep this original evidence.',
    revisions: [
      {
        version: 3,
        content: 'Verified fact fact_a.',
        createdAt: stamp,
        reason: 'Original audit reason.',
        actor: { kind: 'bot', botId: 'bot_aster', roomId: 'room_lounge' },
        sourceTaskId: 'source_a',
      },
    ],
  });
  const originalSkill = skill(store, 'procedure_b', {
    botId: null,
    sourceTaskId: 'source_b',
    status: 'candidate',
    locked: true,
    autoActivated: false,
  });

  assert.deepEqual(migrateLearningToRooms(store), { memories: 1, skills: 1, held: 0 });
  const migratedMemory = store.get<Memory>('memories', originalMemory.id)!;
  const migratedSkill = store.get<Skill>('skills', originalSkill.id)!;
  assert.equal(migratedMemory.roomId, 'room_lounge');
  assert.equal(migratedSkill.roomId, 'room_other');
  for (const [original, migrated] of [
    [originalMemory, migratedMemory],
    [originalSkill, migratedSkill],
  ] as const) {
    assert.equal(migrated.id, original.id);
    assert.equal(migrated.botId, original.botId);
    assert.equal(migrated.content, original.content);
    assert.equal(migrated.status, original.status);
    assert.equal(migrated.locked, original.locked);
    assert.equal(migrated.evidence, original.evidence);
    assert.equal(migrated.sourceTaskId, original.sourceTaskId);
    assert.equal(migrated.createdAt, original.createdAt);
    assert.ok(migrated.updatedAt > original.updatedAt);
    assert.deepEqual(migrated.revisions!.slice(0, original.revisions!.length), original.revisions);
    assert.match(migrated.revisions!.at(-1)!.reason, /Room isolation migration/);
    assert.equal(migrated.revisions!.at(-1)!.actor, undefined);
  }
  assert.equal(migratedMemory.version, 4);
  assert.equal(migratedSkill.version, 2);
  assert.equal(migratedSkill.useCount, originalSkill.useCount);
  assert.equal(migratedSkill.autoActivated, false);
  const audits = store.list<Audit>(LEARNING_ROOM_MIGRATION_AUDIT_KIND);
  assert.deepEqual(
    audits.find((item) => item.recordId === originalMemory.id)!.original,
    originalMemory,
  );
  assert.deepEqual(
    audits.find((item) => item.recordId === originalSkill.id)!.original,
    originalSkill,
  );
  assert.ok(audits.every((item) => !item.held && item.provenance.issues.length === 0));
});

test('already room-scoped records remain byte-for-byte unchanged, including archived and inactive records', async (t) => {
  const { store } = await fixture(t);
  for (const status of ['active', 'archived'] as const)
    memory(store, `scoped_${status}`, { roomId: 'room_lounge', status, locked: true });
  for (const status of ['active', 'candidate', 'archived'] as const)
    skill(store, `scoped_${status}`, { roomId: 'room_other', status });
  const before = store.db
    .prepare(
      "SELECT kind,id,data,created_at,updated_at FROM objects WHERE kind IN ('memories','skills') ORDER BY kind,id",
    )
    .all();
  assert.deepEqual(migrateLearningToRooms(store), { memories: 0, skills: 0, held: 0 });
  assert.deepEqual(
    store.db
      .prepare(
        "SELECT kind,id,data,created_at,updated_at FROM objects WHERE kind IN ('memories','skills') ORDER BY kind,id",
      )
      .all(),
    before,
  );
  assert.equal(store.list(LEARNING_ROOM_MIGRATION_AUDIT_KIND).length, 0);
  assert.ok(store.get('meta', LEARNING_ROOM_MIGRATION_ID));
});

test('a legacy bot skill keeps its implicit unlocked control after the migration adds a system revision', async (t) => {
  const { store } = await fixture(t);
  task(store, 'source_a');
  const original = skill(store, 'legacy_bot_skill', {
    sourceTaskId: 'source_a',
    revisions: [
      {
        version: 1,
        content: 'Procedure legacy_bot_skill.',
        description: 'Apply the verified procedure legacy_bot_skill.',
        createdAt: stamp,
        reason: 'Proposed after a task',
        actor: { kind: 'bot', botId: 'bot_aster', roomId: 'room_lounge' },
      },
    ],
  });
  assert.equal(original.locked, undefined);
  assert.equal(normalizeSkill(original).locked, false);
  migrateLearningToRooms(store);
  const migrated = store.get<Skill>('skills', original.id)!;
  assert.equal(normalizeSkill(migrated).locked, false);
  assert.deepEqual(migrated.revisions[0], original.revisions[0]);
  assert.deepEqual(store.list<Audit>(LEARNING_ROOM_MIGRATION_AUDIT_KIND)[0].original, original);
});

test('revision-only provenance survives deleted bot identities, changed membership and archived source rooms', async (t) => {
  const { store } = await fixture(t);
  store.patch<Room>('rooms', 'room_other', { archived: true, botIds: [] });
  const original = memory(store, 'historical_actor', {
    botId: 'removed_bot',
    revisions: [
      {
        version: 1,
        content: 'Verified fact historical_actor.',
        createdAt: stamp,
        reason: 'Source task no longer retained, but the actor recorded its room.',
        actor: { kind: 'bot', botId: 'removed_bot', roomId: 'room_other' },
      },
    ],
  });
  const roomBefore = store.get('rooms', 'room_other');
  const botsBefore = store.list('bots');
  assert.deepEqual(migrateLearningToRooms(store), { memories: 1, skills: 0, held: 0 });
  const migrated = store.get<Memory>('memories', original.id)!;
  assert.equal(migrated.roomId, 'room_other');
  assert.equal(migrated.botId, 'removed_bot');
  assert.deepEqual(store.get('rooms', 'room_other'), roomBefore);
  assert.deepEqual(store.list('bots'), botsBefore);
  assert.equal(normalizeMemory(migrated).locked, normalizeMemory(original).locked);
  assert.equal(normalizeMemory(migrated).status, normalizeMemory(original).status);
});

test('missing, conflicting and broken provenance is preserved in one inactive holding room without duplication', async (t) => {
  const { store } = await fixture(t);
  task(store, 'source_a');
  task(store, 'source_b', 'room_other');
  task(store, 'deleted_room_task', 'room_deleted');
  memory(store, 'unknown_origin', { botId: null });
  memory(store, 'broken_task', { sourceTaskId: 'missing_task' });
  memory(store, 'broken_room', { sourceTaskId: 'deleted_room_task' });
  memory(store, 'conflicting_origin', {
    sourceTaskId: 'source_a',
    revisions: [
      {
        version: 1,
        content: 'Verified fact conflicting_origin.',
        createdAt: stamp,
        reason: 'Learned elsewhere.',
        sourceTaskId: 'source_b',
      },
    ],
  });
  skill(store, 'unknown_archived_skill', { status: 'archived', locked: true });
  skill(store, 'inconsistent_actor_skill', {
    revisions: [
      {
        version: 1,
        description: 'Original.',
        content: 'Original.',
        reason: 'Inconsistent imported provenance.',
        createdAt: stamp,
        sourceTaskId: 'source_a',
        actor: { kind: 'bot', botId: 'bot_nova', roomId: 'room_lounge' },
      },
    ],
  });
  const originals = [...store.list<Memory>('memories'), ...store.list<Skill>('skills')];
  const result = migrateLearningToRooms(store);
  assert.equal(result.memories, 4);
  assert.equal(result.skills, 2);
  assert.equal(result.held, 6);
  assert.ok(result.holdingRoomId);
  const holding = store.get<Room>('rooms', result.holdingRoomId)!;
  assert.equal(holding.name, '記憶・スキルの整理待ち');
  assert.equal(holding.archived, true);
  assert.equal(holding.paused, true);
  assert.deepEqual(holding.botIds, []);
  assert.equal(holding.autonomousWakeups?.mode, 'off');
  const migrated = [...store.list<Memory>('memories'), ...store.list<Skill>('skills')];
  assert.equal(migrated.length, originals.length);
  assert.ok(migrated.every((item) => item.roomId === holding.id));
  const audits = store.list<Audit>(LEARNING_ROOM_MIGRATION_AUDIT_KIND);
  for (const original of originals)
    assert.deepEqual(audits.find((item) => item.recordId === original.id)!.original, original);
  assert.ok(audits.every((item) => item.held && item.provenance.issues.length > 0));
  const host = new Controller(store);
  try {
    for (const roomId of ['room_lounge', 'room_other']) {
      const current = task(store, `read_${roomId}`, roomId);
      const prompt = learningPromptContext(host.getSnapshot(), current);
      assert.equal(prompt.memories, '(none)');
      assert.equal(prompt.skills, '(none)');
    }
    assert.throws(
      () => host.enqueueTask({ roomId: holding.id, botId: 'bot_aster', prompt: 'Read held data.' }),
      /Restore this room/,
    );
  } finally {
    await host.shutdown();
  }
});

test('merged memories consider contributor history without reading migrated scopes or guessing across rooms', async (t) => {
  const { store } = await fixture(t);
  task(store, 'source_a');
  task(store, 'source_b', 'room_other');
  memory(store, 'contributor_b', { sourceTaskId: 'source_b', version: 1, status: 'archived' });
  memory(store, 'merged_fact', {
    sourceTaskId: 'source_a',
    version: 2,
    revisions: [
      {
        version: 2,
        content: 'Facts collected from two projects.',
        createdAt: stamp,
        reason: 'Combined previously global records.',
        sourceTaskId: 'source_a',
        mergedFrom: [{ id: 'contributor_b', version: 1 }],
      },
    ],
  });
  memory(store, 'missing_contributor', {
    sourceTaskId: 'source_a',
    revisions: [
      {
        version: 1,
        content: 'Original.',
        createdAt: stamp,
        reason: 'An old merge source was deleted.',
        mergedFrom: [{ id: 'missing_memory', version: 4 }],
      },
    ],
  });
  const result = migrateLearningToRooms(store);
  assert.equal(store.get<Memory>('memories', 'contributor_b')!.roomId, 'room_other');
  assert.equal(store.get<Memory>('memories', 'merged_fact')!.roomId, result.holdingRoomId);
  assert.equal(store.get<Memory>('memories', 'missing_contributor')!.roomId, result.holdingRoomId);
  const merged = store
    .list<Audit>(LEARNING_ROOM_MIGRATION_AUDIT_KIND)
    .find((item) => item.recordId === 'merged_fact')!;
  assert.deepEqual(merged.provenance.roomIds, ['room_lounge', 'room_other']);
  assert.ok(merged.provenance.issues.includes('conflicting_rooms'));
  assert.equal(result.held, 2);
});

test('a later source task cannot assign undocumented older content or merged contributor history to its room', async (t) => {
  const { store } = await fixture(t);
  task(store, 'latest_source_b', 'room_other');
  const oldRevision = {
    version: 1,
    content: 'An older fact with no surviving room provenance.',
    createdAt: stamp,
    reason: 'Preserved legacy history.',
  };
  memory(store, 'partly_documented', {
    version: 2,
    sourceTaskId: 'latest_source_b',
    revisions: [oldRevision],
  });
  skill(store, 'partly_documented_skill', {
    version: 2,
    sourceTaskId: 'latest_source_b',
    revisions: [{ ...oldRevision, description: 'An undocumented older procedure.' }],
  });
  memory(store, 'merged_undocumented', {
    sourceTaskId: 'latest_source_b',
    revisions: [
      {
        ...oldRevision,
        sourceTaskId: 'latest_source_b',
        mergedFrom: [{ id: 'partly_documented', version: 2 }],
      },
    ],
  });
  memory(store, 'single_legacy_revision', {
    sourceTaskId: 'latest_source_b',
    revisions: [oldRevision],
  });
  const result = migrateLearningToRooms(store);
  assert.equal(result.held, 3);
  for (const [kind, name] of [
    ['memories', 'partly_documented'],
    ['skills', 'partly_documented_skill'],
    ['memories', 'merged_undocumented'],
  ] as const)
    assert.equal(store.get<Memory | Skill>(kind, name)!.roomId, result.holdingRoomId);
  assert.equal(store.get<Memory>('memories', 'single_legacy_revision')!.roomId, 'room_other');
  const audit = store
    .list<Audit>(LEARNING_ROOM_MIGRATION_AUDIT_KIND)
    .find((item) => item.recordId === 'merged_undocumented')!;
  assert.ok(audit.provenance.issues.includes('missing_revision_provenance:partly_documented:1'));
});

test('a failure rolls back changed records, audit, holding room and marker together', async (t) => {
  const { store } = await fixture(t);
  memory(store, 'unknown_origin');
  skill(store, 'unknown_skill');
  const before = store.db.prepare('SELECT * FROM objects ORDER BY kind,id').all();
  const put = store.put.bind(store);
  store.put = ((kind, value) => {
    if (kind === 'meta' && value.id === LEARNING_ROOM_MIGRATION_ID)
      throw new Error('Injected marker write failure.');
    return put(kind, value);
  }) as Store['put'];
  assert.throws(() => migrateLearningToRooms(store), /Injected marker write failure/);
  assert.deepEqual(store.db.prepare('SELECT * FROM objects ORDER BY kind,id').all(), before);
  store.put = put;
  assert.equal(migrateLearningToRooms(store).held, 2);
});

test('the durable dataset marker keeps migration idempotent and preserves deliberate new all-room sharing after restart', async (t) => {
  const f = await fixture(t);
  memory(f.store, 'unknown_origin');
  const first = migrateLearningToRooms(f.store);
  assert.equal(first.held, 1);
  const migrated = f.store.get('memories', 'unknown_origin');
  const marker = f.store.get('meta', LEARNING_ROOM_MIGRATION_ID);
  const sharedMemory = memory(f.store, 'new_explicit_global', { roomId: null });
  const sharedSkill = skill(f.store, 'new_explicit_shared_skill', { botId: null, roomId: null });
  const audits = f.store.list(LEARNING_ROOM_MIGRATION_AUDIT_KIND);
  const rooms = f.store.list('rooms');
  f.restart();
  assert.deepEqual(migrateLearningToRooms(f.store), {
    memories: 0,
    skills: 0,
    held: 0,
    holdingRoomId: first.holdingRoomId,
  });
  assert.deepEqual(f.store.get('memories', 'unknown_origin'), migrated);
  assert.deepEqual(f.store.get('memories', sharedMemory.id), sharedMemory);
  assert.deepEqual(f.store.get('skills', sharedSkill.id), sharedSkill);
  assert.deepEqual(f.store.get('meta', LEARNING_ROOM_MIGRATION_ID), marker);
  assert.deepEqual(f.store.list(LEARNING_ROOM_MIGRATION_AUDIT_KIND), audits);
  assert.deepEqual(f.store.list('rooms'), rooms);
});

test('an old globally pinned skill cannot bypass its migrated live scope; task pins remain intact for history', async (t) => {
  const { store } = await fixture(t);
  task(store, 'source_a');
  const original = skill(store, 'project_a_skill', { sourceTaskId: 'source_a', roomId: null });
  const current = task(store, 'task_b', 'room_other');
  const pin = {
    id: original.id,
    version: original.version,
    name: original.name,
    description: original.description,
    content: original.content,
    botId: original.botId,
    roomId: null,
    readAt: stamp,
  };
  store.patch<Task>('tasks', current.id, { skillUses: [pin] });
  migrateLearningToRooms(store);
  assert.equal(normalizeSkill(store.get<Skill>('skills', original.id)!).roomId, 'room_lounge');
  assert.deepEqual(store.get<Task>('tasks', current.id)!.skillUses, [pin]);
  const host = new Controller(store);
  const tools = createTools({
    host,
    task: current,
    settings: store.settings(),
    signal: new AbortController().signal,
    operationKeys: new Set(),
  });
  try {
    assert.equal(learningPromptContext(host.getSnapshot(), current).skills, '(none)');
    await assert.rejects(tools.invoke('read_skill', { id: original.id }), /available.*room/);
    assert.deepEqual(store.get<Task>('tasks', current.id)!.skillUses, [pin]);
  } finally {
    tools.dispose();
    await host.shutdown();
  }
});
