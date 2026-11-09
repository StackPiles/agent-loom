import { z } from 'zod';
import {
  BOT_PRIORITY_REQUESTS,
  OWNER_PRIORITY_REQUESTS,
  PRIORITY_WINDOW_MS,
  isTaskScheduling,
  type SchedulingGrant,
  type TaskSchedulingSnapshot,
} from '../shared/scheduling.js';
import type { Task } from '../shared/types.js';
import { id, now, type Store } from './store.js';

export const priorityRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    deadlineAt: z.string().max(80).datetime({ offset: true }).optional(),
  })
  .strict();
export type PriorityRequest = z.infer<typeof priorityRequestSchema>;

const spentRequests = (grant: SchedulingGrant): number =>
  Math.max(grant.consumedRequests ?? 0, grant.grantedRequests - grant.remainingRequests);

interface GrantHolder {
  task: Task;
  grant: SchedulingGrant;
  retired?: boolean;
}
interface GroupResolution {
  groupId: string;
  holder?: GrantHolder;
}
interface SchedulingIndex {
  tasks: Map<string, Task>;
  groups: Map<string, Task[]>;
}
export interface CapturedScheduling extends TaskSchedulingSnapshot {
  holderTaskId?: string;
  memberTaskIds?: string[];
}

/** Short, durable work-level preferences. No grant changes task permissions or lifecycle. */
export class SchedulingService {
  private index?: SchedulingIndex;
  private resolutions = new Map<string, GroupResolution>();

  constructor(
    private readonly store: Store,
    private readonly options: {
      assertEligible(taskId: string): Task;
      changed(): void;
    },
  ) {}

  invalidate(): void {
    this.index = undefined;
    this.resolutions.clear();
  }

  private groupId(task: Task): string {
    return task.workId || task.rootTaskId || task.id;
  }

  private groupKey(task: Task): string {
    return `${task.roomId}\0${this.groupId(task)}`;
  }

  private currentIndex(): SchedulingIndex {
    if (this.index) return this.index;
    const tasks = new Map(this.store.list<Task>('tasks').map((task) => [task.id, task]));
    const groups = new Map<string, Task[]>();
    for (const task of tasks.values()) {
      const key = this.groupKey(task);
      const members = groups.get(key) ?? [];
      members.push(task);
      groups.set(key, members);
    }
    return (this.index = { tasks, groups });
  }

