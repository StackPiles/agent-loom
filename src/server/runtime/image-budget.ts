/** Raw bytes of new image pixels returned by tools in one task execution. */
export const IMAGE_INPUT_TASK_MAX_BYTES = 80 * 1024 * 1024;

/**
 * Shared by explicit image reads and immediate screenshot inclusion. This
 * bounds new tool output, not the size of previously persisted model history.
 * Reserve only after a successful read and the final permission check, just
 * before returning pixels. Tool execution is sequential, so no release is needed.
 */
export class ImageInputBudget {
  private usedBytes = 0;

  get remainingBytes(): number {
    return IMAGE_INPUT_TASK_MAX_BYTES - this.usedBytes;
  }

  tryReserve(byteLength: number): boolean {
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > this.remainingBytes)
      return false;
    this.usedBytes += byteLength;
    return true;
  }
}
