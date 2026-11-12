import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  Bot,
  Message,
  Notification,
  NotificationInput,
  NotificationReplyContext,
  NotificationReplyResult,
  NotificationSender,
  Room,
  Task,
} from '../shared/types.js';
import {
  isNotificationReplyContext,
  isNotificationSender,
  NOTIFICATION_REPLY_BODY_LIMIT,
  NOTIFICATION_REPLY_SOURCE_LIMIT,
  resolveNotification,
  type NotificationReplyBlocked,
} from '../shared/notifications.js';
import { IMAGE_INPUT_LIMITS } from '../shared/image-inputs.js';
import { modelImageInputEnabled } from '../shared/model-settings.js';
import { chatImageUploadSchema, saveChatImages } from './chat-images.js';
import type { Controller } from './controller.js';
import type { OperationRecord } from './runtime/contract.js';
import { Store, id, now } from './store.js';

export const notificationReplySchema = z
  .object({
    body: z.string().trim().max(NOTIFICATION_REPLY_BODY_LIMIT),
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    images: z.array(chatImageUploadSchema).max(IMAGE_INPUT_LIMITS.maxImages).optional(),
  })
  .strict();
export type NotificationReplyInput = z.infer<typeof notificationReplySchema>;

function problem(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}
function required<T>(store: Store, kind: string, key: string): T {
  return store.get<T>(kind, key) ?? problem('Not found', 404);
}

export function saveNotification(store: Store, input: NotificationInput): Notification {
  const { senderBotId, ...fields } = input;
  let sender: NotificationSender = { kind: 'system' };
  if (senderBotId !== undefined) {
    if (!input.roomId || !input.taskId)
      problem('A bot notification must identify its current room and task.');
    const bot = required<Bot>(store, 'bots', senderBotId);
    const task = required<Task>(store, 'tasks', input.taskId);
    if (task.botId !== bot.id || task.roomId !== input.roomId)
      problem('The notification sender must match its task and room.');
    sender = { kind: 'bot', botId: bot.id, name: bot.name, handle: bot.handle };
    if (!isNotificationSender(sender)) problem('The notification sender identity is invalid.');
    if (input.messageId) {
      const message = required<Message>(store, 'messages', input.messageId);
      if (
        message.authorType !== 'bot' ||
        message.authorId !== bot.id ||
        message.roomId !== task.roomId ||
        message.taskId !== task.id ||
        message.targetUser !== true ||
        message.targetBotIds?.length
      )
        problem('The notification message must be this bot’s user-directed post in this task.');
    }
  }
  const recent = store
    .list<Notification>('notifications')
    .find(
      (notification) =>
        notification.title === input.title &&
        notification.body === input.body &&
        notification.roomId === input.roomId &&
        notification.taskId === input.taskId &&
        notification.messageId === input.messageId &&
        notification.sender?.kind === sender.kind &&
        (sender.kind !== 'bot' ||
          (notification.sender?.kind === 'bot' && notification.sender.botId === sender.botId)) &&
        Date.now() - Date.parse(notification.createdAt) < 60_000,
    );
  if (recent) return recent;
  return store.put<Notification>('notifications', {
    ...fields,
    sender,
    id: id('notice'),
    read: false,
    createdAt: now(),
  });
}

const unavailable: Record<NotificationReplyBlocked, string> = {
  system: 'This is a system notification and has no bot reply recipient.',
  unknown_sender: 'The sender of this older notification cannot be identified.',
  bot_missing: 'The bot that sent this notification no longer exists.',
  bot_disabled: 'Enable this bot before replying to its notification.',
  room_missing: 'The original room no longer exists.',
  room_archived: 'Restore the original room before replying.',
  not_member: 'The sender no longer belongs to the original room.',
  source_mismatch: 'The notification has inconsistent sender, room, or source references.',
};

function notificationContext(store: Store, notification: Notification) {
  const task = notification.taskId ? store.get<Task>('tasks', notification.taskId) : undefined;
  const message = notification.messageId
    ? store.get<Message>('messages', notification.messageId)
    : undefined;
  const messageTask = message?.taskId ? store.get<Task>('tasks', message.taskId) : undefined;
  const botId = notification.sender?.kind === 'bot' ? notification.sender.botId : task?.botId;
  const bot = botId ? store.get<Bot>('bots', botId) : undefined;
  const room = notification.roomId ? store.get<Room>('rooms', notification.roomId) : undefined;
  return resolveNotification(notification, {
    bots: bot ? [bot] : [],
    rooms: room ? [room] : [],
    tasks: [task, messageTask].filter((item): item is Task => item !== undefined),
    messages: message ? [message] : [],
  });
}

