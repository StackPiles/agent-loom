import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Controller } from './controller.js';
import type { Store } from './store.js';
import { now } from './store.js';
import { chatImageUploadSchema, saveChatImages, validateChatImageSizes } from './chat-images.js';
import { IMAGE_INPUT_LIMITS } from '../shared/image-inputs.js';
import { modelImageInputEnabled } from '../shared/model-settings.js';
import {
  canAcceptTaskInput,
  TASK_INPUT_BODY_LIMIT,
  TASK_INPUT_PENDING_LIMIT,
  TASK_INPUT_TOTAL_LIMIT,
  type TaskInput,
  type TaskInputResult,
} from '../shared/task-inputs.js';
import type { Message, Task } from '../shared/types.js';

export const taskInputSchema = z
  .object({
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    body: z.string().trim().max(TASK_INPUT_BODY_LIMIT),
    mode: z.enum(['boundary', 'immediate']).default('boundary'),
    images: z.array(chatImageUploadSchema).max(IMAGE_INPUT_LIMITS.maxImages).optional(),
  })
  .strict();

export type NewTaskInput = z.infer<typeof taskInputSchema>;
export interface StoredTaskInput extends TaskInput {
  /** Private keyed receipt identity; never exposed through the room snapshot. */
  requestFingerprint: string;
}

function problem(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}

export function publicTaskInput(input: StoredTaskInput): TaskInput {
  const { requestFingerprint: _fingerprint, ...visible } = input;
  return visible;
}

export function listTaskInputs(store: Store): TaskInput[] {
  return store.list<StoredTaskInput>('taskInputs').map(publicTaskInput);
}

function fingerprint(store: Store, taskId: string, input: NewTaskInput): string {
  const hash = createHash('sha256').update(JSON.stringify([taskId, input.body, input.mode]));
  for (const image of input.images ?? []) {
    hash.update(JSON.stringify([image.filename, image.mimeType, image.data.length]));
    hash.update(image.data);
  }
  return store.secretFingerprint('task-input', hash.digest('hex'));
}

function acceptedInput(
  store: Store,
  receipt: StoredTaskInput,
  taskId: string,
  requestFingerprint: string,
): TaskInputResult {
  if (receipt.taskId !== taskId || receipt.requestFingerprint !== requestFingerprint)
    problem(
      'This additional-instruction request ID was already used for different content or a different task.',
      409,
    );
  const message = store.get<Message>('messages', receipt.messageId);
  if (
    !message ||
    message.taskInputId !== receipt.id ||
    message.taskId !== receipt.taskId ||
    message.roomId !== receipt.roomId ||
    message.authorType !== 'user' ||
    message.authorId !== 'user' ||
    message.body !== receipt.body ||
    message.targetBotIds?.length !== 1 ||
    message.targetBotIds[0] !== receipt.botId ||
    JSON.stringify(message.attachments?.map((image) => image.id) ?? []) !==
      JSON.stringify(receipt.inputImageIds ?? [])
  )
    problem(
      'The saved additional instruction is incomplete. Review the task history before sending another instruction.',
      409,
    );
  return { input: publicTaskInput(receipt), message, duplicate: true };
}

/** Rechecked after attachment I/O, immediately before the atomic owner-message commit. */
function assertAdmission(controller: Controller, taskId: string): Task {
  if (controller.maintenance)
    problem('Agent Loom is updating. Please wait for it to restart.', 503);
  if (controller.closing) problem('The server is shutting down.', 503);
  const task = controller.store.get<Task>('tasks', taskId);
  if (!task) problem('Not found', 404);
  if (!canAcceptTaskInput(task))
    problem(
      'This task is no longer accepting additional instructions. Keep the message and send it as a new request, or resume the task first.',
      409,
    );
  try {
    controller.validateTarget(task.roomId, task.botId);
  } catch (error) {
    const targetError = error as Error & { statusCode?: number };
    if (targetError.statusCode === 400 || targetError.statusCode === 404)
      problem(targetError.message, 409);
    throw error;
  }
  if (
    task.workspacePath &&
    resolve(task.workspacePath) !== controller.roomWorkspacePath(task.roomId)
  )
    problem('The task belongs to a different workspace. Review it before continuing.', 409);
  controller.assertWorkTask(task.id, true);
  const prior = controller.store
    .list<TaskInput>('taskInputs')
    .filter((item) => item.taskId === taskId);
  if (prior.length >= TASK_INPUT_TOTAL_LIMIT)
    problem(
      'This task has reached its additional-instruction limit. Start a new request after reviewing its progress.',
      429,
    );
  if (prior.filter((item) => item.status === 'pending').length >= TASK_INPUT_PENDING_LIMIT)
    problem('This task already has too many instructions waiting to be delivered.', 429);
  return task;
}

