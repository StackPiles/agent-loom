import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { GeneratedImage, Message, Room, Task, WorkItem } from '../shared/types.js';
import {
  DEFAULT_IMAGE_STORAGE_SETTINGS,
  IMAGE_STORAGE_UNUSED_DAYS,
  type ImageRetentionState,
  type ImageStorageBlockReason,
  type ImageStorageCategory,
  type ImageStorageCleanupResult,
  type ImageStorageDeduplicateResult,
  type ImageStorageItem,
  type ImageStorageOverview,
  type ImageStorageQuery,
  type ImageStorageSettings,
  type ImageStorageUsage,
  type ImageUseReason,
} from '../shared/image-storage.js';
import { MAX_IMAGE_INPUT_LIMITS } from '../shared/image-inputs.js';
import {
  activeManagedImages,
  consolidateManagedImageAlias,
  isImageAssetDeleted,
  markImageAssetDeleted,
} from './image-assets.js';
import { readGeneratedImage } from './runtime/images.js';
import { retainedSessionImageHashes } from './runtime/session-images.js';
import type { Store } from './store.js';

const IMAGE_ID = /^img_[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const imagePattern = /img_[a-f0-9]{64}/g;
const assetPattern = /loom-image:v1:sha256:([a-f0-9]{64}):[1-9][0-9]*/g;
const receiptPattern = /"(?:sha256|sharedHash|contentHash)"\s*:\s*"([a-f0-9]{64})"/g;
const DAY = 86_400_000;
const retentionKind = 'imageRetention';
const settingsKind = 'imageStorageSettings';
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
const diskKey = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const runningStates = new Set<Task['status']>([
  'queued',
  'running',
  'waiting_model',
  'waiting_tool',
  'awaiting_approval',
]);

interface References {
  images: Set<string>;
  hashes: Set<string>;
}

function references(): References {
  return { images: new Set(), hashes: new Set() };
}

function collect(text: string, into: References): void {
  for (const match of text.matchAll(imagePattern)) into.images.add(match[0]);
  for (const match of text.matchAll(assetPattern)) into.hashes.add(match[1]);
  for (const match of text.matchAll(receiptPattern)) into.hashes.add(match[1]);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function inside(root: string, target: string): boolean {
  const part = relative(root, target);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

/** Only generated, app-owned descendants; never interpret an attachment filename as a path. */
function managedPath(root: string, components: string[]): string | undefined {
  if (components.some((part) => !part || part === '.' || part === '..' || /[\\/]/.test(part)))
    throw new Error('Invalid managed image storage path.');
  let target = root;
  for (let index = 0; index < components.length; index++) {
    target = join(target, components[index]);
    let stat;
    try {
      stat = lstatSync(target);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (stat.isSymbolicLink() || (index < components.length - 1 && !stat.isDirectory()))
      throw new Error('Image storage contains an unsafe symbolic link or directory.');
  }
  if (!inside(root, target) || realpathSync.native(target) !== target)
    throw new Error('Image storage cannot access files outside its managed directory.');
  return target;
}

/** Scan bounded chunks, including old JSONL backups, without loading historical image bytes. */
function scanSessionDirectory(root: string, components: string[], into: References): void {
  let files = 0;
  const visit = (parts: string[], depth: number): void => {
    if (depth > 16 || ++files > 50_000)
      throw new Error('The conversation image dependency scan is too large to complete safely.');
    const target = managedPath(root, parts);
    if (!target) return;
    const stat = lstatSync(target);
    if (stat.isDirectory()) {
      for (const child of readdirSync(target)) visit([...parts, child], depth + 1);
      return;
    }
    if (!stat.isFile()) throw new Error('A conversation image dependency is not a regular file.');
    const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
        throw new Error('A conversation image dependency changed while it was being scanned.');
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let tail = '';
      for (;;) {
        const count = readSync(fd, chunk, 0, chunk.length, null);
        if (!count) break;
        const text = tail + chunk.subarray(0, count).toString('utf8');
        collect(text, into);
        tail = text.slice(-256);
      }
    } finally {
      closeSync(fd);
    }
  };
  visit(components, 0);
}

function historicalSessionReferences(root: string): References {
  const result = references();
  const directory = managedPath(root, ['sessions']);
  if (!directory) return result;
  for (const name of readdirSync(directory))
    if (name !== 'assets' && name !== 'assets-retired')
      scanSessionDirectory(root, ['sessions', name], result);
  return result;
}

/**
 * Historical messages are not permanent roots. Current/recoverable work, its
 * sessions and explicit durable dependencies are roots until that work closes.
 */
function imageDependencies(store: Store, images: readonly GeneratedImage[]): References {
  const result = references();
  const work = new Map(store.list<WorkItem>('workItems').map((item) => [item.id, item]));
  const openWork = new Set(
    [...work.values()]
      .filter((item) => item.status !== 'completed' && item.status !== 'cancelled')
      .map((item) => item.id),
  );
  const tasks = store.list<Task>('tasks');
  const liveTasks = new Set<string>();
  for (const task of tasks) {
    const closedWork = task.workId && work.has(task.workId) && !openWork.has(task.workId);
    if (
      runningStates.has(task.status) ||
      (task.status !== 'completed' && !closedWork) ||
      (task.workId && openWork.has(task.workId))
    )
      liveTasks.add(task.id);
  }
  for (const item of work.values())
    if (openWork.has(item.id)) {
      collect(JSON.stringify(item), result);
      liveTasks.add(item.sourceTaskId);
    }
  // A child may need a predecessor's image even after that predecessor settled.
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (!liveTasks.has(task.id)) continue;
      for (const id of [task.parentTaskId, task.rootTaskId])
        if (id && !liveTasks.has(id)) {
          liveTasks.add(id);
          changed = true;
        }
    }
  }
  const sessionDirectories = new Map<string, string[]>();
  for (const task of tasks) {
    if (!liveTasks.has(task.id)) continue;
    collect(JSON.stringify(task), result);
    const parts =
      task.kind === 'learning'
        ? ['sessions', 'learning', diskKey(task.id)]
        : ['sessions', diskKey(task.botId), diskKey(task.roomId)];
    sessionDirectories.set(parts.join('/'), parts);
  }
  for (const row of store.db.prepare('SELECT kind,id,data FROM objects').iterate() as Iterable<{
    kind: string;
    id: string;
    data: string;
  }>) {
    if (row.kind === 'images' || row.kind === 'workItems' || row.kind === 'tasks') continue;
    const value = JSON.parse(row.data) as {
      taskId?: string;
      workId?: string;
      enabled?: boolean;
      status?: string;
    };
    if (
      (value.taskId && liveTasks.has(value.taskId)) ||
      (value.workId && openWork.has(value.workId)) ||
      ['bots', 'skills', 'memories', 'mailDrafts'].includes(row.kind) ||
      (row.kind === 'automations' && value.enabled !== false) ||
      (row.kind === 'wakeups' && ['scheduled', 'dispatched'].includes(value.status ?? '')) ||
      (['avatarGenerations', 'imageTests'].includes(row.kind) &&
        ['queued', 'generating', 'running'].includes(value.status ?? ''))
    )
      collect(row.data, result);
  }
  const root = realpathSync.native(store.dataDir);
  for (const components of sessionDirectories.values())
    scanSessionDirectory(root, components, result);
  for (const hash of retainedSessionImageHashes(store.dataDir)) result.hashes.add(hash);
  // Editing provenance is deliberately retained while a surviving edit uses it.
  // The cleanup caller passes only the images which will survive that cleanup.
  for (const image of images) {
    if (!image.inputImages?.length) continue;
    collect(JSON.stringify(image.inputImages), result);
  }
  return result;
}

/** Retire edit results before their sources, including before the automatic batch limit. */
function cleanupOrder(images: readonly ImageStorageItem[]): ImageStorageItem[] {
  const groups = new Map<string, ImageStorageItem[]>();
  const imageGroups = new Map<string, string>();
  for (const image of images) {
    if (!image.candidate) continue;
    const key = image.storage.contentHash ?? image.id;
    const group = groups.get(key) ?? [];
    group.push(image);
    groups.set(key, group);
    imageGroups.set(image.id, key);
  }
  const dependents = new Map<string, Set<string>>();
  const sources = new Map<string, Set<string>>();
  for (const [key, group] of groups) {
    for (const image of group) {
      for (const input of image.inputImages ?? []) {
        // Both receipt identities matter. A workspace source may only have its
        // content hash, while older records may establish an imageId reference.
        for (const source of [
          input.imageId ? imageGroups.get(input.imageId) : undefined,
          input.sha256,
        ]) {
          if (!source || source === key || !groups.has(source)) continue;
          const users = dependents.get(source) ?? new Set<string>();
          users.add(key);
          dependents.set(source, users);
          const inputs = sources.get(key) ?? new Set<string>();
          inputs.add(source);
          sources.set(key, inputs);
        }
      }
    }
  }
  const ready = [...groups.keys()].filter((key) => !dependents.get(key)?.size);
  const emitted = new Set<string>();
  const ordered: ImageStorageItem[] = [];
  for (let index = 0; index < ready.length; index++) {
    const key = ready[index];
    if (emitted.has(key)) continue;
    emitted.add(key);
    ordered.push(...groups.get(key)!);
    for (const source of sources.get(key) ?? []) {
      const users = dependents.get(source)!;
      users.delete(key);
      if (!users.size) ready.push(source);
    }
  }
  // Cycles and unknown dependencies retain their stable order. The final
  // dependency check still refuses unsafe removals instead of breaking a cycle.
  for (const [key, group] of groups) if (!emitted.has(key)) ordered.push(...group);
  return ordered;
}

type RetentionRecord = ImageRetentionState & { id: string };
type Signature = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>;
interface VerifiedFile {
  path: string;
  hash: string;
  signature: Signature;
}
interface Inspection {
  images: ImageStorageItem[];
  originals: Map<string, VerifiedFile>;
  warnings: string[];
}

function problem(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function signature(stat: Signature): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function sameSignature(left: Signature, right: Signature): boolean {
  return signature(left) === signature(right);
}

function imageFilename(image: Pick<GeneratedImage, 'id' | 'mimeType'>): string {
  if (!IMAGE_ID.test(image.id) || !Object.hasOwn(extensions, image.mimeType))
    problem('Invalid managed image identifier or media type.');
  return `${image.id}.${extensions[image.mimeType]}`;
}

function overlapsWorkspace(store: Store, filenames: readonly string[]): boolean {
  const root = realpathSync.native(store.dataDir);
  return [
    store.settings().workspacePath,
    ...store.list<Room>('rooms').map((room) => room.workspacePath),
  ]
    .filter((path): path is string => Boolean(path))
    .some((workspace) => {
      try {
        const path = realpathSync.native(workspace);
        return (
          inside(root, path) &&
          filenames.some((filename) => inside(path, filename) || inside(filename, path))
        );
      } catch (error) {
        return !isMissing(error);
      }
    });
}

function retention(
  store: Store,
  image: GeneratedImage,
  stamp: string,
  uploaded = false,
): RetentionRecord {
  const existing = store.get<RetentionRecord>(retentionKind, image.id);
  if (existing) return existing;
  const state: RetentionRecord = {
    id: image.id,
    initializedAt: stamp,
    // The historical access time is unknown. Start a complete retention window.
    lastUsedAt: stamp,
    protected: uploaded || image.source === 'uploaded',
    ...(HASH.test(image.contentHash ?? '') ? { contentHash: image.contentHash } : {}),
  };
  // Imported, explicitly retired attachments must not be resurrected by registration.
  if (image.storage?.deletedAt && validTime(image.storage.deletedAt)) {
    state.deletedAt = image.storage.deletedAt;
    if (HASH.test(image.storage.contentHash ?? '')) state.contentHash = image.storage.contentHash;
  }
  store.put(retentionKind, state);
  return state;
}

function stateOf(record: RetentionRecord): ImageRetentionState {
  const { id: _, ...state } = record;
  return state;
}

/** Read-only projection; message copies never overwrite the independent retention record. */
export function imageWithStorage(store: Store, image: GeneratedImage): GeneratedImage {
  const saved = store.get<RetentionRecord>(retentionKind, image.id);
  return saved ? { ...image, storage: stateOf(saved) } : image;
}

/** Register only app-managed images. Existing owner protection choices survive registration. */
export function registerManagedImage(
  store: Store,
  image: GeneratedImage,
  options: { uploaded?: boolean; now?: number } = {},
): GeneratedImage {
  imageFilename(image);
  retention(store, image, new Date(options.now ?? Date.now()).toISOString(), options.uploaded);
  return imageWithStorage(store, image);
}

/** Successful explicit use only. Callers must not invoke this for previews or hydration. */
export function touchManagedImage(
  store: Store,
  imageId: string,
  reason: ImageUseReason,
  at = Date.now(),
): void {
  if (!IMAGE_ID.test(imageId)) problem('Image not found.', 404);
  if (!['open', 'download', 'view', 'edit', 'attach'].includes(reason))
    problem('Invalid image use reason.');
  const image = store.get<GeneratedImage>('images', imageId);
  if (!image) problem('Image not found.', 404);
  const stamp = new Date(at).toISOString();
  const state = retention(store, image, stamp);
  if (state.deletedAt)
    problem('The image original was removed by the storage retention policy.', 410);
  const root = realpathSync.native(store.dataDir);
  const filename = managedPath(root, ['generated-images', imageFilename(image)]);
  if (!filename || !lstatSync(filename).isFile())
    problem('The image original is unavailable.', 404);
  if (state.contentHash && isImageAssetDeleted(store.dataDir, state.contentHash))
    problem('The image original was removed by the storage retention policy.', 410);
  store.put(retentionKind, {
    ...state,
    lastUsedAt: new Date(Math.max(at, Date.parse(state.lastUsedAt) || 0)).toISOString(),
  });
}

function settings(store: Store): ImageStorageSettings {
  const saved = store.get<ImageStorageSettings & { id: string }>(settingsKind, 'main');
  return {
    autoCleanup: saved?.autoCleanup === true,
    unusedDays:
      Number.isInteger(saved?.unusedDays) &&
      saved!.unusedDays >= IMAGE_STORAGE_UNUSED_DAYS.min &&
      saved!.unusedDays <= IMAGE_STORAGE_UNUSED_DAYS.max
        ? saved!.unusedDays
        : DEFAULT_IMAGE_STORAGE_SETTINGS.unusedDays,
  };
}

function publishImageStates(store: Store, ids: ReadonlySet<string>): void {
  for (const id of ids) {
    const image = store.get<GeneratedImage>('images', id);
    if (image) store.put('images', imageWithStorage(store, image));
  }
  for (const message of store.list<Message>('messages')) {
    if (!message.attachments?.some((image) => ids.has(image.id))) continue;
    const room = store.get<Room>('rooms', message.roomId);
    if (!room || room.deletion || store.get('deletedRooms', message.roomId)) continue;
    store.put('messages', {
      ...message,
      attachments: message.attachments.map((image) =>
        ids.has(image.id) ? imageWithStorage(store, image) : image,
      ),
    });
  }
}

/** Raw bytes stay bounded while hashing originals and session assets. */
async function verifyFile(filename: string, expectedBytes: number): Promise<VerifiedFile> {
  const before = lstatSync(filename);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size !== expectedBytes ||
    expectedBytes < 1 ||
    expectedBytes > MAX_IMAGE_INPUT_LIMITS.maxImageBytes
  )
    throw new Error('The stored image is missing or has an unexpected size.');
  const handle = await openFile(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!sameSignature(before, opened))
      throw new Error('The stored image changed while opening it.');
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expectedBytes));
    let offset = 0;
    while (offset < expectedBytes) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, expectedBytes - offset),
        offset,
      );
      if (!bytesRead) throw new Error('The stored image is incomplete.');
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (!sameSignature(opened, await handle.stat()) || !sameSignature(opened, lstatSync(filename)))
      throw new Error('The stored image changed while reading it.');
    return { path: filename, hash: digest.digest('hex'), signature: opened };
  } finally {
    await handle.close();
  }
}

