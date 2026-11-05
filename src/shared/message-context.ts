import type { Message, Task } from './types.js';

/** The origin of a task, not a delivery target or an automatic reply route. */
export type TaskRequestSource =
  | { kind: 'user' }
  | { kind: 'bot'; botId: string }
  | { kind: 'automation' }
  | { kind: 'learning' }
  | { kind: 'unknown' };

export interface MessageContext {
  audience: 'user' | 'bots' | 'room';
  targetBotIds: string[];
  source: TaskRequestSource;
}

/** Directed tool posts refer to their task, but are not new generation attempts. */
export function isTaskOutputMessage(message: Message): boolean {
  return (
    message.authorType === 'bot' && message.targetUser !== true && !message.targetBotIds?.length
  );
}

export function getTaskRequestSource(
  task: Task | undefined,
  tasks: ReadonlyMap<string, Task>,
): TaskRequestSource {
  if (!task) return { kind: 'unknown' };
  if (task.kind === 'learning') return { kind: 'learning' };
  if (task.parentTaskId) {
    const parent = tasks.get(task.parentTaskId);
    if (
      !parent ||
      parent.id === task.id ||
      parent.roomId !== task.roomId ||
      parent.botId === task.botId ||
      parent.kind !== task.kind ||
      parent.rootTaskId !== task.rootTaskId ||
      !Number.isInteger(parent.depth) ||
      parent.depth < 0 ||
      task.depth !== parent.depth + 1
    )
      return { kind: 'unknown' };
    return { kind: 'bot', botId: parent.botId };
  }
  if (task.rootTaskId !== task.id || task.depth !== 0) return { kind: 'unknown' };
  // Production root chat tasks are admitted by the owner's room-message route.
  if (task.kind === 'chat') return { kind: 'user' };
  if (task.kind === 'automation') return { kind: 'automation' };
  return { kind: 'unknown' };
}

export function getMessageContext(
  message: Message,
  tasks: ReadonlyMap<string, Task>,
): MessageContext {
  const shared: MessageContext = {
    audience: 'room',
    targetBotIds: [],
    source: { kind: 'unknown' },
  };
  if (message.authorType === 'system') return shared;
  const targetBotIds = [...new Set(message.targetBotIds?.filter((id) => id.length > 0) ?? [])];
  if (message.targetUser === true) {
    if (message.authorType !== 'bot' || targetBotIds.length) return shared;
    return { audience: 'user', targetBotIds: [], source: { kind: 'unknown' } };
  }
  // Only persisted routing metadata establishes a recipient. Textual @mentions
  // in a bot's ordinary answer do not queue work for another bot.
  if (targetBotIds.length) return { audience: 'bots', targetBotIds, source: { kind: 'unknown' } };
  if (message.authorType !== 'bot') return shared;
  const task = message.taskId ? tasks.get(message.taskId) : undefined;
  if (!task || task.roomId !== message.roomId || task.botId !== message.authorId) return shared;
  return { ...shared, source: getTaskRequestSource(task, tasks) };
}
