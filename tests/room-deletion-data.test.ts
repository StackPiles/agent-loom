import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Store } from '../src/server/store.js';
import {
  planRoomDeletion,
  purgeRoomData,
  type RoomDeletionPlan,
} from '../src/server/room-deletion-data.js';
import {
  createSessionImageStore,
  retainedSessionImageHashes,
} from '../src/server/runtime/session-images.js';
import { LEARNING_ROOM_MIGRATION_AUDIT_KIND } from '../src/server/learning-room-migration.js';
import { SERVICE_ROOM_MIGRATION_AUDIT_KIND } from '../src/server/service-room-migration.js';
import type { Room, Task } from '../src/shared/types.js';

const stamp = '2026-11-15T10:00:00.000Z';
const diskKey = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const image = (digit: string) => `img_${digit.repeat(64)}`;
const asset = (value: string) => createHash('sha256').update(value).digest('hex');
const ref = (value: string) => `loom-image:v1:sha256:${asset(value)}:${Buffer.byteLength(value)}`;
const imageEntry = (...refs: string[]) =>
  JSON.stringify({
    type: 'message',
    message: { content: refs.map((data) => ({ type: 'image', mimeType: 'image/png', data })) },
  });

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-room-delete-'));
  let store = new Store(directory);
  store.seed();
  const room = store.get<Room>('rooms', 'room_lounge')!;
  store.put('rooms', { ...room, id: 'room_b', name: 'Other room' });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new Store(directory);
    },
    file(parts: string, contents: string) {
      const filename = join(directory, ...parts.split('/'));
      mkdirSync(join(filename, '..'), { recursive: true });
      writeFileSync(filename, contents);
      return filename;
    },
  };
}

function task(store: Store, id: string, roomId = 'room_lounge', kind: Task['kind'] = 'chat') {
  return store.put<Task>('tasks', {
    id,
    roomId,
    botId: 'bot_aster',
    kind,
    prompt: id,
    status: 'completed',
    output: 'saved output',
    rootTaskId: id,
    depth: 0,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: stamp,
    updatedAt: stamp,
  });
}

