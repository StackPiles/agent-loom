import type { Message, Task } from './types.js';
import { IMAGE_INPUT_LIMITS } from './image-inputs.js';

export const TASK_INPUT_BODY_LIMIT = 32_000;
export const TASK_INPUT_PENDING_LIMIT = 32;
export const TASK_INPUT_TOTAL_LIMIT = 200;

export type TaskInputMode = 'boundary' | 'immediate';
export type TaskInputStatus = 'pending' | 'delivered' | 'cancelled';

/** A durable owner instruction for one already-admitted task. */
export interface TaskInput {
  id: string;
  requestId: string;
  taskId: string;
  roomId: string;
  botId: string;
  messageId: string;
  sequence: number;
  body: string;
  inputImageIds?: string[];
  mode: TaskInputMode;
  status: TaskInputStatus;
  createdAt: string;
  deliveredAt?: string;
  cancelledAt?: string;
  reason?: string;
}

export interface TaskInputResult {
  input: TaskInput;
  message: Message;
  duplicate: boolean;
}

export function canAcceptTaskInput(task: Pick<Task, 'status' | 'kind'>): boolean {
  return (
    (task.kind === 'chat' || task.kind === 'automation') &&
    ['queued', 'running', 'waiting_model', 'waiting_tool', 'awaiting_approval'].includes(
      task.status,
    )
  );
}

export function isTaskInput(value: unknown): value is TaskInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'id',
          'requestId',
          'taskId',
          'roomId',
          'botId',
          'messageId',
          'sequence',
          'body',
          'inputImageIds',
          'mode',
          'status',
          'createdAt',
          'deliveredAt',
          'cancelledAt',
          'reason',
        ].includes(key),
    )
  )
    return false;
  const reference = (item: unknown) =>
    typeof item === 'string' &&
    item.length > 0 &&
    item.length <= 1024 &&
    !/[\x00-\x1f\x7f]/.test(item);
  const timestamp = (item: unknown) =>
    typeof item === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) &&
    Number.isFinite(Date.parse(item)) &&
    new Date(item).toISOString() === item;
  const imageIds = input.inputImageIds;
  if (
    typeof input.requestId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId) ||
    input.id !== 'taskinput_' + input.requestId.replaceAll('-', '') ||
    !['taskId', 'roomId', 'botId', 'messageId'].every((key) => reference(input[key])) ||
    !Number.isSafeInteger(input.sequence) ||
    (input.sequence as number) < 1 ||
    (input.sequence as number) > TASK_INPUT_TOTAL_LIMIT ||
    typeof input.body !== 'string' ||
    input.body.length > TASK_INPUT_BODY_LIMIT ||
    input.body !== input.body.trim() ||
    typeof input.mode !== 'string' ||
    !['boundary', 'immediate'].includes(input.mode) ||
    typeof input.status !== 'string' ||
    !['pending', 'delivered', 'cancelled'].includes(input.status) ||
    !timestamp(input.createdAt) ||
    (imageIds !== undefined &&
      (!Array.isArray(imageIds) ||
        imageIds.length > IMAGE_INPUT_LIMITS.maxImages ||
        new Set(imageIds).size !== imageIds.length ||
        !imageIds.every(
          (imageId) => typeof imageId === 'string' && /^img_[a-f0-9]{64}$/.test(imageId),
        ))) ||
    (!input.body && (!Array.isArray(imageIds) || imageIds.length === 0)) ||
    (input.reason !== undefined &&
      (typeof input.reason !== 'string' ||
        input.reason.length > 1000 ||
        /[\x00-\x1f\x7f]/.test(input.reason)))
  )
    return false;
  return (
    (input.status === 'delivered'
      ? timestamp(input.deliveredAt)
      : input.deliveredAt === undefined) &&
    (input.status === 'cancelled' ? timestamp(input.cancelledAt) : input.cancelledAt === undefined)
  );
}

/** Distinguishes a revised owner instruction from denial, task stop and tool failure. */
export class TaskInputSupersededError extends Error {
  readonly code = 'task_input_superseded';
  constructor() {
    super(
      'This pending operation was superseded by a new instruction for the same task. Read the new instruction before planning another operation.',
    );
    this.name = 'TaskInputSupersededError';
  }
}
