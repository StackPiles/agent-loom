import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  SERVICE_ROOM_MIGRATION_AUDIT_KIND,
  SERVICE_ROOM_MIGRATION_ID,
  migrateServicesToRooms,
} from '../src/server/service-room-migration.js';
import { Store } from '../src/server/store.js';
import type { ServiceAccount } from '../src/shared/service-accounts.js';
import type { Room, Task } from '../src/shared/types.js';

type LegacyAccount = Omit<ServiceAccount, 'roomId'> & { roomId?: string | null };

interface Audit {
  recordId: string;
  original: LegacyAccount;
  roomId: string;
  held: boolean;
  provenance: {
    roomIds: string[];
    taskIds: string[];
    operationIds: string[];
    receiptRevisions: number[];
    issues: string[];
  };
}

const stamp = '2026-11-01T00:00:00.000Z';
const later = '2026-11-02T00:00:00.000Z';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-service-room-migration-'));
  let store = new Store(directory);
  store.seed();
  const lounge = store.get<Room>('rooms', 'room_lounge')!;
  store.put('rooms', { ...lounge, id: 'room_other', name: 'Other project' });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new Store(directory);
    },
  };
}

function task(store: Store, id: string, roomId = 'room_lounge', botId = 'bot_aster') {
  return store.put<Task>('tasks', {
    id,
    roomId,
    botId,
    prompt: 'Manage the service registry in this room.',
    output: 'Saved the verified service.',
    rootTaskId: id,
    depth: 0,
    kind: 'chat',
    status: 'completed',
    inputTokens: 0,
    outputTokens: 0,
    createdAt: stamp,
    updatedAt: stamp,
  });
}

function account(store: Store, id: string, patch: Partial<LegacyAccount> = {}): LegacyAccount {
  return store.put<LegacyAccount>('serviceAccounts', {
    id,
    name: `Service ${id}`,
    url: `https://service.example.test/${id}`,
    login: `${id}@example.test`,
    botId: 'bot_aster',
    mailAccountId: null,
    status: 'active',
    notes: `Project notes for ${id}.`,
    credentialConfigured: false,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  });
}

function receipt(
  store: Store,
  id: string,
  taskId: string,
  result: LegacyAccount,
  overrides: {
    args?: Record<string, unknown>;
    status?: 'started' | 'completed' | 'failed';
    result?: string;
  } = {},
) {
  return store.put('operations', {
    id,
    key: id,
    taskId,
    toolName: 'manage_service_account',
    args:
      overrides.args ??
      (result.revision === 1
        ? { operation: 'create', name: result.name, url: result.url }
        : {
            operation: 'update',
            serviceId: result.id,
            expectedRevision: result.revision - 1,
            notes: result.notes,
          }),
    status: overrides.status ?? 'completed',
    result:
      overrides.result ?? JSON.stringify({ ...result, sharedBotIds: result.sharedBotIds ?? [] }),
    updatedAt: result.updatedAt,
  });
}

test('complete exact-ID receipt history assigns one room and preserves metadata and encrypted bytes without accessing credentials', async (t) => {
  const { store } = await fixture(t);
  task(store, 'create_a');
  task(store, 'update_a');
  const created = account(store, 'project_service', {
    sharedBotIds: ['bot_nova'],
    mailAccountId: 'mail_preserved',
    status: 'pending',
    credentialConfigured: true,
  });
  receipt(store, 'receipt_create', 'create_a', created);
  const current = store.put('serviceAccounts', {
    ...created,
    notes: 'Updated project notes.',
    revision: 2,
    updatedAt: later,
  });
  receipt(store, 'receipt_update', 'update_a', current);
  store.setSecret(`service.${current.id}.credential`, ' exact synthetic credential \n');
  const secretRows = store.db.prepare('SELECT * FROM secrets ORDER BY key').all();
  const operations = store.list('operations');
  const oldSecret = store.secret;
  const oldSetSecret = store.setSecret;
  store.secret = () => {
    throw new Error('Migration must not decrypt a credential.');
  };
  store.setSecret = () => {
    throw new Error('Migration must not rewrite a credential.');
  };
  try {
    assert.deepEqual(migrateServicesToRooms(store), { services: 1, held: 0 });
  } finally {
    store.secret = oldSecret;
    store.setSecret = oldSetSecret;
  }
  const migrated = store.get<ServiceAccount>('serviceAccounts', current.id)!;
  assert.equal(migrated.roomId, 'room_lounge');
  assert.equal(migrated.revision, 3);
  assert.ok(migrated.updatedAt > current.updatedAt);
  const { roomId: _, revision: _revision, updatedAt: _updatedAt, ...preserved } = migrated;
  const { revision: _oldRevision, updatedAt: _oldUpdatedAt, ...original } = current;
  assert.deepEqual(preserved, original);
  assert.deepEqual(store.db.prepare('SELECT * FROM secrets ORDER BY key').all(), secretRows);
  assert.equal(store.secret(`service.${current.id}.credential`), ' exact synthetic credential \n');
  assert.deepEqual(store.list('operations'), operations);
  const audit = store.list<Audit>(SERVICE_ROOM_MIGRATION_AUDIT_KIND)[0];
  assert.deepEqual(audit.original, current);
  assert.deepEqual(audit.provenance.roomIds, ['room_lounge']);
  assert.deepEqual(audit.provenance.receiptRevisions, [1, 2]);
  assert.deepEqual(audit.provenance.issues, []);
  assert.ok(!JSON.stringify(audit).includes('exact synthetic credential'));
});

