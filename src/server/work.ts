import { resolve } from 'node:path';
import { z } from 'zod';
import type { Bot, Room, Task } from '../shared/types.js';
import type { MailDraft } from '../shared/mail-accounts.js';
import {
  autonomousWakeupPolicy,
  type WorkCheckpoint,
  type WorkItem,
  type Wakeup,
  type WakeupListing,
} from '../shared/work.js';
import {
  normalizeSchedule,
  onceScheduleAt,
  nextScheduleAt,
  formatScheduleInstant,
} from '../shared/schedules.js';
import type { NewTask, OperationRecord } from './runtime/contract.js';
import { id, now, type Store } from './store.js';
import type { CapturedScheduling } from './scheduling.js';

const ACTIVE = new Set<Task['status']>([
  'queued',
  'running',
  'waiting_model',
  'waiting_tool',
  'awaiting_approval',
]);
const TERMINAL = new Set<WorkItem['status']>(['completed', 'cancelled']);
const short = z.string().trim().min(1).max(160);
const note = z.string().trim().max(4_000);
export const autonomousWakeupPolicySchema = z
  .object({
    mode: z.enum(['off', 'self', 'room']),
    minIntervalMinutes: z.number().int().min(1).max(1440),
    maxPendingWakeups: z.number().int().min(1).max(200),
    maxRunsPerHour: z.number().int().min(1).max(240),
  })
  .strict();
export const workCheckpointSchema = z
  .object({
    summary: note,
    completed: note,
    nextStep: note,
    references: z.array(z.string().trim().min(1).max(1000)).max(24),
    doneWhen: z.string().trim().min(1).max(2000),
    pendingChecks: z.array(z.string().trim().min(1).max(1000)).max(24).optional(),
    uncertainActions: z.array(z.string().trim().min(1).max(1000)).max(24),
  })
  .strict();
const scheduleSchema = z.unknown().transform((value, context) => {
  try {
    return normalizeSchedule(value);
  } catch (error) {
    context.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
});
export const wakeupInputSchema = z
  .object({
    operation: z.enum(['upsert', 'cancel']),
    workId: short.optional(),
    wakeupId: short.optional(),
    key: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/)
      .optional(),
    name: short.optional(),
    purpose: z.string().trim().min(1).max(4000).optional(),
    workKind: z.enum(['task', 'standing']).optional(),
    botHandle: short.optional(),
    reason: z.string().trim().min(1).max(2000).optional(),
    prompt: z.string().trim().min(1).max(16_000).optional(),
    schedule: scheduleSchema.optional(),
    checkpoint: workCheckpointSchema.optional(),
    baseRevision: z.number().int().min(1).optional(),
  })
  .strict();
export type WakeupInput = z.infer<typeof wakeupInputSchema>;
export const workInputSchema = z
  .object({
    operation: z.enum(['update', 'complete', 'cancel']),
    workId: short,
    checkpoint: workCheckpointSchema.optional(),
    baseRevision: z.number().int().min(1).optional(),
  })
  .strict();
export type WorkInput = z.infer<typeof workInputSchema>;

function preservePendingChecks(
  checkpoint: WorkCheckpoint,
  previous?: WorkCheckpoint,
): WorkCheckpoint {
  // Older callers omit this field. An explicit empty array clears it.
  return {
    ...checkpoint,
    pendingChecks: checkpoint.pendingChecks ?? previous?.pendingChecks ?? [],
  };
}

function problem(message: string, statusCode = 409, code?: string): never {
  throw Object.assign(new Error(message), { statusCode, code });
}
function required<T>(store: Store, kind: string, key: string): T {
  return store.get<T>(kind, key) ?? problem('This work or reservation no longer exists.', 404);
}

export interface WorkHost {
  enqueueTask(task: NewTask): Task;
  stopTask(taskId: string): Promise<unknown>;
  changed(): void;
  captureScheduling?(taskId: string): CapturedScheduling;
  inheritScheduling?(taskId: string, captured: CapturedScheduling): void;
}

/** Durable jobs and reservations, separate from owner-managed integrations. */
export class WorkService {
  constructor(
    private readonly store: Store,
    private readonly host: WorkHost,
  ) {}