function notifyRuntime(controller: Controller, input: TaskInput): void {
  if (input.status !== 'pending') return;
  try {
    controller.runtime?.notifyTaskInput?.(input.taskId);
  } catch {
    // Acceptance is already durable. Never discard its attachment or report an
    // unaccepted request merely because an in-memory wake-up failed.
    controller.changed();
  }
  controller.supersedeTaskApprovals(input.taskId);
}

/** Persist an input before waking the active task; retries return this same receipt. */
export async function receiveTaskInput(
  controller: Controller,
  taskId: string,
  value: unknown,
): Promise<TaskInputResult> {
  const input = taskInputSchema.parse(value);
  if (!input.body && !input.images?.length)
    problem('Write an additional instruction or attach an image before sending.');
  const { store } = controller;
  const inputId = 'taskinput_' + input.requestId.replaceAll('-', '');
  const requestFingerprint = fingerprint(store, taskId, input);
  const prior = store.get<StoredTaskInput>('taskInputs', inputId);
  if (prior) {
    const result = acceptedInput(store, prior, taskId, requestFingerprint);
    notifyRuntime(controller, result.input);
    return result;
  }
  const validate = () => {
    const task = assertAdmission(controller, taskId);
    const settings = store.settings();
    if (settings.demoMode)
      problem(
        'Additional instructions are available with a connected conversation model. Disable demo mode in Settings first.',
        409,
      );
    if (!settings.model.modelId || !settings.model.baseUrl)
      problem(
        'Connect a conversation model in Settings before sending an additional instruction.',
        409,
      );
    if (input.images?.length && !modelImageInputEnabled(settings))
      problem(
        'Enable image input for an image-capable conversation model before attaching images.',
      );
    return task;
  };
  validate();
  const saved = await saveChatImages(store.dataDir, input.images ?? [], store.settings().images);
  let result: TaskInputResult;
  let committed = false;
  try {
    const raced = store.get<StoredTaskInput>('taskInputs', inputId);
    if (raced) {
      result = acceptedInput(store, raced, taskId, requestFingerprint);
      await saved.discard();
      notifyRuntime(controller, result.input);
      return result;
    }
    const task = validate();
    validateChatImageSizes(saved.images, store.settings().images);
    const previous = store.list<TaskInput>('taskInputs').filter((item) => item.taskId === taskId);
    const sequence = Math.max(0, ...previous.map((item) => item.sequence)) + 1;
    if (!Number.isSafeInteger(sequence) || sequence > TASK_INPUT_TOTAL_LIMIT)
      problem(
        'This task has invalid additional-instruction history. Review it before continuing.',
        409,
      );
    store.db.exec('SAVEPOINT task_input');
    try {
      const message = controller.addMessage({
        roomId: task.roomId,
        authorType: 'user',
        authorId: 'user',
        body: input.body,
        taskId: task.id,
        taskInputId: inputId,
        targetBotIds: [task.botId],
        status: 'complete',
        ...(saved.images.length ? { attachments: saved.images } : {}),
      });
      const receipt = store.put<StoredTaskInput>('taskInputs', {
        id: inputId,
        requestId: input.requestId,
        taskId: task.id,
        roomId: task.roomId,
        botId: task.botId,
        messageId: message.id,
        sequence,
        body: input.body,
        mode: input.mode,
        status: 'pending',
        createdAt: now(),
        requestFingerprint,
        ...(saved.images.length ? { inputImageIds: saved.images.map((image) => image.id) } : {}),
      });
      store.db.exec('RELEASE SAVEPOINT task_input');
      committed = true;
      result = { input: publicTaskInput(receipt), message, duplicate: false };
    } catch (error) {
      store.db.exec('ROLLBACK TO SAVEPOINT task_input');
      store.db.exec('RELEASE SAVEPOINT task_input');
      throw error;
    }
  } catch (error) {
    if (!committed) await saved.discard();
    throw error;
  }
  notifyRuntime(controller, result.input);
  controller.changed();
  return result;
}

export function markTaskInputsDelivered(
  store: Store,
  taskId: string,
  inputIds: readonly string[],
  reason?: string,
): void {
  const inputs = [...new Set(inputIds)].map((inputId) => {
    const input = store.get<StoredTaskInput>('taskInputs', inputId);
    if (!input || input.taskId !== taskId || input.status === 'cancelled')
      throw new Error('Only accepted instructions for this task can be marked delivered.');
    return input;
  });
  store.db.exec('SAVEPOINT task_input_delivery');
  try {
    for (const input of inputs)
      if (input.status === 'pending')
        store.patch<StoredTaskInput>('taskInputs', input.id, {
          status: 'delivered',
          deliveredAt: now(),
          ...(reason ? { reason: reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000) } : {}),
        });
    store.db.exec('RELEASE SAVEPOINT task_input_delivery');
  } catch (error) {
    store.db.exec('ROLLBACK TO SAVEPOINT task_input_delivery');
    store.db.exec('RELEASE SAVEPOINT task_input_delivery');
    throw error;
  }
}
