import { z } from 'zod';
import type { Bot, Memory, Room, Skill, Task } from '../shared/types.js';
import {
  learningVisible,
  memoryRevision,
  normalizeMemory,
  normalizeSkill,
  normalizedLearningText,
  skillRevision,
  type LearningActor,
  type MemoryInput,
  type MemoryMergeInput,
  type MemoryPatch,
  type NormalizedMemory,
  type NormalizedSkill,
  type SkillInput,
  type SkillPatch,
} from '../shared/learning.js';
import { Store, id, now } from './store.js';

const recordId = z.string().trim().min(1).max(160);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reason = z.string().trim().min(1).max(1000);
const evidence = z.string().trim().max(4000);
const scope = {
  botId: recordId.nullable(),
  roomId: recordId.nullable().optional(),
  locked: z.boolean().optional(),
};
const provenance = {
  reason: reason.optional(),
  evidence: evidence.optional(),
  sourceTaskId: recordId.optional(),
};
export const memoryInputSchema = z
  .object({
    ...scope,
    ...provenance,
    botId: scope.botId.default(null),
    content: z.string().trim().min(1).max(8000),
    replacesId: recordId.optional(),
    baseVersion: version.optional(),
  })
  .strict();
export const memoryPatchSchema = z
  .object({
    ...scope,
    ...provenance,
    content: z.string().trim().min(1).max(8000),
    status: z.enum(['active', 'archived']),
  })
  .partial()
  .strict();
export const skillInputSchema = z
  .object({
    ...scope,
    ...provenance,
    botId: scope.botId.default(null),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000),
    content: z.string().trim().min(1).max(64_000),
    evidence: evidence.default('Created by the user.'),
  })
  .strict();
export const skillPatchSchema = z
  .object({
    ...scope,
    ...provenance,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000),
    content: z.string().trim().min(1).max(64_000),
    status: z.enum(['candidate', 'active', 'archived']),
  })
  .partial()
  .strict();
export const memoryMergeSchema = z
  .object({
    targetId: recordId,
    baseVersion: version,
    content: z.string().trim().min(1).max(8000),
    sources: z
      .array(z.object({ id: recordId, baseVersion: version }).strict())
      .min(1)
      .max(20),
    reason,
    evidence: evidence.optional(),
    sourceTaskId: recordId.optional(),
  })
  .strict();
export const learningVersionSchema = version;
const actorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('bot'), botId: recordId, roomId: recordId }).strict(),
]);
const user: LearningActor = { kind: 'user' };

function problem(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}

