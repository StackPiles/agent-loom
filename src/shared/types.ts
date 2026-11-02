import type { MailAccount } from './mail-accounts.js';
import type { ServiceAccount } from './service-accounts.js';
import type { AutomationSchedule } from './schedules.js';

export type { AutomationSchedule } from './schedules.js';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_model'
  | 'waiting_tool'
  | 'awaiting_approval'
  | 'stopped'
  | 'interrupted'
  | 'failed'
  | 'completed';
export type Permission = 'allow' | 'auto' | 'ask' | 'deny';
export type ReasoningEffort =
  'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export interface ImageSettings {
  enabled: boolean;
  baseUrl: string;
  modelId: string;
  apiKeyConfigured: boolean;
  size: string;
  responseFormat: 'auto' | 'b64_json';
  timeoutSeconds: number;
  shareInferenceSlot: boolean;
}
export interface InferenceSettings {
  maxConcurrentRequests: number;
}
export interface BrowserSettings {
  enabled: boolean;
  mode: 'existing' | 'dedicated';
  permission: Permission;
  includeScreenshotsInModel: boolean;
}
export interface BrowserTab {
  pageId: number;
  url: string;
  title?: string;
  protected?: boolean;
}
export interface BrowserStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'error';
  mode: BrowserSettings['mode'];
  platform: string;
  busy: boolean;
  tabs: BrowserTab[];
  error?: string;
}
export interface GeneratedImage {
  id: string;
  type: 'image';
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  filename: string;
  byteLength: number;
  prompt: string;
  model: string;
  createdAt: string;
}
export interface AvatarGeneration {
  id: string;
  status: 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  prompt: string;
  image?: GeneratedImage;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface QueueState {
  active: number;
  waiting: number;
  capacity?: number;
  modelWaiting?: number;
  sessionWaiting?: number;
  waitingTasks?: Array<{
    taskId: string;
    reason: 'inference' | 'room' | 'session' | 'worker';
  }>;
}
export interface ModelSettings {
  baseUrl: string;
  modelId: string;
  apiKeyConfigured: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  reasoningMode?: 'server' | 'openai';
  reasoningEffort?: ReasoningEffort;
}
export interface Settings {
  model: ModelSettings;
  images?: ImageSettings;
  inference?: InferenceSettings;
  browser?: BrowserSettings;
  demoMode: boolean;
  autoLearn: boolean;
  maxHandoffs: number;
  workspacePath: string;
  permissions: { shell: Permission; fileWrite: Permission; network: Permission };
  search: { provider: 'none' | 'searxng' | 'brave'; baseUrl: string; apiKeyConfigured: boolean };
}
export interface Bot {
  id: string;
  name: string;
  handle: string;
  role: string;
  systemPrompt: string;
  color: string;
  avatar: string;
  enabled: boolean;
  createdAt: string;
}
export interface Room {
  id: string;
  name: string;
  description: string;
  workspacePath?: string;
  parallelResponses?: boolean;
  botIds: string[];
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface Message {
  id: string;
  roomId: string;
  authorType: 'user' | 'bot' | 'system';
  authorId: string;
  body: string;
  taskId?: string;
  status: 'complete' | 'streaming' | 'error';
  createdAt: string;
  targetBotIds?: string[];
  reasoning?: string;
  reasoningStatus?: 'streaming' | 'complete' | 'interrupted';
  reasoningTruncated?: boolean;
  attachments?: GeneratedImage[];
}
export interface Task {
  id: string;
  roomId: string;
  botId: string;
  prompt: string;
  workspacePath?: string;
  status: TaskStatus;
  parentTaskId?: string;
  rootTaskId: string;
  depth: number;
  kind: 'chat' | 'automation' | 'learning';
  output: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  inputTokens: number;
  outputTokens: number;
}
export interface Activity {
  id: string;
  roomId: string;
  botId: string;
  taskId: string;
  messageId?: string;
  kind: 'status' | 'tool' | 'approval' | 'learning' | 'error' | 'progress';
  approvalRule?: string;
  title: string;
  detail: string;
  status: 'running' | 'success' | 'error' | 'pending';
  createdAt: string;
}
export interface Approval {
  id: string;
  taskId: string;
  roomId: string;
  botId: string;
  toolName: string;
  summary: string;
  target: string;
  args: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
  createdAt: string;
  decidedAt?: string;
}
export interface SkillRevision {
  version: number;
  content: string;
  description: string;
  createdAt: string;
  reason: string;
}
export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  botId: string | null;
  status: 'candidate' | 'active' | 'archived';
  version: number;
  revisions: SkillRevision[];
  sourceTaskId?: string;
  evidence: string;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface Memory {
  id: string;
  botId: string | null;
  content: string;
  sourceTaskId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface Automation {
  id: string;
  name: string;
  kind: 'interval' | 'schedule' | 'url_watch' | 'webhook' | 'imap';
  enabled: boolean;
  roomId: string;
  botId: string;
  prompt: string;
  intervalMinutes: number;
  sourceUrl: string;
  schedule?: AutomationSchedule;
  /** One-time schedule admission/expiry, not the eventual bot task's outcome. */
  scheduleStatus?: 'fired' | 'missed';
  /** External account connection; inline IMAP remains readable for older records. */
  mailAccountId?: string;
  imap?: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    mailbox: string;
    passwordConfigured: boolean;
  };
  nextRunAt?: string;
  lastRunAt?: string;
  lastError?: string;
  createdAt: string;
}
export interface Notification {
  id: string;
  title: string;
  body: string;
  roomId?: string;
  taskId?: string;
  read: boolean;
  createdAt: string;
}
export interface Snapshot {
  version: string;
  settings: Settings;
  bots: Bot[];
  rooms: Room[];
  messages: Message[];
  tasks: Task[];
  activities: Activity[];
  approvals: Approval[];
  skills: Skill[];
  memories: Memory[];
  automations: Automation[];
  /** Optional on older snapshots; current servers always return these collections. */
  mailAccounts?: MailAccount[];
  serviceAccounts?: ServiceAccount[];
  notifications: Notification[];
  queue: QueueState;
}
export interface ServerEvent {
  id: number;
  type: 'snapshot' | 'message_delta' | 'message_reasoning_delta' | 'message_updated' | 'heartbeat';
  data:
    | Snapshot
    | { messageId: string; delta: string; truncated?: boolean }
    | { messageId: string; patch: Partial<Message> }
    | null;
}

export interface FolderPickerStatus {
  available: boolean;
  platform: string;
  reason?: 'remote' | 'headless' | 'unsupported' | 'disabled';
  message?: string;
}

export interface PromptGenerationRequest {
  name: string;
  role: string;
  instructions: string;
  currentPrompt?: string;
  locale: 'ja' | 'en';
}
export interface PromptGeneration {
  id: string;
  status: 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  request: PromptGenerationRequest;
  output: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
