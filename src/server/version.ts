import { readFileSync } from 'node:fs';

const source = new URL(import.meta.url).pathname.endsWith('.ts');
const metadataUrl = new URL(source ? '../../package.json' : '../build-info.json', import.meta.url);

function readVersion(): string {
  try {
    const metadata = JSON.parse(readFileSync(metadataUrl, 'utf8')) as { version?: unknown } | null;
    const version = metadata?.version;
    if (
      typeof version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
    )
      throw new Error('The version metadata does not contain a valid version.');
    return version;
  } catch (cause) {
    throw new Error(
      source
        ? 'Agent Loom could not read its version from package.json.'
        : 'Agent Loom build version metadata is missing or invalid. Run npm run build before starting the server.',
      { cause },
    );
  }
}

// Source execution uses the package version. Production uses metadata captured
// by the completed build, so a later git pull cannot relabel an older artifact.
export const VERSION = readVersion();