function sameScope(
  left: { botId: string | null; roomId?: string | null },
  right: { botId: string | null; roomId?: string | null },
): boolean {
  return left.botId === right.botId && (left.roomId ?? null) === (right.roomId ?? null);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function protectedScopeOverlaps(
  item: { botId: string | null; roomId?: string | null },
  incoming: { roomId?: string | null },
  actor: Extract<LearningActor, { kind: 'bot' }>,
): boolean {
  return (
    (!item.botId || item.botId === actor.botId) &&
    (!item.roomId || !incoming.roomId || item.roomId === incoming.roomId)
  );
}

/** Synchronous ownership checks and compare-and-swap writes for durable learning. */
export class LearningStore {
  constructor(private readonly store: Store) {}

  getMemory(key: string): NormalizedMemory {
    const memory = this.store.get<Memory>('memories', key);
    if (!memory) problem('Memory not found.', 404);
    return normalizeMemory(memory);
  }

  getSkill(key: string): NormalizedSkill {
    const skill = this.store.get<Skill>('skills', key);
    if (!skill) problem('Skill not found.', 404);
    return normalizeSkill(skill);
  }

  private checkActor(value: LearningActor): LearningActor {
    const actor = actorSchema.parse(value);
    if (actor.kind === 'bot') {
      const bot = this.store.get<Bot>('bots', actor.botId);
      const room = this.store.get<Room>('rooms', actor.roomId);
      if (!bot?.enabled || !room || room.archived || !room.botIds.includes(actor.botId))
        problem('This bot cannot change learning records from this room.', 403);
    }
    return actor;
  }

  private checkScope(botId: string | null, roomId: string | null): void {
    if (botId && !this.store.get<Bot>('bots', botId)) problem('Bot not found.', 404);
    if (roomId) {
      const room = this.store.get<Room>('rooms', roomId);
      if (!room) problem('Room not found.', 404);
      if (botId && !room.botIds.includes(botId))
        problem('The selected bot is not a member of this room.');
    }
  }

  private checkSource(sourceTaskId: string | undefined, actor: LearningActor): void {
    if (!sourceTaskId) {
      if (actor.kind === 'bot') problem('Bot learning changes need a source task.');
      return;
    }
    const task = this.store.get<Task>('tasks', sourceTaskId);
    if (!task) problem('Source task not found.', 404);
    if (actor.kind === 'bot' && (task.botId !== actor.botId || task.roomId !== actor.roomId))
      problem('The source task must belong to this bot and room.', 403);
  }

  private checkEvidence(input: { reason?: string; evidence?: string }, actor: LearningActor): void {
    if (actor.kind === 'bot' && (!input.reason?.trim() || !input.evidence?.trim()))
      problem('Bot learning changes need a concrete reason and observed evidence.');
  }

  private checkCreate(
    input: {
      botId: string | null;
      roomId?: string | null;
      locked?: boolean;
      sourceTaskId?: string;
    },
    actor: LearningActor,
  ): void {
    this.checkScope(input.botId, input.roomId ?? null);
    this.checkSource(input.sourceTaskId, actor);
    if (actor.kind === 'bot') {
      if (input.botId !== actor.botId || !learningVisible(input, actor.botId, actor.roomId))
        problem(
          'Bots can create only their own memories and skills in this room or all rooms.',
          403,
        );
      if (input.locked !== undefined)
        problem('Only the owner can change whether a learning record is fixed.', 403);
    }
  }

  private checkVersion(actual: number, expected: number): void {
    const baseVersion = version.parse(expected);
    if (actual !== baseVersion)
      problem('This item changed since it was read. Reload the latest version before saving.', 409);
  }

  private checkBotEdit(
    existing: { botId: string | null; roomId: string | null; locked: boolean; status: string },
    patch: MemoryPatch | SkillPatch,
    actor: LearningActor,
    skill: boolean,
  ): void {
    if (actor.kind !== 'bot') return;
    if (existing.botId !== actor.botId || !learningVisible(existing, actor.botId, actor.roomId))
      problem('This bot can change only its own learning records available in this room.', 403);
    if (existing.locked)
      problem('This item is fixed by the owner and cannot be changed by a bot.', 409);
    if (existing.status !== 'active')
      problem('Bots cannot change or reactivate inactive learning records.', 409);
    if (patch.botId !== undefined || patch.roomId !== undefined || patch.locked !== undefined)
      problem('Only the owner can change the scope or fixed setting.', 403);
    if (skill && patch.status !== undefined)
      problem('Only the owner can change the status of an existing skill.', 403);
    if (!skill && patch.status !== undefined && patch.status !== 'archived')
      problem('Bots can archive a memory but cannot reactivate it.', 403);
  }

  private memoryDuplicate(
    input: { botId: string | null; roomId?: string | null; content: string },
    actor: LearningActor,
    exclude: Set<string> = new Set(),
  ): NormalizedMemory | undefined {
    const content = normalizedLearningText(input.content);
    let duplicate: NormalizedMemory | undefined;
    for (const raw of this.store.list<Memory>('memories')) {
      if (exclude.has(raw.id)) continue;
      const memory = normalizeMemory(raw);
      if (
        actor.kind === 'bot' &&
        protectedScopeOverlaps(memory, input, actor) &&
        (memory.locked || memory.status === 'archived') &&
        [memory.content, ...memory.revisions.map((revision) => revision.content)].some(
          (value) => normalizedLearningText(value) === content,
        )
      )
        problem(
          'This content belongs to a fixed or archived memory. Respect the owner’s decision.',
          409,
        );
      if (
        sameScope(memory, input) &&
        memory.status === 'active' &&
        normalizedLearningText(memory.content) === content
      )
        duplicate = memory;
    }
    return duplicate;
  }

  private skillDuplicate(
    input: { botId: string | null; roomId?: string | null; name: string; content: string },
    actor: LearningActor,
    excludeId?: string,
  ): NormalizedSkill | undefined {
    const content = normalizedLearningText(input.content);
    const name = normalizedLearningText(input.name);
    let duplicate: NormalizedSkill | undefined;
    for (const raw of this.store.list<Skill>('skills')) {
      if (raw.id === excludeId) continue;
      const skill = normalizeSkill(raw);
      const historyMatches = [skill, ...skill.revisions].some(
        (revision) =>
          (revision.name && normalizedLearningText(revision.name) === name) ||
          normalizedLearningText(revision.content) === content,
      );
      if (
        actor.kind === 'bot' &&
        protectedScopeOverlaps(skill, input, actor) &&
        (skill.locked || skill.status !== 'active') &&
        historyMatches
      )
        problem(
          'This procedure belongs to a fixed or inactive skill. Respect the owner’s decision.',
          409,
        );
      if (
        sameScope(skill, input) &&
        skill.status !== 'archived' &&
        (normalizedLearningText(skill.name) === name ||
          normalizedLearningText(skill.content) === content)
      )
        duplicate = skill;
    }
    return duplicate;
  }

  saveMemory(inputValue: MemoryInput, actorValue: LearningActor = user): NormalizedMemory {
    const input = memoryInputSchema.parse(inputValue);
    const actor = this.checkActor(actorValue);
    this.checkEvidence(input, actor);
    if (input.replacesId) {
      const existing = this.getMemory(input.replacesId);
      if (existing.botId !== input.botId) problem('Memory replacement must keep the same owner.');
      return this.updateMemory(
        input.replacesId,
        {
          content: input.content,
          ...(input.roomId !== undefined ? { roomId: input.roomId } : {}),
          ...(input.locked !== undefined ? { locked: input.locked } : {}),
          ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.sourceTaskId !== undefined ? { sourceTaskId: input.sourceTaskId } : {}),
        },
        input.baseVersion!,
        actor,
      );
    }
    if (input.baseVersion !== undefined)
      problem('baseVersion is only valid when replacing a memory.');
    this.checkCreate(input, actor);
    const duplicate = this.memoryDuplicate(input, actor);
    if (duplicate) {
      if (actor.kind === 'user' && (input.locked ?? true) !== duplicate.locked)
        problem(
          `This memory already exists (${duplicate.id}). Edit its current version to change the fixed setting.`,
          409,
        );
      return duplicate;
    }
    const stamp = now();
    const memory: NormalizedMemory = {
      id: id('memory'),
      botId: input.botId,
      roomId: input.roomId ?? null,
      content: input.content,
      sourceTaskId: input.sourceTaskId,
      evidence: input.evidence ?? '',
      locked: input.locked ?? actor.kind === 'user',
      status: 'active',
      version: 1,
      revisions: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    memory.revisions = [
      memoryRevision(memory, {
        actor,
        reason:
          input.reason ?? (actor.kind === 'user' ? 'Created by the user' : 'Saved by the bot'),
        createdAt: stamp,
      }),
    ];
    return this.store.put('memories', memory);
  }

  private prepareMemoryUpdate(
    existing: NormalizedMemory,
    patch: MemoryPatch,
    baseVersion: number,
    actor: LearningActor,
    exclude: Set<string> = new Set([existing.id]),
    force = false,
    mergedFrom?: Array<{ id: string; version: number }>,
    restoringHistory = false,
  ): NormalizedMemory {
    this.checkVersion(existing.version, baseVersion);
    this.checkBotEdit(existing, patch, actor, false);
    if (!(restoringHistory && actor.kind === 'user')) this.checkSource(patch.sourceTaskId, actor);
    this.checkEvidence(patch, actor);
    const { reason: changeReason, ...fields } = patch;
    const updated: NormalizedMemory = {
      ...existing,
      ...fields,
      roomId: fields.roomId === undefined ? existing.roomId : fields.roomId,
      status: fields.status ?? existing.status,
      locked:
        fields.locked ??
        (actor.kind === 'user' && fields.status === 'archived' ? true : existing.locked),
      evidence: fields.evidence ?? existing.evidence,
    };
    if (!sameScope(existing, updated)) this.checkScope(updated.botId, updated.roomId);
    if (
      actor.kind === 'bot' &&
      updated.status === 'active' &&
      (normalizedLearningText(updated.content) !== normalizedLearningText(existing.content) ||
        !sameScope(existing, updated)) &&
      this.memoryDuplicate(updated, actor, exclude)
    )
      problem('An equivalent memory already exists. Merge the existing memories instead.', 409);
    if (!force && sameValue(existing, updated)) return existing;
    updated.version = existing.version + 1;
    updated.updatedAt = now();
    updated.revisions = [
      ...existing.revisions,
      memoryRevision(updated, {
        actor,
        reason:
          changeReason ?? (actor.kind === 'user' ? 'Edited by the user' : 'Updated by the bot'),
        createdAt: updated.updatedAt,
        ...(mergedFrom ? { mergedFrom } : {}),
      }),
    ];
    return updated;
  }

  updateMemory(
    key: string,
    patchValue: MemoryPatch,
    baseVersion: number,
    actorValue: LearningActor = user,
  ): NormalizedMemory {
    const patch = memoryPatchSchema.parse(patchValue);
    const actor = this.checkActor(actorValue);
    const updated = this.prepareMemoryUpdate(this.getMemory(key), patch, baseVersion, actor);
    return this.store.put('memories', updated);
  }

  restoreMemory(key: string, restoreVersion: number, baseVersion: number): NormalizedMemory {
    const existing = this.getMemory(key);
    this.checkVersion(existing.version, baseVersion);
    const revision = existing.revisions.find(
      (item) => item.version === version.parse(restoreVersion),
    );
    if (!revision) problem('This memory revision does not exist.', 404);
    const updated = this.prepareMemoryUpdate(
      existing,
      {
        content: revision.content,
        evidence: revision.evidence ?? '',
        sourceTaskId: revision.sourceTaskId,
        reason: `Restored version ${restoreVersion}`,
      },
      baseVersion,
      user,
      new Set([key]),
      true,
      undefined,
      true,
    );
    return this.store.put('memories', updated);
  }

  mergeMemories(inputValue: MemoryMergeInput, actorValue: LearningActor = user): NormalizedMemory {
    const input = memoryMergeSchema.parse(inputValue);
    const actor = this.checkActor(actorValue);
    const ids = [input.targetId, ...input.sources.map((source) => source.id)];
    if (new Set(ids).size !== ids.length)
      problem('Merge sources must be distinct from each other and the target.');
    const target = this.getMemory(input.targetId);
    const sources = input.sources.map((source) => ({
      memory: this.getMemory(source.id),
      baseVersion: source.baseVersion,
    }));
    if (target.status !== 'active' || sources.some(({ memory }) => memory.status !== 'active'))
      problem('Only active memories can be merged.', 409);
    if (sources.some(({ memory }) => !sameScope(memory, target)))
      problem('Merged memories must have the same bot and room scope.');
    const excluded = new Set(ids);
    const updated = this.prepareMemoryUpdate(
      target,
      {
        content: input.content,
        reason: input.reason,
        ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
        ...(input.sourceTaskId !== undefined ? { sourceTaskId: input.sourceTaskId } : {}),
      },
      input.baseVersion,
      actor,
      excluded,
      true,
      sources.map(({ memory }) => ({ id: memory.id, version: memory.version })),
    );
    const archived = sources.map(({ memory, baseVersion }) =>
      this.prepareMemoryUpdate(
        memory,
        {
          status: 'archived',
          reason: `Merged into ${target.id}: ${input.reason}`.slice(0, 1000),
          ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
          ...(input.sourceTaskId !== undefined ? { sourceTaskId: input.sourceTaskId } : {}),
        },
        baseVersion,
        actor,
        excluded,
      ),
    );
    this.store.db.exec('SAVEPOINT learning_merge');
    try {
      this.store.put('memories', updated);
      for (const memory of archived) this.store.put('memories', memory);
      this.store.db.exec('RELEASE SAVEPOINT learning_merge');
      return updated;
    } catch (error) {
      this.store.db.exec('ROLLBACK TO SAVEPOINT learning_merge');
      this.store.db.exec('RELEASE SAVEPOINT learning_merge');
      throw error;
    }
  }

  proposeSkill(inputValue: SkillInput, actorValue: LearningActor = user): NormalizedSkill {
    const input = skillInputSchema.parse(inputValue);
    const actor = this.checkActor(actorValue);
    this.checkCreate(input, actor);
    // Owner creation has a friendly evidence default. A bot must supply its own
    // evidence explicitly rather than inheriting that owner-authored statement.
    this.checkEvidence({ reason: input.reason, evidence: inputValue.evidence }, actor);
    if (actor.kind === 'bot' && (!input.description || !input.evidence))
      problem('Automatic skills need an applicable description and observed evidence.');
    const duplicate = this.skillDuplicate(input, actor);
    if (duplicate) {
      if (normalizedLearningText(duplicate.content) === normalizedLearningText(input.content)) {
        if (actor.kind === 'user' && (input.locked ?? true) !== duplicate.locked)
          problem(
            `This skill already exists (${duplicate.id}). Edit its current version to change the fixed setting.`,
            409,
          );
        return duplicate;
      }
      problem(
        `A skill with this name already exists (${duplicate.id}). Read and update its current version.`,
        409,
      );
    }
    const stamp = now();
    const skill: NormalizedSkill = {
      id: id('skill'),
      name: input.name,
      description: input.description,
      content: input.content,
      botId: input.botId,
      roomId: input.roomId ?? null,
      locked: input.locked ?? actor.kind === 'user',
      status: actor.kind === 'bot' ? 'active' : 'candidate',
      autoActivated: actor.kind === 'bot',
      version: 1,
      revisions: [],
      evidence: input.evidence,
      sourceTaskId: input.sourceTaskId,
      useCount: 0,
      createdAt: stamp,
      updatedAt: stamp,
    };
    skill.revisions = [
      skillRevision(skill, {
        actor,
        reason:
          input.reason ??
          (actor.kind === 'user' ? 'Created by the user' : 'Created and activated by the bot'),
        createdAt: stamp,
      }),
    ];
    return this.store.put('skills', skill);
  }

  private prepareSkillUpdate(
    existing: NormalizedSkill,
    patch: SkillPatch,
    baseVersion: number,
    actor: LearningActor,
    force = false,
    restoringHistory = false,
  ): NormalizedSkill {
    this.checkVersion(existing.version, baseVersion);
    this.checkBotEdit(existing, patch, actor, true);
    if (!(restoringHistory && actor.kind === 'user')) this.checkSource(patch.sourceTaskId, actor);
    this.checkEvidence(patch, actor);
    const { reason: changeReason, ...fields } = patch;
    const updated: NormalizedSkill = {
      ...existing,
      ...fields,
      roomId: fields.roomId === undefined ? existing.roomId : fields.roomId,
      locked:
        fields.locked ??
        (actor.kind === 'user' && fields.status && fields.status !== 'active'
          ? true
          : existing.locked),
      autoActivated:
        actor.kind === 'user' && fields.status === 'active' ? false : existing.autoActivated,
    };
    if (!sameScope(existing, updated)) this.checkScope(updated.botId, updated.roomId);
    if (actor.kind === 'bot') {
      if (this.skillDuplicate(updated, actor, existing.id))
        problem(
          'An equivalent skill already exists. Update the matching skill instead of duplicating it.',
          409,
        );
    }
    if (!force && sameValue(existing, updated)) return existing;
    updated.version = existing.version + 1;
    updated.updatedAt = now();
    updated.revisions = [
      ...existing.revisions,
      skillRevision(updated, {
        actor,
        reason:
          changeReason ?? (actor.kind === 'user' ? 'Edited by the user' : 'Updated by the bot'),
        createdAt: updated.updatedAt,
      }),
    ];
    return updated;
  }

  updateSkill(
    key: string,
    patchValue: SkillPatch,
    baseVersion: number,
    actorValue: LearningActor = user,
  ): NormalizedSkill {
    const patch = skillPatchSchema.parse(patchValue);
    const actor = this.checkActor(actorValue);
    const updated = this.prepareSkillUpdate(this.getSkill(key), patch, baseVersion, actor);
    return this.store.put('skills', updated);
  }

  restoreSkill(key: string, restoreVersion: number, baseVersion: number): NormalizedSkill {
    const existing = this.getSkill(key);
    this.checkVersion(existing.version, baseVersion);
    const revision = existing.revisions.find(
      (item) => item.version === version.parse(restoreVersion),
    );
    if (!revision) problem('This skill revision does not exist.', 404);
    const updated = this.prepareSkillUpdate(
      existing,
      {
        name: revision.name ?? existing.name,
        content: revision.content,
        description: revision.description ?? existing.description,
        evidence: revision.evidence ?? '',
        sourceTaskId: revision.sourceTaskId,
        reason: `Restored version ${restoreVersion}`,
      },
      baseVersion,
      user,
      true,
      true,
    );
    return this.store.put('skills', updated);
  }
}
