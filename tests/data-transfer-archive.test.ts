import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  lstat,
  readdir,
  utimes,
  symlink,
  readlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Store } from '../src/server/store.js';
import { VERSION } from '../src/server/controller.js';
import type { StoredTaskInput } from '../src/server/task-inputs.js';
import type {
  BrowserSettings,
  GeneratedImage,
  Message,
  NotificationReplyContext,
} from '../src/shared/types.js';
import { browserUploadSettings, DEFAULT_BROWSER_UPLOAD_SETTINGS } from '../src/shared/browser.js';
import { DEFAULT_AUTONOMOUS_WAKEUP_POLICY } from '../src/shared/work.js';
import {
  exportDataArchive,
  importDataArchive,
  DATA_TRANSFER_MAX_EXPANDED_BYTES,
  DATA_TRANSFER_MAX_FILES,
  DATA_TRANSFER_MAX_MANIFEST_BYTES,
  DATA_TRANSFER_MAX_RECORD_BYTES,
  validateDataTransferBrowserState,
  validateDataTransferPassword,
} from '../src/server/data-transfer-archive.js';

const PASSWORD = 'transfer fixture password 123';
const SECRET = 'fixture-only-provider-secret-never-in-errors';
const UPLOAD_SETTINGS = {
  uploadMaxFiles: 12,
  uploadMaxFileMiB: 384,
  uploadMaxTotalMiB: 768,
  uploadStorageMiB: 4096,
};
const UPLOADED_IMAGE: GeneratedImage = {
  id: `img_${'1'.repeat(64)}`,
  type: 'image',
  mimeType: 'image/png',
  filename: 'reference.png',
  byteLength: 4,
  prompt: '',
  model: '',
  createdAt: '2026-11-10T00:00:00.000Z',
  source: 'uploaded',
};
const EDITED_IMAGE: GeneratedImage = {
  ...UPLOADED_IMAGE,
  id: `img_${'2'.repeat(64)}`,
  filename: 'edited.png',
  source: 'generated',
  operation: 'edit',
  model: 'fixture-image-model',
  prompt: 'Change the background to blue.',
  inputImages: [{ role: 'source', imageId: UPLOADED_IMAGE.id, sha256: '3'.repeat(64) }],
};
const PENDING_TASK_INPUT: StoredTaskInput = {
  id: 'taskinput_01900000000040008000000000000001',
  requestId: '01900000-0000-4000-8000-000000000001',
  taskId: 'task_reply_fixture',
  roomId: 'room_lounge',
  botId: 'bot_aster',
  messageId: 'message_task_input_pending',
  sequence: 1,
  body: 'Use the additional screenshot when explicitly resuming.',
  inputImageIds: [UPLOADED_IMAGE.id],
  mode: 'immediate',
  status: 'pending',
  createdAt: '2026-11-10T00:00:00.000Z',
  requestFingerprint: 'a'.repeat(64),
};
const DELIVERED_TASK_INPUT: StoredTaskInput = {
  ...PENDING_TASK_INPUT,
  id: 'taskinput_01900000000040008000000000000002',
  requestId: '01900000-0000-4000-8000-000000000002',
  messageId: 'message_task_input_delivered',
  sequence: 2,
  body: 'Keep the original task identity.',
  inputImageIds: undefined,
  mode: 'boundary',
  status: 'delivered',
  deliveredAt: '2026-11-10T00:01:00.000Z',
  reason: 'Text delivered; image references are available in the history.',
  requestFingerprint: 'b'.repeat(64),
};
const NOVA_PROFILE = 'browser-profiles/' + createHash('sha256').update('bot_nova').digest('hex');
const diskKey = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const KEY_OPTIONS = { N: 65_536, r: 8, p: 1, maxmem: 128 * 1024 ** 2 };
const NOTICE_REPLY: NotificationReplyContext = {
  notificationId: 'notification_owner_fixture',
  roomId: 'room_lounge',
  botId: 'bot_aster',
  senderName: 'Aster at send time',
  senderHandle: 'aster',
  title: 'A proactive suggestion',
  body: 'A proactive suggestion for the owner.',
  createdAt: '2026-11-05T00:00:00.000Z',
  messageId: 'message_owner_fixture',
  taskId: 'task_fixture',
};
const SCHEDULING_GRANT = {
  id: 'priority_transfer_fixture',
  source: 'owner',
  reason: 'Finish the requested review',
  requestedAt: '2026-11-09T00:00:00.000Z',
  expiresAt: '2026-11-09T00:05:00.000Z',
  grantedRequests: 3,
  remainingRequests: 1,
  consumedRequests: 2,
};