/** Size of each managed inode is counted once; linked aliases never inflate totalBytes. */
function usage(
  store: Store,
  images: readonly ImageStorageItem[],
  warnings: string[],
): ImageStorageUsage {
  const root = realpathSync.native(store.dataDir);
  const seen = new Set<string>();
  let totalBytes = 0;
  let logicalBytes = 0;
  const categories: ImageStorageUsage['categories'] = [];
  const scan = (
    kind: ImageStorageCategory,
    parts: string[],
    accept?: (path: string) => boolean,
  ) => {
    let bytes = 0;
    let files = 0;
    let visited = 0;
    const visit = (components: string[], depth: number) => {
      if (depth > 16 || ++visited > 200_000)
        throw new Error('Image storage is too large to count safely.');
      const filename = managedPath(root, components);
      if (!filename) return;
      const stat = lstatSync(filename);
      if (stat.isDirectory()) {
        for (const name of readdirSync(filename)) {
          if (
            kind === 'backups' &&
            components.length === 1 &&
            ['assets', 'assets-retired'].includes(name)
          )
            continue;
          visit([...components, name], depth + 1);
        }
      } else if (stat.isFile() && (!accept || accept(filename))) {
        files++;
        logicalBytes += stat.size;
        const key = `${stat.dev}:${stat.ino}`;
        if (!seen.has(key)) {
          seen.add(key);
          bytes += stat.size;
          totalBytes += stat.size;
        }
      }
    };
    try {
      visit(parts, 0);
    } catch {
      warnings.push('一部の保存領域を安全に読み取れず、容量を集計できませんでした。');
    }
    categories.push({ kind, bytes, files });
  };
  scan('originals', ['generated-images']);
  scan('history', ['sessions', 'assets']);
  scan('backups', ['sessions'], (filename) => /\.inline-images-v1-[^/\\]+\.bak$/.test(filename));
  scan('uploads', ['browser-uploads']);
  const candidates = images.filter((image) => image.candidate);
  const candidatePaths = new Set<string>();
  for (const image of candidates) {
    candidatePaths.add(join(root, 'generated-images', imageFilename(image)));
    if (image.storage.contentHash)
      candidatePaths.add(join(root, 'sessions', 'assets', `${image.storage.contentHash}.bin`));
  }
  const candidateInodes = new Map<string, { size: number; links: number; count: number }>();
  for (const filename of candidatePaths) {
    try {
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const key = `${stat.dev}:${stat.ino}`;
      const current = candidateInodes.get(key);
      if (current) current.count++;
      else candidateInodes.set(key, { size: stat.size, links: stat.nlink, count: 1 });
    } catch (error) {
      if (!isMissing(error)) warnings.push('一部の画像の削減可能な容量を集計できませんでした。');
    }
  }
  const candidateBytes = [...candidateInodes.values()].reduce(
    (sum, inode) => sum + (inode.count >= inode.links ? inode.size : 0),
    0,
  );
  // This is the remaining consolidation opportunity, not the space already
  // saved by hard links. Group identical verified pixels across physical inodes.
  const duplicates = new Map<string, Map<string, number>>();
  for (const image of images) {
    const hash = image.storage.contentHash;
    if (
      !hash ||
      image.storage.deletedAt ||
      image.blockedReasons.some((reason) => ['missing', 'unverified'].includes(reason))
    )
      continue;
    let inodes = duplicates.get(hash);
    if (!inodes) duplicates.set(hash, (inodes = new Map()));
    for (const parts of [
      ['generated-images', imageFilename(image)],
      ['sessions', 'assets', `${hash}.bin`],
    ]) {
      try {
        const filename = managedPath(root, parts);
        if (!filename) continue;
        const stat = lstatSync(filename);
        if (stat.isFile() && stat.size === image.byteLength)
          inodes.set(`${stat.dev}:${stat.ino}`, stat.size);
      } catch {
        // Unverified files are never a promised source of reclaimable space.
      }
    }
  }
  const duplicateBytes = [...duplicates.values()].reduce((total, inodes) => {
    const sizes = [...inodes.values()];
    return (
      total +
      (sizes.length > 1 ? sizes.reduce((sum, size) => sum + size, 0) - Math.max(...sizes) : 0)
    );
  }, 0);
  return {
    totalBytes,
    logicalBytes,
    duplicateBytes,
    categories,
    imageCount: images.filter((image) => !image.storage.deletedAt).length,
    protectedCount: images.filter((image) => image.storage.protected && !image.storage.deletedAt)
      .length,
    candidateCount: candidates.length,
    candidateBytes,
  };
}

