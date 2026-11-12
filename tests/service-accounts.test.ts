import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import type { MailAccount } from '../src/shared/mail-accounts.js';
import type { ServiceAccountInput } from '../src/shared/service-accounts.js';
import type { Bot } from '../src/shared/types.js';
import {
  detachServiceAccounts,
  getServiceAccount,
  listServiceAccounts,
  readServiceCredentialForBot,
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

test('legacy records remain private and exact sharing changes preserve the encrypted credential', async (t) => {
  const store = await fixture(t);
  const credential = ' \tshared-service-private-value\n ';
  const initial = saveServiceAccount(store, serviceInput({ credential }));
  const { sharedBotIds: _, ...legacy } = initial;
  store.put('serviceAccounts', legacy);
  assert.deepEqual(getServiceAccount(store, initial.id).sharedBotIds, []);
  assert.equal(
    readServiceCredentialForBot(store, initial.id, initial.revision, 'bot_aster').credential,
    credential,
  );
  assert.throws(
    () => readServiceCredentialForBot(store, initial.id, initial.revision, 'bot_nova'),
    /unavailable to this bot/,
  );
  const shared = saveServiceAccount(
    store,
    serviceInput({ sharedBotIds: ['bot_nova'], expectedRevision: initial.revision }),
    initial.id,
  );
  assert.deepEqual(shared.sharedBotIds, ['bot_nova']);
  assert.equal(shared.botId, 'bot_aster');
  assert.equal(
    readServiceCredentialForBot(store, shared.id, shared.revision, 'bot_nova').credential,
    credential,
  );
  const renamed = saveServiceAccount(
    store,
    serviceInput({ name: 'Renamed shared service', expectedRevision: shared.revision }),
    shared.id,
  );
  assert.deepEqual(renamed.sharedBotIds, ['bot_nova'], 'an omitted update preserves exact shares');
  const privateAgain = saveServiceAccount(
    store,
    serviceInput({ sharedBotIds: [], expectedRevision: renamed.revision }),
    renamed.id,
  );
  assert.deepEqual(privateAgain.sharedBotIds, []);
  for (const revision of [renamed.revision, privateAgain.revision])
    assert.throws(
      () => readServiceCredentialForBot(store, privateAgain.id, revision, 'bot_nova'),
      /unavailable to this bot/,
    );
  assert.equal(store.secret(`service.${initial.id}.credential`), credential);
  assert.ok(!JSON.stringify(listServiceAccounts(store)).includes(credential));
  const reassigned = saveServiceAccount(
    store,
    serviceInput({ botId: 'bot_nova', expectedRevision: privateAgain.revision }),
    privateAgain.id,
  );
  assert.deepEqual(
    reassigned.sharedBotIds,
    [],
    'changing the manager never shares with the old manager',
  );
  assert.throws(
    () => readServiceCredentialForBot(store, reassigned.id, reassigned.revision, 'bot_aster'),
    /unavailable to this bot/,
  );
  assert.equal(
    readServiceCredentialForBot(store, reassigned.id, reassigned.revision, 'bot_nova').credential,
    credential,
  );
});

test('owner sharing rejects invalid and duplicate targets without changing assignments or credentials', async (t) => {
  const store = await fixture(t);
  const initial = saveServiceAccount(store, serviceInput({ credential: 'sharing-retained-value' }));
  for (const sharedBotIds of [
    ['missing'],
    ['bot_nova', 'bot_nova'],
    ['bot_aster'],
    [''],
    [true],
    null,
    'bot_nova',
  ]) {
    assert.throws(() =>
      saveServiceAccount(
        store,
        {
          ...serviceInput({ expectedRevision: initial.revision }),
          sharedBotIds,
        } as ServiceAccountInput,
        initial.id,
      ),
    );
    assert.deepEqual(getServiceAccount(store, initial.id), initial);
    assert.equal(store.secret(`service.${initial.id}.credential`), 'sharing-retained-value');
  }
});

test('bot credential resolution checks current assignment, actor, service and revision before decrypting', async (t) => {
  const store = await fixture(t);
  const initial = saveServiceAccount(
    store,
    serviceInput({ sharedBotIds: ['bot_nova'], credential: 'resolver-private-value' }),
  );
  const secret = store.secret.bind(store);
  let reads = 0;
  store.secret = (name) => {
    reads++;
    return secret(name);
  };
  const unavailable = (botId: string, revision = initial.revision, accountId = initial.id) => {
    const before = reads;
    assert.throws(() => readServiceCredentialForBot(store, accountId, revision, botId), {
      message: 'The service credential is unavailable to this bot. Refresh assigned services.',
      statusCode: 403,
    });
    assert.equal(reads, before, 'unauthorized lookups never decrypt');
  };
  unavailable('missing');
  unavailable('bot_nova', initial.revision + 1);
  unavailable('bot_nova', initial.revision, 'missing');
  store.patch<Bot>('bots', 'bot_nova', { enabled: false });
  unavailable('bot_nova');
  store.patch<Bot>('bots', 'bot_nova', { enabled: true });
  store.patch('serviceAccounts', initial.id, { status: 'disabled' });
  unavailable('bot_nova');
  unavailable('bot_aster');
  store.patch('serviceAccounts', initial.id, { status: 'pending', sharedBotIds: [] });
  unavailable('bot_nova');
  assert.equal(
    readServiceCredentialForBot(store, initial.id, initial.revision, 'bot_aster').credential,
    'resolver-private-value',
  );
  store.remove('bots', 'bot_aster');
  unavailable('bot_aster');
});

test('owners may preconfigure disabled recipients and deleting a shared bot removes only its grant', async (t) => {
  const store = await fixture(t);
  store.patch<Bot>('bots', 'bot_nova', { enabled: false });
  const initial = saveServiceAccount(
    store,
    serviceInput({ sharedBotIds: ['bot_nova'], credential: 'detachment-retained-value' }),
  );
  assert.deepEqual(initial.sharedBotIds, ['bot_nova']);
  assert.throws(
    () => readServiceCredentialForBot(store, initial.id, initial.revision, 'bot_nova'),
    /unavailable to this bot/,
  );
  detachServiceAccounts(store, { botId: 'bot_nova' });
  const detached = getServiceAccount(store, initial.id);
  assert.deepEqual(detached.sharedBotIds, []);
  assert.equal(detached.botId, initial.botId);
  assert.equal(detached.revision, initial.revision + 1);
  assert.equal(store.secret(`service.${initial.id}.credential`), 'detachment-retained-value');
  assert.throws(
    () => readServiceCredentialForBot(store, detached.id, initial.revision, 'bot_aster'),
    /unavailable to this bot/,
  );
});

test('bot credential failures never expose storage diagnostics or distinguish saved values', async (t) => {
  const store = await fixture(t);
  const initial = saveServiceAccount(store, serviceInput());
  assert.throws(
    () => readServiceCredentialForBot(store, initial.id, initial.revision, 'bot_aster'),
    /unavailable to this bot/,
  );
  store.secret = () => {
    throw new Error('private storage diagnostic with plaintext');
  };
  assert.throws(
    () => readServiceCredentialForBot(store, initial.id, initial.revision, 'bot_aster'),
    { message: 'The service credential is unavailable to this bot. Refresh assigned services.' },
  );
});
