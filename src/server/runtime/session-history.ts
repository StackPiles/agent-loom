import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  utimesSync,
  type Stats,
} from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { buildSessionProjection, type SessionEntry } from '@earendil-works/pi-coding-agent';

type JsonRecord = Record<string, unknown>;

export interface SessionHistoryCompactionOptions {
  sessionPath: string;
  /** A physical JSONL record is checked before decoding or JSON.parse. */
  maxRecordBytes: number;
  /** Serialized retained entries plus the small, payload-free validation witness. */
  maxWorkingBytes: number;
  minimumSavingsBytes?: number;
  /** A live caller must have settled its run before handing over this leaf. */
  expectedLeafId?: string | null;
  signal?: AbortSignal;
}

export interface SessionHistoryCompactionResult {
  sessionPath: string;
  residentBytes: number;
  entryCount?: number;
  changed: boolean;
  backupPath?: string;
  reason?: string;
}

interface Scan {
  header: JsonRecord;
  entryCount: number;
  leafId: string | null;
  firstKeptIndex: number;
  checkpointIndex: number;
  referencedIds: Set<string>;
}

class CannotCompact extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const locks = new Map<string, Promise<void>>();
const entryTypes = new Set([
  'message',
  'thinking_level_change',
  'model_change',
  'usage',
  'compaction',
  'branch_summary',
  'custom',
  'label',
  'session_info',
  'custom_message',
  'context_edit',
]);
const messageRoles = new Set([
  'system',
  'user',
  'assistant',
  'toolResult',
  'custom',
  'bashExecution',
]);

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function entryId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function checkSignal(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function waitForPrevious(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  checkSignal(signal);
  if (!signal) return previous;
  await new Promise<void>((resolve, reject) => {
    const cancelled = () => reject(signal.reason);
    signal.addEventListener('abort', cancelled, { once: true });
    previous.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled));
  });
}

function unchanged(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function assertUnchanged(filename: string, original: Stats): void {
  const current = lstatSync(filename);
  if (!current.isFile() || current.isSymbolicLink() || !unchanged(original, current))
    throw new Error(
      'The conversation changed during history archival; retry at a settled boundary.',
    );
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !record(error) ||
      !['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes(String(error.code))
    )
      throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The old file is streamed. No historical text array or complete file string is built. */
async function* lines(filename: string, maxRecordBytes: number, signal?: AbortSignal) {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const stream = handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: false });
  let pieces: Buffer[] = [];
  let bytes = 0;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('A conversation history is not a file.');
    for await (const chunk of stream) {
      checkSignal(signal);
      const buffer = chunk as Buffer;
      let offset = 0;
      while (offset < buffer.length) {
        const newline = buffer.indexOf(10, offset);
        const end = newline < 0 ? buffer.length : newline;
        const part = buffer.subarray(offset, end);
        bytes += part.length;
        if (bytes > maxRecordBytes) throw new CannotCompact('record-limit');
        pieces.push(part);
        if (newline < 0) break;
        yield Buffer.concat(pieces, bytes);
        pieces = [];
        bytes = 0;
        offset = newline + 1;
      }
    }
    if (bytes) yield Buffer.concat(pieces, bytes);
  } finally {
    stream.destroy();
    await handle.close();
  }
}

function parseLine(bytes: Buffer): JsonRecord | undefined {
  const text = bytes.toString('utf8');
  if (!text.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Pi ignores malformed records, but archival must not make assumptions about them.
    throw new CannotCompact('unsupported-history');
  }
  if (!record(value)) throw new CannotCompact('unsupported-history');
  return value;
}

