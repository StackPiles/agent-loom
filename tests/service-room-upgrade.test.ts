import assert from 'node:assert/strict';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app.js';
import { exportDataArchive, importDataArchive } from '../src/server/data-transfer-archive.js';
import type { RuntimeHost } from '../src/server/runtime/contract.js';
import { Store } from '../src/server/store.js';
import type { ServiceAccount } from '../src/shared/service-accounts.js';
import type { Room, Task } from '../src/shared/types.js';

const stamp = '2026-11-14T12:00:00.000Z';
const password = 'service scope encrypted upgrade fixture';
const managedId = 'service_known_origin';
const heldId = 'service_unknown_origin';
const orphanId = 'service_removed_bots';
const serviceSecret = ' exact preserved service credential\n';
const heldSecret = ' exact held service credential\t';

function legacyData(dataDir: string) {
  const store = new Store(dataDir);
  try {
    store.seed();
    store.put('rooms', { ...store.get<Room>('rooms', 'room_lounge')!, id: 'room_other' });
    const sourceTask: Task = {
      id: 'task_register_service',
      roomId: 'room_lounge',
      botId: 'bot_aster',
      kind: 'chat',
      status: 'completed',
      rootTaskId: 'task_register_service',
      depth: 0,
      prompt: 'Register the service for this project.',
      output: 'Recorded after approval.',
      inputTokens: 0,
      outputTokens: 0,
      createdAt: stamp,
      updatedAt: stamp,
    };
    store.put('tasks', sourceTask);
    const original = {
      id: managedId,
      name: 'Project A service',
      url: 'https://project-a.example.test/login',
      login: 'project-a@example.test',
      botId: 'bot_aster',
      sharedBotIds: ['bot_nova'],
      mailAccountId: null,
      status: 'active' as const,
      notes: 'A_ONLY_SERVICE_NOTES',
      credentialConfigured: true,
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    store.put('serviceAccounts', original);
    store.setSecret(`service.${managedId}.credential`, serviceSecret);
    store.put('operations', {
      id: 'operation_register_service',
      key: 'operation_register_service',
      taskId: sourceTask.id,
      toolName: 'manage_service_account',
      args: { operation: 'create', name: original.name, url: original.url },
      status: 'completed',
      result: JSON.stringify(original),
      updatedAt: stamp,
    });
    store.put('serviceAccounts', { ...original, id: heldId, name: 'Unknown-origin service' });
    store.setSecret(`service.${heldId}.credential`, heldSecret);
    store.put('serviceAccounts', {
      ...original,
      id: orphanId,
      name: 'Retained missing bot assignments',
      botId: 'bot_removed_manager',
      sharedBotIds: ['bot_removed_recipient'],
    });
    store.setSecret(`service.${orphanId}.credential`, 'retained-orphan-credential');
    return original;
  } finally {
    store.close();
  }
}

function idleRuntime() {
  return {
    start() {},
    async stop() {},
    async shutdown() {},
    queueState: () => ({ active: 0, waiting: 0 }),
  };
}

function verifyBeforeRuntime(host: RuntimeHost) {
  const snapshot = host.getSnapshot();
  const service = snapshot.serviceAccounts!.find((item) => item.id === managedId)!;
  const held = snapshot.serviceAccounts!.find((item) => item.id === heldId)!;
  assert.equal(service.roomId, 'room_lounge');
  assert.ok(held.roomId && held.roomId !== 'room_lounge' && held.roomId !== 'room_other');
  assert.equal(
    host.readServiceCredentialForBot!(service.id, service.revision, 'bot_aster', 'room_lounge')
      .credential,
    serviceSecret,
  );
  for (const candidate of [service, held])
    assert.throws(
      () =>
        host.readServiceCredentialForBot!(
          candidate.id,
          candidate.revision,
          'bot_aster',
          'room_other',
        ),
      { statusCode: 403 },
    );
  return idleRuntime();
}

test('startup scopes legacy services before runtime and owner reassignment retains the saved credential', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-service-upgrade-'));
  const original = legacyData(dataDir);
  const app = await createApp({ dataDir, scheduler: false, runtimeFactory: verifyBeforeRuntime });
  t.after(async () => {
    await app.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const first = (await app.app.inject({ url: '/api/state' })).json();
  assert.equal(Object.hasOwn(first, 'serviceRoomMigrationRecords'), false);
  assert.equal(JSON.stringify(first).includes(serviceSecret), false);
  const known = first.serviceAccounts.find((item: ServiceAccount) => item.id === managedId);
  // Room scope and the newly independent login destination each migrate once.
  assert.equal(known.revision, original.revision + 2);
  assert.equal(known.credentialOrigin, new URL(known.loginUrl).origin);
  const held: ServiceAccount = first.serviceAccounts.find(
    (item: ServiceAccount) => item.id === heldId,
  );
  const holdingRoom = first.rooms.find((room: Room) => room.id === held.roomId);
  assert.equal(holdingRoom.archived, true);
  assert.equal(holdingRoom.paused, true);
  assert.deepEqual(holdingRoom.botIds, []);
  const reassigned = await app.app.inject({
    method: 'PUT',
    url: `/api/service-accounts/${held.id}`,
    payload: {
      name: held.name,
      url: held.url,
      login: held.login,
      botId: held.botId,
      sharedBotIds: held.sharedBotIds,
      mailAccountId: held.mailAccountId,
      status: held.status,
      notes: held.notes,
      roomId: 'room_other',
      expectedRevision: held.revision,
    },
  });
  assert.equal(reassigned.statusCode, 200, reassigned.body);
  const moved = reassigned.json<ServiceAccount>();
  assert.equal(moved.id, held.id);
  assert.equal(moved.botId, held.botId);
  assert.deepEqual(moved.sharedBotIds, held.sharedBotIds);
  assert.equal(moved.status, held.status);
  assert.equal(moved.credentialConfigured, true);
  assert.equal(
    app.controller.readServiceCredentialForBot(moved.id, moved.revision, 'bot_nova', 'room_other')
      .credential,
    heldSecret,
  );
  assert.throws(
    () =>
      app.controller.readServiceCredentialForBot(
        moved.id,
        moved.revision,
        'bot_aster',
        'room_lounge',
      ),
    { statusCode: 403 },
  );
});

test('encrypted service imports migrate once and retain credentials, audits and later deliberate sharing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'loom-service-scope-transfer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  legacyData(source);
  const archive = join(root, 'legacy.loomdata');
  const staging = join(root, 'legacy-stage');
  await exportDataArchive({ dataDir: source, archivePath: archive, password });
  await importDataArchive({
    archivePath: archive,
    stagingDir: staging,
    destinationDataDir: destination,
    password,
  });
  await rename(staging, destination);
  const upgraded = await createApp({
    dataDir: destination,
    scheduler: false,
    runtimeFactory: verifyBeforeRuntime,
  });
  let before: { accounts: ServiceAccount[]; audit: unknown[]; marker: unknown };
  try {
    const shared = await upgraded.app.inject({
      method: 'POST',
      url: '/api/service-accounts',
      payload: {
        name: 'Explicitly shared after upgrade',
        url: 'https://shared.example.test/',
        login: '',
        botId: 'bot_aster',
        roomId: null,
        mailAccountId: null,
        status: 'active',
        notes: '',
      },
    });
    assert.equal(shared.statusCode, 200, shared.body);
    before = {
      accounts: upgraded.store.list<ServiceAccount>('serviceAccounts'),
      audit: upgraded.store.list('serviceRoomMigrationRecords'),
      marker: upgraded.store.get('meta', 'serviceRoomScopeMigrationV1'),
    };
    assert.equal(before.audit.length, 3);
  } finally {
    await upgraded.app.close();
  }
  const currentArchive = join(root, 'current.loomdata');
  const currentStage = join(root, 'current-stage');
  const restoredPath = join(root, 'restored');
  await exportDataArchive({ dataDir: destination, archivePath: currentArchive, password });
  await importDataArchive({
    archivePath: currentArchive,
    stagingDir: currentStage,
    destinationDataDir: restoredPath,
    password,
  });
  await rename(currentStage, restoredPath);
  const restored = await createApp({
    dataDir: restoredPath,
    scheduler: false,
    runtimeFactory: idleRuntime,
  });
  try {
    assert.deepEqual(restored.store.list('serviceAccounts'), before.accounts);
    assert.deepEqual(restored.store.list('serviceRoomMigrationRecords'), before.audit);
    assert.deepEqual(restored.store.get('meta', 'serviceRoomScopeMigrationV1'), before.marker);
    assert.equal(restored.store.secret(`service.${managedId}.credential`), serviceSecret);
    assert.equal(restored.store.secret(`service.${heldId}.credential`), heldSecret);
    assert.equal(
      restored.store.secret(`service.${orphanId}.credential`),
      'retained-orphan-credential',
    );
    const orphan = restored.store.get<ServiceAccount>('serviceAccounts', orphanId)!;
    assert.equal(orphan.botId, 'bot_removed_manager');
    assert.deepEqual(orphan.sharedBotIds, ['bot_removed_recipient']);
    assert.throws(
      () =>
        restored.controller.readServiceCredentialForBot(
          orphan.id,
          orphan.revision,
          'bot_aster',
          'room_lounge',
        ),
      { statusCode: 403 },
    );
    assert.equal(
      restored.controller
        .getSnapshot()
        .serviceAccounts!.find((item) => item.name === 'Explicitly shared after upgrade')!.roomId,
      null,
    );
  } finally {
    await restored.app.close();
  }
});
