import type { AutomationSchedule } from './schedules.js';

/** Owner-controlled room policy. Missing on older rooms means disabled. */
export interface AutonomousWakeupPolicy {
  mode: 'off' | 'self' | 'room';
  minIntervalMinutes: number;
  maxPendingWakeups: number;
  maxRunsPerHour: number;
}

export const DEFAULT_AUTONOMOUS_WAKEUP_POLICY: AutonomousWakeupPolicy = {
  mode: 'off',
  minIntervalMinutes: 5,
  maxPendingWakeups: 24,
  maxRunsPerHour: 12,
};

export function autonomousWakeupPolicy(
  value?: Partial<AutonomousWakeupPolicy>,
): AutonomousWakeupPolicy {
  return { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, ...value };
}

export interface WorkCheckpoint {
  summary: string;
  completed: string;
  nextStep: string;
  references: string[];
  doneWhen: string;
  uncertainActions: string[];
}

export interface WorkItem {
  id: string;
  roomId: string;
  name: string;
  purpose: string;
  kind: 'task' | 'standing';
  status: 'active' | 'paused' | 'blocked' | 'completed' | 'cancelled';
  createdByBotId: string;
  sourceTaskId: string;
  /** The owner's room description and bot role at creation; never a tool-provided grant. */
  scope: string;
  workspacePath: string;
  checkpoint: WorkCheckpoint;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  /** A closing bot task may produce its final answer but may not run more tools. */
  finishedByTaskId?: string;
  /** The owner explicitly reviewed a blocked/paused continuation at this instant. */
  reviewedAt?: string;
}

export interface Wakeup {
  id: string;
  workId: string;
  roomId: string;
  botId: string;
  createdByBotId: string;
  sourceTaskId: string;
  /** Stable per-work, per-author, per-target key for updating the same next step. */
  key: string;
  reason: string;
  prompt: string;
  schedule: AutomationSchedule;
  status: 'scheduled' | 'dispatched' | 'missed' | 'cancelled';
  nextRunAt?: string;
  lastRunAt?: string;
  lastTaskId?: string;
  lastError?: string;
  /** Retained across one-time continuations. Recurring occurrences get a fresh run at dispatch. */
  workRunId: string;
  retryAfter?: string;
  /** Owner cancellation cannot be silently undone by a bot upsert. */
  cancelledBy?: 'owner' | 'bot';
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface WakeupListing {
  currentTimeUtc: string;
  policy: AutonomousWakeupPolicy;
  workItems: WorkItem[];
  wakeups: Wakeup[];
}
