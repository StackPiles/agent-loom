import { IMAGE_INPUT_LIMITS } from '../../shared/image-inputs.js';

/** Raw bytes of new image pixels returned by tools in one task execution. */
export const IMAGE_INPUT_TASK_MAX_BYTES = IMAGE_INPUT_LIMITS.maxTotalBytes;

/**
 * Shared by explicit image reads and immediate screenshot inclusion. This
 * bounds new tool output, not the size of previously persisted model history.
 * Reserve only after a successful read and the final permission check, just
 * before returning pixels. Tool execution is sequential, so no release is needed.
 */
export class ImageInputBudget {
  private usedBytes = 0;

  constructor(private readonly limit: number | (() => number) = IMAGE_INPUT_TASK_MAX_BYTES) {}

  get limitBytes(): number {
    return typeof this.limit === 'function' ? this.limit() : this.limit;
  }

  get remainingBytes(): number {
    // Changing settings while paused updates the allowance without resetting usage.
    return Math.max(0, this.limitBytes - this.usedBytes);
  }

  tryReserve(byteLength: number): boolean {
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > this.remainingBytes)
      return false;
    this.usedBytes += byteLength;
    return true;
  }
}
