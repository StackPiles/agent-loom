import { constants, createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough, Readable, Transform, Writable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import {
  DATA_TRANSFER_BROWSER_KEYS,
  DATA_TRANSFER_MAX_ARCHIVE_BYTES,
  type DataTransferArchivePreview,
  type DataTransferBrowserState,
  type DataTransferSummary,
} from '../shared/data-transfer.js';
import { ACTIVE, VERSION } from './controller.js';
import type { Task } from '../shared/types.js';
import { MAX_HANDOFF_LIMIT } from '../shared/handoffs.js';
import {
  IMAGE_STEP_LIMITS,
  IMAGE_STEP_PARAMETERS,
  IMAGE_TIMEOUT_LIMITS,
  MODEL_TIMEOUT_LIMITS,
} from '../shared/model-settings.js';
import { isNotificationReplyContext, isNotificationSender } from '../shared/notifications.js';
import { autonomousWakeupPolicySchema, workCheckpointSchema } from './work.js';
import { normalizeSchedule } from '../shared/schedules.js';
import { isTaskScheduling } from '../shared/scheduling.js';
import { IMAGE_INPUT_LIMITS } from '../shared/image-inputs.js';
import { browserUploadSettingsError, DEFAULT_BROWSER_SETTINGS } from '../shared/browser.js';
import {
  isTaskInput,
  TASK_INPUT_PENDING_LIMIT,
  TASK_INPUT_TOTAL_LIMIT,
} from '../shared/task-inputs.js';

export { DATA_TRANSFER_MAX_ARCHIVE_BYTES } from '../shared/data-transfer.js';
export const DATA_TRANSFER_MAX_EXPANDED_BYTES = 4 * 1024 ** 3;
export const DATA_TRANSFER_MAX_FILES = 200_000;
export const DATA_TRANSFER_MAX_MANIFEST_BYTES = 16 * 1024 ** 2;
export const DATA_TRANSFER_MAX_BROWSER_STATE_BYTES = 1024 ** 2;
export const DATA_TRANSFER_MIN_PASSWORD_LENGTH = 12;
export const DATA_TRANSFER_MAX_PASSWORD_BYTES = 1024;
export const DATA_TRANSFER_MAX_PATH_DEPTH = 64;
export const DATA_TRANSFER_MAX_RECORD_BYTES = 16 * 1024 ** 2;

// Version 1 is deliberately a small framed format, not a general purpose tar/zip
// reader. The authenticated header fixes KDF costs; the encrypted gzip contains
// a four-byte manifest length, JSON manifest, then file bodies in manifest order.
// Authenticate the complete ciphertext to a private temporary file BEFORE gzip
// or archive parsing, so neither unauthenticated data nor a gzip bomb is exposed.
const MAGIC = Buffer.from('LOOMDATA');
const FORMAT_VERSION = 1;
const HEADER_BYTES = 40;
const TAG_BYTES = 16;
const IO_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_SESSION_HEADER_BYTES = 1024 ** 2;
const MAX_OBJECT_BYTES = DATA_TRANSFER_MAX_RECORD_BYTES;
const MAX_WARNINGS = 2000;
const RESERVED = '.loom-transfer';
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const PLATFORMS = new Set([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
]);

interface Entry {
  path: string;
  type: 'directory' | 'file' | 'symlink';
  size: number;
  mtime: number;
  mode: number;
  target?: string;
}
interface ExternalWorkspace {
  sourcePath: string;
  id: string;
}
interface Manifest {
  format: number;
  version: string;
  createdAt: string;
  platform: string;
  dataDir: string;
  workspaces: string[];
  externalWorkspaces: ExternalWorkspace[];
  entries: Entry[];
  warnings: string[];
  browserState?: DataTransferBrowserState;
}
interface DatabaseInfo {
  counts: Record<string, number>;
  workspaces: Set<string>;
  enabledAutomations: number;
}
interface SourceFile {
  filename: string;
  dev: number;
  ino: number;
  size: number;
  mtime: number;
}

function reject(message: string, statusCode = 400, code = 'invalid_data_archive'): never {
  throw Object.assign(new Error(message), { statusCode, code });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function numberBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function integerBetween(value: unknown, min: number, max: number): value is number {
  return numberBetween(value, min, max) && Number.isSafeInteger(value);
}
function safeLabel(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 350);
}
class WarningList {
  readonly values: string[] = [];
  private seen = new Set<string>();
  private omitted = 0;
  add(message: string) {
    const safe = safeLabel(message);
    if (this.seen.has(safe)) return;
    if (this.values.length >= MAX_WARNINGS) {
      this.omitted++;
      return;
    }
    this.seen.add(safe);
    this.values.push(safe);
  }
  finish(): string[] {
    return this.omitted
      ? [
          ...this.values,
          `${this.omitted} additional excluded or unavailable paths were omitted from this warning list.`,
        ]
      : [...this.values];
  }
}

export function validateDataTransferPassword(password: unknown): asserts password is string {
  if (
    typeof password !== 'string' ||
    [...password].length < DATA_TRANSFER_MIN_PASSWORD_LENGTH ||
    Buffer.byteLength(password, 'utf8') > DATA_TRANSFER_MAX_PASSWORD_BYTES
  )
    reject(
      'Use an archive password of at least 12 characters and at most 1,024 UTF-8 bytes.',
      400,
      'invalid_archive_password',
    );
}
export function validateDataTransferBrowserState(
  value: unknown,
): DataTransferBrowserState | undefined {
  if (value === undefined) return;
  if (!isRecord(value) || !exactKeys(value, DATA_TRANSFER_BROWSER_KEYS))
    reject('The browser preferences contain unsupported fields.');
  const result: DataTransferBrowserState = {};
  for (const key of DATA_TRANSFER_BROWSER_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== 'string') reject('Browser preferences must contain text values.');
    result[key] = value[key];
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > DATA_TRANSFER_MAX_BROWSER_STATE_BYTES)
    reject(
      'Browser preferences and unsent chat drafts exceed the 1 MiB transfer limit.',
      413,
      'data_archive_limit',
    );
  return result;
}
async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, rejectKey) => {
    scrypt(password, salt, 32, { N: 65_536, r: 8, p: 1, maxmem: 128 * 1024 ** 2 }, (error, key) => {
      if (error) rejectKey(error);
      else resolve(key);
    });
  });
}
class ByteLimit extends Transform {
  bytes = 0;
  constructor(private readonly maximum: number) {
    super({ highWaterMark: IO_BYTES });
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.bytes += chunk.length;
    if (this.bytes > this.maximum)
      callback(
        Object.assign(new Error('The archive exceeds the transfer size limit.'), {
          statusCode: 413,
          code: 'data_archive_limit',
        }),
      );
    else callback(null, chunk);
  }
}
function sourcePaths(platform: string) {
  return platform === 'win32' ? path.win32 : path.posix;
}
function normalizedSource(value: unknown, platform: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > 32_768 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    reject('A workspace or session contains an invalid source path.');
  const api = sourcePaths(platform);
  if (!api.isAbsolute(value))
    reject('Workspace and session paths must be absolute on the source computer.');
  const normalized = api.normalize(value);
  if (
    platform === 'win32' &&
    (/^\\\\[?.]\\/.test(normalized) ||
      !(/^[A-Za-z]:\\/.test(normalized) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(normalized)))
  )
    reject('The archive contains an unsupported Windows device or drive-relative path.');
  return normalized;
}
function sourceKey(value: string, platform: string): string {
  const normalized = normalizedSource(value, platform);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function withinSource(root: string, candidate: string, platform: string): boolean {
  const api = sourcePaths(platform);
  const relative = api.relative(sourceKey(root, platform), sourceKey(candidate, platform));
  return (
    relative === '' ||
    (!api.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${api.sep}`))
  );
}
function workspaceId(sourcePath: string, platform: string): string {
  return createHash('sha256')
    .update(`${platform}\0${sourceKey(sourcePath, platform)}`)
    .digest('hex')
    .slice(0, 24);
}
function portablePath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > MAX_PATH_BYTES ||
    /[\\\x00-\x1f\x7f:*?"<>|]/.test(value)
  )
    reject('The archive contains an unsafe or unsupported file path.');
  if (value.split('/').length > DATA_TRANSFER_MAX_PATH_DEPTH)
    reject(
      'The archive contains a path deeper than the 64-level transfer limit.',
      413,
      'data_archive_limit',
    );
  for (const part of value.split('/')) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      /[. ]$/.test(part) ||
      WINDOWS_RESERVED.test(part) ||
      Buffer.byteLength(part) > 255
    )
      reject('The archive contains an unsafe or unsupported file path.');
  }
}
const portableKey = (value: string) => value.normalize('NFC').toLowerCase();
interface SourceNode {
  children: Map<string, SourceNode>;
  mapping?: { sourcePath: string; virtual: string };
}
class SourceIndex {
  private root: SourceNode = { children: new Map() };
  constructor(private readonly platform: string) {}
  private parts(value: string): string[] {
    const normalized = sourceKey(value, this.platform),
      api = sourcePaths(this.platform);
    const root = api.parse(normalized).root;
    return [root, ...normalized.slice(root.length).split(api.sep).filter(Boolean)];
  }
  add(sourcePath: string, virtual: string) {
    let node = this.root;
    for (const part of this.parts(sourcePath)) {
      let next = node.children.get(part);
      if (!next) {
        next = { children: new Map() };
        node.children.set(part, next);
      }
      node = next;
    }
    node.mapping = { sourcePath, virtual };
  }
  match(value: string) {
    let node = this.root,
      found = node.mapping;
    for (const part of this.parts(value)) {
      const next = node.children.get(part);
      if (!next) break;
      node = next;
      if (node.mapping) found = node.mapping;
    }
    return found;
  }
}
const sourceIndexes = new WeakMap<object, { count: number; index: SourceIndex }>();
const entryIndexes = new WeakMap<object, { count: number; paths: Map<string, Entry> }>();
function manifestEntryIndex(manifest: Manifest): Map<string, Entry> {
  let cached = entryIndexes.get(manifest);
  if (!cached || cached.count !== manifest.entries.length) {
    cached = {
      count: manifest.entries.length,
      paths: new Map(manifest.entries.map((entry) => [portableKey(entry.path), entry])),
    };
    entryIndexes.set(manifest, cached);
  }
  return cached.paths;
}
function canonicalVirtual(
  virtual: string,
  manifest: Pick<Manifest, 'platform'> & Partial<Manifest>,
): string {
  if (manifest.platform !== 'win32' || !manifest.entries) return virtual;
  const entries = manifestEntryIndex(manifest as Manifest);
  let parent = virtual;
  while (parent !== '.') {
    const actual = entries.get(portableKey(parent));
    if (actual) return actual.path + virtual.slice(parent.length);
    parent = path.posix.dirname(parent);
  }
  return virtual;
}
function virtualPath(
  sourcePath: string,
  manifest: Pick<Manifest, 'platform' | 'dataDir' | 'externalWorkspaces'>,
): string | undefined {
  const api = sourcePaths(manifest.platform);
  let cached = sourceIndexes.get(manifest);
  if (!cached || cached.count !== manifest.externalWorkspaces.length) {
    const index = new SourceIndex(manifest.platform);
    index.add(manifest.dataDir, 'data');
    for (const root of manifest.externalWorkspaces)
      index.add(root.sourcePath, `external/${root.id}`);
    cached = { count: manifest.externalWorkspaces.length, index };
    sourceIndexes.set(manifest, cached);
  }
  const match = cached.index.match(sourcePath);
  if (!match) return;
  const relative = api.relative(match.sourcePath, normalizedSource(sourcePath, manifest.platform));
  return canonicalVirtual(
    match.virtual + (relative ? '/' + relative.split(api.sep).join('/') : ''),
    manifest,
  );
}
function relativeDestination(virtual: string): string {
  portablePath(virtual);
  if (virtual === 'data') return '';
  if (virtual.startsWith('data/')) {
    const relative = virtual.slice(5);
    if (portableKey(relative.split('/')[0]!) === RESERVED)
      reject('An archive cannot contain Loom transfer jobs, backups, or lock files.');
    return relative;
  }
  if (/^external\/[a-f0-9]{24}(?:\/|$)/.test(virtual))
    return `imported-workspaces/${virtual.slice(9)}`;
  reject('The archive contains an unknown storage root.');
}
function destinationPath(root: string, virtual: string): string {
  const relative = relativeDestination(virtual);
  return relative ? path.join(root, ...relative.split('/')) : root;
}
function rebasedPath(sourcePath: string, manifest: Manifest, destinationRoot: string): string {
  const virtual = virtualPath(sourcePath, manifest);
  if (!virtual) reject('The archive is missing a workspace mapping needed by its saved data.');
  return destinationPath(destinationRoot, virtual);
}

const TABLE_SQL: Record<string, string> = {
  objects:
    'CREATE TABLE objects(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id))',
  secrets: 'CREATE TABLE secrets(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
  events:
    'CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL)',
  dedup: 'CREATE TABLE dedup(key TEXT PRIMARY KEY,created_at TEXT NOT NULL)',
  sqlite_sequence: 'CREATE TABLE sqlite_sequence(name,seq)',
};
const normalizeSql = (sql: string) => sql.replace(/\s+/g, '').toLowerCase();
function validateSchema(db: DatabaseSync) {
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version !== 1) reject('This archive uses an unsupported Loom database version.');
  if (
    (db.prepare('SELECT count(*) AS count FROM sqlite_schema').get() as { count: number }).count !==
    9
  )
    reject('The archive database contains an unsupported or incomplete schema.');
  if (
    db
      .prepare(
        'SELECT 1 FROM sqlite_schema WHERE octet_length(name)>256 OR octet_length(tbl_name)>256 OR octet_length(sql)>4096 LIMIT 1',
      )
      .get()
  )
    reject(
      'The archive database contains an oversized schema definition.',
      413,
      'data_archive_limit',
    );
  const rows = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema').all() as Array<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>;
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.name)) reject('The archive database contains duplicate schema objects.');
    seen.add(row.name);
    if (
      row.type === 'table' &&
      Object.hasOwn(TABLE_SQL, row.name) &&
      row.tbl_name === row.name &&
      row.sql &&
      normalizeSql(row.sql) === normalizeSql(TABLE_SQL[row.name]!)
    )
      continue;
    if (
      row.type === 'index' &&
      row.name === 'objects_kind_created' &&
      row.tbl_name === 'objects' &&
      row.sql &&
      normalizeSql(row.sql) ===
        normalizeSql('CREATE INDEX objects_kind_created ON objects(kind,created_at)')
    )
      continue;
    if (
      row.type === 'index' &&
      ['objects', 'secrets', 'dedup'].includes(row.tbl_name) &&
      row.name === `sqlite_autoindex_${row.tbl_name}_1` &&
      row.sql === null
    )
      continue;
    reject('The archive database contains an unsupported table, index, trigger, or view.');
  }
  if (Object.keys(TABLE_SQL).some((name) => !seen.has(name)) || !seen.has('objects_kind_created'))
    reject('The archive database is missing required Loom tables or indexes.');
}
function validateRecordSizes(db: DatabaseSync) {
  // octet_length(column) reads the SQLite record's size metadata. Wrapping the
  // column in CAST, or asking for Unicode length, can first materialize an entire
  // hostile value, defeating a length check intended to bound memory.
  const limits: Array<[string, Array<[string, number]>]> = [
    [
      'objects',
      [
        ['kind', 64],
        ['id', 1024],
        ['data', MAX_OBJECT_BYTES],
        ['created_at', 100],
        ['updated_at', 100],
      ],
    ],
    [
      'secrets',
      [
        ['key', 1024],
        ['value', 1024 ** 2],
      ],
    ],
    [
      'events',
      [
        ['type', 1024],
        ['data', MAX_OBJECT_BYTES],
        ['created_at', 100],
      ],
    ],
    [
      'dedup',
      [
        ['key', 16_384],
        ['created_at', 100],
      ],
    ],
    ['sqlite_sequence', [['name', 1024]]],
  ];
  for (const [table, columns] of limits) {
    const conditions = columns.map(
      ([column, limit]) => `(typeof(${column}) <> 'text' OR octet_length(${column}) > ${limit})`,
    );
    if (db.prepare(`SELECT 1 FROM ${table} WHERE ${conditions.join(' OR ')} LIMIT 1`).get())
      reject(
        'The archive contains an invalid or oversized database record.',
        413,
        'data_archive_limit',
      );
  }
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok')
    reject('The archive database failed its integrity check.');
}
function parseObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    reject('The archive database contains invalid saved JSON.');
  }
  if (!isRecord(value)) reject('The archive database contains an invalid saved record.');
  return value;
}
function validateSettings(value: Record<string, unknown>, platform: string) {
  const model = value.model,
    permissions = value.permissions,
    search = value.search;
  if (
    !isRecord(model) ||
    typeof model.baseUrl !== 'string' ||
    typeof model.modelId !== 'string' ||
    !numberBetween(model.contextWindow, 1, 100_000_000) ||
    !numberBetween(model.maxOutputTokens, 1, 100_000_000) ||
    !numberBetween(model.temperature, 0, 100) ||
    (model.imageInput !== undefined && typeof model.imageInput !== 'boolean') ||
    (model.responseTimeoutSeconds !== undefined &&
      !integerBetween(
        model.responseTimeoutSeconds,
        MODEL_TIMEOUT_LIMITS.min,
        MODEL_TIMEOUT_LIMITS.max,
      )) ||
    (model.idleTimeoutSeconds !== undefined &&
      !integerBetween(
        model.idleTimeoutSeconds,
        MODEL_TIMEOUT_LIMITS.min,
        MODEL_TIMEOUT_LIMITS.max,
      )) ||
    typeof value.demoMode !== 'boolean' ||
    typeof value.autoLearn !== 'boolean' ||
    (value.maxHandoffs !== null && !integerBetween(value.maxHandoffs, 0, MAX_HANDOFF_LIMIT)) ||
    !isRecord(permissions) ||
    !['shell', 'fileWrite', 'network'].every((key) =>
      ['allow', 'auto', 'ask', 'deny'].includes(String(permissions[key])),
    ) ||
    !isRecord(search) ||
    !['none', 'searxng', 'brave'].includes(String(search.provider)) ||
    typeof search.baseUrl !== 'string'
  )
    reject('The archive does not contain valid Loom settings.');
  normalizedSource(value.workspacePath, platform);
  if (value.images !== undefined) {
    const images = value.images;
    if (
      !isRecord(images) ||
      (images.permission !== undefined &&
        (typeof images.permission !== 'string' ||
          !['inherit', 'allow', 'ask', 'deny'].includes(images.permission)))
    )
      reject('The archive contains invalid image permission settings.');
    if (
      images.timeoutSeconds !== undefined &&
      !integerBetween(images.timeoutSeconds, IMAGE_TIMEOUT_LIMITS.min, IMAGE_TIMEOUT_LIMITS.max)
    )
      reject('The archive contains an invalid image generation timeout.');
    if (
      images.steps !== undefined &&
      images.steps !== null &&
      !integerBetween(images.steps, IMAGE_STEP_LIMITS.min, IMAGE_STEP_LIMITS.max)
    )
      reject('The archive contains an invalid image generation step count.');
    if (
      images.stepsParameter !== undefined &&
      (typeof images.stepsParameter !== 'string' ||
        !IMAGE_STEP_PARAMETERS.some((parameter) => parameter === images.stepsParameter))
    )
      reject('The archive contains an invalid image generation step parameter.');
  }
  if (value.browser !== undefined) {
    const browser = value.browser;
    if (
      !isRecord(browser) ||
      Object.keys(browser).some((key) => !Object.hasOwn(DEFAULT_BROWSER_SETTINGS, key)) ||
      typeof browser.enabled !== 'boolean' ||
      !['existing', 'dedicated'].includes(String(browser.mode)) ||
      !['allow', 'auto', 'ask', 'deny'].includes(String(browser.permission)) ||
      typeof browser.includeScreenshotsInModel !== 'boolean' ||
      (browser.maxConcurrentBrowsers !== undefined &&
        !integerBetween(browser.maxConcurrentBrowsers, 1, 16)) ||
      browserUploadSettingsError(browser)
    )
      reject('The archive contains invalid Chrome settings.');
  }
}
async function readPrivateFile(filename: string, maximum: number): Promise<Buffer> {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum)
    reject('A required archive file has an invalid type or size.');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (
      !actual.isFile() ||
      actual.size !== before.size ||
      actual.dev !== before.dev ||
      actual.ino !== before.ino
    )
      reject('A source file changed during the transfer. Please try again after stopping writers.');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
type ReadSavedRecord = (kind: string, id: string) => Record<string, unknown> | undefined;

/** Steering receipts must retain their exact task, owner message and image references. */
function validateTaskInputMetadata(
  kind: string,
  value: Record<string, unknown>,
  read: ReadSavedRecord,
) {
  const invalid = () => reject('The archive contains invalid additional-instruction metadata.');
  if (kind === 'approvals' && value.cancellationReason !== undefined) {
    if (value.cancellationReason !== 'superseded' || value.status !== 'cancelled') invalid();
  }
  if (kind === 'messages' && value.taskInputId !== undefined) {
    if (typeof value.taskInputId !== 'string') return invalid();
    const input = read('taskInputs', value.taskInputId);
    if (!input || input.messageId !== value.id) invalid();
  }
  if (kind !== 'taskInputs') return;
  const { requestFingerprint, ...input } = value;
  if (
    !isTaskInput(input) ||
    typeof requestFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(requestFingerprint)
  )
    return invalid();
  const task = read('tasks', input.taskId);
  const message = read('messages', input.messageId);
  const imageIds = input.inputImageIds ?? [];
  const attachments = message?.attachments ?? [];
  if (
    !task ||
    (task.kind !== 'chat' && task.kind !== 'automation') ||
    task.roomId !== input.roomId ||
    task.botId !== input.botId ||
    !message ||
    message.taskId !== input.taskId ||
    message.taskInputId !== input.id ||
    message.roomId !== input.roomId ||
    message.authorType !== 'user' ||
    message.authorId !== 'user' ||
    message.targetUser === true ||
    message.body !== input.body ||
    message.status !== 'complete' ||
    !Array.isArray(message.targetBotIds) ||
    message.targetBotIds.length !== 1 ||
    message.targetBotIds[0] !== input.botId ||
    !Array.isArray(attachments) ||
    attachments.length !== imageIds.length
  )
    return invalid();
  let imageBytes = 0;
  for (let index = 0; index < imageIds.length; index++) {
    const image = read('images', imageIds[index]);
    const attachment = attachments[index];
    if (
      !image ||
      !isRecord(attachment) ||
      attachment.id !== imageIds[index] ||
      image.source !== 'uploaded' ||
      image.type !== 'image' ||
      typeof image.mimeType !== 'string' ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) ||
      !integerBetween(image.byteLength, 1, IMAGE_INPUT_LIMITS.maxImageBytes) ||
      ['id', 'type', 'source', 'mimeType', 'filename', 'byteLength'].some(
        (key) => image[key] !== attachment[key],
      )
    )
      return invalid();
    imageBytes += image.byteLength as number;
  }
  if (imageBytes > IMAGE_INPUT_LIMITS.maxTotalBytes) invalid();
}

/** New optional image fields are validated without rejecting legacy attachment records. */
function validateImageMetadata(kind: string, value: Record<string, unknown>) {
  const imageId = (id: unknown) => typeof id === 'string' && /^img_[a-f0-9]{64}$/.test(id);
  const invalid = () => reject('The archive contains invalid image input or provenance metadata.');
  if (kind === 'tasks' && value.inputImageIds !== undefined) {
    const ids = value.inputImageIds;
    if (
      !Array.isArray(ids) ||
      ids.length > IMAGE_INPUT_LIMITS.maxImages ||
      !ids.every(imageId) ||
      new Set(ids).size !== ids.length
    )
      invalid();
  }
  const images =
    kind === 'images'
      ? [value]
      : kind === 'messages' && Array.isArray(value.attachments)
        ? value.attachments
        : [];
  for (const image of images) {
    if (!isRecord(image)) continue;
    if (
      image.source !== undefined &&
      (typeof image.source !== 'string' || !['generated', 'uploaded'].includes(image.source))
    )
      invalid();
    if (
      image.operation !== undefined &&
      (typeof image.operation !== 'string' || !['generate', 'edit'].includes(image.operation))
    )
      invalid();
    if (
      image.source === 'uploaded' &&
      (image.operation !== undefined || image.inputImages !== undefined)
    )
      invalid();
    if (image.inputImages === undefined) continue;
    const inputs = image.inputImages;
    if (!Array.isArray(inputs) || inputs.length > IMAGE_INPUT_LIMITS.maxImages + 1)
      return invalid();
    for (const input of inputs) {
      if (
        !isRecord(input) ||
        !exactKeys(input, ['role', 'imageId', 'path', 'sha256']) ||
        typeof input.role !== 'string' ||
        !['source', 'reference', 'mask'].includes(input.role) ||
        typeof input.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.sha256) ||
        (input.imageId !== undefined) === (input.path !== undefined)
      )
        return invalid();
      if (input.imageId !== undefined && !imageId(input.imageId)) invalid();
      if (
        input.path !== undefined &&
        (typeof input.path !== 'string' ||
          !input.path.trim() ||
          input.path.length > 4_000 ||
          /[\x00-\x1f\x7f]/.test(input.path) ||
          /^[\\/]|^[a-z][a-z0-9+.-]*:/i.test(input.path) ||
          path.win32.isAbsolute(input.path))
      )
        invalid();
    }
    const sources = inputs.filter((input) => input.role === 'source').length;
    const masks = inputs.filter((input) => input.role === 'mask').length;
    if (
      sources > 1 ||
      masks > 1 ||
      inputs.length - masks > IMAGE_INPUT_LIMITS.maxImages ||
      (image.operation === 'edit' && sources !== 1) ||
      (image.operation === 'generate' && (sources > 0 || masks > 0))
    )
      invalid();
  }
}

function notificationId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1_024;
}

/** Deleted historical records are allowed; present references must agree. */
function validateNotificationMetadata(
  kind: string,
  value: Record<string, unknown>,
  read: ReadSavedRecord,
) {
  if (kind === 'notifications' && (value.sender !== undefined || value.messageId !== undefined)) {
    const invalid = () =>
      reject('The archive contains invalid notification sender or source metadata.');
    if (value.sender !== undefined && !isNotificationSender(value.sender)) invalid();
    if (value.messageId !== undefined && !notificationId(value.messageId)) invalid();
    if (value.roomId !== undefined && !notificationId(value.roomId)) invalid();
    if (value.taskId !== undefined && !notificationId(value.taskId)) invalid();
    if (isNotificationSender(value.sender) && value.sender.kind === 'bot') {
      if (!notificationId(value.roomId)) invalid();
      const task = notificationId(value.taskId) ? read('tasks', value.taskId) : undefined;
      const message = notificationId(value.messageId)
        ? read('messages', value.messageId)
        : undefined;
      const messageTask = notificationId(message?.taskId)
        ? read('tasks', message.taskId)
        : undefined;
      if (
        (task && (task.botId !== value.sender.botId || task.roomId !== value.roomId)) ||
        (messageTask &&
          (messageTask.botId !== value.sender.botId || messageTask.roomId !== value.roomId)) ||
        (message &&
          (message.authorType !== 'bot' ||
            message.authorId !== value.sender.botId ||
            message.roomId !== value.roomId ||
            (message.targetBotIds !== undefined &&
              (!Array.isArray(message.targetBotIds) || message.targetBotIds.length > 0)) ||
            (value.taskId !== undefined && message.taskId !== value.taskId)))
      )
        invalid();
    }
  }
  if ((kind !== 'messages' && kind !== 'tasks') || value.notificationReply === undefined) return;
  const invalid = () => reject('The archive contains invalid notification reply context.');
  const reply = value.notificationReply;
  if (!isNotificationReplyContext(reply)) return invalid();
  if (value.roomId !== reply.roomId) invalid();
  if (kind === 'tasks') {
    if (
      value.botId !== reply.botId ||
      value.kind !== 'chat' ||
      value.parentTaskId !== undefined ||
      value.rootTaskId !== value.id ||
      value.depth !== 0 ||
      reply.taskId === value.id
    )
      invalid();
  } else if (
    value.authorType !== 'user' ||
    value.authorId !== 'user' ||
    value.targetUser === true ||
    !Array.isArray(value.targetBotIds) ||
    value.targetBotIds.length !== 1 ||
    value.targetBotIds[0] !== reply.botId ||
    reply.messageId === value.id
  )
    invalid();
  const notification = read('notifications', reply.notificationId);
  const task = reply.taskId ? read('tasks', reply.taskId) : undefined;
  const message = reply.messageId ? read('messages', reply.messageId) : undefined;
  const messageTask = notificationId(message?.taskId) ? read('tasks', message.taskId) : undefined;
  if (
    notification &&
    (notification.roomId !== reply.roomId ||
      notification.taskId !== reply.taskId ||
      notification.messageId !== reply.messageId ||
      (notification.sender !== undefined &&
        (!isNotificationSender(notification.sender) ||
          notification.sender.kind !== 'bot' ||
          notification.sender.botId !== reply.botId)))
  )
    invalid();
  if (task && (task.roomId !== reply.roomId || task.botId !== reply.botId)) invalid();
  if (messageTask && (messageTask.roomId !== reply.roomId || messageTask.botId !== reply.botId))
    invalid();
  if (
    message &&
    (message.roomId !== reply.roomId ||
      message.authorType !== 'bot' ||
      message.authorId !== reply.botId ||
      (message.targetBotIds !== undefined &&
        (!Array.isArray(message.targetBotIds) || message.targetBotIds.length > 0)) ||
      (reply.taskId !== undefined && message.taskId !== reply.taskId))
  )
    invalid();
}

async function inspectDatabase(dataDir: string, platform: string): Promise<DatabaseInfo> {
  const key = await readPrivateFile(path.join(dataDir, 'secret.key'), 32);
  if (key.length !== 32) reject('The archive must contain the original 32-byte encryption key.');
  const dbFile = path.join(dataDir, 'loom.sqlite');
  const stat = await lstat(dbFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > DATA_TRANSFER_MAX_EXPANDED_BYTES)
    reject('The archive must contain a regular Loom database file.');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true, allowExtension: false });
    validateSchema(db);
    validateRecordSizes(db);
    const counts: Record<string, number> = Object.create(null);
    const workspaces = new Set<string>();
    const taskInputCounts = new Map<
      string,
      { count: number; pending: number; sequences: Set<number> }
    >();
    let settingsFound = false,
      enabledAutomations = 0;
    const readRecord = db.prepare('SELECT data FROM objects WHERE kind=? AND id=?');
    const readSavedRecord: ReadSavedRecord = (kind, id) => {
      const row = readRecord.get(kind, id) as { data: string } | undefined;
      return row ? parseObject(row.data) : undefined;
    };
    for (const row of db
      .prepare('SELECT kind,id,octet_length(data) AS bytes FROM objects')
      .iterate() as Iterable<{ kind: string; id: string; bytes: number }>) {
      if (
        typeof row.kind !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(row.kind) ||
        typeof row.id !== 'string' ||
        row.id.length > 1024 ||
        !integerBetween(row.bytes, 2, MAX_OBJECT_BYTES)
      )
        reject('The archive database contains an unsupported or oversized saved record.');
      if (!Object.hasOwn(counts, row.kind) && Object.keys(counts).length >= 256)
        reject('The archive contains too many saved record types.', 413, 'data_archive_limit');
      counts[row.kind] = (counts[row.kind] ?? 0) + 1;
      const value = parseObject((readRecord.get(row.kind, row.id) as { data: string }).data);
      if (value.id !== row.id)
        reject('The archive database contains inconsistent record identifiers.');
      if (row.kind === 'settings' && row.id === 'main') {
        validateSettings(value, platform);
        settingsFound = true;
      }
      if (row.kind === 'bots' && value.browser !== undefined) {
        const browser = value.browser;
        if (
          !isRecord(browser) ||
          Object.keys(browser).some((key) => key !== 'mode') ||
          !['dedicated', 'shared', 'disabled'].includes(String(browser.mode))
        )
          reject('The archive contains invalid bot Chrome settings.');
      }
      if (row.kind === 'rooms' && value.paused !== undefined && typeof value.paused !== 'boolean')
        reject('The archive contains an invalid room pause state.');
      if (
        row.kind === 'tasks' &&
        value.scheduling !== undefined &&
        !isTaskScheduling(value.scheduling)
      )
        reject('The archive contains invalid task scheduling metadata.');
      if (
        row.kind === 'tasks' &&
        value.archivedAt !== undefined &&
        (typeof value.archivedAt !== 'string' ||
          value.archivedAt.length !== 24 ||
          !Number.isFinite(Date.parse(value.archivedAt)) ||
          new Date(value.archivedAt).toISOString() !== value.archivedAt)
      )
        reject('The archive contains an invalid task history timestamp.');
      if (
        row.kind === 'rooms' &&
        value.autonomousWakeups !== undefined &&
        !autonomousWakeupPolicySchema.safeParse(value.autonomousWakeups).success
      )
        reject('The archive contains an invalid autonomous wake-up policy.');
      if (
        row.kind === 'workItems' &&
        (!['active', 'paused', 'blocked', 'completed', 'cancelled'].includes(
          String(value.status),
        ) ||
          !['task', 'standing'].includes(String(value.kind)) ||
          !workCheckpointSchema.safeParse(value.checkpoint).success ||
          !integerBetween(value.revision, 1, Number.MAX_SAFE_INTEGER))
      )
        reject('The archive contains an invalid autonomous work item.');
      if (row.kind === 'wakeups') {
        try {
          normalizeSchedule(value.schedule);
        } catch {
          reject('The archive contains an invalid autonomous wake-up schedule.');
        }
      }
      if (row.kind === 'messages' && value.targetUser !== undefined) {
        if (
          typeof value.targetUser !== 'boolean' ||
          (value.targetUser &&
            (value.authorType !== 'bot' ||
              (value.targetBotIds !== undefined &&
                (!Array.isArray(value.targetBotIds) || value.targetBotIds.length > 0))))
        )
          reject('The archive contains an invalid user-directed message.');
      }
      validateNotificationMetadata(row.kind, value, readSavedRecord);
      validateImageMetadata(row.kind, value);
      validateTaskInputMetadata(row.kind, value, readSavedRecord);
      if (row.kind === 'taskInputs') {
        const taskId = value.taskId as string;
        const group = taskInputCounts.get(taskId) ?? {
          count: 0,
          pending: 0,
          sequences: new Set<number>(),
        };
        group.count++;
        if (value.status === 'pending') group.pending++;
        if (
          group.count > TASK_INPUT_TOTAL_LIMIT ||
          group.pending > TASK_INPUT_PENDING_LIMIT ||
          group.sequences.has(value.sequence as number)
        )
          reject('The archive contains invalid additional-instruction ordering or limits.');
        group.sequences.add(value.sequence as number);
        taskInputCounts.set(taskId, group);
      }
      if (['settings', 'rooms', 'tasks', 'workItems'].includes(row.kind)) {
        if (value.workspacePath !== undefined)
          addSourceRoot(workspaces, normalizedSource(value.workspacePath, platform), platform);
      }
      if (row.kind === 'automations' && value.enabled === true) enabledAutomations++;
      if (workspaces.size > DATA_TRANSFER_MAX_FILES)
        reject('The archive contains too many workspace roots.', 413, 'data_archive_limit');
    }
    if (!settingsFound) reject('The archive does not contain its main Loom settings.');
    const readSecret = db.prepare('SELECT value FROM secrets WHERE key=?');
    for (const row of db
      .prepare('SELECT key,octet_length(value) AS bytes FROM secrets')
      .iterate() as Iterable<{ key: string; bytes: number }>) {
      if (
        typeof row.key !== 'string' ||
        row.key.length > 1024 ||
        !integerBetween(row.bytes, 1, 1024 ** 2)
      )
        reject('The archive contains an invalid stored credential.');
      const value = (readSecret.get(row.key) as { value: string }).value;
      try {
        const parts = value.split('.');
        if (
          parts.length !== 3 ||
          parts.some((part) => Buffer.from(part, 'base64').toString('base64') !== part)
        )
          throw new Error();
        const [iv, tag, body] = parts.map((part) => Buffer.from(part, 'base64'));
        if (iv!.length !== 12 || tag!.length !== 16) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, iv!);
        decipher.setAuthTag(tag!);
        const plaintext = Buffer.concat([decipher.update(body!), decipher.final()]);
        plaintext.fill(0);
      } catch {
        reject('The archive encryption key cannot unlock its saved credentials.');
      }
    }
    return { counts, workspaces, enabledAutomations };
  } catch (error) {
    if (isRecord(error) && typeof error.statusCode === 'number') throw error;
    return reject('The archive database is unreadable or invalid.');
  } finally {
    db?.close();
    key.fill(0);
  }
}

interface SessionHeader {
  value: Record<string, unknown>;
  prefix: Buffer;
  bodyOffset: number;
}
async function readSessionHeader(filename: string): Promise<SessionHeader> {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) reject('A Pi session is not a regular file.');
    const buffer = Buffer.allocUnsafe(Math.min(stat.size, MAX_SESSION_HEADER_BYTES + 1));
    let used = 0,
      lineStart = 0;
    while (used <= MAX_SESSION_HEADER_BYTES) {
      const amount = Math.min(8192, buffer.length - used);
      const read = amount ? await handle.read(buffer, used, amount, used) : { bytesRead: 0 };
      used += read.bytesRead;
      const eof = read.bytesRead === 0 || used === stat.size;
      while (lineStart < used) {
        const newline = buffer.subarray(0, used).indexOf(10, lineStart);
        if (newline === -1 && !eof) break;
        const lineEnd = newline === -1 ? used : newline;
        const raw = buffer.subarray(lineStart, lineEnd);
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true })
            .decode(raw)
            .replace(/^\uFEFF/, '')
            .trim();
        } catch {
          reject('A Pi session has an invalid UTF-8 header.');
        }
        if (text) {
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch {
            reject('A Pi session has an invalid JSON header.');
          }
          if (
            !isRecord(value) ||
            value.type !== 'session' ||
            typeof value.cwd !== 'string' ||
            !integerBetween(value.version, 1, 3)
          )
            reject('A Pi session uses an invalid or unsupported header.');
          if (value.parentSession !== undefined && typeof value.parentSession !== 'string')
            reject('A Pi session has an invalid parent reference.');
          const prefix = Buffer.from(buffer.subarray(0, lineStart));
          return { value, prefix, bodyOffset: newline === -1 ? used : newline + 1 };
        }
        lineStart = newline === -1 ? used : newline + 1;
      }
      if (eof) break;
      if (used === buffer.length) break;
    }
    reject('A Pi session header is missing or exceeds the 1 MiB limit.');
  } finally {
    await handle.close();
  }
}
function isSession(entry: Entry): boolean {
  return (
    entry.type === 'file' &&
    entry.path.startsWith('data/sessions/') &&
    entry.path.endsWith('.jsonl')
  );
}
const rootBudgets = new WeakMap<Set<string>, { keys: Set<string>; bytes: number }>();
function addSourceRoot(roots: Set<string>, root: string, platform: string) {
  const normalized = normalizedSource(root, platform);
  let budget = rootBudgets.get(roots);
  if (!budget) {
    budget = { keys: new Set(), bytes: 0 };
    rootBudgets.set(roots, budget);
  }
  const key = sourceKey(normalized, platform);
  if (budget.keys.has(key)) return;
  budget.keys.add(key);
  roots.add(normalized);
  budget.bytes += Buffer.byteLength(normalized) + 4;
  if (roots.size > DATA_TRANSFER_MAX_FILES || budget.bytes > DATA_TRANSFER_MAX_MANIFEST_BYTES)
    reject(
      'The archive contains too many workspace roots or too much path metadata.',
      413,
      'data_archive_limit',
    );
}
async function collectSource(
  dataDir: string,
  archivePath: string,
  browserState?: DataTransferBrowserState,
) {
  const platform = process.platform;
  const rootStat = await lstat(dataDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    reject('Choose the actual Loom data directory, not a symbolic link.');
  const database = await inspectDatabase(dataDir, platform);
  const warnings = new WarningList();
  const entries: Entry[] = [];
  const files = new Map<string, SourceFile>();
  const collisionKeys = new Set<string>();
  let totalBytes = 0,
    metadataBytes = 0;
  const manifest: Manifest = {
    format: FORMAT_VERSION,
    version: VERSION,
    createdAt: new Date().toISOString(),
    platform,
    dataDir,
    workspaces: [],
    externalWorkspaces: [],
    entries,
    warnings: [],
    ...(browserState ? { browserState } : {}),
  };
  const addEntry = (entry: Entry) => {
    portablePath(entry.path);
    relativeDestination(entry.path);
    const key = portableKey(entry.path);
    if (collisionKeys.has(key))
      reject(`Two source paths would collide on another computer: ${safeLabel(entry.path)}.`);
    collisionKeys.add(key);
    entries.push(entry);
    totalBytes += entry.size;
    metadataBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (
      entries.length > DATA_TRANSFER_MAX_FILES ||
      totalBytes > DATA_TRANSFER_MAX_EXPANDED_BYTES ||
      metadataBytes > DATA_TRANSFER_MAX_MANIFEST_BYTES
    )
      reject(
        'The source data exceeds the transfer file count, metadata, or size limit.',
        413,
        'data_archive_limit',
      );
  };
  const walk = async (root: string, prefix: string, includeRoot: boolean) => {
    const stack: Array<{ source: string; virtual: string }> = [{ source: root, virtual: prefix }];
    let first = true;
    while (stack.length) {
      const item = stack.pop()!;
      const stat = await lstat(item.source);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        reject('A source directory changed while its archive was being prepared.');
      if (includeRoot || !first)
        addEntry({
          path: item.virtual,
          type: 'directory',
          size: 0,
          mode: stat.mode & 0o777,
          mtime: stat.mtimeMs,
        });
      first = false;
      const directory = await opendir(item.source);
      for await (const child of directory) {
        const filename = path.join(item.source, child.name);
        const virtual = `${item.virtual}/${child.name}`;
        // Exclude the entire owner-only transfer area, including our own archive,
        // even when a configured external workspace is an ancestor of dataDir.
        if (
          withinSource(path.join(dataDir, RESERVED), filename, platform) ||
          sourceKey(filename, platform) === sourceKey(archivePath, platform)
        )
          continue;
        if (prefix !== 'data' && sourceKey(filename, platform) === sourceKey(dataDir, platform)) {
          warnings.add(`Already included separately as Loom data: ${virtual}`);
          continue;
        }
        try {
          portablePath(virtual);
        } catch {
          warnings.add(`Excluded a path that is not portable across operating systems: ${virtual}`);
          continue;
        }
        const childStat = await lstat(filename);
        if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
          stack.push({ source: filename, virtual });
        } else if (childStat.isFile() && !childStat.isSymbolicLink()) {
          addEntry({
            path: virtual,
            type: 'file',
            size: childStat.size,
            mode: childStat.mode & 0o777,
            mtime: childStat.mtimeMs,
          });
          files.set(virtual, {
            filename,
            dev: childStat.dev,
            ino: childStat.ino,
            size: childStat.size,
            mtime: childStat.mtimeMs,
          });
        } else if (childStat.isSymbolicLink()) {
          const raw = await readlink(filename);
          const target = path.resolve(path.dirname(filename), raw);
          if (!withinSource(root, target, platform)) {
            warnings.add(`Excluded a symbolic link outside its storage root: ${virtual}`);
            continue;
          }
          const relative = path.relative(root, target).split(path.sep).join('/');
          addEntry({
            path: virtual,
            type: 'symlink',
            size: 0,
            mode: childStat.mode & 0o777,
            mtime: childStat.mtimeMs,
            target: relative ? `${prefix}/${relative}` : prefix,
          });
        } else warnings.add(`Excluded a device, socket, or other non-file entry: ${virtual}`);
      }
    }
  };
  await walk(dataDir, 'data', false);
  const roots = new Set<string>();
  for (const root of database.workspaces) addSourceRoot(roots, root, platform);
  for (const entry of entries) {
    if (!isSession(entry)) continue;
    const header = await readSessionHeader(files.get(entry.path)!.filename);
    addSourceRoot(roots, header.value.cwd as string, platform);
    if (header.value.parentSession !== undefined)
      normalizedSource(header.value.parentSession, platform);
  }
  manifest.workspaces = [...roots].sort();
  const external = manifest.workspaces.filter((root) => !withinSource(dataDir, root, platform));
  // Sort shallow roots first and copy each containing tree once. References to
  // nested workspaces retain their relative locations within that copied root.
  external.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const externalIndex = new SourceIndex(platform);
  for (const root of external) {
    if (externalIndex.match(root)) continue;
    const id = workspaceId(root, platform);
    manifest.externalWorkspaces.push({ sourcePath: root, id });
    externalIndex.add(root, `external/${id}`);
  }
  for (const root of manifest.externalWorkspaces) {
    const prefix = `external/${root.id}`;
    let stat;
    try {
      stat = await lstat(root.sourcePath);
    } catch (error) {
      if (!isRecord(error) || !['ENOENT', 'EACCES', 'EPERM'].includes(String(error.code)))
        throw error;
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      warnings.add(
        `Workspace content was unavailable or was a symbolic link; an empty destination folder will be created: ${root.sourcePath}`,
      );
      addEntry({
        path: prefix,
        type: 'directory',
        size: 0,
        mode: 0o700,
        mtime: Date.parse(manifest.createdAt),
      });
      continue;
    }
    await walk(root.sourcePath, prefix, true);
  }
  const byPath = new Map(
    entries.map((entry) => [platform === 'win32' ? portableKey(entry.path) : entry.path, entry]),
  );
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type !== 'symlink') continue;
    const target = byPath.get(platform === 'win32' ? portableKey(entry.target!) : entry.target!);
    if (!target || target.type === 'symlink') {
      warnings.add(`Excluded a dangling or chained symbolic link: ${entry.path}`);
      entries.splice(index, 1);
    } else entry.target = target.path;
  }
  if (
    entries.some((entry) => ['data/browser-profile', 'data/browser-profiles'].includes(entry.path))
  )
    warnings.add(
      'Dedicated Chrome profiles are included. Chrome logins may need to be renewed on another operating system or user account.',
    );
  warnings.add(
    'Host startup settings (.env), installed applications and models, existing-Chrome profiles, and external service data are not copied.',
  );
  warnings.add(
    'Imported automations are disabled and active tasks require an explicit resume. Keep only one copy running the same automations.',
  );
  manifest.warnings = warnings.finish();
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { manifest, files, database };
}
async function writeAll(handle: FileHandle, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw new Error('Could not write the transfer file.');
    offset += bytesWritten;
  }
}
function fileWriter(handle: FileHandle): Writable {
  // pipeline waits for stream close; an fs stream with autoClose:false can wait
  // forever while FileHandle.close waits for that same stream to release its fd.
  // Keep fd ownership here and give pipeline an ordinary resource-free Writable.
  return new Writable({
    highWaterMark: IO_BYTES,
    write(chunk: Buffer, _encoding, callback) {
      void writeAll(handle, chunk).then(() => callback(), callback);
    },
  });
}
async function* fileChunks(handle: FileHandle, start: number, end: number): AsyncGenerator<Buffer> {
  let position = start;
  while (position < end) {
    const chunk = Buffer.allocUnsafe(Math.min(IO_BYTES, end - position));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (!bytesRead) return;
    position += bytesRead;
    yield chunk.subarray(0, bytesRead);
  }
}
function summary(
  manifest: Manifest,
  database: DatabaseInfo,
  destinationRoot?: string,
): DataTransferSummary {
  return {
    version: manifest.version,
    createdAt: manifest.createdAt,
    platform: manifest.platform,
    counts: database.counts,
    fileCount: manifest.entries.filter((entry) => entry.type === 'file').length,
    totalBytes: manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
    workspaces: manifest.workspaces.map((sourcePath) => ({
      sourcePath,
      ...(destinationRoot
        ? { destinationPath: rebasedPath(sourcePath, manifest, destinationRoot) }
        : {}),
    })),
    warnings: manifest.warnings,
  };
}

/** Export only after the application and its dedicated Chrome have fully closed. */
export async function exportDataArchive(options: {
  dataDir: string;
  archivePath: string;
  password: string;
  browserState?: DataTransferBrowserState;
}): Promise<DataTransferSummary> {
  validateDataTransferPassword(options.password);
  const browserState = validateDataTransferBrowserState(options.browserState);
  const dataDir = path.resolve(options.dataDir),
    archivePath = path.resolve(options.archivePath);
  const { manifest, files, database } = await collectSource(dataDir, archivePath, browserState);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const expandedBytes =
    4 + manifestBytes.length + manifest.entries.reduce((sum, entry) => sum + entry.size, 0);
  if (
    manifestBytes.length > DATA_TRANSFER_MAX_MANIFEST_BYTES ||
    expandedBytes > DATA_TRANSFER_MAX_EXPANDED_BYTES
  )
    reject(
      'The source data or its manifest exceeds the transfer size limit.',
      413,
      'data_archive_limit',
    );
  // Do not publish an archive whose paths would collide after restoration.
  manifestFromBytes(manifestBytes);
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header);
  header.writeUInt32BE(FORMAT_VERSION, 8);
  randomBytes(16).copy(header, 12);
  randomBytes(12).copy(header, 28);
  const key = await deriveKey(options.password, header.subarray(12, 28));
  let output: FileHandle | undefined;
  let complete = false;
  try {
    output = await open(
      archivePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await writeAll(output, header);
    const cipher = createCipheriv('aes-256-gcm', key, header.subarray(28));
    cipher.setAAD(header);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(manifestBytes.length);
    async function* payload() {
      yield length;
      yield manifestBytes;
      for (const entry of manifest.entries) {
        if (entry.type !== 'file') continue;
        const source = files.get(entry.path)!;
        const handle = await open(
          source.filename,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const before = await handle.stat();
          if (
            !before.isFile() ||
            before.dev !== source.dev ||
            before.ino !== source.ino ||
            before.size !== source.size ||
            before.mtimeMs !== source.mtime
          )
            reject(
              `A file changed during export: ${safeLabel(entry.path)}. Stop writers and try again.`,
            );
          let read = 0;
          for await (const chunk of fileChunks(handle, 0, source.size)) {
            read += chunk.length;
            if (read > entry.size)
              reject('A source file grew during export. Stop writers and try again.');
            yield chunk;
          }
          const after = await handle.stat();
          if (read !== entry.size || after.size !== source.size || after.mtimeMs !== source.mtime)
            reject('A source file changed during export. Stop writers and try again.');
        } finally {
          await handle.close();
        }
      }
    }
    await pipeline(
      Readable.from(payload()),
      createGzip({ level: 6, chunkSize: IO_BYTES }),
      cipher,
      new ByteLimit(DATA_TRANSFER_MAX_ARCHIVE_BYTES - HEADER_BYTES - TAG_BYTES),
      fileWriter(output),
    );
    await writeAll(output, cipher.getAuthTag());
    await output.sync();
    complete = true;
    return summary(manifest, database);
  } finally {
    key.fill(0);
    await output?.close();
    if (output && !complete) await rm(archivePath, { force: true });
  }
}

function checkApplicationVersion(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value))
    reject('The archive has an invalid application version.');
  const source = value.split('.').map(Number),
    target = VERSION.split('.').map(Number);
  if (
    source[0] !== target[0] ||
    source[1]! > target[1]! ||
    (source[1] === target[1] && source[2]! > target[2]!)
  )
    reject(
      'This archive was created by an unsupported or newer Agent Loom version. Update Loom before importing it.',
    );
}
function manifestFromBytes(bytes: Buffer): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    reject('The archive manifest is not valid UTF-8 JSON.');
  }
  if (
    !isRecord(raw) ||
    !exactKeys(raw, [
      'format',
      'version',
      'createdAt',
      'platform',
      'dataDir',
      'workspaces',
      'externalWorkspaces',
      'entries',
      'warnings',
      'browserState',
    ]) ||
    raw.format !== FORMAT_VERSION ||
    typeof raw.platform !== 'string' ||
    !PLATFORMS.has(raw.platform) ||
    typeof raw.createdAt !== 'string' ||
    raw.createdAt.length > 40 ||
    !Number.isFinite(Date.parse(raw.createdAt))
  )
    reject('The archive manifest has an unsupported format.');
  checkApplicationVersion(raw.version);
  const platform = raw.platform;
  const dataDir = normalizedSource(raw.dataDir, platform);
  if (
    !Array.isArray(raw.workspaces) ||
    raw.workspaces.length > DATA_TRANSFER_MAX_FILES ||
    !Array.isArray(raw.externalWorkspaces) ||
    raw.externalWorkspaces.length > DATA_TRANSFER_MAX_FILES ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > DATA_TRANSFER_MAX_FILES
  )
    reject('The archive contains too many files or workspace roots.', 413, 'data_archive_limit');
  if (
    !Array.isArray(raw.warnings) ||
    raw.warnings.length > MAX_WARNINGS + 1 ||
    raw.warnings.some((warning) => typeof warning !== 'string' || warning.length > 1024)
  )
    reject('The archive contains invalid warnings.');
  const externalWorkspaces: ExternalWorkspace[] = [];
  const rootKeys = new Set<string>(),
    rootIds = new Set<string>();
  for (const value of raw.externalWorkspaces) {
    if (
      !isRecord(value) ||
      !exactKeys(value, ['sourcePath', 'id']) ||
      typeof value.id !== 'string' ||
      !/^[a-f0-9]{24}$/.test(value.id)
    )
      reject('The archive contains an invalid external workspace mapping.');
    const sourcePath = normalizedSource(value.sourcePath, platform);
    const key = sourceKey(sourcePath, platform);
    if (
      withinSource(dataDir, sourcePath, platform) ||
      rootKeys.has(key) ||
      rootIds.has(value.id) ||
      workspaceId(sourcePath, platform) !== value.id
    )
      reject('The archive contains a duplicate or inconsistent external workspace mapping.');
    rootKeys.add(key);
    rootIds.add(value.id);
    externalWorkspaces.push({ sourcePath, id: value.id });
  }
  const externalIndex = new SourceIndex(platform);
  for (const root of externalWorkspaces) externalIndex.add(root.sourcePath, root.id);
  for (const root of externalWorkspaces) {
    const parent = sourcePaths(platform).dirname(root.sourcePath);
    if (
      sourceKey(parent, platform) !== sourceKey(root.sourcePath, platform) &&
      externalIndex.match(parent)
    )
      reject('The archive contains overlapping external workspace roots.');
  }
  const manifest: Manifest = {
    format: FORMAT_VERSION,
    version: raw.version,
    createdAt: raw.createdAt,
    platform,
    dataDir,
    workspaces: [],
    externalWorkspaces,
    entries: [],
    warnings: raw.warnings as string[],
    ...(raw.browserState !== undefined
      ? { browserState: validateDataTransferBrowserState(raw.browserState) }
      : {}),
  };
  const workspaceKeys = new Set<string>();
  for (const value of raw.workspaces) {
    const workspace = normalizedSource(value, platform),
      key = sourceKey(workspace, platform);
    if (workspaceKeys.has(key)) reject('The archive contains duplicate workspace references.');
    workspaceKeys.add(key);
    const virtual = virtualPath(workspace, manifest);
    if (!virtual) reject('A workspace is missing its storage mapping.');
    relativeDestination(virtual);
    manifest.workspaces.push(workspace);
  }
  const byPath = new Map<string, Entry>();
  const destinations = new Map<
    string,
    { spelling: string; type: Entry['type']; explicit: boolean }
  >();
  let totalBytes = 4 + bytes.length;
  for (const rawEntry of raw.entries) {
    if (
      !isRecord(rawEntry) ||
      !exactKeys(rawEntry, ['path', 'type', 'size', 'mtime', 'mode', 'target'])
    )
      reject('The archive contains an invalid file entry.');
    portablePath(rawEntry.path);
    const virtual = rawEntry.path;
    if (
      virtual === 'data' ||
      (virtual.startsWith('external/') && !rootIds.has(virtual.split('/')[1]!))
    )
      reject('The archive contains an unknown or invalid storage root.');
    if (
      !['file', 'directory', 'symlink'].includes(String(rawEntry.type)) ||
      !integerBetween(rawEntry.size, 0, DATA_TRANSFER_MAX_EXPANDED_BYTES) ||
      !integerBetween(rawEntry.mode, 0, 0o777) ||
      !numberBetween(rawEntry.mtime, -8.64e15, 8.64e15)
    )
      reject('The archive contains invalid file metadata.');
    if (
      (rawEntry.type !== 'file' && rawEntry.size !== 0) ||
      (rawEntry.type === 'symlink'
        ? typeof rawEntry.target !== 'string'
        : rawEntry.target !== undefined)
    )
      reject('The archive contains an invalid file or symbolic link.');
    const entry = rawEntry as unknown as Entry;
    const key = portableKey(virtual);
    if (byPath.has(key)) reject('The archive contains duplicate or case-colliding paths.');
    byPath.set(key, entry);
    const relative = relativeDestination(virtual);
    const parts = relative.split('/');
    for (let index = 0; index < parts.length; index++) {
      const spelling = parts.slice(0, index + 1).join('/');
      const final = index === parts.length - 1;
      const existing = destinations.get(portableKey(spelling));
      if (existing) {
        if (
          existing.spelling !== spelling ||
          (final && (existing.explicit || entry.type !== 'directory')) ||
          existing.type !== 'directory'
        )
          reject('Archive paths collide with another file or imported workspace.');
        if (final) existing.explicit = true;
      } else
        destinations.set(portableKey(spelling), {
          spelling,
          type: final ? entry.type : 'directory',
          explicit: final,
        });
      // A malicious manifest can name many deep files without their directory
      // entries. Bound inferred parents too, before the later parent validation.
      if (destinations.size > DATA_TRANSFER_MAX_FILES + 1)
        reject(
          'The archive contains too many files or inferred parent directories.',
          413,
          'data_archive_limit',
        );
    }
    totalBytes += entry.size;
    if (totalBytes > DATA_TRANSFER_MAX_EXPANDED_BYTES)
      reject('The archive expands beyond the 4 GiB transfer limit.', 413, 'data_archive_limit');
    manifest.entries.push(entry);
  }
  for (const entry of manifest.entries) {
    let parent = path.posix.dirname(entry.path);
    while (parent !== 'data' && parent !== 'external') {
      const ancestor = byPath.get(portableKey(parent));
      if (!ancestor || ancestor.path !== parent || ancestor.type !== 'directory')
        reject('The archive contains a missing, ambiguous, or non-directory parent path.');
      parent = path.posix.dirname(parent);
    }
    if (entry.type === 'symlink') {
      portablePath(entry.target);
      relativeDestination(entry.target);
      const ownRoot = entry.path.startsWith('data/')
        ? 'data'
        : entry.path.split('/').slice(0, 2).join('/');
      if (entry.target !== ownRoot && !entry.target.startsWith(`${ownRoot}/`))
        reject('A symbolic link leaves its archive storage root.');
      const target = byPath.get(portableKey(entry.target));
      if (!target || target.path !== entry.target || target.type === 'symlink')
        reject('The archive contains a dangling or chained symbolic link.');
    }
  }
  for (const root of externalWorkspaces) {
    if (byPath.get(`external/${root.id}`)?.type !== 'directory')
      reject('An external workspace is missing its root directory.');
  }
  // Unavailable workspace roots are restored as empty directories. Count those
  // inferred directories before extraction too; entries alone do not bound them.
  for (const workspace of manifest.workspaces) {
    const virtual = virtualPath(workspace, manifest)!;
    const storagePath = canonicalVirtual(workspaceStoragePath(virtual, manifest), manifest);
    const relative = relativeDestination(storagePath);
    if (!relative) continue;
    const parts = relative.split('/');
    for (let index = 0; index < parts.length; index++) {
      const spelling = parts.slice(0, index + 1).join('/');
      const key = portableKey(spelling),
        existing = destinations.get(key);
      if (existing && (existing.spelling !== spelling || existing.type !== 'directory'))
        reject('A configured workspace collides with a non-directory or ambiguous path.');
      if (!existing) destinations.set(key, { spelling, type: 'directory', explicit: false });
      if (destinations.size > DATA_TRANSFER_MAX_FILES + 1)
        reject(
          'The archive contains too many files or inferred workspace directories.',
          413,
          'data_archive_limit',
        );
    }
  }
  if (
    byPath.get('data/loom.sqlite')?.type !== 'file' ||
    byPath.get('data/loom.sqlite')?.path !== 'data/loom.sqlite' ||
    byPath.get('data/secret.key')?.type !== 'file' ||
    byPath.get('data/secret.key')?.path !== 'data/secret.key' ||
    byPath.get('data/secret.key')?.size !== 32
  )
    reject('The archive must contain its database and original encryption key.');
  for (const name of ['loom.sqlite-wal', 'loom.sqlite-shm', 'loom.sqlite-journal']) {
    const entry = byPath.get(`data/${name}`);
    if (entry && entry.type !== 'file') reject('SQLite journal files cannot be symbolic links.');
  }
  return manifest;
}

class ArchiveReader {
  private chunk: Buffer = Buffer.alloc(0);
  private offset = 0;
  private done = false;
  constructor(private readonly input: AsyncIterator<Buffer>) {}
  async take(maximum: number): Promise<Buffer> {
    while (this.offset === this.chunk.length && !this.done) {
      const next = await this.input.next();
      if (next.done) {
        this.done = true;
        this.chunk = Buffer.alloc(0);
        this.offset = 0;
        break;
      }
      this.chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      this.offset = 0;
    }
    const length = Math.min(maximum, this.chunk.length - this.offset);
    const value = this.chunk.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  async bytes(length: number): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(length);
    let position = 0;
    while (position < length) {
      const chunk = await this.take(length - position);
      if (!chunk.length) reject('The archive ended before all of its data was present.');
      chunk.copy(buffer, position);
      position += chunk.length;
    }
    return buffer;
  }
  async file(handle: FileHandle, length: number) {
    let remaining = length;
    while (remaining) {
      const chunk = await this.take(Math.min(remaining, IO_BYTES));
      if (!chunk.length) reject('The archive ended before a file was complete.');
      await writeAll(handle, chunk);
      remaining -= chunk.length;
    }
  }
}
async function decryptArchive(archivePath: string, temporary: string, password: string) {
  const input = await open(archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: FileHandle | undefined, key: Buffer | undefined;
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size < HEADER_BYTES + TAG_BYTES + 1)
      reject('This is not a complete Agent Loom transfer archive.');
    if (stat.size > DATA_TRANSFER_MAX_ARCHIVE_BYTES)
      reject('The archive exceeds the 4 GiB transfer limit.', 413, 'data_archive_limit');
    const header = Buffer.alloc(HEADER_BYTES),
      tag = Buffer.alloc(TAG_BYTES);
    if (
      (await input.read(header, 0, header.length, 0)).bytesRead !== HEADER_BYTES ||
      (await input.read(tag, 0, tag.length, stat.size - TAG_BYTES)).bytesRead !== TAG_BYTES
    )
      reject('The archive header is incomplete.');
    if (!header.subarray(0, 8).equals(MAGIC) || header.readUInt32BE(8) !== FORMAT_VERSION)
      reject('This is not a supported Agent Loom transfer archive.');
    key = await deriveKey(password, header.subarray(12, 28));
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(28));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    output = await open(temporary, 'wx', 0o600);
    try {
      await pipeline(
        Readable.from(fileChunks(input, HEADER_BYTES, stat.size - TAG_BYTES)),
        decipher,
        new ByteLimit(DATA_TRANSFER_MAX_ARCHIVE_BYTES),
        fileWriter(output),
      );
    } catch (error) {
      if (isRecord(error) && error.statusCode === 413) throw error;
      reject(
        'The archive password is incorrect or the archive is damaged.',
        400,
        'archive_authentication_failed',
      );
    }
  } finally {
    key?.fill(0);
    await output?.close();
    await input.close();
  }
}
async function extractArchive(compressed: string, stagingDir: string): Promise<Manifest> {
  const output = new PassThrough({ highWaterMark: IO_BYTES });
  const decoded = pipeline(
    createReadStream(compressed, { highWaterMark: IO_BYTES }),
    createGunzip({ chunkSize: IO_BYTES }),
    new ByteLimit(DATA_TRANSFER_MAX_EXPANDED_BYTES),
    output,
  );
  // The reader controls backpressure and observes errors. Attach this handler now
  // so an early zlib error cannot become an unhandled rejected pipeline promise.
  void decoded.catch(() => {});
  try {
    const reader = new ArchiveReader(output[Symbol.asyncIterator]() as AsyncIterator<Buffer>);
    const manifestLength = (await reader.bytes(4)).readUInt32BE(0);
    if (!manifestLength || manifestLength > DATA_TRANSFER_MAX_MANIFEST_BYTES)
      reject('The archive manifest exceeds the 16 MiB transfer limit.', 413, 'data_archive_limit');
    const manifest = manifestFromBytes(await reader.bytes(manifestLength));
    for (const entry of manifest.entries) {
      if (entry.type === 'symlink') continue;
      const filename = destinationPath(stagingDir, entry.path);
      if (entry.type === 'directory') await mkdir(filename, { recursive: true, mode: 0o700 });
      else {
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        const handle = await open(
          filename,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          await reader.file(handle, entry.size);
        } finally {
          await handle.close();
        }
      }
    }
    if ((await reader.take(1)).length)
      reject('The archive contains unexpected trailing file data.');
    await decoded;
    return manifest;
  } catch (error) {
    output.destroy();
    await decoded.catch(() => {});
    if (isRecord(error) && typeof error.statusCode === 'number') throw error;
    reject('The archive compression or file data is damaged.');
  }
}
function rebaseDatabase(
  stagingDir: string,
  destinationDataDir: string,
  manifest: Manifest,
): number {
  const db = new DatabaseSync(path.join(stagingDir, 'loom.sqlite'), { allowExtension: false });
  try {
    // Validation was read-only. This is an isolated staging database, never the
    // live Store; consolidate journals before the eventual directory swap.
    db.exec(
      'PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=100; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE;',
    );
    const read = db.prepare('SELECT data FROM objects WHERE kind=? AND id=?');
    const write = db.prepare('UPDATE objects SET data=? WHERE kind=? AND id=?');
    let disabled = 0;
    for (const row of db
      .prepare(
        "SELECT kind,id FROM objects WHERE kind IN ('settings','rooms','tasks','automations','workItems')",
      )
      .iterate() as Iterable<{ kind: string; id: string }>) {
      const value = parseObject((read.get(row.kind, row.id) as { data: string }).data);
      let changed = false;
      if (row.kind === 'automations') {
        if (value.enabled === true) disabled++;
        value.enabled = false;
        delete value.nextRunAt;
        changed = true;
      } else if (value.workspacePath !== undefined) {
        value.workspacePath = rebasedPath(
          normalizedSource(value.workspacePath, manifest.platform),
          manifest,
          destinationDataDir,
        );
        changed = true;
      }
      if (row.kind === 'rooms' && value.autonomousWakeups !== undefined) {
        value.autonomousWakeups = {
          ...(value.autonomousWakeups as Record<string, unknown>),
          mode: 'off',
        };
        changed = true;
      }
      if (row.kind === 'tasks' && value.archivedAt && ACTIVE.has(value.status as Task['status'])) {
        // Keep active or recoverable work visible; startup retains the existing
        // interruption and paused-queue recovery rules for its execution state.
        delete value.archivedAt;
        changed = true;
      }
      if (row.kind === 'workItems') {
        if (!['completed', 'cancelled'].includes(String(value.status))) {
          value.status = 'paused';
          value.lastError =
            'Imported work is paused. Review the source instance and enable this room before resuming.';
          delete value.finishedByTaskId;
          delete value.reviewedAt;
        }
        value.revision = Number(value.revision) + 1;
        value.updatedAt = new Date().toISOString();
        changed = true;
      }
      if (changed) write.run(JSON.stringify(value), row.kind, row.id);
    }
    db.prepare("DELETE FROM objects WHERE kind='authSessions'").run();
    db.exec('COMMIT;');
    return disabled;
  } catch (error) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      /* No active transaction. */
    }
    if (isRecord(error) && typeof error.statusCode === 'number') throw error;
    reject('The staged database could not be prepared for this computer.');
  } finally {
    db.close();
  }
}
async function rebaseSession(
  filename: string,
  destinationDataDir: string,
  manifest: Manifest,
  warnings: WarningList,
) {
  const header = await readSessionHeader(filename);
  header.value.cwd = rebasedPath(
    normalizedSource(header.value.cwd, manifest.platform),
    manifest,
    destinationDataDir,
  );
  if (header.value.parentSession !== undefined) {
    const original = normalizedSource(header.value.parentSession, manifest.platform);
    const virtual = virtualPath(original, manifest);
    if (virtual) header.value.parentSession = destinationPath(destinationDataDir, virtual);
    else
      warnings.add(
        `A historical Pi parent session was outside the copied storage roots: ${original}`,
      );
  }
  const temporary = `${filename}.transfer-${randomUUID()}`;
  const output = await open(temporary, 'wx', 0o600);
  try {
    await writeAll(output, header.prefix);
    await writeAll(output, Buffer.from(JSON.stringify(header.value) + '\n'));
    await pipeline(
      createReadStream(filename, { start: header.bodyOffset, highWaterMark: IO_BYTES }),
      fileWriter(output),
    );
  } finally {
    await output.close();
  }
  await rename(temporary, filename);
}
async function finishMetadata(stagingDir: string, manifest: Manifest, warnings: WarningList) {
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  for (const entry of manifest.entries) {
    const filename = destinationPath(stagingDir, entry.path);
    if (entry.type === 'symlink') {
      const target = destinationPath(stagingDir, entry.target!);
      const targetEntry = byPath.get(entry.target!)!;
      try {
        await symlink(
          path.relative(path.dirname(filename), target) || '.',
          filename,
          targetEntry.type === 'directory' ? 'dir' : 'file',
        );
      } catch (error) {
        if (
          isRecord(error) &&
          ['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(String(error.code))
        )
          warnings.add(
            `A symbolic link could not be created on this computer and was excluded: ${entry.path}`,
          );
        else throw error;
      }
    }
  }
  // Files first, then deepest directories: creating children or rebasing JSONL
  // must not replace the mtimes used by Pi's most-recent-session selection.
  const ordered = manifest.entries
    .filter((entry) => entry.type !== 'symlink')
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'file' ? -1 : 1;
      return b.path.length - a.path.length;
    });
  for (const entry of ordered) {
    const filename = destinationPath(stagingDir, entry.path);
    try {
      // SQLite may legitimately remove its old WAL/journal during consolidation.
      await chmod(
        filename,
        entry.path === 'data/secret.key' || entry.path === 'data/loom.sqlite'
          ? 0o600
          : entry.mode | (entry.type === 'directory' ? 0o700 : 0o600),
      );
      await utimes(filename, entry.mtime / 1000, entry.mtime / 1000);
    } catch (error) {
      if (
        !isRecord(error) ||
        error.code !== 'ENOENT' ||
        !/^data\/loom\.sqlite-(?:wal|shm|journal)$/.test(entry.path)
      )
        throw error;
    }
  }
  await chmod(stagingDir, 0o700);
}
async function treeSize(root: string): Promise<{ fileCount: number; totalBytes: number }> {
  const directories = [root];
  let fileCount = 0,
    totalBytes = 0,
    entries = 0;
  while (directories.length) {
    const directory = await opendir(directories.pop()!);
    for await (const entry of directory) {
      if (++entries > DATA_TRANSFER_MAX_FILES)
        reject('The staged data exceeds the transfer file count limit.', 413, 'data_archive_limit');
      const filename = path.join(directory.path, entry.name);
      const stat = await lstat(filename);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) directories.push(filename);
      else if (stat.isFile()) {
        fileCount++;
        totalBytes += stat.size;
      }
      if (totalBytes > DATA_TRANSFER_MAX_EXPANDED_BYTES)
        reject('The staged data exceeds the 4 GiB transfer limit.', 413, 'data_archive_limit');
    }
  }
  return { fileCount, totalBytes };
}
function workspaceStoragePath(virtual: string, manifest: Manifest): string {
  const entries = manifestEntryIndex(manifest);
  const parts = virtual.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const ancestor = entries.get(portableKey(parts.slice(0, index).join('/')));
    if (ancestor?.type === 'symlink') {
      const remaining = parts.slice(index).join('/');
      // Links have already been validated as a single hop to a normal entry.
      return ancestor.target! + (remaining ? '/' + remaining : '');
    }
  }
  return virtual;
}

/** Authenticate, validate and prepare an isolated data tree. Never mutate the running destination. */
export async function importDataArchive(options: {
  archivePath: string;
  stagingDir: string;
  destinationDataDir: string;
  password: string;
}): Promise<DataTransferArchivePreview> {
  validateDataTransferPassword(options.password);
  const archivePath = path.resolve(options.archivePath),
    stagingDir = path.resolve(options.stagingDir),
    destinationDataDir = path.resolve(options.destinationDataDir);
  if (
    withinSource(stagingDir, destinationDataDir, process.platform) ||
    withinSource(stagingDir, archivePath, process.platform)
  )
    reject(
      'The staging directory must be separate from the destination data and uploaded archive.',
    );
  let prepared = false,
    temporaryDirectory: string | undefined;
  try {
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    const stat = await lstat(stagingDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(stagingDir)).length)
      reject('Choose an empty, private staging directory for this import.');
    await chmod(stagingDir, 0o700);
    prepared = true;
    temporaryDirectory = await mkdtemp(path.join(path.dirname(stagingDir), '.decrypt-'));
    await chmod(temporaryDirectory, 0o700);
    const compressed = path.join(temporaryDirectory, 'authenticated.gz');
    await decryptArchive(archivePath, compressed, options.password);
    const manifest = await extractArchive(compressed, stagingDir);
    const database = await inspectDatabase(stagingDir, manifest.platform);
    for (const root of database.workspaces) rebasedPath(root, manifest, destinationDataDir);
    const warnings = new WarningList();
    for (const warning of manifest.warnings) warnings.add(warning);
    for (const entry of manifest.entries) {
      if (isSession(entry))
        await rebaseSession(
          destinationPath(stagingDir, entry.path),
          destinationDataDir,
          manifest,
          warnings,
        );
    }
    for (const root of manifest.workspaces) {
      const virtual = virtualPath(root, manifest)!;
      const filename = destinationPath(
        stagingDir,
        canonicalVirtual(workspaceStoragePath(virtual, manifest), manifest),
      );
      try {
        const current = await lstat(filename);
        if (!current.isDirectory() || current.isSymbolicLink())
          reject('A configured workspace is not a regular directory in the archive.');
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error;
        await mkdir(filename, { recursive: true, mode: 0o700 });
        warnings.add(`An unavailable workspace was restored as an empty directory: ${root}`);
      }
    }
    const disabledAutomations = rebaseDatabase(stagingDir, destinationDataDir, manifest);
    delete database.counts.authSessions;
    warnings.add(
      'Source Loom login sessions are excluded. The destination keeps its own access settings.',
    );
    if (database.counts.workItems || database.counts.wakeups)
      warnings.add(
        'Autonomous wake-ups are disabled in imported rooms and unfinished work is paused. Stop the source copy before explicitly resuming this work.',
      );
    await finishMetadata(stagingDir, manifest, warnings);
    const actual = await treeSize(stagingDir);
    manifest.warnings = warnings.finish();
    return {
      ...summary(manifest, database, destinationDataDir),
      ...actual,
      disabledAutomations,
      ...(manifest.browserState ? { browserState: manifest.browserState } : {}),
    };
  } catch (error) {
    if (prepared) await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
