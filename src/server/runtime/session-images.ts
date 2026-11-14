import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { open, readdir, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message } from '@earendil-works/pi-ai';
import { MAX_IMAGE_INPUT_LIMITS } from '../../shared/image-inputs.js';

const REFERENCE_PREFIX = 'loom-image:v1:sha256:';
const REFERENCE = /^loom-image:v1:sha256:([a-f0-9]{64}):([1-9][0-9]*)$/;
const MAX_HEADER_BYTES = 1024 * 1024;
// One permitted image request plus its ordinary text/entry metadata. Do not
// allocate an unbounded string while migrating a damaged or unexpected file.
const MAX_ENTRY_BYTES = Math.ceil(MAX_IMAGE_INPUT_LIMITS.maxTotalBytes / 3) * 4 + 8 * 1024 * 1024;
const migrationLocks = new Map<string, Promise<void>>();

type RecordValue = Record<string, unknown>;
interface ImageReference {
  hash: string;
  bytes: number;
}

export interface PreparedSessionHistory {
  sessionPath?: string;
  /** Serialized, compact history bytes; the caller budgets object overhead. */
  residentBytes: number;
  /** All historical image bytes. Use estimateImageBytes for an active request. */
  imageBytes: number;
  migrated: boolean;
  backupPath?: string;
}

interface SessionHistoryLocation {
  sessionDirectory: string;
  cwd: string;
  signal?: AbortSignal;
}

function record(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function abort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function hardLinksUnavailable(error: unknown): boolean {
  return (
    record(error) &&
    ['ENOTSUP', 'EPERM', 'EXDEV', 'EOPNOTSUPP', 'ENOSYS'].includes(String(error.code))
  );
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch (error) {
    // Windows does not expose portable directory fsync through Node's fs API.
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

function reference(data: string): ImageReference | undefined {
  if (!data.startsWith('loom-image:')) return undefined;
  const match = REFERENCE.exec(data);
  const bytes = match ? Number(match[2]) : NaN;
  if (!match || !Number.isSafeInteger(bytes) || bytes > MAX_IMAGE_INPUT_LIMITS.maxImageBytes)
    throw new Error('A saved conversation contains an invalid image reference.');
  return { hash: match[1], bytes };
}

function imageParts(content: unknown): RecordValue[] {
  return Array.isArray(content)
    ? content.filter(
        (part): part is RecordValue =>
          record(part) && part.type === 'image' && typeof part.data === 'string',
      )
    : [];
}

function entryImages(entry: unknown): RecordValue[] {
  if (!record(entry)) return [];
  if (entry.type === 'message' && record(entry.message)) return imageParts(entry.message.content);
  if (entry.type === 'custom_message') return imageParts(entry.content);
  if (entry.type === 'context_edit' && record(entry.replacement))
    return imageParts(entry.replacement.content);
  return [];
}

function rawImageBytes(data: string): number {
  // Pi image parts contain raw base64. Never reinterpret arbitrary data URLs,
  // file paths, or a malformed stored reference as an image.
  if (!data.length || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new Error('A saved conversation contains invalid image data.');
  const bytes = Buffer.byteLength(data, 'base64');
  if (bytes < 1 || bytes > MAX_IMAGE_INPUT_LIMITS.maxImageBytes)
    throw new Error('A saved conversation image exceeds the supported image size.');
  return bytes;
}

function pathKey(value: string): string {
  const expanded = value.startsWith('file://')
    ? fileURLToPath(value)
    : value === '~'
      ? homedir()
      : value.startsWith(`~${path.sep}`) || value.startsWith('~/')
        ? path.join(homedir(), value.slice(2))
        : value;
  const absolute = path.resolve(expanded);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

async function wait(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  abort(signal);
  if (!signal) return promise;
  await new Promise<void>((resolve, reject) => {
    const cancelled = () => reject(signal.reason);
    signal.addEventListener('abort', cancelled, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled));
  });
}

async function serialize<T>(
  key: string,
  signal: AbortSignal | undefined,
  action: () => Promise<T>,
) {
  const previous = migrationLocks.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const held = new Promise<void>((resolve) => (unlock = resolve));
  const tail = previous.then(() => held);
  migrationLocks.set(key, tail);
  try {
    await wait(previous, signal);
    abort(signal);
    return await action();
  } finally {
    unlock();
    if (migrationLocks.get(key) === tail) {
      void tail.then(() => {
        if (migrationLocks.get(key) === tail) migrationLocks.delete(key);
      });
    }
  }
}

/** Yield physical lines without ever holding the complete session in memory. */
async function* physicalLines(
  filename: string,
  signal?: AbortSignal,
  maxRecordBytes = MAX_ENTRY_BYTES,
) {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const stream = handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: false });
  let pieces: Buffer[] = [];
  let size = 0;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('A conversation history is not a file.');
    for await (const chunk of stream) {
      abort(signal);
      const buffer = chunk as Buffer;
      let start = 0;
      while (start < buffer.length) {
        const newline = buffer.indexOf(10, start);
        const end = newline < 0 ? buffer.length : newline;
        const segment = buffer.subarray(start, end);
        size += segment.length;
        if (size > Math.min(MAX_ENTRY_BYTES, maxRecordBytes))
          throw new Error(
            'A conversation history entry is too large to migrate safely. The original history was preserved.',
          );
        pieces.push(segment);
        if (newline < 0) break;
        yield { bytes: Buffer.concat(pieces, size), newline: true };
        pieces = [];
        size = 0;
        start = newline + 1;
      }
    }
    if (size) yield { bytes: Buffer.concat(pieces, size), newline: false };
  } finally {
    stream.destroy();
    await handle.close();
  }
}

async function copyPrefix(
  filename: string,
  bytes: number,
  output: FileHandle,
  signal?: AbortSignal,
) {
  if (!bytes) return;
  const input = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, bytes));
    for (let offset = 0; offset < bytes;) {
      abort(signal);
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(buffer.length, bytes - offset),
        offset,
      );
      if (!bytesRead)
        throw new Error(
          'The conversation changed during image migration. Its original history was preserved.',
        );
      await output.writeFile(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await input.close();
  }
}

