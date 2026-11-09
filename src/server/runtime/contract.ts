import type {
  Activity,
  Approval,
  Automation,
  Memory,
  Message,
  Notification,
  NotificationInput,
  QueueState,
  Settings,
  Skill,
  Snapshot,
  Task,
} from '../../shared/types.js';
import type { BrowserManager } from '../browser-manager.js';
import type { AutomationInput, AutomationExpectation } from '../automations.js';
import type { MailService } from '../mail-accounts.js';
import type { ServiceAccount, ServiceAccountInput } from '../../shared/service-accounts.js';
import type {
  LearningActor,
  MemoryInput,
  MemoryMergeInput,
  MemoryPatch,
  SkillInput,
  SkillPatch,
} from '../../shared/learning.js';
import type { RuntimeShutdownReason } from '../../shared/task-interruption.js';
import type { WakeupListing, WorkItem, Wakeup } from '../../shared/work.js';
import type { WakeupInput, WorkInput } from '../work.js';
import type { TaskSchedulingSnapshot } from '../../shared/scheduling.js';
import type { InferencePurpose } from './scheduling.js';

export type { RuntimeShutdownReason } from '../../shared/task-interruption.js';

export type NewTask = Pick<Task, 'roomId' | 'botId' | 'prompt'> &
  Partial<
    Pick<
      Task,
      | 'parentTaskId'
      | 'rootTaskId'
      | 'depth'
      | 'kind'
      | 'notificationReply'
      | 'workId'
      | 'workRunId'
      | 'wakeupId'
    >
  >;
export interface OperationRecord {
  key: string;
  taskId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'started' | 'completed' | 'failed';
  result?: string;
  /** Server-verified ambiguous delivery; only explicit owner review acknowledges it. */
  uncertainty?: { kind: 'mail'; draftId: string; reviewedAt?: string };
  updatedAt: string;
}
export interface RuntimeSecrets {
  modelApiKey?: string;
  searchApiKey?: string;
  imageApiKey?: string;
}
export interface RuntimeHost {
  dataDir: string;
  browser?: BrowserManager;
  mail?: Pick<
    MailService,
    | 'list'
    | 'get'
    | 'listMessages'
    | 'readMessage'
    | 'listDrafts'
    | 'getDraft'
    | 'saveDraft'
    | 'sendDraft'
  >;
  getSnapshot(): Snapshot;
  getSecrets(): RuntimeSecrets;
  updateTask(id: string, patch: Partial<Task>): void;
  addMessage(message: Omit<Message, 'id' | 'createdAt'>): Message;
  appendMessage(id: string, delta: string): void;
  /** Persist and immediately publish provider-reported reasoning, separately from answer text. */
  appendReasoning(id: string, delta: string): void;
  updateMessage(id: string, patch: Partial<Message>): void;
  addActivity(activity: Omit<Activity, 'id' | 'createdAt'>): Activity;
  updateActivity(id: string, patch: Partial<Activity>): void;
  requestApproval(
    approval: Omit<Approval, 'id' | 'createdAt' | 'status'>,
    signal: AbortSignal,
  ): Promise<boolean>;
  enqueueTask(task: NewTask): Task;
  getTaskScheduling?(taskId: string): TaskSchedulingSnapshot;
  /** Atomically spend one admitted priority request from the current shared grant. */
  consumeTaskPriority?(taskId: string, grantId: string): boolean;
  requestTaskPriority?(
    taskId: string,
    input: { reason: string; deadlineAt?: string },
  ): TaskSchedulingSnapshot;
  assertWorkTask?(taskId: string, allowFinalResponse?: boolean): void;
  listWakeups?(taskId: string, workId?: string): WakeupListing;
  manageWakeup?(taskId: string, input: WakeupInput): { work: WorkItem; wakeup: Wakeup };
  manageWork?(taskId: string, input: WorkInput): Promise<WorkItem>;
  /** Report a saved unknown mail outcome; never accepts model-provided authority. */
  recordUncertainWorkMail?(taskId: string, operationKey: string, draftId: string): void;
  /** Only explicit owner-approved room automation mutations use this capability. */
  saveAutomation?(input: AutomationInput, expected?: AutomationExpectation): Automation;
  saveServiceAccount?(
    input: ServiceAccountInput,
    expected?: { id: string; revision: number },
  ): ServiceAccount;
  /** Stable keyed identity for a write-only service credential; never its plaintext. */
  serviceCredentialFingerprint?(value: string): string;
  proposeSkill(skill: SkillInput, actor?: LearningActor): Skill;
  saveMemory(memory: MemoryInput, actor?: LearningActor): Memory;
  updateSkill?(id: string, patch: SkillPatch, baseVersion: number, actor?: LearningActor): Skill;
  updateMemory?(id: string, patch: MemoryPatch, baseVersion: number, actor?: LearningActor): Memory;
  mergeMemories?(input: MemoryMergeInput, actor?: LearningActor): Memory;
  notify(notification: NotificationInput): Notification;
  useSkill(id: string): void;
  getOperation(key: string): OperationRecord | undefined;
  saveOperation(operation: OperationRecord): void;
  changed(): void;
}
export interface Runtime {
  start(task: Task): void;
  stop(taskId: string): Promise<void>;
  shutdown(reason?: RuntimeShutdownReason): Promise<void>;
  queueState(): QueueState;
  configureInference?(): void;
  /** Re-evaluate waiting work after a grant or durable work identity changes. */
  refreshScheduling?(): void;
  /** Let the current action finish, then hold subsequent actions until room resume. */
  setRoomPaused?(roomId: string, paused: boolean): void;
  /** True only for a live task parked between actions in its still-paused room. */
  isTaskSuspended?(taskId: string): boolean;
  /** Under application maintenance, save paused work for explicit room resume after an update. */
  prepareForUpdate?(): Promise<void>;
  /** Reserve the same request capacity for explicit application generation jobs. */
  acquireInference?(signal: AbortSignal): Promise<() => void>;
}
export interface ToolContext {
  host: RuntimeHost;
  task: Task;
  settings: Settings;
  signal: AbortSignal;
  operationKeys: Set<string>;
  /** Abortable boundary before the next tool/model action, including worker readmission. */
  waitForRoom?: (signal: AbortSignal) => Promise<void>;
  /** Cancels only capacity waits on pause; never attach this signal to an active action. */
  roomPauseSignal?: () => AbortSignal;
  /** Share the runtime's configured request capacity with an image-model tool. */
  acquireInference?: (signal: AbortSignal, purpose?: InferencePurpose) => Promise<() => void>;
  /** A resource queue may be withdrawn before its action starts; caller releases and checkpoints before retry. */
  acquireCapacity?: (
    signal: AbortSignal,
    acquire: (signal: AbortSignal) => Promise<() => void>,
  ) => Promise<() => void>;
}