async function exists(filename: string) {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function files(root: string, values: Record<string, string | Buffer>) {
  for (const [name, value] of Object.entries(values)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), value);
  }
}
function saved(db: DatabaseSync, kind: string, id: string): Record<string, unknown> | undefined {
  const row = db.prepare('SELECT data FROM objects WHERE kind=? AND id=?').get(kind, id) as
    { data: string } | undefined;
  return row ? JSON.parse(row.data) : undefined;
}
function decryptSecret(db: DatabaseSync, key: Buffer, name: string): string {
  const row = db.prepare('SELECT value FROM secrets WHERE key=?').get(name) as { value: string };
  const [iv, tag, body] = row.value.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(body!), decipher.final()]).toString();
}
async function fixture(t: TestContext, ancestorWorkspace = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const container = path.join(root, 'source');
  const source = path.join(container, 'data');
  const destination = path.join(root, 'destination');
  const external = ancestorWorkspace ? container : path.join(root, 'external');
  const stage = path.join(destination, '.loom-transfer', 'jobs', 'b'.repeat(32), 'data');
  const archive = path.join(source, '.loom-transfer', 'jobs', 'a'.repeat(32), 'archive.loom');
  const sessions = path.join('sessions', diskKey('bot_aster'), diskKey('room_lounge'));
  const body =
    JSON.stringify({
      type: 'message',
      id: 'msg-context',
      message: { role: 'user', content: `Historical path: ${source}` },
    }) + '\n';
  const store = new Store(source);
  try {
    store.seed();
    store.patch('settings', 'main', {
      browser: { ...store.settings().browser!, ...UPLOAD_SETTINGS },
      model: {
        ...store.settings().model,
        responseTimeoutSeconds: 2400,
        idleTimeoutSeconds: 450,
        imageInput: true,
      },
      images: {
        ...store.settings().images,
        permission: 'allow',
        size: '2048x2048',
        steps: 40,
        stepsParameter: 'sd_cpp_extra_args',
        timeoutSeconds: 3600,
        shareInferenceSlot: false,
      },
    });
    // Older bots keep the shared browser; newer dedicated bindings survive transfer.
    store.patch('bots', 'bot_aster', { browser: undefined });
    store.setSecret('model.apiKey', SECRET);
    store.setSecret('mail.mail_fixture.imap', 'fixture-mail-password');
    store.setSecret('service.service_fixture.credential', 'fixture-service-token');
    store.put('rooms', {
      id: 'room_external',
      name: 'External',
      workspacePath: path.join(external, 'nested'),
    });
    store.put('tasks', {
      id: 'task_fixture',
      status: 'interrupted',
      roomId: 'room_lounge',
      botId: 'bot_aster',
      workspacePath: path.join(source, 'workspace'),
      scheduling: { grant: SCHEDULING_GRANT },
      skillUses: [
        {
          id: 'skill_fixture',
          version: 1,
          name: 'Transfer fixture procedure',
          description: 'The exact procedure used before the task was interrupted.',
          content: 'First revision',
          botId: 'bot_aster',
          roomId: 'room_lounge',
          readAt: '2026-11-06T00:00:00.000Z',
        },
      ],
    });
    store.put('tasks', { id: 'task_external', status: 'completed', workspacePath: external });
    store.patch('rooms', 'room_lounge', {
      autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room' },
    });
    store.put('workItems', {
      id: 'work_fixture',
      roomId: 'room_lounge',
      name: 'Transfer work',
      purpose: 'Continue the review',
      kind: 'task',
      status: 'active',
      createdByBotId: 'bot_aster',
      sourceTaskId: 'task_fixture',
      workspacePath: path.join(source, 'workspace'),
      scope: 'Existing room scope',
      revision: 2,
      checkpoint: {
        summary: 'Waiting',
        completed: 'Inspected the input',
        nextStep: 'Review the result',
        references: ['report.txt'],
        doneWhen: 'The review is reported',
        uncertainActions: ['Verify the previous upload'],
      },
      createdAt: '2026-11-06T00:00:00.000Z',
      updatedAt: '2026-11-06T00:00:00.000Z',
      reviewedAt: '2026-11-06T00:00:00.000Z',
    });
    store.patch('tasks', 'task_fixture', { workId: 'work_fixture', workRunId: 'run_fixture' });
    store.put('wakeups', {
      id: 'wake_fixture',
      workId: 'work_fixture',
      roomId: 'room_lounge',
      botId: 'bot_aster',
      createdByBotId: 'bot_aster',
      sourceTaskId: 'task_fixture',
      key: 'review',
      reason: 'Wait for the result',
      prompt: 'Review the result',
      workRunId: 'run_fixture',
      status: 'scheduled',
      nextRunAt: '2099-01-01T09:00:00.000Z',
      revision: 1,
      schedule: {
        type: 'once',
        dateTime: '2099-01-01T09:00',
        timeZone: 'UTC',
        missedRunPolicy: 'run_once',
      },
      createdAt: '2026-11-06T00:00:00.000Z',
      updatedAt: '2026-11-06T00:00:00.000Z',
    });
    store.put('operations', {
      id: 'operation_fixture',
      key: 'operation_fixture',
      taskId: 'task_fixture',
      toolName: 'write_file',
      args: { path: path.join(source, 'workspace', 'report.txt') },
      status: 'completed',
      result: 'already written',
    });
    store.put('automations', {
      id: 'automation_fixture',
      enabled: true,
      kind: 'interval',
      nextRunAt: '2099-01-01T00:00:00.000Z',
    });
    store.put('automationState', {
      id: 'automation_fixture',
      lastUid: 17,
      pendingMail: [{ id: 'mail-locator', text: 'queued envelope' }],
    });
    store.put('mailDrafts', {
      id: 'draft_fixture',
      accountId: 'mail_fixture',
      status: 'sent',
      body: 'Sent fixture',
    });
    store.put('operations', {
      id: 'operation_unknown_mail',
      key: 'operation_unknown_mail',
      taskId: 'task_fixture',
      toolName: 'send_mail',
      args: { draftId: 'draft_unknown_fixture' },
      status: 'failed',
      uncertainty: { kind: 'mail', draftId: 'draft_unknown_fixture' },
    });
    store.put('mailDrafts', {
      id: 'draft_unknown_fixture',
      accountId: 'mail_fixture',
      botId: 'bot_aster',
      status: 'unknown',
    });
    store.put('mailSends', {
      id: 'receipt_fixture',
      status: 'sent',
      providerMessageId: 'provider-fixture-123',
    });
    store.put('authSessions', {
      id: 'source-cookie-hash',
      expiresAt: Date.now() + 3600_000,
      tokenFingerprint: 'source-token',
    });
    store.put('skills', {
      id: 'skill_fixture',
      content: 'Durable skill',
      version: 2,
      roomId: 'room_lounge',
      locked: true,
      revisions: [
        { version: 1, content: 'First revision' },
        {
          version: 2,
          content: 'Durable skill',
          actor: { kind: 'user' },
          reason: 'Corrected and fixed by the owner',
          evidence: 'Transfer fixture',
        },
      ],
    });
    store.put('memories', {
      id: 'memory_fixture',
      content: 'Durable memory',
      version: 2,
      status: 'archived',
      locked: true,
      roomId: 'room_lounge',
      revisions: [
        { version: 1, content: 'Original memory' },
        {
          version: 2,
          content: 'Durable memory',
          status: 'archived',
          actor: { kind: 'user' },
          reason: 'No longer current',
          evidence: 'Transfer fixture',
        },
      ],
    });
    store.put('messages', {
      id: 'message_owner_fixture',
      roomId: 'room_lounge',
      authorType: 'bot',
      authorId: 'bot_aster',
      taskId: 'task_fixture',
      targetUser: true,
      body: 'A proactive suggestion for the owner.',
      status: 'complete',
      createdAt: '2026-11-05T00:00:00.000Z',
    });
    store.put('notifications', {
      id: NOTICE_REPLY.notificationId,
      title: NOTICE_REPLY.title,
      body: NOTICE_REPLY.body,
      roomId: NOTICE_REPLY.roomId,
      taskId: NOTICE_REPLY.taskId,
      messageId: NOTICE_REPLY.messageId,
      sender: {
        kind: 'bot',
        botId: NOTICE_REPLY.botId,
        name: NOTICE_REPLY.senderName,
        handle: NOTICE_REPLY.senderHandle,
      },
      read: true,
      createdAt: NOTICE_REPLY.createdAt,
    });
    store.put('notifications', {
      id: 'notification_legacy_fixture',
      title: 'A saved legacy notice',
      body: 'The old archive did not record a sender.',
      roomId: 'room_lounge',
      taskId: 'task_fixture',
      read: false,
      createdAt: NOTICE_REPLY.createdAt,
    });
    store.put('notifications', {
      id: 'notification_system_fixture',
      title: 'A system update',
      body: 'The scheduler recorded a status update.',
      roomId: 'room_lounge',
      sender: { kind: 'system' },
      read: false,
      createdAt: NOTICE_REPLY.createdAt,
    });
    store.put('tasks', {
      id: 'task_reply_fixture',
      botId: 'bot_aster',
      roomId: 'room_lounge',
      kind: 'chat',
      status: 'interrupted',
      rootTaskId: 'task_reply_fixture',
      depth: 0,
      prompt: 'Please use the second option.',
      output: '',
      createdAt: '2026-11-06T00:00:00.000Z',
      updatedAt: '2026-11-06T00:00:00.000Z',
      inputTokens: 0,
      outputTokens: 0,
      notificationReply: NOTICE_REPLY,
    });
    store.put('messages', {
      id: 'message_reply_fixture',
      roomId: 'room_lounge',
      authorType: 'user',
      authorId: 'user',
      taskId: 'task_reply_fixture',
      targetBotIds: ['bot_aster'],
      body: 'Please use the second option.',
      status: 'complete',
      createdAt: '2026-11-06T00:00:00.000Z',
      notificationReply: NOTICE_REPLY,
    });
    store.put('images', { id: 'img_fixture', filename: 'generated-fixture.png', byteLength: 4 });
    store.put('images', UPLOADED_IMAGE);
    store.put('images', EDITED_IMAGE);
    store.patch('messages', 'message_reply_fixture', { attachments: [UPLOADED_IMAGE] });
    store.patch('messages', 'message_owner_fixture', { attachments: [EDITED_IMAGE] });
    store.patch('tasks', 'task_reply_fixture', { inputImageIds: [UPLOADED_IMAGE.id] });
    for (const input of [PENDING_TASK_INPUT, DELIVERED_TASK_INPUT]) {
      store.put('taskInputs', input);
      store.put('messages', {
        id: input.messageId,
        roomId: input.roomId,
        authorType: 'user',
        authorId: 'user',
        taskId: input.taskId,
        taskInputId: input.id,
        targetBotIds: [input.botId],
        body: input.body,
        status: 'complete',
        createdAt: input.createdAt,
        ...(input.inputImageIds?.length ? { attachments: [UPLOADED_IMAGE] } : {}),
      });
    }
    store.put('approvals', {
      id: 'approval_superseded_fixture',
      taskId: PENDING_TASK_INPUT.taskId,
      status: 'cancelled',
      cancellationReason: 'superseded',
      decidedAt: PENDING_TASK_INPUT.createdAt,
    });
    store.event('fixture', { preserved: true });
    store.remember('webhook:fixture:already-seen');
  } finally {
    store.close();
  }
  await files(source, {
    'workspace/report.txt': 'Workspace report',
    'workspace/.env': 'FIXTURE_WORKSPACE_ONLY=1',
    'generated-images/img_fixture.png': Buffer.from([0, 1, 2, 3]),
    [`generated-images/${UPLOADED_IMAGE.id}.png`]: Buffer.from([0, 1, 2, 3]),
    [`generated-images/${EDITED_IMAGE.id}.png`]: Buffer.from([0, 1, 2, 3]),
    'browser-profile/Preferences': '{"fixture":true}',
    [NOVA_PROFILE + '/Preferences']: '{"bot":"nova"}',
    'pi/catalog.json': '{"fixture":true}',
    '.loom-transfer/private-backup/never-copy.txt': 'reserved control data',
    [path.join(sessions, 'old.jsonl')]:
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'old',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: path.join(source, 'workspace'),
      }) +
      '\n' +
      body,
    [path.join(sessions, 'new.jsonl')]:
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'new',
        timestamp: '2024-01-02T00:00:00.000Z',
        cwd: path.join(source, 'workspace'),
        parentSession: path.join(source, sessions, 'old.jsonl'),
      }) +
      '\n' +
      body,
  });
  await files(external, {
    'nested/external.txt': 'External workspace content',
    'top.txt': 'External root content',
  });
  await files(destination, { 'existing.txt': 'Destination must stay unchanged during preview' });
  await mkdir(path.dirname(archive), { recursive: true });
  const oldTime = 1_700_000_000.125,
    newTime = oldTime + 3600;
  await utimes(path.join(source, sessions, 'old.jsonl'), oldTime, oldTime);
  await utimes(path.join(source, sessions, 'new.jsonl'), newTime, newTime);
  return {
    root,
    container,
    source,
    destination,
    external,
    stage,
    archive,
    sessions,
    body,
    oldTime,
    newTime,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function exportFixture(f: Fixture) {
  return exportDataArchive({
    dataDir: f.source,
    archivePath: f.archive,
    password: PASSWORD,
    browserState: {
      'loom.locale': 'ja',
      'loom.drafts': '{"room_lounge":"Unsent draft"}',
      'loom.room': 'room_lounge',
    },
  });
}
async function importFixture(f: Fixture, archivePath = f.archive, password = PASSWORD) {
  return importDataArchive({
    archivePath,
    stagingDir: f.stage,
    destinationDataDir: f.destination,
    password,
  });
}

// Deliberately write authenticated hostile archives. Encryption does not make an
// imported manifest trusted: owners can know a password for an unsafe archive.
interface Capsule {
  manifest: {
    format: number;
    version: string;
    platform: string;
    dataDir: string;
    workspaces: string[];
    externalWorkspaces: Array<{ sourcePath: string; id: string }>;
    entries: Array<{
      path: string;
      type: string;
      size: number;
      mode: number;
      mtime: number;
      target?: string;
    }>;
    browserState?: Record<string, string>;
    [key: string]: unknown;
  };
  bodies: Buffer[];
}
async function decodeArchive(filename: string): Promise<Capsule> {
  const archive = await readFile(filename),
    header = archive.subarray(0, 40);
  const key = scryptSync(PASSWORD, header.subarray(12, 28), 32, KEY_OPTIONS);
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(28));
  decipher.setAAD(header);
  decipher.setAuthTag(archive.subarray(-16));
  const data = gunzipSync(
    Buffer.concat([decipher.update(archive.subarray(40, -16)), decipher.final()]),
  );
  const length = data.readUInt32BE(0);
  const manifest = JSON.parse(data.subarray(4, 4 + length).toString()) as Capsule['manifest'];
  const bodies: Buffer[] = [];
  let offset = 4 + length;
  for (const entry of manifest.entries) {
    if (entry.type !== 'file') continue;
    bodies.push(Buffer.from(data.subarray(offset, offset + entry.size)));
    offset += entry.size;
  }
  assert.equal(offset, data.length);
  return { manifest, bodies };
}
async function encryptPayload(filename: string, plaintext: Buffer) {
  const header = Buffer.alloc(40);
  header.write('LOOMDATA');
  header.writeUInt32BE(1, 8);
  randomBytes(16).copy(header, 12);
  randomBytes(12).copy(header, 28);
  const key = scryptSync(PASSWORD, header.subarray(12, 28), 32, KEY_OPTIONS);
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(28));
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(gzipSync(plaintext)), cipher.final()]);
  await writeFile(filename, Buffer.concat([header, ciphertext, cipher.getAuthTag()]));
}
async function encodeArchive(filename: string, capsule: Capsule) {
  const manifest = Buffer.from(JSON.stringify(capsule.manifest));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(manifest.length);
  await encryptPayload(filename, Buffer.concat([prefix, manifest, ...capsule.bodies]));
}
async function mutateDatabase(f: Fixture, capsule: Capsule, mutate: (db: DatabaseSync) => void) {
  const index = capsule.manifest.entries
    .filter((entry) => entry.type === 'file')
    .findIndex((entry) => entry.path === 'data/loom.sqlite');
  const filename = path.join(f.root, `modified-${randomBytes(6).toString('hex')}.sqlite`);
  await writeFile(filename, capsule.bodies[index]!);
  const db = new DatabaseSync(filename);
  try {
    mutate(db);
  } finally {
    db.close();
  }
  capsule.bodies[index] = await readFile(filename);
  capsule.manifest.entries.find((entry) => entry.path === 'data/loom.sqlite')!.size =
    capsule.bodies[index]!.length;
}
async function rejectedImport(f: Fixture, filename: string, expression: RegExp, statusCode = 400) {
  await assert.rejects(importFixture(f, filename), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, expression);
    assert.equal((error as Error & { statusCode: number }).statusCode, statusCode);
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
  assert.equal(await exists(f.stage), false);
  assert.equal(
    await readFile(path.join(f.destination, 'existing.txt'), 'utf8'),
    'Destination must stay unchanged during preview',
  );
  const parent = path.dirname(f.stage);
  if (await exists(parent))
    assert.equal(
      (await readdir(parent)).some((name) => name.startsWith('.decrypt-')),
      false,
    );
}