test('purge removes exact room ownership, dependent records, secrets and migration originals while preserving shared registries', async (t) => {
  const f = await fixture(t);
  const { store } = f;
  task(store, 'task_a');
  task(store, 'task_b', 'room_b');
  const directKinds = [
    'messages',
    'taskInputs',
    'activities',
    'approvals',
    'notifications',
    'automations',
    'workItems',
    'wakeups',
    'memories',
    'skills',
    'serviceAccounts',
  ];
  for (const kind of directKinds) {
    store.put(kind, {
      id: `${kind}_a`,
      roomId: 'room_lounge',
      taskId: 'task_a',
      content: 'private room data',
    });
    store.put(kind, {
      id: `${kind}_b`,
      roomId: 'room_b',
      taskId: 'task_b',
      content: 'other room data',
    });
  }
  for (const kind of ['memories', 'skills', 'serviceAccounts'])
    store.put(kind, {
      id: `${kind}_shared`,
      roomId: null,
      sourceTaskId: 'task_a',
      content: 'intentionally shared',
    });
  store.put('operations', { id: 'op_a', taskId: 'task_a', result: 'private result' });
  store.put('operations', { id: 'op_b', taskId: 'task_b', result: 'other result' });
  store.put('notifications', {
    id: 'old_notification',
    taskId: 'task_a',
    body: 'old private notification',
  });
  store.put('notifications', {
    id: 'message_notification',
    messageId: 'messages_a',
    body: 'private reply',
  });
  store.put('notifications', {
    id: 'conflicting_notification',
    roomId: 'room_b',
    taskId: 'task_a',
    body: 'keep other scope',
  });
  store.put('automationState', { id: 'automations_a', pendingWebhooks: ['private event'] });
  store.put('automationState', { id: 'automations_b', pendingWebhooks: ['other event'] });
  for (const [id, collection] of [
    ['audit_memory_a', 'memories'],
    ['audit_skill_a', 'skills'],
  ] as const)
    store.put(LEARNING_ROOM_MIGRATION_AUDIT_KIND, {
      id,
      collection,
      recordId: `${collection}_a`,
      roomId: 'room_b',
      original: { content: 'original private data' },
    });
  store.put(LEARNING_ROOM_MIGRATION_AUDIT_KIND, {
    id: 'audit_shared',
    collection: 'memories',
    recordId: 'memories_shared',
    roomId: 'room_lounge',
    original: { content: 'shared original' },
  });
  store.put(LEARNING_ROOM_MIGRATION_AUDIT_KIND, {
    id: 'audit_moved',
    collection: 'memories',
    recordId: 'memories_b',
    roomId: 'room_lounge',
    original: { content: 'owner reassigned this' },
  });
  store.put(SERVICE_ROOM_MIGRATION_AUDIT_KIND, {
    id: 'audit_service_a',
    recordId: 'serviceAccounts_a',
    roomId: 'room_lounge',
    original: { login: 'private login' },
  });
  store.put(SERVICE_ROOM_MIGRATION_AUDIT_KIND, {
    id: 'audit_service_shared',
    recordId: 'serviceAccounts_shared',
    roomId: 'room_lounge',
    original: { login: 'shared login' },
  });
  store.put('mailAccounts', { id: 'mail_account', botIds: ['bot_aster'] });
  store.put('mailDrafts', {
    id: 'draft',
    botId: 'bot_aster',
    accountId: 'mail_account',
    text: 'shared mailbox draft',
  });
  store.put('mailSends', { id: 'send', draftId: 'draft', status: 'sent' });
  for (const name of [
    'service.serviceAccounts_a.credential',
    'imap.automations_a.password',
    'hook.automations_a',
    'service.serviceAccounts_b.credential',
    'mail.mail_account.imap',
    'model.apiKey',
  ])
    store.setSecret(name, 'kept encrypted');
  for (const key of [
    'webhook:automations_a:event',
    'mail-event:automations_a:source:event',
    'webhook:automations_a_extra:event',
    'webhook:automations_b:event',
  ])
    store.remember(key);
  const ownEvent = store.event('reply', { roomId: 'room_lounge', body: 'private body' });
  const taskEvent = store.event('operation', { taskId: 'task_a' });
  const otherEvent = store.event('reply', { roomId: 'room_b' });
  const unrelatedEvent = store.event('global', { body: 'room_lounge is just a name here' });
  const beforeBots = store.list('bots');
  const beforeSettings = store.settings();
  const plan = planRoomDeletion(store, 'room_lounge');
  store.put('roomDeletions', { id: 'room_lounge', roomId: 'room_lounge', plan });
  await purgeRoomData(store, plan);
  for (const kind of directKinds) {
    assert.equal(store.get(kind, `${kind}_a`), undefined, kind);
    assert.ok(store.get(kind, `${kind}_b`), kind);
  }
  assert.equal(store.get('tasks', 'task_a'), undefined);
  assert.ok(store.get('tasks', 'task_b'));
  assert.equal(store.get('operations', 'op_a'), undefined);
  assert.ok(store.get('operations', 'op_b'));
  for (const id of ['old_notification', 'message_notification'])
    assert.equal(store.get('notifications', id), undefined);
  assert.ok(store.get('notifications', 'conflicting_notification'));
  assert.equal(store.get('automationState', 'automations_a'), undefined);
  assert.ok(store.get('automationState', 'automations_b'));
  assert.equal(store.get(LEARNING_ROOM_MIGRATION_AUDIT_KIND, 'audit_memory_a'), undefined);
  assert.equal(store.get(LEARNING_ROOM_MIGRATION_AUDIT_KIND, 'audit_skill_a'), undefined);
  assert.ok(store.get(LEARNING_ROOM_MIGRATION_AUDIT_KIND, 'audit_shared'));
  assert.ok(store.get(LEARNING_ROOM_MIGRATION_AUDIT_KIND, 'audit_moved'));
  assert.equal(store.get(SERVICE_ROOM_MIGRATION_AUDIT_KIND, 'audit_service_a'), undefined);
  assert.ok(store.get(SERVICE_ROOM_MIGRATION_AUDIT_KIND, 'audit_service_shared'));
  assert.ok(store.get('mailAccounts', 'mail_account'));
  assert.ok(store.get('mailDrafts', 'draft'));
  assert.ok(store.get('mailSends', 'send'));
  for (const kind of ['memories', 'skills', 'serviceAccounts'])
    assert.ok(store.get(kind, `${kind}_shared`));
  for (const name of [
    'service.serviceAccounts_a.credential',
    'imap.automations_a.password',
    'hook.automations_a',
  ])
    assert.equal(store.secret(name), '');
  for (const name of [
    'service.serviceAccounts_b.credential',
    'mail.mail_account.imap',
    'model.apiKey',
  ])
    assert.equal(store.secret(name), 'kept encrypted');
  assert.deepEqual(
    store.db
      .prepare('SELECT key FROM dedup ORDER BY key')
      .all()
      .map((r) => r.key),
    ['webhook:automations_a_extra:event', 'webhook:automations_b:event'],
  );
  assert.deepEqual(
    store.db
      .prepare('SELECT id FROM events ORDER BY id')
      .all()
      .map((r) => r.id),
    [otherEvent, unrelatedEvent],
  );
  assert.notEqual(ownEvent, taskEvent);
  assert.deepEqual(store.list('bots'), beforeBots);
  assert.deepEqual(store.settings(), beforeSettings);
  assert.ok(store.get('rooms', 'room_lounge'));
  assert.ok(store.get('roomDeletions', 'room_lounge'));
});

