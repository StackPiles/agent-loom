import type { Bot, BotBrowserSettings } from '../shared/types.js';
import { id, now, type Store } from './store.js';

export const BROWSER_ROOM_MIGRATION_ID = 'browserRoomScopeMigrationV1';
export const BROWSER_ROOM_MIGRATION_AUDIT_KIND = 'browserRoomMigrationRecords';

export interface BrowserRoomMigrationResult {
  bots: number;
}

interface MigrationMarker extends BrowserRoomMigrationResult {
  id: typeof BROWSER_ROOM_MIGRATION_ID;
  version: 1;
  completedAt: string;
}

export interface BrowserRoomMigrationRecord {
  id: string;
  migrationId: typeof BROWSER_ROOM_MIGRATION_ID;
  botId: string;
  /** Absence is recorded separately so the original setting can be restored exactly. */
  hadBrowserSetting: boolean;
  originalBrowser?: BotBrowserSettings;
  createdAt: string;
}

/**
 * Run once after seeding, before constructing browser controls or starting tasks.
 * Existing shared choices predate room isolation. Move them to room-and-bot
 * profiles without opening, copying, deleting or inspecting any Chrome profile.
 * A later explicit shared choice survives every subsequent restart or transfer.
 */
export function migrateBrowserProfilesToRooms(store: Store): BrowserRoomMigrationResult {
  const existing = store.get<MigrationMarker>('meta', BROWSER_ROOM_MIGRATION_ID);
  if (existing) {
    if (
      existing.version !== 1 ||
      typeof existing.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(existing.completedAt)) ||
      !Number.isSafeInteger(existing.bots) ||
      existing.bots < 0
    )
      throw new Error('The browser room migration marker is invalid.');
    return { bots: 0 };
  }

  const bots = store
    .list<Bot>('bots')
    .filter((bot) => bot.browser === undefined || bot.browser.mode === 'shared');
  const stamp = now();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const bot of bots) {
      store.put<BrowserRoomMigrationRecord>(BROWSER_ROOM_MIGRATION_AUDIT_KIND, {
        id: id('browserRoom'),
        migrationId: BROWSER_ROOM_MIGRATION_ID,
        botId: bot.id,
        hadBrowserSetting: bot.browser !== undefined,
        ...(bot.browser === undefined ? {} : { originalBrowser: bot.browser }),
        createdAt: stamp,
      });
      store.put<Bot>('bots', { ...bot, browser: { mode: 'dedicated' } });
    }
    store.put<MigrationMarker>('meta', {
      id: BROWSER_ROOM_MIGRATION_ID,
      version: 1,
      completedAt: stamp,
      bots: bots.length,
    });
    store.db.exec('COMMIT');
    return { bots: bots.length };
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
