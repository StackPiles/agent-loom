import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  BROWSER_UPLOAD_SETTING_LIMITS,
  browserUploadSettings,
  browserUploadSettingsError,
} from '../shared/browser.js';
import type { BrowserSettings } from '../shared/types.js';
import { throwIfAborted } from './runtime/gate.js';
import { workspacePath } from './runtime/workspace.js';

const MiB = 1024 * 1024;

export type BrowserUploadLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

/** Legacy callers inherit the same upload defaults as the browser settings UI. */
export const BROWSER_UPLOAD_LIMITS = Object.freeze(browserUploadLimits());

export function browserUploadLimits(settings?: Partial<BrowserSettings>): BrowserUploadLimits {
  const invalid = browserUploadSettingsError(settings === undefined ? {} : settings);
  if (invalid) throw new Error(invalid);
  const current = browserUploadSettings(settings);
  return {
    maxFiles: current.uploadMaxFiles,
    maxFileBytes: current.uploadMaxFileMiB * MiB,
    maxTotalBytes: current.uploadMaxTotalMiB * MiB,
  };
}

/** Byte-based limits also support small deterministic fixtures without changing settings. */
function checkedLimits(limits: BrowserUploadLimits): BrowserUploadLimits {
  if (!limits || typeof limits !== 'object') throw new Error('Browser upload limits are invalid.');
  for (const [name, maximum] of [
    ['maxFiles', BROWSER_UPLOAD_SETTING_LIMITS.uploadMaxFiles.max],
    ['maxFileBytes', BROWSER_UPLOAD_SETTING_LIMITS.uploadMaxFileMiB.max * MiB],
    ['maxTotalBytes', BROWSER_UPLOAD_SETTING_LIMITS.uploadMaxTotalMiB.max * MiB],
  ] as const) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > maximum)
      throw new Error(`Browser upload limit ${name} must be an integer from 1 to ${maximum}.`);
  }
  if (limits.maxFileBytes > limits.maxTotalBytes)
    throw new Error('The browser upload per-file limit must not exceed its combined limit.');
  return {
    maxFiles: limits.maxFiles,
    maxFileBytes: limits.maxFileBytes,
    maxTotalBytes: limits.maxTotalBytes,
  };
}

const byteLimit = (value: number) => (value % MiB === 0 ? `${value / MiB} MiB` : `${value} bytes`);

function assertFileSize(name: string, size: bigint | number, limits: BrowserUploadLimits): void {
  if (BigInt(size) > BigInt(limits.maxFileBytes))
    throw new Error(
      `Browser upload file ${JSON.stringify(name)} exceeds the configured ${byteLimit(limits.maxFileBytes)} per-file limit.`,
    );
}

function assertTotalSize(size: number, limits: BrowserUploadLimits): void {
  if (size > limits.maxTotalBytes)
    throw new Error(
      `Browser upload files exceed the configured combined ${byteLimit(limits.maxTotalBytes)} limit.`,
    );
}

export type PreparedBrowserUploads = {
  root: string;
  files: Array<{ path: string; name: string; size: number; sha256: string; data: Buffer }>;
};

type UploadReceipt = Omit<PreparedBrowserUploads['files'][number], 'data'>;
type Location = { root: string; target: string };
type LocationState = {
  file: BigIntStats;
  ancestors: Array<{ name: string; stat: BigIntStats }>;
};
type Source = {
  path: string;
  location: Location;
  state: LocationState;
};
type PreparedState = {
  rootInput: string;
  root: string;
  sources: Source[];
  receipts: UploadReceipt[];
  limits: BrowserUploadLimits;
};

const READ_CHUNK_BYTES = 64 * 1024;
const preparedStates = new WeakMap<PreparedBrowserUploads, PreparedState>();
const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const sameContents = (a: BigIntStats, b: BigIntStats) =>
  sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function changedPath(name: string): Error {
  return new Error(
    `Browser upload file ${JSON.stringify(name)} or its workspace changed after inspection. Inspect the files and request upload again.`,
  );
}

/** Portable relative paths only, including when a Windows path is sent to a POSIX host. */
export function normalizeBrowserUploadPaths(
  filePaths: readonly string[],
  limits: BrowserUploadLimits = BROWSER_UPLOAD_LIMITS,
): string[] {
  const current = checkedLimits(limits);
  if (!Array.isArray(filePaths) || !filePaths.length)
    throw new Error('Provide at least one workspace-relative browser upload file path.');
  if (filePaths.length > current.maxFiles)
    throw new Error(
      `A browser upload accepts at most ${current.maxFiles} ${current.maxFiles === 1 ? 'file' : 'files'}.`,
    );
  const seen = new Set<string>();
  return filePaths.map((name) => {
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 4000 ||
      /[\x00-\x1f\x7f]/.test(name)
    )
      throw new Error(
        'Use nonempty workspace-relative upload paths of at most 4,000 characters without control characters.',
      );
    // Colons also prohibit Windows drive-relative names and alternate data streams.
    if (/^[\\/]/.test(name) || name.includes(':') || path.win32.isAbsolute(name))
      throw new Error(
        'Browser upload paths must be workspace-relative; absolute paths, URLs, and Windows drive or stream paths are not supported.',
      );
    const normalized = path.posix.normalize(name.replace(/\\/g, '/'));
    if (normalized === '..' || normalized.startsWith('../'))
      throw new Error('The browser upload path is outside the configured workspace.');
    if (normalized === '.')
      throw new Error('Browser upload paths must name a regular file within the workspace.');
    if (seen.has(normalized))
      throw new Error(`Duplicate browser upload file path: ${JSON.stringify(normalized)}.`);
    seen.add(normalized);
    return normalized;
  });
}

