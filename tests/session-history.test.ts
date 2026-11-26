import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  getCurrentTools,
  normalizeContext,
  toToolDeclaration,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import { SessionManager, convertToLlm } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import {
  compactSessionHistory,
  type SessionHistoryCompactionOptions,
} from '../src/server/runtime/session-history.js';
import { prepareReasoningContext } from '../src/server/runtime/reasoning-context.js';

const MIB = 1024 * 1024;
const model: Model<'openai-completions'> = {
  id: 'history-fixture',
  name: 'History fixture',
  api: 'openai-completions',
  provider: 'loom-local',
  baseUrl: 'http://fixture.invalid/v1',
  input: ['text'],
  reasoning: true,
  contextWindow: 262144,
  maxTokens: 65536,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function assistant(text: string, timestamp = Date.now() + 10_000): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: 'stop',
    timestamp,
    usage: {
      input: 2000,
      output: 2010,
      reasoning: 2000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 4010,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'loom-session-history-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessions = path.join(directory, 'sessions', 'bot', 'room');
  const cwd = path.join(directory, 'workspace');
  await mkdir(sessions, { recursive: true });
  await mkdir(cwd);
  const manager = SessionManager.create(cwd, sessions);
  const removedTool = toToolDeclaration({
    name: 'removed_tool',
    description: 'Old tool',
    parameters: Type.Object({}),
  });
  const keptTool = toToolDeclaration({
    name: 'kept_tool',
    description: 'Current tool',
    parameters: Type.Object({ key: Type.String() }),
  });
  manager.appendModelChange('older-provider', 'older-model');
  manager.appendThinkingLevelChange('medium');
  manager.appendMessage({
    role: 'system',
    content: 'Original exact instructions.',
    toolsAdded: [removedTool, keptTool],
    timestamp: 1,
  });
  const archivedId = manager.appendMessage({
    role: 'user',
    content: 'EXCLUDED_OLD_TOOL_LOG '.repeat(50_000),
    timestamp: 2,
  });
  manager.appendMessage(assistant('The old operation completed with receipt op-17.', 3));
  const oldCheckpoint = manager.appendCompaction(
    'EXCLUDED_OLD_SUMMARY '.repeat(20_000),
    null,
    100_000,
  );
  manager.appendMessage({ role: 'system', content: '', toolsRemoved: [removedTool], timestamp: 4 });
  const extensionId = manager.appendCustomEntry('fixture.extension', {
    version: 1,
    state: 'must survive',
  });
  const pendingId = manager.appendCustomMessageEntry(
    'loom.task_input.v1',
    'Pending owner correction, never submitted yet.',
    false,
    { version: 1, inputId: 'input-1', taskId: 'task-1', fingerprint: 'fixture' },
  );
  const firstKept = manager.appendMessage({
    role: 'user',
    content: 'Continue the current work exactly.',
    timestamp: 5,
  });
  manager.appendMessage(assistant('The current prefix stays intact.', 6));
  const checkpointId = manager.appendCompaction(
    'Exact existing summary. Operation op-17 is complete; do not repeat it.',
    firstKept,
    120_000,
    { readFiles: ['/work/evidence.txt'], custom: { preserve: true } },
    true,
  );
  const activeAssistantId = manager.appendMessage(
    assistant('The active answer and its usage stay byte-for-byte the same.'),
  );
  const filename = manager.getSessionFile()!;
  const options: SessionHistoryCompactionOptions = {
    sessionPath: filename,
    maxRecordBytes: 2 * MIB,
    maxWorkingBytes: 4 * MIB,
    minimumSavingsBytes: 64 * 1024,
  };
  return {
    directory,
    cwd,
    sessions,
    filename,
    manager,
    options,
    archivedId,
    oldCheckpoint,
    extensionId,
    pendingId,
    firstKept,
    checkpointId,
    activeAssistantId,
  };
}

function restoredTools(manager: SessionManager) {
  const systemMessages = manager
    .getBranch()
    .flatMap((entry) =>
      entry.type === 'message' && entry.message.role === 'system' ? [entry.message] : [],
    );
  return {
    tools: getCurrentTools(systemMessages),
    mentioned: [
      ...new Set(
        systemMessages
          .flatMap((message) => [...(message.toolsAdded ?? []), ...(message.toolsRemoved ?? [])])
          .map((tool) => tool.name),
      ),
    ].sort(),
  };
}

test('old large text and summaries leave live memory while canonical projection, identities, tool state and pending input stay exact', async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.filename);
  const header = JSON.parse(JSON.stringify(f.manager.getHeader()));
  const context = structuredClone(f.manager.buildSessionContext());
  const activeIds = f.manager
    .buildSessionProjection()
    .entries.filter((entry) => entry.messages.length)
    .map((entry) => entry.sourceEntry.id);
  const tools = restoredTools(f.manager);
  const pending = structuredClone(f.manager.getEntry(f.pendingId));
  const usage = structuredClone(f.manager.getEntry(f.activeAssistantId));
  const leafId = f.manager.getLeafId();
  const result = await compactSessionHistory({ ...f.options, expectedLeafId: leafId });
  assert.equal(result.changed, true, result.reason);
  assert.ok(result.backupPath?.endsWith('.bak'));
  assert.deepEqual(
    await readFile(result.backupPath!),
    original,
    'the complete old file is archived exactly',
  );
  assert.ok(result.residentBytes < 16 * 1024);
  assert.equal((await stat(f.filename)).size, result.residentBytes);
  f.manager.setSessionFile(f.filename);
  assert.deepEqual(f.manager.getHeader(), header);
  assert.equal(f.manager.getLeafId(), leafId);
  assert.equal(f.manager.getEntryCount(), result.entryCount);
  assert.equal(
    f.manager.getEntry(f.archivedId),
    undefined,
    'Pi actually unloads the excluded payload',
  );
  assert.equal(
    f.manager.getEntry(f.oldCheckpoint),
    undefined,
    'old summary is outside the working set',
  );
  assert.deepEqual(f.manager.buildSessionContext(), context);
  assert.deepEqual(
    f.manager
      .buildSessionProjection()
      .entries.filter((entry) => entry.messages.length)
      .map((entry) => entry.sourceEntry.id),
    activeIds,
  );
  assert.deepEqual(
    restoredTools(f.manager),
    tools,
    'removed tools must not become newly registered tools',
  );
  assert.deepEqual(f.manager.getEntry(f.pendingId), pending);
  assert.ok(f.manager.getEntry(f.extensionId));
  assert.deepEqual(f.manager.getEntry(f.activeAssistantId), usage);
  assert.equal(SessionManager.continueRecent(f.cwd, f.sessions).getSessionFile(), f.filename);
  const checkpoint = f.manager.getEntry(f.checkpointId);
  assert.equal(checkpoint?.type, 'compaction');
  if (checkpoint?.type === 'compaction') {
    assert.equal(
      checkpoint.summary,
      'Exact existing summary. Operation op-17 is complete; do not repeat it.',
    );
    assert.equal(checkpoint.firstKeptEntryId, f.firstKept);
  }
  const again = await compactSessionHistory(f.options);
  assert.equal(again.changed, false);
  assert.equal((await readdir(f.sessions)).filter((name) => name.endsWith('.bak')).length, 1);
});

