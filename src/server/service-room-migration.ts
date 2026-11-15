import type { ServiceAccount } from '../shared/service-accounts.js';
import type { Room, Task } from '../shared/types.js';
import { DEFAULT_AUTONOMOUS_WAKEUP_POLICY } from '../shared/work.js';
import { id, now, type Store } from './store.js';

export const SERVICE_ROOM_MIGRATION_ID = 'serviceRoomScopeMigrationV1';
export const SERVICE_ROOM_MIGRATION_AUDIT_KIND = 'serviceRoomMigrationRecords';

type LegacyServiceAccount = Omit<ServiceAccount, 'roomId'> & { roomId?: string | null };

export interface ServiceRoomMigrationResult {
  services: number;
  held: number;
  holdingRoomId?: string;
}

interface MigrationMarker extends ServiceRoomMigrationResult {
  id: typeof SERVICE_ROOM_MIGRATION_ID;
  version: 1;
  completedAt: string;
}

interface Provenance {
  roomIds: string[];
  taskIds: string[];
  operationIds: string[];
  receiptRevisions: number[];
  issues: string[];
}

interface Receipt {
  operation: 'create' | 'update';
  taskId: string;
  snapshot: string;
}

interface Evidence {
  roomIds: Set<string>;
  taskIds: Set<string>;
  operationIds: Set<string>;
  revisions: Map<number, Receipt>;
  issues: Set<string>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return;
  try {
    return object(JSON.parse(value));
  } catch {
    return;
  }
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Compare only registry metadata; credentials are never read by this migration. */
function accountSnapshot(account: Record<string, unknown>): string {
  return JSON.stringify([
    account.id,
    account.name,
    account.url,
    account.login,
    account.botId,
    account.sharedBotIds ?? [],
    account.mailAccountId,
    account.status,
    account.notes,
    account.credentialConfigured,
    account.revision,
    account.createdAt,
    account.updatedAt,
  ]);
}

/**
 * Old registry entries have neither an origin room nor revision history. Only
 * successful exact-ID mutation receipts prove where each revision was written.
 * A selected room, bot membership, URL/name match, approval, or last updater
 * cannot stand in for missing creation and intervening revision evidence.
 */
function serviceOrigins(store: Store, accounts: readonly LegacyServiceAccount[]) {
  const entries = new Map(accounts.map((account) => [account.id, account]));
  const evidence = new Map<string, Evidence>();
  const tasks = new Map<string, Pick<Task, 'roomId' | 'botId'> | undefined>();
  const rooms = new Map<string, boolean>();
  const taskFor = (taskId: string) => {
    if (!tasks.has(taskId)) {
      const task = store.get<Task>('tasks', taskId);
      tasks.set(taskId, task ? { roomId: task.roomId, botId: task.botId } : undefined);
    }
    return tasks.get(taskId);
  };
  const roomExists = (roomId: string) => {
    if (!rooms.has(roomId)) rooms.set(roomId, Boolean(store.get<Room>('rooms', roomId)));
    return rooms.get(roomId)!;
  };
  const forAccount = (accountId: string): Evidence => {
    let found = evidence.get(accountId);
    if (!found) {
      found = {
        roomIds: new Set(),
        taskIds: new Set(),
        operationIds: new Set(),
        revisions: new Map(),
        issues: new Set(),
      };
      evidence.set(accountId, found);
    }
    return found;
  };

  // Filter and iterate in SQLite. Do not hydrate image, shell, or unrelated
  // operation histories into the Node heap just to find service provenance.
  const receipts = entries.size
    ? (store.db
        .prepare(
          "SELECT id,json_extract(data,'$.taskId') AS taskId," +
            "json_extract(data,'$.args') AS args,json_extract(data,'$.result') AS result " +
            "FROM objects WHERE kind='operations' " +
            "AND json_extract(data,'$.toolName')='manage_service_account' " +
            "AND json_extract(data,'$.status')='completed'",
        )
        .iterate() as Iterable<{ id: string; taskId: unknown; args: unknown; result: unknown }>)
    : [];
  for (const row of receipts) {
    const args = parseObject(row.args);
    const result = parseObject(row.result);
    const related = new Set<string>();
    if (typeof args?.serviceId === 'string' && entries.has(args.serviceId))
      related.add(args.serviceId);
    if (typeof result?.id === 'string' && entries.has(result.id)) related.add(result.id);
    for (const accountId of related) {
      const account = entries.get(accountId)!;
      const found = forAccount(accountId);
      found.operationIds.add(row.id);
      if (typeof row.taskId === 'string') found.taskIds.add(row.taskId);
      const operation = args?.operation;
      const revision = result?.revision;
      if (
        !args ||
        !result ||
        result.id !== account.id ||
        !validRevision(revision) ||
        revision > account.revision ||
        result.createdAt !== account.createdAt ||
        !(
          (operation === 'create' &&
            revision === 1 &&
            args.serviceId === undefined &&
            args.expectedRevision === undefined) ||
          (operation === 'update' &&
            args.serviceId === account.id &&
            validRevision(args.expectedRevision) &&
            revision === args.expectedRevision + 1)
        )
      ) {
        found.issues.add(`invalid_receipt:${row.id}`);
        continue;
      }
      const sourceTask = typeof row.taskId === 'string' ? taskFor(row.taskId) : undefined;
      if (!sourceTask?.roomId) {
        found.issues.add(`missing_source_task:${row.id}`);
        continue;
      }
      found.roomIds.add(sourceTask.roomId);
      if (!roomExists(sourceTask.roomId)) found.issues.add(`missing_room:${sourceTask.roomId}`);
      if (
        result.botId !== sourceTask.botId ||
        (result.roomId !== undefined &&
          result.roomId !== null &&
          result.roomId !== sourceTask.roomId)
      )
        found.issues.add(`inconsistent_actor:${row.id}`);
      const receipt: Receipt = {
        operation,
        taskId: row.taskId as string,
        snapshot: accountSnapshot(result),
      };
      const previous = found.revisions.get(revision);
      if (previous && JSON.stringify(previous) !== JSON.stringify(receipt))
        found.issues.add(`conflicting_revision_receipts:${revision}`);
      else found.revisions.set(revision, receipt);
    }
  }

  return (account: LegacyServiceAccount): Provenance => {
    const found = forAccount(account.id);
    const revisions = [...found.revisions.keys()].sort((left, right) => left - right);
    if (found.revisions.get(1)?.operation !== 'create') found.issues.add('missing_creation');
    // Compare bounded receipt counts, never loop up to an untrusted revision.
    if (
      revisions.length !== account.revision ||
      revisions.some((revision, index) => revision !== index + 1)
    )
      found.issues.add('incomplete_revision_history');
    const latest = found.revisions.get(account.revision);
    if (
      latest &&
      latest.snapshot !== accountSnapshot(account as unknown as Record<string, unknown>)
    )
      found.issues.add('current_record_differs_from_receipt');
    if (!found.roomIds.size) found.issues.add('missing_provenance');
    if (found.roomIds.size > 1) found.issues.add('conflicting_rooms');
    return {
      roomIds: [...found.roomIds].sort(),
      taskIds: [...found.taskIds].sort(),
      operationIds: [...found.operationIds].sort(),
      receiptRevisions: revisions,
      issues: [...found.issues].sort(),
    };
  };
}

/** Run after Store.seed(), before constructing the Controller or any runtime. */
export function migrateServicesToRooms(store: Store): ServiceRoomMigrationResult {
  const existing = store.get<MigrationMarker>('meta', SERVICE_ROOM_MIGRATION_ID);
  if (existing) {
    if (existing.version !== 1 || !existing.completedAt)
      throw new Error('The service room migration marker is invalid.');
    return {
      services: 0,
      held: 0,
      ...(existing.holdingRoomId ? { holdingRoomId: existing.holdingRoomId } : {}),
    };
  }
  const accounts = store
    .list<LegacyServiceAccount>('serviceAccounts')
    .filter((account) => !account.roomId);
  const resolveOrigin = serviceOrigins(store, accounts);
  const result: ServiceRoomMigrationResult = { services: 0, held: 0 };
  const stamp = now();
  const holdingRoom = () => {
    if (result.holdingRoomId) return result.holdingRoomId;
    const room: Room = {
      id: id('room'),
      name: 'サービスの整理待ち',
      description:
        '元のルームを一意に確認できなかったサービスを保管しています。保存済みの認証情報は保持されています。「メールとサービス」で対象ルームを指定してください。',
      botIds: [],
      pinned: false,
      archived: true,
      paused: true,
      autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY },
      createdAt: stamp,
      updatedAt: stamp,
    };
    store.put('rooms', room);
    result.holdingRoomId = room.id;
    return room.id;
  };

  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const original of accounts) {
      if (!validRevision(original.revision) || original.revision >= Number.MAX_SAFE_INTEGER)
        throw new Error('A service account has no available revision for room migration.');
      const provenance = resolveOrigin(original);
      const held = provenance.issues.length > 0 || provenance.roomIds.length !== 1;
      const roomId = held ? holdingRoom() : provenance.roomIds[0];
      // Keep the complete original registry entry privately. Do not read,
      // decrypt, copy, or rewrite the separately encrypted credential row.
      store.put(SERVICE_ROOM_MIGRATION_AUDIT_KIND, {
        id: id('serviceRoom'),
        migrationId: SERVICE_ROOM_MIGRATION_ID,
        recordId: original.id,
        original,
        roomId,
        held,
        provenance,
        createdAt: stamp,
      });
      store.put('serviceAccounts', {
        ...original,
        roomId,
        revision: original.revision + 1,
        updatedAt: stamp,
      });
      result.services++;
      if (held) result.held++;
    }
    store.put<MigrationMarker>('meta', {
      id: SERVICE_ROOM_MIGRATION_ID,
      version: 1,
      completedAt: stamp,
      ...result,
    });
    store.db.exec('COMMIT');
    return result;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
