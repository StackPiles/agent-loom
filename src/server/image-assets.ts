import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { MAX_IMAGE_INPUT_LIMITS } from '../shared/image-inputs.js';

const HASH = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^img_[a-f0-9]{64}$/;
const ALIAS = /^img_[a-f0-9]{64}\.(?:png|jpg|webp)$/;
const MARKER_BYTES = 1024;
// The saved alias is briefly visible before its catalog/message transaction.
// Its inode timestamps cannot establish freshness because hard links share them.
const PUBLICATION_GRACE_MS = 5 * 60 * 1000;
const holds = new Map<string, Map<symbol, { imageId?: string; hash?: string }>>();
const publications = new Map<string, Map<string, number>>();

function codeIs(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function hardLinksUnavailable(error: unknown): boolean {
  return ['ENOTSUP', 'EPERM', 'EXDEV', 'EOPNOTSUPP', 'ENOSYS'].some((code) => codeIs(error, code));
}

function checkedHash(hash: string): string {
  if (!HASH.test(hash)) throw new Error('Invalid managed image content hash.');
  return hash;
}

function rootPath(dataDir: string, create = false): string {
  if (create) mkdirSync(dataDir, { recursive: true });
  return realpathSync.native(dataDir);
}

/** Trust only the selected root's OS aliases, never a descendant link. */
function ownedPath(root: string, parts: string[], createParents = false): string {
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (!codeIs(error, 'ENOENT')) throw error;
      if (index < parts.length - 1 && createParents) {
        mkdirSync(current, { mode: 0o700 });
        stat = lstatSync(current);
      } else return path.join(root, ...parts);
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
      throw new Error('A managed image storage path contains an unsafe link or directory.');
  }
  return current;
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].some((code) => codeIs(error, code))
    )
      throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function removeTemporary(filename: string): void {
  try {
    unlinkSync(filename);
  } catch (error) {
    if (!codeIs(error, 'ENOENT')) throw error;
  }
}

function sameContents(a: Stats, b: Stats): boolean {
  return (
    a.isFile() &&
    b.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function checkedRead(
  filename: string,
  bytes: number,
  hash?: string,
): { data: Buffer; stat: Stats } {
  let fd: number | undefined;
  try {
    const before = lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink())
      throw new Error('A managed image storage path contains an unsafe link or directory.');
    fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!sameContents(before, stat) || stat.size !== bytes)
      throw new Error('A saved conversation image is missing or has an unexpected size.');
    const data = Buffer.allocUnsafe(bytes);
    let offset = 0;
    while (offset < bytes) {
      const count = readSync(fd, data, offset, bytes - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (
      offset !== bytes ||
      !sameContents(stat, fstatSync(fd)) ||
      !sameContents(stat, lstatSync(filename))
    )
      throw new Error('A saved conversation image changed while it was being read.');
    if (hash && createHash('sha256').update(data).digest('hex') !== hash)
      throw new Error('A saved conversation image failed its integrity check.');
    return { data, stat };
  } catch (error) {
    if (codeIs(error, 'ENOENT'))
      throw new Error(
        'A saved conversation image is missing. Restore it from the Loom data backup.',
      );
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Bounded, integrity-checked original pixels. A true missing file still fails. */
export function readManagedImageAsset(dataDir: string, hash: string, bytes: number): Buffer {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_IMAGE_INPUT_LIMITS.maxImageBytes)
    throw new Error('Invalid managed image size.');
  const root = rootPath(dataDir);
  return checkedRead(
    ownedPath(root, ['sessions', 'assets', `${checkedHash(hash)}.bin`]),
    bytes,
    hash,
  ).data;
}

function markerPath(root: string, hash: string, create = false): string {
  return ownedPath(root, ['sessions', 'assets-retired', `${checkedHash(hash)}.json`], create);
}

/** Missing markers mean live data; malformed markers fail closed instead of hiding corruption. */
export function isImageAssetDeleted(dataDir: string, hash: string): boolean {
  const filename = markerPath(rootPath(dataDir), hash);
  let stat: Stats;
  try {
    stat = lstatSync(filename);
  } catch (error) {
    if (codeIs(error, 'ENOENT')) return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MARKER_BYTES)
    throw new Error('A managed image deletion marker is invalid.');
  const text = checkedRead(filename, stat.size).data.toString('utf8');
  let marker: unknown;
  try {
    marker = JSON.parse(text);
  } catch {
    throw new Error('A managed image deletion marker is invalid.');
  }
  const value = marker as { version?: unknown; hash?: unknown; deletedAt?: unknown } | null;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== 1 ||
    value.hash !== hash ||
    typeof value.deletedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.deletedAt))
  )
    throw new Error('A managed image deletion marker is invalid.');
  return true;
}

