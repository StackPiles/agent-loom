import {
  DATA_TRANSFER_BROWSER_KEYS,
  type DataTransferBrowserState,
  type DataTransferInfo,
  type DataTransferJob,
} from '../shared/data-transfer';
import { api, ApiError } from './api';

const basePath = '/data-transfer';
const jobPath = (id: string) => `${basePath}/jobs/${encodeURIComponent(id)}`;

export const dataTransferApi = {
  info: (signal?: AbortSignal) => api<DataTransferInfo>(basePath, 'GET', undefined, signal),
  export: (password: string, browserState?: DataTransferBrowserState, signal?: AbortSignal) =>
    api<DataTransferJob>(`${basePath}/export`, 'POST', { password, browserState }, signal),
  createImport: (size: number, signal?: AbortSignal) =>
    api<DataTransferJob>(`${basePath}/import`, 'POST', { size }, signal),
  job: (id: string, signal?: AbortSignal) =>
    api<DataTransferJob>(jobPath(id), 'GET', undefined, signal),
  inspect: (id: string, password: string, signal?: AbortSignal) =>
    api<DataTransferJob>(`${jobPath(id)}/inspect`, 'POST', { password }, signal),
  apply: (id: string, previewToken: string, signal?: AbortSignal) =>
    api<DataTransferJob>(`${jobPath(id)}/apply`, 'POST', { previewToken }, signal),
  discard: (id: string, signal?: AbortSignal) =>
    api<void>(jobPath(id), 'DELETE', undefined, signal),
  downloadUrl: (id: string) => `/api${jobPath(id)}/download`,
};

export function captureTransferBrowserState(): DataTransferBrowserState {
  const state: DataTransferBrowserState = {};
  for (const key of DATA_TRANSFER_BROWSER_KEYS) {
    const value = localStorage.getItem(key);
    if (value !== null) state[key] = value;
  }
  return state;
}

/** Only Loom's portable UI preferences and drafts may cross the machine boundary. */
export function restoreTransferBrowserState(state: DataTransferBrowserState) {
  for (const key of DATA_TRANSFER_BROWSER_KEYS) {
    const value = state[key];
    if (typeof value === 'string') localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  }
}

export function transferPasswordProblem(password: string): 'short' | 'long' | null {
  if (Array.from(password).length < 12) return 'short';
  if (new TextEncoder().encode(password).byteLength > 1024) return 'long';
  return null;
}

export function isTransferConnectionError(error: unknown) {
  return error instanceof ApiError
    ? error.status >= 500 || error.status === 408 || error.status === 429
    : error instanceof TypeError ||
        (error instanceof DOMException && error.name === 'TimeoutError');
}

export class DataTransferPendingError extends Error {
  constructor() {
    super('The connection is still unavailable. The transfer result is not yet known.');
    this.name = 'DataTransferPendingError';
  }
}

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    function abort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** A server restart is expected during export/apply; it is not a failed transfer. */
export async function waitForDataTransferJob(
  id: string,
  options: {
    signal?: AbortSignal;
    onUpdate?: (job: DataTransferJob) => void;
    onReconnect?: (waiting: boolean) => void;
    intervalMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<DataTransferJob> {
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now())));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const job = await dataTransferApi.job(id, signal);
      options.onReconnect?.(false);
      options.onUpdate?.(job);
      if (job.status === 'ready' || job.status === 'completed' || job.status === 'failed')
        return job;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!isTransferConnectionError(error)) throw error;
      options.onReconnect?.(true);
    }
    await delay(
      Math.min(options.intervalMs ?? 1500, Math.max(0, deadline - Date.now())),
      options.signal,
    );
  }
  throw new DataTransferPendingError();
}

export async function uploadTransferFile(
  initialJob: DataTransferJob,
  file: File,
  chunkBytes: number,
  options: { signal?: AbortSignal; onUpdate?: (job: DataTransferJob) => void } = {},
): Promise<DataTransferJob> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1)
    throw new Error('Invalid transfer chunk size.');
  if (initialJob.totalBytes !== undefined && initialJob.totalBytes !== file.size)
    throw new Error('The selected file does not match this upload. Select the file again.');
  let job = initialJob;
  let offset = job.uploadedBytes ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size)
    throw new Error('Invalid upload position. Select the file again.');
  while (offset < file.size) {
    options.signal?.throwIfAborted();
    const end = Math.min(offset + chunkBytes, file.size);
    const response = await fetch(`/api${jobPath(job.id)}/upload`, {
      method: 'PUT',
      credentials: 'same-origin',
      signal: options.signal,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Loom-Offset': String(offset),
      },
      body: file.slice(offset, end),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok)
      throw new ApiError(
        payload?.error || `${response.status} ${response.statusText}`,
        response.status,
        typeof payload?.code === 'string' ? payload.code : undefined,
      );
    job = payload as DataTransferJob;
    if (job?.id !== initialJob.id || job.uploadedBytes !== end)
      throw new Error('The server could not confirm the uploaded bytes. Select the file again.');
    offset = end;
    options.onUpdate?.(job);
  }
  return job;
}
