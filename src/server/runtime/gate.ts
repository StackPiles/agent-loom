import { WorkSchedulingLedger, type InferencePurpose } from './scheduling.js';

export type TaskPriority = 'chat' | 'automation' | 'learning';

/** Legacy callers used a boolean for idle-capacity learning work. */
export function taskPriority(value: TaskPriority | boolean): TaskPriority {
  return value === true ? 'learning' : value === false ? 'chat' : value;
}

export interface InferenceRequest {
  taskId?: string;
  groupId?: string;
  roomId?: string;
  purpose?: InferencePurpose;
  /** Keep one model response at a time in this room, while other rooms may run. */
  serialRoom?: boolean;
}

/** Abortable inference slots shared by every room and bot. */
export class InferenceGate {
  private held = 0;
  private limit = 1;
  private heldRooms = new Map<string, number>();
  private serialRooms = new Map<string, number>();
  private active = new Set<InferenceRequest>();
  private helperSequence = 0;
  private waiting: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort: () => void;
    schedulingId: string;
    request: InferenceRequest;
  }> = [];

  constructor(
    private readonly changed: () => void = () => {},
    capacity = 1,
    readonly scheduling = new WorkSchedulingLedger(),
  ) {
    this.limit = this.validateCapacity(capacity);
  }

  get state(): { active: number; waiting: number } {
    return { active: this.held, waiting: this.waiting.length };
  }

  get capacity(): number {
    return this.limit;
  }

  isWaiting(taskId: string): boolean {
    return this.waiting.some((entry) => entry.request.taskId === taskId);
  }

  blockingTaskId(taskId: string): string | undefined {
    const waiting = this.waiting.find((entry) => entry.request.taskId === taskId);
    if (!waiting) return undefined;
    const active = [...this.active].filter((request) => request.taskId !== taskId);
    if (!this.roomAvailable(waiting.request))
      return active.find((request) => request.roomId === waiting.request.roomId)?.taskId;
    if (this.held >= this.limit)
      return (active.find((request) => request.purpose === 'compaction') ?? active[0])?.taskId;
    return undefined;
  }

  /** Priority changes reorder only requests that have not been issued. */
  refresh(): void {
    this.pump();
  }

  get waitingRequests(): Array<{ taskId: string; reason: 'inference' | 'room' }> {
    return this.waiting.flatMap((entry) =>
      entry.request.taskId
        ? [
            {
              taskId: entry.request.taskId,
              reason: this.roomAvailable(entry.request) ? 'inference' : 'room',
            },
          ]
        : [],
    );
  }

  /** Increasing capacity admits waiters; decreasing it lets current streams finish. */
  setCapacity(capacity: number): void {
    const next = this.validateCapacity(capacity);
    if (next === this.limit) return;
    this.limit = next;
    this.pump();
  }

  private validateCapacity(capacity: number): number {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16)
      throw new RangeError('Inference concurrency must be an integer from 1 to 16.');
    return capacity;
  }

  private roomAvailable(request: InferenceRequest): boolean {
    if (!request.roomId) return true;
    return request.serialRoom
      ? !this.heldRooms.get(request.roomId)
      : !this.serialRooms.get(request.roomId);
  }

  acquire(
    signal?: AbortSignal,
    _priority: TaskPriority | boolean = 'chat',
    request: InferenceRequest = {},
  ): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const schedulingId = request.taskId ?? `helper:${++this.helperSequence}`;
      this.scheduling.register(
        schedulingId,
        request.groupId ?? (request.taskId ? schedulingId : 'application-helper'),
      );
      const entry = {
        resolve,
        reject,
        signal,
        schedulingId,
        request,
        abort: () => {
          const index = this.waiting.indexOf(entry);
          if (index !== -1) {
            this.waiting.splice(index, 1);
            if (!entry.request.taskId) this.scheduling.finish(schedulingId);
            reject(abortError());
            this.pump();
          }
        },
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.waiting.push(entry);
      this.pump();
    });
  }

  private pump(): void {
    for (const entry of this.waiting) {
      if (this.roomAvailable(entry.request))
        this.scheduling.wait(
          entry.schedulingId,
          entry.request.purpose ?? (entry.request.taskId ? 'response' : 'helper'),
        );
      else this.scheduling.clearWaiting(entry.schedulingId);
    }
    while (this.held < this.limit) {
      // Every eligible kind shares the same work ledger. A blocked room does
      // not waste global capacity, and issued requests are never preempted.
      const choice = this.scheduling.choose(
        this.waiting
          .filter((entry) => this.roomAvailable(entry.request))
          .map((entry) => entry.schedulingId),
      );
      if (!choice) break;
      const index = this.waiting.findIndex(
        (entry) => entry.schedulingId === choice.taskId && this.roomAvailable(entry.request),
      );
      const candidate = this.waiting[index];
      if (candidate.signal?.aborted) {
        candidate.abort();
        continue;
      }
      const finishCharge = this.scheduling.dispatch(choice);
      if (!finishCharge) continue;
      const entry = this.waiting.splice(index, 1)[0];
      entry.signal?.removeEventListener('abort', entry.abort);
      if (entry.signal?.aborted) {
        finishCharge();
        if (!entry.request.taskId) this.scheduling.finish(entry.schedulingId);
        entry.reject(abortError());
        continue;
      }
      this.held++;
      this.active.add(entry.request);
      const { roomId, serialRoom } = entry.request;
      if (roomId) {
        this.heldRooms.set(roomId, (this.heldRooms.get(roomId) ?? 0) + 1);
        if (serialRoom) this.serialRooms.set(roomId, (this.serialRooms.get(roomId) ?? 0) + 1);
      }
      for (const waiter of this.waiting)
        if (!this.roomAvailable(waiter.request)) this.scheduling.clearWaiting(waiter.schedulingId);
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        finishCharge();
        if (!entry.request.taskId) this.scheduling.finish(entry.schedulingId);
        this.active.delete(entry.request);
        this.held--;
        if (roomId) {
          this.decrement(this.heldRooms, roomId);
          if (serialRoom) this.decrement(this.serialRooms, roomId);
        }
        this.pump();
      });
    }
    this.changed();
  }

  private decrement(counts: Map<string, number>, roomId: string): void {
    const count = (counts.get(roomId) ?? 1) - 1;
    if (count) counts.set(roomId, count);
    else counts.delete(roomId);
  }
}

export function abortError(): Error {
  const error = new Error('Task stopped.');
  error.name = 'AbortError';
  return error;
}

/** Only a queued capacity acquisition was withdrawn; no task or action was aborted. */
export class InferenceRescheduledError extends Error {
  constructor() {
    super('Inference admission was rescheduled.');
    this.name = 'InferenceRescheduledError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
