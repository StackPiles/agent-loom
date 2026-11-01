import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import type {
  Activity,
  Approval,
  Automation,
  Bot,
  Memory,
  Message,
  Notification,
  Room,
  Skill,
  Snapshot,
  Task,
} from '../shared/types.js';
import type { NewTask, OperationRecord, Runtime, RuntimeHost } from './runtime/contract.js';
import { Store, id, now } from './store.js';
import { automationRevision, saveAutomation, type AutomationInput } from './automations.js';
import type { MailService } from './mail-accounts.js';
import type { ServiceAccount, ServiceAccountInput } from '../shared/service-accounts.js';
import { listServiceAccounts, saveServiceAccount } from './service-accounts.js';

export const ACTIVE = new Set<Task['status']>([
  'queued',
  'running',
  'waiting_model',
  'waiting_tool',
  'awaiting_approval',
]);
export const VERSION = '0.2.2';
export const REASONING_CHAR_LIMIT = 64_000;
export function problem(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}
export function required<T>(store: Store, kind: string, key: string): T {
  return store.get<T>(kind, key) ?? problem('Not found', 404);
}

/** Persistence and UI events are independent of the model adapter. */
export class Controller implements RuntimeHost {
  readonly events = new EventEmitter();
  readonly dataDir: string;
  runtime?: Runtime;
  browser?: RuntimeHost['browser'];
  mail?: MailService;
  closing = false;
  private pending = new Map<string, (decision: boolean | null) => void>();
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  constructor(readonly store: Store) {
    this.dataDir = store.dataDir;
    this.events.setMaxListeners(100);
    // Older tasks predate per-room roots. Capture the root before any setting can
    // be edited, so an interrupted operation cannot be replayed in a new folder.
    this.pinLegacyWorkspaces();
    // A process restart must never silently repeat a side effect.
    for (const task of store.list<Task>('tasks'))
      if (ACTIVE.has(task.status)) {
        store.patch<Task>('tasks', task.id, {
          status: 'interrupted',
          error: 'Server restarted. Review the activity and resume explicitly.',
          updatedAt: now(),
        });
      }
    for (const approval of store.list<Approval>('approvals'))
      if (approval.status === 'pending') {
        store.patch<Approval>('approvals', approval.id, { status: 'cancelled', decidedAt: now() });
      }
    for (const message of store.list<Message>('messages')) {
      for (const image of message.attachments ?? []) store.put('images', image);
      if (message.status === 'streaming')
        store.patch<Message>('messages', message.id, {
          status: 'error',
          ...(message.reasoningStatus === 'streaming' ? { reasoningStatus: 'interrupted' } : {}),
        });
    }
    for (const activity of store.list<Activity>('activities'))
      if (activity.status === 'running' || activity.status === 'pending') {
        store.patch<Activity>('activities', activity.id, {
          status: 'error',
          detail: `${activity.detail}\nInterrupted by server restart.`,
        });
      }
  }
  getSnapshot(): Snapshot {
    const s = this.store;
    return {
      version: VERSION,
      settings: s.settings(),
      bots: s.list('bots'),
      rooms: s.list('rooms'),
      messages: s.list('messages'),
      tasks: s.list('tasks'),
      activities: s.list('activities'),
      approvals: s.list('approvals'),
      skills: s.list('skills'),
      memories: s.list('memories'),
      automations: s.list('automations'),
      mailAccounts: this.mail?.list() ?? [],
      serviceAccounts: listServiceAccounts(s),
      notifications: s.list('notifications'),
      queue: this.runtime?.queueState() ?? { active: 0, waiting: 0 },
    };
  }
  getSecrets() {
    return {
      modelApiKey: this.store.secret('model.apiKey'),
      searchApiKey: this.store.secret('search.apiKey'),
      imageApiKey: this.store.secret('image.apiKey'),
    };
  }
  changed = () => {
    if (this.closing || this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      this.events.emit('snapshot', this.getSnapshot());
    }, 80);
    this.snapshotTimer.unref();
  };
  updateTask(taskId: string, patch: Partial<Task>) {
    this.store.patch<Task>('tasks', taskId, { ...patch, updatedAt: now() });
    this.changed();
  }
  addMessage(input: Omit<Message, 'id' | 'createdAt'>) {
    const message = this.store.put<Message>('messages', {
      ...input,
      id: id('msg'),
      createdAt: now(),
    });
    this.store.patch<Room>('rooms', message.roomId, { updatedAt: now() });
    for (const image of message.attachments ?? []) this.store.put('images', image);
    this.changed();
    return message;
  }
  appendMessage(messageId: string, delta: string) {
    const message = required<Message>(this.store, 'messages', messageId);
    this.store.patch<Message>('messages', messageId, { body: message.body + delta });
    this.events.emit('message_delta', { messageId, delta });
    this.changed();
  }
  appendReasoning(messageId: string, delta: string) {
    if (!delta) return;
    const message = required<Message>(this.store, 'messages', messageId);
    const current = message.reasoning ?? '';
    let accepted = delta.slice(0, Math.max(0, REASONING_CHAR_LIMIT - current.length));
    if (accepted.length < delta.length && /[\uD800-\uDBFF]$/.test(accepted))
      accepted = accepted.slice(0, -1);
    const truncated = Boolean(message.reasoningTruncated || accepted.length < delta.length);
    if (!accepted && message.reasoningTruncated) return;
    this.store.patch<Message>('messages', messageId, {
      reasoning: current + accepted,
      reasoningStatus: 'streaming',
      reasoningTruncated: truncated,
    });
    this.events.emit('message_reasoning_delta', { messageId, delta: accepted, truncated });
    this.changed();
  }
  updateMessage(messageId: string, patch: Partial<Message>) {
    this.store.patch<Message>('messages', messageId, patch);
    for (const image of patch.attachments ?? []) this.store.put('images', image);
    this.events.emit('message_updated', { messageId, patch });
    this.changed();
  }
  addActivity(input: Omit<Activity, 'id' | 'createdAt'>) {
    const messageId =
      input.messageId ??
      this.store
        .list<Message>('messages')
        .findLast((message) => message.taskId === input.taskId && message.status === 'streaming')
        ?.id;
    const activity = this.store.put<Activity>('activities', {
      ...input,
      messageId,
      id: id('act'),
      createdAt: now(),
    });
    this.changed();
    return activity;
  }
  updateActivity(activityId: string, patch: Partial<Activity>) {
    this.store.patch<Activity>('activities', activityId, patch);
    this.changed();
  }
  requestApproval(
    input: Omit<Approval, 'id' | 'createdAt' | 'status'>,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted || this.closing) return Promise.resolve(false);
    const approval = this.store.put<Approval>('approvals', {
      ...input,
      id: id('approval'),
      createdAt: now(),
      status: 'pending',
    });
    this.changed();
    return new Promise((resolve) => {
      const finish = (decision: boolean | null) => {
        if (!this.pending.delete(approval.id)) return;
        signal.removeEventListener('abort', abort);
        this.store.patch<Approval>('approvals', approval.id, {
          status: decision === null ? 'cancelled' : decision ? 'approved' : 'denied',
          decidedAt: now(),
        });
        this.changed();
        resolve(decision === true);
      };
      const abort = () => finish(null);
      this.pending.set(approval.id, finish);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  decideApproval(approvalId: string, approve: boolean): Approval {
    const approval = required<Approval>(this.store, 'approvals', approvalId);
    if (approval.status !== 'pending' || !this.pending.has(approvalId))
      problem(
        'This approval is no longer pending. Resume the task to request a new approval.',
        409,
      );
    this.pending.get(approvalId)!(approve);
    return required(this.store, 'approvals', approvalId);
  }
  saveAutomation(input: AutomationInput, expected?: { id: string; revision?: string }): Automation {
    const existing = expected
      ? required<Automation>(this.store, 'automations', expected.id)
      : undefined;
    if (existing && expected?.revision && automationRevision(existing) !== expected.revision)
      problem(
        'This automation changed while awaiting approval. Review the current settings and start a fresh request.',
        409,
      );
    const automation = saveAutomation(this.store, input, existing);
    this.changed();
    return automation;
  }
  saveServiceAccount(
    input: ServiceAccountInput,
    expected?: { id: string; revision: number },
  ): ServiceAccount {
    const account = saveServiceAccount(
      this.store,
      { ...input, ...(expected ? { expectedRevision: expected.revision } : {}) },
      expected?.id,
    );
    this.changed();
    return account;
  }
  validateTarget(roomId: string, botId: string) {
    const room = required<Room>(this.store, 'rooms', roomId);
    const bot = required<Bot>(this.store, 'bots', botId);
    if (room.archived) problem('Restore this room before starting a task.', 409);
    if (!bot.enabled || !room.botIds.includes(botId))
      problem('Choose an enabled bot that belongs to this room.', 400);
    return { room, bot };
  }
  roomWorkspacePath(roomId: string): string {
    const room = required<Room>(this.store, 'rooms', roomId);
    return resolve(room.workspacePath || this.store.settings().workspacePath);
  }
  pinLegacyWorkspaces(roomId?: string): void {
    const fallback = resolve(this.store.settings().workspacePath);
    const rooms = new Map(this.store.list<Room>('rooms').map((room) => [room.id, room]));
    for (const task of this.store.list<Task>('tasks')) {
      if (task.workspacePath || (roomId && task.roomId !== roomId)) continue;
      const room = rooms.get(task.roomId);
      this.store.patch<Task>('tasks', task.id, {
        workspacePath: resolve(room?.workspacePath || fallback),
      });
    }
  }
  enqueueTask = (input: NewTask): Task => {
    if (this.closing) problem('The server is shutting down.', 503);
    if (this.store.list<Task>('tasks').filter((t) => ACTIVE.has(t.status)).length >= 200)
      problem('The task queue is full. Stop queued work before adding more.', 429);
    this.validateTarget(input.roomId, input.botId);
    this.pinLegacyWorkspaces(input.roomId);
    const settings = this.store.settings();
    if (!settings.demoMode && (!settings.model.baseUrl || !settings.model.modelId))
      problem('Connect a model in Settings, or enable the clearly labelled demo.', 409);
    const taskId = id('task');
    let rootTaskId = taskId,
      depth = 0;
    let workspacePath = this.roomWorkspacePath(input.roomId);
    if (input.parentTaskId) {
      const parent = required<Task>(this.store, 'tasks', input.parentTaskId);
      if (parent.roomId !== input.roomId) problem('Bot handoffs must stay in the same room.');
      rootTaskId = parent.rootTaskId;
      depth = parent.depth + 1;
      workspacePath = parent.workspacePath ?? workspacePath;
      const handoffs = this.store
        .list<Task>('tasks')
        .filter(
          (t) => t.rootTaskId === rootTaskId && t.id !== rootTaskId && t.kind !== 'learning',
        ).length;
      if (
        input.kind !== 'learning' &&
        (handoffs >= settings.maxHandoffs || depth > settings.maxHandoffs)
      )
        problem(
          'This conversation reached its handoff limit. Send a new message to continue.',
          409,
        );
    }
    const task: Task = {
      id: taskId,
      roomId: input.roomId,
      botId: input.botId,
      prompt: input.prompt,
      workspacePath,
      status: 'queued',
      parentTaskId: input.parentTaskId,
      rootTaskId,
      depth,
      kind: input.kind ?? 'chat',
      output: '',
      createdAt: now(),
      updatedAt: now(),
      inputTokens: 0,
      outputTokens: 0,
    };
    this.store.put('tasks', task);
    this.changed();
    this.startPersisted(task);
    return task;
  };
  private startPersisted(task: Task) {
    queueMicrotask(() => {
      if (this.closing || this.store.get<Task>('tasks', task.id)?.status !== 'queued') return;
      try {
        this.runtime?.start(task);
      } catch (error) {
        this.updateTask(task.id, {
          status: 'failed',
          error: error instanceof Error ? error.message : 'Could not start the task.',
        });
      }
    });
  }
  async stop(taskId: string): Promise<Task> {
    const task = required<Task>(this.store, 'tasks', taskId);
    if (!ACTIVE.has(task.status)) return task;
    await this.runtime?.stop(taskId);
    for (const approval of this.store.list<Approval>('approvals'))
      if (approval.taskId === taskId && approval.status === 'pending')
        this.pending.get(approval.id)?.(null);
    const current = required<Task>(this.store, 'tasks', taskId);
    if (ACTIVE.has(current.status)) this.updateTask(taskId, { status: 'stopped' });
    return required(this.store, 'tasks', taskId);
  }
  resume(taskId: string): Task {
    this.pinLegacyWorkspaces();
    const task = required<Task>(this.store, 'tasks', taskId);
    if (!['stopped', 'interrupted', 'failed'].includes(task.status))
      problem('Only stopped, interrupted, or failed tasks can be resumed.', 409);
    if (this.store.list<Task>('tasks').filter((t) => ACTIVE.has(t.status)).length >= 200)
      problem('The task queue is full. Stop queued work before resuming.', 429);
    this.validateTarget(task.roomId, task.botId);
    if (resolve(task.workspacePath!) !== this.roomWorkspacePath(task.roomId))
      problem(
        'This task was started in a different workspace folder. Restore the room’s original folder to resume it, or send a new message to work in the new folder.',
        409,
      );
    const settings = this.store.settings();
    if (!settings.demoMode && (!settings.model.modelId || !settings.model.baseUrl))
      problem('Connect a model before resuming.', 409);
    this.updateTask(taskId, { status: 'queued', error: undefined, completedAt: undefined });
    const resumed = required<Task>(this.store, 'tasks', taskId);
    this.startPersisted(resumed);
    return resumed;
  }
  proposeSkill(
    input: Pick<Skill, 'name' | 'description' | 'content' | 'botId' | 'evidence'> & {
      sourceTaskId?: string;
    },
  ): Skill {
    if (input.botId) required<Bot>(this.store, 'bots', input.botId);
    const stamp = now();
    const skill = this.store.put<Skill>('skills', {
      ...input,
      id: id('skill'),
      status: 'candidate',
      version: 1,
      useCount: 0,
      createdAt: stamp,
      updatedAt: stamp,
      revisions: [
        {
          version: 1,
          content: input.content,
          description: input.description,
          createdAt: stamp,
          reason: input.sourceTaskId ? 'Proposed after a task' : 'Created by the user',
        },
      ],
    });
    this.changed();
    return skill;
  }
  saveMemory(input: {
    botId: string | null;
    content: string;
    sourceTaskId?: string;
    replacesId?: string;
  }): Memory {
    if (input.botId) required<Bot>(this.store, 'bots', input.botId);
    const normalized = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    if (input.replacesId) {
      const existing = required<Memory>(this.store, 'memories', input.replacesId);
      if (existing.botId !== input.botId) problem('Memory replacement must keep the same owner.');
      const memory = this.store.patch<Memory>('memories', existing.id, {
        content: input.content,
        sourceTaskId: input.sourceTaskId,
        updatedAt: now(),
      });
      this.changed();
      return memory;
    }
    const match = this.store
      .list<Memory>('memories')
      .find((m) => m.botId === input.botId && normalized(m.content) === normalized(input.content));
    if (match) return match;
    const { replacesId: _, ...fields } = input;
    const memory = this.store.put<Memory>('memories', {
      ...fields,
      id: id('memory'),
      createdAt: now(),
      updatedAt: now(),
    });
    this.changed();
    return memory;
  }
  notify = (
    input: Pick<Notification, 'title' | 'body'> & Partial<Pick<Notification, 'roomId' | 'taskId'>>,
  ): Notification => {
    const recent = this.store
      .list<Notification>('notifications')
      .find(
        (n) =>
          n.title === input.title &&
          n.body === input.body &&
          n.roomId === input.roomId &&
          Date.now() - Date.parse(n.createdAt) < 60_000,
      );
    if (recent) return recent;
    const notification = this.store.put<Notification>('notifications', {
      ...input,
      id: id('notice'),
      read: false,
      createdAt: now(),
    });
    this.changed();
    return notification;
  };
  useSkill(skillId: string) {
    const skill = required<Skill>(this.store, 'skills', skillId);
    this.store.patch<Skill>('skills', skillId, { useCount: skill.useCount + 1 });
    this.changed();
  }
  getOperation(key: string) {
    return this.store.get<OperationRecord>('operations', key);
  }
  saveOperation(operation: OperationRecord) {
    this.store.put('operations', { ...operation, id: operation.key });
  }
  async shutdown() {
    this.closing = true;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    await this.runtime?.shutdown();
    for (const finish of [...this.pending.values()]) finish(null);
    this.events.removeAllListeners();
  }
}