  private room(roomId: string): Room {
    const room = required<Room>(this.store, 'rooms', roomId);
    if (room.archived) problem('The room is archived.');
    return room;
  }
  private actor(taskId: string, requirePermission = true) {
    const task = required<Task>(this.store, 'tasks', taskId);
    const room = this.room(task.roomId);
    const bot = required<Bot>(this.store, 'bots', task.botId);
    if (task.kind === 'learning' || !bot.enabled || !room.botIds.includes(bot.id))
      problem('An enabled member of this room must request the wake-up.');
    if (!ACTIVE.has(task.status)) problem('This task has stopped; it cannot change future work.');
    if (requirePermission && autonomousWakeupPolicy(room.autonomousWakeups).mode === 'off')
      problem(
        'Autonomous wake-ups are disabled. The owner can enable them in this room’s settings.',
      );
    if (requirePermission && room.paused) problem('This room is paused.');
    return { task, room, bot, policy: autonomousWakeupPolicy(room.autonomousWakeups) };
  }
  private workspace(room: Room) {
    return resolve(room.workspacePath || this.store.settings().workspacePath);
  }
  private workFor(task: Task, workId: string): WorkItem {
    const work = required<WorkItem>(this.store, 'workItems', workId);
    if (work.roomId !== task.roomId || (task.workId && task.workId !== work.id))
      problem('Work must belong to the current room and task. Do not replace its work identity.');
    if (!task.workId && work.createdByBotId !== task.botId)
      problem('Only this work’s creator or one of its assigned tasks can manage its reservations.');
    return work;
  }
  private current(work: WorkItem, room: Room) {
    if (work.status !== 'active')
      problem(`This work is ${work.status}. The owner must review it before it can continue.`);
    if (work.workspacePath !== this.workspace(room))
      problem('The room’s workspace changed. Review this work in its original workspace.');
    if (work.checkpoint.uncertainActions.length)
      problem(
        'This work contains operations with an uncertain outcome. Review their real status before continuing.',
      );
    const author = this.store.get<Bot>('bots', work.createdByBotId);
    if (!author?.enabled || !room.botIds.includes(author.id))
      problem('The creator is no longer an enabled member of this room.');
  }

  assertTask(taskId: string, allowFinalResponse = false): void {
    const task = required<Task>(this.store, 'tasks', taskId);
    if (!task.workId || task.kind === 'learning') return;
    const work = this.workFor(task, task.workId);
    if (
      allowFinalResponse &&
      (TERMINAL.has(work.status) || work.status === 'blocked') &&
      work.finishedByTaskId === task.id
    )
      return;
    const { room, policy } = this.actor(taskId);
    this.current(work, room);
    if (policy.mode === 'self' && task.wakeupId) {
      const wake = this.store.get<Wakeup>('wakeups', task.wakeupId);
      if (wake && (wake.botId !== wake.createdByBotId || wake.botId !== work.createdByBotId))
        problem('This cross-bot wake-up is no longer allowed by the room policy.');
    }
  }

  list(taskId: string, workId?: string): WakeupListing {
    const { task, policy } = this.actor(taskId, false);
    const workItems = this.store
      .list<WorkItem>('workItems')
      .filter((work) => work.roomId === task.roomId && (!workId || work.id === workId));
    if (workId && !workItems.length) problem('No work with that ID exists in this room.', 404);
    const ids = new Set(workItems.map((work) => work.id));
    return {
      currentTimeUtc: now(),
      policy,
      workItems,
      wakeups: this.store.list<Wakeup>('wakeups').filter((wake) => ids.has(wake.workId)),
    };
  }

  private bind(task: Task, work: WorkItem, runId: string) {
    // A delegated task owns its continuation, never its parent or siblings.
    // Include its existing descendants/receipts, but leave a descendant's
    // independently established work and that subtree intact.
    const candidates = this.store
      .list<Task>('tasks')
      .filter(
        (candidate) =>
          candidate.roomId === task.roomId &&
          candidate.rootTaskId === task.rootTaskId &&
          candidate.kind !== 'learning',
      );
    const pending = [task.id];
    const seen = new Set<string>();
    const selected: Task[] = [];
    while (pending.length) {
      const taskId = pending.shift()!;
      if (seen.has(taskId)) continue;
      seen.add(taskId);
      const candidate = candidates.find((item) => item.id === taskId);
      if (!candidate) continue;
      if (candidate.workId && candidate.workId !== work.id) {
        if (candidate.id === task.id) problem('This task already belongs to another work item.');
        continue;
      }
      selected.push(candidate);
      pending.push(
        ...candidates.filter((item) => item.parentTaskId === candidate.id).map((item) => item.id),
      );
    }
    const lineage = new Set(selected.map((candidate) => candidate.id));
    let ancestor = task.parentTaskId;
    while (ancestor && !lineage.has(ancestor)) {
      lineage.add(ancestor);
      ancestor = candidates.find((candidate) => candidate.id === ancestor)?.parentTaskId;
    }
    if (this.unreviewedMail(lineage).length)
      problem(
        'This task lineage has an unreviewed unknown mail delivery. Ask the owner to inspect its draft before scheduling a continuation.',
      );
    const scheduling = this.host.captureScheduling?.(task.id);
    for (const candidate of selected)
      this.store.patch<Task>('tasks', candidate.id, { workId: work.id, workRunId: runId });
    if (scheduling) this.host.inheritScheduling?.(task.id, scheduling);
  }