test('active usage anchor and normalized provider input remain identical', async (t) => {
  const f = await fixture(t);
  const prepare = () => {
    const messages = convertToLlm(f.manager.buildSessionProjection().messages);
    return prepareReasoningContext(model, normalizeContext({ messages }), {
      branch: f.manager.getBranch(),
    });
  };
  const before = prepare();
  assert.equal((await compactSessionHistory(f.options)).changed, true);
  f.manager.setSessionFile(f.filename);
  assert.deepEqual(prepare(), before);
});

test('context edits and referenced old records survive without restoring omitted messages', async (t) => {
  const f = await fixture(t);
  f.manager.appendContextEdit(f.firstKept, { content: 'The owner corrected the current request.' });
  f.manager.appendContextEdit(f.pendingId, null);
  f.manager.appendLabelChange(f.archivedId, 'Keep this historical evidence');
  const before = structuredClone(f.manager.buildSessionContext());
  const result = await compactSessionHistory(f.options);
  assert.equal(result.changed, true, result.reason);
  f.manager.setSessionFile(f.filename);
  assert.deepEqual(f.manager.buildSessionContext(), before);
  assert.ok(
    f.manager.getEntry(f.archivedId),
    'label target is retained instead of becoming dangling',
  );
  assert.ok(f.manager.getEntry(f.pendingId));
  assert.equal(f.manager.getLabel(f.archivedId), 'Keep this historical evidence');
});

