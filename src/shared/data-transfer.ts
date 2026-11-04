export const DATA_TRANSFER_MAX_ARCHIVE_BYTES = 4 * 1024 ** 3;
export const DATA_TRANSFER_CHUNK_BYTES = 8 * 1024 ** 2;
export const DATA_TRANSFER_BROWSER_KEYS = [
  'loom.drafts',
  'loom.locale',
  'loom.room',
  'loom.mailAccount',
  'loom.activity',
  'loom.notifications',
] as const;

export type DataTransferBrowserState = Partial<
  Record<(typeof DATA_TRANSFER_BROWSER_KEYS)[number], string>
>;

export interface DataTransferWorkspace {
  sourcePath: string;
  destinationPath?: string;
  fileCount?: number;
  totalBytes?: number;
}

export interface DataTransferSummary {
  version: string;
  createdAt: string;
  platform: string;
  counts: Record<string, number>;
  fileCount: number;
  totalBytes: number;
  workspaces: DataTransferWorkspace[];
  warnings: string[];
}

export interface DataTransferPreview extends DataTransferSummary {
  token: string;
  currentCounts: Record<string, number>;
  disabledAutomations: number;
  browserState?: DataTransferBrowserState;
}

export type DataTransferArchivePreview = Omit<DataTransferPreview, 'token' | 'currentCounts'>;

export type DataTransferJobStatus =
  'queued' | 'uploading' | 'working' | 'ready' | 'applying' | 'completed' | 'failed';

export interface DataTransferJob {
  id: string;
  kind: 'export' | 'import';
  status: DataTransferJobStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  totalBytes?: number;
  uploadedBytes?: number;
  archiveBytes?: number;
  summary?: DataTransferSummary;
  preview?: DataTransferPreview;
  backupPath?: string;
  error?: string;
  requiresNewUpload?: boolean;
}

export interface DataTransferInfo {
  available: boolean;
  busy: boolean;
  maxArchiveBytes: number;
  chunkBytes: number;
  activeJob?: DataTransferJob;
}