/** Commit the reason for future missing pixels before deleting any original. */
export function markImageAssetDeleted(dataDir: string, hash: string, deletedAt: string): void {
  if (typeof deletedAt !== 'string' || !Number.isFinite(Date.parse(deletedAt)))
    throw new Error('Invalid managed image deletion timestamp.');
  checkedHash(hash);
  const contents = JSON.stringify({ version: 1, hash, deletedAt }) + '\n';
  if (Buffer.byteLength(contents) > MARKER_BYTES)
    throw new Error('Invalid managed image deletion timestamp.');
  const root = rootPath(dataDir, true);
  if (isImageAssetDeleted(root, hash)) return;
  const filename = markerPath(root, hash, true);
  const temporary = ownedPath(root, ['sessions', 'assets-retired', `.${hash}.${randomUUID()}.tmp`]);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // All managed mutations are serialized in one Loom process. Recheck links
    // immediately before publishing the completed marker.
    markerPath(root, hash, true);
    renameSync(temporary, filename);
    syncDirectory(path.dirname(filename));
  } finally {
    if (fd !== undefined) closeSync(fd);
    removeTemporary(temporary);
  }
}

/** Call only after the exact original bytes have been verified and republished. */
export function restoreImageAsset(dataDir: string, hash: string): void {
  const root = rootPath(dataDir);
  if (!isImageAssetDeleted(root, hash)) return;
  unlinkSync(markerPath(root, hash));
  syncDirectory(path.join(root, 'sessions', 'assets-retired'));
}

export function retainManagedImage(
  dataDir: string,
  input: { imageId?: string; hash?: string },
): () => void {
  if (
    (!input.imageId && !input.hash) ||
    (input.imageId !== undefined && !IMAGE_ID.test(input.imageId)) ||
    (input.hash !== undefined && !HASH.test(input.hash))
  )
    throw new Error('Invalid managed image retention identity.');
  const root = rootPath(dataDir);
  let entries = holds.get(root);
  if (!entries) holds.set(root, (entries = new Map()));
  const key = Symbol('managed-image-reader');
  entries.set(key, { ...input });
  return () => {
    const current = holds.get(root);
    current?.delete(key);
    if (!current?.size) holds.delete(root);
  };
}

export function activeManagedImages(dataDir: string): {
  imageIds: Set<string>;
  hashes: Set<string>;
} {
  const root = rootPath(dataDir);
  const imageIds = new Set<string>();
  const hashes = new Set<string>();
  for (const entry of holds.get(root)?.values() ?? []) {
    if (entry.imageId) imageIds.add(entry.imageId);
    if (entry.hash) hashes.add(entry.hash);
  }
  const recent = publications.get(root);
  for (const [hash, until] of recent ?? []) {
    if (until > Date.now()) hashes.add(hash);
    else recent?.delete(hash);
  }
  if (!recent?.size) publications.delete(root);
  return { imageIds, hashes };
}

function published(root: string, hash: string): void {
  let recent = publications.get(root);
  if (!recent) publications.set(root, (recent = new Map()));
  recent.set(hash, Date.now() + PUBLICATION_GRACE_MS);
}