test('managed session cleanup covers old bot membership, learning history and original backups but preserves shared images and workspace files', async (t) => {
  const f = await fixture(t);
  task(f.store, 'task_a');
  task(f.store, 'learning_a', 'room_lounge', 'learning');
  task(f.store, 'task_b', 'room_b');
  const ownImage = image('a');
  const sharedImage = image('b');
  const avatarImage = image('c');
  const unrelatedImage = image('d');
  f.store.put('messages', {
    id: 'msg_a',
    roomId: 'room_lounge',
    body: 'Room images',
    attachments: [ownImage, sharedImage, avatarImage].map((id) => ({ id })),
  });
  f.store.put('messages', { id: 'msg_b', roomId: 'room_b', body: sharedImage });
  f.store.patch('bots', 'bot_aster', { avatar: `image:${avatarImage}` });
  for (const id of [ownImage, sharedImage, avatarImage, unrelatedImage]) {
    f.store.put('images', { id, mimeType: 'image/png' });
    f.file(`generated-images/${id}.png`, 'pixels');
  }
  const ownSession = `sessions/${diskKey('bot_aster')}/${diskKey('room_lounge')}`;
  const oldBotSession = `sessions/${diskKey('deleted_bot')}/${diskKey('room_lounge')}`;
  const otherSession = `sessions/${diskKey('bot_aster')}/${diskKey('room_b')}`;
  const learningSession = `sessions/learning/${diskKey('learning_a')}`;
  const own = ref('own pixels');
  const shared = ref('shared pixels');
  f.file(`${ownSession}/session.jsonl`, imageEntry(own, shared));
  f.file(`${ownSession}/session.jsonl.inline-images-v1-original.bak`, 'old inline pixels');
  f.file(`${oldBotSession}/session.jsonl`, 'old bot history');
  f.file(`${learningSession}/session.jsonl`, 'learning history');
  f.file(`${otherSession}/session.jsonl`, imageEntry(shared));
  const ownAsset = f.file(`sessions/assets/${asset('own pixels')}.bin`, 'own pixels');
  const sharedAsset = f.file(`sessions/assets/${asset('shared pixels')}.bin`, 'shared pixels');
  const unrelatedAsset = f.file(
    `sessions/assets/${asset('unrelated pixels')}.bin`,
    'unrelated pixels',
  );
  const workspace = f.file('workspace/project.txt', 'user project');
  const browser = f.file('browser-profile/browser-data', 'shared browser');
  const plan = planRoomDeletion(f.store, 'room_lounge');
  await purgeRoomData(f.store, plan);
  for (const directory of [ownSession, oldBotSession, learningSession])
    assert.equal(existsSync(join(f.directory, directory)), false);
  assert.ok(existsSync(join(f.directory, otherSession, 'session.jsonl')));
  assert.equal(existsSync(ownAsset), false);
  for (const filename of [sharedAsset, unrelatedAsset, workspace, browser])
    assert.ok(existsSync(filename));
  assert.equal(readFileSync(workspace, 'utf8'), 'user project');
  assert.equal(f.store.get('images', ownImage), undefined);
  assert.equal(existsSync(join(f.directory, 'generated-images', `${ownImage}.png`)), false);
  for (const id of [sharedImage, avatarImage, unrelatedImage]) {
    assert.ok(f.store.get('images', id));
    assert.ok(existsSync(join(f.directory, 'generated-images', `${id}.png`)));
  }
});

