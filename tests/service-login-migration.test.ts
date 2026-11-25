import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import { exportDataArchive, importDataArchive } from '../src/server/data-transfer-archive.js';
import {
  getServiceAccount,
  readServiceCredentialForBot,
  saveServiceAccount,
} from '../src/server/service-accounts.js';
import { migrateServiceLogins } from '../src/server/service-login-migration.js';
import { Store } from '../src/server/store.js';
import type { ServiceAccount } from '../src/shared/service-accounts.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-service-login-migration-'));
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
    },
  };
}

function legacy(store: Store, url: string, credential = 'migration-password-fixture') {
  const current = saveServiceAccount(store, {
    name: 'Legacy account',
    url,
    login: 'fixture@example.test',
    botId: 'bot_aster',
    sharedBotIds: ['bot_nova'],
    roomId: 'room_lounge',
    mailAccountId: null,
    status: 'active',
    notes: 'Keep metadata and sharing.',
    credential,
  });
  const { loginUrl: _, credentialOrigin: __, ...account } = current;
  return store.put('serviceAccounts', account);
}

const secrets = (store: Store) =>
  store.db.prepare("SELECT key,value FROM secrets WHERE key LIKE 'service.%' ORDER BY key").all();

test('legacy Google, Amazon and custom services migrate without reading or rewriting saved secrets', async (t) => {
  const f = await fixture(t);
  const originals = [
    legacy(f.store, 'https://mail.google.com/mail/u/0/'),
    legacy(f.store, 'https://affiliate.amazon.co.jp/home'),
    legacy(f.store, 'https://custom.example/app'),
    legacy(f.store, 'https://accounts.google.com/ServiceLogin'),
    legacy(f.store, 'https://www.amazon.co.jp/ap/signin'),
  ];
  const encrypted = secrets(f.store);
  const read = t.mock.method(f.store, 'secret', () => {
    throw new Error('Migration must not decrypt.');
  });
  const write = t.mock.method(f.store, 'setSecret', () => {
    throw new Error('Migration must not rewrite.');
  });
  assert.deepEqual(migrateServiceLogins(f.store), { services: 5, skipped: 0 });
  assert.equal(read.mock.calls.length, 0);
  assert.equal(write.mock.calls.length, 0);
  assert.deepEqual(secrets(f.store), encrypted);
  read.mock.restore();
  write.mock.restore();

  const origins = [
    'https://accounts.google.com',
    'https://www.amazon.co.jp',
    'https://custom.example',
    'https://accounts.google.com',
    'https://www.amazon.co.jp',
  ];
  for (const [index, original] of originals.entries()) {
    const migrated = getServiceAccount(f.store, original.id);
    assert.equal(migrated.credentialOrigin, origins[index]);
    assert.equal(migrated.revision, original.revision + 1);
    assert.deepEqual(migrated.sharedBotIds, original.sharedBotIds);
    assert.equal(migrated.roomId, original.roomId);
    assert.equal(migrated.url, original.url);
    assert.equal(migrated.login, original.login);
    assert.equal(migrated.notes, original.notes);
    assert.equal(migrated.credentialConfigured, true);
    assert.throws(
      () =>
        readServiceCredentialForBot(
          f.store,
          original.id,
          original.revision,
          'bot_aster',
          'room_lounge',
        ),
      /unavailable to this bot/,
    );
    assert.equal(
      readServiceCredentialForBot(
        f.store,
        migrated.id,
        migrated.revision,
        'bot_nova',
        'room_lounge',
      ).credential,
      'migration-password-fixture',
    );
  }
});

test('migration is idempotent across restart, respects explicit entries and handles later legacy imports', async (t) => {
  const f = await fixture(t);
  const initial = legacy(f.store, 'https://mail.google.com/');
  const explicit = saveServiceAccount(f.store, {
    name: 'Explicit entry',
    url: initial.url,
    login: initial.login,
    botId: initial.botId,
    roomId: initial.roomId,
    mailAccountId: null,
    status: 'active',
    notes: '',
    loginUrl: 'https://identity.example/custom',
    credential: 'custom-password-fixture',
  });
  assert.deepEqual(migrateServiceLogins(f.store), { services: 1, skipped: 0 });
  const migrated = f.store.get<ServiceAccount>('serviceAccounts', initial.id)!;
  const encrypted = secrets(f.store);
  f.restart();
  assert.deepEqual(migrateServiceLogins(f.store), { services: 0, skipped: 0 });
  assert.deepEqual(f.store.get('serviceAccounts', initial.id), migrated);
  assert.deepEqual(f.store.get('serviceAccounts', explicit.id), explicit);
  assert.deepEqual(secrets(f.store), encrypted);

  const imported = legacy(f.store, 'https://affiliate.amazon.co.jp/home');
  assert.deepEqual(migrateServiceLogins(f.store), { services: 1, skipped: 0 });
  assert.equal(
    getServiceAccount(f.store, imported.id).credentialOrigin,
    'https://www.amazon.co.jp',
  );
  assert.deepEqual(f.store.get('serviceAccounts', initial.id), migrated);
});