/**
 * Keep original pixels in managed files, never in Pi's long-lived entry array.
 * References stay portable when the complete Loom data directory is transferred.
 */
export function createSessionImageStore(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const inputRoot = path.resolve(dataDir);
  // Native realpath also expands Windows 8.3 names, matching fs.promises.realpath.
  const root = realpathSync.native(dataDir);
  const sessions = path.join(root, 'sessions');
  const assets = path.join(sessions, 'assets');

  // The selected data root may itself use an OS alias (/tmp on macOS or an
  // 8.3 name on Windows). Trust only that root; descendants still reject symlinks.
  const canonical = (filename: string): string => {
    const absolute = path.resolve(filename);
    const relative = path.relative(inputRoot, absolute);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? path.join(root, relative)
      : absolute;
  };

  const owned = (filename: string, directory = false): string => {
    const absolute = canonical(filename);
    const relative = path.relative(root, absolute);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error('A conversation storage path is outside the Loom data directory.');
    let current = root;
    const parts = relative.split(path.sep);
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      if (!existsSync(current)) {
        if (index < parts.length - 1 || directory) mkdirSync(current, { mode: 0o700 });
        else break;
      }
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || ((index < parts.length - 1 || directory) && !stat.isDirectory()))
        throw new Error('A conversation storage path contains an unsafe link or directory.');
    }
    return absolute;
  };
  owned(sessions, true);

  const assetPath = (ref: ImageReference) => owned(path.join(assets, `${ref.hash}.bin`));
  const readAsset = (ref: ImageReference): Buffer => {
    const filename = assetPath(ref);
    let fd: number | undefined;
    try {
      fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== ref.bytes)
        throw new Error('A saved conversation image is missing or has an unexpected size.');
      const data = Buffer.allocUnsafe(ref.bytes);
      let offset = 0;
      while (offset < data.length) {
        const count = readSync(fd, data, offset, data.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      const after = fstatSync(fd);
      if (
        offset !== data.length ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new Error('A saved conversation image changed while it was being read.');
      if (createHash('sha256').update(data).digest('hex') !== ref.hash)
        throw new Error('A saved conversation image failed its integrity check.');
      return data;
    } catch (error) {
      if (record(error) && error.code === 'ENOENT')
        throw new Error(
          'A saved conversation image is missing. Restore it from the Loom data backup.',
        );
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  const storeImage = (part: RecordValue): number => {
    const data = part.data as string;
    const existing = reference(data);
    if (existing) return existing.bytes;
    const bytes = rawImageBytes(data);
    const decoded = Buffer.from(data, 'base64');
    const hash = createHash('sha256').update(decoded).digest('hex');
    const ref = { hash, bytes };
    owned(assets, true);
    const filename = assetPath(ref);
    if (existsSync(filename)) {
      // A pre-existing filename alone must never cause the only pixels to be discarded.
      readAsset(ref);
    } else {
      const temporary = owned(path.join(assets, `.${hash}.${randomUUID()}.tmp`));
      let fd: number | undefined;
      try {
        fd = openSync(temporary, 'wx', 0o600);
        writeFileSync(fd, decoded);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        try {
          // Publish without replacing another writer's asset or a symlink.
          linkSync(temporary, filename);
        } catch (error) {
          if (record(error) && error.code === 'EEXIST') {
            readAsset(ref);
          } else if (hardLinksUnavailable(error)) {
            // Some data filesystems cannot create hard links. Stores are
            // synchronous, and Loom exclusively owns its data root, so another
            // Loom writer cannot interleave this check and same-directory rename.
            // Recheck every path component and never replace an existing asset.
            let destinationExists = false;
            try {
              const destination = lstatSync(assetPath(ref));
              if (destination.isSymbolicLink())
                throw new Error(
                  'A conversation storage path contains an unsafe link or directory.',
                );
              destinationExists = true;
            } catch (checkError) {
              if (!record(checkError) || checkError.code !== 'ENOENT') throw checkError;
            }
            if (destinationExists) readAsset(ref);
            else renameSync(temporary, filename);
          } else {
            throw error;
          }
        }
        syncDirectory(assets);
      } finally {
        if (fd !== undefined) closeSync(fd);
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
    // All agent-state/persistence references to this same image object shrink.
    part.data = `${REFERENCE_PREFIX}${hash}:${bytes}`;
    return bytes;
  };

  const externalizeMessageImages = (message: unknown): void => {
    if (!record(message)) return;
    for (const part of imageParts(message.content)) storeImage(part);
  };

  const estimateImageBytes = (messages: readonly unknown[]): number => {
    let bytes = 0;
    for (const message of messages) {
      if (!record(message)) continue;
      for (const part of imageParts(message.content)) {
        const data = part.data as string;
        bytes += reference(data)?.bytes ?? rawImageBytes(data);
        if (!Number.isSafeInteger(bytes)) throw new Error('Conversation image sizes are invalid.');
      }
    }
    return bytes;
  };

  const hydrateMessages = async <T extends Message>(
    messages: readonly T[],
    signal?: AbortSignal,
  ): Promise<T[]> => {
    const hydrated: T[] = [];
    for (const message of messages) {
      abort(signal);
      if (!Array.isArray(message.content)) {
        hydrated.push(message);
        continue;
      }
      let changed = false;
      const content = message.content.map((part) => {
        if (part.type !== 'image') return part;
        const ref = reference(part.data);
        if (!ref) return part;
        abort(signal);
        changed = true;
        return { ...part, data: readAsset(ref).toString('base64') };
      });
      hydrated.push(changed ? ({ ...message, content } as T) : message);
    }
    return hydrated;
  };

  const readHeader = (filename: string): RecordValue | undefined => {
    const fd = openSync(owned(filename), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!fstatSync(fd).isFile()) return undefined;
      const buffer = Buffer.allocUnsafe(MAX_HEADER_BYTES);
      let used = 0;
      let start = 0;
      while (used < buffer.length) {
        const count = readSync(fd, buffer, used, Math.min(4096, buffer.length - used), used);
        used += count;
        while (start < used) {
          const newline = buffer.subarray(0, used).indexOf(10, start);
          if (newline < 0 && count) break;
          const end = newline < 0 ? used : newline;
          const line = buffer.subarray(start, end).toString('utf8').trim();
          start = end + 1;
          if (!line) continue;
          try {
            const header: unknown = JSON.parse(line);
            return record(header) && header.type === 'session' && typeof header.id === 'string'
              ? header
              : undefined;
          } catch {
            // Pi also skips malformed lines while looking for the first parsed entry.
          }
        }
        if (!count) break;
      }
      return undefined;
    } finally {
      closeSync(fd);
    }
  };

  const checkedDirectory = (value: string): string => {
    const directory = canonical(value);
    const relative = path.relative(sessions, directory);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      relative.split(path.sep)[0] === 'assets'
    )
      throw new Error('The conversation session directory is invalid.');
    owned(directory, true);
    return directory;
  };

  const recentSession = async (options: SessionHistoryLocation) => {
    abort(options.signal);
    const directory = checkedDirectory(options.sessionDirectory);
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter((file) => file.name.endsWith('.jsonl'))
      .map((file) => {
        const filename = owned(path.join(directory, file.name));
        const stat = statSync(filename);
        if (!stat.isFile()) throw new Error('A conversation history is not a regular file.');
        return { filename, stat };
      })
      .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    return files.find(({ filename }) => {
      abort(options.signal);
      const header = readHeader(filename);
      return typeof header?.cwd === 'string' && pathKey(header.cwd) === pathKey(options.cwd);
    });
  };

  const inspectSessionHistory = async (
    options: SessionHistoryLocation,
  ): Promise<{ sessionPath?: string; sourceBytes: number }> => {
    const selected = await recentSession(options);
    return selected
      ? { sessionPath: selected.filename, sourceBytes: selected.stat.size }
      : { sourceBytes: 0 };
  };

  const prepareSessionHistory = async (
    options: SessionHistoryLocation & {
      /** Caller-owned transient budget, before JSON/string/object expansion. */
      maxRecordBytes?: number;
    },
  ): Promise<PreparedSessionHistory> => {
    const directory = checkedDirectory(options.sessionDirectory);
    if (
      options.maxRecordBytes !== undefined &&
      (!Number.isSafeInteger(options.maxRecordBytes) || options.maxRecordBytes < 1)
    )
      throw new Error('The conversation migration memory budget is invalid.');
    return serialize(pathKey(directory), options.signal, async () => {
      const chosen = await recentSession(options);
      if (!chosen) return { residentBytes: 0, imageBytes: 0, migrated: false };
      const { filename, stat: original } = chosen;
      const temporary = owned(path.join(directory, `.session-images-${randomUUID()}.tmp`));
      let output: FileHandle | undefined;
      let changed = false;
      let imageBytes = 0;
      let residentBytes = 0;
      let sourceOffset = 0;
      let backupPath: string | undefined;
      try {
        for await (const line of physicalLines(filename, options.signal, options.maxRecordBytes)) {
          abort(options.signal);
          let parsed: unknown;
          try {
            parsed = JSON.parse(line.bytes.toString('utf8'));
          } catch {
            // Preserve unknown/malformed records exactly; Pi decides their meaning.
          }
          let changedLine = false;
          for (const part of entryImages(parsed)) {
            const before = part.data;
            imageBytes += storeImage(part);
            if (part.data !== before) changedLine = true;
          }
          const bytes = changedLine ? Buffer.from(JSON.stringify(parsed)) : line.bytes;
          if (changedLine && !output) {
            output = await open(temporary, 'wx', original.mode & 0o777);
            await copyPrefix(filename, sourceOffset, output, options.signal);
          }
          if (output) {
            await output.writeFile(bytes);
            if (line.newline) await output.writeFile('\n');
          }
          residentBytes += bytes.length + Number(line.newline);
          sourceOffset += line.bytes.length + Number(line.newline);
          changed ||= changedLine;
        }
        if (output) {
          await output.sync();
          await output.close();
        }
        abort(options.signal);
        const current = lstatSync(owned(filename));
        if (
          current.dev !== original.dev ||
          current.ino !== original.ino ||
          current.size !== original.size ||
          current.mtimeMs !== original.mtimeMs ||
          current.ctimeMs !== original.ctimeMs
        )
          throw new Error(
            'The conversation changed during image migration. Its original history was preserved; retry the task.',
          );
        if (changed) {
          backupPath = owned(`${filename}.inline-images-v1-${randomUUID()}.bak`);
          try {
            linkSync(filename, backupPath);
          } catch (error) {
            if (!hardLinksUnavailable(error)) throw error;
            copyFileSync(filename, backupPath, constants.COPYFILE_EXCL);
          }
          // Windows FlushFileBuffers requires a write-capable handle. Never
          // chmod this backup: a hard link shares the original's permissions.
          // Denied write access must fail before the original is replaced.
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
          // Keep discovery's most-recent ordering unchanged by this migration.
          utimesSync(temporary, original.atimeMs / 1000, original.mtimeMs / 1000);
          abort(options.signal);
          renameSync(temporary, filename);
          syncDirectory(directory);
        }
        return {
          sessionPath: filename,
          residentBytes,
          imageBytes,
          migrated: changed,
          ...(backupPath ? { backupPath } : {}),
        };
      } finally {
        await output?.close().catch(() => undefined);
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    });
  };

  return {
    inspectSessionHistory,
    prepareSessionHistory,
    externalizeMessageImages,
    estimateImageBytes,
    hydrateMessages,
  };
}
