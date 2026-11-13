import { resolve } from 'node:path';
import type { Activity, Approval, Bot, Message, Room, Task, WorkItem } from '../shared/types.js';
import { autonomousWakeupPolicy, type Wakeup } from '../shared/work.js';
import type { OperationRecord } from './runtime/contract.js';
import { Store, now } from './store.js';

const UPDATE_TITLE = 'Paused for application update';
const UPDATE_DETAIL =
  'Paused for an application update. Resume the room to continue from saved context.';
const FAILED = new Set<Task['status']>(['failed', 'stopped', 'interrupted']);

/**
 * Older runtimes blocked work while saving a safe update checkpoint, then restored
 * only its task to the paused queue. Repair that exact durable state at startup.
 * This is not an owner review: never acknowledge uncertainty, retry a failed task,
 * resume a room, or change any reservation or execution history.
 */
export function recoverLegacyUpdateWork(store: Store): string[] {
  const works = store.list<WorkItem>('workItems').filter((work) => work.status === 'blocked');
  if (!works.length) return [];
  const tasks = store.list<Task>('tasks');
  const activities = store.list<Activity>('activities');
  const messages = new Map(store.list<Message>('messages').map((message) => [message.id, message]));
  const rooms = new Map(store.list<Room>('rooms').map((room) => [room.id, room]));
  const bots = new Map(store.list<Bot>('bots').map((bot) => [bot.id, bot]));
  const wakeups = store.list<Wakeup>('wakeups');
  const operations = store.list<OperationRecord>('operations');
  const drafts = new Map(
    store.list<{ id: string; status?: string }>('mailDrafts').map((draft) => [draft.id, draft]),
  );
  const approvals = store.list<Approval>('approvals');
  const pendingApprovals = new Set(
    approvals
      .filter((approval) => approval.status === 'pending')
      .map((approval) => approval.taskId),
  );

  const recovered: WorkItem[] = [];
  for (const work of works) {
    const room = rooms.get(work.roomId);
    const creator = bots.get(work.createdByBotId);
    if (
      !room?.paused ||
      room.archived ||
      !creator?.enabled ||
      !room.botIds.includes(creator.id) ||
      work.finishedByTaskId ||
      !Array.isArray(work.checkpoint?.uncertainActions) ||
      work.checkpoint.uncertainActions.length ||
      work.scope !== `${room.description}\n${creator.role}`.trim() ||
      work.workspacePath !== resolve(room.workspacePath || store.settings().workspacePath)
    )
      continue;
    const policy = autonomousWakeupPolicy(room.autonomousWakeups);
    if (policy.mode === 'off') continue;
    const members = (botId: string) => bots.get(botId)?.enabled && room.botIds.includes(botId);
    const related = tasks.filter((task) => task.workId === work.id);
    const source = related.find((task) => task.id === work.sourceTaskId);
    if (!source || source.botId !== creator.id) continue;
    const candidate = related.find(
      (task) =>
        work.lastError ===
        `Task ${task.id} stopped. Review its results and resume explicitly before continuing.`,
    );
    if (!candidate) continue;
    const blockedAt = Date.parse(work.updatedAt);
    if (!Number.isFinite(blockedAt)) continue;

    const savedForUpdate = (task: Task): boolean => {
      const startedAt = Date.parse(task.startedAt ?? '');
      const queuedAt = Date.parse(task.updatedAt);
      if (
        task.status !== 'queued' ||
        task.error !== undefined ||
        task.completedAt !== undefined ||
        task.archivedAt ||
        task.archiveReason ||
        !Number.isFinite(startedAt) ||
        !Number.isFinite(queuedAt) ||
        startedAt > blockedAt ||
        queuedAt < blockedAt
      )
        return false;
      return activities.some((activity) => {
        if (
          activity.taskId !== task.id ||
          activity.roomId !== task.roomId ||
          activity.botId !== task.botId ||
          activity.kind !== 'status' ||
          activity.status !== 'success' ||
          activity.title !== UPDATE_TITLE ||
          activity.detail !== UPDATE_DETAIL ||
          !activity.messageId
        )
          return false;
        const message = messages.get(activity.messageId);
        const activityAt = Date.parse(activity.createdAt);
        const messageAt = Date.parse(message?.createdAt ?? '');
        // Activities retain their session-start time when updated. Its linked
        // message must belong to this execution, not an older successful update.
        return Boolean(
          message?.taskId === task.id &&
          message.roomId === task.roomId &&
          message.authorType === 'bot' &&
          message.authorId === task.botId &&
          message.status === 'complete' &&
          Number.isFinite(activityAt) &&
          Number.isFinite(messageAt) &&
          activityAt <= startedAt &&
          startedAt <= messageAt &&
          messageAt <= blockedAt,
        );
      });
    };
    if (!savedForUpdate(candidate)) continue;

    const reviewedAt = Date.parse(work.reviewedAt ?? '');
    if (
      related.some((task) => {
        if (
          task.roomId !== room.id ||
          task.workspacePath !== work.workspacePath ||
          !task.workRunId ||
          task.kind === 'learning' ||
          pendingApprovals.has(task.id)
        )
          return true;
        if (task.status === 'completed') return false;
        if (FAILED.has(task.status)) {
          const failedAt = Date.parse(task.updatedAt);
          return !(
            Number.isFinite(reviewedAt) &&
            Number.isFinite(failedAt) &&
            failedAt <= reviewedAt &&
            reviewedAt < blockedAt
          );
        }
        if (
          task.status !== 'queued' ||
          !members(task.botId) ||
          task.archivedAt ||
          task.archiveReason
        )
          return true;
        if (task.startedAt && !savedForUpdate(task)) return true;
        if (task.error !== undefined || task.completedAt !== undefined) return true;
        if (!task.wakeupId) return false;
        const wake = wakeups.find((item) => item.id === task.wakeupId);
        return (
          !wake ||
          wake.workId !== work.id ||
          wake.roomId !== room.id ||
          wake.botId !== task.botId ||
          wake.cancelledBy === 'owner' ||
          (policy.mode === 'self' &&
            (wake.botId !== wake.createdByBotId || wake.botId !== creator.id))
        );
      })
    )
      continue;
    const taskIds = new Set(related.map((task) => task.id));
    if (
      approvals.some(
        (approval) =>
          taskIds.has(approval.taskId) &&
          approval.status === 'cancelled' &&
          // Old application startup may already have cancelled an approval.
          // Update preparation cancels its waits before recording the block.
          // Equal timestamps cannot distinguish them under a coarse clock.
          (!Number.isFinite(Date.parse(approval.decidedAt ?? '')) ||
            Date.parse(approval.decidedAt!) >= blockedAt),
      ) ||
      operations.some(
        (operation) =>
          taskIds.has(operation.taskId) &&
          (operation.status !== 'completed' ||
            operation.uncertainty !== undefined ||
            (operation.toolName === 'send_mail' &&
              ['unknown', 'sending'].includes(
                drafts.get(String(operation.args.draftId))?.status ?? '',
              ))),
      ) ||
      wakeups.some(
        (wake) =>
          wake.workId === work.id &&
          wake.status === 'scheduled' &&
          (wake.roomId !== room.id ||
            !members(wake.createdByBotId) ||
            !members(wake.botId) ||
            (policy.mode === 'self' &&
              (wake.botId !== wake.createdByBotId || wake.botId !== creator.id))),
      )
    )
      continue;
    recovered.push(work);
  }
  if (!recovered.length) return [];

  const stamp = now();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const work of recovered)
      store.patch<WorkItem>('workItems', work.id, {
        status: 'active',
        lastError: undefined,
        revision: work.revision + 1,
        updatedAt: stamp,
      });
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return recovered.map((work) => work.id);
}
