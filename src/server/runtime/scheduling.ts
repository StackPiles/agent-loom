import type {
  SchedulingGrant,
  TaskSchedulingInfo,
  TaskSchedulingSnapshot,
} from '../../shared/scheduling.js';

export type InferencePurpose = TaskSchedulingInfo['purpose'];
export type DispatchReason = NonNullable<TaskSchedulingInfo['lastDispatchReason']>;

interface TaskAccount {
  groupId: string;
  rawGroupId: string;
  purpose: InferencePurpose;
  waitingSince?: number;
  waitingOrder?: number;
  occupiedMs: number;
  lastDispatchReason?: DispatchReason;
  lastDispatchedAt?: number;
}

interface GroupAccount {
  debtMs: number;
  updatedAt: number;
  lastServiceAt?: number;
}

interface ActiveCharge {
  taskId: string;
  groupId: string;
  startedAt: number;
}

export interface SchedulingChoice {
  taskId: string;
  groupId: string;
  reason: DispatchReason;
  grant?: SchedulingGrant;
}

interface Candidate extends SchedulingChoice {
  debtMs: number;
  waitingSince: number;
  order: number;
}

export interface WorkSchedulingOptions {
  resolve?: (taskId: string) => TaskSchedulingSnapshot | undefined;
  consume?: (taskId: string, grantId: string) => boolean;
  now?: () => number;
  minimumChargeMs?: number;
  recentWindowMs?: number;
  maxDebtMs?: number;
  agingMs?: number;
  maxUrgentBurst?: number;
}

/**
 * One admission ledger for task workers and model requests. Only model-slot
 * occupancy is charged: tool/approval waits do not accumulate service debt.
 * Every kind has equal weight; explicit short-lived grants can move at most
 * two consecutive requests ahead of another eligible work group.
 */
export class WorkSchedulingLedger {
  private readonly tasks = new Map<string, TaskAccount>();
  private readonly groups = new Map<string, GroupAccount>();
  private readonly transfers = new Map<string, { debtMs: number; updatedAt: number }>();
  private readonly active = new Set<ActiveCharge>();
  private readonly declinedGrants = new Map<string, number>();
  private readonly finished = new Set<string>();
  private readonly now: () => number;
  private readonly minimumChargeMs: number;
  private readonly recentWindowMs: number;
  private readonly maxDebtMs: number;
  private readonly agingMs: number;
  private readonly maxUrgentBurst: number;
  private urgentBurst = 0;
  private lastUrgentGroup?: string;
  private lastPrunedAt = 0;
  private waitingSequence = 0;

  constructor(private readonly options: WorkSchedulingOptions = {}) {
    this.now = options.now ?? Date.now;
    this.minimumChargeMs = options.minimumChargeMs ?? 1_000;
    this.recentWindowMs = options.recentWindowMs ?? 300_000;
    this.maxDebtMs = options.maxDebtMs ?? 300_000;
    this.agingMs = options.agingMs ?? 30_000;
    this.maxUrgentBurst = options.maxUrgentBurst ?? 2;
  }

  register(taskId: string, groupId = taskId): void {
    this.prune();
    if (this.tasks.has(taskId)) return;
    this.tasks.set(taskId, {
      groupId,
      rawGroupId: groupId,
      purpose: 'response',
      occupiedMs: 0,
    });
  }

  wait(taskId: string, purpose?: InferencePurpose, since = this.now()): void {
    this.register(taskId);
    const task = this.tasks.get(taskId)!;
    if (task.waitingSince === undefined) {
      task.waitingSince = since;
      task.waitingOrder = ++this.waitingSequence;
    }
    if (purpose) task.purpose = purpose;
  }

  setPurpose(taskId: string, purpose: InferencePurpose): void {
    this.register(taskId);
    this.tasks.get(taskId)!.purpose = purpose;
  }