function validEntry(entry: JsonRecord): boolean {
  if (
    !entryTypes.has(String(entry.type)) ||
    !entryId(entry.id) ||
    (entry.parentId !== null && !entryId(entry.parentId)) ||
    typeof entry.timestamp !== 'string'
  )
    return false;
  switch (entry.type) {
    case 'message':
      return record(entry.message) && messageRoles.has(String(entry.message.role));
    case 'compaction':
      return (
        typeof entry.summary === 'string' &&
        entryId(entry.firstKeptEntryId) &&
        typeof entry.tokensBefore === 'number' &&
        Number.isFinite(entry.tokensBefore) &&
        (entry.systemMessage === undefined ||
          (record(entry.systemMessage) && entry.systemMessage.role === 'system'))
      );
    case 'thinking_level_change':
      return typeof entry.thinkingLevel === 'string';
    case 'model_change':
      return typeof entry.provider === 'string' && typeof entry.modelId === 'string';
    case 'context_edit':
      return (
        entryId(entry.targetId) &&
        (entry.replacement === null ||
          (record(entry.replacement) &&
            (typeof entry.replacement.content === 'string' ||
              Array.isArray(entry.replacement.content))))
      );
    case 'label':
      return entryId(entry.targetId);
    case 'custom':
    case 'custom_message':
      return typeof entry.customType === 'string';
    case 'branch_summary':
      return entryId(entry.fromId) && typeof entry.summary === 'string';
    default:
      return true;
  }
}

async function scanHistory(options: SessionHistoryCompactionOptions): Promise<Scan> {
  let header: JsonRecord | undefined;
  let leafId: string | null = null;
  const indexes = new Map<string, number>();
  const referencedIds = new Set<string>();
  let metadataBytes = 0;
  let firstKeptIndex = -1;
  let checkpointIndex = -1;
  for await (const bytes of lines(options.sessionPath, options.maxRecordBytes, options.signal)) {
    const entry = parseLine(bytes);
    if (!entry) continue;
    if (!header) {
      if (
        entry.type !== 'session' ||
        entry.version !== 3 ||
        typeof entry.id !== 'string' ||
        typeof entry.cwd !== 'string'
      )
        throw new CannotCompact('unsupported-history');
      header = entry;
      metadataBytes += bytes.length;
      continue;
    }
    if (!validEntry(entry)) throw new CannotCompact('unsupported-history');
    if (entry.parentId !== leafId || indexes.has(entry.id as string))
      throw new CannotCompact('nonlinear-history');
    const index = indexes.size;
    leafId = entry.id as string;
    indexes.set(leafId, index);
    // Bound even a history consisting of millions of tiny records. Bodies are not retained.
    metadataBytes += Buffer.byteLength(leafId) + 128;
    if (metadataBytes > options.maxWorkingBytes) throw new CannotCompact('working-limit');
    if (entry.type === 'compaction') {
      const kept = indexes.get(entry.firstKeptEntryId as string);
      if (kept === undefined) throw new CannotCompact('unsupported-checkpoint');
      firstKeptIndex = kept;
      checkpointIndex = index;
    }
    const targetId =
      entry.type === 'context_edit' || entry.type === 'label'
        ? (entry.targetId as string)
        : entry.type === 'branch_summary' && entry.fromId !== 'root'
          ? (entry.fromId as string)
          : undefined;
    if (targetId !== undefined) {
      const targetIndex = indexes.get(targetId);
      if (targetIndex === undefined || targetIndex >= index)
        throw new CannotCompact('unsupported-reference');
      if (!referencedIds.has(targetId)) {
        metadataBytes += Buffer.byteLength(targetId) + 128;
        if (metadataBytes > options.maxWorkingBytes) throw new CannotCompact('working-limit');
        referencedIds.add(targetId);
      }
    }
  }
  if (!header) throw new CannotCompact('unsupported-history');
  if (options.expectedLeafId !== undefined && options.expectedLeafId !== leafId)
    throw new CannotCompact('live-history-changed');
  if (checkpointIndex < 0) throw new CannotCompact('no-checkpoint');
  return {
    header,
    entryCount: indexes.size,
    leafId,
    firstKeptIndex,
    checkpointIndex,
    referencedIds,
  };
}

/**
 * Pi ignores these payloads before the newest retained range. Keeping their original
 * identities/links and assistant model fields supplies a bounded canonical projection
 * witness without loading the old bodies. All state/extension records remain complete.
 */
function excludedWitness(entry: JsonRecord): JsonRecord {
  const common = {
    type: entry.type,
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
  };
  if (entry.type === 'message') {
    const message = entry.message as JsonRecord;
    return {
      ...common,
      message: {
        role: message.role,
        ...(message.role === 'assistant'
          ? { provider: message.provider, model: message.model }
          : {}),
        content: [],
      },
    };
  }
  return { ...common, summary: '', tokensBefore: 0, firstKeptEntryId: entry.firstKeptEntryId };
}

