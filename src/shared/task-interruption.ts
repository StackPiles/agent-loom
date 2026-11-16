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
export const TASK_STOP_REASONS = [
  'owner_stop',
  'work_completed',
  'work_cancelled',
  'work_paused',
  'work_superseded',
  'work_deferred',
] as const;
export type TaskStopReason = (typeof TASK_STOP_REASONS)[number];
export type TaskInterruptionReason = RuntimeShutdownReason | TaskStopReason | 'unexpected';

/** Server-recorded cause; model/provider text cannot establish who stopped a task. */
export interface TaskStopContext {
  reason: TaskStopReason;
  actorType: 'owner' | 'bot' | 'system';
  actorId?: string;
  workId?: string;
  causeTaskId?: string;
  at: string;
  detail?: string;
}

export function isTaskStopReason(reason: TaskInterruptionReason): reason is TaskStopReason {
  return (TASK_STOP_REASONS as readonly string[]).includes(reason);
}

/** Preserve the first cause, except that a deliberate owner stop takes priority. */
export function preferTaskStopContext(
  previous: TaskStopContext | undefined,
  requested: TaskStopContext,
): TaskStopContext {
  if (!previous || (previous.reason !== 'owner_stop' && requested.reason === 'owner_stop'))
    return requested;
  return previous;
}

const interruptionPrefixes: Record<TaskInterruptionReason, string> = {
  owner_stop: 'Stopped by the user.',
  work_completed: 'Ended because the related work was completed.',
  work_cancelled: 'Ended because the related work was cancelled.',
  work_paused: 'Stopped because the related work was paused.',
  work_superseded: 'Ended because this task was no longer needed for the related work.',
  work_deferred: 'Ended because the remaining task was saved as follow-up work.',
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
  if (isTaskStopReason(reason) && reason !== 'owner_stop')
    return interruptionPrefixes[reason] + (beforeExecution ? ' Execution had not started.' : '');
  return interruptionPrefixes[reason] + resumeAdvice;
}

export function taskInterruptionTitle(reason: TaskInterruptionReason): string {
  switch (reason) {
    case 'owner_stop':
      return 'Task stopped by the user';
    case 'work_completed':
      return 'Related work completed';
    case 'work_cancelled':
      return 'Related work cancelled';
    case 'work_paused':
      return 'Related work paused';
    case 'work_superseded':
      return 'Task no longer needed';
    case 'work_deferred':
      return 'Task saved as follow-up work';
    default:
      return 'Task interrupted';
  }
}

/** Legacy or provider-written prose cannot establish who requested cancellation. */
export function classifyTaskInterruption(value: unknown): TaskInterruptionReason | 'unknown' {
  if (value === stoppedBeforeExecution) return 'owner_stop';
  for (const reason of Object.keys(interruptionPrefixes) as TaskInterruptionReason[])
    if (
      value === taskInterruptionMessage(reason) ||
      (isTaskStopReason(reason) && value === taskInterruptionMessage(reason, true))
    )
      return reason;
  return 'unknown';
}
