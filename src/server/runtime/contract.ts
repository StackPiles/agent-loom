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

export type NewTask = Pick<Task, 'roomId' | 'botId' | 'prompt'> &
  Partial<Pick<Task, 'parentTaskId' | 'rootTaskId' | 'depth' | 'kind' | 'notificationReply'>>;
export interface OperationRecord {
  key: string;
  taskId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'started' | 'completed' | 'failed';
  result?: string;
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
  /** Only explicit owner-approved room automation mutations use this capability. */
  saveAutomation?(input: AutomationInput, expected?: AutomationExpectation): Automation;
  saveServiceAccount?(
    input: ServiceAccountInput,
    expected?: { id: string; revision: number },
  ): ServiceAccount;
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
  shutdown(): Promise<void>;
  queueState(): QueueState;
  configureInference?(): void;
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
  acquireInference?: (signal: AbortSignal) => Promise<() => void>;
}