test('image retention metadata is removed with its room image without rooting or deleting another room shared content', async (t) => {
  const f = await fixture(t);
  const own = image('a'),
    alias = image('b'),
    other = image('c');
  const ownHash = asset('owned original'),
    sharedHash = asset('shared original');
  f.store.put('messages', {
    id: 'message_owned',
    roomId: 'room_lounge',
    attachments: [{ id: own }, { id: alias }],
  });
  f.store.put('messages', {
    id: 'message_surviving',
    roomId: 'room_b',
    attachments: [{ id: other }],
  });
  for (const id of [own, alias, other]) {
    f.store.put('images', { id, mimeType: 'image/png' });
    f.store.put('imageRetention', {
      id,
      initializedAt: stamp,
      lastUsedAt: stamp,
      protected: true,
      contentHash: id === own ? ownHash : sharedHash,
    });
    f.file(`generated-images/${id}.png`, id === own ? 'owned original' : 'shared original');
  }
  const ownAsset = f.file(`sessions/assets/${ownHash}.bin`, 'owned original');
  const sharedAsset = f.file(`sessions/assets/${sharedHash}.bin`, 'shared original');
  const plan = planRoomDeletion(f.store, 'room_lounge');
  assert.deepEqual(new Set(plan.sessionAssetHashes), new Set([ownHash, sharedHash]));
  await purgeRoomData(f.store, plan);
  for (const id of [own, alias]) {
    assert.equal(f.store.get('images', id), undefined);
    assert.equal(f.store.get('imageRetention', id), undefined);
    assert.equal(existsSync(join(f.directory, 'generated-images', `${id}.png`)), false);
  }
  assert.equal(existsSync(ownAsset), false);
  assert.ok(existsSync(sharedAsset));
  assert.ok(f.store.get('images', other));
  assert.ok(f.store.get('imageRetention', other));
});

test('references in surviving image edits and private migration originals retain source image files', async (t) => {
  const f = await fixture(t);
  const source = image('a');
  const edited = image('b');
  const auditImage = image('c');
  f.store.put('messages', {
    id: 'msg_a',
    roomId: 'room_lounge',
    attachments: [{ id: source }, { id: auditImage }],
  });
  f.store.put('messages', { id: 'msg_b', roomId: 'room_b', attachments: [{ id: edited }] });
  f.store.put('images', { id: source });
  f.store.put('images', { id: edited, inputImages: [{ id: source }] });
  f.store.put('images', { id: auditImage });
  f.store.put(LEARNING_ROOM_MIGRATION_AUDIT_KIND, {
    id: 'kept_original',
    roomId: 'room_b',
    collection: 'memories',
    recordId: 'fact_b',
    original: { content: auditImage },
  });
  for (const id of [source, edited, auditImage]) f.file(`generated-images/${id}.png`, id);
  await purgeRoomData(f.store, planRoomDeletion(f.store, 'room_lounge'));
  for (const id of [source, edited, auditImage]) {
    assert.ok(f.store.get('images', id));
    assert.ok(existsSync(join(f.directory, 'generated-images', `${id}.png`)));
  }
});