/** Synchronous publication keeps cleanup from interleaving between canonical data and its alias. */
export function persistManagedImageAsset(
  dataDir: string,
  data: Buffer,
  aliasFilename?: string,
  signal?: AbortSignal,
): { hash: string; assetPath: string } {
  signal?.throwIfAborted();
  if (!data.length || data.length > MAX_IMAGE_INPUT_LIMITS.maxImageBytes)
    throw new Error('Invalid managed image size.');
  if (aliasFilename !== undefined && !ALIAS.test(aliasFilename))
    throw new Error('Invalid managed image alias.');
  const root = rootPath(dataDir, true);
  const hash = createHash('sha256').update(data).digest('hex');
  const assetPath = ownedPath(root, ['sessions', 'assets', `${hash}.bin`], true);
  let exists = false;
  try {
    lstatSync(assetPath);
    exists = true;
  } catch (error) {
    if (!codeIs(error, 'ENOENT')) throw error;
  }
  if (exists) checkedRead(assetPath, data.length, hash);
  else {
    const temporary = ownedPath(root, ['sessions', 'assets', `.${hash}.${randomUUID()}.tmp`]);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, data);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      signal?.throwIfAborted();
      try {
        linkSync(temporary, assetPath);
      } catch (error) {
        if (codeIs(error, 'EEXIST')) checkedRead(assetPath, data.length, hash);
        else if (hardLinksUnavailable(error)) {
          ownedPath(root, ['sessions', 'assets', `${hash}.bin`], true);
          let found = false;
          try {
            lstatSync(assetPath);
            found = true;
          } catch (checkError) {
            if (!codeIs(checkError, 'ENOENT')) throw checkError;
          }
          if (found) checkedRead(assetPath, data.length, hash);
          else renameSync(temporary, assetPath);
        } else throw error;
      }
      syncDirectory(path.dirname(assetPath));
    } finally {
      if (fd !== undefined) closeSync(fd);
      removeTemporary(temporary);
    }
  }
  signal?.throwIfAborted();
  if (aliasFilename !== undefined) {
    const destination = ownedPath(root, ['generated-images', aliasFilename], true);
    let created = false;
    let complete = false;
    try {
      try {
        linkSync(assetPath, destination);
        created = true;
      } catch (error) {
        if (!hardLinksUnavailable(error)) throw error;
        copyFileSync(assetPath, destination, constants.COPYFILE_EXCL);
        created = true;
        const fd = openSync(destination, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      signal?.throwIfAborted();
      syncDirectory(path.dirname(destination));
      complete = true;
    } finally {
      if (created && !complete) removeTemporary(destination);
    }
  }
  restoreImageAsset(root, hash);
  published(root, hash);
  return { hash, assetPath };
}

/** Replace only an existing, verified alias. Unsupported filesystems keep their existing copy. */
export function consolidateManagedImageAlias(
  dataDir: string,
  aliasFilename: string,
  data: Buffer,
  signal?: AbortSignal,
): { hash: string; assetPath: string; linked: boolean } {
  if (!ALIAS.test(aliasFilename)) throw new Error('Invalid managed image alias.');
  if (!data.length || data.length > MAX_IMAGE_INPUT_LIMITS.maxImageBytes)
    throw new Error('Invalid managed image size.');
  signal?.throwIfAborted();
  const root = rootPath(dataDir);
  const hash = createHash('sha256').update(data).digest('hex');
  if (isImageAssetDeleted(root, hash))
    throw new Error('This image original was already removed by storage cleanup.');
  const alias = ownedPath(root, ['generated-images', aliasFilename]);
  checkedRead(alias, data.length, hash);
  const assetPath = ownedPath(root, ['sessions', 'assets', `${hash}.bin`], true);
  const probe = ownedPath(root, ['sessions', 'assets', `.${hash}.${randomUUID()}.tmp`]);
  try {
    try {
      linkSync(alias, probe);
    } catch (error) {
      if (hardLinksUnavailable(error)) return { hash, assetPath, linked: false };
      throw error;
    }
  } finally {
    removeTemporary(probe);
  }
  persistManagedImageAsset(root, data, undefined, signal);
  const source = checkedRead(alias, data.length, hash).stat;
  const original = lstatSync(assetPath);
  if (source.dev === original.dev && source.ino === original.ino)
    return { hash, assetPath, linked: false };
  const temporary = ownedPath(root, ['generated-images', `.${aliasFilename}.${randomUUID()}.tmp`]);
  try {
    linkSync(assetPath, temporary);
    signal?.throwIfAborted();
    const current = lstatSync(ownedPath(root, ['generated-images', aliasFilename]));
    if (!sameContents(source, current))
      throw new Error('The image changed before its storage could be consolidated.');
    renameSync(temporary, alias);
    syncDirectory(path.dirname(alias));
    published(root, hash);
    return { hash, assetPath, linked: true };
  } finally {
    removeTemporary(temporary);
  }
}