test('a failed migration rolls back every metadata change and can retry with untouched encrypted values', async (t) => {
  const f = await fixture(t);
  legacy(f.store, 'https://mail.google.com/');
  const second = legacy(f.store, 'https://affiliate.amazon.co.jp/');
  const originals = f.store.list('serviceAccounts');
  const encrypted = secrets(f.store);
  const put = f.store.put;
  const failure = t.mock.method(f.store, 'put', function (kind, account) {
    if (kind === 'serviceAccounts' && account.id === second.id)
      throw new Error('Synthetic migration failure.');
    return put.call(this, kind, account);
  });
  assert.throws(() => migrateServiceLogins(f.store), /Synthetic migration failure/);
  assert.deepEqual(f.store.list('serviceAccounts'), originals);
  assert.deepEqual(secrets(f.store), encrypted);
  failure.mock.restore();
  assert.deepEqual(migrateServiceLogins(f.store), { services: 2, skipped: 0 });
});

test('invalid legacy records gain no inferred origin and ordinary alternate hosts stay isolated', async (t) => {
  const f = await fixture(t);
  const invalid = legacy(f.store, 'https://custom.example/');
  f.store.patch('serviceAccounts', invalid.id, { url: 'https://user:private@mail.google.com/' });
  const exhausted = legacy(f.store, 'https://mail.google.com/');
  f.store.patch('serviceAccounts', exhausted.id, { revision: Number.MAX_SAFE_INTEGER });
  const alternate = legacy(f.store, 'https://mail.google.com:8443/');
  const before = f.store.get('serviceAccounts', invalid.id);
  const encrypted = secrets(f.store);
  assert.deepEqual(migrateServiceLogins(f.store), { services: 1, skipped: 2 });
  assert.deepEqual(f.store.get('serviceAccounts', invalid.id), before);
  const invalidPublic = getServiceAccount(f.store, invalid.id);
  assert.equal(invalidPublic.loginUrl, '');
  assert.equal(invalidPublic.credentialOrigin, undefined);
  assert.equal(invalidPublic.credentialConfigured, true);
  assert.equal(f.store.get<ServiceAccount>('serviceAccounts', exhausted.id)?.loginUrl, undefined);
  assert.equal(
    getServiceAccount(f.store, alternate.id).credentialOrigin,
    'https://mail.google.com:8443',
  );
  assert.deepEqual(secrets(f.store), encrypted);
});

test('an invalid explicit imported login entry cannot silently fall back to a known provider', async (t) => {
  const f = await fixture(t);
  const account = legacy(f.store, 'https://mail.google.com/');
  f.store.patch('serviceAccounts', account.id, {
    loginUrl: 'javascript:untrusted()',
    credentialOrigin: 'https://untrusted.example',
  });
  assert.deepEqual(migrateServiceLogins(f.store), { services: 0, skipped: 0 });
  const projected = getServiceAccount(f.store, account.id);
  assert.equal(projected.loginUrl, '');
  assert.equal(projected.credentialOrigin, undefined);
  assert.equal(projected.credentialConfigured, true);
});

