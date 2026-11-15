import type { Automation, Room, Task, Wakeup, WorkItem } from '../shared/types.js';
import { ACTIVE, type Controller, problem } from './controller.js';
import { now, type Store } from './store.js';
import type { Scheduler } from './scheduler.js';
import {
  planRoomDeletion,
  purgeRoomData,
  validateRoomDeletionPlan,
  type RoomDeletionPlan,
} from './room-deletion-data.js';

interface RoomDeletionJob {
  id: string;
  roomId: string;
  startedAt: string;
  stoppingTaskIds: string[];
  plan?: RoomDeletionPlan;
}

const failureMessage =
  'Deletion could not finish. Close any programs using the room’s internal files, then retry deletion. Its work remains disabled.';

/** Persist revocation before yielding, so queued work and HTTP handlers see the same boundary. */
function beginDeletion(store: Store, roomId: string): RoomDeletionJob {
  const room = store.get<Room>('rooms', roomId);
  if (!room) problem('Room not found.', 404);
  const previous = store.get<RoomDeletionJob>('roomDeletions', roomId);
  const job: RoomDeletionJob = previous ?? {
    id: roomId,
    roomId,
    startedAt: room.deletion?.startedAt ?? now(),
    stoppingTaskIds: store
      .list<Task>('tasks')
      .filter((task) => task.roomId === roomId && ACTIVE.has(task.status))
      .map((task) => task.id),
  };
  if (job.id !== roomId || job.roomId !== roomId || !Array.isArray(job.stoppingTaskIds))
    problem('The saved room deletion is invalid.', 409);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.put('roomDeletions', job);
    store.patch<Room>('rooms', roomId, {
      paused: true,
      deletion: { status: 'deleting', startedAt: job.startedAt },
      updatedAt: now(),
    });
    if (!job.plan) {
      for (const automation of store.list<Automation>('automations'))
        if (automation.roomId === roomId)
          store.patch<Automation>('automations', automation.id, {
            enabled: false,
            nextRunAt: undefined,
          });
      for (const work of store.list<WorkItem>('workItems'))
        if (work.roomId === roomId && !['completed', 'cancelled'].includes(work.status))
          store.patch<WorkItem>('workItems', work.id, {
            status: 'cancelled',
            revision: work.revision + 1,
            updatedAt: now(),
          });
      for (const wake of store.list<Wakeup>('wakeups'))
        if (wake.roomId === roomId && wake.status === 'scheduled')
          store.patch<Wakeup>('wakeups', wake.id, {
            status: 'cancelled',
            cancelledBy: 'owner',
            nextRunAt: undefined,
            retryAfter: undefined,
            revision: wake.revision + 1,
            updatedAt: now(),
          });
    }
    store.db.exec('COMMIT');
    return job;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}

function failedDeletion(store: Store, job: Pick<RoomDeletionJob, 'roomId' | 'startedAt'>): void {
  if (store.get('rooms', job.roomId))
    store.patch<Room>('rooms', job.roomId, {
      paused: true,
      deletion: { status: 'failed', startedAt: job.startedAt, error: failureMessage },
      updatedAt: now(),
    });
}

async function finishDeletion(store: Store, job: RoomDeletionJob): Promise<void> {
  if (!job.plan) {
    job = { ...job, plan: planRoomDeletion(store, job.roomId) };
    // The plan remains available after partial database/file cleanup or process termination.
    store.put('roomDeletions', job);
  }
  if (job.plan!.roomId !== job.roomId)
    throw new Error('The deletion plan belongs to another room.');
  validateRoomDeletionPlan(store, job.plan!);
  store.fenceRoomDeletion(job.roomId, job.plan!.records);
  await purgeRoomData(store, job.plan!);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.remove('rooms', job.roomId);
    // Only an identifier and timestamp remain; no conversation, credentials, or file paths.
    store.put('deletedRooms', { id: job.roomId, deletedAt: now() });
    store.remove('roomDeletions', job.roomId);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}

/** Run before migrations, controller recovery, or runtime/scheduler construction. */
export async function recoverRoomDeletions(store: Store): Promise<void> {
  for (const room of store.list<Room>('rooms')) {
    if (!room.deletion && !store.get('roomDeletions', room.id)) continue;
    try {
      const job = beginDeletion(store, room.id);
      await finishDeletion(store, job);
    } catch {
      failedDeletion(store, { roomId: room.id, startedAt: room.deletion?.startedAt ?? now() });
    }
  }
}

export class RoomDeletionService {
  private readonly pending = new Map<string, Promise<{ ok: true; roomId: string }>>();
  constructor(
    private readonly store: Store,
    private readonly controller: Controller,
    private readonly scheduler: Pick<Scheduler, 'stopRoom'>,
  ) {}

  delete(roomId: string): Promise<{ ok: true; roomId: string }> {
    const pending = this.pending.get(roomId);
    if (pending) return pending;
    if (this.controller.maintenance || this.controller.closing)
      problem('Agent Loom is restarting. Please wait.', 503);
    if (this.store.get('deletedRooms', roomId)) return Promise.resolve({ ok: true, roomId });
    const job = beginDeletion(this.store, roomId);
    this.controller.runtime?.setRoomPaused?.(roomId, true);
    this.controller.changed();
    const operation = (async () => {
      try {
        const stopped = await Promise.allSettled([
          this.scheduler.stopRoom(roomId),
          this.controller.stopRoomForDeletion(roomId, job.stoppingTaskIds),
        ]);
        const failure = stopped.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        await finishDeletion(this.store, job);
        return { ok: true as const, roomId };
      } catch {
        failedDeletion(this.store, job);
        throw Object.assign(new Error(failureMessage), {
          statusCode: 409,
          code: 'room_delete_failed',
        });
      } finally {
        this.pending.delete(roomId);
        this.controller.changed();
      }
    })();
    this.pending.set(roomId, operation);
    return operation;
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
  }
}
