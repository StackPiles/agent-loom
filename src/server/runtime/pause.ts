import { abortError, throwIfAborted, type TaskPriority } from './gate.js';
import { WorkSchedulingLedger } from './scheduling.js';

interface BoundaryWaiter {
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  abort: () => void;
}

interface ScheduledTask {
  taskId: string;
  roomId: string;
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
  /** Unstarted tasks whose rooms and bot sessions are ready. */
  pendingTasks?: () => string[];
  scheduling?: WorkSchedulingLedger;
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
  private readonly pendingTasks: () => string[];
  private readonly scheduling: WorkSchedulingLedger;

  constructor(options: RoomTaskSchedulerOptions = {}) {
    this.capacity = options.capacity ?? 16;
    if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 16)
      throw new RangeError('Task worker capacity must be an integer from 1 to 16.');
    this.changed = options.changed ?? (() => {});
    this.onSuspend = options.onSuspend ?? (() => {});
    this.pendingTasks = options.pendingTasks ?? (() => []);
    this.scheduling = options.scheduling ?? new WorkSchedulingLedger();
    for (const roomId of options.pausedRooms ?? []) this.paused.add(roomId);
  }

  get activeCount(): number {
    return this.held;
  }

  get waitingTasks(): Array<{ taskId: string; roomId: string; reason: 'paused' | 'worker' }> {
    const parked = [...this.tasks.values()].filter(
      (task) => !task.active && !task.waiters.size && this.paused.has(task.roomId),
    );
    return [...this.waiting, ...parked].map((task) => ({
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
      for (const task of this.tasks.values())
        if (task.roomId === roomId) this.scheduling.clearWaiting(task.taskId);
      // Set the durable admission predicate before notifying capacity waiters.
      this.roomSignals.get(roomId)?.abort();
    } else {
      this.paused.delete(roomId);
      this.roomSignals.set(roomId, new AbortController());
      for (const task of this.waiting)
        if (task.roomId === roomId) this.scheduling.wait(task.taskId);
      this.pump();
    }
    this.changed();
  }

  /** Reserve one worker before starting a previously unstarted task. */
  tryStart(taskId: string, roomId: string, _priority: TaskPriority | boolean = 'chat'): boolean {
    if (this.tasks.has(taskId) || this.paused.has(roomId) || this.held >= this.capacity)
      return false;
    this.scheduling.register(taskId);
    this.tasks.set(taskId, {
      taskId,
      roomId,
      active: true,
      waiters: new Set(),
    });
    this.held++;
    this.changed();
    return true;
  }

  /** Reconcile suspended continuations after the runtime's pending queue changes. */
  refresh(): void {
    const before = this.held;
    this.pump();
    if (this.held !== before) this.changed();
  }

  /**
   * A passive owner-decision wait has no runnable continuation yet. Lend its
   * worker without enqueuing it; the real continuation must checkpoint after
   * the decision before it can execute another action.
   */
  lend(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task?.active) return;
    task.active = false;
    this.held--;
    this.scheduling.clearWaiting(taskId);
    this.onSuspend(taskId);
    this.pump();
    this.changed();
  }

  /** Also used to wake a safe inference waiter when a ready task needs its worker. */
  shouldYield(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task?.active || this.held < this.capacity) return false;
    const ready = [
      ...this.pendingTasks(),
      ...this.waiting
        .filter((candidate) => !this.paused.has(candidate.roomId))
        .map((candidate) => candidate.taskId),
    ];
    if (!ready.length) return false;
    return this.scheduling.choose([...ready, taskId])?.taskId !== taskId;
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
      const yieldToPending = this.shouldYield(taskId);
      if (task.active && !this.paused.has(task.roomId) && !yieldToPending) return suspended;
      suspended = true;
      if (this.paused.has(task.roomId)) this.scheduling.clearWaiting(taskId);
      else this.scheduling.wait(taskId);
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
      const ready = this.waiting.filter((task) => !this.paused.has(task.roomId));
      const choice = this.scheduling.choose([
        ...this.pendingTasks(),
        ...ready.map((task) => task.taskId),
      ]);
      if (!choice) break;
      const index = this.waiting.findIndex((task) => task.taskId === choice.taskId);
      // The runtime owns initial admission. Leave this worker for the ready
      // unstarted task when it wins the same comparison as parked continuations.
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