async function sourceOperation<T>(name: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // Node's filesystem errors include absolute paths. Only relative sources belong
    // in model-visible diagnostics, approvals, and operation receipts.
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new Error(`Browser upload file ${JSON.stringify(name)} does not exist or disappeared.`);
    if (code === 'ELOOP') throw changedPath(name);
    if (code)
      throw new Error(`Browser upload file ${JSON.stringify(name)} could not be read (${code}).`);
    throw error;
  }
}

async function resolveSource(rootInput: string, name: string, root: string): Promise<Location> {
  // Do not let workspacePath recreate a workspace removed while approval was pending.
  if ((await realpath(rootInput)) !== root) throw changedPath(name);
  const location = await workspacePath(rootInput, name);
  if (location.root !== root) throw changedPath(name);
  return location;
}

async function locationState(
  source: Pick<Source, 'path' | 'location'>,
  resolve: () => Promise<Location>,
  signal?: AbortSignal,
): Promise<LocationState> {
  throwIfAborted(signal);
  const current = await resolve();
  if (current.root !== source.location.root || current.target !== source.location.target)
    throw changedPath(source.path);
  const relative = path.relative(source.location.root, path.dirname(source.location.target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw changedPath(source.path);
  const ancestors: LocationState['ancestors'] = [];
  let directory = source.location.root;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    throwIfAborted(signal);
    if (part) directory = path.join(directory, part);
    const stat = await lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw changedPath(source.path);
    ancestors.push({ name: directory, stat });
  }
  const file = await lstat(source.location.target, { bigint: true });
  if (!file.isFile() || file.isSymbolicLink())
    throw new Error(`Browser upload path ${JSON.stringify(source.path)} must be a regular file.`);
  if ((await realpath(source.location.target)) !== source.location.target)
    throw changedPath(source.path);
  if (file.size < 1n)
    throw new Error(`Browser upload file ${JSON.stringify(source.path)} is empty (0 bytes).`);
  throwIfAborted(signal);
  return { file, ancestors };
}

function assertSameLocation(name: string, before: LocationState, after: LocationState): void {
  if (
    !sameContents(before.file, after.file) ||
    before.ancestors.length !== after.ancestors.length ||
    before.ancestors.some(
      (entry, index) =>
        entry.name !== after.ancestors[index].name ||
        !sameFile(entry.stat, after.ancestors[index].stat),
    )
  )
    throw changedPath(name);
}

/**
 * Read at most the inspected length plus a one-byte growth probe. Retained bytes
 * are used for staging after approval; revalidation hashes chunks without keeping
 * a second complete copy. Path and ancestor checks complement O_NOFOLLOW where
 * supported; these checks are not an OS sandbox against hostile same-user code.
 */
async function readSource(
  source: Source,
  resolve: () => Promise<Location>,
  retainData: boolean,
  signal?: AbortSignal,
): Promise<{ data?: Buffer; sha256: string }> {
  throwIfAborted(signal);
  assertSameLocation(source.path, source.state, await locationState(source, resolve, signal));
  const handle = await open(
    source.location.target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    throwIfAborted(signal);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameContents(source.state.file, opened))
      throw changedPath(source.path);
    assertSameLocation(source.path, source.state, await locationState(source, resolve, signal));
    const size = Number(opened.size);
    const data = retainData ? Buffer.allocUnsafe(size) : undefined;
    const chunk = data ?? Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, size));
    const hash = createHash('sha256');
    let length = 0;
    while (length < size) {
      throwIfAborted(signal);
      const offset = data ? length : 0;
      const result = await handle.read(
        chunk,
        offset,
        Math.min(READ_CHUNK_BYTES, size - length),
        length,
      );
      if (!result.bytesRead) throw changedPath(source.path);
      hash.update(chunk.subarray(offset, offset + result.bytesRead));
      length += result.bytesRead;
    }
    throwIfAborted(signal);
    if ((await handle.read(Buffer.alloc(1), 0, 1, size)).bytesRead) throw changedPath(source.path);
    const finished = await handle.stat({ bigint: true });
    if (!sameContents(opened, finished)) throw changedPath(source.path);
    assertSameLocation(source.path, source.state, await locationState(source, resolve, signal));
    throwIfAborted(signal);
    return { data, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

/** Read exact, bounded workspace bytes before presenting the browser approval. */
export async function prepareBrowserUploads(
  rootInput: string,
  filePaths: readonly string[],
  signal?: AbortSignal,
  limits: BrowserUploadLimits = BROWSER_UPLOAD_LIMITS,
): Promise<PreparedBrowserUploads> {
  throwIfAborted(signal);
  const current = checkedLimits(limits);
  const names = normalizeBrowserUploadPaths(filePaths, current);
  const initialRoot = path.resolve(rootInput);
  const root = await sourceOperation(names[0], () => realpath(initialRoot));
  const sources: Source[] = [];
  let totalBytes = 0;
  // Check all sizes and aliases before allocating or reading any file contents.
  for (const name of names) {
    throwIfAborted(signal);
    await sourceOperation(name, async () => {
      const resolve = () => resolveSource(initialRoot, name, root);
      const location = await resolve();
      const state = await locationState({ path: name, location }, resolve, signal);
      assertFileSize(name, state.file.size, current);
      if (
        sources.some(
          (source) =>
            source.location.target === location.target || sameFile(source.state.file, state.file),
        )
      )
        throw new Error(
          `Duplicate browser upload file: ${JSON.stringify(name)} resolves to the same file.`,
        );
      if (sources.length && !sameFile(sources[0].state.ancestors[0].stat, state.ancestors[0].stat))
        throw changedPath(name);
      totalBytes += Number(state.file.size);
      assertTotalSize(totalBytes, current);
      sources.push({ path: name, location, state });
    });
  }
  const files: PreparedBrowserUploads['files'] = [];
  for (const source of sources) {
    const result = await sourceOperation(source.path, () =>
      readSource(source, () => resolveSource(initialRoot, source.path, root), true, signal),
    );
    files.push({
      path: source.path,
      name: path.posix.basename(source.path),
      size: Number(source.state.file.size),
      sha256: result.sha256,
      data: result.data!,
    });
  }
  throwIfAborted(signal);
  const uploads = { root, files };
  preparedStates.set(uploads, {
    rootInput: initialRoot,
    root,
    sources,
    receipts: files.map(({ path, name, size, sha256 }) => ({ path, name, size, sha256 })),
    limits: current,
  });
  return uploads;
}

function preparedState(uploads: PreparedBrowserUploads): PreparedState {
  const state = preparedStates.get(uploads);
  if (!state)
    throw new Error('Browser upload files must be prepared by the workspace upload reader.');
  if (
    uploads.root !== state.root ||
    !Array.isArray(uploads.files) ||
    uploads.files.length !== state.receipts.length ||
    uploads.files.some((file, index) => {
      const receipt = state.receipts[index];
      return (
        !file ||
        file.path !== receipt.path ||
        file.name !== receipt.name ||
        file.size !== receipt.size ||
        file.sha256 !== receipt.sha256 ||
        !Buffer.isBuffer(file.data) ||
        file.data.length !== receipt.size
      );
    })
  )
    throw new Error('Prepared browser upload metadata changed. Prepare the upload again.');
  return state;
}

/** Reviewable metadata only: never expose file bytes or internal absolute paths. */
export function browserUploadReceipts(uploads: PreparedBrowserUploads): UploadReceipt[] {
  return preparedState(uploads).receipts.map((receipt) => ({ ...receipt }));
}

/** Enforce live policy against the approved metadata without rereading source bytes. */
export function assertBrowserUploadLimits(
  uploads: PreparedBrowserUploads,
  limits: BrowserUploadLimits,
): void {
  const current = checkedLimits(limits);
  const { receipts } = preparedState(uploads);
  if (receipts.length > current.maxFiles)
    throw new Error(
      `A browser upload accepts at most ${current.maxFiles} ${current.maxFiles === 1 ? 'file' : 'files'}.`,
    );
  let totalBytes = 0;
  for (const file of receipts) {
    assertFileSize(file.path, file.size, current);
    totalBytes += file.size;
  }
  assertTotalSize(totalBytes, current);
}

/** Reject source, workspace, metadata, and retained-byte changes across approval waits. */
export async function assertBrowserUploadsCurrent(
  uploads: PreparedBrowserUploads,
  signal?: AbortSignal,
  limits?: BrowserUploadLimits,
): Promise<void> {
  throwIfAborted(signal);
  const state = preparedState(uploads);
  assertBrowserUploadLimits(uploads, limits === undefined ? state.limits : limits);
  for (const [index, file] of uploads.files.entries()) {
    throwIfAborted(signal);
    if (digest(file.data) !== state.receipts[index].sha256)
      throw new Error('Prepared browser upload bytes changed. Prepare the upload again.');
  }
  for (const [index, source] of state.sources.entries()) {
    const result = await sourceOperation(source.path, () =>
      readSource(
        source,
        () => resolveSource(state.rootInput, source.path, state.root),
        false,
        signal,
      ),
    );
    if (result.sha256 !== state.receipts[index].sha256) throw changedPath(source.path);
  }
  // An asynchronous source read must not allow a caller to replace the approved
  // metadata or retained bytes while this validation is in progress.
  preparedState(uploads);
  for (const [index, file] of uploads.files.entries()) {
    throwIfAborted(signal);
    if (digest(file.data) !== state.receipts[index].sha256)
      throw new Error('Prepared browser upload bytes changed. Prepare the upload again.');
  }
  throwIfAborted(signal);
}
