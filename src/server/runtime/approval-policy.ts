import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import type { ToolContext } from './contract.js';
import { isPublicAddress } from './network.js';
import { listWorkspace, workspacePath } from './workspace.js';
import { throwIfAborted } from './gate.js';

const DOCUMENT_EXTENSIONS = new Set(['.md', '.txt', '.csv', '.tsv']);
const MAX_AUTO_DOCUMENT_BYTES = 64 * 1024;
const CREDENTIAL_QUERY =
  /(?:api.?key|token|password|passwd|secret|authorization|credential|signature)/i;

function containsKnownSecret(value: unknown, secrets: readonly (string | undefined)[]): boolean {
  if (typeof value === 'string') {
    let decoded = value;
    try {
      decoded = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      // Malformed encoding does not hide the original string from inspection.
    }
    return secrets.some((secret) => secret && (value.includes(secret) || decoded.includes(secret)));
  }
  if (value && typeof value === 'object')
    return Object.values(value).some((item) => containsKnownSecret(item, secrets));
  return false;
}

/** Shared by initial approval and redirect validation; this does not perform DNS resolution. */
export function isAutomaticWebRead(
  input: string,
  secrets: readonly (string | undefined)[] = [],
): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  if ([...url.searchParams.keys()].some((key) => CREDENTIAL_QUERY.test(key))) return false;
  if (containsKnownSecret([input, url.pathname, url.hash, ...url.searchParams.values()], secrets))
    return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return !(
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (isIP(host) && !isPublicAddress(host))
  );
}

export interface AutomaticApproval {
  rule:
    'new_workspace_document' | 'public_web_read' | 'configured_web_search' | 'workspace_inspection';
  reason: string;
  inspection?: 'location' | 'listing' | 'node_version';
}

/** Exact inspections are interpreted internally; arbitrary shell syntax is never auto-run. */
function inspection(command: string): AutomaticApproval['inspection'] | undefined {
  const normalized = command.trim().replace(/ +/g, ' ');
  if (/^(?:pwd|Get-Location)$/i.test(normalized)) return 'location';
  if (/^(?:ls(?: -(?:a|l|la|al))?|dir|Get-ChildItem(?: -Name)?)$/i.test(normalized))
    return 'listing';
  if (/^node (?:--version|-v)$/.test(normalized)) return 'node_version';
  return undefined;
}

/** A conservative deterministic policy: no extra model request and no blanket shell grants. */
export async function automaticApproval(
  context: ToolContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<AutomaticApproval | undefined> {
  const secrets = Object.values(context.host.getSecrets());
  if (containsKnownSecret(args, secrets)) return undefined;

  if (toolName === 'write_file') {
    if (typeof args.path !== 'string' || typeof args.content !== 'string') return undefined;
    if (
      args.content.includes('\0') ||
      Buffer.byteLength(args.content, 'utf8') > MAX_AUTO_DOCUMENT_BYTES
    )
      return undefined;
    const resolved = await workspacePath(context.settings.workspacePath, args.path);
    const relative = path.relative(resolved.root, resolved.target);
    if (!relative || relative.split(/[\\/]/).some((part) => part.startsWith('.'))) return undefined;
    if (!DOCUMENT_EXTENSIONS.has(path.extname(relative).toLowerCase())) return undefined;
    try {
      await lstat(resolved.target);
      return undefined; // Replacing any existing file always needs the user's review.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return {
      rule: 'new_workspace_document',
      reason:
        'Create a new text document of at most 64 KiB inside the workspace. Existing files cannot be overwritten by this automatic approval.',
    };
  }

  if (toolName === 'run_command' && typeof args.command === 'string') {
    const kind = inspection(args.command);
    if (!kind) return undefined;
    return {
      rule: 'workspace_inspection',
      reason:
        'Perform this exact bounded read-only inspection with built-in workspace tools; no shell command is executed.',
      inspection: kind,
    };
  }

  if (toolName === 'web_fetch' && typeof args.url === 'string') {
    if (!isAutomaticWebRead(args.url, secrets)) return undefined;
    return {
      rule: 'public_web_read',
      reason:
        'Read a web page with the public-address restriction enforced for DNS resolution and every redirect.',
    };
  }

  if (toolName === 'web_search' && context.settings.search.provider !== 'none') {
    return {
      rule: 'configured_web_search',
      reason: 'Search using the provider configured by the workspace owner.',
    };
  }
  return undefined;
}

export async function runAutomaticInspection(
  approval: AutomaticApproval,
  context: ToolContext,
  signal: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  let output: string;
  switch (approval.inspection) {
    case 'location':
      output = (await workspacePath(context.settings.workspacePath)).root;
      break;
    case 'listing':
      output =
        (await listWorkspace(context.settings.workspacePath)).join('\n') || '(empty workspace)';
      break;
    case 'node_version':
      output = process.version;
      break;
    default:
      throw new Error('The operation is not a recognized automatic workspace inspection.');
  }
  throwIfAborted(signal);
  return `Exit code: 0\nRead-only inspection (bounded workspace tools; no shell execution).\n${output}`;
}