test('encrypted round trip preserves credentials, all durable state, images and Pi context while isolating preview', async (t) => {
  const f = await fixture(t);
  const sourceStore = new Store(f.source);
  let messageOrder: string[];
  try {
    // Exercise tied creation times across the actual archive/rebase path. The
    // input messages and later replies must retain their durable insertion order.
    sourceStore.db
      .prepare("UPDATE objects SET created_at=? WHERE kind='messages'")
      .run('2026-11-10T12:00:00.000Z');
    messageOrder = sourceStore.list<Message>('messages').map((message) => message.id);
  } finally {
    sourceStore.close();
  }
  const exported = await exportFixture(f);
  assert.equal(exported.version, VERSION);
  assert.ok(exported.warnings.some((warning) => warning.includes('Dedicated Chrome profiles')));
  const encrypted = await readFile(f.archive);
  assert.equal(encrypted.includes(Buffer.from(SECRET)), false);
  assert.equal(encrypted.includes(Buffer.from('Workspace report')), false);
  const preview = await importFixture(f);
  assert.equal(preview.disabledAutomations, 1);
  assert.equal(preview.browserState?.['loom.locale'], 'ja');
  assert.match(preview.browserState?.['loom.drafts'] ?? '', /Unsent draft/);
  assert.equal(await exists(path.join(f.stage, '.loom-transfer')), false);
  assert.equal(
    await readFile(path.join(f.destination, 'existing.txt'), 'utf8'),
    'Destination must stay unchanged during preview',
  );
  assert.equal(await exists(path.join(f.destination, 'loom.sqlite')), false);
  assert.equal(
    await readFile(path.join(f.stage, 'workspace', 'report.txt'), 'utf8'),
    'Workspace report',
  );
  assert.equal(
    await readFile(path.join(f.stage, 'workspace', '.env'), 'utf8'),
    'FIXTURE_WORKSPACE_ONLY=1',
  );
  assert.deepEqual(
    await readFile(path.join(f.stage, 'generated-images', 'img_fixture.png')),
    Buffer.from([0, 1, 2, 3]),
  );
  assert.equal(
    await readFile(path.join(f.stage, 'pi', 'catalog.json'), 'utf8'),
    '{"fixture":true}',
  );
  assert.equal(
    await readFile(path.join(f.stage, 'browser-profile', 'Preferences'), 'utf8'),
    '{"fixture":true}',
  );
  assert.equal(
    await readFile(path.join(f.stage, NOVA_PROFILE, 'Preferences'), 'utf8'),
    '{"bot":"nova"}',
  );
  const db = new DatabaseSync(path.join(f.stage, 'loom.sqlite'), { readOnly: true });
  try {
    const key = await readFile(path.join(f.stage, 'secret.key'));
    assert.deepEqual(saved(db, 'images', UPLOADED_IMAGE.id), UPLOADED_IMAGE);
    assert.deepEqual(saved(db, 'images', EDITED_IMAGE.id), EDITED_IMAGE);
    assert.deepEqual(saved(db, 'messages', 'message_reply_fixture')!.attachments, [UPLOADED_IMAGE]);
    assert.deepEqual(saved(db, 'tasks', 'task_reply_fixture')!.inputImageIds, [UPLOADED_IMAGE.id]);
    assert.deepEqual(saved(db, 'taskInputs', PENDING_TASK_INPUT.id), PENDING_TASK_INPUT);
    assert.deepEqual(
      saved(db, 'taskInputs', DELIVERED_TASK_INPUT.id),
      JSON.parse(JSON.stringify(DELIVERED_TASK_INPUT)),
    );
    assert.equal(
      saved(db, 'messages', PENDING_TASK_INPUT.messageId)!.taskInputId,
      PENDING_TASK_INPUT.id,
    );
    assert.deepEqual(saved(db, 'messages', PENDING_TASK_INPUT.messageId)!.attachments, [
      UPLOADED_IMAGE,
    ]);
    assert.equal(
      saved(db, 'approvals', 'approval_superseded_fixture')!.cancellationReason,
      'superseded',
    );
    const transferredModel = saved(db, 'settings', 'main')!.model as Record<string, unknown>;
    assert.equal(transferredModel.responseTimeoutSeconds, 2400);
    assert.equal(transferredModel.idleTimeoutSeconds, 450);
    assert.equal(transferredModel.imageInput, true);
    const transferredImages = saved(db, 'settings', 'main')!.images as Record<string, unknown>;
    assert.equal(transferredImages.permission, 'allow');
    assert.equal(transferredImages.size, '2048x2048');
    assert.equal(transferredImages.steps, 40);
    assert.equal(transferredImages.stepsParameter, 'sd_cpp_extra_args');
    assert.equal(transferredImages.timeoutSeconds, 3600);
    assert.equal(transferredImages.shareInferenceSlot, false);
    assert.equal(saved(db, 'bots', 'bot_aster')!.browser, undefined);
    assert.deepEqual(saved(db, 'bots', 'bot_nova')!.browser, { mode: 'dedicated' });
    assert.equal(saved(db, 'messages', 'message_owner_fixture')!.targetUser, true);
    assert.equal(saved(db, 'messages', 'message_owner_fixture')!.taskId, 'task_fixture');
    assert.equal(
      saved(db, 'messages', 'message_owner_fixture')!.body,
      'A proactive suggestion for the owner.',
    );
    assert.deepEqual(saved(db, 'notifications', NOTICE_REPLY.notificationId)!.sender, {
      kind: 'bot',
      botId: 'bot_aster',
      name: NOTICE_REPLY.senderName,
      handle: 'aster',
    });
    assert.equal(
      saved(db, 'notifications', NOTICE_REPLY.notificationId)!.messageId,
      'message_owner_fixture',
    );
    assert.deepEqual(saved(db, 'tasks', 'task_reply_fixture')!.notificationReply, NOTICE_REPLY);
    assert.deepEqual(
      saved(db, 'messages', 'message_reply_fixture')!.notificationReply,
      NOTICE_REPLY,
    );
    assert.deepEqual(saved(db, 'messages', 'message_reply_fixture')!.targetBotIds, ['bot_aster']);
    assert.equal(saved(db, 'notifications', 'notification_legacy_fixture')!.sender, undefined);
    assert.deepEqual(saved(db, 'notifications', 'notification_system_fixture')!.sender, {
      kind: 'system',
    });
    assert.equal(
      (saved(db, 'settings', 'main')!.browser as { maxConcurrentBrowsers: number })
        .maxConcurrentBrowsers,
      3,
    );
    assert.deepEqual(
      browserUploadSettings(saved(db, 'settings', 'main')!.browser as BrowserSettings),
      UPLOAD_SETTINGS,
    );
    assert.equal(decryptSecret(db, key, 'model.apiKey'), SECRET);
    assert.equal(decryptSecret(db, key, 'mail.mail_fixture.imap'), 'fixture-mail-password');
    assert.equal(
      decryptSecret(db, key, 'service.service_fixture.credential'),
      'fixture-service-token',
    );
    assert.equal(
      saved(db, 'settings', 'main')!.workspacePath,
      path.join(f.destination, 'workspace'),
    );
    assert.equal(
      saved(db, 'tasks', 'task_fixture')!.workspacePath,
      path.join(f.destination, 'workspace'),
    );
    const roomPath = saved(db, 'rooms', 'room_external')!.workspacePath as string;
    assert.ok(roomPath.startsWith(path.join(f.destination, 'imported-workspaces') + path.sep));
    assert.equal(
      await readFile(
        path.join(f.stage, path.relative(f.destination, roomPath), 'external.txt'),
        'utf8',
      ),
      'External workspace content',
    );
    assert.equal(
      saved(db, 'mailSends', 'receipt_fixture')!.providerMessageId,
      'provider-fixture-123',
    );
    assert.equal(saved(db, 'mailDrafts', 'draft_fixture')!.status, 'sent');
    assert.equal(saved(db, 'mailDrafts', 'draft_unknown_fixture')!.status, 'unknown');
    assert.deepEqual(saved(db, 'operations', 'operation_unknown_mail')!.uncertainty, {
      kind: 'mail',
      draftId: 'draft_unknown_fixture',
    });
    assert.equal(saved(db, 'automationState', 'automation_fixture')!.lastUid, 17);
    assert.equal(saved(db, 'automations', 'automation_fixture')!.enabled, false);
    assert.equal(saved(db, 'automations', 'automation_fixture')!.nextRunAt, undefined);
    assert.equal(saved(db, 'workItems', 'work_fixture')!.status, 'paused');
    assert.equal(
      saved(db, 'workItems', 'work_fixture')!.workspacePath,
      path.join(f.destination, 'workspace'),
    );
    assert.equal(saved(db, 'workItems', 'work_fixture')!.reviewedAt, undefined);
    assert.deepEqual(
      (saved(db, 'workItems', 'work_fixture')!.checkpoint as { uncertainActions: string[] })
        .uncertainActions,
      ['Verify the previous upload'],
    );
    assert.equal(
      (saved(db, 'rooms', 'room_lounge')!.autonomousWakeups as { mode: string }).mode,
      'off',
    );
    assert.equal(saved(db, 'tasks', 'task_fixture')!.workRunId, 'run_fixture');
    assert.deepEqual(saved(db, 'tasks', 'task_fixture')!.scheduling, {
      grant: SCHEDULING_GRANT,
    });
    assert.equal(saved(db, 'wakeups', 'wake_fixture')!.nextRunAt, '2099-01-01T09:00:00.000Z');
    assert.equal(saved(db, 'wakeups', 'wake_fixture')!.workRunId, 'run_fixture');
    assert.equal(saved(db, 'authSessions', 'source-cookie-hash'), undefined);
    assert.equal(saved(db, 'skills', 'skill_fixture')!.content, 'Durable skill');
    assert.equal(saved(db, 'memories', 'memory_fixture')!.content, 'Durable memory');
    assert.equal(saved(db, 'skills', 'skill_fixture')!.version, 2);
    assert.equal(saved(db, 'skills', 'skill_fixture')!.locked, true);
    assert.equal(saved(db, 'memories', 'memory_fixture')!.status, 'archived');
    assert.equal(saved(db, 'memories', 'memory_fixture')!.roomId, 'room_lounge');
    assert.deepEqual(saved(db, 'memories', 'memory_fixture')!.revisions, [
      { version: 1, content: 'Original memory' },
      {
        version: 2,
        content: 'Durable memory',
        status: 'archived',
        actor: { kind: 'user' },
        reason: 'No longer current',
        evidence: 'Transfer fixture',
      },
    ]);
    assert.deepEqual(saved(db, 'tasks', 'task_fixture')!.skillUses, [
      {
        id: 'skill_fixture',
        version: 1,
        name: 'Transfer fixture procedure',
        description: 'The exact procedure used before the task was interrupted.',
        content: 'First revision',
        botId: 'bot_aster',
        roomId: 'room_lounge',
        readAt: '2026-11-06T00:00:00.000Z',
      },
    ]);
    assert.deepEqual(saved(db, 'operations', 'operation_fixture')!.args, {
      path: path.join(f.source, 'workspace', 'report.txt'),
    });
    assert.ok(db.prepare('SELECT 1 FROM dedup WHERE key=?').get('webhook:fixture:already-seen'));
    assert.equal(
      JSON.parse((db.prepare('SELECT data FROM events').get() as { data: string }).data).preserved,
      true,
    );
  } finally {
    db.close();
  }
  const transferredStore = new Store(f.stage);
  try {
    assert.deepEqual(
      transferredStore.list<Message>('messages').map((message) => message.id),
      messageOrder,
      'archive restoration preserves same-millisecond conversation order',
    );
  } finally {
    transferredStore.close();
  }
  const sessionText = await readFile(path.join(f.stage, f.sessions, 'new.jsonl'), 'utf8');
  const lineEnd = sessionText.indexOf('\n');
  const header = JSON.parse(sessionText.slice(0, lineEnd));
  assert.equal(header.cwd, path.join(f.destination, 'workspace'));
  assert.equal(header.parentSession, path.join(f.destination, f.sessions, 'old.jsonl'));
  assert.equal(sessionText.slice(lineEnd + 1), f.body);
  assert.ok(
    Math.abs((await stat(path.join(f.stage, f.sessions, 'new.jsonl'))).mtimeMs - f.newTime * 1000) <
      2,
  );
  assert.ok(
    Math.abs((await stat(path.join(f.stage, f.sessions, 'old.jsonl'))).mtimeMs - f.oldTime * 1000) <
      2,
  );
  const continued = SessionManager.continueRecent(
    path.join(f.destination, 'workspace'),
    path.join(f.stage, f.sessions),
  );
  assert.equal(continued.getSessionFile(), path.join(f.stage, f.sessions, 'new.jsonl'));
  const original = new DatabaseSync(path.join(f.source, 'loom.sqlite'), { readOnly: true });
  try {
    assert.equal(saved(original, 'automations', 'automation_fixture')!.enabled, true);
  } finally {
    original.close();
  }
});