test('an interrupted multi-tool batch retains call identities and all completed receipts', async (t) => {
  const f = await fixture(t);
  const calls = assistant('');
  calls.stopReason = 'toolUse';
  calls.content = [
    { type: 'toolCall', id: 'call-issued', name: 'kept_tool', arguments: { key: 'first' } },
    { type: 'toolCall', id: 'call-pending', name: 'kept_tool', arguments: { key: 'second' } },
  ];
  f.manager.appendMessage(calls);
  f.manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'call-issued',
    toolName: 'kept_tool',
    content: [{ type: 'text', text: 'Completed external operation; receipt op-123.' }],
    isError: false,
    timestamp: Date.now() + 11_000,
  });
  const context = structuredClone(f.manager.buildSessionContext());
  assert.equal((await compactSessionHistory(f.options)).changed, true);
  f.manager.setSessionFile(f.filename);
  assert.deepEqual(f.manager.buildSessionContext(), context);
  assert.equal(
    f.manager.buildSessionContext().messages.filter((message) => message.role === 'toolResult')
      .length,
    1,
  );
});

test('repeated existing checkpoints keep the working file small and preserve complete durable evidence', async (t) => {
  const f = await fixture(t);
  for (let turn = 0; turn < 5; turn++) {
    if (turn) {
      f.manager.appendMessage({
        role: 'user',
        content: `OLD_ROUND_${turn} `.repeat(60_000),
        timestamp: Date.now() + turn,
      });
      f.manager.appendMessage(assistant(`Finished round ${turn}.`));
      const firstKept = f.manager.appendMessage({
        role: 'user',
        content: `Exact next request ${turn}`,
        timestamp: Date.now() + turn + 100,
      });
      f.manager.appendCompaction(`Exact checkpoint ${turn}`, firstKept, 90_000);
    }
    const before = structuredClone(f.manager.buildSessionContext());
    const original = await readFile(f.filename);
    const result = await compactSessionHistory(f.options);
    assert.equal(result.changed, true, result.reason);
    assert.deepEqual(await readFile(result.backupPath!), original);
    f.manager.setSessionFile(f.filename);
    assert.deepEqual(f.manager.buildSessionContext(), before);
    assert.ok(result.residentBytes < 20 * 1024);
  }
  assert.equal((await readdir(f.sessions)).filter((name) => name.endsWith('.bak')).length, 5);
});

test('a real Pi checkpoint retaining no earlier entries uses its own valid boundary ID', async (t) => {
  const f = await fixture(t);
  const checkpoint = f.manager.appendCompaction('Exact standalone checkpoint.', null, 150_000);
  const saved = f.manager.getEntry(checkpoint);
  assert.equal(saved?.type, 'compaction');
  if (saved?.type === 'compaction') assert.equal(saved.firstKeptEntryId, checkpoint);
  f.manager.appendMessage({
    role: 'user',
    content: 'Continue after that exact checkpoint.',
    timestamp: Date.now(),
  });
  const before = structuredClone(f.manager.buildSessionContext());
  assert.equal((await compactSessionHistory(f.options)).changed, true);
  f.manager.setSessionFile(f.filename);
  assert.deepEqual(f.manager.buildSessionContext(), before);
});

for (const kind of ['context_edit', 'label', 'branch_summary'] as const) {
  test(`a missing or oversized ${kind} reference cannot bypass bounded scanning`, async (t) => {
    const f = await fixture(t);
    const source = await readFile(f.filename, 'utf8');
    for (const target of ['missing', 'x'.repeat(MIB)]) {
      const entry = {
        type: kind,
        id: 'invalid-reference',
        parentId: f.manager.getLeafId(),
        timestamp: new Date().toISOString(),
        ...(kind === 'branch_summary'
          ? { fromId: target, summary: 'Preserve unknown evidence.' }
          : { targetId: target }),
        ...(kind === 'context_edit' ? { replacement: null } : {}),
        ...(kind === 'label' ? { label: 'unknown target' } : {}),
      };
      const changed = `${source}${JSON.stringify(entry)}\n`;
      await writeFile(f.filename, changed);
      const result = await compactSessionHistory(f.options);
      assert.equal(result.changed, false);
      assert.equal(await readFile(f.filename, 'utf8'), changed);
      assert.equal(
        (await readdir(f.sessions)).some((name) => name.endsWith('.bak')),
        false,
      );
    }
  });
}

