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
  rmSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GeneratedImage, Room, Task } from '../shared/types.js';
import type { ImageRetentionState } from '../shared/image-storage.js';
import { LEARNING_ROOM_MIGRATION_AUDIT_KIND } from './learning-room-migration.js';
import { SERVICE_ROOM_MIGRATION_AUDIT_KIND } from './service-room-migration.js';
import { retainedSessionImageHashes } from './runtime/session-images.js';
import type { Store } from './store.js';

const scopedKinds = new Set([
  'messages',
  'tasks',
  'taskInputs',
  'activities',
  'approvals',
  'notifications',
  'automations',
  'workItems',
  'wakeups',
  'memories',
  'skills',
  'serviceAccounts',
]);
const taskKinds = new Set(['operations', 'taskInputs', 'activities', 'approvals', 'notifications']);
const auditKinds = new Set([LEARNING_ROOM_MIGRATION_AUDIT_KIND, SERVICE_ROOM_MIGRATION_AUDIT_KIND]);
const removableKinds = new Set([...scopedKinds, ...taskKinds, ...auditKinds, 'automationState']);
const diskKey = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const imageIdPattern = /img_[a-f0-9]{64}/g;
const sessionAssetPattern = /loom-image:v1:sha256:([a-f0-9]{64}):[1-9][0-9]*/g;
const ownedSessionAssetPattern =
  /(?<!\\)"data"\s*:\s*"loom-image:v1:sha256:([a-f0-9]{64}):[1-9][0-9]*"/g;
const imageId = /^img_[a-f0-9]{64}$/;
const hash = /^[a-f0-9]{64}$/;
const diskHash = /^[a-f0-9]{24}$/;

/** Identifiers only. Persist this plan before deleting records or managed files. */
export interface RoomDeletionPlan {
  version: 1;
  roomId: string;
  taskIds: string[];
  records: { kind: string; id: string }[];
  automationIds: string[];
  serviceIds: string[];
  eventIds: number[];
  dedupKeys: string[];
  /** Slash-separated paths, constrained to exact Bot × Room/learning session directories. */
  sessionDirectories: string[];
  imageIds: string[];
  sessionAssetHashes: string[];
  /** Binds retry-only filesystem identifiers to this dataset's reviewed plan. */
  proof: string;
}

