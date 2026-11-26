// Invoked with a deliberately small heap by session-history.test.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionManager, buildSessionProjection } from '@earendil-works/pi-coding-agent';
import { compactSessionHistory } from '../src/server/runtime/session-history.ts';

const directory = realpathSync.native(
  mkdtempSync(path.join(tmpdir(), 'loom-history-memory-child-')),
);
const cwd = path.join(directory, 'workspace');
const timestamp = '2026-01-01T00:00:00.000Z';
const managers = [];
const histories = [];
const collect = () => {
  for (let i = 0; i < 3; i++) global.gc();
  return process.memoryUsage();
};
try {
  mkdirSync(cwd);
  const baseline = collect();
  for (let conversation = 0; conversation < 2; conversation++) {
    const sessionDirectory = path.join(directory, 'sessions', `bot-${conversation}`, 'room');
    mkdirSync(sessionDirectory, { recursive: true });
    const filename = path.join(sessionDirectory, 'history.jsonl');
    const fd = openSync(filename, 'wx');
    const sourceDigest = createHash('sha256');
    const write = (entry) => {
      const line = `${JSON.stringify(entry)}\n`;
      sourceDigest.update(line);
      writeFileSync(fd, line);
    };
    const system = {
      type: 'message',
      id: 'system',
      parentId: null,
      timestamp,
      message: {
        role: 'system',
        content: 'Preserve the current instructions exactly.',
        timestamp: 1,
      },
    };
    const current = {
      type: 'message',
      id: 'current',
      parentId: 'old-47',
      timestamp,
      message: {
        role: 'user',
        content: '継続する。元の資料・条件・識別子を変えない。',
        timestamp: 3,
      },
    };
    const checkpoint = {
      type: 'compaction',
      id: 'checkpoint',
      parentId: 'current',
      timestamp,
      summary: '既存の正確な要約。receipt op-77 は完了済み。',
      firstKeptEntryId: 'current',
      tokensBefore: 100000,
      systemMessage: system.message,
    };
    const answer = {
      type: 'message',
      id: 'answer',
      parentId: 'checkpoint',
      timestamp,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'The preserved result.' }],
        api: 'openai-completions',
        provider: 'loom-local',
        model: 'fixture',
        stopReason: 'stop',
        timestamp: 4,
        usage: {
          input: 10,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    };
    try {
      write({ type: 'session', version: 3, id: `history-${conversation}`, cwd, timestamp });
      write(system);
      for (let i = 0; i < 48; i++) {
        write({
          type: 'message',
          id: `old-${i}`,
          parentId: i ? `old-${i - 1}` : 'system',
          timestamp,
          message: { role: 'user', content: `${i}:` + 'old text '.repeat(131072), timestamp: 2 },
        });
      }
      write(current);
      write(checkpoint);
      write(answer);
    } finally {
      closeSync(fd);
    }
    const originalBytes = statSync(filename).size;
    const result = await compactSessionHistory({
      sessionPath: filename,
      maxRecordBytes: 2 * 1024 * 1024,
      maxWorkingBytes: 2 * 1024 * 1024,
    });
    assert.equal(result.changed, true, result.reason);
    const backupDigest = createHash('sha256');
    for await (const chunk of createReadStream(result.backupPath)) backupDigest.update(chunk);
    assert.equal(backupDigest.digest('hex'), sourceDigest.digest('hex'));
    const manager = SessionManager.open(filename, sessionDirectory);
    managers.push(manager);
    const expected = buildSessionProjection([
      system,
      { ...current, parentId: 'system' },
      checkpoint,
      answer,
    ]);
    assert.deepEqual(manager.buildSessionContext(), {
      messages: expected.messages,
      model: expected.model,
      thinkingLevel: expected.thinkingLevel,
    });
    assert.equal(manager.getEntry('old-0'), undefined);
    assert.equal(manager.getEntryCount(), 4);
    manager.appendMessage({
      role: 'user',
      content: 'Continue after bounded loading.',
      timestamp: 5,
    });
    histories.push({ originalBytes, residentBytes: result.residentBytes, contextPreserved: true });
  }
  const retained = collect();
  assert.equal(managers.length, 2);
  console.log(JSON.stringify({ baseline, retained, histories }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