function modelContext(entries: JsonRecord[]) {
  const projection = buildSessionProjection(entries as unknown as SessionEntry[]);
  return {
    messages: projection.messages,
    thinkingLevel: projection.thinkingLevel,
    model: projection.model,
  };
}

async function retainedHistory(options: SessionHistoryCompactionOptions, scan: Scan) {
  const witness: JsonRecord[] = [];
  const retained: { index: number; entry: JsonRecord }[] = [];
  let index = -1;
  let headerSeen = false;
  let chargedBytes = Buffer.byteLength(JSON.stringify(scan.header)) + 1;
  let prefixAssistant:
    { index: number; entry: JsonRecord; bytes: number; selected: boolean } | undefined;
  for await (const bytes of lines(options.sessionPath, options.maxRecordBytes, options.signal)) {
    const entry = parseLine(bytes);
    if (!entry) continue;
    if (!headerSeen) {
      headerSeen = true;
      if (!isDeepStrictEqual(entry, scan.header)) throw new CannotCompact('live-history-changed');
      continue;
    }
    index++;
    const message = record(entry.message) ? entry.message : undefined;
    const selected =
      index >= scan.firstKeptIndex ||
      (entry.type !== 'message' && entry.type !== 'compaction') ||
      (message !== undefined &&
        !['user', 'assistant', 'toolResult'].includes(String(message.role))) ||
      scan.referencedIds.has(entry.id as string);
    const evidence = selected ? entry : excludedWitness(entry);
    witness.push(evidence);
    if (selected) retained.push({ index, entry });
    chargedBytes += selected ? bytes.length + 1 : Buffer.byteLength(JSON.stringify(evidence)) + 1;
    if (index < scan.firstKeptIndex && message?.role === 'assistant')
      prefixAssistant = { index, entry, bytes: bytes.length + 1, selected };
    if (
      chargedBytes + (prefixAssistant && !prefixAssistant.selected ? prefixAssistant.bytes : 0) >
      options.maxWorkingBytes
    )
      throw new CannotCompact('working-limit');
  }
  if (index + 1 !== scan.entryCount || witness.at(-1)?.id !== scan.leafId)
    throw new CannotCompact('live-history-changed');
  // The effective model can come from an assistant rather than a model_change entry.
  // Keep that original entry, including its metadata, without inventing a new setting.
  if (prefixAssistant && !prefixAssistant.selected)
    retained.push({ index: prefixAssistant.index, entry: prefixAssistant.entry });
  retained.sort((left, right) => left.index - right.index);
  let parentId: string | null = null;
  const candidate = retained.map(({ entry }) => {
    const next = entry.parentId === parentId ? entry : { ...entry, parentId };
    parentId = entry.id as string;
    return next;
  });
  if (!isDeepStrictEqual(modelContext(witness), modelContext(candidate)))
    throw new CannotCompact('projection-mismatch');
  return candidate;
}

