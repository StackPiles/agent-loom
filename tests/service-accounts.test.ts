import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import type { MailAccount } from '../src/shared/mail-accounts.js';
import type { ServiceAccountInput } from '../src/shared/service-accounts.js';
import {
  detachServiceAccounts,
  getServiceAccount,
  listServiceAccounts,
  removeServiceAccount,
  saveServiceAccount,
} from '../src/server/service-accounts.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-services-'));
  const store = new Store(directory);
  store.seed();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

const serviceInput = (overrides: Partial<ServiceAccountInput> = {}): ServiceAccountInput => ({
  name: 'Research service',
  url: 'https://service.example/login',
  login: 'research@example.test',
  botId: 'bot_aster',
  mailAccountId: null,
  status: 'active',
  notes: 'Used for research.',
  ...overrides,
});

test('service credentials are encrypted and omitted from every public registry projection', async (t) => {
  const store = await fixture(t);
  const credential = 'fixture-secret-service-key';
  const account = saveServiceAccount(store, serviceInput({ credential }));
  assert.equal(account.credentialConfigured, true);
  assert.equal(store.secret(`service.${account.id}.credential`), credential);
  assert.ok(!JSON.stringify(account).includes(credential));
  assert.ok(!JSON.stringify(listServiceAccounts(store)).includes(credential));
  const raw = store.db
    .prepare('SELECT data FROM objects WHERE kind=? AND id=?')
    .get('serviceAccounts', account.id) as { data: string };
  const encrypted = store.db
    .prepare('SELECT value FROM secrets WHERE key=?')
    .get(`service.${account.id}.credential`) as { value: string };
  assert.ok(!raw.data.includes(credential));
  assert.ok(!encrypted.value.includes(credential));
});

test('same-identity edits retain credentials; origin or login edits clear an omitted credential', async (t) => {
  const store = await fixture(t);
  let account = saveServiceAccount(store, serviceInput({ credential: 'fixture-original-secret' }));
  account = saveServiceAccount(
    store,
    serviceInput({
      name: 'Renamed',
      url: 'https://service.example/settings',
      expectedRevision: account.revision,
    }),
    account.id,
  );
  assert.equal(account.credentialConfigured, true);
  assert.equal(store.secret(`service.${account.id}.credential`), 'fixture-original-secret');
  account = saveServiceAccount(
    store,
    serviceInput({ url: 'https://other.example/login', expectedRevision: account.revision }),
    account.id,
  );
  assert.equal(account.credentialConfigured, false);
  account = saveServiceAccount(
    store,
    serviceInput({ credential: 'fixture-replacement-secret', expectedRevision: account.revision }),
    account.id,
  );
  assert.equal(account.credentialConfigured, true);
  account = saveServiceAccount(
    store,
    serviceInput({ login: 'other@example.test', expectedRevision: account.revision }),
    account.id,
  );
  assert.equal(account.credentialConfigured, false);
});

test('a stale service edit cannot overwrite newer metadata or its credential', async (t) => {
  const store = await fixture(t);
  const initial = saveServiceAccount(store, serviceInput({ credential: 'fixture-secret' }));
  const current = saveServiceAccount(
    store,
    serviceInput({ name: 'Current name', expectedRevision: initial.revision }),
    initial.id,
  );
  assert.throws(
    () =>
      saveServiceAccount(
        store,
        serviceInput({ credential: 'stale-secret', expectedRevision: initial.revision }),
        initial.id,
      ),
    { statusCode: 409 },
  );
  assert.equal(getServiceAccount(store, initial.id).name, current.name);
  assert.equal(store.secret(`service.${initial.id}.credential`), 'fixture-secret');
});

