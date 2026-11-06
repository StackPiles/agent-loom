/** Known application lifecycle causes only; never persist arbitrary process errors or URLs. */
export const RUNTIME_SHUTDOWN_REASONS = [
  'server_shutdown',
  'process_sigint',
  'process_sigterm',
  'supervisor_shutdown',
  'supervisor_disconnect',
  'application_update',
  'data_export',
  'data_restore',
  'startup_failure',
] as const;

export type RuntimeShutdownReason = (typeof RUNTIME_SHUTDOWN_REASONS)[number];
export type TaskInterruptionReason = RuntimeShutdownReason | 'owner_stop' | 'unexpected';

const interruptionPrefixes: Record<TaskInterruptionReason, string> = {
  owner_stop: 'Stopped by the user.',
  server_shutdown: 'Interrupted because the server shut down.',
  process_sigint: 'Interrupted because the server received SIGINT.',
  process_sigterm: 'Interrupted because the server received SIGTERM.',
  supervisor_shutdown: 'Interrupted because the application supervisor requested shutdown.',
  supervisor_disconnect: 'Interrupted because the application lost its supervisor connection.',
  application_update: 'Interrupted because the application is restarting for an update.',
  data_export: 'Interrupted because a data export restarted the application.',
  data_restore: 'Interrupted because data restoration restarted the application.',
  startup_failure: 'Interrupted because the server could not finish starting.',
  unexpected: 'Interrupted because execution was cancelled unexpectedly.',
};
const resumeAdvice =
  ' Review progress and resume explicitly; completed side effects will not be replayed automatically.';
const stoppedBeforeExecution = 'Stopped by the user before execution.';

export function taskInterruptionMessage(
  reason: TaskInterruptionReason,
  beforeExecution = false,
): string {
  if (reason === 'owner_stop' && beforeExecution) return stoppedBeforeExecution;
  return interruptionPrefixes[reason] + resumeAdvice;
}

/** Legacy or provider-written prose cannot establish who requested cancellation. */
export function classifyTaskInterruption(value: unknown): TaskInterruptionReason | 'unknown' {
  if (value === stoppedBeforeExecution) return 'owner_stop';
  for (const reason of Object.keys(interruptionPrefixes) as TaskInterruptionReason[])
    if (value === taskInterruptionMessage(reason)) return reason;
  return 'unknown';
}