  clearWaiting(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.waitingSince = undefined;
      task.waitingOrder = undefined;
    }
  }

  /** Keep recent group service, but do not retain every completed task forever. */
  finish(taskId: string): void {
    if ([...this.active].some((charge) => charge.taskId === taskId)) this.finished.add(taskId);
    else this.tasks.delete(taskId);
    this.prune();
  }

  private prune(): void {
    const now = this.now();
    if (now - this.lastPrunedAt < 1_000) return;
    this.lastPrunedAt = now;
    const retained = new Set([
      ...[...this.tasks.values()].map((task) => task.groupId),
      ...[...this.active].map((charge) => charge.groupId),
    ]);
    for (const [id, group] of this.groups)
      if (!retained.has(id) && now - group.updatedAt >= this.recentWindowMs) this.groups.delete(id);
    for (const [key, transfer] of this.transfers)
      if (now - transfer.updatedAt >= this.recentWindowMs) this.transfers.delete(key);
    for (const [key, expiresAt] of this.declinedGrants)
      if (expiresAt <= now) this.declinedGrants.delete(key);
  }

  private account(groupId: string, now: number): GroupAccount {
    let group = this.groups.get(groupId);
    if (!group) {
      group = { debtMs: 0, updatedAt: now };
      this.groups.set(groupId, group);
    }
    const elapsed = Math.max(0, now - group.updatedAt);
    group.debtMs *= Math.exp(-elapsed / this.recentWindowMs);
    group.updatedAt = now;
    return group;
  }

  /** Moving a task into durable Work cannot erase its old root's service. */
  private rebind(taskId: string, from: string, to: string, now: number): string {
    if (from === to) return to;
    const source = this.account(from, now);
    const target = this.account(to, now);
    const key = JSON.stringify([from, to]);
    const prior = this.transfers.get(key);
    const copied = prior
      ? prior.debtMs * Math.exp(-Math.max(0, now - prior.updatedAt) / this.recentWindowMs)
      : 0;
    target.debtMs = Math.min(this.maxDebtMs, target.debtMs + Math.max(0, source.debtMs - copied));
    if (source.lastServiceAt !== undefined)
      target.lastServiceAt = Math.max(target.lastServiceAt ?? 0, source.lastServiceAt);
    this.transfers.set(key, { debtMs: source.debtMs, updatedAt: now });
    // A binding may cover only this task and some descendants. Keep the old
    // root's account and unrelated siblings distinct, and do not charge the
    // same inherited history again for every child entering the same Work.
    for (const active of this.active) if (active.taskId === taskId) active.groupId = to;
    return to;
  }

  private resolve(
    taskId: string,
    now: number,
  ): {
    task: TaskAccount;
    grant?: SchedulingGrant;
    grantUnavailable?: boolean;
  } {
    this.register(taskId);
    const task = this.tasks.get(taskId)!;
    const resolved = this.options.resolve?.(taskId);
    const rawGroupId = resolved?.groupId ?? task.rawGroupId;
    if (rawGroupId !== task.rawGroupId) {
      task.groupId = this.rebind(taskId, task.groupId, rawGroupId, now);
      task.rawGroupId = rawGroupId;
    }
    return { task, grant: resolved?.grant, grantUnavailable: resolved?.grantUnavailable };
  }

  private validGrant(grant: SchedulingGrant | undefined, now: number): boolean {
    return Boolean(
      grant &&
      !grant.revokedAt &&
      grant.remainingRequests > 0 &&
      Date.parse(grant.requestedAt) <= now &&
      Date.parse(grant.expiresAt) > now &&
      !this.declinedGrants.has(`${grant.id}:${grant.remainingRequests}`),
    );
  }

  private debt(groupId: string, now: number): number {
    let debt = this.account(groupId, now).debtMs;
    for (const charge of this.active) {
      if (charge.groupId === groupId)
        debt += Math.max(0, now - charge.startedAt - this.minimumChargeMs);
    }
    return Math.min(this.maxDebtMs, debt);
  }

  /** Resolve each candidate once; callers may compare different ready queues. */
  choose(taskIds: readonly string[]): SchedulingChoice | undefined {
    const now = this.now();
    const candidates: Candidate[] = [];
    const resolved = [...new Set(taskIds)].map((taskId, order) => ({
      taskId,
      order,
      ...this.resolve(taskId, now),
    }));
    // Complete identity migrations before comparing any group's debt. A child
    // encountered first must not see an empty Work account which a later
    // candidate is about to populate with its former root's service history.
    for (const { taskId, order, task, grant, grantUnavailable } of resolved) {
      candidates.push({
        taskId,
        groupId: task.groupId,
        reason: 'fair',
        grant: grantUnavailable ? undefined : grant,
        debtMs: this.debt(task.groupId, now),
        // A work group earns an aging turn, not one turn per old child. Any
        // model service resets the group's age while individual wait times
        // remain visible in diagnostics.
        waitingSince: Math.max(
          task.waitingSince ?? now,
          [...this.active].some((charge) => charge.groupId === task.groupId)
            ? now
            : (this.account(task.groupId, now).lastServiceAt ?? 0),
        ),
        order: task.waitingOrder ?? this.waitingSequence + order + 1,
      });
    }
    if (!candidates.length) return undefined;
    const otherGroups = this.lastUrgentGroup
      ? candidates.filter((candidate) => candidate.groupId !== this.lastUrgentGroup)
      : [];
    const ordinaryTurn = this.urgentBurst >= this.maxUrgentBurst && otherGroups.length > 0;
    if (!ordinaryTurn) {
      const urgent = candidates.filter((candidate) => this.validGrant(candidate.grant, now));
      urgent.sort(
        (left, right) =>
          Number(left.grant!.source === 'bot') - Number(right.grant!.source === 'bot') ||
          Date.parse(left.grant!.requestedAt) - Date.parse(right.grant!.requestedAt) ||
          left.waitingSince - right.waitingSince ||
          left.order - right.order,
      );
      if (urgent.length) return { ...urgent[0], reason: urgent[0].grant!.source };
    }
    // Other urgent groups participate in this fair turn too. Requiring an
    // unmarked task here would defeat the bound when every task is marked.
    const fair = ordinaryTurn ? otherGroups : candidates;
    const aged = fair.filter((candidate) => now - candidate.waitingSince >= this.agingMs);
    const pool = aged.length ? aged : fair;
    pool.sort((left, right) =>
      aged.length
        ? left.waitingSince - right.waitingSince ||
          left.debtMs - right.debtMs ||
          left.order - right.order
        : left.debtMs - right.debtMs ||
          left.waitingSince - right.waitingSince ||
          left.order - right.order,
    );
    return { ...pool[0], reason: aged.length ? 'waiting' : 'fair' };
  }

  /** A grant is spent only when a model slot is actually admitted. */
  dispatch(choice: SchedulingChoice): (() => void) | undefined {
    const now = this.now();
    const { task, grant, grantUnavailable } = this.resolve(choice.taskId, now);
    const boosted = choice.reason === 'owner' || choice.reason === 'bot';
    if (
      boosted &&
      (grantUnavailable || !this.validGrant(grant, now) || grant!.id !== choice.grant?.id)
    )
      return undefined;
    if (boosted && !this.options.consume) {
      this.declinedGrants.set(
        `${grant!.id}:${grant!.remainingRequests}`,
        Date.parse(grant!.expiresAt),
      );
      return undefined;
    }
    if (boosted && this.options.consume) {
      if (!this.options.consume(choice.taskId, grant!.id)) {
        this.declinedGrants.set(
          `${grant!.id}:${grant!.remainingRequests}`,
          Date.parse(grant!.expiresAt),
        );
        if (boosted) return undefined;
      }
    }
    const groupId = task.groupId;
    const group = this.account(groupId, now);
    group.debtMs = Math.min(this.maxDebtMs, group.debtMs + this.minimumChargeMs);
    group.lastServiceAt = now;
    const charge: ActiveCharge = { taskId: choice.taskId, groupId, startedAt: now };
    this.active.add(charge);
    task.waitingSince = undefined;
    task.waitingOrder = undefined;
    task.lastDispatchReason = choice.reason;
    task.lastDispatchedAt = now;
    if (boosted) {
      this.urgentBurst++;
      this.lastUrgentGroup = groupId;
    } else {
      this.urgentBurst = 0;
      this.lastUrgentGroup = undefined;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const finishedAt = this.now();
      const occupied = Math.max(0, finishedAt - charge.startedAt);
      this.active.delete(charge);
      task.occupiedMs += occupied;
      const account = this.account(charge.groupId, finishedAt);
      account.lastServiceAt = finishedAt;
      account.debtMs = Math.min(
        this.maxDebtMs,
        account.debtMs + Math.max(0, occupied - this.minimumChargeMs),
      );
      if (this.finished.has(choice.taskId)) {
        this.finished.delete(choice.taskId);
        this.finish(choice.taskId);
      }
    };
  }

  info(taskId: string, blockingTaskId?: string): TaskSchedulingInfo {
    const now = this.now();
    const { task, grant, grantUnavailable } = this.resolve(taskId, now);
    let occupiedMs = task.occupiedMs;
    for (const active of this.active)
      if (active.taskId === taskId) occupiedMs += Math.max(0, now - active.startedAt);
    return {
      taskId,
      groupId: task.groupId,
      purpose: task.purpose,
      ...(task.waitingSince === undefined
        ? {}
        : { waitingSince: new Date(task.waitingSince).toISOString() }),
      occupiedMs,
      ...(grant ? { grant } : {}),
      ...(grantUnavailable ? { grantUnavailable: true } : {}),
      ...(task.lastDispatchReason ? { lastDispatchReason: task.lastDispatchReason } : {}),
      ...(task.lastDispatchedAt === undefined
        ? {}
        : { lastDispatchedAt: new Date(task.lastDispatchedAt).toISOString() }),
      ...(blockingTaskId ? { blockingTaskId } : {}),
    };
  }
}