test('credential-only rotation and explicit clearing advance revision without changing service identity', async (t) => {
  const store = await fixture(t);
  const initial = saveServiceAccount(
    store,
    serviceInput({ credential: 'fixture-original-credential' }),
  );
  const rotated = saveServiceAccount(
    store,
    serviceInput({
      credential: 'fixture-rotated-credential',
      expectedRevision: initial.revision,
    }),
    initial.id,
  );
  assert.deepEqual(rotated, {
    ...initial,
    revision: initial.revision + 1,
    updatedAt: rotated.updatedAt,
  });
  assert.equal(store.secret(`service.${initial.id}.credential`), 'fixture-rotated-credential');
  const cleared = saveServiceAccount(
    store,
    serviceInput({ credential: '', expectedRevision: rotated.revision }),
    initial.id,
  );
  assert.deepEqual(cleared, {
    ...rotated,
    credentialConfigured: false,
    revision: rotated.revision + 1,
    updatedAt: cleared.updatedAt,
  });
  assert.equal(store.secret(`service.${initial.id}.credential`), '');
  assert.equal(
    store.db
      .prepare('SELECT value FROM secrets WHERE key=?')
      .get(`service.${initial.id}.credential`),
    undefined,
  );
  assert.doesNotMatch(
    JSON.stringify([initial, rotated, cleared, listServiceAccounts(store)]),
    /fixture-(?:original|rotated)-credential/,
  );
});

test('credential whitespace is preserved exactly through storage and same-identity edits', async (t) => {
  const store = await fixture(t);
  const credential = ' \tfixture-key with spaces\r\n ';
  const initial = saveServiceAccount(store, serviceInput({ credential }));
  assert.equal(store.secret(`service.${initial.id}.credential`), credential);
  const edited = saveServiceAccount(
    store,
    serviceInput({ name: 'Renamed service', expectedRevision: initial.revision }),
    initial.id,
  );
  assert.equal(edited.credentialConfigured, true);
  assert.equal(store.secret(`service.${initial.id}.credential`), credential);
  assert.doesNotMatch(JSON.stringify(listServiceAccounts(store)), /fixture-key with spaces/);
});

test('credential-only changes reject stale rotations, clearing and identity edits', async (t) => {
  const store = await fixture(t);
  const initial = saveServiceAccount(
    store,
    serviceInput({ credential: 'fixture-initial-credential' }),
  );
  const current = saveServiceAccount(
    store,
    serviceInput({
      credential: 'fixture-current-credential',
      expectedRevision: initial.revision,
    }),
    initial.id,
  );
  for (const change of [
    { credential: 'fixture-stale-credential' },
    { credential: '' },
    { name: 'Stale name', login: 'stale@example.test' },
  ]) {
    assert.throws(
      () =>
        saveServiceAccount(
          store,
          serviceInput({ ...change, expectedRevision: initial.revision }),
          initial.id,
        ),
      { statusCode: 409 },
    );
    assert.deepEqual(getServiceAccount(store, initial.id), current);
    assert.equal(store.secret(`service.${initial.id}.credential`), 'fixture-current-credential');
  }
});

test('failed metadata writes roll back credential replacement, deletion and new secret creation', async (t) => {
  const store = await fixture(t);
  const initial = saveServiceAccount(
    store,
    serviceInput({ credential: 'fixture-retained-credential' }),
  );
  const secretRows = () =>
    store.db.prepare("SELECT key,value FROM secrets WHERE key LIKE 'service.%' ORDER BY key").all();
  const originalSecrets = secretRows();
  store.db.exec(`
    CREATE TEMP TRIGGER reject_service_metadata BEFORE INSERT ON objects
    WHEN NEW.kind = 'serviceAccounts'
    BEGIN
      SELECT RAISE(ABORT, 'Synthetic service metadata failure');
    END;
  `);
  try {
    for (const credential of ['fixture-rejected-credential', '']) {
      assert.throws(
        () =>
          saveServiceAccount(
            store,
            serviceInput({
              name: 'Rejected edit',
              credential,
              expectedRevision: initial.revision,
            }),
            initial.id,
          ),
        /Synthetic service metadata failure/,
      );
      assert.deepEqual(getServiceAccount(store, initial.id), initial);
      assert.equal(store.secret(`service.${initial.id}.credential`), 'fixture-retained-credential');
      assert.deepEqual(secretRows(), originalSecrets);
    }
    assert.throws(
      () => saveServiceAccount(store, serviceInput({ credential: 'fixture-orphan-credential' })),
      /Synthetic service metadata failure/,
    );
    assert.deepEqual(listServiceAccounts(store), [initial]);
    assert.deepEqual(secretRows(), originalSecrets);
  } finally {
    store.db.exec('DROP TRIGGER reject_service_metadata');
  }
  const recovered = saveServiceAccount(
    store,
    serviceInput({ credential: '', expectedRevision: initial.revision }),
    initial.id,
  );
  assert.equal(recovered.revision, initial.revision + 1);
  assert.equal(recovered.credentialConfigured, false);
});

