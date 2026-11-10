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
  NotificationInput,
  NotificationReplyResult,
  Room,
  Skill,
  Snapshot,
  Task,
  WorkItem,
} from '../shared/types.js';
import { WorkService, type WakeupInput, type WorkInput } from './work.js';
import { SchedulingService, type PriorityRequest } from './scheduling.js';
import type {
  NewTask,
  OperationRecord,
  Runtime,
  RuntimeHost,
  RuntimeShutdownReason,
} from './runtime/contract.js';
import { Store, id, now } from './store.js';
import { automationRevision, saveAutomation, type AutomationInput } from './automations.js';
import type { MailService } from './mail-accounts.js';
import type { ServiceAccount, ServiceAccountInput } from '../shared/service-accounts.js';
import { listServiceAccounts, saveServiceAccount } from './service-accounts.js';
import { LearningStore } from './learning.js';
import { replyToNotification, saveNotification } from './notifications.js';
import { taskInterruptionMessage } from '../shared/task-interruption.js';
import { VERSION } from './version.js';
import { IMAGE_INPUT_LIMITS } from '../shared/image-inputs.js';
import {
  normalizeMemory,
  normalizeSkill,
  type LearningActor,
  type MemoryInput,
  type MemoryMergeInput,
  type MemoryPatch,
  type SkillInput,
  type SkillPatch,
} from '../shared/learning.js';