test('external workspace containing dataDir copies the data tree once and excludes transfer jobs', async (t) => {
  const f = await fixture(t, true);
  await exportFixture(f);
  const capsule = await decodeArchive(f.archive);
  const externalRoot = capsule.manifest.externalWorkspaces[0]!;
  assert.equal(capsule.manifest.externalWorkspaces.length, 1);
  assert.equal(externalRoot.sourcePath, f.container);
  assert.equal(
    capsule.manifest.entries.some((entry) =>
      entry.path.startsWith(`external/${externalRoot.id}/data/`),
    ),
    false,
  );
  assert.equal(
    capsule.manifest.entries.some((entry) => entry.path.includes('.loom-transfer')),
    false,
  );
  await importFixture(f);
  assert.equal(
    await readFile(
      path.join(f.stage, 'imported-workspaces', externalRoot.id, 'nested', 'external.txt'),
      'utf8',
    ),
    'External workspace content',
  );
});

test('wrong passwords and altered authentication tags fail before extraction and clean temporary plaintext', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  await assert.rejects(importFixture(f, f.archive, 'wrong password 123456'), {
    code: 'archive_authentication_failed',
    statusCode: 400,
  });
  assert.equal(await exists(f.stage), false);
  const bytes = await readFile(f.archive);
  bytes[bytes.length - 1] ^= 1;
  const damaged = path.join(f.root, 'damaged.loom');
  await writeFile(damaged, bytes);
  await rejectedImport(f, damaged, /password is incorrect|damaged/);
});