async function compact(
  options: SessionHistoryCompactionOptions,
): Promise<SessionHistoryCompactionResult> {
  const filename = options.sessionPath;
  checkSignal(options.signal);
  const original = lstatSync(filename);
  if (
    !original.isFile() ||
    original.isSymbolicLink() ||
    realpathSync.native(filename) !== filename ||
    !filename.endsWith('.jsonl')
  )
    throw new Error('The conversation history path is invalid.');
  const unchangedResult = (
    reason: string,
    entryCount?: number,
  ): SessionHistoryCompactionResult => ({
    sessionPath: filename,
    residentBytes: original.size,
    ...(entryCount !== undefined ? { entryCount } : {}),
    changed: false,
    reason,
  });
  const minimumSavingsBytes = options.minimumSavingsBytes ?? 256 * 1024;
  if (original.size <= minimumSavingsBytes) return unchangedResult('below-threshold');
  let scan: Scan;
  let entries: JsonRecord[];
  try {
    scan = await scanHistory(options);
    assertUnchanged(filename, original);
    entries = await retainedHistory(options, scan);
    assertUnchanged(filename, original);
  } catch (error) {
    if (error instanceof CannotCompact) {
      assertUnchanged(filename, original);
      return unchangedResult(error.reason);
    }
    throw error;
  }
  if (entries.length >= scan.entryCount)
    return unchangedResult('insufficient-savings', scan.entryCount);
  const directory = path.dirname(filename);
  const temporary = path.join(directory, `.session-history-${randomUUID()}.tmp`);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  let residentBytes = 0;
  try {
    output = await open(temporary, 'wx', original.mode & 0o777);
    for (const entry of [scan.header, ...entries]) {
      checkSignal(options.signal);
      const text = `${JSON.stringify(entry)}\n`;
      residentBytes += Buffer.byteLength(text);
      await output.writeFile(text);
    }
    if (original.size - residentBytes < minimumSavingsBytes)
      return unchangedResult('insufficient-savings', scan.entryCount);
    await output.sync();
    await output.close();
    output = undefined;
    checkSignal(options.signal);
    assertUnchanged(filename, original);
    const backupPath = `${filename}.history-v1-${randomUUID()}.bak`;
    // Publish the exact original backup before replacing the working file. This
    // synchronous final section cannot race an append from this process. A .bak
    // is included in transfer/dependency scans but never selected as a live session.
    try {
      linkSync(filename, backupPath);
    } catch (error) {
      if (
        !record(error) ||
        !['ENOTSUP', 'EPERM', 'EXDEV', 'EOPNOTSUPP', 'ENOSYS'].includes(String(error.code))
      )
        throw error;
      copyFileSync(filename, backupPath, constants.COPYFILE_EXCL);
    }
    const backupFd = openSync(
      backupPath,
      (process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY) |
        (constants.O_NOFOLLOW ?? 0),
    );
    try {
      fsyncSync(backupFd);
    } finally {
      closeSync(backupFd);
    }
    syncDirectory(directory);
    // A hard link changes ctime, so compare identity, size and mtime after backup.
    const backed = lstatSync(filename);
    if (
      backed.dev !== original.dev ||
      backed.ino !== original.ino ||
      backed.size !== original.size ||
      backed.mtimeMs !== original.mtimeMs
    )
      throw new Error('The conversation changed before history archival was published.');
    utimesSync(temporary, original.atimeMs / 1000, original.mtimeMs / 1000);
    renameSync(temporary, filename);
    syncDirectory(directory);
    return {
      sessionPath: filename,
      residentBytes,
      entryCount: entries.length,
      changed: true,
      backupPath,
    };
  } finally {
    await output?.close().catch(() => undefined);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/**
 * Move only context already excluded by a saved Pi compaction out of the working
 * JSONL. No text is summarized/truncated, and the complete original is archived.
 * Unsupported history is left untouched. Unexpected I/O/cancellation propagates.
 * A live caller must settle the complete run, hold its session ownership and a
 * temporary allowance, then reload the same SessionManager with setSessionFile.
 * Merely calling this function does not free an already-open manager's entries.
 */
export async function compactSessionHistory(
  options: SessionHistoryCompactionOptions,
): Promise<SessionHistoryCompactionResult> {
  for (const value of [options.maxRecordBytes, options.maxWorkingBytes])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error('Conversation history archival requires positive byte allowances.');
  if (
    options.minimumSavingsBytes !== undefined &&
    (!Number.isSafeInteger(options.minimumSavingsBytes) || options.minimumSavingsBytes < 0)
  )
    throw new Error('The conversation history savings threshold is invalid.');
  const filename = path.resolve(options.sessionPath);
  const previous = locks.get(filename) ?? Promise.resolve();
  let unlock!: () => void;
  const held = new Promise<void>((resolve) => (unlock = resolve));
  const tail = previous.then(() => held);
  locks.set(filename, tail);
  try {
    checkSignal(options.signal);
    await waitForPrevious(previous, options.signal);
    checkSignal(options.signal);
    return await compact({ ...options, sessionPath: filename });
  } finally {
    unlock();
    if (locks.get(filename) === tail)
      void tail.then(() => {
        if (locks.get(filename) === tail) locks.delete(filename);
      });
  }
}