  private unreviewedMail(taskIds: ReadonlySet<string>): OperationRecord[] {
    return this.store
      .list<OperationRecord>('operations')
      .filter(
        (operation) =>
          taskIds.has(operation.taskId) &&
          operation.uncertainty?.kind === 'mail' &&
          !operation.uncertainty.reviewedAt,
      );
  }

  /** Persist only a verified connector outcome, including before a work exists. */
  recordUncertainMail(taskId: string, operationKey: string, draftId: string): void {
    const task = required<Task>(this.store, 'tasks', taskId);
    const operation = this.store.get<OperationRecord>('operations', operationKey);
    const draft = this.store.get<MailDraft>('mailDrafts', draftId);
    if (
      !operation ||
      operation.taskId !== task.id ||
      operation.toolName !== 'send_mail' ||
      operation.args.draftId !== draftId ||
      !draft ||
      (draft.botId && draft.botId !== task.botId) ||
      draft.status !== 'unknown' ||
      operation.args.expectedRevision !== draft.revision
    )
      problem('No matching server-recorded unknown mail operation exists for this task.', 400);
    if (operation.uncertainty?.reviewedAt) return;
    const work = task.workId ? this.store.get<WorkItem>('workItems', task.workId) : undefined;
    const reference =
      `Unconfirmed email delivery: inspect draft ${draft.id} and operation ${operation.key} before retrying.`.slice(
        0,
        1000,
      );
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.patch<OperationRecord & { id: string }>('operations', operationKey, {
        uncertainty: { kind: 'mail', draftId },
      });
      if (work && work.roomId === task.roomId && !TERMINAL.has(work.status)) {
        const room = this.store.get<Room>('rooms', work.roomId);
        const bot = this.store.get<Bot>('bots', task.botId);
        const canReport =
          ACTIVE.has(task.status) &&
          bot?.enabled &&
          room &&
          !room.archived &&
          !room.paused &&
          room.botIds.includes(task.botId) &&
          autonomousWakeupPolicy(room.autonomousWakeups).mode !== 'off' &&
          work.workspacePath === this.workspace(room) &&
          work.status !== 'paused';
        const notes = work.checkpoint.uncertainActions;
        // Keep every existing note if the UI limit is full; the new reference
        // remains in lastError and its durable operation marker in that case.
        const uncertainActions =
          notes.includes(reference) || notes.length >= 24 ? notes : [...notes, reference];
        this.patchWork(work, {
          checkpoint: { ...work.checkpoint, uncertainActions },
          ...(work.status === 'active' || work.status === 'blocked'
            ? { status: 'blocked' as const }
            : {}),
          ...(canReport ? { finishedByTaskId: task.id } : {}),
          lastError: reference,
        });
      }
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    this.host.changed();
  }