test('authenticated path traversal, drive paths, duplicates, symlink parents and reserved state are rejected', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  for (const badPath of [
    'data/../../escape',
    '/tmp/escape',
    'C:\\escape',
    '\\\\server\\share\\escape',
    'data/workspace/CON.txt',
    'data/workspace/trailing.',
    'data/.loom-transfer/owner.lock',
  ]) {
    await t.test(badPath, async () => {
      const capsule = structuredClone(baseline) as Capsule;
      capsule.manifest.entries.find((entry) => entry.path === 'data/workspace/report.txt')!.path =
        badPath;
      const filename = path.join(f.root, 'attack.loom');
      await encodeArchive(filename, capsule);
      await rejectedImport(f, filename, /path|root|transfer jobs|collid/i);
    });
  }
  for (const duplicate of ['data/workspace/report.txt', 'data/workspace/REPORT.txt']) {
    const capsule = structuredClone(baseline) as Capsule;
    capsule.manifest.entries.push({
      path: duplicate,
      type: 'file',
      size: 0,
      mtime: 0,
      mode: 0o600,
    });
    const filename = path.join(f.root, 'duplicate.loom');
    await encodeArchive(filename, capsule);
    await rejectedImport(f, filename, /duplicate|collid/i);
  }
  const linkParent = structuredClone(baseline) as Capsule;
  const workspace = linkParent.manifest.entries.find((entry) => entry.path === 'data/workspace')!;
  workspace.type = 'symlink';
  workspace.target = 'data/pi';
  const filename = path.join(f.root, 'link-parent.loom');
  await encodeArchive(filename, linkParent);
  await rejectedImport(f, filename, /collid|non-directory|symbolic link/i);
});

test('archive limits reject oversized manifests, expanded sizes, file counts and browser preferences', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  const filename = path.join(f.root, 'limit.loom');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(DATA_TRANSFER_MAX_MANIFEST_BYTES + 1);
  await encryptPayload(filename, prefix);
  await rejectedImport(f, filename, /manifest.*limit/i, 413);
  const oversized = structuredClone(baseline) as Capsule;
  oversized.manifest.entries.find((entry) => entry.path === 'data/workspace/report.txt')!.size =
    DATA_TRANSFER_MAX_EXPANDED_BYTES;
  await encodeArchive(filename, oversized);
  await rejectedImport(f, filename, /expands|limit/i, 413);
  const many = structuredClone(baseline) as Capsule;
  many.manifest.entries = Array(DATA_TRANSFER_MAX_FILES + 1).fill(null);
  await encodeArchive(filename, many);
  await rejectedImport(f, filename, /many|limit/i, 413);
  assert.throws(() => validateDataTransferBrowserState({ 'loom.drafts': 'x'.repeat(1024 ** 2) }), {
    statusCode: 413,
  });
  assert.throws(() => validateDataTransferBrowserState({ 'unrelated.secret': 'never transfer' }), {
    statusCode: 400,
  });
  assert.throws(() => validateDataTransferPassword('short'), { statusCode: 400 });
  assert.throws(() => validateDataTransferPassword('ä'.repeat(513)), { statusCode: 400 });
  assert.doesNotThrow(() => validateDataTransferPassword('ä'.repeat(512)));
});

test('import refuses invalid bot browser bindings and browser pool limits', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  const filename = path.join(f.root, 'invalid-browser.loom');
  for (const invalid of [
    { kind: 'bots', id: 'bot_nova', browser: { mode: 'remote' } },
    {
      kind: 'bots',
      id: 'bot_nova',
      browser: { mode: 'dedicated', profileDir: '/another-profile' },
    },
    {
      kind: 'settings',
      id: 'main',
      browser: {
        enabled: true,
        mode: 'dedicated',
        permission: 'allow',
        includeScreenshotsInModel: false,
        maxConcurrentBrowsers: 0,
      },
    },
  ]) {
    const capsule = structuredClone(baseline) as Capsule;
    await mutateDatabase(f, capsule, (db) => {
      const record = saved(db, invalid.kind, invalid.id)!;
      db.prepare('UPDATE objects SET data=? WHERE kind=? AND id=?').run(
        JSON.stringify({ ...record, browser: invalid.browser }),
        invalid.kind,
        invalid.id,
      );
    });
    await encodeArchive(filename, capsule);
    await rejectedImport(f, filename, /Chrome settings/);
  }
});

test('import validates Chrome upload budgets and preserves legacy omissions', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  const filename = path.join(f.root, 'browser-uploads.loom');
  for (const patch of [
    { uploadMaxFiles: 0 },
    { uploadMaxFiles: 101 },
    { uploadMaxFiles: 1.5 },
    { uploadMaxFileMiB: 1025 },
    { uploadMaxTotalMiB: 2049 },
    { uploadStorageMiB: 32769 },
    { uploadMaxFileMiB: null },
    { uploadMaxTotalMiB: '512' },
    { uploadStorageMiB: true },
    { uploadMaxFiles: [] },
    { uploadMaxTotalMiB: 300 },
    { uploadStorageMiB: 512 },
    { uploadMaxBytes: 1024 },
  ]) {
    const capsule = structuredClone(baseline) as Capsule;
    await mutateDatabase(f, capsule, (db) => {
      const record = saved(db, 'settings', 'main')!;
      const browser = { ...(record.browser as Record<string, unknown>), ...patch };
      db.prepare("UPDATE objects SET data=? WHERE kind='settings' AND id='main'").run(
        JSON.stringify({ ...record, browser }),
      );
    });
    await encodeArchive(filename, capsule);
    await rejectedImport(f, filename, /Chrome settings/);
  }
  const legacy = structuredClone(baseline) as Capsule;
  await mutateDatabase(f, legacy, (db) => {
    const record = saved(db, 'settings', 'main')!;
    const browser = { ...(record.browser as Record<string, unknown>) };
    for (const key of Object.keys(DEFAULT_BROWSER_UPLOAD_SETTINGS)) delete browser[key];
    db.prepare("UPDATE objects SET data=? WHERE kind='settings' AND id='main'").run(
      JSON.stringify({ ...record, browser }),
    );
  });
  await encodeArchive(filename, legacy);
  await importFixture(f, filename);
  const db = new DatabaseSync(path.join(f.stage, 'loom.sqlite'), { readOnly: true });
  try {
    const browser = saved(db, 'settings', 'main')!.browser as BrowserSettings;
    for (const key of Object.keys(DEFAULT_BROWSER_UPLOAD_SETTINGS))
      assert.equal(Object.hasOwn(browser, key), false);
    assert.deepEqual(browserUploadSettings(browser), DEFAULT_BROWSER_UPLOAD_SETTINGS);
  } finally {
    db.close();
  }
});

test('import rejects malformed autonomous policies, checkpoints and schedules before replacement', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  const filename = path.join(f.root, 'invalid-autonomous-work.loom');
  for (const invalid of [
    {
      kind: 'rooms',
      id: 'room_lounge',
      patch: { autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'unrestricted' } },
    },
    {
      kind: 'workItems',
      id: 'work_fixture',
      patch: { checkpoint: { summary: 'Missing uncertainty state and completion condition' } },
    },
    {
      kind: 'wakeups',
      id: 'wake_fixture',
      patch: {
        schedule: {
          type: 'once',
          dateTime: 'invalid',
          timeZone: 'UTC',
          missedRunPolicy: 'run_once',
        },
      },
    },
  ]) {
    const capsule = structuredClone(baseline) as Capsule;
    await mutateDatabase(f, capsule, (db) => {
      const record = saved(db, invalid.kind, invalid.id)!;
      db.prepare('UPDATE objects SET data=? WHERE kind=? AND id=?').run(
        JSON.stringify({ ...record, ...invalid.patch }),
        invalid.kind,
        invalid.id,
      );
    });
    await encodeArchive(filename, capsule);
    await rejectedImport(f, filename, /invalid autonomous/);
  }
});

