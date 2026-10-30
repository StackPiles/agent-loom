import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import {
  createNativeFolderPicker,
  nativeFolderCommand,
  parseNativeFolderResult,
  runNativeFolderCommand,
  type NativeFolderCommand,
  type NativeFolderPicker,
  type NativeFolderResult,
} from '../src/server/native-folder.js';
import { WINDOWS_FOLDER_SCRIPT, MAC_FOLDER_SCRIPT } from '../src/server/native-folder-scripts.js';

const ok = (value: string | null): NativeFolderResult => ({
  code: 0,
  stdout: JSON.stringify({ path: value }),
  stderr: '',
});
const desktop = {
  platform: 'darwin' as const,
  env: {},
  inContainer: false,
  commandExists: () => true,
};
async function directory(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-picker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t: TestContext, folderPicker: NativeFolderPicker, apiToken?: string) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'loom-picker-api-'));
  const f = await createApp({
    dataDir,
    folderPicker,
    apiToken,
    scheduler: false,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  t.after(async () => {
    await f.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return f;
}

test('native command plans use standard folder dialogs and keep path data out of executable source', () => {
  const unusual = 'C:\\資料 "quoted"\\$(not-a-command) `literal`';
  const windows = nativeFolderCommand('win32', { SystemRoot: 'C:\\Windows' }, unusual, () => true)!;
  assert.equal(windows.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(windows.args.includes('-STA'));
  assert.ok(!windows.args.includes('-ExecutionPolicy'));
  assert.equal(
    Buffer.from(windows.args.at(-1)!, 'base64').toString('utf16le'),
    WINDOWS_FOLDER_SCRIPT,
  );
  assert.equal(windows.env.LOOM_FOLDER_PICKER_INITIAL_PATH, unusual);
  assert.equal(
    windows.args.some((arg) => arg.includes(unusual)),
    false,
  );
  assert.match(WINDOWS_FOLDER_SCRIPT, /FOS_PICKFOLDERS/);
  assert.doesNotMatch(WINDOWS_FOLDER_SCRIPT, /FolderBrowserDialog|BrowseForFolder/);
  const mac = nativeFolderCommand('darwin', {}, '/資料 "quoted"/$(literal)', () => true)!;
  assert.equal(mac.args[3], MAC_FOLDER_SCRIPT);
  assert.equal(mac.args[4], '/資料 "quoted"/$(literal)');
  const zenity = nativeFolderCommand(
    'linux',
    {},
    '/tmp/folder with spaces',
    (file) => file === '/usr/bin/zenity',
  )!;
  assert.ok(zenity.args.includes('--directory'));
  assert.ok(zenity.args.includes('--filename=/tmp/folder with spaces/'));
  const kde = nativeFolderCommand(
    'linux',
    {},
    '/tmp/project',
    (file) => file === '/usr/bin/kdialog',
  )!;
  assert.ok(kde.args.includes('--getexistingdirectory'));
  assert.equal(
    nativeFolderCommand('linux', {}, undefined, () => false),
    undefined,
  );
});

test('native picker reports headless, disabled and unsupported environments without launching a process', async () => {
  let calls = 0;
  const run = async () => {
    calls++;
    return ok(null);
  };
  const cases = [
    { ...desktop, inContainer: true, reason: 'headless' },
    { ...desktop, env: { SSH_CONNECTION: 'synthetic' }, reason: 'headless' },
    { ...desktop, env: { LOOM_NATIVE_PICKER: '0' }, reason: 'disabled' },
    { ...desktop, platform: 'linux' as const, reason: 'headless' },
    {
      ...desktop,
      platform: 'win32' as const,
      env: { SESSIONNAME: 'Services' },
      reason: 'headless',
    },
    { ...desktop, commandExists: () => false, reason: 'unsupported' },
  ];
  for (const value of cases) {
    const picker = createNativeFolderPicker({ ...value, run });
    assert.equal((await picker.status()).reason, value.reason);
    await assert.rejects(picker.select(), { statusCode: 409 });
    await picker.close();
  }
  assert.equal(calls, 0);
  const linux = createNativeFolderPicker({
    ...desktop,
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    run,
  });
  assert.equal((await linux.status()).available, true);
  await linux.close();
});

test('native response parsing preserves Unicode and spaces and distinguishes cancellation from failures', () => {
  const windows = nativeFolderCommand('win32', {}, undefined, () => true)!;
  const selected = 'C:\\資料と作業\\日本語 folder';
  assert.equal(
    parseNativeFolderResult(windows, {
      ...ok(selected),
      stdout: `\uFEFF${ok(selected).stdout}\r\n`,
    }),
    selected,
  );
  assert.equal(parseNativeFolderResult(windows, ok(null)), null);
  assert.throws(
    () => parseNativeFolderResult(windows, { code: 0, stdout: 'unexpected output', stderr: '' }),
    /invalid response/,
  );
  assert.throws(
    () => parseNativeFolderResult(windows, { code: 1, stdout: '', stderr: 'native error' }),
    /could not finish/,
  );
  const linux = nativeFolderCommand('linux', {}, undefined, () => true)!;
  assert.equal(
    parseNativeFolderResult(linux, { code: 0, stdout: '/tmp/資料 trailing \n', stderr: '' }),
    '/tmp/資料 trailing ',
  );
  assert.equal(parseNativeFolderResult(linux, { code: 1, stdout: '', stderr: '' }), null);
  assert.throws(
    () => parseNativeFolderResult(linux, { code: 1, stdout: '', stderr: 'Cannot open display' }),
    /could not finish/,
  );
  const mac = nativeFolderCommand('darwin', {}, undefined, () => true)!;
  assert.equal(
    parseNativeFolderResult(mac, { code: 1, stdout: '', stderr: 'execution error (-128)' }),
    null,
  );
});

test('native picker accepts only existing absolute directories and leaves cancellation unchanged', async (t) => {
  const root = await directory(t);
  const selected = path.join(root, '日本語 project');
  await mkdir(selected);
  const file = path.join(root, 'a-file.txt');
  await writeFile(file, 'not a directory');
  let result: string | null = selected;
  let captured: NativeFolderCommand | undefined;
  const picker = createNativeFolderPicker({
    ...desktop,
    run: async (command) => {
      captured = command;
      return ok(result);
    },
  });
  t.after(() => picker.close());
  const canonical = await realpath(selected);
  assert.equal(await picker.select(selected), canonical);
  assert.equal(captured?.args[4], canonical);
  for (const invalid of [
    file,
    path.join(root, 'missing'),
    'relative/path',
    `${root}\nextra`,
    `${root}\0extra`,
  ]) {
    result = invalid;
    await assert.rejects(picker.select(), /invalid folder path|no longer exists/);
  }
  result = null;
  assert.equal(await picker.select(), null);
  await assert.rejects(picker.select('invalid\0initial'), { statusCode: 400 });
  result = selected;
  assert.equal(await picker.select(path.join(root, 'removed-start')), canonical);
  assert.equal(captured?.args[4], '', 'A missing starting folder falls back to the OS default');
});

test('native picker serializes dialogs and releases the lock after cancellation, timeout and shutdown', async () => {
  let started!: () => void;
  let ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let count = 0;
  const picker = createNativeFolderPicker({
    ...desktop,
    run: async (_command, signal) => {
      count++;
      started();
      return new Promise<NativeFolderResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
    },
  });
  const abort = new AbortController();
  const first = picker.select(undefined, abort.signal);
  const firstRejected = assert.rejects(first, /cancel first/);
  await ready;
  await assert.rejects(picker.select(), { statusCode: 409 });
  abort.abort(new Error('cancel first'));
  await firstRejected;
  ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const second = picker.select();
  const secondRejected = assert.rejects(second, /shutting down/);
  await ready;
  await picker.close();
  await secondRejected;
  assert.equal(count, 2);
  assert.equal((await picker.status()).reason, 'disabled');
  await assert.rejects(picker.select(), { statusCode: 503 });
  const timeout = createNativeFolderPicker({
    ...desktop,
    timeoutMs: 20,
    run: async (_command, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
  });
  await assert.rejects(timeout.select(), { statusCode: 408 });
  await timeout.close();
});

test('native child process execution is abortable and bounds output', async () => {
  const command: NativeFolderCommand = {
    file: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    env: process.env,
    format: 'json',
    name: 'osascript',
  };
  const abort = new AbortController();
  const running = runNativeFolderCommand(command, abort.signal);
  const rejected = assert.rejects(running, /cancel actual child/);
  await delay(80);
  abort.abort(new Error('cancel actual child'));
  await rejected;
  await assert.rejects(
    runNativeFolderCommand(
      {
        ...command,
        args: ['-e', 'process.stdout.write("x".repeat(65536)); setInterval(() => {}, 1000)'],
      },
      AbortSignal.timeout(5_000),
    ),
    /too much output/,
  );
  await assert.rejects(
    runNativeFolderCommand(
      { ...command, file: path.join(tmpdir(), 'loom-no-such-native-dialog-program') },
      AbortSignal.timeout(5_000),
    ),
    /could not be started/,
  );
});

test('folder-picker routes require authentication and a direct local browser without mutating settings', async (t) => {
  let selected: string | null = path.join(tmpdir(), 'chosen-folder');
  let calls = 0,
    closes = 0;
  const picker: NativeFolderPicker = {
    status: async () => ({ available: true, platform: 'win32' }),
    select: async () => {
      calls++;
      return selected;
    },
    close: async () => {
      closes++;
    },
  };
  const token = 'synthetic-picker-access-token';
  const f = await fixture(t, picker, token);
  const before = f.store.settings().workspacePath;
  const headers = { host: 'localhost', authorization: `Bearer ${token}` };
  assert.equal(
    (
      await f.app.inject({
        method: 'GET',
        url: '/api/workspace-picker',
        headers: { host: 'localhost' },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (await f.app.inject({ method: 'GET', url: '/api/workspace-picker', headers })).json().available,
    true,
  );
  for (const extra of [
    { 'x-forwarded-for': '198.51.100.2' },
    { forwarded: 'for=198.51.100.2' },
    { 'x-forwarded-host': 'localhost' },
    { 'sec-fetch-site': 'cross-site' },
    { host: 'server.example' },
  ]) {
    const combined = { ...headers, ...extra };
    assert.equal(
      (
        await f.app.inject({ method: 'GET', url: '/api/workspace-picker', headers: combined })
      ).json().reason,
      'remote',
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/workspace-picker',
          headers: combined,
          payload: {},
        })
      ).statusCode,
      403,
    );
  }
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/workspace-picker',
        headers,
        remoteAddress: '198.51.100.2',
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/workspace-picker',
        headers: { ...headers, origin: 'https://other.example' },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/workspace-picker',
        headers,
        payload: { initialPath: 'bad\0path' },
      })
    ).statusCode,
    400,
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await f.app.inject({ method: 'POST', url: '/api/workspace-picker', headers, payload: {} })
    ).json().path,
    selected,
  );
  selected = null;
  assert.equal(
    (
      await f.app.inject({ method: 'POST', url: '/api/workspace-picker', headers, payload: {} })
    ).json().path,
    null,
  );
  assert.equal(f.store.settings().workspacePath, before);
  await f.app.close();
  assert.equal(closes, 1);
});