type StoredRow = { kind: string; id: string; data: string };
type Fields = {
  roomId?: string | null;
  taskId?: string;
  messageId?: string;
  workId?: string;
  automationId?: string;
  collection?: string;
  recordId?: string;
};
interface References {
  images: Set<string>;
  assets: Set<string>;
}
const references = (): References => ({ images: new Set(), assets: new Set() });
function collectReferences(text: string, result: References) {
  for (const match of text.matchAll(imageIdPattern)) result.images.add(match[0]);
  for (const match of text.matchAll(sessionAssetPattern)) result.assets.add(match[1]);
  for (const match of text.matchAll(/"contentHash"\s*:\s*"([a-f0-9]{64})"/g))
    result.assets.add(match[1]);
}
function collectOwnedReferences(value: unknown, result: References, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 32) return;
  if (Array.isArray(value)) {
    for (const child of value) collectOwnedReferences(child, result, depth + 1);
    return;
  }
  const item = value as Record<string, unknown>;
  if (item.type === 'image' && typeof item.id === 'string' && imageId.test(item.id))
    result.images.add(item.id);
  if (item.type === 'image' && typeof item.contentHash === 'string' && hash.test(item.contentHash))
    result.assets.add(item.contentHash);
  if (item.type === 'image' && typeof item.data === 'string')
    for (const match of item.data.matchAll(sessionAssetPattern)) result.assets.add(match[1]);
  for (const [key, child] of Object.entries(item)) {
    if (key === 'imageId' && typeof child === 'string' && imageId.test(child))
      result.images.add(child);
    if (key === 'inputImageIds' && Array.isArray(child))
      for (const id of child) if (typeof id === 'string' && imageId.test(id)) result.images.add(id);
    if (key === 'attachments' && Array.isArray(child))
      for (const image of child) {
        const id = (image as { id?: unknown } | null)?.id;
        if (typeof id === 'string' && imageId.test(id)) result.images.add(id);
      }
    if (key === 'result' && typeof child === 'string') {
      try {
        collectOwnedReferences(JSON.parse(child), result, depth + 1);
      } catch {
        /* Non-JSON tool prose does not establish image ownership. */
      }
    } else collectOwnedReferences(child, result, depth + 1);
  }
}
const keyFor = (kind: string, id: string) => JSON.stringify([kind, id]);
const within = (root: string, filename: string): boolean => {
  const part = relative(root, filename);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** App-owned descendants only; never follow links or infer a user path from a stored filename. */
function managedFiles(store: Store) {
  const root = realpathSync.native(store.dataDir);
  const workspaces = [
    store.settings().workspacePath,
    ...store.list<Room>('rooms').map((r) => r.workspacePath),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => {
      try {
        return realpathSync.native(value);
      } catch (error) {
        if (!missing(error)) throw error;
        return resolve(value);
      }
    })
    // A project workspace may contain its .loom directory. Its managed storage is
    // still owned by the app; an explicitly selected directory *inside* that
    // storage, however, must never be recursively removed as conversation data.
    .filter((value) => within(root, value));

  function path(parts: string, destructive = false): string | undefined {
    if (
      !parts ||
      parts.includes('\\') ||
      parts.split('/').some((p) => !p || p === '.' || p === '..')
    )
      throw new Error('Invalid managed room deletion path.');
    const filename = join(root, ...parts.split('/'));
    if (!within(root, filename) || filename === root)
      throw new Error('Room deletion cannot access a path outside managed storage.');
    let current = root;
    const components = parts.split('/');
    for (let index = 0; index < components.length; index++) {
      current = join(current, components[index]);
      let stat;
      try {
        stat = lstatSync(current);
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
      if (stat.isSymbolicLink() || (index < components.length - 1 && !stat.isDirectory()))
        throw new Error('Room deletion found an unsafe link in managed storage.');
    }
    if (
      destructive &&
      workspaces.some((workspace) => within(workspace, filename) || within(filename, workspace))
    )
      throw new Error(
        'A conversation storage path overlaps a configured workspace. Keep the workspace safe before retrying deletion.',
      );
    return filename;
  }

  function walk(
    parts: string,
    callback: (filename: string, part: string) => void,
    depth = 0,
  ): void {
    if (depth > 32) throw new Error('Conversation storage is nested too deeply to delete safely.');
    const filename = path(parts);
    if (!filename) return;
    const stat = lstatSync(filename);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(filename)) walk(`${parts}/${entry}`, callback, depth + 1);
    } else if (stat.isFile()) callback(filename, parts);
    else throw new Error('Conversation storage contains an unsupported file.');
  }

  function scanFile(filename: string, result: References, ownership = false) {
    const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!fstatSync(fd).isFile()) throw new Error('A conversation file is not a regular file.');
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let tail = '';
      for (;;) {
        const count = readSync(fd, chunk, 0, chunk.length, null);
        if (!count) break;
        const text = tail + chunk.subarray(0, count).toString('utf8');
        if (ownership) {
          for (const match of text.matchAll(ownedSessionAssetPattern)) result.assets.add(match[1]);
        } else collectReferences(text, result);
        // Both identifiers are ASCII and shorter than this overlap. Large
        // inline images/JSONL histories never need to be hydrated into memory.
        tail = text.slice(-256);
      }
    } finally {
      closeSync(fd);
    }
  }

  function scanSessions(result: References, excluded = new Set<string>()) {
    const directory = path('sessions');
    if (!directory) return;
    for (const entry of readdirSync(directory)) {
      if (entry === 'assets' || entry === 'assets-retired') continue;
      const first = `sessions/${entry}`;
      const firstPath = path(first);
      if (!firstPath) continue;
      if (!lstatSync(firstPath).isDirectory()) {
        scanFile(firstPath, result);
        continue;
      }
      for (const child of readdirSync(firstPath)) {
        const second = `${first}/${child}`;
        if (!excluded.has(second)) walk(second, (filename) => scanFile(filename, result));
      }
    }
  }

  return {
    path,
    scanSessions,
    scanDirectory(parts: string, result: References, ownership = false) {
      walk(parts, (filename) => scanFile(filename, result, ownership));
    },
    removeDirectory(parts: string) {
      const filename = path(parts, true);
      if (!filename) return;
      if (!lstatSync(filename).isDirectory())
        throw new Error('A conversation directory is not a directory.');
      // Validate all descendants before rmSync. Runtime writers are drained by
      // the caller; synchronous validation/removal cannot interleave app writes.
      walk(parts, () => {});
      rmSync(filename, { recursive: true });
    },
    removeFile(parts: string) {
      const filename = path(parts, true);
      if (!filename) return;
      if (!lstatSync(filename).isFile()) throw new Error('A managed image is not a regular file.');
      unlinkSync(filename);
    },
  };
}