  manageWakeup(taskId: string, raw: WakeupInput): { work: WorkItem; wakeup: Wakeup } {
    const input = wakeupInputSchema.parse(raw);
    const { task, room, bot, policy } = this.actor(taskId);
    this.assertTask(taskId);
    const existingById = input.wakeupId
      ? required<Wakeup>(this.store, 'wakeups', input.wakeupId)
      : undefined;
    const workId = input.workId ?? task.workId ?? existingById?.workId;
    let work = workId ? this.workFor(task, workId) : undefined;
    if (existingById && (existingById.roomId !== room.id || existingById.workId !== work?.id))
      problem('This reservation does not belong to the current work and room.');
    if (work) this.current(work, room);
    if (input.operation === 'cancel') {
      if (!work || !existingById) problem('Choose an existing wakeupId to cancel.');
      if (existingById.createdByBotId !== bot.id)
        problem('You can cancel only reservations you created.');
      if (
        Object.keys(input).some(
          (key) => !['operation', 'workId', 'wakeupId', 'baseRevision'].includes(key),
        )
      )
        problem('Cancel accepts only workId, wakeupId and baseRevision.');
      this.checkRevision(existingById.revision, input.baseRevision);
      const wakeup = this.cancelWakeup(existingById.id, 'bot');
      return { work, wakeup };
    }
    const handle = input.botHandle?.replace(/^@/, '').toLowerCase();
    const target = handle
      ? this.store
          .list<Bot>('bots')
          .find((candidate) => candidate.handle.replace(/^@/, '').toLowerCase() === handle)
      : existingById
        ? this.store.get<Bot>('bots', existingById.botId)
        : bot;
    if (!target?.enabled || !room.botIds.includes(target.id))
      problem('Choose an enabled bot in this room.');
    if (
      policy.mode === 'self' &&
      (target.id !== bot.id || (work && target.id !== work.createdByBotId))
    )
      problem('This room allows only the original creator to schedule its own wake-ups.');
    const key = input.key ?? existingById?.key;
    if (!key)
      problem(
        'Provide a stable key for this next step; reuse it when changing the same reservation.',
      );
    const existing =
      existingById ??
      (work
        ? this.store
            .list<Wakeup>('wakeups')
            .find(
              (wake) =>
                wake.workId === work!.id &&
                wake.createdByBotId === bot.id &&
                wake.botId === target.id &&
                wake.key === key,
            )
        : undefined);
    if (existing && existing.createdByBotId !== bot.id)
      problem('You can change only reservations you created.');
    if (existing?.cancelledBy === 'owner')
      problem(
        'The owner cancelled this reservation. Do not recreate it; request a new explicit instruction.',
      );
    if (existing && (existing.key !== key || existing.botId !== target.id))
      problem(
        'Keep this reservation’s key and target. Cancel it explicitly before changing the target.',
      );
    if (existing) this.checkRevision(existing.revision, input.baseRevision);
    const schedule = input.schedule ?? existing?.schedule;
    if (!schedule)
      problem('Provide an explicit one-time, daily or weekday schedule with a time zone.');
    const normalized = normalizeSchedule(schedule);
    const nextRunAt =
      normalized.type === 'once'
        ? onceScheduleAt(normalized)
        : nextScheduleAt(normalized, Date.now());
    if (!nextRunAt) problem('The schedule has no future occurrence.');
    if (Date.parse(nextRunAt) < Date.now() + policy.minIntervalMinutes * 60_000)
      problem(
        `The next wake-up must be at least ${policy.minIntervalMinutes} minute(s) in the future.`,
      );
    const reason = input.reason ?? existing?.reason;
    const prompt = input.prompt ?? existing?.prompt;
    if (!reason || !prompt)
      problem('Provide the reason for waiting and the concrete work to perform on wake-up.');
    if (!work && (!input.name || !input.purpose || !input.checkpoint))
      problem(
        'New work requires name, purpose and a complete checkpoint, including its completion condition.',
      );
    if (work && input.checkpoint)
      problem(
        'Checkpoints in manage_wakeup are only for new work. Update an existing checkpoint with manage_work and its current baseRevision.',
      );
    if (input.checkpoint?.uncertainActions.length)
      problem(
        'Resolve uncertain operations through the owner before scheduling more work; save them with manage_work.',
      );
    if (work && ['name', 'purpose', 'workKind'].some((field) => field in input))
      problem(
        'Existing work keeps its original name, purpose and type. Update its checkpoint instead.',
      );
    const scheduled = this.store
      .list<Wakeup>('wakeups')
      .filter((wake) => wake.roomId === room.id && wake.status === 'scheduled');
    if (
      (!existing || existing.status !== 'scheduled') &&
      scheduled.length >= policy.maxPendingWakeups
    )
      problem(
        'This room has reached its pending wake-up limit. Update or cancel an existing reservation.',
      );
    if (
      !work &&
      this.store
        .list<WorkItem>('workItems')
        .filter((item) => item.roomId === room.id && !TERMINAL.has(item.status)).length >=
        policy.maxPendingWakeups
    )
      problem('This room has reached its active work limit. Finish an existing work item first.');
    const stamp = now();
    const runId = task.workRunId ?? task.rootTaskId;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      if (!work) {
        work = this.store.put<WorkItem>('workItems', {
          id: id('work'),
          roomId: room.id,
          name: input.name!,
          purpose: input.purpose!,
          kind: input.workKind ?? 'task',
          status: 'active',
          createdByBotId: bot.id,
          sourceTaskId: task.id,
          scope: `${room.description}\n${bot.role}`.trim(),
          workspacePath: this.workspace(room),
          checkpoint: preservePendingChecks(input.checkpoint!),
          revision: 1,
          createdAt: stamp,
          updatedAt: stamp,
        });
        this.bind(task, work, runId);
      } else {
        if (!task.workId) this.bind(task, work, runId);
      }
      const wakeup = this.store.put<Wakeup>('wakeups', {
        ...existing,
        id: existing?.id ?? id('wake'),
        workId: work.id,
        roomId: room.id,
        botId: target.id,
        createdByBotId: bot.id,
        sourceTaskId: task.id,
        key,
        reason,
        prompt,
        schedule: normalized,
        status: 'scheduled',
        nextRunAt,
        workRunId: task.workRunId ?? runId,
        retryAfter: undefined,
        lastError: undefined,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? stamp,
        updatedAt: stamp,
      });
      this.store.db.exec('COMMIT');
      this.host.changed();
      return { work, wakeup };
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      this.host.changed();
      throw error;
    }
  }

  private checkRevision(actual: number, supplied?: number) {
    if (supplied === undefined)
      problem('Read the current record and supply its baseRevision before changing it.');
    if (actual !== supplied) problem('This record changed. Read it again before updating.');
  }
  private patchWork(work: WorkItem, patch: Partial<WorkItem>) {
    return this.store.patch<WorkItem>('workItems', work.id, {
      ...patch,
      revision: work.revision + 1,
      updatedAt: now(),
    });
  }
  cancelWakeup(wakeupId: string, actor: 'owner' | 'bot' = 'owner'): Wakeup {
    const wake = required<Wakeup>(this.store, 'wakeups', wakeupId);
    const updated = this.store.patch<Wakeup>('wakeups', wake.id, {
      status: 'cancelled',
      nextRunAt: undefined,
      retryAfter: undefined,
      cancelledBy: wake.cancelledBy === 'owner' ? 'owner' : actor,
      revision: wake.revision + 1,
      updatedAt: now(),
    });
    this.host.changed();
    return updated;
  }

  async manageWork(taskId: string, raw: WorkInput): Promise<WorkItem> {
    const input = workInputSchema.parse(raw);
    const { task, room } = this.actor(taskId);
    this.assertTask(taskId);
    const work = this.workFor(task, input.workId);
    this.current(work, room);
    if (work.createdByBotId !== task.botId)
      problem('Only the creator can change or close the whole work item.');
    this.checkRevision(work.revision, input.baseRevision);
    if (input.operation === 'update') {
      if (!input.checkpoint) problem('Provide a complete progress checkpoint.');
      const updated = this.patchWork(work, {
        checkpoint: preservePendingChecks(input.checkpoint, work.checkpoint),
        ...(input.checkpoint.uncertainActions.length
          ? {
              status: 'blocked' as const,
              finishedByTaskId: taskId,
              lastError: 'An operation has an uncertain outcome. Review it before continuing.',
            }
          : {}),
      });
      this.host.changed();
      return updated;
    }
    if (input.operation === 'complete' && input.checkpoint?.uncertainActions.length)
      problem(
        'Save the uncertain operations as a checkpoint and request review before completing this work.',
      );
    if (input.checkpoint)
      this.patchWork(work, {
        checkpoint: preservePendingChecks(input.checkpoint, work.checkpoint),
      });
    return this.changeStatus(
      work.id,
      input.operation === 'complete' ? 'completed' : 'cancelled',
      taskId,
    );
  }

  async changeStatus(
    workId: string,
    status: 'paused' | 'cancelled' | 'completed',
    finishingTaskId?: string,
  ): Promise<WorkItem> {
    const work = required<WorkItem>(this.store, 'workItems', workId);
    if (TERMINAL.has(work.status)) return work;
    const updated = this.patchWork(work, {
      status,
      finishedByTaskId: finishingTaskId,
      lastError: undefined,
    });
    if (status !== 'paused') {
      for (const wake of this.store.list<Wakeup>('wakeups'))
        if (wake.workId === work.id && wake.status === 'scheduled') this.cancelWakeup(wake.id);
    }
    // Record revocation before any await so no queued task or concurrent tool can escape.
    this.host.changed();
    await Promise.allSettled(
      this.store
        .list<Task>('tasks')
        .filter(
          (task) =>
            task.workId === work.id && task.id !== finishingTaskId && ACTIVE.has(task.status),
        )
        .map((task) => this.host.stopTask(task.id)),
    );
    return updated;
  }

  resume(workId: string, checkpoint?: WorkCheckpoint): WorkItem {
    let work = required<WorkItem>(this.store, 'workItems', workId);
    const room = this.room(work.roomId);
    if (!['paused', 'blocked'].includes(work.status))
      problem('Only paused or blocked work can be resumed.');
    const policy = autonomousWakeupPolicy(room.autonomousWakeups);
    if (policy.mode === 'off') problem('Enable autonomous wake-ups in the room first.');
    if (room.paused) problem('Resume the room before resuming this work.');
    if (work.workspacePath !== this.workspace(room))
      problem('Restore this work’s original workspace before resuming.');
    const creator = this.store.get<Bot>('bots', work.createdByBotId);
    if (!creator?.enabled || !room.botIds.includes(creator.id))
      problem('Enable this work’s creator and restore its room membership before resuming.');
    for (const wake of this.store.list<Wakeup>('wakeups')) {
      if (wake.workId !== work.id || wake.status !== 'scheduled') continue;
      if (wake.roomId !== room.id)
        problem(
          `Reservation ${wake.id} belongs to a different room. Cancel it before resuming this work.`,
        );
      const author = this.store.get<Bot>('bots', wake.createdByBotId);
      const target = this.store.get<Bot>('bots', wake.botId);
      if (
        !author?.enabled ||
        !target?.enabled ||
        !room.botIds.includes(author.id) ||
        !room.botIds.includes(target.id)
      )
        problem(
          `Reservation ${wake.id} needs an enabled author and target in this room. Restore their membership or cancel that reservation before resuming.`,
        );
      if (policy.mode === 'self' && (target.id !== author.id || target.id !== work.createdByBotId))
        problem(
          `Reservation ${wake.id} conflicts with the room’s self-only wake-up policy. Cancel it or allow teammate wake-ups before resuming this work.`,
        );
    }
    const reviewedCheckpoint = checkpoint
      ? preservePendingChecks(workCheckpointSchema.parse(checkpoint), work.checkpoint)
      : work.checkpoint;
    if (reviewedCheckpoint.uncertainActions.length)
      problem('Review and clear the checkpoint’s uncertain actions before resuming.');
    const operations = this.unreviewedMail(
      new Set(
        this.store
          .list<Task>('tasks')
          .filter((task) => task.workId === work.id)
          .map((task) => task.id),
      ),
    );
    if (operations.length && !checkpoint)
      problem(
        'Review the unknown mail deliveries and explicitly provide a cleared checkpoint before resuming.',
      );
    const reviewedAt = now();
    let updated: WorkItem;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      updated = this.patchWork(work, {
        checkpoint: reviewedCheckpoint,
        status: 'active',
        lastError: undefined,
        finishedByTaskId: undefined,
        reviewedAt,
      });
      for (const operation of operations)
        this.store.patch<OperationRecord & { id: string }>('operations', operation.key, {
          uncertainty: { ...operation.uncertainty!, reviewedAt },
        });
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    this.host.changed();
    return updated;
  }

  taskSettled(task: Task, recovering = false): void {
    if (!task.workId || !['failed', 'stopped', 'interrupted'].includes(task.status)) return;
    const work = this.store.get<WorkItem>('workItems', task.workId);
    if (!work || work.status !== 'active') return;
    // Only startup revisits historical failures. A live failure is new even
    // when a frozen/coarse clock gives it the same timestamp as owner review.
    if (recovering && work.reviewedAt && Date.parse(task.updatedAt) <= Date.parse(work.reviewedAt))
      return;
    this.patchWork(work, {
      status: 'blocked',
      lastError: `Task ${task.id} ${task.status}. Review its results and resume explicitly before continuing.`,
    });
  }

  assertAdmission(
    input: NewTask,
    parent?: Task,
    resumingTaskId?: string,
  ): { workId?: string; workRunId?: string; wakeupId?: string } {
    if (input.kind === 'learning') return {};
    const workId = parent?.workId ?? input.workId;
    if (!workId) return {};
    if (parent?.workId && input.workId && parent.workId !== input.workId)
      problem('A handoff cannot change its work identity.');
    const work = required<WorkItem>(this.store, 'workItems', workId);
    const room = this.room(input.roomId);
    if (work.roomId !== room.id) problem('A work item cannot cross room boundaries.');
    const policy = autonomousWakeupPolicy(room.autonomousWakeups);
    if (policy.mode === 'off') problem('Autonomous wake-ups are disabled for this room.');
    this.current(work, room);
    const workRunId = parent?.workRunId ?? input.workRunId;
    if (!workRunId) problem('A work occurrence is required.');
    if (resumingTaskId) {
      const existing = required<Task>(this.store, 'tasks', resumingTaskId);
      if (
        existing.workId !== workId ||
        existing.workRunId !== workRunId ||
        existing.roomId !== input.roomId ||
        existing.botId !== input.botId ||
        existing.wakeupId !== input.wakeupId
      )
        problem('Explicit recovery must preserve the task’s work, occurrence, room and bot.');
      if (policy.mode === 'self' && existing.wakeupId) {
        const wake = this.store.get<Wakeup>('wakeups', existing.wakeupId);
        if (wake && (wake.botId !== wake.createdByBotId || wake.botId !== work.createdByBotId))
          problem('This cross-bot wake-up is no longer allowed by the room policy.');
      }
      // An existing task keeps its receipts and occurrence. Owner recovery does
      // not add another task to either admission counter.
      return { workId, workRunId, ...(input.wakeupId ? { wakeupId: input.wakeupId } : {}) };
    }
    const handoffLimit = this.store.settings().maxHandoffs;
    if (work.kind === 'task' && handoffLimit !== null) {
      const runs = this.store
        .list<Task>('tasks')
        .filter(
          (task) =>
            task.roomId === room.id &&
            task.kind !== 'learning' &&
            (task.workRunId === workRunId || task.rootTaskId === workRunId),
        );
      if (runs.length >= handoffLimit + 1)
        problem(
          'This work occurrence reached its task and handoff limit. Review the work before starting a new occurrence.',
          409,
          'work_chain_limit',
        );
    }
    const recent = this.store
      .list<Task>('tasks')
      .filter(
        (task) =>
          task.workId &&
          task.roomId === room.id &&
          task.kind !== 'learning' &&
          Date.parse(task.createdAt) > Date.now() - 3_600_000,
      );
    if (recent.length >= policy.maxRunsPerHour)
      problem(
        'This room’s hourly autonomous execution limit was reached. The next reservation will wait.',
        429,
        'work_rate_limit',
      );
    return { workId, workRunId, ...(input.wakeupId ? { wakeupId: input.wakeupId } : {}) };
  }

  tick(): void {
    const stamp = Date.now();
    const wakeups = this.store.list<Wakeup>('wakeups');
    const lastRoomRun = new Map<string, number>();
    for (const wake of wakeups) {
      const previous = Date.parse(wake.lastRunAt ?? '');
      if (Number.isFinite(previous))
        lastRoomRun.set(wake.roomId, Math.max(lastRoomRun.get(wake.roomId) ?? 0, previous));
    }
    // A recurring record keeps its creation time after every dispatch. Serving
    // creation order lets it repeatedly take a room's next slot before an older
    // unserved occurrence. Order eligible candidates by their reserved instant;
    // keep creation time and identity as stable ties, including after restart.
    const pending = wakeups
      .filter((wake) => wake.status === 'scheduled' && wake.nextRunAt)
      .sort((left, right) => {
        const leftDue = Date.parse(left.nextRunAt!);
        const rightDue = Date.parse(right.nextRunAt!);
        return (
          (Number.isFinite(leftDue) ? leftDue : Infinity) -
            (Number.isFinite(rightDue) ? rightDue : Infinity) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id)
        );
      });
    for (const wake of pending) {
      if (
        wake.status !== 'scheduled' ||
        !wake.nextRunAt ||
        Date.parse(wake.nextRunAt) > stamp ||
        (wake.retryAfter && Date.parse(wake.retryAfter) > stamp)
      )
        continue;
      const work = this.store.get<WorkItem>('workItems', wake.workId);
      const room = this.store.get<Room>('rooms', wake.roomId);
      if (!work || work.status !== 'active' || !room || room.paused || room.archived) continue;
      const policy = autonomousWakeupPolicy(room.autonomousWakeups);
      if (policy.mode === 'off') continue;
      try {
        this.current(work, room);
        const target = this.store.get<Bot>('bots', wake.botId);
        const author = this.store.get<Bot>('bots', wake.createdByBotId);
        if (
          !target?.enabled ||
          !author?.enabled ||
          !room.botIds.includes(target.id) ||
          !room.botIds.includes(author.id)
        )
          problem('The wake-up target or author is no longer an enabled room member.');
        if (
          policy.mode === 'self' &&
          (target.id !== author.id || target.id !== work.createdByBotId)
        )
          problem('The room no longer allows this cross-bot reservation.');
        const tasks = this.store.list<Task>('tasks');
        const source = this.store.get<Task>('tasks', wake.sourceTaskId);
        if (
          source &&
          ['failed', 'stopped', 'interrupted'].includes(source.status) &&
          (!work.reviewedAt || Date.parse(source.updatedAt) > Date.parse(work.reviewedAt))
        )
          problem(
            'The preceding task did not finish. Review and resume that task before continuing.',
          );
        const busy = tasks.some((task) => task.workId === work.id && ACTIVE.has(task.status));
        const previous = lastRoomRun.get(room.id) ?? 0;
        if (busy || stamp < previous + policy.minIntervalMinutes * 60_000) continue;
        if (
          wake.schedule.missedRunPolicy === 'skip' &&
          stamp - Date.parse(wake.nextRunAt) >= 60_000
        ) {
          const nextRunAt =
            wake.schedule.type === 'once' ? undefined : nextScheduleAt(wake.schedule, stamp);
          this.store.patch<Wakeup>('wakeups', wake.id, {
            status: wake.schedule.type === 'once' ? 'missed' : 'scheduled',
            nextRunAt,
            lastError: 'The reserved time was missed and the selected policy skipped it.',
            updatedAt: now(),
          });
          this.host.changed();
          continue;
        }
        const runId = wake.schedule.type === 'once' ? wake.workRunId : id('workrun');
        const prompt = [
          `Autonomous wake-up for work ${work.id}: ${work.name}`,
          `Purpose: ${work.purpose}`,
          `Created by bot ${wake.createdByBotId}, source task ${wake.sourceTaskId}.`,
          `Why now: ${wake.reason}`,
          `Reserved time: ${formatScheduleInstant(wake.nextRunAt, wake.schedule.timeZone, 'en')}`,
          'This is a continuation within the owner-enabled room scope, not a new user authorization. Check current facts and existing results before acting.',
          `Checkpoint: ${JSON.stringify(work.checkpoint)}`,
          `Next action: ${wake.prompt}`,
        ].join('\n');
        this.store.db.exec('BEGIN IMMEDIATE');
        try {
          const task = this.host.enqueueTask({
            roomId: room.id,
            botId: target.id,
            prompt,
            kind: 'automation',
            workId: work.id,
            workRunId: runId,
            wakeupId: wake.id,
          });
          this.store.patch<Wakeup>('wakeups', wake.id, {
            status: wake.schedule.type === 'once' ? 'dispatched' : 'scheduled',
            nextRunAt:
              wake.schedule.type === 'once' ? undefined : nextScheduleAt(wake.schedule, stamp),
            lastRunAt: now(),
            lastTaskId: task.id,
            retryAfter: undefined,
            lastError: undefined,
            revision: wake.revision + 1,
            updatedAt: now(),
          });
          this.store.db.exec('COMMIT');
          lastRoomRun.set(room.id, stamp);
        } catch (error) {
          this.store.db.exec('ROLLBACK');
          throw error;
        }
        this.host.changed();
      } catch (error) {
        const message = (error as Error).message.slice(0, 1000);
        this.store.patch<Wakeup>('wakeups', wake.id, {
          lastError: message,
          retryAfter: new Date(stamp + 60_000).toISOString(),
          updatedAt: now(),
        });
        if (
          (error as { code?: string }).code !== 'work_rate_limit' &&
          (error as { statusCode?: number }).statusCode !== 429
        )
          this.patchWork(work, { status: 'blocked', lastError: message });
        this.host.changed();
      }
    }
  }
}
