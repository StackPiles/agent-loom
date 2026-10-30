import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { FolderPickerStatus } from '../shared/types.js';
import { WINDOWS_FOLDER_SCRIPT, MAC_FOLDER_SCRIPT } from './native-folder-scripts.js';

export interface NativeFolderPicker {
  status(): Promise<FolderPickerStatus>;
  select(initialPath?: string, signal?: AbortSignal): Promise<string | null>;
  close(): Promise<void>;
}
export interface NativeFolderCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  format: 'json' | 'line';
  name: 'powershell' | 'osascript' | 'zenity' | 'kdialog';
}
export interface NativeFolderResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
interface PickerOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  inContainer?: boolean;
  commandExists?: (file: string) => boolean;
  run?: (command: NativeFolderCommand, signal: AbortSignal) => Promise<NativeFolderResult>;
  timeoutMs?: number;
}
const failure = (message: string, statusCode = 422) =>
  Object.assign(new Error(message), { statusCode });
const invalidPath = /[\u0000-\u001f]/;
const TITLE = 'Agent Loom - Select workspace folder';

// A disconnected network share must not keep the HTTP request or shutdown waiting.
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

function executableExists(file: string): boolean {
  try {
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function nativeFolderCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  initialPath: string | undefined,
  commandExists: (file: string) => boolean = executableExists,
): NativeFolderCommand | undefined {
  if (platform === 'win32') {
    const windows = env.SystemRoot || env.WINDIR || 'C:\\Windows';
    const file = path.win32.join(
      windows,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    if (!commandExists(file)) return undefined;
    return {
      file,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-EncodedCommand',
        Buffer.from(WINDOWS_FOLDER_SCRIPT, 'utf16le').toString('base64'),
      ],
      env: { ...env, LOOM_FOLDER_PICKER_INITIAL_PATH: initialPath || '' },
      format: 'json',
      name: 'powershell',
    };
  }
  if (platform === 'darwin' && commandExists('/usr/bin/osascript'))
    return {
      file: '/usr/bin/osascript',
      args: [
        '-l',
        'JavaScript',
        '-e',
        MAC_FOLDER_SCRIPT,
        initialPath || '',
        env.LOOM_FOLDER_PICKER_VALIDATE_ONLY === '1' ? 'validate' : 'select',
      ],
      env: { ...env },
      format: 'json',
      name: 'osascript',
    };
  if (platform === 'linux') {
    for (const file of ['/usr/bin/zenity', '/bin/zenity']) {
      if (commandExists(file))
        return {
          file,
          args: [
            '--file-selection',
            '--directory',
            `--title=${TITLE}`,
            ...(initialPath ? [`--filename=${initialPath.replace(/\/$/, '')}/`] : []),
          ],
          env: { ...env },
          format: 'line',
          name: 'zenity',
        };
    }
    for (const file of ['/usr/bin/kdialog', '/bin/kdialog']) {
      if (commandExists(file))
        return {
          file,
          args: ['--title', TITLE, '--getexistingdirectory', initialPath || homedir()],
          env: { ...env },
          format: 'line',
          name: 'kdialog',
        };
    }
  }
  return undefined;
}

/** The child owns the native dialog; abort closes it before releasing the lock. */
export async function runNativeFolderCommand(
  command: NativeFolderCommand,
  signal: AbortSignal,
): Promise<NativeFolderResult> {
  if (signal.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      shell: false,
      windowsHide: true,
      env: command.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let bytes = 0,
      settled = false;
    let stopped: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, result?: NativeFolderResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(exitTimer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const stop = (error: Error) => {
      if (stopped || settled) return;
      stopped = error;
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      exitTimer = setTimeout(() => finish(stopped), 2_000);
    };
    const abort = () =>
      stop(
        signal.reason instanceof Error
          ? signal.reason
          : failure('Folder selection cancelled.', 499),
      );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32_768) stop(failure('The native folder dialog returned too much output.'));
      else target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', () => finish(failure('The native folder dialog could not be started.')));
    child.once('close', (code) =>
      finish(stopped, {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}

export function parseNativeFolderResult(
  command: NativeFolderCommand,
  result: NativeFolderResult,
): string | null {
  if (result.code !== 0) {
    if (command.format === 'line' && result.code === 1 && !result.stderr.trim()) return null;
    if (command.name === 'osascript' && /\(-128\)/.test(result.stderr)) return null;
    throw failure(
      `The OS folder dialog could not finish (${command.name}, exit ${result.code ?? 'signal'}). Check that Agent Loom is running in your desktop session.`,
    );
  }
  if (command.format === 'json') {
    try {
      return z
        .object({ path: z.string().nullable() })
        .parse(JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim())).path;
    } catch {
      throw failure('The native folder dialog returned an invalid response.');
    }
  }
  const selected = result.stdout.replace(/\r?\n$/, '');
  if (!selected) throw failure('The native folder dialog did not return a folder.');
  return selected;
}

export function createNativeFolderPicker(options: PickerOptions = {}): NativeFolderPicker {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const inContainer =
    options.inContainer ??
    (existsSync('/.dockerenv') || existsSync('/run/.containerenv') || Boolean(env.container));
  const commandExists = options.commandExists ?? executableExists;
  const run = options.run ?? runNativeFolderCommand;
  let closed = false;
  let active: { abort: AbortController; done: Promise<string | null> } | undefined;
  const unavailable = (
    reason: FolderPickerStatus['reason'],
    message: string,
  ): FolderPickerStatus => ({ available: false, platform, reason, message });
  const status = async (): Promise<FolderPickerStatus> => {
    if (closed || env.LOOM_NATIVE_PICKER === '0')
      return unavailable('disabled', 'Native folder selection is disabled on this server.');
    if (
      inContainer ||
      (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) ||
      env.SSH_CONNECTION ||
      env.SSH_TTY ||
      (platform === 'win32' && env.SESSIONNAME?.toLowerCase() === 'services')
    )
      return unavailable(
        'headless',
        'Native folder selection requires Agent Loom to run directly in your desktop session, outside Docker or SSH.',
      );
    if (!nativeFolderCommand(platform, env, undefined, commandExists))
      return unavailable(
        'unsupported',
        platform === 'linux'
          ? 'Install Zenity or KDialog in your desktop session to use native folder selection.'
          : 'A supported native folder dialog is not available on this system.',
      );
    return { available: true, platform };
  };
  const select = (initialPath?: string, signal?: AbortSignal): Promise<string | null> => {
    if (active)
      return Promise.reject(
        failure(
          'A folder selection dialog is already open. Finish or cancel it before opening another.',
          409,
        ),
      );
    if (closed) return Promise.reject(failure('The application is shutting down.', 503));
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal;
    const timer = setTimeout(
      () =>
        abort.abort(failure('Folder selection timed out. Open the chooser again when ready.', 408)),
      options.timeoutMs ?? 120_000,
    );
    const done = (async () => {
      const supported = await status();
      if (!supported.available)
        throw failure(supported.message || 'Native folder selection is unavailable.', 409);
      if (combined.aborted) throw combined.reason;
      let initial: string | undefined;
      if (initialPath) {
        if (invalidPath.test(initialPath) || initialPath.length > 2_000)
          throw failure('The starting folder path is invalid.', 400);
        if (
          path.isAbsolute(initialPath) &&
          (
            await abortable(
              stat(initialPath).catch(() => undefined),
              combined,
            )
          )?.isDirectory()
        )
          initial = await abortable(realpath(initialPath), combined);
      }
      if (combined.aborted) throw combined.reason;
      const command = nativeFolderCommand(platform, env, initial, commandExists);
      if (!command) throw failure('The native folder dialog is no longer available.', 409);
      const selected = parseNativeFolderResult(command, await run(command, combined));
      if (combined.aborted) throw combined.reason;
      if (selected === null) return null;
      if (!path.isAbsolute(selected) || invalidPath.test(selected) || selected.length > 2_000)
        throw failure('The chooser returned an invalid folder path.');
      const info = await abortable(
        stat(selected).catch(() => undefined),
        combined,
      );
      if (!info?.isDirectory())
        throw failure('The selected folder no longer exists or cannot be accessed.');
      const canonical = await abortable(realpath(selected), combined);
      if (combined.aborted) throw combined.reason;
      return canonical;
    })().finally(() => {
      clearTimeout(timer);
      active = undefined;
    });
    active = { abort, done };
    return done;
  };
  return {
    status,
    select,
    async close() {
      closed = true;
      const current = active;
      current?.abort.abort(failure('The application is shutting down.', 503));
      await current?.done.catch(() => {});
    },
  };
}

export function isLocalFolderPickerRequest(request: FastifyRequest): boolean {
  const host = request.headers.host?.toLowerCase() ?? '';
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) return false;
  const address = request.raw.socket.remoteAddress?.toLowerCase() ?? '';
  if (
    address !== '::1' &&
    !/^127(?:\.\d{1,3}){3}$/.test(address) &&
    !/^::ffff:127(?:\.\d{1,3}){3}$/.test(address)
  )
    return false;
  if (
    [
      'forwarded',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-real-ip',
      'via',
    ].some((name) => request.headers[name] !== undefined)
  )
    return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

export function registerWorkspacePickerRoutes(
  app: FastifyInstance,
  picker: NativeFolderPicker = createNativeFolderPicker(),
): void {
  const remote = (platform: string): FolderPickerStatus => ({
    available: false,
    platform,
    reason: 'remote',
    message:
      'Open Agent Loom through localhost on the same computer as its server to use the OS folder chooser. Remote browsers cannot choose a server folder through a local OS dialog.',
  });
  app.get('/api/workspace-picker', async (request) => {
    const current = await picker.status();
    return isLocalFolderPickerRequest(request) ? current : remote(current.platform);
  });
  app.post('/api/workspace-picker', async (request, reply) => {
    if (!isLocalFolderPickerRequest(request)) throw failure(remote(process.platform).message!, 403);
    const body = z
      .object({
        initialPath: z
          .string()
          .max(2_000)
          .refine((value) => !invalidPath.test(value), 'Invalid folder path')
          .optional(),
      })
      .parse(request.body ?? {});
    const abort = new AbortController();
    const cancel = () =>
      abort.abort(failure('The browser disconnected from folder selection.', 499));
    const close = () => {
      if (!reply.raw.writableEnded) cancel();
    };
    request.raw.once('aborted', cancel);
    reply.raw.once('close', close);
    try {
      return { path: await picker.select(body.initialPath, abort.signal) };
    } finally {
      request.raw.off('aborted', cancel);
      reply.raw.off('close', close);
    }
  });
  app.addHook('preClose', async () => picker.close());
}