function rows(store: Store): Iterable<StoredRow> {
  return store.db
    .prepare('SELECT kind,id,data FROM objects ORDER BY kind,id')
    .iterate() as Iterable<StoredRow>;
}

function auditIsOwned(store: Store, row: StoredRow, roomId: string, removed: Set<string>): boolean {
  const audit = JSON.parse(row.data) as Fields;
  const collection =
    row.kind === SERVICE_ROOM_MIGRATION_AUDIT_KIND ? 'serviceAccounts' : audit.collection;
  if (!collection || !audit.recordId) return false;
  const current = store.get<Fields>(collection, audit.recordId);
  // A record deliberately reassigned/shared after migration owns its original
  // audit too. An old audit.roomId alone must not erase another room's history.
  return current
    ? removed.has(keyFor(collection, audit.recordId)) && current.roomId === roomId
    : audit.roomId === roomId;
}

export function planRoomDeletion(store: Store, roomId: string): RoomDeletionPlan {
  if (!store.get<Room>('rooms', roomId)) throw new Error('The room no longer exists.');
  const plan: RoomDeletionPlan = {
    version: 1,
    roomId,
    taskIds: [],
    records: [],
    automationIds: [],
    serviceIds: [],
    eventIds: [],
    dedupKeys: [],
    sessionDirectories: [],
    imageIds: [],
    sessionAssetHashes: [],
    proof: '',
  };
  const owned = new Set<string>();
  const ownRefs = references();
  const add = (row: StoredRow) => {
    const key = keyFor(row.kind, row.id);
    if (owned.has(key)) return;
    owned.add(key);
    plan.records.push({ kind: row.kind, id: row.id });
    const value = JSON.parse(row.data);
    collectOwnedReferences(value, ownRefs);
    // A generated raster may finish immediately before its receipt is settled.
    // Its server-issued operation key still proves the exact managed file ID.
    if (
      row.kind === 'operations' &&
      ['generate_image', 'edit_image'].includes(value.toolName) &&
      hash.test(row.id)
    )
      ownRefs.images.add(`img_${row.id}`);
  };
  for (const row of rows(store)) {
    if (!scopedKinds.has(row.kind)) continue;
    if ((JSON.parse(row.data) as Fields).roomId !== roomId) continue;
    add(row);
    if (row.kind === 'tasks') plan.taskIds.push(row.id);
    if (row.kind === 'automations') plan.automationIds.push(row.id);
    if (row.kind === 'serviceAccounts') plan.serviceIds.push(row.id);
  }
  const tasks = new Set(plan.taskIds);
  const automations = new Set(plan.automationIds);
  const messages = new Set(plan.records.filter((r) => r.kind === 'messages').map((r) => r.id));
  const works = new Set(plan.records.filter((r) => r.kind === 'workItems').map((r) => r.id));
  for (const row of rows(store)) {
    if (owned.has(keyFor(row.kind, row.id))) continue;
    if (row.kind === 'automationState' && automations.has(row.id)) add(row);
    else if (auditKinds.has(row.kind) && auditIsOwned(store, row, roomId, owned)) add(row);
    else if (taskKinds.has(row.kind)) {
      const value = JSON.parse(row.data) as Fields;
      if (value.roomId && value.roomId !== roomId) continue;
      if (
        (value.taskId && tasks.has(value.taskId)) ||
        (row.kind === 'notifications' && value.messageId && messages.has(value.messageId))
      )
        add(row);
    }
  }
  for (const event of store.db.prepare('SELECT id,data FROM events').iterate() as Iterable<{
    id: number;
    data: string;
  }>) {
    let value: Fields;
    try {
      value = JSON.parse(event.data) as Fields;
    } catch {
      continue;
    }
    if (value?.roomId && value.roomId !== roomId) continue;
    if (
      value &&
      (value.roomId === roomId ||
        (value.taskId && tasks.has(value.taskId)) ||
        (value.messageId && messages.has(value.messageId)) ||
        (value.workId && works.has(value.workId)) ||
        (value.automationId && automations.has(value.automationId)))
    ) {
      plan.eventIds.push(event.id);
      collectOwnedReferences(value, ownRefs);
    }
  }
  const prefixes = plan.automationIds.flatMap((id) => [`webhook:${id}:`, `mail-event:${id}:`]);
  for (const row of store.db.prepare('SELECT key FROM dedup').iterate() as Iterable<{
    key: string;
  }>)
    if (prefixes.some((prefix) => row.key.startsWith(prefix))) plan.dedupKeys.push(row.key);

  const files = managedFiles(store);
  const sessions = files.path('sessions');
  const directories = new Set<string>();
  if (sessions)
    for (const bot of readdirSync(sessions)) {
      if (!diskHash.test(bot)) continue;
      const candidate = `sessions/${bot}/${diskKey(roomId)}`;
      if (files.path(candidate)) directories.add(candidate);
    }
  for (const taskId of plan.taskIds) {
    const candidate = `sessions/learning/${diskKey(taskId)}`;
    if (files.path(candidate)) directories.add(candidate);
  }
  for (const directory of directories) {
    files.path(directory, true);
    const found = references();
    files.scanDirectory(directory, found, true);
    for (const hash of found.assets) ownRefs.assets.add(hash);
  }
  plan.sessionDirectories = [...directories].sort();
  for (const id of ownRefs.images) {
    const image = store.get<GeneratedImage>('images', id);
    const retention = store.get<ImageRetentionState>('imageRetention', id);
    for (const value of [image?.contentHash, retention?.contentHash])
      if (typeof value === 'string' && hash.test(value)) ownRefs.assets.add(value);
  }
  plan.imageIds = [...ownRefs.images].sort();
  plan.sessionAssetHashes = [...ownRefs.assets].sort();
  plan.proof = planProof(store, plan);
  return plan;
}

