import type { MailAccount } from './mail-accounts.js';
import type { ServiceAccount } from './service-accounts.js';
import type { AutomationSchedule } from './schedules.js';
import type { HandoffLimit } from './handoffs.js';
import type { AutonomousWakeupPolicy, Wakeup, WorkItem } from './work.js';
import type { TaskScheduling, TaskSchedulingInfo } from './scheduling.js';

export type { AutomationSchedule } from './schedules.js';
export type { AutonomousWakeupPolicy, Wakeup, WorkItem, WorkCheckpoint } from './work.js';
export type {
  SchedulingGrant,
  TaskScheduling,
  TaskSchedulingInfo,
  TaskSchedulingSnapshot,
} from './scheduling.js';

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
  /** Bot image tool policy; missing values inherit the workspace network policy. */
  permission?: 'inherit' | 'allow' | 'ask' | 'deny';
  baseUrl: string;
  modelId: string;
  apiKeyConfigured: boolean;
  size: string;
  /** Null or omitted keeps the image server's sampling-step default. */
  steps?: number | null;
  /** Provider-specific transport used only when an explicit step count is set. */
  stepsParameter?: 'sd_cpp_extra_args' | 'steps' | 'num_inference_steps' | 'sample_steps';
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
  maxConcurrentBrowsers?: number;
  uploadMaxFiles?: number;
  uploadMaxFileMiB?: number;
  uploadMaxTotalMiB?: number;
  uploadStorageMiB?: number;
}
export interface BotBrowserSettings {
  /** Missing on older bots means shared, preserving their existing sign-in. */
  mode: 'dedicated' | 'shared' | 'disabled';
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
  waiting?: boolean;
  botMode?: BotBrowserSettings['mode'];
  pool?: { active: number; limit: number; waiting: number };
}
/** Exactly one source: an image attached in the current room or a workspace-relative file. */
export interface ImageSource {
  imageId?: string;
  path?: string;
}
/** The immutable input identity used for one image operation; never contains image bytes. */
export interface ImageInputReceipt extends ImageSource {
  role: 'source' | 'reference' | 'mask';
  sha256: string;
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
  /** Older generated images and browser captures omit this field. */
  source?: 'generated' | 'uploaded';
  operation?: 'generate' | 'edit';
  inputImages?: ImageInputReceipt[];
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
  scheduling?: TaskSchedulingInfo[];
  waitingTasks?: Array<{
    taskId: string;
    reason: 'inference' | 'room' | 'session' | 'worker' | 'paused';
  }>;
}
export interface ModelSettings {
  baseUrl: string;
  modelId: string;
  apiKeyConfigured: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  /** Explicit image-input capability/consent; older settings inherit the screenshot opt-in. */
  imageInput?: boolean;
  /** Dispatch to first meaningful output; Loom's own queue waiting is excluded. */
  responseTimeoutSeconds?: number;
  /** Maximum silence between meaningful output events once generation has begun. */
  idleTimeoutSeconds?: number;
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
  maxHandoffs: HandoffLimit;
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
  browser?: BotBrowserSettings;
  createdAt: string;
}
export interface Room {
  id: string;
  name: string;
  description: string;
  workspacePath?: string;
  parallelResponses?: boolean;
  autonomousWakeups?: AutonomousWakeupPolicy;
  /** Let started tasks finish, holding new work until the owner resumes the room. */
  paused?: boolean;
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
  /** An explicit bot-to-owner post, still visible in the shared room. */
  targetUser?: boolean;
  /** The original notice quoted by an explicit owner reply. */
  notificationReply?: NotificationReplyContext;
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
  /** Owner-attached images fixed when this task is created, scoped to the same room. */
  inputImageIds?: string[];
  workspacePath?: string;
  status: TaskStatus;
  parentTaskId?: string;
  rootTaskId: string;
  depth: number;
  kind: 'chat' | 'automation' | 'learning';
  /** Durable work identity survives scheduled wake-ups and bot handoffs. */
  workId?: string;
  /** One business occurrence, including its one-time continuations. */
  workRunId?: string;
  wakeupId?: string;
  output: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  inputTokens: number;
  outputTokens: number;
  /** Instructions actually read by this task, retained across pause and recovery. */
  skillUses?: SkillUse[];
  /** Persisted separately from the owner's request, including after recovery. */
  notificationReply?: NotificationReplyContext;
  /** Temporary work-level priority, including its durable consumption/cooldown. */
  scheduling?: TaskScheduling;
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
export type LearningActor = { kind: 'user' } | { kind: 'bot'; botId: string; roomId: string };
export interface SkillUse {
  id: string;
  version: number;
  name: string;
  description: string;
  content: string;
  botId: string | null;
  roomId: string | null;
  readAt: string;
}
export interface SkillRevision {
  version: number;
  content: string;
  description: string;
  createdAt: string;
  reason: string;
  /** Optional only for revisions created before autonomous learning. */
  name?: string;
  botId?: string | null;
  roomId?: string | null;
  status?: Skill['status'];
  locked?: boolean;
  actor?: LearningActor;
  sourceTaskId?: string;
  evidence?: string;
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
  /** null/missing means all rooms in the selected bot/team scope. */
  roomId?: string | null;
  /** Prevent bot edits; owners can still edit and restore. */
  locked?: boolean;
  autoActivated?: boolean;
}
export interface MemoryRevision {
  version: number;
  content: string;
  createdAt: string;
  reason: string;
  botId?: string | null;
  roomId?: string | null;
  status?: 'active' | 'archived';
  locked?: boolean;
  actor?: LearningActor;
  sourceTaskId?: string;
  evidence?: string;
  mergedFrom?: Array<{ id: string; version: number }>;
}
export interface Memory {
  id: string;
  botId: string | null;
  content: string;
  sourceTaskId?: string;
  createdAt: string;
  updatedAt: string;
  /** Optional on records created before memory revision history existed. */
  version?: number;
  status?: 'active' | 'archived';
  roomId?: string | null;
  locked?: boolean;
  evidence?: string;
  revisions?: MemoryRevision[];
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
export type NotificationSender =
  { kind: 'bot'; botId: string; name: string; handle: string } | { kind: 'system' };
export interface NotificationReplyContext {
  notificationId: string;
  roomId: string;
  botId: string;
  senderName: string;
  senderHandle: string;
  title: string;
  body: string;
  createdAt: string;
  messageId?: string;
  taskId?: string;
}
export interface Notification {
  id: string;
  title: string;
  body: string;
  roomId?: string;
  taskId?: string;
  /** A saved identity snapshot; absent on notifications from older versions. */
  sender?: NotificationSender;
  messageId?: string;
  read: boolean;
  createdAt: string;
}
export type NotificationInput = Pick<Notification, 'title' | 'body'> &
  Partial<Pick<Notification, 'roomId' | 'taskId' | 'messageId'>> & {
    /** Internal capability: the runtime supplies its actual task's bot. */
    senderBotId?: string;
  };
export interface NotificationReplyResult {
  message: Message;
  tasks: Task[];
  notification: Notification;
  duplicate: boolean;
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
  workItems?: WorkItem[];
  wakeups?: Wakeup[];
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