function acceptedReply(
  store: Store,
  receipt: OperationRecord,
  notificationId: string,
  input: NotificationReplyInput,
  requestFingerprint: string,
): NotificationReplyResult {
  if (
    receipt.toolName !== 'reply_to_notification' ||
    receipt.status !== 'completed' ||
    receipt.args?.notificationId !== notificationId ||
    receipt.args?.requestId !== input.requestId ||
    receipt.args?.body !== input.body ||
    (receipt.args?.requestFingerprint === undefined
      ? !!input.images?.length
      : receipt.args.requestFingerprint !== requestFingerprint)
  )
    problem('This reply request ID was already used with a different or incomplete request.', 409);
  let recorded: { messageId?: unknown; taskId?: unknown } = {};
  try {
    recorded = JSON.parse(receipt.result ?? '{}') as typeof recorded;
  } catch {
    problem('The previous reply receipt is unavailable. Review the original room.', 409);
  }
  const message =
    typeof recorded?.messageId === 'string'
      ? store.get<Message>('messages', recorded.messageId)
      : undefined;
  const task =
    typeof recorded?.taskId === 'string' ? store.get<Task>('tasks', recorded.taskId) : undefined;
  if (
    !message ||
    !task ||
    receipt.taskId !== task.id ||
    message.authorType !== 'user' ||
    message.authorId !== 'user' ||
    message.body !== input.body ||
    task.prompt !== replyPrompt(input) ||
    (message.attachments?.length ?? 0) !== (input.images?.length ?? 0) ||
    JSON.stringify(message.attachments?.map((image) => image.id) ?? []) !==
      JSON.stringify(task.inputImageIds ?? []) ||
    task.kind !== 'chat' ||
    task.parentTaskId !== undefined ||
    task.rootTaskId !== task.id ||
    task.depth !== 0 ||
    message.roomId !== task.roomId ||
    message.targetBotIds?.length !== 1 ||
    message.targetBotIds[0] !== task.botId ||
    !isNotificationReplyContext(message.notificationReply) ||
    !isNotificationReplyContext(task.notificationReply) ||
    message.notificationReply.notificationId !== notificationId ||
    task.notificationReply.notificationId !== notificationId ||
    task.notificationReply.roomId !== task.roomId ||
    task.notificationReply.botId !== task.botId ||
    Object.keys({ ...task.notificationReply, ...message.notificationReply }).some(
      (key) =>
        task.notificationReply![key as keyof NotificationReplyContext] !==
        message.notificationReply![key as keyof NotificationReplyContext],
    )
  )
    problem('The previously accepted reply is no longer complete. Review the original room.', 409);
  const notification = store.get<Notification>('notifications', notificationId);
  if (!notification)
    problem('The reply was accepted, but its original notification is no longer available.', 409);
  return { message, tasks: [task], notification, duplicate: true };
}

function replyPrompt(input: NotificationReplyInput): string {
  return (
    input.body || 'Please examine the attached images and respond in the conversation’s language.'
  );
}

function fingerprint(store: Store, notificationId: string, input: NotificationReplyInput): string {
  const hash = createHash('sha256').update(JSON.stringify([notificationId, input.body]));
  for (const image of input.images ?? []) {
    hash.update(JSON.stringify([image.filename, image.mimeType, image.data.length]));
    hash.update(image.data);
  }
  // Receipts retain only a keyed digest, never uploaded pixels or encoded image data.
  return store.secretFingerprint('notification-reply', hash.digest('hex'));
}

