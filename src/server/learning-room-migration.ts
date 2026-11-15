import {
  memoryRevision,
  normalizeMemory,
  normalizeSkill,
  skillRevision,
} from '../shared/learning.js';
import type { Memory, MemoryRevision, Room, Skill, SkillRevision, Task } from '../shared/types.js';
import { DEFAULT_AUTONOMOUS_WAKEUP_POLICY } from '../shared/work.js';
import { id, now, type Store } from './store.js';

export const LEARNING_ROOM_MIGRATION_ID = 'learningRoomScopeMigrationV1';
export const LEARNING_ROOM_MIGRATION_AUDIT_KIND = 'learningRoomMigrationRecords';

export interface LearningRoomMigrationResult {
  memories: number;
  skills: number;
  held: number;
  holdingRoomId?: string;
}

interface MigrationMarker extends LearningRoomMigrationResult {
  id: typeof LEARNING_ROOM_MIGRATION_ID;
  version: 1;
  completedAt: string;
}

interface Provenance {
  roomIds: string[];
  sourceTaskIds: string[];
  issues: string[];
}

interface MigrationAudit {
  id: string;
  migrationId: typeof LEARNING_ROOM_MIGRATION_ID;
  collection: 'memories' | 'skills';
  recordId: string;
  original: Memory | Skill;
  roomId: string;
  held: boolean;
  provenance: Provenance;
  createdAt: string;
}

type Source = Pick<Memory, 'sourceTaskId' | 'roomId'> &
  Pick<MemoryRevision, 'actor' | 'mergedFrom'>;

/** Never derive a room from prose, current membership, or the selected UI room. */
function originResolver(store: Store, memories: readonly Memory[]) {
  const sourceMemories = new Map(memories.map((memory) => [memory.id, memory]));
  const tasks = new Map<string, Pick<Task, 'botId' | 'roomId'> | undefined>();
  const rooms = new Map<string, boolean>();
  const sourceTask = (taskId: string) => {
    if (!tasks.has(taskId)) {
      const task = store.get<Task>('tasks', taskId);
      tasks.set(taskId, task ? { botId: task.botId, roomId: task.roomId } : undefined);
    }
    return tasks.get(taskId);
  };
  const roomExists = (roomId: string) => {
    if (!rooms.has(roomId)) rooms.set(roomId, Boolean(store.get<Room>('rooms', roomId)));
    return rooms.get(roomId)!;
  };

  return (record: Memory | Skill): Provenance => {
    const roomIds = new Set<string>();
    const sourceTaskIds = new Set<string>();
    const issues = new Set<string>();
    const visiting = new Set<string>();
    const visited = new Set<string>();
    let inspected = 0;

    const hasProvenance = (value: Source) =>
      Boolean(
        value.roomId ||
        (value.actor?.kind === 'bot' && value.actor.roomId) ||
        value.sourceTaskId ||
        value.mergedFrom?.length,
      );
    const hasContent = (value: { content?: string }) => Boolean(value.content?.trim());
    const history = (value: Memory | Skill, throughVersion = Infinity) => {
      const currentVersion =
        Number.isSafeInteger(value.version) && (value.version ?? 0) > 0 ? value.version! : 1;
      const includeCurrent = currentVersion <= throughVersion;
      const revisions = (value.revisions ?? []).filter(
        (revision) => revision.version <= throughVersion,
      );
      const currentRevision = revisions.find((revision) => revision.version === currentVersion);
      if (
        includeCurrent &&
        hasContent(value) &&
        !hasProvenance(value) &&
        !(currentRevision && hasProvenance(currentRevision))
      )
        issues.add(`missing_revision_provenance:${value.id}:${currentVersion}`);
      if (includeCurrent) source(value);
      for (const revision of revisions) {
        // A record-level task belongs to its current content. It cannot prove
        // where an earlier content-bearing revision came from after later edits.
        if (
          hasContent(revision) &&
          !hasProvenance(revision) &&
          !(includeCurrent && revision.version === currentVersion && hasProvenance(value))
        )
          issues.add(`missing_revision_provenance:${value.id}:${revision.version}`);
        source(revision);
      }
    };

    const room = (roomId: string) => {
      roomIds.add(roomId);
      if (!roomExists(roomId)) issues.add(`missing_room:${roomId}`);
    };
    const source = (value: Source) => {
      if (value.roomId) room(value.roomId);
      if (value.actor?.kind === 'bot') room(value.actor.roomId);
      if (value.sourceTaskId) {
        sourceTaskIds.add(value.sourceTaskId);
        const task = sourceTask(value.sourceTaskId);
        if (!task?.roomId) issues.add(`missing_source_task:${value.sourceTaskId}`);
        else {
          room(task.roomId);
          if (
            value.actor?.kind === 'bot' &&
            (value.actor.roomId !== task.roomId || value.actor.botId !== task.botId)
          )
            issues.add(`inconsistent_actor:${value.sourceTaskId}`);
        }
      }
      for (const merged of value.mergedFrom ?? []) {
        const key = JSON.stringify([merged.id, merged.version]);
        if (visiting.has(key)) {
          issues.add('cyclic_memory_provenance');
          continue;
        }
        if (visited.has(key)) continue;
        // A malformed graph must not make startup unbounded. Unresolved records
        // remain intact in the holding room instead of guessing a destination.
        if (++inspected > 1_000 || visiting.size >= 100) {
          issues.add('memory_provenance_limit');
          continue;
        }
        const memory = sourceMemories.get(merged.id);
        if (!memory) {
          issues.add(`missing_merged_memory:${merged.id}`);
          continue;
        }
        const version = normalizeMemory(memory).version;
        if (
          version !== merged.version &&
          !memory.revisions?.some((revision) => revision.version === merged.version)
        ) {
          issues.add(`missing_merged_revision:${merged.id}:${merged.version}`);
          continue;
        }
        visiting.add(key);
        history(memory, merged.version);
        visiting.delete(key);
        visited.add(key);
      }
    };

    history(record);
    if (!roomIds.size) issues.add('missing_provenance');
    if (roomIds.size > 1) issues.add('conflicting_rooms');
    return {
      roomIds: [...roomIds].sort(),
      sourceTaskIds: [...sourceTaskIds].sort(),
      issues: [...issues].sort(),
    };
  };
}

