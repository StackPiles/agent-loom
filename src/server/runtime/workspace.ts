import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { throwIfAborted } from './gate.js';

const OMITTED_DIRECTORIES = new Set(['.git', 'node_modules', '.loom', '.ssh', '.aws', '.gnupg']);
const SENSITIVE_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|ed25519|ecdsa)|credentials(?:\.json)?|auth\.json|secrets?\.(?:json|key)|loom\.sqlite(?:-wal|-shm)?|.+\.(?:pem|p12|pfx))$/i;

function inside(root: string, destination: string): boolean {
  const relative = path.relative(root, destination);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function checkPrivatePath(relative: string): void {
  if (
    relative
      .split(path.sep)
      .some((part) => OMITTED_DIRECTORIES.has(part.toLowerCase()) || SENSITIVE_NAME.test(part))
  ) {
    throw new Error(
      'Credential files and private application directories are not available to file tools.',
    );
  }
}

/** Resolve every ancestor, reject secret paths and symlink escapes, including new files. */
export async function workspacePath(
  rootInput: string,
  userPath = '.',
  createParents = false,
): Promise<{ root: string; target: string }> {
  await mkdir(rootInput, { recursive: true });
  const root = await realpath(rootInput);
  if (userPath.includes('\0')) throw new Error('The path contains a NUL character.');
  const target = path.resolve(root, userPath);
  if (!inside(root, target)) throw new Error('This path is outside the configured workspace.');
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  checkPrivatePath(path.relative(root, target));
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    const next = path.join(current, parts[index]);
    try {
      const canonical = await realpath(next);
      if (!inside(root, canonical))
        throw new Error('The path follows a symlink outside the workspace.');
      checkPrivatePath(path.relative(root, canonical));
      current = canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (createParents && index < parts.length - 1) {
        await mkdir(next);
        current = await realpath(next);
        if (!inside(root, current)) throw new Error('Workspace path changed during resolution.');
      } else current = next;
    }
  }
  return { root, target: current };
}

export async function readWorkspaceFile(
  root: string,
  name: string,
  offset = 1,
  limit = 300,
): Promise<string> {
  const { target } = await workspacePath(root, name);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('The path is not a regular file.');
    if (stat.size > 1_000_000) throw new Error('File exceeds the 1 MB text reading limit.');
    const content = await handle.readFile('utf8');
    if (content.includes('\0')) throw new Error('Binary files are not supported by read_file.');
    const lines = content.split('\n');
    const start = Math.max(0, offset - 1);
    const selected = lines.slice(start, start + Math.min(500, Math.max(1, limit)));
    return `${name} (${lines.length} lines)\n${selected.map((line, index) => `${start + index + 1}: ${line}`).join('\n')}`.slice(
      0,
      32_000,
    );
  } finally {
    await handle.close();
  }
}

export async function listWorkspace(root: string, name = '.'): Promise<string[]> {
  const { target } = await workspacePath(root, name);
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        !OMITTED_DIRECTORIES.has(entry.name.toLowerCase()) && !SENSITIVE_NAME.test(entry.name),
    )
    .sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    )
    .slice(0, 400)
    .map(
      (entry) =>
        `${entry.name}${entry.isDirectory() ? '/' : entry.isSymbolicLink() ? ' [symlink]' : ''}`,
    );
}

export async function searchWorkspace(
  rootInput: string,
  query: string,
  directory = '.',
  signal?: AbortSignal,
): Promise<string> {
  if (!query.trim()) throw new Error('Search text must not be empty.');
  const { root, target } = await workspacePath(rootInput, directory);
  const matches: string[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || visited >= 500 || matches.length >= 60) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      throwIfAborted(signal);
      if (visited >= 500 || matches.length >= 60) break;
      if (
        OMITTED_DIRECTORIES.has(entry.name.toLowerCase()) ||
        SENSITIVE_NAME.test(entry.name) ||
        entry.isSymbolicLink()
      )
        continue;
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(filename, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      visited++;
      try {
        const stat = await lstat(filename);
        if (stat.size > 200_000) continue;
        const result = await readWorkspaceFile(root, path.relative(root, filename), 1, 500);
        for (const line of result.split('\n').slice(1)) {
          if (line.toLowerCase().includes(query.toLowerCase()))
            matches.push(`${path.relative(root, filename)}:${line.slice(0, 400)}`);
          if (matches.length >= 60) break;
        }
      } catch {
        /* Unreadable, binary or concurrently removed files are skipped. */
      }
    }
  };
  await walk(target, 0);
  return `${matches.length ? matches.join('\n') : 'No matching text found.'}\nScanned ${visited} files (limits: 500 files, 8 directories deep, first 500 lines/file, 60 matches).`;
}

export async function writeWorkspaceFile(
  rootInput: string,
  name: string,
  content: string,
  options: { createOnly?: boolean } = {},
): Promise<string> {
  if (Buffer.byteLength(content, 'utf8') > 1_000_000)
    throw new Error('Write exceeds the 1 MB file limit.');
  const { root, target } = await workspacePath(rootInput, name, true);
  if (root === target) throw new Error('A file name is required.');
  const parent = await realpath(path.dirname(target));
  if (!inside(root, parent)) throw new Error('The parent directory left the workspace.');
  const temporary = path.join(parent, `.loom-write-${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Recheck immediately before committing. Writes replace a symlink itself, never its target.
    if ((await realpath(parent)) !== parent)
      throw new Error('The parent directory changed during writing.');
    // Hard-linking the completed temporary file is atomic and fails if the target
    // appeared after policy evaluation. Smart approval must never become overwrite approval.
    if (options.createOnly) await link(temporary, target);
    else await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${path.relative(root, target)}.`;
}
