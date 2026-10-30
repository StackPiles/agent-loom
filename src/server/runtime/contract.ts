import type {
  Activity,
  Approval,
  Memory,
  Message,
  Notification,
  Settings,
  Skill,
  Snapshot,
  Task,
} from '../../shared/types.js';

export type NewTask = Pick<Task, 'roomId' | 'botId' | 'prompt'> &
  Partial<Pick<Task, 'parentTaskId' | 'rootTaskId' | 'depth' | 'kind'>>;
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
}
export interface RuntimeHost {
  dataDir: string;
  getSnapshot(): Snapshot;
  getSecrets(): RuntimeSecrets;
  updateTask(id: string, patch: Partial<Task>): void;
  addMessage(message: Omit<Message, 'id' | 'createdAt'>): Message;
  appendMessage(id: string, delta: string): void;
  updateMessage(id: string, patch: Partial<Message>): void;
  addActivity(activity: Omit<Activity, 'id' | 'createdAt'>): Activity;
  updateActivity(id: string, patch: Partial<Activity>): void;
  requestApproval(
    approval: Omit<Approval, 'id' | 'createdAt' | 'status'>,
    signal: AbortSignal,
  ): Promise<boolean>;
  enqueueTask(task: NewTask): Task;
  proposeSkill(
    skill: Pick<Skill, 'name' | 'description' | 'content' | 'botId' | 'evidence'> & {
      sourceTaskId?: string;
    },
  ): Skill;
  saveMemory(memory: {
    botId: string | null;
    content: string;
    sourceTaskId?: string;
    replacesId?: string;
  }): Memory;
  notify(
    notification: Pick<Notification, 'title' | 'body'> &
      Partial<Pick<Notification, 'roomId' | 'taskId'>>,
  ): Notification;
  useSkill(id: string): void;
  getOperation(key: string): OperationRecord | undefined;
  saveOperation(operation: OperationRecord): void;
  changed(): void;
}
export interface Runtime {
  start(task: Task): void;
  stop(taskId: string): Promise<void>;
  shutdown(): Promise<void>;
  queueState(): { active: number; waiting: number };
}
export interface ToolContext {
  host: RuntimeHost;
  task: Task;
  settings: Settings;
  signal: AbortSignal;
  operationKeys: Set<string>;
}