test('manual entries of every status go to one inactive holding room without inferring a room from membership or names', async (t) => {
  const { store } = await fixture(t);
  store.remove('rooms', 'room_other');
  const originals: LegacyAccount[] = [];
  for (const status of ['active', 'pending', 'disabled'] as const) {
    const original = account(store, `manual_${status}`, {
      status,
      name: 'A service named after room_lounge',
      notes: 'Mentioning room_lounge is not structural provenance.',
      credentialConfigured: true,
    });
    store.setSecret(`service.${original.id}.credential`, `fixture-${status}-credential`);
    originals.push(original);
  }
  const secretRows = store.db.prepare('SELECT * FROM secrets ORDER BY key').all();
  const result = migrateServicesToRooms(store);
  assert.equal(result.services, 3);
  assert.equal(result.held, 3);
  assert.ok(result.holdingRoomId);
  const holding = store.get<Room>('rooms', result.holdingRoomId)!;
  assert.equal(holding.name, 'サービスの整理待ち');
  assert.equal(holding.archived, true);
  assert.equal(holding.paused, true);
  assert.equal(holding.autonomousWakeups?.mode, 'off');
  assert.deepEqual(holding.botIds, []);
  assert.equal(store.list('serviceAccounts').length, originals.length);
  for (const original of originals) {
    const migrated = store.get<ServiceAccount>('serviceAccounts', original.id)!;
    assert.equal(migrated.roomId, holding.id);
    assert.equal(migrated.status, original.status);
    assert.equal(migrated.botId, original.botId);
    assert.equal(migrated.login, original.login);
    assert.equal(migrated.credentialConfigured, original.credentialConfigured);
    assert.deepEqual(
      store
        .list<Audit>(SERVICE_ROOM_MIGRATION_AUDIT_KIND)
        .find((audit) => audit.recordId === original.id)!.original,
      original,
    );
  }
  assert.deepEqual(store.db.prepare('SELECT * FROM secrets ORDER BY key').all(), secretRows);
});

test('a latest updater, revision gaps and contradictory room histories cannot establish an original service room', async (t) => {
  const { store } = await fixture(t);
  task(store, 'source_a');
  task(store, 'source_b', 'room_other');
  const onlyUpdate = account(store, 'only_update', { revision: 2 });
  receipt(store, 'only_update_2', 'source_b', onlyUpdate);

  const createdGap = account(store, 'gap');
  receipt(store, 'gap_1', 'source_a', createdGap);
  const currentGap = account(store, createdGap.id, { revision: 3, updatedAt: later });
  receipt(store, 'gap_3', 'source_a', currentGap);

  const createdConflict = account(store, 'conflict');
  receipt(store, 'conflict_1', 'source_a', createdConflict);
  const currentConflict = account(store, createdConflict.id, { revision: 2, updatedAt: later });
  receipt(store, 'conflict_2', 'source_b', currentConflict);

  const result = migrateServicesToRooms(store);
  assert.equal(result.held, 3);
  assert.ok(
    store
      .list<ServiceAccount>('serviceAccounts')
      .every((item) => item.roomId === result.holdingRoomId),
  );
  const audits = store.list<Audit>(SERVICE_ROOM_MIGRATION_AUDIT_KIND);
  assert.ok(
    audits
      .find((item) => item.recordId === 'only_update')!
      .provenance.issues.includes('missing_creation'),
  );
  assert.ok(
    audits
      .find((item) => item.recordId === 'gap')!
      .provenance.issues.includes('incomplete_revision_history'),
  );
  assert.ok(
    audits
      .find((item) => item.recordId === 'conflict')!
      .provenance.issues.includes('conflicting_rooms'),
  );
});

