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
export interface ModelSettings {
  baseUrl: string;
  modelId: string;
  apiKeyConfigured: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  reasoningMode?: 'server' | 'openai';
  reasoningEffort?: 'low' | 'medium' | 'high';
}
export interface Settings {
  model: ModelSettings;
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
}
export interface Task {
  id: string;
  roomId: string;
  botId: string;
  prompt: string;
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
  kind: 'interval' | 'url_watch' | 'webhook' | 'imap';
  enabled: boolean;
  roomId: string;
  botId: string;
  prompt: string;
  intervalMinutes: number;
  sourceUrl: string;
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
  notifications: Notification[];
  queue: { active: number; waiting: number };
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