test('import rejects forged priority allowances and malformed grant references', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  const filename = path.join(f.root, 'invalid-task-scheduling.loom');
  for (const scheduling of [
    { grant: { ...SCHEDULING_GRANT, remainingRequests: 4 } },
    { grant: { ...SCHEDULING_GRANT, source: 'bot' } },
    { grant: { ...SCHEDULING_GRANT, source: ['bot'], grantedRequests: 1 } },
    { grant: { ...SCHEDULING_GRANT, expiresAt: '2099-01-01T00:00:00.000Z' } },
    { grant: { ...SCHEDULING_GRANT, revokedAt: '2026-11-09T00:01:00.000Z' } },
    { grant: SCHEDULING_GRANT, grantRedirect: { taskId: 'task_fixture' } },
  ]) {
    const capsule = structuredClone(baseline) as Capsule;
    await mutateDatabase(f, capsule, (db) => {
      const task = saved(db, 'tasks', 'task_fixture')!;
      db.prepare('UPDATE objects SET data=? WHERE kind=? AND id=?').run(
        JSON.stringify({ ...task, scheduling }),
        'tasks',
        'task_fixture',
      );
    });
    await encodeArchive(filename, capsule);
    await rejectedImport(f, filename, /invalid task scheduling metadata/);
  }
});

test('import refuses invalid model timeout budgets and image-input flags', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  const filename = path.join(f.root, 'invalid-model-timeouts.loom');
  for (const invalid of [
    { responseTimeoutSeconds: 0 },
    { idleTimeoutSeconds: 86_401 },
    { imageInput: 'true' },
    { imageInput: null },
  ]) {
    const capsule = structuredClone(baseline) as Capsule;
    await mutateDatabase(f, capsule, (db) => {
      const record = saved(db, 'settings', 'main')!;
      const model = { ...(record.model as Record<string, unknown>), ...invalid };
      db.prepare("UPDATE objects SET data=? WHERE kind='settings' AND id='main'").run(
        JSON.stringify({ ...record, model }),
      );
    });
    await encodeArchive(filename, capsule);
    await rejectedImport(f, filename, /settings/);
  }
});

test('import refuses invalid image permissions without coercing them to allowed values', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  const filename = path.join(f.root, 'invalid-image-permissions.loom');
  for (const permission of ['auto', 'invalid', null, ['allow']]) {
    const capsule = structuredClone(baseline) as Capsule;
    await mutateDatabase(f, capsule, (db) => {
      const record = saved(db, 'settings', 'main')!;
      const images = { ...(record.images as Record<string, unknown>), permission };
      db.prepare("UPDATE objects SET data=? WHERE kind='settings' AND id='main'").run(
        JSON.stringify({ ...record, images }),
      );
    });
    await encodeArchive(filename, capsule);
    await rejectedImport(f, filename, /image permission settings/);
  }
});

test('import validates explicit image timeout budgets while allowing legacy omission', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  const filename = path.join(f.root, 'image-timeouts.loom');
  for (const timeoutSeconds of [9, 86_401, 10.5, null, '3600']) {
    const capsule = structuredClone(baseline) as Capsule;
    await mutateDatabase(f, capsule, (db) => {
      const record = saved(db, 'settings', 'main')!;
      const images = { ...(record.images as Record<string, unknown>), timeoutSeconds };
      db.prepare("UPDATE objects SET data=? WHERE kind='settings' AND id='main'").run(
        JSON.stringify({ ...record, images }),
      );
    });
    await encodeArchive(filename, capsule);
    await rejectedImport(f, filename, /image.*timeout/);
  }
  const legacy = structuredClone(baseline) as Capsule;
  await mutateDatabase(f, legacy, (db) => {
    const record = saved(db, 'settings', 'main')!;
    const images = { ...(record.images as Record<string, unknown>) };
    delete images.timeoutSeconds;
    db.prepare("UPDATE objects SET data=? WHERE kind='settings' AND id='main'").run(
      JSON.stringify({ ...record, images }),
    );
  });
  await encodeArchive(filename, legacy);
  await importFixture(f, filename);
  const db = new DatabaseSync(path.join(f.stage, 'loom.sqlite'), { readOnly: true });
  try {
    const images = saved(db, 'settings', 'main')!.images as Record<string, unknown>;
    assert.equal(Object.hasOwn(images, 'timeoutSeconds'), false);
    assert.equal(images.size, '2048x2048');
    assert.equal(images.shareInferenceSlot, false);
  } finally {
    db.close();
  }
});

test('import validates image step counts and transport choices while preserving server-default and legacy settings', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  const filename = path.join(f.root, 'image-steps.loom');
  for (const patch of [
    ...[0, 1001, 1.5, '40', true].map((steps) => ({ steps })),
    ...['unsupported', null, ['steps']].map((stepsParameter) => ({ stepsParameter })),
  ]) {
    const capsule = structuredClone(baseline) as Capsule;
    await mutateDatabase(f, capsule, (db) => {
      const record = saved(db, 'settings', 'main')!;
      const images = { ...(record.images as Record<string, unknown>), ...patch };
      db.prepare("UPDATE objects SET data=? WHERE kind='settings' AND id='main'").run(
        JSON.stringify({ ...record, images }),
      );
    });
    await encodeArchive(filename, capsule);
    await rejectedImport(f, filename, /image generation step/);
  }
  for (const legacy of [false, true]) {
    const capsule = structuredClone(baseline) as Capsule;
    await mutateDatabase(f, capsule, (db) => {
      const record = saved(db, 'settings', 'main')!;
      const images = { ...(record.images as Record<string, unknown>), steps: null };
      if (legacy) {
        delete (images as Record<string, unknown>).steps;
        delete (images as Record<string, unknown>).stepsParameter;
      }
      db.prepare("UPDATE objects SET data=? WHERE kind='settings' AND id='main'").run(
        JSON.stringify({ ...record, images }),
      );
    });
    await encodeArchive(filename, capsule);
    await importFixture(f, filename);
    const db = new DatabaseSync(path.join(f.stage, 'loom.sqlite'), { readOnly: true });
    try {
      const images = saved(db, 'settings', 'main')!.images as Record<string, unknown>;
      assert.equal(images.steps, legacy ? undefined : null);
      assert.equal(images.stepsParameter, legacy ? undefined : 'sd_cpp_extra_args');
      assert.equal(images.size, '2048x2048');
    } finally {
      db.close();
    }
    await rm(f.stage, { recursive: true, force: true });
  }
});

test('import rejects malformed chat image identities and editing provenance', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  const filename = path.join(f.root, 'invalid-image-metadata.loom');
  const cases = [
    { kind: 'tasks', id: 'task_reply_fixture', patch: { inputImageIds: ['../outside.png'] } },
    {
      kind: 'tasks',
      id: 'task_reply_fixture',
      patch: { inputImageIds: [UPLOADED_IMAGE.id, UPLOADED_IMAGE.id] },
    },
    { kind: 'images', id: UPLOADED_IMAGE.id, patch: { source: ['uploaded'] } },
    {
      kind: 'images',
      id: EDITED_IMAGE.id,
      patch: {
        inputImages: [
          { role: 'source', path: 'https://example.com/image.png', sha256: '3'.repeat(64) },
        ],
      },
    },
    {
      kind: 'images',
      id: EDITED_IMAGE.id,
      patch: {
        inputImages: [{ role: 'reference', imageId: UPLOADED_IMAGE.id, sha256: '3'.repeat(64) }],
      },
    },
  ];
  for (const change of cases) {
    const capsule = structuredClone(baseline) as Capsule;
    await mutateDatabase(f, capsule, (db) => {
      const record = saved(db, change.kind, change.id)!;
      db.prepare('UPDATE objects SET data=? WHERE kind=? AND id=?').run(
        JSON.stringify({ ...record, ...change.patch }),
        change.kind,
        change.id,
      );
    });
    await encodeArchive(filename, capsule);
    await rejectedImport(f, filename, /invalid image input or provenance/);
  }
});

test('import rejects broken task-input receipts, owner-message links and superseded approval metadata', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  const filename = path.join(f.root, 'invalid-task-input.loom');
  const cases = [
    { kind: 'taskInputs', id: PENDING_TASK_INPUT.id, patch: { roomId: 'room_other' } },
    { kind: 'taskInputs', id: PENDING_TASK_INPUT.id, patch: { botId: 'bot_nova' } },
    { kind: 'taskInputs', id: PENDING_TASK_INPUT.id, patch: { taskId: 'missing-task' } },
    {
      kind: 'taskInputs',
      id: PENDING_TASK_INPUT.id,
      patch: { body: 'Changed without its owner message.' },
    },
    { kind: 'taskInputs', id: PENDING_TASK_INPUT.id, patch: { mode: ['immediate'] } },
    { kind: 'taskInputs', id: PENDING_TASK_INPUT.id, patch: { requestFingerprint: 'unkeyed' } },
    { kind: 'taskInputs', id: PENDING_TASK_INPUT.id, patch: { inputImageIds: [EDITED_IMAGE.id] } },
    { kind: 'taskInputs', id: DELIVERED_TASK_INPUT.id, patch: { deliveredAt: undefined } },
    {
      kind: 'taskInputs',
      id: DELIVERED_TASK_INPUT.id,
      patch: { sequence: PENDING_TASK_INPUT.sequence },
    },
    {
      kind: 'messages',
      id: PENDING_TASK_INPUT.messageId,
      patch: { taskInputId: 'missing-receipt' },
    },
    {
      kind: 'messages',
      id: PENDING_TASK_INPUT.messageId,
      patch: { authorType: 'bot', authorId: 'bot_aster' },
    },
    { kind: 'messages', id: PENDING_TASK_INPUT.messageId, patch: { attachments: [] } },
    { kind: 'approvals', id: 'approval_superseded_fixture', patch: { status: 'denied' } },
  ];
  for (const change of cases) {
    const capsule = structuredClone(baseline) as Capsule;
    await mutateDatabase(f, capsule, (db) => {
      const record = saved(db, change.kind, change.id)!;
      db.prepare('UPDATE objects SET data=? WHERE kind=? AND id=?').run(
        JSON.stringify({ ...record, ...change.patch }),
        change.kind,
        change.id,
      );
    });
    await encodeArchive(filename, capsule);
    await rejectedImport(f, filename, /invalid additional-instruction/);
  }
});