test('service links require an existing mail account assigned to the selected bot', async (t) => {
  const store = await fixture(t);
  const stamp = new Date().toISOString();
  const mail: MailAccount = {
    id: 'mail_test',
    name: 'Mail',
    address: 'research@example.test',
    provider: 'imap',
    enabled: true,
    botIds: ['bot_nova'],
    sendPolicy: 'ask',
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
  store.put('mailAccounts', mail);
  assert.throws(
    () => saveServiceAccount(store, serviceInput({ mailAccountId: mail.id })),
    /Assign this mail account/,
  );
  assert.throws(
    () => saveServiceAccount(store, serviceInput({ mailAccountId: 'missing' })),
    /existing mail account/,
  );
  assert.throws(
    () => saveServiceAccount(store, serviceInput({ botId: 'missing' })),
    /existing bot/,
  );
  const account = saveServiceAccount(
    store,
    serviceInput({ botId: 'bot_nova', mailAccountId: mail.id }),
  );
  assert.equal(account.mailAccountId, mail.id);
});

test('unassigning bots or mail retains service identity and credentials; local disconnect erases only local records', async (t) => {
  const store = await fixture(t);
  const stamp = new Date().toISOString();
  store.put<MailAccount>('mailAccounts', {
    id: 'mail_test',
    name: 'Mail',
    address: 'research@example.test',
    provider: 'imap',
    enabled: true,
    botIds: ['bot_aster'],
    sendPolicy: 'ask',
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  });
  const initial = saveServiceAccount(
    store,
    serviceInput({ mailAccountId: 'mail_test', credential: 'fixture-retained-secret' }),
  );
  detachServiceAccounts(store, { botId: 'bot_aster' });
  let account = getServiceAccount(store, initial.id);
  assert.equal(account.botId, null);
  assert.equal(account.mailAccountId, 'mail_test');
  detachServiceAccounts(store, { mailAccountId: 'mail_test' });
  account = getServiceAccount(store, initial.id);
  assert.equal(account.mailAccountId, null);
  assert.equal(account.url, initial.url);
  assert.equal(account.login, initial.login);
  assert.equal(store.secret(`service.${initial.id}.credential`), 'fixture-retained-secret');
  assert.throws(() => removeServiceAccount(store, initial.id, initial.revision), {
    statusCode: 409,
  });
  removeServiceAccount(store, initial.id, account.revision);
  assert.equal(listServiceAccounts(store).length, 0);
  assert.equal(store.secret(`service.${initial.id}.credential`), '');
  assert.ok(store.get('mailAccounts', 'mail_test'));
});

test('service URLs cannot carry credentials, unsafe schemes, or hidden executable properties', async (t) => {
  const store = await fixture(t);
  for (const url of [
    'javascript:alert(1)',
    'file:///tmp/test',
    'https://user:pass@service.example',
    'https://service.example/?api_key=secret',
  ])
    assert.throws(() => saveServiceAccount(store, serviceInput({ url })));
  assert.throws(() =>
    saveServiceAccount(store, { ...serviceInput(), command: 'unexpected' } as ServiceAccountInput),
  );
  assert.equal(listServiceAccounts(store).length, 0);
});