test('failed or started effects and approved request cards do not prove service creation', async (t) => {
  const { store } = await fixture(t);
  task(store, 'source_a');
  for (const status of ['failed', 'started'] as const) {
    const saved = account(store, `not_completed_${status}`);
    receipt(store, `receipt_${status}`, 'source_a', saved, { status });
    store.put('approvals', {
      id: `approval_${status}`,
      roomId: 'room_lounge',
      botId: 'bot_aster',
      taskId: 'source_a',
      toolName: 'manage_service_account',
      status: 'approved',
      args: { serviceId: saved.id },
    });
  }
  const result = migrateServicesToRooms(store);
  assert.equal(result.held, 2);
  for (const audit of store.list<Audit>(SERVICE_ROOM_MIGRATION_AUDIT_KIND)) {
    assert.deepEqual(audit.provenance.operationIds, []);
    assert.ok(audit.provenance.issues.includes('missing_creation'));
  }
});

test('broken tasks, missing rooms, contradictory identities and malformed receipts are retained for review', async (t) => {
  const { store } = await fixture(t);
  task(store, 'source_a');
  task(store, 'deleted_room_task', 'room_deleted');
  const missingTask = account(store, 'missing_task');
  receipt(store, 'missing_task_receipt', 'deleted_task', missingTask);
  const missingRoom = account(store, 'missing_room');
  receipt(store, 'missing_room_receipt', 'deleted_room_task', missingRoom);
  const wrongBot = account(store, 'wrong_actor', { botId: 'bot_nova' });
  receipt(store, 'wrong_bot_receipt', 'source_a', wrongBot);
  const malformed = account(store, 'malformed_result', { revision: 2 });
  receipt(store, 'malformed_receipt', 'source_a', malformed, { result: '{partial JSON' });
  const renamed = account(store, 'unrecorded_change');
  receipt(store, 'unrecorded_change_receipt', 'source_a', renamed);
  store.patch<LegacyAccount>('serviceAccounts', renamed.id, { notes: 'Unrecorded replacement.' });
  const result = migrateServicesToRooms(store);
  assert.equal(result.held, 5);
  const audits = store.list<Audit>(SERVICE_ROOM_MIGRATION_AUDIT_KIND);
  assert.ok(
    audits
      .find((entry) => entry.recordId === 'missing_task')!
      .provenance.issues.some((issue) => issue.startsWith('missing_source_task:')),
  );
  assert.ok(
    audits
      .find((entry) => entry.recordId === 'missing_room')!
      .provenance.issues.includes('missing_room:room_deleted'),
  );
  assert.ok(
    audits
      .find((entry) => entry.recordId === 'wrong_actor')!
      .provenance.issues.some((issue) => issue.startsWith('inconsistent_actor:')),
  );
  assert.ok(
    audits
      .find((entry) => entry.recordId === 'malformed_result')!
      .provenance.issues.some((issue) => issue.startsWith('invalid_receipt:')),
  );
  assert.ok(
    audits
      .find((entry) => entry.recordId === 'unrecorded_change')!
      .provenance.issues.includes('current_record_differs_from_receipt'),
  );
});

test('duplicate identical receipts are harmless, while conflicting receipts for a revision are not chosen arbitrarily', async (t) => {
  const { store } = await fixture(t);
  task(store, 'source_a');
  const consistent = account(store, 'same_receipt');
  receipt(store, 'consistent_first', 'source_a', consistent);
  receipt(store, 'consistent_duplicate', 'source_a', consistent);
  const conflicting = account(store, 'conflicting_receipt');
  receipt(store, 'conflicting_first', 'source_a', conflicting);
  receipt(store, 'conflicting_second', 'source_a', {
    ...conflicting,
    notes: 'A different snapshot.',
  });
  const result = migrateServicesToRooms(store);
  assert.equal(result.held, 1);
  assert.equal(store.get<ServiceAccount>('serviceAccounts', consistent.id)!.roomId, 'room_lounge');
  assert.equal(
    store.get<ServiceAccount>('serviceAccounts', conflicting.id)!.roomId,
    result.holdingRoomId,
  );
  const audit = store
    .list<Audit>(SERVICE_ROOM_MIGRATION_AUDIT_KIND)
    .find((item) => item.recordId === conflicting.id)!;
  assert.ok(audit.provenance.issues.includes('conflicting_revision_receipts:1'));
});