/** Recheck the owner request after attachment I/O, immediately before its atomic commit. */
function prepareReply(
  controller: Controller,
  notificationId: string,
  input: NotificationReplyInput,
) {
  const { store } = controller;
  if (controller.maintenance)
    problem('Agent Loom is updating. Please wait for it to restart.', 503);
  if (controller.closing) problem('The server is shutting down.', 503);
  const notification = required<Notification>(store, 'notifications', notificationId);
  const source = notificationContext(store, notification);
  if (!source.canReply || source.sender.kind !== 'bot' || !source.bot || !source.room)
    problem(unavailable[source.replyBlocked ?? 'unknown_sender'], 409);
  const settings = store.settings();
  if (!settings.demoMode && (!settings.model.modelId || !settings.model.baseUrl))
    problem('Connect a model in Settings, or enable the clearly labelled demo.', 409);
  if (input.images?.length && !modelImageInputEnabled(settings))
    problem(
      'Enable image input for an image-capable conversation model in Settings before attaching images.',
    );
  controller.validateTarget(source.room.id, source.bot.id);
  const context: NotificationReplyContext = {
    notificationId,
    roomId: source.room.id,
    botId: source.bot.id,
    senderName: source.sender.name,
    senderHandle: source.sender.handle,
    title: notification.title.trim().slice(0, 160),
    body: (source.message?.targetUser === true ? source.message.body : notification.body)
      .trim()
      .slice(0, NOTIFICATION_REPLY_SOURCE_LIMIT),
    createdAt: notification.createdAt,
    ...(notification.messageId ? { messageId: notification.messageId } : {}),
    ...(notification.taskId ? { taskId: notification.taskId } : {}),
  };
  if (!isNotificationReplyContext(context))
    problem('The original notification does not contain a valid reply context.', 409);
  return { context, workspacePath: controller.roomWorkspacePath(source.room.id) };
}

/** Admit one owner request; retries read the durable receipt without starting more work. */
export async function replyToNotification(
  controller: Controller,
  notificationId: string,
  inputValue: unknown,
): Promise<NotificationReplyResult> {
  const input = notificationReplySchema.parse(inputValue);
  if (!input.body && !input.images?.length)
    problem('Write a reply or attach an image before sending.');
  const { store } = controller;
  const key = `notification-reply:${notificationId}:${input.requestId}`;
  const requestFingerprint = fingerprint(store, notificationId, input);
  const receipt = store.get<OperationRecord>('operations', key);
  if (receipt) return acceptedReply(store, receipt, notificationId, input, requestFingerprint);
  const initial = prepareReply(controller, notificationId, input);
  const saved = await saveChatImages(store.dataDir, input.images ?? []);
  let result: NotificationReplyResult;
  let committed = false;
  try {
    const raced = store.get<OperationRecord>('operations', key);
    if (raced) {
      result = acceptedReply(store, raced, notificationId, input, requestFingerprint);
      await saved.discard();
      return result;
    }
    const current = prepareReply(controller, notificationId, input);
    if (JSON.stringify(current) !== JSON.stringify(initial))
      problem('This notification changed while its images were being saved. Review it again.', 409);
    const { context } = current;
    // No asynchronous work may run inside this savepoint. A task can observe
    // only a committed message, its image records and receipt, or no work after rollback.
    store.db.exec('SAVEPOINT notification_reply');
    try {
      const message = controller.addMessage({
        roomId: context.roomId,
        authorType: 'user',
        authorId: 'user',
        body: input.body,
        targetBotIds: [context.botId],
        notificationReply: context,
        status: 'complete',
        ...(saved.images.length ? { attachments: saved.images } : {}),
      });
      const task = controller.enqueueTask({
        roomId: context.roomId,
        botId: context.botId,
        prompt: replyPrompt(input),
        notificationReply: context,
        ...(saved.images.length ? { inputImageIds: saved.images.map((image) => image.id) } : {}),
      });
      const updated = store.patch<Notification>('notifications', notificationId, { read: true });
      store.put('operations', {
        id: key,
        key,
        taskId: task.id,
        toolName: 'reply_to_notification',
        args: { notificationId, requestId: input.requestId, body: input.body, requestFingerprint },
        status: 'completed',
        result: JSON.stringify({ messageId: message.id, taskId: task.id }),
        updatedAt: now(),
      });
      store.db.exec('RELEASE SAVEPOINT notification_reply');
      committed = true;
      result = { message, tasks: [task], notification: updated, duplicate: false };
    } catch (error) {
      store.db.exec('ROLLBACK TO SAVEPOINT notification_reply');
      store.db.exec('RELEASE SAVEPOINT notification_reply');
      throw error;
    }
  } catch (error) {
    if (!committed) await saved.discard();
    throw error;
  }
  controller.changed();
  return result;
}