test('HTTP disconnect and application shutdown cancel an outstanding native selection', async (t) => {
  let started!: () => void;
  let ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled!: () => void;
  let stopped = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const picker = createNativeFolderPicker({
    ...desktop,
    run: async (_command, signal) => {
      started();
      return new Promise<NativeFolderResult>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            cancelled();
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  });
  const f = await fixture(t, picker);
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const address = f.app.server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/workspace-picker`;
  const abort = new AbortController();
  const first = fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: abort.signal,
  });
  const firstRejected = assert.rejects(first, /abort/i);
  await ready;
  abort.abort();
  await Promise.race([
    stopped,
    delay(3_000).then(() => {
      throw new Error('Disconnect did not cancel selection');
    }),
  ]);
  await firstRejected;
  ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  stopped = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const second = fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(5_000),
  }).then(
    (response) => response.status,
    () => 0,
  );
  await ready;
  await f.app.close();
  await stopped;
  assert.ok([0, 503].includes(await second));
});

test('host-native programs validate without displaying a graphical dialog on Windows and macOS', async (t) => {
  assert.match(WINDOWS_FOLDER_SCRIPT, /LOOM_FOLDER_PICKER_VALIDATE_ONLY/);
  assert.match(MAC_FOLDER_SCRIPT, /argv\[1\] === 'validate'/);
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  const initial = path.join(await directory(t), '日本語 folder');
  await mkdir(initial);
  const command = nativeFolderCommand(
    process.platform,
    { ...process.env, LOOM_FOLDER_PICKER_VALIDATE_ONLY: '1' },
    initial,
  );
  assert.ok(command, 'The standard Windows/macOS script host must be present');
  const result = await runNativeFolderCommand(command, AbortSignal.timeout(60_000));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parseNativeFolderResult(command, result), null);
});