function planProof(store: Store, plan: RoomDeletionPlan): string {
  const { proof: _proof, ...unsigned } = plan;
  return store.secretFingerprint('room-deletion-plan-v1', JSON.stringify(unsigned));
}

export function validateRoomDeletionPlan(store: Store, plan: RoomDeletionPlan) {
  if (
    plan.version !== 1 ||
    typeof plan.roomId !== 'string' ||
    !plan.roomId ||
    !Array.isArray(plan.records) ||
    plan.records.some(
      (record) => !removableKinds.has(record.kind) || typeof record.id !== 'string',
    ) ||
    !Array.isArray(plan.taskIds) ||
    !Array.isArray(plan.automationIds) ||
    !Array.isArray(plan.serviceIds) ||
    !Array.isArray(plan.eventIds) ||
    plan.eventIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    !Array.isArray(plan.dedupKeys) ||
    !Array.isArray(plan.sessionDirectories) ||
    !Array.isArray(plan.imageIds) ||
    plan.imageIds.some((id) => !imageId.test(id)) ||
    !Array.isArray(plan.sessionAssetHashes) ||
    plan.sessionAssetHashes.some((value) => !hash.test(value)) ||
    typeof plan.proof !== 'string' ||
    plan.proof !== planProof(store, plan)
  )
    throw new Error('The saved room deletion plan is invalid.');
  if (!store.get<Room>('rooms', plan.roomId)) throw new Error('The room no longer exists.');
  const taskIds = new Set<string>();
  for (const id of plan.taskIds) {
    const task = store.get<Task>('tasks', id);
    if (!task) continue;
    if (task.roomId !== plan.roomId) throw new Error('A task changed rooms before deletion.');
    taskIds.add(id);
  }
  const owned = new Set(plan.records.map((row) => keyFor(row.kind, row.id)));
  for (const entry of plan.records) {
    const value = store.get<Fields>(entry.kind, entry.id);
    if (!value) continue;
    if (auditKinds.has(entry.kind)) {
      if (auditIsOwned(store, { ...entry, data: JSON.stringify(value) }, plan.roomId, owned))
        continue;
    } else if (entry.kind === 'automationState') {
      if (store.get<Fields>('automations', entry.id)?.roomId === plan.roomId) continue;
    } else if (value.roomId === plan.roomId) continue;
    else if (!value.roomId && taskKinds.has(entry.kind)) {
      if (value.taskId && taskIds.has(value.taskId)) continue;
      if (
        entry.kind === 'notifications' &&
        value.messageId &&
        store.get<Fields>('messages', value.messageId)?.roomId === plan.roomId
      )
        continue;
    }
    throw new Error('A saved deletion record no longer belongs to this room.');
  }
  const taskDirectories = new Set(plan.taskIds.map((id) => `sessions/learning/${diskKey(id)}`));
  for (const directory of plan.sessionDirectories) {
    const parts = directory.split('/');
    if (
      !taskDirectories.has(directory) &&
      !(
        parts.length === 3 &&
        parts[0] === 'sessions' &&
        diskHash.test(parts[1]) &&
        parts[2] === diskKey(plan.roomId)
      )
    )
      throw new Error('The saved room deletion plan contains an invalid session path.');
  }
}