test('application startup migrates before the runtime can observe or use a legacy service', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-service-login-startup-'));
  const store = new Store(directory);
  let account: ServiceAccount;
  try {
    store.seed();
    account = legacy(store, 'https://mail.google.com/');
  } finally {
    store.close();
  }
  let observed: ServiceAccount | undefined;
  const instance = await createApp({
    dataDir: directory,
    scheduler: false,
    runtimeFactory: (host) => {
      observed = host.getSnapshot().serviceAccounts?.find((item) => item.id === account.id);
      return {
        start() {},
        async stop() {},
        async shutdown() {},
        queueState: () => ({ active: 0, waiting: 0 }),
      };
    },
  });
  t.after(async () => {
    await instance.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(observed?.loginUrl, 'https://accounts.google.com/ServiceLogin?service=mail');
  assert.equal(observed?.credentialOrigin, 'https://accounts.google.com');
  assert.equal(observed?.revision, account.revision + 1);
});

test('invalid imported login metadata leaves the service API usable and can be repaired with PUT', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-service-login-repair-'));
  const store = new Store(directory);
  let broken: ServiceAccount;
  let valid: ServiceAccount;
  try {
    store.seed();
    broken = legacy(store, 'https://mail.google.com/');
    store.patch('serviceAccounts', broken.id, {
      url: 'file:///legacy-invalid-working-url',
      loginUrl: 'javascript:untrusted()',
      credentialOrigin: 'https://untrusted.example',
    });
    valid = legacy(store, 'https://affiliate.amazon.co.jp/');
  } finally {
    store.close();
  }
  const instance = await createApp({
    dataDir: directory,
    scheduler: false,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  t.after(async () => {
    await instance.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const headers = { host: 'localhost' };
  const list = await instance.app.inject({ url: '/api/service-accounts', headers });
  assert.equal(list.statusCode, 200, list.body);
  const accounts: ServiceAccount[] = list.json();
  assert.equal(accounts.find((account) => account.id === broken.id)?.loginUrl, '');
  assert.equal(
    accounts.find((account) => account.id === valid.id)?.credentialOrigin,
    'https://www.amazon.co.jp',
  );
  assert.equal((await instance.app.inject({ url: '/api/state', headers })).statusCode, 200);
  const repaired = await instance.app.inject({
    method: 'PUT',
    url: `/api/service-accounts/${broken.id}`,
    headers,
    payload: {
      name: broken.name,
      url: 'https://mail.google.com/',
      loginUrl: 'https://accounts.google.com/ServiceLogin?service=mail',
      login: broken.login,
      botId: broken.botId,
      roomId: broken.roomId,
      sharedBotIds: broken.sharedBotIds,
      mailAccountId: broken.mailAccountId,
      status: broken.status,
      notes: broken.notes,
      expectedRevision: broken.revision,
      credential: 'repaired-password-fixture',
    },
  });
  assert.equal(repaired.statusCode, 200, repaired.body);
  assert.equal(repaired.json().credentialOrigin, 'https://accounts.google.com');
  assert.equal(repaired.json().credentialConfigured, true);
  assert.equal(repaired.json().revision, broken.revision + 1);
  assert.equal(
    instance.store.secret(`service.${broken.id}.credential`),
    'repaired-password-fixture',
  );
});

test('encrypted data transfer preserves a migrated binding and migrates an older archive once', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-service-login-transfer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const password = 'service login transfer fixture password';
  const sourcePath = join(directory, 'source');
  const source = new Store(sourcePath);
  let accountId: string;
  try {
    source.seed();
    accountId = legacy(source, 'https://affiliate.amazon.co.jp/home').id;
  } finally {
    source.close();
  }
  for (const stage of ['legacy', 'current']) {
    const archivePath = join(directory, `${stage}.loomdata`);
    const stagingDir = join(directory, `${stage}-staged`);
    await exportDataArchive({ dataDir: sourcePath, archivePath, password });
    await importDataArchive({
      archivePath,
      stagingDir,
      destinationDataDir: join(directory, `${stage}-destination`),
      password,
    });
    const imported = new Store(stagingDir);
    try {
      const before = secrets(imported);
      assert.deepEqual(migrateServiceLogins(imported), {
        services: stage === 'legacy' ? 1 : 0,
        skipped: 0,
      });
      assert.deepEqual(secrets(imported), before);
      const account = getServiceAccount(imported, accountId);
      assert.equal(account.credentialOrigin, 'https://www.amazon.co.jp');
      assert.equal(account.revision, 2);
      assert.equal(
        imported.secret(`service.${accountId}.credential`),
        'migration-password-fixture',
      );
    } finally {
      imported.close();
    }
    if (stage === 'legacy') {
      const original = new Store(sourcePath);
      try {
        migrateServiceLogins(original);
      } finally {
        original.close();
      }
    }
  }
});
