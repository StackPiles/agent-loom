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
  /** Future checks and dependencies; these do not block scheduled continuation. */
  pendingChecks?: string[];
  /** Already attempted external actions whose success or failure is unknown. */
  uncertainActions: string[];
}

export interface WorkCompletionDecision {
  /** Opaque identity returned in completionReview.items. */
  itemId: string;
  action: 'wait' | 'dismiss' | 'defer';
  /** Evidence that this choice preserves the work's requested purpose. */
  reason: string;
}

export interface WorkCompletionInput {
  summary: string;
  decisions: WorkCompletionDecision[];
  /** A review deadline, never a deadline for declaring the work successful. */
  waitUntil?: string;
  followUp?: { name: string; purpose: string };
}

export interface WorkCompletionItem {
  id: string;
  kind: 'task' | 'wakeup' | 'check';
  label: string;
  taskId?: string;
  wakeupId?: string;
  /** The last occurrence observed when reviewing a recurring reservation. */
  lastTaskId?: string;
  /** Reservation revision or accepted owner-instruction generation. */
  revision?: number;
  status?: string;
}

export interface WorkCompletionReview {
  id: string;
  status: 'needs_review' | 'waiting' | 'review_queued' | 'resolved';
  requestedByTaskId?: string;
  workRunId: string;
  requestedAt: string;
  items: WorkCompletionItem[];
  decisions?: WorkCompletionDecision[];
  summary?: string;
  waitUntil?: string;
  reviewTaskId?: string;
  followUpWorkId?: string;
  lastError?: string;
  retryAfter?: string;
  /** Limits automatic reviews when repeatedly waiting on the same unresolved work. */
  attempts: number;
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
  completionReview?: WorkCompletionReview;
  /** Saved follow-up scope; old tasks and operation receipts keep their original work. */
  deferredFromWorkId?: string;
  /** Full saved backlog; the short checkpoint may summarize only its first items. */
  deferredItems?: Array<WorkCompletionItem & { reason: string }>;
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