test('import rejects a task-input queue above the pending bound without discarding its entries', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const capsule = await decodeArchive(f.archive);
  const filename = path.join(f.root, 'excessive-task-inputs.loom');
  await mutateDatabase(f, capsule, (db) => {
    const message = saved(db, 'messages', PENDING_TASK_INPUT.messageId)!;
    const insert = db.prepare(
      'INSERT INTO objects(kind,id,data,created_at,updated_at) VALUES(?,?,?,?,?)',
    );
    for (let sequence = 3; sequence <= 34; sequence++) {
      const suffix = String(sequence).padStart(12, '0');
      const input = {
        ...PENDING_TASK_INPUT,
        id: 'taskinput_01900000000040008000' + suffix,
        requestId: '01900000-0000-4000-8000-' + suffix,
        messageId: 'excessive-input-message-' + sequence,
        sequence,
      };
      insert.run('taskInputs', input.id, JSON.stringify(input), input.createdAt, input.createdAt);
      insert.run(
        'messages',
        input.messageId,
        JSON.stringify({ ...message, id: input.messageId, taskInputId: input.id }),
        input.createdAt,
        input.createdAt,
      );
    }
  });
  await encodeArchive(filename, capsule);
  await rejectedImport(f, filename, /invalid additional-instruction ordering or limits/);
});

test('import refuses ambiguous or invalid user-directed message metadata', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  const filename = path.join(f.root, 'invalid-user-message.loom');
  for (const patch of [
    { targetUser: 'true' },
    { targetUser: true, authorType: 'user' },
    { targetUser: true, targetBotIds: ['bot_nova'] },
  ]) {
    const capsule = structuredClone(baseline) as Capsule;
    await mutateDatabase(f, capsule, (db) => {
      const record = saved(db, 'messages', 'message_owner_fixture')!;
      db.prepare("UPDATE objects SET data=? WHERE kind='messages' AND id=?").run(
        JSON.stringify({ ...record, ...patch }),
        'message_owner_fixture',
      );
    });
    await encodeArchive(filename, capsule);
    await rejectedImport(f, filename, /invalid user-directed message/);
  }
});

test('import refuses malformed notification attribution and contradictory reply references', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  const filename = path.join(f.root, 'invalid-notification-context.loom');
  type Change = { kind: string; id: string; patch: Record<string, unknown> };
  const cases: Array<Change | Change[]> = [
    {
      kind: 'notifications',
      id: NOTICE_REPLY.notificationId,
      patch: { sender: { kind: 'bot', botId: 'bot_nova', name: 'Nova', handle: 'nova' } },
    },
    {
      kind: 'notifications',
      id: NOTICE_REPLY.notificationId,
      patch: { sender: { kind: 'system', botId: 'bot_aster' } },
    },
    {
      kind: 'tasks',
      id: 'task_reply_fixture',
      patch: { notificationReply: { ...NOTICE_REPLY, body: 'x'.repeat(12_001) } },
    },
    {
      kind: 'tasks',
      id: 'task_reply_fixture',
      patch: {
        roomId: 'room_external',
        notificationReply: { ...NOTICE_REPLY, roomId: 'room_external' },
      },
    },
    {
      kind: 'tasks',
      id: 'task_reply_fixture',
      patch: {
        notificationReply: { ...NOTICE_REPLY, notificationId: 'notification_system_fixture' },
      },
    },
    {
      kind: 'messages',
      id: 'message_reply_fixture',
      patch: { targetBotIds: ['bot_nova'] },
    },
    [
      {
        kind: 'notifications',
        id: NOTICE_REPLY.notificationId,
        patch: { taskId: undefined },
      },
      {
        kind: 'tasks',
        id: 'task_reply_fixture',
        patch: { notificationReply: { ...NOTICE_REPLY, taskId: undefined } },
      },
      {
        kind: 'messages',
        id: 'message_reply_fixture',
        patch: { notificationReply: { ...NOTICE_REPLY, taskId: undefined } },
      },
      {
        kind: 'messages',
        id: NOTICE_REPLY.messageId!,
        patch: { taskId: 'task_external' },
      },
    ],
  ];
  for (const changes of cases) {
    const capsule = structuredClone(baseline) as Capsule;
    await mutateDatabase(f, capsule, (db) => {
      for (const { kind, id, patch } of Array.isArray(changes) ? changes : [changes]) {
        const record = saved(db, kind, id)!;
        db.prepare('UPDATE objects SET data=? WHERE kind=? AND id=?').run(
          JSON.stringify({ ...record, ...patch }),
          kind,
          id,
        );
      }
    });
    await encodeArchive(filename, capsule);
    await rejectedImport(f, filename, /invalid notification/);
  }
});

test('notification transfer keeps legacy unknown senders and saved replies after source deletion', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const capsule = await decodeArchive(f.archive);
  await mutateDatabase(f, capsule, (db) => {
    for (const [kind, id] of [
      ['notifications', NOTICE_REPLY.notificationId],
      ['messages', NOTICE_REPLY.messageId!],
      ['tasks', NOTICE_REPLY.taskId!],
      ['bots', NOTICE_REPLY.botId],
    ])
      db.prepare('DELETE FROM objects WHERE kind=? AND id=?').run(kind, id);
  });
  const filename = path.join(f.root, 'historical-notification-context.loom');
  await encodeArchive(filename, capsule);
  await importFixture(f, filename);
  const db = new DatabaseSync(path.join(f.stage, 'loom.sqlite'), { readOnly: true });
  try {
    assert.equal(saved(db, 'notifications', 'notification_legacy_fixture')!.sender, undefined);
    assert.equal(saved(db, 'notifications', NOTICE_REPLY.notificationId), undefined);
    assert.deepEqual(saved(db, 'tasks', 'task_reply_fixture')!.notificationReply, NOTICE_REPLY);
    assert.deepEqual(
      saved(db, 'messages', 'message_reply_fixture')!.notificationReply,
      NOTICE_REPLY,
    );
  } finally {
    db.close();
  }
});

test('future versions, unknown SQLite schema, invalid settings and mismatched encryption keys are refused', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  const future = structuredClone(baseline) as Capsule;
  future.manifest.version = '999.0.0';
  const filename = path.join(f.root, 'invalid.loom');
  await encodeArchive(filename, future);
  await rejectedImport(f, filename, /newer|unsupported/);
  for (const sql of [
    'CREATE TABLE unknown_table(value TEXT)',
    'CREATE VIEW unsafe_view AS SELECT * FROM secrets',
    'CREATE TRIGGER unsafe_trigger AFTER UPDATE ON objects BEGIN DELETE FROM secrets; END',
    'PRAGMA user_version=999',
  ]) {
    const capsule = structuredClone(baseline) as Capsule;
    await mutateDatabase(f, capsule, (db) => db.exec(sql));
    await encodeArchive(filename, capsule);
    await rejectedImport(f, filename, /unsupported|version/);
  }
  const settings = structuredClone(baseline) as Capsule;
  await mutateDatabase(f, settings, (db) =>
    db
      .prepare("UPDATE objects SET data=? WHERE kind='settings' AND id='main'")
      .run('{"id":"main","model":null}'),
  );
  await encodeArchive(filename, settings);
  await rejectedImport(f, filename, /settings/);
  const wrongKey = structuredClone(baseline) as Capsule;
  const keyIndex = wrongKey.manifest.entries
    .filter((entry) => entry.type === 'file')
    .findIndex((entry) => entry.path === 'data/secret.key');
  wrongKey.bodies[keyIndex] = randomBytes(32);
  await encodeArchive(filename, wrongKey);
  await rejectedImport(f, filename, /key.*credentials/);
});

