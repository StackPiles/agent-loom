export const UPDATE_PROTOCOL = 1;

export interface UpdateRelease {
  version: string;
  commit: string;
  url: string;
  publishedAt?: string;
  checks: 'passed' | 'pending' | 'failed' | 'unknown';
  protocol: number;
}

export interface UpdateJob {
  id: string;
  phase:
    'preparing' | 'stopping' | 'installing' | 'building' | 'verifying' | 'succeeded' | 'failed';
  targetSha: string;
  targetVersion: string;
  previousSha: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
  rolledBack?: boolean;
}

export interface UpdateInstallation {
  kind: 'managed-git' | 'git' | 'docker' | 'development' | 'standalone';
  canUpdate: boolean;
  reason?: string;
}

export interface UpdateInfo {
  current: { version: string; commit?: string };
  latest?: UpdateRelease;
  checkedAt?: string;
  checkError?: string;
  available: boolean;
  installation: UpdateInstallation;
  job?: UpdateJob;
}

export const isActiveUpdate = (job?: UpdateJob): boolean =>
  Boolean(job && job.phase !== 'succeeded' && job.phase !== 'failed');