/**
 * The caller has persisted the plan and drained all of this room's writers.
 * Keep its room and lifecycle record until this idempotent cleanup succeeds.
 */
export async function purgeRoomData(store: Store, plan: RoomDeletionPlan): Promise<void> {
  validateRoomDeletionPlan(store, plan);
  const files = managedFiles(store);
  for (const directory of plan.sessionDirectories) files.path(directory, true);
  const owned = new Set(plan.records.map((row) => keyFor(row.kind, row.id)));
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const record of plan.records) store.remove(record.kind, record.id);
    for (const id of plan.automationIds) {
      store.setSecret(`imap.${id}.password`, '');
      store.setSecret(`hook.${id}`, '');
    }
    for (const id of plan.serviceIds) store.setSecret(`service.${id}.credential`, '');
    for (const id of plan.eventIds) store.db.prepare('DELETE FROM events WHERE id=?').run(id);
    for (const key of plan.dedupKeys) store.db.prepare('DELETE FROM dedup WHERE key=?').run(key);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  for (const directory of plan.sessionDirectories) files.removeDirectory(directory);

  // The catalog is not a live reference. All other surviving records are roots,
  // including avatar/test jobs, shared mail, and saved original migration data.
  const retained = references();
  const candidates = new Set(plan.imageIds);
  const imageReferences = new Map<string, References>();
  for (const row of rows(store)) {
    if (
      row.kind === 'roomDeletions' ||
      row.kind === 'deletedRooms' ||
      row.kind === 'imageRetention' ||
      owned.has(keyFor(row.kind, row.id))
    )
      continue;
    if (row.kind === 'images') {
      const refs = references();
      collectReferences(row.data, refs);
      const retention = store.get<ImageRetentionState>('imageRetention', row.id);
      if (typeof retention?.contentHash === 'string' && hash.test(retention.contentHash))
        refs.assets.add(retention.contentHash);
      refs.images.delete(row.id);
      imageReferences.set(row.id, refs);
      if (!candidates.has(row.id)) retained.images.add(row.id);
    } else collectReferences(row.data, retained);
  }
  for (const event of store.db.prepare('SELECT data FROM events').iterate() as Iterable<{
    data: string;
  }>)
    collectReferences(event.data, retained);
  files.scanSessions(retained);
  for (const value of retainedSessionImageHashes(store.dataDir)) retained.assets.add(value);
  // Preserve sources of a surviving edit/image as well as the displayed image.
  for (const id of retained.images) {
    const refs = imageReferences.get(id);
    if (!refs) continue;
    for (const source of refs.images) retained.images.add(source);
    for (const source of refs.assets) retained.assets.add(source);
  }
  for (const id of plan.imageIds) {
    if (retained.images.has(id)) continue;
    for (const extension of ['png', 'jpg', 'webp'])
      files.removeFile(`generated-images/${id}.${extension}`);
    store.remove('images', id);
    store.remove('imageRetention', id);
  }
  for (const value of plan.sessionAssetHashes)
    if (!retained.assets.has(value)) files.removeFile(`sessions/assets/${value}.bin`);
}