test('Windows drive and UNC paths rebase into the destination with canonical stored filename case', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const baseline = await decodeArchive(f.archive);
  for (const sourceRoot of [
    'C:\\Users\\Owner\\Agent Loom\\.loom',
    '\\\\server\\share\\Agent Loom\\data',
  ]) {
    await t.test(sourceRoot, async () => {
      const capsule = structuredClone(baseline) as Capsule;
      const externalRoot = 'D:\\Documents\\Agent Work';
      const convert = (value: string) => {
        const relative = path.relative(f.source, value);
        if (
          relative === '' ||
          (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
        )
          return path.win32.join(sourceRoot, ...relative.split(path.sep));
        const externalRelative = path.relative(f.external, value);
        if (
          externalRelative === '' ||
          (externalRelative !== '..' &&
            !externalRelative.startsWith('..' + path.sep) &&
            !path.isAbsolute(externalRelative))
        )
          return path.win32.join(externalRoot, ...externalRelative.split(path.sep));
        throw new Error('Unexpected fixture path');
      };
      capsule.manifest.platform = 'win32';
      capsule.manifest.dataDir = sourceRoot;
      capsule.manifest.workspaces = capsule.manifest.workspaces.map(convert);
      for (const root of capsule.manifest.externalWorkspaces) {
        const previousId = root.id;
        root.sourcePath = convert(root.sourcePath);
        root.id = createHash('sha256')
          .update(`win32\0${path.win32.normalize(root.sourcePath).toLowerCase()}`)
          .digest('hex')
          .slice(0, 24);
        for (const entry of capsule.manifest.entries)
          if (
            entry.path === `external/${previousId}` ||
            entry.path.startsWith(`external/${previousId}/`)
          )
            entry.path = `external/${root.id}${entry.path.slice(`external/${previousId}`.length)}`;
      }
      await mutateDatabase(f, capsule, (db) => {
        const rows = db
          .prepare(
            "SELECT kind,id,data FROM objects WHERE kind IN ('settings','rooms','tasks','workItems')",
          )
          .all() as Array<{ kind: string; id: string; data: string }>;
        const update = db.prepare('UPDATE objects SET data=? WHERE kind=? AND id=?');
        for (const row of rows) {
          const value = JSON.parse(row.data);
          if (value.workspacePath) value.workspacePath = convert(value.workspacePath).toUpperCase();
          update.run(JSON.stringify(value), row.kind, row.id);
        }
      });
      let index = 0;
      for (const entry of capsule.manifest.entries) {
        if (entry.type !== 'file') continue;
        if (entry.path.startsWith('data/sessions/') && entry.path.endsWith('.jsonl')) {
          const text = Buffer.from(capsule.bodies[index]!).toString();
          const newline = text.indexOf('\n');
          const header = JSON.parse(text.slice(0, newline));
          header.cwd = convert(header.cwd).toUpperCase();
          if (header.parentSession)
            header.parentSession = convert(header.parentSession).toUpperCase();
          capsule.bodies[index] = Buffer.from(JSON.stringify(header) + text.slice(newline));
          entry.size = capsule.bodies[index]!.length;
        }
        index++;
      }
      const filename = path.join(f.root, 'windows.loom');
      await encodeArchive(filename, capsule);
      const preview = await importFixture(f, filename);
      assert.equal(preview.platform, 'win32');
      const db = new DatabaseSync(path.join(f.stage, 'loom.sqlite'), { readOnly: true });
      try {
        assert.equal(
          saved(db, 'settings', 'main')!.workspacePath,
          path.join(f.destination, 'workspace'),
        );
        assert.equal(
          saved(db, 'tasks', 'task_fixture')!.workspacePath,
          path.join(f.destination, 'workspace'),
        );
      } finally {
        db.close();
      }
      const text = await readFile(path.join(f.stage, f.sessions, 'new.jsonl'), 'utf8');
      const header = JSON.parse(text.split('\n')[0]!);
      assert.equal(header.cwd, path.join(f.destination, 'workspace'));
      assert.equal(header.parentSession, path.join(f.destination, f.sessions, 'old.jsonl'));
      assert.equal(text.slice(text.indexOf('\n') + 1), f.body);
      await rm(f.stage, { recursive: true, force: true });
    });
  }
});

test('internal single-hop links survive; outside, dangling and chained links are not followed', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'outside.txt'), 'Outside link content must never be copied');
  try {
    await symlink(
      path.join('workspace', 'report.txt'),
      path.join(f.source, 'shortcut.txt'),
      'file',
    );
    await symlink('workspace', path.join(f.source, 'linked-dir'), 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(String((error as NodeJS.ErrnoException).code))) {
      t.skip('This host does not allow creating symbolic links.');
      return;
    }
    throw error;
  }
  await symlink(path.join(f.root, 'outside.txt'), path.join(f.source, 'outside-link'), 'file');
  await symlink('shortcut.txt', path.join(f.source, 'chained-link'), 'file');
  await symlink('missing-target', path.join(f.source, 'dangling-link'), 'file');
  await symlink('.', path.join(f.external, 'same-root'), 'dir');
  const source = new Store(f.source);
  try {
    source.put('rooms', { id: 'alias_room', workspacePath: path.join(f.source, 'linked-dir') });
  } finally {
    source.close();
  }
  const exported = await exportFixture(f);
  assert.ok(exported.warnings.some((warning) => warning.includes('outside-link')));
  assert.ok(exported.warnings.some((warning) => warning.includes('chained-link')));
  assert.ok(exported.warnings.some((warning) => warning.includes('dangling-link')));
  const capsule = await decodeArchive(f.archive);
  assert.equal(
    capsule.bodies.some((body) =>
      body.includes(Buffer.from('Outside link content must never be copied')),
    ),
    false,
  );
  await importFixture(f);
  assert.equal((await lstat(path.join(f.stage, 'shortcut.txt'))).isSymbolicLink(), true);
  assert.equal(path.isAbsolute(await readlink(path.join(f.stage, 'shortcut.txt'))), false);
  assert.equal(await readFile(path.join(f.stage, 'shortcut.txt'), 'utf8'), 'Workspace report');
  assert.equal(
    await readFile(path.join(f.stage, 'linked-dir', 'report.txt'), 'utf8'),
    'Workspace report',
  );
  assert.equal(await exists(path.join(f.stage, 'outside-link')), false);
  const importedRoot = path.join(
    f.stage,
    'imported-workspaces',
    capsule.manifest.externalWorkspaces[0]!.id,
  );
  assert.equal(await readlink(path.join(importedRoot, 'same-root')), '.');
  assert.equal(
    await readFile(path.join(importedRoot, 'same-root', 'top.txt'), 'utf8'),
    'External root content',
  );
  const db = new DatabaseSync(path.join(f.stage, 'loom.sqlite'), { readOnly: true });
  try {
    assert.equal(
      saved(db, 'rooms', 'alias_room')!.workspacePath,
      path.join(f.destination, 'linked-dir'),
    );
  } finally {
    db.close();
  }
});

test('new external workspaces cannot merge with an existing imported-workspaces directory', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const capsule = await decodeArchive(f.archive);
  const root = capsule.manifest.externalWorkspaces[0]!;
  capsule.manifest.entries.push(
    { path: 'data/imported-workspaces', type: 'directory', size: 0, mtime: 0, mode: 0o700 },
    {
      path: `data/imported-workspaces/${root.id}`,
      type: 'directory',
      size: 0,
      mtime: 0,
      mode: 0o700,
    },
  );
  const filename = path.join(f.root, 'collision.loom');
  await encodeArchive(filename, capsule);
  await rejectedImport(f, filename, /collid|workspace/);
});

test('inferred parents of malicious deep paths are bounded even when the manifest is small', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const capsule = await decodeArchive(f.archive);
  // Each file has 61 missing parents. Serialized JSON remains well below 16 MiB;
  // the inferred destination tree would otherwise grow independently of that cap.
  for (let index = 0; index < 3300; index++) {
    capsule.manifest.entries.push({
      path: `data/missing-${index}/${Array.from({ length: 60 }, (_, depth) => `d${depth}`).join('/')}/leaf`,
      type: 'file',
      size: 0,
      mtime: 0,
      mode: 0o600,
    });
  }
  assert.ok(Buffer.byteLength(JSON.stringify(capsule.manifest)) < DATA_TRANSFER_MAX_MANIFEST_BYTES);
  const filename = path.join(f.root, 'deep.loom');
  await encodeArchive(filename, capsule);
  await rejectedImport(f, filename, /too many.*parent|count|limit/i, 413);
  const workspaceOnly = await decodeArchive(f.archive);
  for (let index = 0; index < 3300; index++) {
    workspaceOnly.manifest.workspaces.push(
      path.join(
        f.source,
        `missing-${index}`,
        ...Array.from({ length: 60 }, (_, depth) => `d${depth}`),
      ),
    );
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(workspaceOnly.manifest)) < DATA_TRANSFER_MAX_MANIFEST_BYTES,
  );
  await encodeArchive(filename, workspaceOnly);
  await rejectedImport(f, filename, /too many.*workspace|count|limit/i, 413);
});

test('oversized SQLite values are rejected before loading or parsing saved JSON', async (t) => {
  const f = await fixture(t);
  await exportFixture(f);
  const capsule = await decodeArchive(f.archive);
  await mutateDatabase(f, capsule, (db) => {
    db.prepare(
      "UPDATE objects SET data=CAST(zeroblob(?) AS TEXT) WHERE kind='memories' AND id='memory_fixture'",
    ).run(DATA_TRANSFER_MAX_RECORD_BYTES + 1);
  });
  const filename = path.join(f.root, 'large-record.loom');
  await encodeArchive(filename, capsule);
  await rejectedImport(f, filename, /oversized database record/i, 413);
});
