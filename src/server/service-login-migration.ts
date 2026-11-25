import type { ServiceAccount } from '../shared/service-accounts.js';
import { resolveServiceLogin } from '../shared/service-login.js';
import { now, type Store } from './store.js';

export interface ServiceLoginMigrationResult {
  services: number;
  skipped: number;
}

/**
 * Bind legacy records before tasks can run. Metadata-only: the existing secret
 * rows are never read, decrypted, replaced or cleared. Per-record completion
 * also handles a later import of an older archive without repeating migration.
 */
export function migrateServiceLogins(store: Store): ServiceLoginMigrationResult {
  const pending: ServiceAccount[] = [];
  let skipped = 0;
  const stamp = now();
  for (const account of store.list<ServiceAccount>('serviceAccounts')) {
    if (account.loginUrl !== undefined) continue;
    if (
      !Number.isSafeInteger(account.revision) ||
      account.revision < 1 ||
      account.revision >= Number.MAX_SAFE_INTEGER
    ) {
      skipped++;
      continue;
    }
    try {
      const { loginUrl, credentialOrigin } = resolveServiceLogin(account.url);
      pending.push({
        ...account,
        loginUrl,
        credentialOrigin,
        revision: account.revision + 1,
        updatedAt: stamp,
      });
    } catch {
      // Invalid legacy metadata never gains an inferred credential recipient.
      skipped++;
    }
  }
  if (!pending.length) return { services: 0, skipped };
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const account of pending) store.put('serviceAccounts', account);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return { services: pending.length, skipped };
}