test('a failed file purge can resume from the persisted plan after restart without recreating deleted records', async (t) => {
  const f = await fixture(t);
  task(f.store, 'task_a');
  const id = image('a');
  f.store.put('messages', { id: 'msg_a', roomId: 'room_lounge', attachments: [{ id }] });
  f.store.put('images', { id });
  const imagePath = join(f.directory, 'generated-images', `${id}.png`);
  mkdirSync(imagePath, { recursive: true });
  const plan = planRoomDeletion(f.store, 'room_lounge');
  f.store.put('roomDeletions', { id: 'room_lounge', plan });
  await assert.rejects(purgeRoomData(f.store, plan), /not a regular file/);
  assert.equal(f.store.get('messages', 'msg_a'), undefined);
  assert.equal(f.store.get('tasks', 'task_a'), undefined);
  assert.ok(f.store.get('rooms', 'room_lounge'));
  f.restart();
  const saved = f.store.get<{ plan: RoomDeletionPlan }>('roomDeletions', 'room_lounge')!.plan;
  rmSync(imagePath, { recursive: true });
  writeFileSync(imagePath, 'unlocked file');
  await purgeRoomData(f.store, saved);
  await purgeRoomData(f.store, saved);
  assert.equal(existsSync(imagePath), false);
  assert.equal(f.store.get('images', id), undefined);
});

