import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  BROWSER_ROOM_MIGRATION_AUDIT_KIND,
  BROWSER_ROOM_MIGRATION_ID,
  migrateBrowserProfilesToRooms,
  type BrowserRoomMigrationRecord,
} from '../src/server/browser-room-migration.js';
import { Store } from '../src/server/store.js';
import { exportDataArchive, importDataArchive } from '../src/server/data-transfer-archive.js';
import { botBrowserMode } from '../src/shared/browser.js';
import type { Bot } from '../src/shared/types.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-browser-room-migration-'));
  let store = new Store(directory);
  store.seed();
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
      store.seed();
    },
  };
}

function addBot(store: Store, id: string, mode?: 'dedicated' | 'shared' | 'disabled') {
  const { browser: _, ...base } = store.get<Bot>('bots', 'bot_aster')!;
  return store.put<Bot>('bots', {
    ...base,
    id,
    handle: id,
    name: `Preserve ${id}`,
    systemPrompt: `Keep the instructions for ${id}.`,
    ...(mode === undefined ? {} : { browser: { mode } }),
  });
}

test('legacy shared and omitted settings become dedicated once, retaining exact previous settings privately', async (t) => {
  const f = await fixture(t);
  const originals = [addBot(f.store, 'legacy'), addBot(f.store, 'shared', 'shared')];
  const dedicated = addBot(f.store, 'dedicated', 'dedicated');
  const disabled = addBot(f.store, 'disabled', 'disabled');
  const disabledBot = f.store.put('bots', {
    ...addBot(f.store, 'inactive', 'shared'),
    enabled: false,
  });
  const originalSettings = f.store.get('settings', 'main');

  assert.deepEqual(migrateBrowserProfilesToRooms(f.store), { bots: 3 });
  for (const original of [...originals, disabledBot]) {
    assert.deepEqual(f.store.get<Bot>('bots', original.id), {
      ...original,
      browser: { mode: 'dedicated' },
    });
  }
  assert.deepEqual(f.store.get('bots', dedicated.id), dedicated);
  assert.deepEqual(f.store.get('bots', disabled.id), disabled);
  assert.deepEqual(f.store.get('settings', 'main'), originalSettings);
  const audits = f.store.list<BrowserRoomMigrationRecord>(BROWSER_ROOM_MIGRATION_AUDIT_KIND);
  assert.equal(audits.length, 3);
  for (const original of [...originals, disabledBot]) {
    const audit = audits.find((item) => item.botId === original.id)!;
    assert.equal(audit.migrationId, BROWSER_ROOM_MIGRATION_ID);
    assert.equal(audit.hadBrowserSetting, original.browser !== undefined);
    assert.deepEqual(audit.originalBrowser, original.browser);
    assert.equal(Object.hasOwn(audit, 'originalBrowser'), original.browser !== undefined);
  }

  f.store.patch<Bot>('bots', 'shared', { browser: { mode: 'shared' } });
  f.restart();
  assert.deepEqual(migrateBrowserProfilesToRooms(f.store), { bots: 0 });
  assert.equal(f.store.get<Bot>('bots', 'shared')!.browser!.mode, 'shared');
  assert.deepEqual(f.store.list(BROWSER_ROOM_MIGRATION_AUDIT_KIND), audits);
});

test('profile contents stay untouched and migration does not create a browser or profile directory', async (t) => {
  const f = await fixture(t);
  addBot(f.store, 'shared', 'shared');
  const profiles = [
    join(f.directory, 'browser-profile'),
    join(f.directory, 'browser-profiles', createHash('sha256').update('bot_aster').digest('hex')),
  ];
  for (const profile of profiles) {
    await mkdir(join(profile, 'Default'), { recursive: true });
    await writeFile(join(profile, 'Default', 'Cookies'), 'synthetic retained profile bytes');
    await writeFile(join(profile, 'SingletonLock'), 'synthetic existing Chrome owner');
  }
  const children = await readdir(join(f.directory, 'browser-profiles'));
  migrateBrowserProfilesToRooms(f.store);
  for (const profile of profiles) {
    assert.equal(
      await readFile(join(profile, 'Default', 'Cookies'), 'utf8'),
      'synthetic retained profile bytes',
    );
    assert.equal(
      await readFile(join(profile, 'SingletonLock'), 'utf8'),
      'synthetic existing Chrome owner',
    );
  }
  assert.deepEqual(await readdir(join(f.directory, 'browser-profiles')), children);
});

