import type { Approval, Task, WorkItem } from '../shared/types.js';
import type { OperationRecord } from './runtime/contract.js';
import { Store, now } from './store.js';

const TERMINAL = new Set<Task['status']>(['completed', 'failed', 'stopped', 'interrupted']);

function reviewedAfter(reviewedAt: string | undefined, updatedAt: string): boolean {
  if (!reviewedAt) return false;
  const review = Date.parse(reviewedAt);
  const operation = Date.parse(updatedAt);
  return Number.isFinite(review) && Number.isFinite(operation) && review >= operation;
}

function unresolved(operation: OperationRecord, work: WorkItem): boolean {
  // A started effect may still finish, even after the owner reviewed earlier
  // results. A general work review cannot acknowledge an unknown mail delivery.
  if (operation.status === 'started') return true;
  // This acknowledgment belongs to the operation identity and survives later
  // receipt updates, just as it does in WorkService's unknown-mail guard.
  const mailReviewed =
    typeof operation.uncertainty?.reviewedAt === 'string' &&
    Number.isFinite(Date.parse(operation.uncertainty.reviewedAt));
  if (operation.uncertainty && !mailReviewed) return true;
  if (operation.status === 'failed')
    return !(reviewedAfter(work.reviewedAt, operation.updatedAt) || mailReviewed);
  return operation.status !== 'completed';
}

/** Change only display metadata. Call from mutation lifecycle hooks, never from a GET. */
export function reconcileAutomaticTaskHistory(store: Store): boolean {
  const tasks = store.list<Task>('tasks');
  const works = new Map(store.list<WorkItem>('workItems').map((work) => [work.id, work]));
  const taskWork = (task: Task): WorkItem | undefined => {
    const work = task.workId ? works.get(task.workId) : undefined;
    return work?.roomId === task.roomId ? work : undefined;
  };
  const closedWork = (task: Task): WorkItem | undefined => {
    const work = taskWork(task);
    return work?.status === 'completed' || work?.status === 'cancelled' ? work : undefined;
  };
  const candidates = tasks.filter(
    (task) =>
      task.archiveReason ||
      (!task.archivedAt && !task.keepVisible && TERMINAL.has(task.status) && closedWork(task)),
  );
  if (!candidates.length) return false;

  const pendingTasks = new Set(
    store
      .list<Approval>('approvals')
      .filter((approval) => approval.status === 'pending')
      .map((approval) => approval.taskId),
  );
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const uncertainWorks = new Set<string>();
  for (const operation of store.list<OperationRecord>('operations')) {
    const task = taskById.get(operation.taskId);
    const work = task ? taskWork(task) : undefined;
    // A sibling task's unresolved effect can change the same work's outcome.
    if (work && unresolved(operation, work)) uncertainWorks.add(work.id);
  }

  const changes: { id: string; archivedAt?: string; archiveReason?: Task['archiveReason'] }[] = [];
  const stamp = now();
  for (const task of candidates) {
    const work = closedWork(task);
    const eligible =
      TERMINAL.has(task.status) &&
      !task.keepVisible &&
      work &&
      Array.isArray(work.checkpoint?.uncertainActions) &&
      work.checkpoint.uncertainActions.length === 0 &&
      !pendingTasks.has(task.id) &&
      !uncertainWorks.has(work.id);
    if (!eligible) {
      if (task.archiveReason)
        changes.push({ id: task.id, archivedAt: undefined, archiveReason: undefined });
      continue;
    }
    const archiveReason = work.status === 'completed' ? 'work_completed' : 'work_cancelled';
    if (!task.archivedAt || task.archiveReason !== archiveReason)
      changes.push({ id: task.id, archivedAt: task.archivedAt ?? stamp, archiveReason });
  }
  if (!changes.length) return false;

  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const change of changes) store.patch<Task>('tasks', change.id, change);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return true;
}
