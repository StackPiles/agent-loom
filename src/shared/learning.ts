import type { LearningActor, Memory, MemoryRevision, Skill, SkillRevision } from './types.js';

export type { LearningActor } from './types.js';

export interface MemoryInput {
  botId: string | null;
  content: string;
  sourceTaskId?: string;
  replacesId?: string;
  baseVersion?: number;
  roomId?: string | null;
  locked?: boolean;
  evidence?: string;
  reason?: string;
}

export interface SkillInput {
  name: string;
  description: string;
  content: string;
  botId: string | null;
  evidence: string;
  sourceTaskId?: string;
  roomId?: string | null;
  locked?: boolean;
  reason?: string;
}

export type MemoryPatch = Partial<
  Pick<Memory, 'content' | 'botId' | 'roomId' | 'locked' | 'status' | 'evidence' | 'sourceTaskId'>
> & { reason?: string };
export type SkillPatch = Partial<
  Pick<
    Skill,
    | 'name'
    | 'description'
    | 'content'
    | 'botId'
    | 'roomId'
    | 'locked'
    | 'status'
    | 'evidence'
    | 'sourceTaskId'
  >
> & { reason?: string };

export interface MemoryMergeInput {
  targetId: string;
  baseVersion: number;
  content: string;
  sources: Array<{ id: string; baseVersion: number }>;
  reason: string;
  evidence?: string;
  sourceTaskId?: string;
}

export type NormalizedMemory = Memory &
  Required<Pick<Memory, 'version' | 'status' | 'roomId' | 'locked' | 'evidence' | 'revisions'>>;
export type NormalizedSkill = Skill & Required<Pick<Skill, 'roomId' | 'locked' | 'autoActivated'>>;

export function normalizedLearningText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Read old records without rewriting them or claiming unknown authorship. */
export function normalizeMemory(memory: Memory): NormalizedMemory {
  const version =
    Number.isSafeInteger(memory.version) && (memory.version ?? 0) > 0 ? memory.version! : 1;
  const normalized: NormalizedMemory = {
    ...memory,
    botId: memory.botId ?? null,
    roomId: memory.roomId ?? null,
    version,
    status: memory.status ?? 'active',
    // Older bot-owned memories were editable; preserve that existing behavior.
    // New owner-authored records explicitly set locked=true when created.
    locked: memory.locked ?? false,
    evidence: memory.evidence ?? '',
    revisions: [...(memory.revisions ?? [])],
  };
  const current = memoryRevision(normalized, {
    reason: 'Preserved existing memory',
    createdAt: memory.updatedAt ?? memory.createdAt,
  });
  const currentIndex = normalized.revisions.findIndex((revision) => revision.version === version);
  if (currentIndex < 0) normalized.revisions.push(current);
  else normalized.revisions[currentIndex] = { ...current, ...normalized.revisions[currentIndex] };
  return normalized;
}

export function normalizeSkill(skill: Skill): NormalizedSkill {
  const history = [...(skill.revisions ?? [])];
  const botOnlyHistory =
    Boolean(skill.sourceTaskId) &&
    history.length > 0 &&
    history.every(
      (revision) => revision.actor?.kind === 'bot' || revision.reason === 'Proposed after a task',
    );
  const normalized: NormalizedSkill = {
    ...skill,
    botId: skill.botId ?? null,
    roomId: skill.roomId ?? null,
    locked: skill.locked ?? !botOnlyHistory,
    autoActivated: skill.autoActivated ?? false,
    version: Number.isSafeInteger(skill.version) && skill.version > 0 ? skill.version : 1,
    evidence: skill.evidence ?? '',
    revisions: history,
  };
  const current = skillRevision(normalized, {
    reason: 'Preserved existing skill',
    createdAt: skill.updatedAt ?? skill.createdAt,
  });
  const currentIndex = history.findIndex((revision) => revision.version === normalized.version);
  if (currentIndex < 0) normalized.revisions.push(current);
  else normalized.revisions[currentIndex] = { ...current, ...normalized.revisions[currentIndex] };
  return normalized;
}

interface RevisionContext {
  reason: string;
  createdAt: string;
  actor?: LearningActor;
}

export function memoryRevision(
  memory: NormalizedMemory,
  context: RevisionContext & { mergedFrom?: MemoryRevision['mergedFrom'] },
): MemoryRevision {
  return {
    version: memory.version,
    content: memory.content,
    botId: memory.botId,
    roomId: memory.roomId,
    status: memory.status,
    locked: memory.locked,
    evidence: memory.evidence,
    sourceTaskId: memory.sourceTaskId,
    ...context,
  };
}

export function skillRevision(skill: NormalizedSkill, context: RevisionContext): SkillRevision {
  return {
    version: skill.version,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    botId: skill.botId,
    roomId: skill.roomId,
    status: skill.status,
    locked: skill.locked,
    evidence: skill.evidence,
    sourceTaskId: skill.sourceTaskId,
    ...context,
  };
}

export function learningVisible(
  item: { botId: string | null; roomId?: string | null },
  botId: string,
  roomId: string,
): boolean {
  return (!item.botId || item.botId === botId) && (!item.roomId || item.roomId === roomId);
}