export interface ImageStorageOptions {
  store: Store;
  onChanged?: () => void;
  now?: () => number;
  cleanupIntervalMs?: number;
  isPaused?: () => boolean;
}

export function createImageStorage(options: ImageStorageOptions) {
  const { store } = options;
  const clock = options.now ?? Date.now;
  const digests = new Map<string, { signature: string; hash: string }>();
  let tail = Promise.resolve();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const available = () => {
    if (stopped || options.isPaused?.())
      problem('Image storage maintenance is currently paused.', 503);
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    available();
    const next = tail.then(() => {
      available();
      return operation();
    });
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const initializeRecords = () => {
    const stamp = new Date(clock()).toISOString();
    const uploaded = new Set(
      store
        .list<Message>('messages')
        .filter((message) => message.authorType === 'user')
        .flatMap((message) => message.attachments?.map((image) => image.id) ?? []),
    );
    for (const image of store.list<GeneratedImage>('images'))
      retention(store, image, stamp, uploaded.has(image.id));
  };

  async function inspect(): Promise<Inspection> {
    initializeRecords();
    const stamp = clock();
    const policy = settings(store);
    const root = realpathSync.native(store.dataDir);
    const warnings: string[] = [];
    const originals = new Map<string, VerifiedFile>();
    const roomNames = new Map(store.list<Room>('rooms').map((room) => [room.id, room.name]));
    const names = new Map<string, Set<string>>();
    for (const message of store.list<Message>('messages'))
      for (const image of message.attachments ?? []) {
        let rooms = names.get(image.id);
        if (!rooms) names.set(image.id, (rooms = new Set()));
        rooms.add(roomNames.get(message.roomId) ?? message.roomId);
      }
    const images: ImageStorageItem[] = [];
    for (const original of store.list<GeneratedImage>('images')) {
      let state = store.get<RetentionRecord>(retentionKind, original.id)!;
      const blockedReasons: ImageStorageBlockReason[] = [];
      const used = validTime(state.lastUsedAt) ? Date.parse(state.lastUsedAt) : stamp;
      const initialized = validTime(state.initializedAt) ? Date.parse(state.initializedAt) : stamp;
      const eligible = Math.max(used, initialized) + policy.unusedDays * DAY;
      if (state.deletedAt) blockedReasons.push('deleted');
      else {
        if (state.protected) blockedReasons.push('protected');
        if (initialized + policy.unusedDays * DAY > stamp) blockedReasons.push('grace');
        if (used + policy.unusedDays * DAY > stamp) blockedReasons.push('recent');
        try {
          const filename = managedPath(root, ['generated-images', imageFilename(original)]);
          if (!filename) blockedReasons.push('missing');
          else {
            const stat = lstatSync(filename);
            const key = signature(stat);
            const cached = digests.get(original.id);
            const verified =
              cached?.signature === key
                ? { path: filename, hash: cached.hash, signature: stat }
                : await verifyFile(filename, original.byteLength);
            if (state.contentHash && state.contentHash !== verified.hash)
              throw new Error('The stored image no longer matches its registered content hash.');
            if (original.contentHash && original.contentHash !== verified.hash)
              throw new Error('The stored image no longer matches its original content hash.');
            if (isImageAssetDeleted(store.dataDir, verified.hash))
              throw new Error('The image asset is retired but its catalog entry is not.');
            if (
              original.contentHash &&
              !managedPath(root, ['sessions', 'assets', `${verified.hash}.bin`])
            )
              throw Object.assign(new Error('The canonical image asset is unexpectedly missing.'), {
                code: 'ENOENT',
              });
            digests.set(original.id, { signature: key, hash: verified.hash });
            originals.set(original.id, verified);
            if (!state.contentHash) {
              // A view/use can happen while the bounded file read yields. Merge its newest state.
              state = {
                ...store.get<RetentionRecord>(retentionKind, original.id)!,
                contentHash: verified.hash,
              };
              store.put(retentionKind, state);
            }
          }
        } catch (error) {
          blockedReasons.push(isMissing(error) ? 'missing' : 'unverified');
        }
      }
      images.push({
        ...original,
        storage: stateOf(state),
        candidate: !blockedReasons.length,
        eligibleAt: new Date(eligible).toISOString(),
        blockedReasons,
        roomNames: [...(names.get(original.id) ?? [])],
      });
    }
    const dependencies = imageDependencies(store, []);
    const active = activeManagedImages(store.dataDir);
    const byHash = new Map<string, ImageStorageItem[]>();
    for (const image of images) {
      if (image.storage.deletedAt) continue;
      const hash = image.storage.contentHash;
      if (active.imageIds.has(image.id) || (hash && active.hashes.has(hash)))
        image.blockedReasons.push('in_use');
      if (dependencies.images.has(image.id) || (hash && dependencies.hashes.has(hash)))
        image.blockedReasons.push('work');
      image.candidate = !image.blockedReasons.length;
      if (hash) {
        const group = byHash.get(hash) ?? [];
        group.push(image);
        byHash.set(hash, group);
      }
    }
    // A surviving image can depend on an older original. Propagate until all
    // protected chains and same-content aliases are accounted for.
    let changed = true;
    while (changed) {
      changed = false;
      const retained = references();
      for (const image of images)
        if (!image.storage.deletedAt && !image.candidate && image.inputImages?.length)
          collect(JSON.stringify(image.inputImages), retained);
      for (const image of images) {
        if (!image.candidate) continue;
        if (
          retained.images.has(image.id) ||
          (image.storage.contentHash && retained.hashes.has(image.storage.contentHash))
        ) {
          image.candidate = false;
          image.blockedReasons.push('dependency');
          changed = true;
        }
      }
      for (const group of byHash.values())
        if (group.some((image) => !image.candidate))
          for (const image of group)
            if (image.candidate) {
              image.candidate = false;
              image.blockedReasons.push('shared');
              changed = true;
            }
    }
    if (
      images.some((image) =>
        image.blockedReasons.some((reason) => ['missing', 'unverified'].includes(reason)),
      )
    )
      warnings.push('読み取れない画像や整合性を確認できない画像は、整理対象から除外しています。');
    return { images, originals, warnings };
  }

  /** Finish only already-committed deletions after a crash; never expires a new image. */
  async function recoverRetired(): Promise<number> {
    const root = realpathSync.native(store.dataDir);
    const records = store
      .list<GeneratedImage>('images')
      .map((image) => imageWithStorage(store, image));
    const groups = new Map<string, GeneratedImage[]>();
    for (const image of records) {
      const state = image.storage;
      if (!state?.deletedAt || !state.contentHash || !HASH.test(state.contentHash)) continue;
      const group = groups.get(state.contentHash) ?? [];
      group.push(image);
      groups.set(state.contentHash, group);
    }
    let freedBytes = 0;
    for (const [hash, group] of groups) {
      if (stopped || options.isPaused?.()) break;
      const files: VerifiedFile[] = [];
      try {
        for (const image of group) {
          const filename = managedPath(root, ['generated-images', imageFilename(image)]);
          if (!filename) continue;
          const file = await verifyFile(filename, image.byteLength);
          if (file.hash !== hash)
            throw new Error('A retired image changed before its deletion finished.');
          files.push(file);
        }
        const current = store
          .list<GeneratedImage>('images')
          .map((image) => imageWithStorage(store, image));
        const keepAsset = current.some(
          (image) =>
            !image.storage?.deletedAt && (image.storage?.contentHash ?? image.contentHash) === hash,
        );
        const assetPath = keepAsset
          ? undefined
          : managedPath(root, ['sessions', 'assets', `${hash}.bin`]);
        if (assetPath) {
          const file = await verifyFile(assetPath, group[0].byteLength);
          if (file.hash !== hash)
            throw new Error('A retired image asset changed before its deletion finished.');
          files.push(file);
        }
        if (!files.length && (keepAsset || isImageAssetDeleted(store.dataDir, hash))) continue;
        // Re-read every root after the asynchronous integrity checks.
        if (stopped || options.isPaused?.()) break;
        const latest = store
          .list<GeneratedImage>('images')
          .map((image) => imageWithStorage(store, image));
        const latestKeepAsset = latest.some(
          (image) =>
            !image.storage?.deletedAt && (image.storage?.contentHash ?? image.contentHash) === hash,
        );
        if (
          latestKeepAsset !== keepAsset ||
          group.some((image) => !store.get<RetentionRecord>(retentionKind, image.id)?.deletedAt)
        )
          continue;
        const active = activeManagedImages(store.dataDir);
        if (active.hashes.has(hash) || group.some((image) => active.imageIds.has(image.id)))
          continue;
        const dependencies = imageDependencies(
          store,
          latest.filter((image) => !image.storage?.deletedAt),
        );
        if (
          dependencies.hashes.has(hash) ||
          group.some((image) => dependencies.images.has(image.id))
        )
          continue;
        if (files.some((file) => !sameSignature(file.signature, lstatSync(file.path)))) continue;
        const workspaces = [
          store.settings().workspacePath,
          ...store.list<Room>('rooms').map((room) => room.workspacePath),
        ].filter((path): path is string => Boolean(path));
        if (
          workspaces.some((workspace) => {
            try {
              const path = realpathSync.native(workspace);
              return (
                inside(root, path) &&
                files.some((file) => inside(path, file.path) || inside(file.path, path))
              );
            } catch (error) {
              return !isMissing(error);
            }
          })
        )
          continue;
        if (!keepAsset) markImageAssetDeleted(store.dataDir, hash, group[0].storage!.deletedAt!);
        for (const file of files) {
          const stat = lstatSync(file.path);
          unlinkSync(file.path);
          if (stat.nlink === 1) freedBytes += stat.size;
        }
      } catch {
        // An interrupted deletion remains explicitly retired. Never convert a
        // changed path or unexpected file into a new deletion target.
      }
    }
    return freedBytes;
  }

  const manager = {
    async initialize(): Promise<void> {
      // Update verification and data restore start the app in maintenance mode.
      // This metadata-only adoption is safe before those gates reopen.
      initializeRecords();
      publishImageStates(
        store,
        new Set(store.list<GeneratedImage>('images').map((image) => image.id)),
      );
    },
    start(): void {
      if (timer || stopped) return;
      const run = () => {
        if (stopped || options.isPaused?.()) return;
        void enqueue(async () => {
          const recoveredBytes = await recoverRetired();
          if (recoveredBytes) {
            store.put('imageStorageCleanup', {
              id: 'last',
              at: new Date(clock()).toISOString(),
              deletedImages: 0,
              freedBytes: recoveredBytes,
            });
            options.onChanged?.();
          }
          if (options.isPaused?.() || !settings(store).autoCleanup) return;
          const current = await inspect();
          const ids = cleanupOrder(current.images)
            .slice(0, 200)
            .map((image) => image.id);
          if (ids.length) await cleanup(ids, true);
        }).catch(() => {});
      };
      timer = setInterval(run, options.cleanupIntervalMs ?? 30 * 60_000);
      timer.unref();
      run();
    },
    async shutdown(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await tail;
    },
    getSettings(): ImageStorageSettings {
      return settings(store);
    },
    updateSettings(input: Partial<ImageStorageSettings>): ImageStorageSettings {
      available();
      const next = { ...settings(store), ...input };
      if (
        typeof next.autoCleanup !== 'boolean' ||
        !Number.isInteger(next.unusedDays) ||
        next.unusedDays < IMAGE_STORAGE_UNUSED_DAYS.min ||
        next.unusedDays > IMAGE_STORAGE_UNUSED_DAYS.max
      )
        problem('Use a whole retention period between 1 and 3650 days.');
      store.put(settingsKind, { id: 'main', ...next });
      options.onChanged?.();
      return next;
    },
    touch(imageId: string, reason: ImageUseReason): void {
      available();
      touchManagedImage(store, imageId, reason, clock());
    },
    setProtected(imageId: string, value: boolean): GeneratedImage {
      manager.protect([imageId], value);
      return imageWithStorage(store, store.get<GeneratedImage>('images', imageId)!);
    },
    protect(imageIds: readonly string[], value: boolean): { updated: number } {
      available();
      if (typeof value !== 'boolean') problem('Protection must be true or false.');
      const ids = [...new Set(imageIds)];
      const found = ids.map((id) => {
        const image = IMAGE_ID.test(id) ? store.get<GeneratedImage>('images', id) : undefined;
        if (!image) problem('Image not found.', 404);
        const state = retention(store, image, new Date(clock()).toISOString());
        if (state.deletedAt)
          problem('An already removed image cannot be protected or restored.', 410);
        return { image, state };
      });
      for (const { image, state } of found)
        store.put(retentionKind, { ...state, id: image.id, protected: value });
      publishImageStates(store, new Set(ids));
      options.onChanged?.();
      return { updated: found.length };
    },
    list(query: ImageStorageQuery = {}): Promise<ImageStorageOverview> {
      return enqueue(async () => {
        const current = await inspect();
        const stats = usage(store, current.images, current.warnings);
        if (
          stats.categories.some(
            (category) =>
              (category.kind === 'backups' || category.kind === 'uploads') && category.bytes,
          )
        )
          current.warnings.push(
            '移行時のバックアップとブラウザー送信用の一時コピーは、画像原本の整理とは別に管理されます。',
          );
        const filtered = current.images
          .filter((image) =>
            query.filter === 'candidates'
              ? image.candidate
              : query.filter === 'protected'
                ? image.storage.protected && !image.storage.deletedAt
                : query.filter === 'deleted'
                  ? Boolean(image.storage.deletedAt)
                  : true,
          )
          .sort(
            query.sort === 'oldest'
              ? (a, b) =>
                  a.storage.lastUsedAt.localeCompare(b.storage.lastUsedAt) ||
                  a.id.localeCompare(b.id)
              : (a, b) => b.byteLength - a.byteLength || a.id.localeCompare(b.id),
          );
        const offset = Math.max(0, query.offset ?? 0);
        const limit = Math.max(1, Math.min(200, query.limit ?? 50));
        const lastCleanup = store.get<{
          id: string;
          at: string;
          deletedImages: number;
          freedBytes: number;
        }>('imageStorageCleanup', 'last');
        return {
          settings: settings(store),
          usage: stats,
          images: filtered.slice(offset, offset + limit),
          total: filtered.length,
          offset,
          limit,
          warnings: [...new Set(current.warnings)],
          ...(lastCleanup
            ? {
                lastCleanup: {
                  at: lastCleanup.at,
                  deletedImages: lastCleanup.deletedImages,
                  freedBytes: lastCleanup.freedBytes,
                },
              }
            : {}),
        };
      });
    },
    cleanup(imageIds: readonly string[]): Promise<ImageStorageCleanupResult> {
      return enqueue(() => cleanup(imageIds, false));
    },
    deduplicate(): Promise<ImageStorageDeduplicateResult> {
      return enqueue(async () => {
        const before = await inspect();
        const beforeUsage = usage(store, before.images, []);
        let consolidatedImages = 0;
        for (const image of before.images) {
          if (options.isPaused?.() || stopped) break;
          if (image.storage.deletedAt || !before.originals.has(image.id)) continue;
          if (image.blockedReasons.includes('in_use') || image.blockedReasons.includes('work'))
            continue;
          const original = before.originals.get(image.id)!;
          if (overlapsWorkspace(store, [original.path])) continue;
          const data = await readGeneratedImage(store.dataDir, image);
          if (stopped || options.isPaused?.()) break;
          const active = activeManagedImages(store.dataDir);
          if (
            active.imageIds.has(image.id) ||
            retainedSessionImageHashes(store.dataDir).has(original.hash)
          )
            continue;
          if (
            !store.get<GeneratedImage>('images', image.id) ||
            store.get<RetentionRecord>(retentionKind, image.id)?.deletedAt
          )
            continue;
          if (overlapsWorkspace(store, [original.path])) continue;
          const previous = lstatSync(original.path);
          const result = consolidateManagedImageAlias(store.dataDir, imageFilename(image), data);
          const after = lstatSync(before.originals.get(image.id)!.path);
          if (result.linked && (previous.dev !== after.dev || previous.ino !== after.ino))
            consolidatedImages++;
          const state = store.get<RetentionRecord>(retentionKind, image.id)!;
          if (state.contentHash && state.contentHash !== result.hash)
            throw new Error(
              'The image changed while its duplicate storage was being consolidated.',
            );
          store.put(retentionKind, { ...state, contentHash: result.hash });
          digests.delete(image.id);
        }
        const after = await inspect();
        const afterUsage = usage(store, after.images, []);
        options.onChanged?.();
        return {
          consolidatedImages,
          freedBytes: Math.max(0, beforeUsage.totalBytes - afterUsage.totalBytes),
        };
      });
    },
  };

  /** Check the reviewed identifiers again immediately before each synchronous removal. */
  async function cleanup(
    requested: readonly string[],
    automatic: boolean,
  ): Promise<ImageStorageCleanupResult> {
    const ids = new Set(requested);
    if (!ids.size || ids.size > 200 || [...ids].some((id) => !IMAGE_ID.test(id)))
      problem('Choose between 1 and 200 managed images to clean up.');
    const recoveredBytes = await recoverRetired();
    const initial = await inspect();
    const selected = new Map(
      initial.images.filter((image) => ids.has(image.id)).map((image) => [image.id, image]),
    );
    const skipped = new Map<string, ImageStorageBlockReason>();
    for (const id of ids) {
      const image = selected.get(id);
      if (!image) skipped.set(id, 'missing');
      else if (!image.candidate) skipped.set(id, image.blockedReasons[0] ?? 'unverified');
    }
    const groups = new Map<string, ImageStorageItem[]>();
    for (const image of cleanupOrder(initial.images)) {
      if (!ids.has(image.id) || skipped.has(image.id) || !image.storage.contentHash) continue;
      const group = groups.get(image.storage.contentHash) ?? [];
      group.push(image);
      groups.set(image.storage.contentHash, group);
    }
    let deletedImages = 0;
    let freedBytes = recoveredBytes;
    const changed = new Set<string>();
    const root = realpathSync.native(store.dataDir);
    let historicalReferences: References | undefined;
    for (const [hash, group] of groups) {
      const groupIds = new Set(group.map((image) => image.id));
      let asset: VerifiedFile | undefined;
      try {
        const filename = managedPath(root, ['sessions', 'assets', `${hash}.bin`]);
        if (filename) {
          asset = await verifyFile(filename, group[0].byteLength);
          if (asset.hash !== hash) throw new Error('The shared image asset is inconsistent.');
        }
      } catch {
        for (const image of group) skipped.set(image.id, 'unverified');
        continue;
      }
      // No await from this point until the marker, records and unlink operations finish.
      // The data directory has one Store owner; runtime leases protect async readers/writers.
      if (stopped || options.isPaused?.() || (automatic && !settings(store).autoCleanup)) {
        for (const image of group) skipped.set(image.id, 'in_use');
        continue;
      }
      const currentImages = store
        .list<GeneratedImage>('images')
        .map((image) => imageWithStorage(store, image));
      const aliases = currentImages.filter(
        (image) =>
          !image.storage?.deletedAt && (image.storage?.contentHash ?? image.contentHash) === hash,
      );
      const currentGroup = aliases.filter((image) => groupIds.has(image.id));
      const removeAsset = currentGroup.length === aliases.length;
      let blocked: ImageStorageBlockReason | undefined;
      if (currentGroup.length !== group.length) blocked = 'shared';
      if (removeAsset && !asset) {
        historicalReferences ??= historicalSessionReferences(root);
        if (historicalReferences.hashes.has(hash)) blocked = 'missing';
      }
      const active = activeManagedImages(store.dataDir);
      if (active.hashes.has(hash) || aliases.some((image) => active.imageIds.has(image.id)))
        blocked = 'in_use';
      const dependencies = imageDependencies(
        store,
        currentImages.filter((image) => !groupIds.has(image.id) && !image.storage?.deletedAt),
      );
      if (dependencies.hashes.has(hash) || group.some((image) => dependencies.images.has(image.id)))
        blocked = 'work';
      const now = clock();
      const period = settings(store).unusedDays * DAY;
      for (const image of aliases) {
        const state = image.storage;
        if (!state) {
          blocked = 'unverified';
          continue;
        }
        if (state.protected) blocked = groupIds.has(image.id) ? 'protected' : 'shared';
        else if (!validTime(state.initializedAt) || Date.parse(state.initializedAt) + period > now)
          blocked = 'grace';
        else if (!validTime(state.lastUsedAt) || Date.parse(state.lastUsedAt) + period > now)
          blocked = 'recent';
      }
      const files: VerifiedFile[] = [];
      for (const image of group) {
        const file = initial.originals.get(image.id);
        if (!file) {
          blocked = 'unverified';
          continue;
        }
        try {
          const current = managedPath(root, ['generated-images', imageFilename(image)]);
          if (!current || !sameSignature(file.signature, lstatSync(current)))
            blocked = 'unverified';
          else files.push(file);
        } catch {
          blocked = 'unverified';
        }
      }
      if (asset) {
        try {
          if (!sameSignature(asset.signature, lstatSync(asset.path))) blocked = 'unverified';
          else if (removeAsset) files.push(asset);
        } catch {
          blocked = 'unverified';
        }
      }
      const workspaces = [
        store.settings().workspacePath,
        ...store.list<Room>('rooms').map((room) => room.workspacePath),
      ].filter((path): path is string => Boolean(path));
      for (const workspace of workspaces) {
        try {
          const path = realpathSync.native(workspace);
          if (
            inside(root, path) &&
            files.some((file) => inside(path, file.path) || inside(file.path, path))
          )
            blocked = 'dependency';
        } catch (error) {
          if (!isMissing(error)) blocked = 'unverified';
        }
      }
      if (blocked) {
        for (const image of group) skipped.set(image.id, blocked);
        continue;
      }
      const deletedAt = new Date(now).toISOString();
      for (const image of currentGroup) {
        const state = store.get<RetentionRecord>(retentionKind, image.id)!;
        store.put(retentionKind, { ...state, deletedAt });
        changed.add(image.id);
      }
      // A selected alias can expire while another eligible alias of the same
      // pixels survives. Retire the shared history asset only with the last one.
      if (removeAsset) markImageAssetDeleted(store.dataDir, hash, deletedAt);
      // A durable tombstone precedes removal so a crash never turns intentional
      // expiry into an unexplained missing-image error when history is resumed.
      for (const file of files) {
        const stat = lstatSync(file.path);
        unlinkSync(file.path);
        if (stat.nlink === 1) freedBytes += stat.size;
      }
      deletedImages += currentGroup.length;
      for (const image of currentGroup) digests.delete(image.id);
    }
    if (changed.size) {
      publishImageStates(store, changed);
      options.onChanged?.();
    }
    store.put('imageStorageCleanup', {
      id: 'last',
      at: new Date(clock()).toISOString(),
      deletedImages,
      freedBytes,
    });
    return {
      deletedImages,
      freedBytes,
      skipped: [...skipped].map(([id, reason]) => ({ id, reason })),
    };
  }

  return manager;
}

export type ImageStorage = ReturnType<typeof createImageStorage>;