  /** A retired/broken reference never falls back to its old remaining balance. */
  private holder(task: Task, index: SchedulingIndex, at: number): GrantHolder | undefined {
    const original = task.scheduling;
    if (!isTaskScheduling(original) || !original.grant) return;
    if (Date.parse(original.grant.expiresAt) <= at) return;
    let current = task;
    const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      const scheduling = current.scheduling;
      if (!isTaskScheduling(scheduling) || !scheduling.grant) break;
      if (!scheduling.grantRedirect) {
        if (Date.parse(scheduling.grant.expiresAt) <= at) break;
        return { task: current, grant: scheduling.grant };
      }
      const target = index.tasks.get(scheduling.grantRedirect.taskId);
      if (
        !target ||
        target.roomId !== task.roomId ||
        target.scheduling?.grant?.id !== scheduling.grantRedirect.grantId
      )
        break;
      current = target;
    }
    return {
      task,
      grant: { ...original.grant, remainingRequests: 0 },
      retired: true,
    };
  }

  private write(updates: Array<{ taskId: string; scheduling: Task['scheduling'] }>): void {
    // Savepoints also keep this atomic if a caller already owns a store transaction.
    this.store.db.exec('SAVEPOINT scheduling_priority');
    try {
      for (const update of updates)
        this.store.patch<Task>('tasks', update.taskId, {
          scheduling: update.scheduling,
          updatedAt: now(),
        });
      this.store.db.exec('RELEASE scheduling_priority');
    } catch (error) {
      this.store.db.exec('ROLLBACK TO scheduling_priority; RELEASE scheduling_priority');
      throw error;
    }
    this.invalidate();
    this.options.changed();
  }

  private resolve(taskId: string, at = Date.now()): GroupResolution {
    const index = this.currentIndex();
    const task = index.tasks.get(taskId);
    if (!task) return { groupId: taskId };
    const key = this.groupKey(task);
    const cached = this.resolutions.get(key);
    if (cached && (!cached.holder || Date.parse(cached.holder.grant.expiresAt) > at)) return cached;
    const holders = new Map<string, GrantHolder>();
    for (const member of index.groups.get(key) ?? []) {
      const holder = this.holder(member, index, at);
      if (holder) holders.set(holder.task.id, holder);
    }
    const ordered = [...holders.values()].sort(
      (left, right) =>
        Date.parse(left.grant.requestedAt) - Date.parse(right.grant.requestedAt) ||
        left.grant.id.localeCompare(right.grant.id) ||
        left.task.id.localeCompare(right.task.id),
    );
    const retired = ordered.find((holder) => holder.retired);
    let holder = retired ?? ordered[0];
    if (!retired && ordered.length > 1) {
      // Independently granted roots may later join a Work. Sum their already
      // consumed requests, never their remaining allowances.
      const distinct = new Map<string, SchedulingGrant>();
      for (const item of ordered) {
        const previous = distinct.get(item.grant.id);
        if (!previous || spentRequests(item.grant) > spentRequests(previous))
          distinct.set(item.grant.id, item.grant);
      }
      const owner = ordered.find((item) => item.grant.source === 'owner');
      const attribution = (owner ?? ordered[0]).grant;
      const grantedRequests = owner ? OWNER_PRIORITY_REQUESTS : BOT_PRIORITY_REQUESTS;
      const spent = [...distinct.values()].reduce(
        (total, grant) => Math.min(Number.MAX_SAFE_INTEGER, total + spentRequests(grant)),
        0,
      );
      const revokedAt = ordered
        .map((item) => item.grant.revokedAt)
        .filter((value): value is string => Boolean(value))
        .sort()[0];
      const grant: SchedulingGrant = {
        ...attribution,
        id: ordered[0].grant.id,
        requestedAt: ordered[0].grant.requestedAt,
        expiresAt: ordered[0].grant.expiresAt,
        grantedRequests,
        consumedRequests: spent,
        remainingRequests: revokedAt ? 0 : Math.max(0, grantedRequests - spent),
        ...(revokedAt ? { revokedAt } : {}),
      };
      const canonical = ordered[0].task;
      const updates: Array<{ taskId: string; scheduling: Task['scheduling'] }> = [
        { taskId: canonical.id, scheduling: { grant } },
      ];
      // Flatten aliases too, so retired secondary windows cannot outlive the
      // merged window or follow a future replacement grant on their old holder.
      for (const candidate of index.tasks.values()) {
        if (candidate.id === canonical.id || !candidate.scheduling?.grant) continue;
        const target = this.holder(candidate, index, at);
        if (!target || target.retired || !holders.has(target.task.id)) continue;
        updates.push({
          taskId: candidate.id,
          scheduling: {
            grant: {
              ...candidate.scheduling.grant,
              requestedAt: grant.requestedAt,
              expiresAt: grant.expiresAt,
              remainingRequests: 0,
            },
            grantRedirect: { taskId: canonical.id, grantId: grant.id },
          },
        });
      }
      this.write(updates);
      holder = { task: canonical, grant };
    }
    const result = { groupId: this.groupId(task), ...(holder ? { holder } : {}) };
    this.resolutions.set(key, result);
    return result;
  }

  get(taskId: string): TaskSchedulingSnapshot {
    const result = this.resolve(taskId);
    return {
      groupId: result.groupId,
      ...(result.holder ? { grant: { ...result.holder.grant } } : {}),
      ...(result.holder?.retired ? { grantUnavailable: true } : {}),
    };
  }

  capture(taskId: string): CapturedScheduling {
    const result = this.resolve(taskId);
    const index = this.currentIndex();
    const task = index.tasks.get(taskId);
    return {
      ...this.get(taskId),
      ...(result.holder ? { holderTaskId: result.holder.task.id } : {}),
      ...(task
        ? {
            memberTaskIds: (index.groups.get(this.groupKey(task)) ?? []).map((member) => member.id),
          }
        : {}),
    };
  }

  /** Called synchronously around Work binding, never inferred from timestamp ordering. */
  inherit(taskId: string, before: CapturedScheduling): void {
    this.invalidate();
    const task = this.store.get<Task>('tasks', taskId);
    if (!task || this.groupId(task) === before.groupId) return;
    if (before.grant && before.holderTaskId && Date.parse(before.grant.expiresAt) > Date.now()) {
      const index = this.currentIndex();
      const updates: Array<{ taskId: string; scheduling: Task['scheduling'] }> = [];
      const retain = (member: Task) => {
        const existing = this.holder(member, index, Date.now());
        if (
          member.id !== before.holderTaskId &&
          (!existing ||
            existing.task.id !== before.holderTaskId ||
            existing.grant.id !== before.grant!.id)
        )
          updates.push({
            taskId: member.id,
            scheduling: {
              grant: { ...before.grant!, remainingRequests: 0 },
              grantRedirect: { taskId: before.holderTaskId!, grantId: before.grant!.id },
            },
          });
      };
      retain(task);
      // The grant itself may have been stored on the child that is moving.
      // Keep a reference in its former group too, so parents and siblings
      // cannot obtain a second allowance after the holder moves into Work.
      const formerMember = before.memberTaskIds
        ?.map((memberId) => index.tasks.get(memberId))
        .find(
          (member) =>
            member && member.roomId === task.roomId && this.groupId(member) === before.groupId,
        );
      if (formerMember) retain(formerMember);
      if (updates.length) this.write(updates);
    }
    this.resolve(taskId);
  }

  request(
    taskId: string,
    input: PriorityRequest,
    source: SchedulingGrant['source'],
  ): TaskSchedulingSnapshot {
    const request = priorityRequestSchema.parse(input);
    const task = this.options.assertEligible(taskId);
    if (source === 'bot' && task.kind === 'learning')
      throw Object.assign(new Error('Learning tasks cannot request their own priority.'), {
        statusCode: 409,
      });
    const current = this.resolve(taskId);
    const grant = current.holder?.grant;
    if (grant) {
      if (
        source !== 'owner' ||
        grant.source === 'owner' ||
        grant.revokedAt ||
        current.holder?.retired
      )
        return this.get(taskId);
      const spent = spentRequests(grant);
      this.write([
        {
          taskId: current.holder!.task.id,
          scheduling: {
            grant: {
              ...grant,
              source: 'owner',
              reason: request.reason,
              grantedRequests: OWNER_PRIORITY_REQUESTS,
              consumedRequests: spent,
              remainingRequests: Math.max(0, OWNER_PRIORITY_REQUESTS - spent),
            },
          },
        },
      ]);
      return this.get(taskId);
    }
    const at = Date.now();
    const grantedRequests = source === 'owner' ? OWNER_PRIORITY_REQUESTS : BOT_PRIORITY_REQUESTS;
    this.write([
      {
        taskId,
        scheduling: {
          grant: {
            id: id('priority'),
            source,
            reason: request.reason,
            requestedAt: new Date(at).toISOString(),
            expiresAt: new Date(at + PRIORITY_WINDOW_MS).toISOString(),
            grantedRequests,
            consumedRequests: 0,
            remainingRequests: grantedRequests,
            ...(request.deadlineAt
              ? { deadlineAt: new Date(request.deadlineAt).toISOString() }
              : {}),
          },
        },
      },
    ]);
    return this.get(taskId);
  }

  consume(taskId: string, grantId: string): boolean {
    try {
      this.options.assertEligible(taskId);
    } catch {
      return false;
    }
    const current = this.resolve(taskId);
    const holder = current.holder;
    if (
      !holder ||
      holder.retired ||
      holder.grant.id !== grantId ||
      holder.grant.revokedAt ||
      holder.grant.remainingRequests <= 0 ||
      Date.parse(holder.grant.requestedAt) > Date.now()
    )
      return false;
    this.write([
      {
        taskId: holder.task.id,
        scheduling: {
          grant: {
            ...holder.grant,
            remainingRequests: holder.grant.remainingRequests - 1,
            consumedRequests: spentRequests(holder.grant) + 1,
          },
        },
      },
    ]);
    return true;
  }

  revoke(taskId: string): TaskSchedulingSnapshot {
    this.options.assertEligible(taskId);
    const current = this.resolve(taskId);
    const holder = current.holder;
    if (holder && !holder.retired && !holder.grant.revokedAt)
      this.write([
        {
          taskId: holder.task.id,
          scheduling: {
            grant: { ...holder.grant, remainingRequests: 0, revokedAt: now() },
          },
        },
      ]);
    return this.get(taskId);
  }
}
