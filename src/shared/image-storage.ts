import type { GeneratedImage } from './types.js';

export interface ImageStorageSettings {
  autoCleanup: boolean;
  unusedDays: number;
}

export const DEFAULT_IMAGE_STORAGE_SETTINGS: ImageStorageSettings = {
  autoCleanup: false,
  unusedDays: 30,
};

export const IMAGE_STORAGE_UNUSED_DAYS = { min: 1, max: 3650 };

/** Persisted independently of conversation attachments; attachments carry a projection. */
export interface ImageRetentionState {
  initializedAt: string;
  lastUsedAt: string;
  protected: boolean;
  contentHash?: string;
  deletedAt?: string;
}

export type ImageUseReason = 'open' | 'download' | 'view' | 'edit' | 'attach';
export type ImageStorageBlockReason =
  | 'protected'
  | 'recent'
  | 'grace'
  | 'in_use'
  | 'work'
  | 'shared'
  | 'dependency'
  | 'missing'
  | 'deleted'
  | 'unverified';

export interface ImageStorageItem extends GeneratedImage {
  storage: ImageRetentionState;
  candidate: boolean;
  eligibleAt: string;
  blockedReasons: ImageStorageBlockReason[];
  roomNames: string[];
}

export type ImageStorageCategory = 'originals' | 'history' | 'backups' | 'uploads';

export interface ImageStorageUsage {
  /** Physical bytes counted once per filesystem inode across managed categories. */
  totalBytes: number;
  logicalBytes: number;
  duplicateBytes: number;
  categories: Array<{ kind: ImageStorageCategory; bytes: number; files: number }>;
  imageCount: number;
  protectedCount: number;
  candidateCount: number;
  candidateBytes: number;
}

export interface ImageStorageOverview {
  settings: ImageStorageSettings;
  usage: ImageStorageUsage;
  images: ImageStorageItem[];
  total: number;
  offset: number;
  limit: number;
  warnings: string[];
  lastCleanup?: { at: string; deletedImages: number; freedBytes: number };
}

export interface ImageStorageQuery {
  filter?: 'all' | 'candidates' | 'protected' | 'deleted';
  sort?: 'largest' | 'oldest';
  offset?: number;
  limit?: number;
}

export interface ImageStorageCleanupResult {
  deletedImages: number;
  freedBytes: number;
  skipped: Array<{ id: string; reason: ImageStorageBlockReason }>;
}

export interface ImageStorageDeduplicateResult {
  consolidatedImages: number;
  freedBytes: number;
}
