import { abortError, throwIfAborted } from './gate.js';

interface BoundaryWaiter {
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  abort: () => void;
}

interface ScheduledTask {
  taskId: string;
  roomId: string;
  background: boolean;
  active: boolean;
  waiters: Set<BoundaryWaiter>;
}

export interface RoomTaskSchedulerOptions {
  capacity?: number;
  pausedRooms?: Iterable<string>;
  /** Called after scheduler state changes. Queue a runtime pump instead of recursing into it. */
  changed?: () => void;
  /** Release task-scoped idle resources when a task gives up its worker at a boundary. */
  onSuspend?: (taskId: string) => void;
}

/**
 * Keep a started task's continuation while lending its worker to another room.
 * A pause never cancels an active operation: the task parks at its next checkpoint.
 * Initial admission and resumed continuations share the same bounded worker count.
 */
export class RoomTaskScheduler {
  readonly capacity: number;
  private readonly paused = new Set<string>();
  private readonly roomSignals = new Map<string, AbortController>();
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly waiting: ScheduledTask[] = [];
  private held = 0;
  private readonly changed: () => void;
  private readonly onSuspend: (taskId: string) => void;

  constructor(options: RoomTaskSchedulerOptions = {}) {
    this.capacity = options.capacity ?? 16;
    if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 16)
      throw new RangeError('Task worker capacity must be an integer from 1 to 16.');
    this.changed = options.changed ?? (() => {});
    this.onSuspend = options.onSuspend ?? (() => {});
    for (const roomId of options.pausedRooms ?? []) this.paused.add(roomId);
  }

  get activeCount(): number {
    return this.held;
  }

  get waitingTasks(): Array<{ taskId: string; roomId: string; reason: 'paused' | 'worker' }> {
    return this.waiting.map((task) => ({
      taskId: task.taskId,
      roomId: task.roomId,
      reason: this.paused.has(task.roomId) ? 'paused' : 'worker',
    }));
  }

  isRoomPaused(roomId: string): boolean {
    return this.paused.has(roomId);
  }

  isSuspended(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    return Boolean(task && !task.active);
  }

  /**
   * Use only while acquiring capacity, never for an issued model/tool operation.
   * Pausing cancels that acquisition; resuming gives later attempts a fresh signal.
   * The caller must distinguish this signal from task cancellation, checkpoint,
   * and retry admission. Recheck pause after a grant, releasing it before waiting.
   */
  pauseSignal(roomId: string): AbortSignal {
    let controller = this.roomSignals.get(roomId);
    if (!controller) {
      controller = new AbortController();
      if (this.paused.has(roomId)) controller.abort();
      this.roomSignals.set(roomId, controller);
    }
    return controller.signal;
  }

  setRoomPaused(roomId: string, paused: boolean): void {
    if (this.paused.has(roomId) === paused) return;
    if (paused) {
      this.paused.add(roomId);
      // Set the durable admission predicate before notifying capacity waiters.
      this.roomSignals.get(roomId)?.abort();
    } else {
      this.paused.delete(roomId);
      this.roomSignals.set(roomId, new AbortController());
      this.pump();
    }
    this.changed();
  }

  /** Reserve one worker before starting a previously unstarted task. */
  tryStart(taskId: string, roomId: string, background = false): boolean {
    if (this.tasks.has(taskId) || this.paused.has(roomId) || this.held >= this.capacity)
      return false;
    this.tasks.set(taskId, { taskId, roomId, background, active: true, waiters: new Set() });
    this.held++;
    this.changed();
    return true;
  }

  /**
   * Await between operations, with no inference/image/browser acquisition held.
   * Concurrent checkpoints share one worker wait. Returns whether it suspended.
   * The continuation remains owned by the caller; finish() is still required on
   * completion/cancellation. Aborted waiters never readmit themselves later.
   */
  async checkpoint(taskId: string, signal: AbortSignal): Promise<boolean> {
    let suspended = false;
    while (true) {
      throwIfAborted(signal);
      const task = this.tasks.get(taskId);
      if (!task) throw new Error('The task has no worker registration.');
      if (task.active && !this.paused.has(task.roomId)) return suspended;
      suspended = true;
      await new Promise<void>((resolve, reject) => {
        const waiter: BoundaryWaiter = {
          signal,
          resolve,
          reject,
          abort: () => {
            if (!task.waiters.has(waiter)) return;
            this.removeWaiter(task, waiter);
            reject(abortError());
            this.pump();
            this.changed();
          },
        };
        if (!task.waiters.size) this.waiting.push(task);
        task.waiters.add(waiter);
        signal.addEventListener('abort', waiter.abort, { once: true });
        if (task.active) {
          task.active = false;
          this.held--;
          this.onSuspend(taskId);
        }
        if (signal.aborted) waiter.abort();
        this.pump();
        this.changed();
      });
      // Resume/pause can both occur before the awaiting continuation runs.
      // Recheck here instead of allowing a resolved waiter through a new pause.
    }
  }

  /** Idempotently remove a completed/cancelled task and lend its worker onward. */
  finish(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.tasks.delete(taskId);
    for (const waiter of [...task.waiters]) {
      this.removeWaiter(task, waiter);
      waiter.reject(abortError());
    }
    if (task.active) this.held--;
    this.pump();
    this.changed();
  }

  private removeWaiter(task: ScheduledTask, waiter: BoundaryWaiter): void {
    if (!task.waiters.delete(waiter)) return;
    if (!task.waiters.size) {
      const index = this.waiting.indexOf(task);
      if (index !== -1) this.waiting.splice(index, 1);
    }
    waiter.signal.removeEventListener('abort', waiter.abort);
  }

  private pump(): void {
    while (this.held < this.capacity) {
      const foreground = this.waiting.findIndex(
        (task) => !task.background && !this.paused.has(task.roomId),
      );
      const index =
        foreground !== -1
          ? foreground
          : this.waiting.findIndex((task) => !this.paused.has(task.roomId));
      if (index === -1) break;
      const task = this.waiting[index];
      const admitted: BoundaryWaiter[] = [];
      for (const waiter of [...task.waiters]) {
        this.removeWaiter(task, waiter);
        if (waiter.signal.aborted) waiter.reject(abortError());
        else admitted.push(waiter);
      }
      if (!admitted.length) continue;
      task.active = true;
      this.held++;
      for (const waiter of admitted) waiter.resolve();
    }
  }
}