test('reliable archived origins remain archived and do not recreate removed managers or memberships', async (t) => {
  const { store } = await fixture(t);
  store.patch<Room>('rooms', 'room_other', { archived: true, botIds: [] });
  task(store, 'historical_source', 'room_other', 'removed_bot');
  const original = account(store, 'historical_account', { botId: 'removed_bot' });
  receipt(store, 'historical_receipt', 'historical_source', original);
  const rooms = store.list('rooms');
  const bots = store.list('bots');
  assert.deepEqual(migrateServicesToRooms(store), { services: 1, held: 0 });
  assert.equal(store.get<ServiceAccount>('serviceAccounts', original.id)!.roomId, 'room_other');
  assert.equal(store.get<ServiceAccount>('serviceAccounts', original.id)!.botId, 'removed_bot');
  assert.deepEqual(store.list('rooms'), rooms);
  assert.deepEqual(store.list('bots'), bots);
});

test('scoped records remain byte-identical and an empty migration still marks the dataset', async (t) => {
  const { store } = await fixture(t);
  account(store, 'already_scoped', { roomId: 'room_other', status: 'disabled' });
  const before = store.db
    .prepare("SELECT * FROM objects WHERE kind IN ('serviceAccounts','rooms') ORDER BY kind,id")
    .all();
  assert.deepEqual(migrateServicesToRooms(store), { services: 0, held: 0 });
  assert.deepEqual(
    store.db
      .prepare("SELECT * FROM objects WHERE kind IN ('serviceAccounts','rooms') ORDER BY kind,id")
      .all(),
    before,
  );
  assert.equal(store.list(SERVICE_ROOM_MIGRATION_AUDIT_KIND).length, 0);
  assert.ok(store.get('meta', SERVICE_ROOM_MIGRATION_ID));
});

test('marker and original audit survive restart without rescoping later explicit shared services', async (t) => {
  const f = await fixture(t);
  account(f.store, 'manual_legacy');
  const first = migrateServicesToRooms(f.store);
  assert.equal(first.held, 1);
  const deliberate = account(f.store, 'deliberate_new_share', { roomId: null });
  const before = f.store.db.prepare('SELECT * FROM objects ORDER BY kind,id').all();
  f.restart();
  assert.deepEqual(migrateServicesToRooms(f.store), {
    services: 0,
    held: 0,
    holdingRoomId: first.holdingRoomId,
  });
  assert.deepEqual(f.store.get('serviceAccounts', deliberate.id), deliberate);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM objects ORDER BY kind,id').all(), before);
});

test('transaction failure restores registry metadata, audits, holding room and marker without touching encrypted data', async (t) => {
  const { store } = await fixture(t);
  account(store, 'manual_legacy', { credentialConfigured: true });
  store.setSecret('service.manual_legacy.credential', 'rollback-credential-fixture');
  const before = store.db.prepare('SELECT * FROM objects ORDER BY kind,id').all();
  const secrets = store.db.prepare('SELECT * FROM secrets ORDER BY key').all();
  const put = store.put.bind(store);
  store.put = ((kind, value) => {
    if (kind === 'meta' && value.id === SERVICE_ROOM_MIGRATION_ID)
      throw new Error('Injected service marker failure.');
    return put(kind, value);
  }) as Store['put'];
  assert.throws(() => migrateServicesToRooms(store), /Injected service marker failure/);
  assert.deepEqual(store.db.prepare('SELECT * FROM objects ORDER BY kind,id').all(), before);
  assert.deepEqual(store.db.prepare('SELECT * FROM secrets ORDER BY key').all(), secrets);
  store.put = put;
  assert.equal(migrateServicesToRooms(store).held, 1);
  assert.deepEqual(store.db.prepare('SELECT * FROM secrets ORDER BY key').all(), secrets);
});