test('session symlinks and workspaces inside internal storage are never followed or recursively removed', async (t) => {
  const f = await fixture(t);
  const directory = `sessions/${diskKey('bot_aster')}/${diskKey('room_lounge')}`;
  const own = f.file(`${directory}/session.jsonl`, 'private history');
  f.store.put('messages', { id: 'msg_a', roomId: 'room_lounge', body: 'private' });
  const plan = planRoomDeletion(f.store, 'room_lounge');
  f.store.patch<Room>('rooms', 'room_lounge', { workspacePath: join(f.directory, directory) });
  await assert.rejects(purgeRoomData(f.store, plan), /overlaps a configured workspace/);
  assert.equal(readFileSync(own, 'utf8'), 'private history');
  assert.ok(f.store.get('messages', 'msg_a'));
  f.store.patch<Room>('rooms', 'room_lounge', { workspacePath: undefined });
  const target = f.file('workspace/keep.txt', 'keep project');
  rmSync(join(f.directory, directory), { recursive: true });
  symlinkSync(
    join(f.directory, 'workspace'),
    join(f.directory, directory),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(purgeRoomData(f.store, plan), /unsafe link/);
  assert.equal(readFileSync(target, 'utf8'), 'keep project');
  assert.ok(f.store.get('messages', 'msg_a'));
});

test('tampered persisted plans cannot erase another room, shared settings, or arbitrary files', async (t) => {
  const f = await fixture(t);
  task(f.store, 'task_a');
  task(f.store, 'task_b', 'room_b', 'learning');
  f.store.put('memories', { id: 'memory_a', roomId: 'room_lounge' });
  f.store.put('memories', { id: 'memory_b', roomId: 'room_b' });
  const plan = planRoomDeletion(f.store, 'room_lounge');
  for (const changed of [
    { ...plan, records: [...plan.records, { kind: 'memories', id: 'memory_b' }] },
    { ...plan, records: [...plan.records, { kind: 'settings', id: 'main' }] },
    {
      ...plan,
      taskIds: [...plan.taskIds, 'task_b'],
      sessionDirectories: [`sessions/learning/${diskKey('task_b')}`],
    },
    { ...plan, sessionDirectories: ['workspace'] },
    { ...plan, imageIds: [image('f')] },
  ])
    await assert.rejects(purgeRoomData(f.store, changed), /invalid/);
  assert.ok(f.store.get('memories', 'memory_a'));
  assert.ok(f.store.get('memories', 'memory_b'));
  assert.ok(f.store.get('settings', 'main'));
  // Authentic plans are checked against current ownership too.
  f.store.patch('memories', 'memory_a', { roomId: 'room_b' });
  await assert.rejects(purgeRoomData(f.store, plan), /no longer belongs/);
  assert.ok(f.store.get('memories', 'memory_a'));
  assert.ok(f.store.get('tasks', 'task_a'));
});

test('in-memory session image pins protect a second room before its JSONL append and are released per task', async (t) => {
  const f = await fixture(t);
  const data = 'live shared pixels';
  const directory = `sessions/${diskKey('bot_aster')}/${diskKey('room_lounge')}`;
  f.file(`${directory}/session.jsonl`, imageEntry(ref(data)));
  const assetPath = f.file(`sessions/assets/${asset(data)}.bin`, data);
  const live = createSessionImageStore(f.directory, { retainReferences: true });
  t.after(() => live.release());
  live.externalizeMessageImages({
    content: [{ type: 'image', data: Buffer.from(data).toString('base64'), mimeType: 'image/png' }],
  });
  assert.deepEqual([...retainedSessionImageHashes(f.directory)], [asset(data)]);
  const plan = planRoomDeletion(f.store, 'room_lounge');
  await purgeRoomData(f.store, plan);
  assert.ok(existsSync(assetPath));
  live.release();
  live.release();
  assert.equal(retainedSessionImageHashes(f.directory).size, 0);
  await purgeRoomData(f.store, plan);
  assert.equal(existsSync(assetPath), false);
});

test('prose identifiers do not establish ownership, while interrupted image receipts and unrelated catalog sources are handled explicitly', async (t) => {
  const f = await fixture(t);
  task(f.store, 'task_a');
  const proseImage = image('e');
  const ownedImage = image('a');
  const unrelatedEdit = image('b');
  const interruptedOperation = 'c'.repeat(64);
  const orphanedGeneratedImage = `img_${interruptedOperation}`;
  f.store.put('messages', {
    id: 'msg_a',
    roomId: 'room_lounge',
    body: `A reference in prose: ${proseImage}`,
    attachments: [{ id: ownedImage }],
  });
  f.store.put('operations', {
    id: interruptedOperation,
    taskId: 'task_a',
    toolName: 'generate_image',
    status: 'started',
  });
  for (const id of [proseImage, ownedImage, unrelatedEdit]) f.store.put('images', { id });
  f.store.patch('images', unrelatedEdit, { inputImages: [{ imageId: ownedImage }] });
  for (const id of [proseImage, ownedImage, unrelatedEdit, orphanedGeneratedImage])
    f.file(`generated-images/${id}.png`, id);
  const quotedAsset = asset('quoted reference');
  const quotedFile = f.file(`sessions/assets/${quotedAsset}.bin`, 'quoted reference');
  const directory = `sessions/${diskKey('bot_aster')}/${diskKey('room_lounge')}`;
  f.file(
    `${directory}/session.jsonl`,
    JSON.stringify({
      type: 'message',
      message: {
        content: [{ type: 'text', text: JSON.stringify({ data: ref('quoted reference') }) }],
      },
    }),
  );
  const plan = planRoomDeletion(f.store, 'room_lounge');
  assert.ok(!plan.imageIds.includes(proseImage));
  assert.ok(!plan.sessionAssetHashes.includes(quotedAsset));
  assert.ok(plan.imageIds.includes(orphanedGeneratedImage));
  await purgeRoomData(f.store, plan);
  assert.ok(existsSync(quotedFile));
  for (const id of [proseImage, ownedImage, unrelatedEdit]) {
    assert.ok(f.store.get('images', id));
    assert.ok(existsSync(join(f.directory, 'generated-images', `${id}.png`)));
  }
  assert.equal(
    existsSync(join(f.directory, 'generated-images', `${orphanedGeneratedImage}.png`)),
    false,
  );
});

test('task-local image retention is reference counted across stores and recognizes previously externalized images', async (t) => {
  const f = await fixture(t);
  const a = createSessionImageStore(f.directory, { retainReferences: true });
  const b = createSessionImageStore(f.directory, { retainReferences: true });
  const unretained = createSessionImageStore(f.directory);
  t.after(() => {
    a.release();
    b.release();
    unretained.release();
  });
  const pixels = 'same pixels';
  a.externalizeMessageImages({
    content: [{ type: 'image', data: Buffer.from(pixels).toString('base64') }],
  });
  b.externalizeMessageImages({ content: [{ type: 'image', data: ref(pixels) }] });
  unretained.externalizeMessageImages({
    content: [{ type: 'image', data: Buffer.from('unretained pixels').toString('base64') }],
  });
  assert.deepEqual([...retainedSessionImageHashes(f.directory)], [asset(pixels)]);
  a.release();
  assert.deepEqual([...retainedSessionImageHashes(f.directory)], [asset(pixels)]);
  b.release();
  assert.equal(retainedSessionImageHashes(f.directory).size, 0);
});
