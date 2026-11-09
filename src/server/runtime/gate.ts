export type TaskPriority = 'chat' | 'automation' | 'learning';

/** Legacy callers used a boolean for idle-capacity learning work. */
export function taskPriority(value: TaskPriority | boolean): TaskPriority {
  return value === true ? 'learning' : value === false ? 'chat' : value;
}

export function priorityRank(priority: TaskPriority): number {
  return priority === 'chat' ? 0 : priority === 'automation' ? 1 : 2;
}

export interface InferenceRequest {
  taskId?: string;
  roomId?: string;
  /** Keep one model response at a time in this room, while other rooms may run. */
  serialRoom?: boolean;
}

/** Abortable inference slots shared by every room and bot. */
export class InferenceGate {
  private held = 0;
  private limit = 1;
  private heldRooms = new Map<string, number>();
  private serialRooms = new Map<string, number>();
  private waiting: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort: () => void;
    priority: TaskPriority;
    request: InferenceRequest;
  }> = [];

  constructor(
    private readonly changed: () => void = () => {},
    capacity = 1,
  ) {
    this.limit = this.validateCapacity(capacity);
  }

  get state(): { active: number; waiting: number } {
    return { active: this.held, waiting: this.waiting.length };
  }

  get capacity(): number {
    return this.limit;
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
    priority: TaskPriority | boolean = 'chat',
    request: InferenceRequest = {},
  ): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        priority: taskPriority(priority),
        request,
        abort: () => {
          const index = this.waiting.indexOf(entry);
          if (index !== -1) {
            this.waiting.splice(index, 1);
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
    while (this.held < this.limit) {
      // Manual work precedes scheduled work, then idle-capacity learning.
      // Keep FIFO within each class and skip rooms whose own turn is blocked.
      // Issued requests retain their slots; priority never cancels an action.
      let index = -1;
      for (let i = 0; i < this.waiting.length; i++) {
        const entry = this.waiting[i];
        if (!this.roomAvailable(entry.request)) continue;
        if (
          index === -1 ||
          priorityRank(entry.priority) < priorityRank(this.waiting[index].priority)
        )
          index = i;
      }
      if (index === -1) break;
      const entry = this.waiting.splice(index, 1)[0];
      entry.signal?.removeEventListener('abort', entry.abort);
      if (entry.signal?.aborted) {
        entry.reject(abortError());
        continue;
      }
      this.held++;
      const { roomId, serialRoom } = entry.request;
      if (roomId) {
        this.heldRooms.set(roomId, (this.heldRooms.get(roomId) ?? 0) + 1);
        if (serialRoom) this.serialRooms.set(roomId, (this.serialRooms.get(roomId) ?? 0) + 1);
      }
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
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

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
