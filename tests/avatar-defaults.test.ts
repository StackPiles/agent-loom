import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Store } from '../src/server/store.js';
import type { Bot } from '../src/shared/types.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-avatar-defaults-'));
  let store = new Store(directory);
  store.seed();
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
      store.seed();
    },
    legacyDefaults() {
      // Reproduce a database created before the character-avatar migration.
      store.patch<Bot>('bots', 'bot_aster', { avatar: 'sparkles' });
      store.patch<Bot>('bots', 'bot_nova', { avatar: 'compass' });
      store.remove('meta', 'characterAvatarsV1');
    },
  };
}

test('fresh installs seed character avatars and retain the same profiles after restart', async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.get<Bot>('bots', 'bot_aster')?.avatar, 'character:aster');
  assert.equal(f.store.get<Bot>('bots', 'bot_nova')?.avatar, 'character:nova');
  const profiles = f.store.list<Bot>('bots');
  f.restart();
  assert.deepEqual(f.store.list<Bot>('bots'), profiles);
});

test('existing original avatars upgrade without changing personalized profile fields', async (t) => {
  const f = await fixture(t);
  f.legacyDefaults();
  f.store.patch<Bot>('bots', 'bot_aster', {
    name: 'My coordinator',
    handle: 'planner',
    role: 'Custom planning role',
    systemPrompt: 'Keep my personal instructions.',
    color: '#123456',
    enabled: false,
  });
  const aster = f.store.get<Bot>('bots', 'bot_aster')!;
  const nova = f.store.get<Bot>('bots', 'bot_nova')!;
  const rooms = f.store.list('rooms');
  f.restart();
  assert.deepEqual(f.store.get<Bot>('bots', 'bot_aster'), {
    ...aster,
    avatar: 'character:aster',
  });
  assert.deepEqual(f.store.get<Bot>('bots', 'bot_nova'), {
    ...nova,
    avatar: 'character:nova',
  });
  assert.deepEqual(f.store.list('rooms'), rooms);
  const upgraded = f.store.list<Bot>('bots');
  f.restart();
  assert.deepEqual(f.store.list<Bot>('bots'), upgraded);
});

test('avatar migration preserves custom symbols, generated images, and user-created bots', async (t) => {
  const f = await fixture(t);
  f.legacyDefaults();
  f.store.patch<Bot>('bots', 'bot_aster', { avatar: '🌿' });
  f.store.patch<Bot>('bots', 'bot_nova', { avatar: `image:img_${'a'.repeat(64)}` });
  f.store.put<Bot>('bots', {
    ...f.store.get<Bot>('bots', 'bot_aster')!,
    id: 'bot_custom',
    name: 'Custom',
    handle: 'custom',
    avatar: 'sparkles',
  });
  f.store.put<Bot>('bots', {
    ...f.store.get<Bot>('bots', 'bot_nova')!,
    id: 'bot_custom_character',
    name: 'Custom character',
    handle: 'custom-character',
    avatar: 'character:orbit',
  });
  const profiles = f.store.list<Bot>('bots');
  f.restart();
  assert.deepEqual(f.store.list<Bot>('bots'), profiles);
});

test('migration and subsequent restarts never recreate deleted default bots', async (t) => {
  const f = await fixture(t);
  f.legacyDefaults();
  f.store.remove('bots', 'bot_aster');
  f.restart();
  assert.equal(f.store.get<Bot>('bots', 'bot_aster'), undefined);
  assert.equal(f.store.get<Bot>('bots', 'bot_nova')?.avatar, 'character:nova');
  assert.equal(f.store.list<Bot>('bots').length, 1);
  f.store.remove('bots', 'bot_nova');
  f.restart();
  assert.deepEqual(f.store.list<Bot>('bots'), []);
});

test('choosing original icons again after migration survives later restarts', async (t) => {
  const f = await fixture(t);
  f.legacyDefaults();
  f.restart();
  assert.equal(f.store.get<Bot>('bots', 'bot_aster')?.avatar, 'character:aster');
  assert.equal(f.store.get<Bot>('bots', 'bot_nova')?.avatar, 'character:nova');
  f.store.patch<Bot>('bots', 'bot_aster', { avatar: 'sparkles' });
  f.store.patch<Bot>('bots', 'bot_nova', { avatar: 'compass' });
  const profiles = f.store.list<Bot>('bots');
  f.restart();
  assert.deepEqual(f.store.list<Bot>('bots'), profiles);
  f.restart();
  assert.deepEqual(f.store.list<Bot>('bots'), profiles);
});