function nextVersion(current: number, revisions: readonly { version: number }[]): number {
  const latest = revisions.reduce(
    (value, revision) =>
      Number.isSafeInteger(revision.version) ? Math.max(value, revision.version) : value,
    current,
  );
  if (latest >= Number.MAX_SAFE_INTEGER)
    throw new Error('A learning record has no available revision for room migration.');
  return latest + 1;
}

function scopedMemory(original: Memory, roomId: string, stamp: string, reason: string): Memory {
  const current = normalizeMemory(original);
  const revisions = [...(original.revisions ?? [])];
  if (!revisions.some((revision) => revision.version === current.version))
    revisions.push(
      memoryRevision(current, {
        createdAt: original.updatedAt ?? original.createdAt,
        reason: 'Preserved existing memory before room isolation migration',
      }),
    );
  const version = nextVersion(current.version, revisions);
  revisions.push(
    memoryRevision({ ...current, roomId, version, updatedAt: stamp }, { createdAt: stamp, reason }),
  );
  return { ...original, roomId, version, updatedAt: stamp, revisions };
}

function scopedSkill(original: Skill, roomId: string, stamp: string, reason: string): Skill {
  const current = normalizeSkill(original);
  const revisions: SkillRevision[] = [...(original.revisions ?? [])];
  if (!revisions.some((revision) => revision.version === current.version))
    revisions.push(
      skillRevision(current, {
        createdAt: original.updatedAt ?? original.createdAt,
        reason: 'Preserved existing skill before room isolation migration',
      }),
    );
  const version = nextVersion(current.version, revisions);
  revisions.push(
    skillRevision({ ...current, roomId, version, updatedAt: stamp }, { createdAt: stamp, reason }),
  );
  // Older bot skills infer this control from bot-only history. The new system
  // migration revision must not turn an implicitly unlocked skill into a lock.
  return { ...original, roomId, version, locked: current.locked, updatedAt: stamp, revisions };
}

/**
 * Run after Store.seed(), before Controller/runtime/scheduler construction.
 *
 * This is one migration per dataset, not a permanent ban on owner-authorized
 * sharing. Whole-database imports carry their own marker: an old backup without
 * it is migrated, while a newer dataset preserves deliberate later sharing.
 * Historical task pins and transcripts are retained; tools must check the live
 * learning record's scope before honoring an old pin.
 */
export function migrateLearningToRooms(store: Store): LearningRoomMigrationResult {
  const existing = store.get<MigrationMarker>('meta', LEARNING_ROOM_MIGRATION_ID);
  if (existing) {
    if (existing.version !== 1 || !existing.completedAt)
      throw new Error('The learning room migration marker is invalid.');
    return {
      memories: 0,
      skills: 0,
      held: 0,
      ...(existing.holdingRoomId ? { holdingRoomId: existing.holdingRoomId } : {}),
    };
  }

  const memories = store.list<Memory>('memories');
  const skills = store.list<Skill>('skills');
  const resolveOrigin = originResolver(store, memories);
  const result: LearningRoomMigrationResult = { memories: 0, skills: 0, held: 0 };
  const stamp = now();
  const holdingRoom = () => {
    if (result.holdingRoomId) return result.holdingRoomId;
    const room: Room = {
      id: id('room'),
      name: '記憶・スキルの整理待ち',
      description:
        '元のルームを一意に確認できなかった記憶・スキルを保管しています。「記憶とスキル」で内容と履歴を確認し、対象ルームを指定してください。',
      botIds: [],
      pinned: false,
      archived: true,
      paused: true,
      autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY },
      createdAt: stamp,
      updatedAt: stamp,
    };
    store.put('rooms', room);
    result.holdingRoomId = room.id;
    return room.id;
  };

  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const collection of ['memories', 'skills'] as const) {
      const records = collection === 'memories' ? memories : skills;
      for (const original of records) {
        if (original.roomId) continue;
        const provenance = resolveOrigin(original);
        const held = provenance.issues.length > 0 || provenance.roomIds.length !== 1;
        const roomId = held ? holdingRoom() : provenance.roomIds[0];
        const reason = held
          ? 'Room isolation migration: origin could not be uniquely verified; retained in the archived holding room for owner review.'
          : 'Room isolation migration: limited to the original room identified by saved provenance.';
        const updated =
          collection === 'memories'
            ? scopedMemory(original as Memory, roomId, stamp, reason)
            : scopedSkill(original as Skill, roomId, stamp, reason);
        const audit: MigrationAudit = {
          id: id('learningRoom'),
          migrationId: LEARNING_ROOM_MIGRATION_ID,
          collection,
          recordId: original.id,
          original,
          roomId,
          held,
          provenance,
          createdAt: stamp,
        };
        store.put(LEARNING_ROOM_MIGRATION_AUDIT_KIND, audit);
        store.put(collection, updated);
        result[collection]++;
        if (held) result.held++;
      }
    }
    store.put<MigrationMarker>('meta', {
      id: LEARNING_ROOM_MIGRATION_ID,
      version: 1,
      completedAt: stamp,
      ...result,
    });
    store.db.exec('COMMIT');
    return result;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
