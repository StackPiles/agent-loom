import type {
  Bot,
  Message,
  Notification,
  NotificationReplyContext,
  NotificationSender,
  Room,
  Snapshot,
} from './types.js';

export const NOTIFICATION_REPLY_BODY_LIMIT = 32_000;
export const NOTIFICATION_REPLY_SOURCE_LIMIT = 12_000;

export type NotificationReplyBlocked =
  | 'system'
  | 'unknown_sender'
  | 'bot_missing'
  | 'bot_disabled'
  | 'room_missing'
  | 'room_archived'
  | 'not_member'
  | 'source_mismatch';

export interface ResolvedNotification {
  sender: NotificationSender | { kind: 'unknown' };
  senderBasis: 'saved' | 'task' | 'unknown';
  bot?: Bot;
  room?: Room;
  message?: Message;
  canReply: boolean;
  replyBlocked?: NotificationReplyBlocked;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}
function handle(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(value);
}
function knownFields(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function isNotificationSender(value: unknown): value is NotificationSender {
  if (!record(value)) return false;
  if (value.kind === 'system') return knownFields(value, ['kind']);
  return (
    value.kind === 'bot' &&
    knownFields(value, ['kind', 'botId', 'name', 'handle']) &&
    text(value.botId, 1_024) &&
    text(value.name, 160) &&
    handle(value.handle)
  );
}

/** Shared by persistence import and model projection; absence remains legacy data. */
export function isNotificationReplyContext(value: unknown): value is NotificationReplyContext {
  if (!record(value)) return false;
  return (
    knownFields(value, [
      'notificationId',
      'roomId',
      'botId',
      'senderName',
      'senderHandle',
      'title',
      'body',
      'createdAt',
      'messageId',
      'taskId',
    ]) &&
    text(value.notificationId, 1_024) &&
    text(value.roomId, 1_024) &&
    text(value.botId, 1_024) &&
    text(value.senderName, 160) &&
    handle(value.senderHandle) &&
    text(value.title, 160) &&
    text(value.body, NOTIFICATION_REPLY_SOURCE_LIMIT) &&
    text(value.createdAt, 100) &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    (value.messageId === undefined || text(value.messageId, 1_024)) &&
    (value.taskId === undefined || text(value.taskId, 1_024))
  );
}

/** Resolve only persisted identities, never a title, an @mention, or room order. */
export function resolveNotification(
  notification: Notification,
  snapshot: Pick<Snapshot, 'bots' | 'rooms' | 'tasks' | 'messages'>,
): ResolvedNotification {
  const task = snapshot.tasks.find((item) => item.id === notification.taskId);
  const room = snapshot.rooms.find((item) => item.id === notification.roomId);
  const message = snapshot.messages.find((item) => item.id === notification.messageId);
  const messageTask = snapshot.tasks.find((item) => item.id === message?.taskId);
  let sender: ResolvedNotification['sender'] = { kind: 'unknown' };
  let senderBasis: ResolvedNotification['senderBasis'] = 'unknown';
  let mismatch = false;
  if (notification.sender !== undefined) {
    if (isNotificationSender(notification.sender)) {
      sender = notification.sender;
      senderBasis = 'saved';
    } else mismatch = true;
  } else if (task && notification.roomId && task.roomId === notification.roomId) {
    const bot = snapshot.bots.find((item) => item.id === task.botId);
    // A deleted legacy bot still has a known ID, but no recoverable name.
    sender = { kind: 'bot', botId: task.botId, name: bot?.name ?? '', handle: bot?.handle ?? '' };
    senderBasis = 'task';
  } else if (task) mismatch = true;

  const bot =
    sender.kind === 'bot' ? snapshot.bots.find((item) => item.id === sender.botId) : undefined;
  if (sender.kind === 'bot') {
    if (task && (task.botId !== sender.botId || task.roomId !== notification.roomId))
      mismatch = true;
    if (
      messageTask &&
      (messageTask.botId !== sender.botId || messageTask.roomId !== notification.roomId)
    )
      mismatch = true;
    if (
      message &&
      (message.authorType !== 'bot' ||
        message.authorId !== sender.botId ||
        message.roomId !== notification.roomId ||
        Boolean(message.targetBotIds?.length) ||
        (notification.taskId !== undefined && message.taskId !== notification.taskId))
    )
      mismatch = true;
  }
  let replyBlocked: NotificationReplyBlocked | undefined;
  if (mismatch) replyBlocked = 'source_mismatch';
  else if (sender.kind === 'system') replyBlocked = 'system';
  else if (sender.kind === 'unknown') replyBlocked = 'unknown_sender';
  else if (!bot) replyBlocked = 'bot_missing';
  else if (!room) replyBlocked = 'room_missing';
  else if (room.archived) replyBlocked = 'room_archived';
  else if (!bot.enabled) replyBlocked = 'bot_disabled';
  else if (!room.botIds.includes(bot.id)) replyBlocked = 'not_member';
  return {
    sender,
    senderBasis,
    bot,
    room,
    ...(!mismatch && message && sender.kind === 'bot' ? { message } : {}),
    canReply: replyBlocked === undefined,
    ...(replyBlocked ? { replyBlocked } : {}),
  };
}