export const ACTIVE = new Set<Task['status']>([
  'queued',
  'running',
  'waiting_model',
  'waiting_tool',
  'awaiting_approval',
]);
export { VERSION };
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
  /** A supervisor update reserves admission before the scheduler is stopped. */
  maintenance = false;
  private pending = new Map<string, (decision: boolean | null) => void>();
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private readonly learning: LearningStore;
  private readonly scheduling: SchedulingService;
  readonly work: WorkService;
  constructor(readonly store: Store) {
    this.dataDir = store.dataDir;
    this.learning = new LearningStore(store);
    this.scheduling = new SchedulingService(store, {
      assertEligible: (taskId) => this.assertSchedulingTarget(taskId),
      changed: this.changed,
    });
    this.work = new WorkService(store, {
      enqueueTask: (task) => this.enqueueTask(task),
      stopTask: (taskId) => this.stop(taskId),
      changed: this.changed,
      captureScheduling: (taskId) => this.scheduling.capture(taskId),
      inheritScheduling: (taskId, captured) => this.scheduling.inherit(taskId, captured),
    });
    this.events.setMaxListeners(100);
    // Older tasks predate per-room roots. Capture the root before any setting can
    // be edited, so an interrupted operation cannot be replayed in a new folder.
    this.pinLegacyWorkspaces();
    // A process restart must never silently repeat a side effect.
    for (const task of store.list<Task>('tasks'))
      if (
        ACTIVE.has(task.status) &&
        !(task.status === 'queued' && store.get<Room>('rooms', task.roomId)?.paused === true)
      ) {
        const interrupted = store.patch<Task>('tasks', task.id, {
          status: 'interrupted',
          error: 'Server restarted. Review the activity and resume explicitly.',
          updatedAt: now(),
        });
        // This interruption is new, including under a frozen/coarse clock;
        // only failures which predate this startup can use the review marker.
        this.work.taskSettled(interrupted);
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
    for (const task of store.list<Task>('tasks')) this.work.taskSettled(task, true);
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
      skills: s.list<Skill>('skills').map(normalizeSkill),
      memories: s.list<Memory>('memories').map(normalizeMemory),
      automations: s.list('automations'),
      workItems: s.list('workItems'),
      wakeups: s.list('wakeups'),
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
    this.scheduling?.invalidate();
    if (this.closing || this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      this.events.emit('snapshot', this.getSnapshot());
    }, 80);
    this.snapshotTimer.unref();
  };
  updateTask(taskId: string, patch: Partial<Task>) {
    const task = this.store.patch<Task>('tasks', taskId, { ...patch, updatedAt: now() });
    if (patch.status) this.work.taskSettled(task);
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
  serviceCredentialFingerprint(value: string): string {
    return this.store.secretFingerprint('service-account-credential', value);
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
  private assertSchedulingTarget(taskId: string): Task {
    if (this.maintenance) problem('Agent Loom is updating. Please wait for it to restart.', 503);
    if (this.closing) problem('The server is shutting down.', 503);
    const task = required<Task>(this.store, 'tasks', taskId);
    if (!ACTIVE.has(task.status)) problem('Only active tasks can receive temporary priority.', 409);
    const { room } = this.validateTarget(task.roomId, task.botId);
    if (room.paused) problem('Resume this room before changing task priority.', 409);
    if (task.workspacePath && resolve(task.workspacePath) !== this.roomWorkspacePath(task.roomId))
      problem('The task belongs to a different workspace. Review it before continuing.', 409);
    this.work.assertTask(task.id);
    return task;
  }
  getTaskScheduling(taskId: string) {
    return this.scheduling.get(taskId);
  }
  consumeTaskPriority(taskId: string, grantId: string): boolean {
    // The durable decrement must finish before the runtime dispatches. Do not
    // recursively pump the runtime from this admission callback.
    return this.scheduling.consume(taskId, grantId);
  }
  requestTaskPriority(taskId: string, input: PriorityRequest) {
    const result = this.scheduling.request(taskId, input, 'bot');
    this.runtime?.refreshScheduling?.();
    return result;
  }
  prioritizeTask(taskId: string, input: { reason?: string } = {}) {
    const result = this.scheduling.request(
      taskId,
      { reason: input.reason ?? 'The owner requested temporary priority.' },
      'owner',
    );
    this.runtime?.refreshScheduling?.();
    return result;
  }
  revokeTaskPriority(taskId: string) {
    const result = this.scheduling.revoke(taskId);
    this.runtime?.refreshScheduling?.();
    return result;
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
    if (this.maintenance) problem('Agent Loom is updating. Please wait for it to restart.', 503);
    if (this.closing) problem('The server is shutting down.', 503);
    if (this.store.list<Task>('tasks').filter((t) => ACTIVE.has(t.status)).length >= 200)
      problem('The task queue is full. Stop queued work before adding more.', 429);
    this.validateTarget(input.roomId, input.botId);
    if (input.inputImageIds !== undefined) {
      const ids = input.inputImageIds;
      const roomImageIds = new Set(
        this.store
          .list<Message>('messages')
          .filter((message) => message.roomId === input.roomId)
          .flatMap((message) => message.attachments?.map((image) => image.id) ?? []),
      );
      if (
        !Array.isArray(ids) ||
        ids.length > IMAGE_INPUT_LIMITS.maxImages ||
        new Set(ids).size !== ids.length ||
        ids.some((imageId) => !/^img_[a-f0-9]{64}$/.test(imageId) || !roomImageIds.has(imageId))
      )
        problem('Task input images must be valid image attachments from this room.');
    }
    this.pinLegacyWorkspaces(input.roomId);
    const settings = this.store.settings();
    if (!settings.demoMode && (!settings.model.baseUrl || !settings.model.modelId))
      problem('Connect a model in Settings, or enable the clearly labelled demo.', 409);
    const parent = input.parentTaskId
      ? required<Task>(this.store, 'tasks', input.parentTaskId)
      : undefined;
    const workIdentity = this.work.assertAdmission(input, parent);
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
        settings.maxHandoffs !== null &&
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
      ...(input.inputImageIds?.length ? { inputImageIds: [...input.inputImageIds] } : {}),
      ...(input.notificationReply ? { notificationReply: input.notificationReply } : {}),
      workspacePath,
      status: 'queued',
      parentTaskId: input.parentTaskId,
      rootTaskId,
      depth,
      kind: input.kind ?? 'chat',
      ...workIdentity,
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
  pauseRoom(roomId: string): Room {
    const room = required<Room>(this.store, 'rooms', roomId);
    const updated = this.store.patch<Room>('rooms', room.id, { paused: true, updatedAt: now() });
    this.runtime?.setRoomPaused?.(room.id, true);
    this.changed();
    return updated;
  }
  resumeRoom(roomId: string): Room {
    if (this.maintenance) problem('Agent Loom is updating. Please wait for it to restart.', 503);
    if (this.closing) problem('The server is shutting down.', 503);
    const room = required<Room>(this.store, 'rooms', roomId);
    if (room.archived) problem('Unarchive this room before resuming its work.', 409);
    const updated = this.store.patch<Room>('rooms', room.id, { paused: false, updatedAt: now() });
    this.runtime?.setRoomPaused?.(room.id, false);
    this.changed();
    return updated;
  }
  async stop(taskId: string): Promise<Task> {
    const task = required<Task>(this.store, 'tasks', taskId);
    if (!ACTIVE.has(task.status)) {
      // Update preparation briefly settles a paused task as stopped before
      // restoring its held queue. A deliberate stop must cancel that recovery
      // even if the Pi execution has already finished its cleanup.
      if (this.maintenance && task.status === 'stopped') await this.runtime?.stop(taskId);
      return required(this.store, 'tasks', taskId);
    }
    // Record cancellation before yielding: enqueueTask's admission microtask
    // may not have reached runtime.stop's pending queue yet. Started jobs keep
    // their normal abort path so partial output and operation results survive.
    if (task.status === 'queued')
      this.updateTask(taskId, {
        status: 'stopped',
        error: taskInterruptionMessage('owner_stop', true),
        completedAt: now(),
      });
    await this.runtime?.stop(taskId);
    for (const approval of this.store.list<Approval>('approvals'))
      if (approval.taskId === taskId && approval.status === 'pending')
        this.pending.get(approval.id)?.(null);
    const current = required<Task>(this.store, 'tasks', taskId);
    if (ACTIVE.has(current.status)) this.updateTask(taskId, { status: 'stopped' });
    return required(this.store, 'tasks', taskId);
  }
  resume(taskId: string): Task {
    if (this.maintenance) problem('Agent Loom is updating. Please wait for it to restart.', 503);
    if (this.closing) problem('The server is shutting down.', 503);
    this.pinLegacyWorkspaces();
    const task = required<Task>(this.store, 'tasks', taskId);
    if (!['stopped', 'interrupted', 'failed'].includes(task.status))
      problem('Only stopped, interrupted, or failed tasks can be resumed.', 409);
    if (this.store.list<Task>('tasks').filter((t) => ACTIVE.has(t.status)).length >= 200)
      problem('The task queue is full. Stop queued work before resuming.', 429);
    this.validateTarget(task.roomId, task.botId);
    if (task.workId) {
      const work = required<WorkItem>(this.store, 'workItems', task.workId);
      if (work.status !== 'active')
        problem('Review and resume this task’s work item before resuming the task.', 409);
      // Task state is still stopped here; admission validates work scope without
      // treating this explicit owner recovery as another autonomous occurrence.
      this.work.assertAdmission({ ...task, kind: task.kind }, undefined, task.id);
    }
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
  proposeSkill(input: SkillInput, actor?: LearningActor): Skill {
    const skill = this.learning.proposeSkill(input, actor);
    this.changed();
    return skill;
  }
  updateSkill(key: string, patch: SkillPatch, baseVersion: number, actor?: LearningActor): Skill {
    const skill = this.learning.updateSkill(key, patch, baseVersion, actor);
    this.changed();
    return skill;
  }
  restoreSkill(key: string, version: number, baseVersion: number): Skill {
    const skill = this.learning.restoreSkill(key, version, baseVersion);
    this.changed();
    return skill;
  }
  saveMemory(input: MemoryInput, actor?: LearningActor): Memory {
    const memory = this.learning.saveMemory(input, actor);
    this.changed();
    return memory;
  }
  updateMemory(
    key: string,
    patch: MemoryPatch,
    baseVersion: number,
    actor?: LearningActor,
  ): Memory {
    const memory = this.learning.updateMemory(key, patch, baseVersion, actor);
    this.changed();
    return memory;
  }
  restoreMemory(key: string, version: number, baseVersion: number): Memory {
    const memory = this.learning.restoreMemory(key, version, baseVersion);
    this.changed();
    return memory;
  }
  mergeMemories(input: MemoryMergeInput, actor?: LearningActor): Memory {
    const memory = this.learning.mergeMemories(input, actor);
    this.changed();
    return memory;
  }
  notify = (input: NotificationInput): Notification => {
    const notification = saveNotification(this.store, input);
    this.changed();
    return notification;
  };
  replyToNotification(notificationId: string, input: unknown): NotificationReplyResult {
    return replyToNotification(this, notificationId, input);
  }
  useSkill(skillId: string) {
    const skill = required<Skill>(this.store, 'skills', skillId);
    this.store.patch<Skill>('skills', skillId, { useCount: skill.useCount + 1 });
    this.changed();
  }
  getOperation(key: string) {
    return this.store.get<OperationRecord>('operations', key);
  }
  saveOperation(operation: OperationRecord) {
    // Later started/failed/completed writes must not erase an independently
    // recorded unknown delivery or its explicit owner-review acknowledgment.
    const uncertainty = this.getOperation(operation.key)?.uncertainty ?? operation.uncertainty;
    this.store.put('operations', {
      ...operation,
      ...(uncertainty ? { uncertainty } : {}),
      id: operation.key,
    });
  }
  assertWorkTask(taskId: string, allowFinalResponse = false) {
    this.work.assertTask(taskId, allowFinalResponse);
  }
  listWakeups(taskId: string, workId?: string) {
    return this.work.list(taskId, workId);
  }
  manageWakeup(taskId: string, input: WakeupInput) {
    const result = this.work.manageWakeup(taskId, input);
    this.runtime?.refreshScheduling?.();
    return result;
  }
  manageWork(taskId: string, input: WorkInput) {
    return this.work.manageWork(taskId, input);
  }
  recordUncertainWorkMail(taskId: string, operationKey: string, draftId: string) {
    this.work.recordUncertainMail(taskId, operationKey, draftId);
  }
  async shutdown(reason: RuntimeShutdownReason = 'server_shutdown') {
    this.closing = true;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    await this.runtime?.shutdown(reason);
    // enqueueTask persists before its runtime-admission microtask. Closing can
    // win that race, so settle work the runtime has not observed yet as well.
    for (const task of this.store.list<Task>('tasks'))
      if (task.status === 'queued' && this.store.get<Room>('rooms', task.roomId)?.paused !== true)
        this.updateTask(task.id, {
          status: 'interrupted',
          error: taskInterruptionMessage(reason, true),
          completedAt: now(),
        });
    for (const finish of [...this.pending.values()]) finish(null);
    this.events.removeAllListeners();
  }
}
