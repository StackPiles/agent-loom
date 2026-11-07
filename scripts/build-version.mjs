import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

/** Capture the package's version only after the production build succeeds. */
export async function writeBuildVersion(root = projectRoot) {
  const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const version = metadata?.version;
  if (
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  )
    throw new Error('package.json must contain a valid version before building Agent Loom.');
  const output = resolve(root, 'dist', 'build-info.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ version }, null, 2)}\n`, 'utf8');
  return { version, output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await writeBuildVersion();
