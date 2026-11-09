export const PRIORITY_WINDOW_MS = 5 * 60_000;
export const OWNER_PRIORITY_REQUESTS = 3;
export const BOT_PRIORITY_REQUESTS = 1;

export interface SchedulingGrant {
  id: string;
  source: 'owner' | 'bot';
  reason: string;
  requestedAt: string;
  expiresAt: string;
  remainingRequests: number;
  grantedRequests: number;
  /** Includes consumption merged from other groups, which can exceed this grant's quota. */
  consumedRequests?: number;
  deadlineAt?: string;
  /** Revocation keeps the original window and attribution instead of refilling it. */
  revokedAt?: string;
}

export interface TaskScheduling {
  grant?: SchedulingGrant;
  /** An exact grant reference, so a later grant on that task cannot revive this one. */
  grantRedirect?: { taskId: string; grantId: string };
}

export interface TaskSchedulingSnapshot {
  groupId: string;
  /** Exhausted and revoked grants remain visible until their window expires. */
  grant?: SchedulingGrant;
  /** Its old reference is unavailable; retain cooldown without offering an upgrade. */
  grantUnavailable?: boolean;
}

export type SchedulingPurpose = 'response' | 'compaction' | 'image' | 'helper';
export type SchedulingDispatchReason = 'owner' | 'bot' | 'waiting' | 'fair';

export interface TaskSchedulingInfo extends TaskSchedulingSnapshot {
  taskId: string;
  purpose: SchedulingPurpose;
  waitingSince?: string;
  occupiedMs: number;
  lastDispatchReason?: SchedulingDispatchReason;
  lastDispatchedAt?: string;
  blockingTaskId?: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const instant = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 80 &&
  /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));

export function isSchedulingGrant(value: unknown): value is SchedulingGrant {
  if (!record(value)) return false;
  const allowed = new Set([
    'id',
    'source',
    'reason',
    'requestedAt',
    'expiresAt',
    'remainingRequests',
    'grantedRequests',
    'consumedRequests',
    'deadlineAt',
    'revokedAt',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (
    !text(value.id, 160) ||
    (value.source !== 'owner' && value.source !== 'bot') ||
    !text(value.reason, 500) ||
    !instant(value.requestedAt) ||
    !instant(value.expiresAt) ||
    Date.parse(value.expiresAt) - Date.parse(value.requestedAt) !== PRIORITY_WINDOW_MS ||
    value.grantedRequests !==
      (value.source === 'owner' ? OWNER_PRIORITY_REQUESTS : BOT_PRIORITY_REQUESTS) ||
    typeof value.remainingRequests !== 'number' ||
    !Number.isInteger(value.remainingRequests) ||
    value.remainingRequests < 0 ||
    value.remainingRequests > (value.grantedRequests as number) ||
    (value.consumedRequests !== undefined &&
      (typeof value.consumedRequests !== 'number' ||
        !Number.isSafeInteger(value.consumedRequests) ||
        value.consumedRequests < 0 ||
        value.remainingRequests >
          Math.max(0, (value.grantedRequests as number) - value.consumedRequests))) ||
    (value.deadlineAt !== undefined && !instant(value.deadlineAt)) ||
    (value.revokedAt !== undefined &&
      (!instant(value.revokedAt) ||
        value.remainingRequests !== 0 ||
        Date.parse(value.revokedAt) < Date.parse(value.requestedAt) ||
        Date.parse(value.revokedAt) >= Date.parse(value.expiresAt)))
  )
    return false;
  return true;
}

export function isTaskScheduling(value: unknown): value is TaskScheduling {
  if (!record(value)) return false;
  if (Object.keys(value).some((key) => !['grant', 'grantRedirect'].includes(key))) return false;
  if (value.grant !== undefined && !isSchedulingGrant(value.grant)) return false;
  if (value.grantRedirect !== undefined) {
    if (!value.grant || !record(value.grantRedirect)) return false;
    if (
      Object.keys(value.grantRedirect).some((key) => !['taskId', 'grantId'].includes(key)) ||
      !text(value.grantRedirect.taskId, 160) ||
      !text(value.grantRedirect.grantId, 160)
    )
      return false;
  }
  return true;
}
