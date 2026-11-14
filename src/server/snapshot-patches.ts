import type { Memory, Skill, SnapshotCollection, SnapshotPatch } from '../shared/types.js';
import { normalizeMemory, normalizeSkill } from '../shared/learning.js';
import type { ServiceAccount } from '../shared/service-accounts.js';
import type { MailService } from './mail-accounts.js';
import { publicServiceAccount } from './service-accounts.js';
import { publicTaskInput, type StoredTaskInput } from './task-inputs.js';
import type { Store, StoreChange } from './store.js';

const collections = new Set<SnapshotCollection>([
  'bots',
  'rooms',
  'messages',
  'tasks',
  'taskInputs',
  'activities',
  'approvals',
  'skills',
  'memories',
  'automations',
  'workItems',
  'wakeups',
  'mailAccounts',
  'serviceAccounts',
  'notifications',
]);

/**
 * Keep identifiers, not a second copy of conversation history. Resolve receipts
 * against committed storage when flushing: rolled-back writes/deletes therefore
 * cannot publish a value which was never committed.
 */
export class SnapshotChanges {
  private dirty = new Map<SnapshotCollection, Set<string>>();
  private settings = false;

  record(change: StoreChange) {
    if (change.kind === 'settings') {
      this.settings = true;
      return;
    }
    if (!collections.has(change.kind as SnapshotCollection)) return;
    const kind = change.kind as SnapshotCollection;
    let ids = this.dirty.get(kind);
    if (!ids) this.dirty.set(kind, (ids = new Set()));
    ids.add(change.id);
  }

  clear() {
    this.dirty.clear();
    this.settings = false;
  }

  flush(store: Store, queue: SnapshotPatch['queue'], mail?: MailService): SnapshotPatch {
    const patch: SnapshotPatch = {
      queue,
      collections: {},
      ...(this.settings ? { settings: store.settings() } : {}),
    };
    for (const [kind, ids] of this.dirty) {
      const rows: {
        value: { id: string };
        position: NonNullable<ReturnType<Store['position']>>;
      }[] = [];
      const removed: string[] = [];
      for (const id of ids) {
        let value = store.get<{ id: string }>(kind, id);
        const position = value && store.position(kind, id);
        if (!value || !position || (kind === 'mailAccounts' && !mail)) {
          removed.push(id);
          continue;
        }
        if (kind === 'skills') value = normalizeSkill(value as Skill);
        else if (kind === 'memories') value = normalizeMemory(value as Memory);
        else if (kind === 'taskInputs') value = publicTaskInput(value as StoredTaskInput);
        else if (kind === 'serviceAccounts')
          value = publicServiceAccount(store, value as ServiceAccount);
        else if (kind === 'mailAccounts') value = mail!.get(id);
        rows.push({ value, position });
      }
      const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      rows.sort(
        (a, b) =>
          compare(a.position.createdAt, b.position.createdAt) ||
          (kind === 'messages'
            ? a.position.rowid - b.position.rowid
            : compare(a.value.id, b.value.id)),
      );
      const upsert = rows.map(({ value }) => value);
      const after = Object.fromEntries(
        rows.map(({ value, position }) => [value.id, position.afterId]),
      );
      // Each branch above is the same public projection used by getSnapshot().
      (
        patch.collections as Record<
          string,
          { upsert: { id: string }[]; removed: string[]; after: Record<string, string | null> }
        >
      )[kind] = { upsert, removed, after };
    }
    this.clear();
    return patch;
  }
}
