import { getHeapStatistics } from 'node:v8';
import { abortError } from './gate.js';

const MIB = 1024 * 1024;
const RESIDENT_OVERHEAD_BYTES = 16 * MIB;

export interface SessionMemoryLimits {
  /** Estimated resident history plus temporary image/request allocations. */
  maxBytes: number;
  maxSessions: number;
}

export function sessionMemoryLimits(
  env: NodeJS.ProcessEnv = process.env,
  heapLimitBytes = getHeapStatistics().heap_size_limit,
): SessionMemoryLimits {
  const positiveInteger = (name: string, fallback: number, maximum: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new Error(`${name} must be a whole number from 1 to ${maximum}.`);
    return value;
  };
  // Leave space for the application, transports, V8 overhead and other objects.
  // This is an admission estimate, not a hard RSS/heap limit.
  const defaultMiB = Math.max(3, Math.min(1536, Math.floor(heapLimitBytes / MIB / 2)));
  const maxMiB = positiveInteger('LOOM_SESSION_MEMORY_MB', defaultMiB, 65_536);
  if (maxMiB < 3) throw new Error('LOOM_SESSION_MEMORY_MB must be at least 3 MiB.');
  return {
    maxBytes: maxMiB * MIB,
    // Parked continuations retain their histories after lending a worker, so
    // this configurable bound is independent of the sixteen active workers.
    maxSessions: positiveInteger('LOOM_SESSION_MAX_LOADED', 4, 64),
  };
}

/** Lightweight JSON still needs parsed strings, objects, indexes and working room. */
export function estimateSessionResidentBytes(jsonBytes: number): number {
  if (!Number.isSafeInteger(jsonBytes) || jsonBytes < 0)
    throw new Error('Conversation history has an invalid byte count.');
  const bytes = RESIDENT_OVERHEAD_BYTES + jsonBytes * 4;
  if (!Number.isSafeInteger(bytes)) throw new Error('Conversation history is too large.');
  return bytes;
}

/** Raw pixels, base64, transport JSON and transient copies share this allowance. */
export function estimateSessionImageWorkingBytes(imageBytes: number): number {
  if (!Number.isSafeInteger(imageBytes) || imageBytes < 0)
    throw new Error('Conversation images have an invalid byte count.');
  const bytes = imageBytes * 4;
  if (!Number.isSafeInteger(bytes)) throw new Error('Conversation images are too large.');
  return bytes;
}

export interface SessionMemoryLease {
  /** Growth is checked at safe boundaries; it never waits while holding other memory. */
  resize(bytes: number): void;
  release(): void;
}

interface Waiter {
  bytes: number;
  taskId?: string;
  signal?: AbortSignal;
  resolve: (lease: SessionMemoryLease) => void;
  reject: (error: Error) => void;
  abort: () => void;
}

interface AcquireOptions {
  taskId?: string;
  signal?: AbortSignal;
  /** An unadmitted conversation can lend its worker without loading any history. */
  onWait?: () => void;
}

class BytePool {
  private used = 0;
  private count = 0;
  private readonly waiting: Waiter[] = [];

  constructor(
    readonly limit: number,
    private readonly maxCount: number,
    private readonly label: string,
    private readonly changed: () => void,
  ) {}

  get state() {
    return { bytes: this.used, count: this.count, waiting: this.waiting.length };
  }

  get waitingTaskIds(): string[] {
    return this.waiting.flatMap((waiter) => (waiter.taskId ? [waiter.taskId] : []));
  }

  private validate(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error(`${this.label} has an invalid memory estimate.`);
    if (bytes > this.limit)
      throw new Error(
        `${this.label} needs about ${Math.ceil(bytes / MIB)} MiB, above its ${Math.floor(this.limit / MIB)} MiB memory allowance. Reduce the conversation or images, or increase LOOM_SESSION_MEMORY_MB before resuming. Saved history is preserved.`,
      );
  }

  acquire(bytes: number, options: AcquireOptions = {}): Promise<SessionMemoryLease> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    try {
      this.validate(bytes);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const entry: Waiter = {
        bytes,
        taskId: options.taskId,
        signal: options.signal,
        resolve,
        reject,
        abort: () => {
          const index = this.waiting.indexOf(entry);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          entry.signal?.removeEventListener('abort', entry.abort);
          reject(abortError());
          this.pump();
        },
      };
      this.waiting.push(entry);
      entry.signal?.addEventListener('abort', entry.abort, { once: true });
      this.pump();
      if (this.waiting.includes(entry)) options.onWait?.();
    });
  }

  private pump(): void {
    // FIFO admission prevents a stream of small new requests from starving a
    // larger conversation. Pausing/cancelling withdraws its pending reservation.
    while (this.waiting.length && this.count < this.maxCount) {
      const entry = this.waiting[0];
      if (entry.signal?.aborted) {
        this.waiting.shift();
        entry.signal.removeEventListener('abort', entry.abort);
        entry.reject(abortError());
        continue;
      }
      if (this.used + entry.bytes > this.limit) break;
      this.waiting.shift();
      entry.signal?.removeEventListener('abort', entry.abort);
      let bytes = entry.bytes;
      let released = false;
      this.used += bytes;
      this.count++;
      entry.resolve({
        resize: (next) => {
          if (released) throw new Error('This conversation memory reservation has ended.');
          this.validate(next);
          if (this.used - bytes + next > this.limit)
            throw new Error(
              `${this.label} grew beyond the available memory allowance. Stop another conversation or increase LOOM_SESSION_MEMORY_MB before resuming. Saved history is preserved.`,
            );
          this.used += next - bytes;
          bytes = next;
          this.pump();
        },
        release: () => {
          if (released) return;
          released = true;
          this.used -= bytes;
          this.count--;
          this.pump();
        },
      });
    }
    this.changed();
  }
}

/**
 * Session retention is separate from inference admission. Fixed partitions keep
 * loaded/paused sessions from using the image headroom they need to finish:
 * otherwise every resident could hold memory while waiting forever to hydrate.
 */
export class SessionMemoryBudget {
  private readonly resident: BytePool;
  private readonly temporary: BytePool;
  readonly residentLimitBytes: number;
  readonly temporaryLimitBytes: number;

  constructor(
    readonly limits: SessionMemoryLimits = sessionMemoryLimits(),
    changed: () => void = () => {},
  ) {
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 3)
      throw new Error('The conversation memory budget must be a positive byte count.');
    if (!Number.isSafeInteger(limits.maxSessions) || limits.maxSessions < 1)
      throw new Error('The loaded conversation limit must be a positive integer.');
    this.residentLimitBytes = Math.floor(limits.maxBytes / 3);
    this.temporaryLimitBytes = limits.maxBytes - this.residentLimitBytes;
    this.resident = new BytePool(
      this.residentLimitBytes,
      limits.maxSessions,
      'Conversation history',
      changed,
    );
    this.temporary = new BytePool(
      this.temporaryLimitBytes,
      Infinity,
      'Conversation image processing',
      changed,
    );
  }

  get state() {
    return { resident: this.resident.state, temporary: this.temporary.state };
  }

  get waitingTaskIds(): string[] {
    return [...new Set([...this.resident.waitingTaskIds, ...this.temporary.waitingTaskIds])];
  }

  acquireSession(bytes: number, options?: AcquireOptions): Promise<SessionMemoryLease> {
    return this.resident.acquire(bytes, options);
  }

  acquireTemporary(bytes: number, options?: AcquireOptions): Promise<SessionMemoryLease> {
    return this.temporary.acquire(bytes, options);
  }
}
