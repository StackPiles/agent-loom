/** A single, abortable FIFO inference slot, shared by every room and bot. */
export class InferenceGate {
  private held = false;
  private waiting: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort: () => void;
    background: boolean;
  }> = [];

  constructor(private readonly changed: () => void = () => {}) {}

  get state(): { active: number; waiting: number } {
    return { active: this.held ? 1 : 0, waiting: this.waiting.length };
  }

  acquire(signal?: AbortSignal, background = false): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        background,
        abort: () => {
          const index = this.waiting.indexOf(entry);
          if (index !== -1) {
            this.waiting.splice(index, 1);
            reject(abortError());
            this.changed();
          }
        },
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.waiting.push(entry);
      this.pump();
    });
  }

  private pump(): void {
    if (this.held) {
      this.changed();
      return;
    }
    // Foreground remains FIFO. Learning uses idle capacity without delaying people.
    const nextForeground = this.waiting.findIndex((entry) => !entry.background);
    const entry = this.waiting.splice(Math.max(0, nextForeground), 1)[0];
    if (!entry) {
      this.changed();
      return;
    }
    entry.signal?.removeEventListener('abort', entry.abort);
    if (entry.signal?.aborted) {
      entry.reject(abortError());
      this.pump();
      return;
    }
    this.held = true;
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      this.held = false;
      this.pump();
    });
    this.changed();
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