test('history discovery ordering and the original fractional modification time are retained', async (t) => {
  const f = await fixture(t);
  await utimes(f.filename, 1767225600.654321, 1767225600.123456);
  const before = await stat(f.filename);
  const result = await compactSessionHistory(f.options);
  assert.equal(result.changed, true);
  const after = await stat(f.filename);
  assert.ok(Math.abs(after.mtimeMs - before.mtimeMs) < 0.01);
  assert.ok(Math.abs(after.atimeMs - before.atimeMs) < 0.01);
  assert.equal(SessionManager.continueRecent(f.cwd, f.sessions).getSessionFile(), f.filename);
});

for (const kind of ['entry', 'message-role', 'branch', 'checkpoint', 'v2', 'malformed'] as const) {
  test(`unsupported ${kind} history is preserved without a new archive`, async (t) => {
    const f = await fixture(t);
    const rows = (await readFile(f.filename, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (kind === 'entry') rows[4].type = 'future_semantic_entry';
    if (kind === 'message-role') rows[4].message.role = 'future_semantic_role';
    if (kind === 'branch') rows.at(-1).parentId = rows[3].id;
    if (kind === 'checkpoint')
      rows.findLast((row) => row.type === 'compaction').firstKeptEntryId = 'missing';
    if (kind === 'v2') rows[0].version = 2;
    const source =
      rows.map((row) => JSON.stringify(row)).join('\n') +
      (kind === 'malformed' ? '\n{broken\n' : '\n');
    await writeFile(f.filename, source);
    const result = await compactSessionHistory(f.options);
    assert.equal(result.changed, false);
    assert.equal(await readFile(f.filename, 'utf8'), source);
    assert.equal((await readdir(f.sessions)).filter((name) => name.endsWith('.bak')).length, 0);
  });
}

test('large current context, parsing limits and stale live leaf never discard information', async (t) => {
  const f = await fixture(t);
  const source = await readFile(f.filename);
  for (const overrides of [
    { maxRecordBytes: 128 },
    { maxWorkingBytes: 128 },
    { expectedLeafId: 'not-the-current-leaf' },
    { minimumSavingsBytes: 4 * MIB },
  ]) {
    const result = await compactSessionHistory({ ...f.options, ...overrides });
    assert.equal(result.changed, false);
    assert.deepEqual(await readFile(f.filename), source);
  }
  f.manager.appendMessage({
    role: 'user',
    content: 'Current data must stay'.repeat(50_000),
    timestamp: Date.now(),
  });
  const current = await readFile(f.filename);
  const result = await compactSessionHistory({ ...f.options, maxWorkingBytes: 64 * 1024 });
  assert.equal(result.changed, false);
  assert.deepEqual(await readFile(f.filename), current);
});

test('an already cancelled request leaves the original and directory untouched', async (t) => {
  const f = await fixture(t);
  const source = await readFile(f.filename);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(compactSessionHistory({ ...f.options, signal: abort.signal }), {
    name: 'AbortError',
  });
  assert.deepEqual(await readFile(f.filename), source);
  assert.deepEqual(await readdir(f.sessions), [path.basename(f.filename)]);
});

test('atomic replacement failure preserves exact original and a complete recoverable backup', async (t) => {
  const f = await fixture(t);
  const source = await readFile(f.filename);
  const mocked = t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('fixture replacement denied'), { code: 'EACCES' });
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(compactSessionHistory(f.options), /replacement denied/);
    assert.deepEqual(await readFile(f.filename), source);
    const backups = (await readdir(f.sessions)).filter((name) => name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.deepEqual(await readFile(path.join(f.sessions, backups[0])), source);
    assert.equal(
      (await readdir(f.sessions)).some((name) => name.endsWith('.tmp')),
      false,
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal((await compactSessionHistory(f.options)).changed, true, 'retry remains lossless');
});

test('unsupported hard links use an exact copied backup', async (t) => {
  const f = await fixture(t);
  const source = await readFile(f.filename);
  const mocked = t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('fixture no hard links'), { code: 'ENOTSUP' });
  });
  syncBuiltinESMExports();
  try {
    const result = await compactSessionHistory(f.options);
    assert.equal(result.changed, true);
    assert.deepEqual(await readFile(result.backupPath!), source);
    assert.notEqual((await stat(f.filename)).ino, (await stat(result.backupPath!)).ino);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('Windows backup synchronization opens a write-capable handle and refuses denied access before replacement', async (t) => {
  const f = await fixture(t);
  const denied = await fixture(t);
  const deniedSource = await readFile(denied.filename);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalOpen = fs.openSync;
  let flushedWithWriteAccess = 0;
  const mocked = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).endsWith('.bak')) {
      const flags = args[1];
      assert.equal(typeof flags, 'number');
      assert.ok((flags as number) & (fs.constants.O_RDWR | fs.constants.O_WRONLY));
      if (String(args[0]).startsWith(denied.filename))
        throw Object.assign(new Error('Backup write access denied.'), { code: 'EACCES' });
      flushedWithWriteAccess++;
    }
    return originalOpen(...args);
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  syncBuiltinESMExports();
  try {
    assert.equal((await compactSessionHistory(f.options)).changed, true);
    assert.equal(flushedWithWriteAccess, 1);
    await assert.rejects(compactSessionHistory(denied.options), /Backup write access denied/);
    assert.deepEqual(await readFile(denied.filename), deniedSource);
    assert.equal(
      (await readdir(denied.sessions)).some((name) => name.endsWith('.tmp')),
      false,
    );
  } finally {
    Object.defineProperty(process, 'platform', platform);
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('a source append after the initial snapshot is never overwritten', async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.filename);
  const originalStat = fs.lstatSync;
  let appended = false;
  const mocked = t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
    const result = originalStat(...args);
    if (String(args[0]) === f.filename && !appended) {
      appended = true;
      fs.appendFileSync(f.filename, '\n');
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(compactSessionHistory(f.options), /conversation changed/);
    assert.deepEqual(await readFile(f.filename), Buffer.concat([original, Buffer.from('\n')]));
    assert.equal(
      (await readdir(f.sessions)).some((name) => name.endsWith('.bak')),
      false,
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('cancellation during the streamed scan leaves every original byte intact', async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.filename);
  const controller = new AbortController();
  const originalCheck = controller.signal.throwIfAborted.bind(controller.signal);
  let checks = 0;
  t.mock.method(controller.signal, 'throwIfAborted', () => {
    if (++checks === 10) controller.abort();
    originalCheck();
  });
  await assert.rejects(compactSessionHistory({ ...f.options, signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.ok(checks >= 10);
  assert.deepEqual(await readFile(f.filename), original);
  assert.deepEqual(await readdir(f.sessions), [path.basename(f.filename)]);
});

test('cancelling a queued archival never unlocks a still-running predecessor', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const first = compactSessionHistory(f.options);
  const cancelled = compactSessionHistory({ ...f.options, signal: controller.signal });
  const third = compactSessionHistory(f.options);
  controller.abort();
  const results = await Promise.allSettled([first, cancelled, third]);
  assert.equal(results[0].status, 'fulfilled');
  if (results[0].status === 'fulfilled') assert.equal(results[0].value.changed, true);
  assert.equal(results[1].status, 'rejected');
  if (results[1].status === 'rejected') assert.equal(results[1].reason.name, 'AbortError');
  assert.equal(results[2].status, 'fulfilled');
  if (results[2].status === 'fulfilled') assert.equal(results[2].value.changed, false);
  assert.equal((await readdir(f.sessions)).filter((name) => name.endsWith('.bak')).length, 1);
});

test('a symbolic link cannot replace an unrelated history file', async (t) => {
  const f = await fixture(t);
  const linked = path.join(f.sessions, 'linked.jsonl');
  try {
    await symlink(f.filename, linked);
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM')
      return t.skip('symlink privilege unavailable');
    throw error;
  }
  await assert.rejects(
    compactSessionHistory({ ...f.options, sessionPath: linked }),
    /path is invalid/,
  );
});

test(
  'two large text histories are streamed and continued inside a 64 MiB heap',
  { timeout: 60_000 },
  () => {
    const child = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=64',
        '--max-semi-space-size=4',
        '--expose-gc',
        '--import',
        'tsx',
        fileURLToPath(new URL('./session-history-memory-fixture.mjs', import.meta.url)),
      ],
      { encoding: 'utf8', timeout: 55_000 },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout);
    assert.equal(result.histories.length, 2);
    for (const history of result.histories) {
      assert.ok(history.originalBytes > 48 * MIB);
      assert.ok(history.residentBytes < 16 * 1024);
      assert.equal(history.contextPreserved, true);
    }
  },
);
