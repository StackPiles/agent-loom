// Invoked in a deliberately small-heap child process by session-images.test.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SessionManager,
  buildSessionProjection,
  convertToLlm,
} from '@earendil-works/pi-coding-agent';
import { createSessionImageStore } from '../src/server/runtime/session-images.ts';

const rows = Number(process.env.LOOM_TEST_HISTORY_MIB ?? 8);
assert.ok(Number.isInteger(rows) && rows > 0 && rows <= 64);
const directory = mkdtempSync(path.join(tmpdir(), 'loom-session-memory-child-'));
const cwd = path.join(directory, 'workspace');
const timestamp = '2026-01-01T00:00:00.000Z';
const collect = () => {
  for (let i = 0; i < 3; i++) global.gc();
  return process.memoryUsage();
};
const managers = [];
const preparations = [];
try {
  mkdirSync(cwd);
  const store = createSessionImageStore(directory);
  const baseline = collect();
  for (let conversation = 0; conversation < 2; conversation++) {
    const sessionDirectory = path.join(directory, 'sessions', `bot-${conversation}`, 'room');
    mkdirSync(sessionDirectory, { recursive: true });
    const filename = path.join(sessionDirectory, 'history.jsonl');
    const fd = openSync(filename, 'wx');
    let lastHash;
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          type: 'session',
          version: 3,
          id: `fixture-${conversation}`,
          cwd,
          timestamp,
        }) + '\n',
      );
      for (let i = 0; i < rows; i++) {
        // 768 KiB synthetic bytes encode to exactly one MiB of base64.
        const pixels = Buffer.alloc(768 * 1024, conversation * 64 + i);
        lastHash = createHash('sha256').update(pixels).digest('hex');
        writeFileSync(
          fd,
          JSON.stringify({
            type: 'message',
            id: `image-${i}`,
            parentId: i ? `image-${i - 1}` : null,
            timestamp,
            message: {
              role: 'toolResult',
              toolName: 'view_image',
              toolCallId: `call-${i}`,
              isError: false,
              timestamp: 1,
              content: [{ type: 'image', mimeType: 'image/png', data: pixels.toString('base64') }],
            },
          }) + '\n',
        );
      }
      writeFileSync(
        fd,
        JSON.stringify({
          type: 'compaction',
          id: 'compact',
          parentId: `image-${rows - 1}`,
          timestamp,
          summary: 'Earlier images have been inspected.',
          firstKeptEntryId: `image-${rows - 1}`,
          tokensBefore: 123456,
        }) + '\n',
      );
    } finally {
      closeSync(fd);
    }
    const originalBytes = statSync(filename).size;
    const prepared = await store.prepareSessionHistory({ sessionDirectory, cwd });
    const manager = SessionManager.open(prepared.sessionPath, sessionDirectory);
    managers.push(manager);
    const entries = manager.getEntries();
    assert.equal(entries.length, rows + 1);
    const parts = entries.flatMap((entry) =>
      entry.type === 'message' ? entry.message.content.filter((part) => part.type === 'image') : [],
    );
    assert.equal(parts.length, rows);
    assert.ok(parts.every((part) => part.data.startsWith('loom-image:v1:sha256:')));
    const active = convertToLlm(buildSessionProjection(entries).messages);
    const hydrated = await store.hydrateMessages(active);
    const activeImages = hydrated.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image') : [],
    );
    assert.equal(activeImages.length, 1);
    assert.equal(
      createHash('sha256').update(Buffer.from(activeImages[0].data, 'base64')).digest('hex'),
      lastHash,
    );
    preparations.push({
      originalBytes,
      residentBytes: prepared.residentBytes,
      retainedEntries: entries.length,
      activeImageHashMatches: true,
    });
  }
  const retained = collect();
  assert.equal(managers.length, 2);
  console.log(
    JSON.stringify({
      node: process.version,
      heapFlags: process.execArgv,
      base64MiBPerHistory: rows,
      baseline,
      retained,
      preparations,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