test('failed migration rolls back bot settings, audit and marker together and can be retried', async (t) => {
  const f = await fixture(t);
  addBot(f.store, 'legacy');
  addBot(f.store, 'shared', 'shared');
  const originals = f.store.list('bots');
  const put = f.store.put;
  f.store.put = function (kind, value) {
    if (kind === 'meta' && value.id === BROWSER_ROOM_MIGRATION_ID)
      throw new Error('Synthetic marker write failure');
    return put.call(this, kind, value) as typeof value;
  };
  assert.throws(() => migrateBrowserProfilesToRooms(f.store), /Synthetic marker write failure/);
  f.store.put = put;
  assert.deepEqual(f.store.list('bots'), originals);
  assert.deepEqual(f.store.list(BROWSER_ROOM_MIGRATION_AUDIT_KIND), []);
  assert.equal(f.store.get('meta', BROWSER_ROOM_MIGRATION_ID), undefined);
  assert.deepEqual(migrateBrowserProfilesToRooms(f.store), { bots: 2 });
});

test('a completed marker preserves deliberate sharing and an invalid marker refuses migration', async (t) => {
  const f = await fixture(t);
  f.store.put('meta', {
    id: BROWSER_ROOM_MIGRATION_ID,
    version: 1,
    completedAt: '2026-11-23T00:00:00.000Z',
    bots: 4,
  });
  addBot(f.store, 'deliberate_shared', 'shared');
  assert.deepEqual(migrateBrowserProfilesToRooms(f.store), { bots: 0 });
  assert.equal(f.store.get<Bot>('bots', 'deliberate_shared')!.browser!.mode, 'shared');
  f.store.patch('meta', BROWSER_ROOM_MIGRATION_ID, { version: 2 });
  assert.throws(() => migrateBrowserProfilesToRooms(f.store), /migration marker is invalid/);
  assert.equal(f.store.get<Bot>('bots', 'deliberate_shared')!.browser!.mode, 'shared');
});

test('omitted bot browser settings no longer silently select the shared browser', () => {
  assert.equal(botBrowserMode({}), 'dedicated');
  assert.equal(botBrowserMode({ browser: { mode: 'dedicated' } }), 'dedicated');
  assert.equal(botBrowserMode({ browser: { mode: 'shared' } }), 'shared');
  assert.equal(botBrowserMode({ browser: { mode: 'disabled' } }), 'disabled');
});

test('encrypted transfer migrates legacy settings and preserves completed migration, later choices and room profiles', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-browser-room-transfer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const password = 'browser room migration transfer fixture';
  const sourcePath = join(directory, 'source');
  const source = new Store(sourcePath);
  try {
    source.seed();
    source.patch<Bot>('bots', 'bot_aster', { browser: { mode: 'shared' } });
  } finally {
    source.close();
  }
  const legacyArchive = join(directory, 'legacy.loomdata');
  const legacyStage = join(directory, 'legacy-stage');
  await exportDataArchive({ dataDir: sourcePath, archivePath: legacyArchive, password });
  await importDataArchive({
    archivePath: legacyArchive,
    stagingDir: legacyStage,
    destinationDataDir: join(directory, 'legacy-destination'),
    password,
  });
  const legacy = new Store(legacyStage);
  let audit: unknown[], marker: unknown;
  try {
    assert.deepEqual(migrateBrowserProfilesToRooms(legacy), { bots: 1 });
    assert.equal(legacy.get<Bot>('bots', 'bot_aster')!.browser!.mode, 'dedicated');
    legacy.patch<Bot>('bots', 'bot_aster', { browser: { mode: 'shared' } });
    audit = legacy.list(BROWSER_ROOM_MIGRATION_AUDIT_KIND);
    marker = legacy.get('meta', BROWSER_ROOM_MIGRATION_ID);
  } finally {
    legacy.close();
  }
  const profilePath = join(
    'browser-profiles',
    'rooms',
    createHash('sha256').update('room_lounge').digest('hex'),
    createHash('sha256').update('bot_nova').digest('hex'),
  );
  await mkdir(join(legacyStage, profilePath), { recursive: true });
  await writeFile(join(legacyStage, profilePath, 'Preferences'), '{"synthetic":"room profile"}');
  const currentArchive = join(directory, 'current.loomdata');
  const currentStage = join(directory, 'current-stage');
  await exportDataArchive({ dataDir: legacyStage, archivePath: currentArchive, password });
  await importDataArchive({
    archivePath: currentArchive,
    stagingDir: currentStage,
    destinationDataDir: join(directory, 'current-destination'),
    password,
  });
  const restored = new Store(currentStage);
  try {
    assert.deepEqual(migrateBrowserProfilesToRooms(restored), { bots: 0 });
    assert.equal(restored.get<Bot>('bots', 'bot_aster')!.browser!.mode, 'shared');
    assert.deepEqual(restored.list(BROWSER_ROOM_MIGRATION_AUDIT_KIND), audit);
    assert.deepEqual(restored.get('meta', BROWSER_ROOM_MIGRATION_ID), marker);
    assert.equal(
      await readFile(join(currentStage, profilePath, 'Preferences'), 'utf8'),
      '{"synthetic":"room profile"}',
    );
  } finally {
    restored.close();
  }
});
