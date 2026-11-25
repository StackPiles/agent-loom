import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import type { MailAccount } from '../src/shared/mail-accounts.js';
import type { ServiceAccountInput } from '../src/shared/service-accounts.js';
import type { Bot, Room } from '../src/shared/types.js';
import type { ToolContext } from '../src/server/runtime/contract.js';
import { prepareServiceBrowserCredential } from '../src/server/runtime/service-browser.js';
import {
  detachServiceAccounts,
  getServiceAccount,
  listServiceAccounts,
  readServiceCredential,
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
  roomId: null,
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

test('public service metadata and credential preparation never decrypt before explicit resolution', async (t) => {
  const store = await fixture(t);
  const account = saveServiceAccount(
    store,
    serviceInput({ url: 'https://mail.google.com/', credential: 'just-in-time-fixture' }),
  );
  const secret = store.secret.bind(store);
  const reads = t.mock.method(store, 'secret', secret);
  assert.equal(getServiceAccount(store, account.id).credentialConfigured, true);
  assert.equal(listServiceAccounts(store)[0].credentialConfigured, true);
  assert.equal(reads.mock.calls.length, 0);

  const context = {
    task: { botId: 'bot_aster', roomId: 'room_lounge' },
    host: {
      getBot: (id: string) => store.get<Bot>('bots', id),
      getRoom: (id: string) => store.get<Room>('rooms', id),
      getServiceAccount: (id: string) => getServiceAccount(store, id),
      readServiceCredentialForBot: (
        ...args: Parameters<typeof readServiceCredentialForBot> extends [Store, ...infer Rest]
          ? Rest
          : never
      ) => readServiceCredentialForBot(store, ...args),
    },
  } as unknown as ToolContext;
  const prepared = prepareServiceBrowserCredential(context, {
    operation: 'fill',
    serviceId: account.id,
    expectedRevision: account.revision,
  })!;
  prepared.assertCurrent();
  assert.equal(prepared.binding.origin, 'https://accounts.google.com');
  assert.equal(reads.mock.calls.length, 0, 'preflight metadata and access checks do not decrypt');
  assert.throws(
    () =>
      readServiceCredentialForBot(
        store,
        account.id,
        account.revision + 1,
        'bot_aster',
        'room_lounge',
      ),
    /unavailable to this bot/,
  );
  assert.equal(reads.mock.calls.length, 0);

  assert.equal(prepared.binding.resolve(), 'just-in-time-fixture');
  assert.equal(reads.mock.calls.length, 1);
  assert.equal(
    readServiceCredential(store, account.id, account.revision).credential,
    'just-in-time-fixture',
  );
  assert.equal(reads.mock.calls.length, 2);
  store.setSecret(`service.${account.id}.credential`, '');
  assert.equal(getServiceAccount(store, account.id).credentialConfigured, false);
  assert.equal(reads.mock.calls.length, 2);
});

test('working URL edits retain the original login binding; login identity edits clear an omitted credential', async (t) => {
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
  assert.equal(account.credentialConfigured, true);
  assert.equal(account.loginUrl, 'https://service.example/login');
  assert.equal(account.credentialOrigin, 'https://service.example');
  assert.equal(store.secret(`service.${account.id}.credential`), 'fixture-original-secret');
  account = saveServiceAccount(
    store,
    serviceInput({
      loginUrl: 'https://other.example/login',
      expectedRevision: account.revision,
    }),
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

test('known service registrations separate working pages from their authentication origin', async (t) => {
  const store = await fixture(t);
  for (const [url, loginUrl, credentialOrigin] of [
    [
      'https://mail.google.com/mail/u/0/',
      'https://accounts.google.com/ServiceLogin?service=mail',
      'https://accounts.google.com',
    ],
    [
      'https://affiliate.amazon.co.jp/home',
      'https://affiliate.amazon.co.jp/login',
      'https://www.amazon.co.jp',
    ],
  ]) {
    const account = saveServiceAccount(store, serviceInput({ url, credential: 'saved-fixture' }));
    assert.equal(account.url, url);
    assert.equal(account.loginUrl, loginUrl);
    assert.equal(account.credentialOrigin, credentialOrigin);
    assert.equal(account.credentialConfigured, true);
    assert.equal(getServiceAccount(store, account.id).credentialOrigin, credentialOrigin);
    assert.equal(store.secret(`service.${account.id}.credential`), 'saved-fixture');
  }
});

test('explicit login entries support custom identity providers and preserve credentials only on the same origin', async (t) => {
  const store = await fixture(t);
  const initial = saveServiceAccount(
    store,
    serviceInput({
      url: 'https://workspace.example/app',
      loginUrl: 'https://identity.example/authorize?client_id=public-client',
      credential: 'idp-fixture',
    }),
  );
  assert.equal(initial.credentialOrigin, 'https://identity.example');
  const moved = saveServiceAccount(
    store,
    serviceInput({
      url: 'https://new-workspace.example/',
      loginUrl: 'https://identity.example/login',
      expectedRevision: initial.revision,
    }),
    initial.id,
  );
  assert.equal(moved.credentialConfigured, true);
  assert.equal(store.secret(`service.${initial.id}.credential`), 'idp-fixture');
  const rebound = saveServiceAccount(
    store,
    serviceInput({
      loginUrl: 'https://different-identity.example/login',
      expectedRevision: moved.revision,
    }),
    initial.id,
  );
  assert.equal(rebound.credentialConfigured, false);
  assert.equal(store.secret(`service.${initial.id}.credential`), '');
  const replacement = saveServiceAccount(
    store,
    serviceInput({
      loginUrl: 'https://replacement-identity.example/login',
      credential: 'new-account-fixture',
      expectedRevision: rebound.revision,
    }),
    initial.id,
  );
  assert.equal(replacement.credentialConfigured, true);
  assert.equal(replacement.credentialOrigin, 'https://replacement-identity.example');
  assert.equal(store.secret(`service.${initial.id}.credential`), 'new-account-fixture');
});

test('login entry validation rejects secret URLs and callers cannot forge a credential origin', async (t) => {
  const store = await fixture(t);
  for (const loginUrl of [
    '',
    'javascript:alert(1)',
    'file:///tmp/test',
    'https://user:password@identity.example/',
    'https://identity.example/?access_token=fixture-private-value',
    'https://identity.example/#access_token=fixture-private-value',
  ])
    assert.throws(() => saveServiceAccount(store, serviceInput({ loginUrl })));
  assert.throws(() =>
    saveServiceAccount(store, {
      ...serviceInput(),
      credentialOrigin: 'https://untrusted.example',
    } as ServiceAccountInput),
  );
  assert.equal(listServiceAccounts(store).length, 0);
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
    readServiceCredentialForBot(store, initial.id, initial.revision, 'bot_aster', 'room_lounge')
      .credential,
    credential,
  );
  assert.throws(
    () =>
      readServiceCredentialForBot(store, initial.id, initial.revision, 'bot_nova', 'room_lounge'),
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
    readServiceCredentialForBot(store, shared.id, shared.revision, 'bot_nova', 'room_lounge')
      .credential,
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
      () =>
        readServiceCredentialForBot(store, privateAgain.id, revision, 'bot_nova', 'room_lounge'),
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
    () =>
      readServiceCredentialForBot(
        store,
        reassigned.id,
        reassigned.revision,
        'bot_aster',
        'room_lounge',
      ),
    /unavailable to this bot/,
  );
  assert.equal(
    readServiceCredentialForBot(
      store,
      reassigned.id,
      reassigned.revision,
      'bot_nova',
      'room_lounge',
    ).credential,
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
    assert.throws(
      () => readServiceCredentialForBot(store, accountId, revision, botId, 'room_lounge'),
      {
        message: 'The service credential is unavailable to this bot. Refresh assigned services.',
        statusCode: 403,
      },
    );
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
    readServiceCredentialForBot(store, initial.id, initial.revision, 'bot_aster', 'room_lounge')
      .credential,
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
    () =>
      readServiceCredentialForBot(store, initial.id, initial.revision, 'bot_nova', 'room_lounge'),
    /unavailable to this bot/,
  );
  detachServiceAccounts(store, { botId: 'bot_nova' });
  const detached = getServiceAccount(store, initial.id);
  assert.deepEqual(detached.sharedBotIds, []);
  assert.equal(detached.botId, initial.botId);
  assert.equal(detached.revision, initial.revision + 1);
  assert.equal(store.secret(`service.${initial.id}.credential`), 'detachment-retained-value');
  assert.throws(
    () =>
      readServiceCredentialForBot(store, detached.id, initial.revision, 'bot_aster', 'room_lounge'),
    /unavailable to this bot/,
  );
});

test('bot credential failures never expose storage diagnostics or distinguish saved values', async (t) => {
  const store = await fixture(t);
  const initial = saveServiceAccount(store, serviceInput());
  assert.throws(
    () =>
      readServiceCredentialForBot(store, initial.id, initial.revision, 'bot_aster', 'room_lounge'),
    /unavailable to this bot/,
  );
  store.secret = () => {
    throw new Error('private storage diagnostic with plaintext');
  };
  assert.throws(
    () =>
      readServiceCredentialForBot(store, initial.id, initial.revision, 'bot_aster', 'room_lounge'),
    { message: 'The service credential is unavailable to this bot. Refresh assigned services.' },
  );
});

test('new services require explicit room scope and omitted update scope preserves the saved room', async (t) => {
  const store = await fixture(t);
  const { roomId: _, ...omitted } = serviceInput({ credential: 'scope-retained-secret' });
  assert.throws(() => saveServiceAccount(store, omitted), /Choose a room or explicitly share/);
  assert.equal(store.list('serviceAccounts').length, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM secrets').get()!.count, 0);
  const scoped = saveServiceAccount(store, { ...omitted, roomId: 'room_lounge' });
  const changed = saveServiceAccount(
    store,
    { ...omitted, name: 'Renamed without changing scope', expectedRevision: scoped.revision },
    scoped.id,
  );
  assert.equal(changed.roomId, 'room_lounge');
  assert.equal(store.secret(`service.${scoped.id}.credential`), 'scope-retained-secret');
  const shared = saveServiceAccount(store, serviceInput({ roomId: null }));
  assert.equal(shared.roomId, null, 'all-room sharing requires an explicit null');
});

test('same-bot service credentials are inaccessible in another room before any secret is read', async (t) => {
  const store = await fixture(t);
  const original = store.get<Room>('rooms', 'room_lounge')!;
  store.put('rooms', { ...original, id: 'room_other' });
  const service = saveServiceAccount(
    store,
    serviceInput({
      roomId: original.id,
      sharedBotIds: ['bot_nova'],
      credential: 'room-only-secret',
    }),
  );
  const secret = store.secret.bind(store);
  let reads = 0;
  store.secret = (key) => {
    reads++;
    return secret(key);
  };
  for (const botId of ['bot_aster', 'bot_nova']) {
    assert.throws(
      () => readServiceCredentialForBot(store, service.id, service.revision, botId, 'room_other'),
      { statusCode: 403 },
    );
    assert.equal(reads, 0);
  }
  assert.equal(
    readServiceCredentialForBot(store, service.id, service.revision, 'bot_nova', original.id)
      .credential,
    'room-only-secret',
  );
  reads = 0;
  const { roomId: _, ...legacy } = service;
  store.put('serviceAccounts', legacy);
  assert.throws(
    () =>
      readServiceCredentialForBot(store, service.id, service.revision, 'bot_aster', original.id),
    { statusCode: 403 },
  );
  assert.equal(reads, 0, 'unmigrated legacy scope cannot default to global access');
});

test('room reassignment keeps credentials and invalidates prior service access and revisions', async (t) => {
  const store = await fixture(t);
  const original = store.get<Room>('rooms', 'room_lounge')!;
  store.put('rooms', { ...original, id: 'room_other' });
  const service = saveServiceAccount(
    store,
    serviceInput({ roomId: original.id, credential: 'retained-through-room-change' }),
  );
  const { credential: _, ...fields } = serviceInput();
  const moved = saveServiceAccount(
    store,
    { ...fields, roomId: 'room_other', expectedRevision: service.revision },
    service.id,
  );
  assert.equal(moved.revision, service.revision + 1);
  assert.equal(moved.credentialConfigured, true);
  assert.equal(store.secret(`service.${service.id}.credential`), 'retained-through-room-change');
  for (const [revision, roomId] of [
    [service.revision, 'room_other'],
    [moved.revision, original.id],
  ] as const)
    assert.throws(
      () => readServiceCredentialForBot(store, service.id, revision, 'bot_aster', roomId),
      { statusCode: 403 },
    );
  assert.equal(
    readServiceCredentialForBot(store, moved.id, moved.revision, 'bot_aster', 'room_other')
      .credential,
    'retained-through-room-change',
  );
});

test('scoped assignments require room members while existing inert recipients survive metadata edits', async (t) => {
  const store = await fixture(t);
  const room = store.get<Room>('rooms', 'room_lounge')!;
  store.put('rooms', { ...room, id: 'room_private', botIds: ['bot_aster'] });
  for (const patch of [
    { roomId: 'missing' },
    { roomId: 'room_private', botId: 'bot_nova' },
    { roomId: 'room_private', sharedBotIds: ['bot_nova'] },
  ])
    assert.throws(() => saveServiceAccount(store, serviceInput(patch)));
  assert.equal(store.list('serviceAccounts').length, 0);
  const service = saveServiceAccount(
    store,
    serviceInput({ roomId: room.id, sharedBotIds: ['bot_nova'], credential: 'kept-secret' }),
  );
  store.put('rooms', { ...room, id: room.id, botIds: ['bot_aster'] });
  const unchangedAssignments = saveServiceAccount(
    store,
    serviceInput({ roomId: room.id, notes: 'Metadata only', expectedRevision: service.revision }),
    service.id,
  );
  assert.deepEqual(unchangedAssignments.sharedBotIds, ['bot_nova']);
  assert.throws(
    () =>
      readServiceCredentialForBot(
        store,
        service.id,
        unchangedAssignments.revision,
        'bot_nova',
        room.id,
      ),
    { statusCode: 403 },
  );
  assert.throws(() =>
    saveServiceAccount(
      store,
      serviceInput({ roomId: 'room_private', expectedRevision: unchangedAssignments.revision }),
      service.id,
    ),
  );
  const assigned = saveServiceAccount(
    store,
    serviceInput({
      roomId: 'room_private',
      sharedBotIds: [],
      expectedRevision: unchangedAssignments.revision,
    }),
    service.id,
  );
  assert.deepEqual(assigned.sharedBotIds, []);
  assert.equal(assigned.roomId, 'room_private');
  assert.equal(store.secret(`service.${service.id}.credential`), 'kept-secret');
});

test('same-room edits retain missing bot references without allowing new grants, promotions or room moves', async (t) => {
  const store = await fixture(t);
  const room = store.get<Room>('rooms', 'room_lounge')!;
  store.put('rooms', { ...room, id: 'room_other' });
  const service = saveServiceAccount(
    store,
    serviceInput({
      roomId: room.id,
      sharedBotIds: ['bot_nova'],
      credential: 'orphan-assignment-secret',
    }),
  );
  // Older datasets can retain references to bots which no longer exist.
  store.remove('bots', 'bot_aster');
  store.remove('bots', 'bot_nova');
  const { roomId: _, ...fields } = serviceInput();
  const edited = saveServiceAccount(
    store,
    { ...fields, notes: 'Historical account retained', expectedRevision: service.revision },
    service.id,
  );
  assert.equal(edited.roomId, room.id);
  assert.equal(edited.botId, 'bot_aster');
  assert.deepEqual(edited.sharedBotIds, ['bot_nova']);
  assert.equal(edited.revision, service.revision + 1);
  assert.equal(store.secret(`service.${service.id}.credential`), 'orphan-assignment-secret');
  for (const patch of [
    { botId: 'bot_nova', sharedBotIds: [] },
    { sharedBotIds: ['bot_nova', 'missing'] },
    { roomId: 'room_other' },
    { roomId: null },
  ]) {
    assert.throws(() =>
      saveServiceAccount(
        store,
        { ...fields, ...patch, expectedRevision: edited.revision },
        service.id,
      ),
    );
    assert.deepEqual(getServiceAccount(store, service.id), edited);
  }
  const reduced = saveServiceAccount(
    store,
    { ...fields, botId: null, expectedRevision: edited.revision },
    service.id,
  );
  assert.equal(reduced.botId, null);
  assert.deepEqual(reduced.sharedBotIds, ['bot_nova']);
  assert.equal(reduced.roomId, room.id);
  assert.equal(reduced.revision, edited.revision + 1);
  assert.equal(store.get('bots', 'bot_aster'), undefined);
  assert.equal(store.get('bots', 'bot_nova'), undefined);
  assert.throws(
    () => readServiceCredentialForBot(store, service.id, reduced.revision, 'bot_nova', room.id),
    { statusCode: 403 },
  );
  assert.equal(store.secret(`service.${service.id}.credential`), 'orphan-assignment-secret');
});

test('owners may revoke grants in an archived holding room without allowing new assignments', async (t) => {
  const store = await fixture(t);
  const room = store.get<Room>('rooms', 'room_lounge')!;
  const service = saveServiceAccount(
    store,
    serviceInput({ roomId: room.id, sharedBotIds: ['bot_nova'], credential: 'held-secret' }),
  );
  store.patch<Room>('rooms', room.id, { archived: true, paused: true, botIds: [] });
  assert.throws(
    () =>
      saveServiceAccount(
        store,
        serviceInput({
          roomId: room.id,
          botId: 'bot_nova',
          sharedBotIds: [],
          expectedRevision: service.revision,
        }),
        service.id,
      ),
    /active room/,
  );
  const privateAgain = saveServiceAccount(
    store,
    serviceInput({ roomId: room.id, sharedBotIds: [], expectedRevision: service.revision }),
    service.id,
  );
  assert.equal(privateAgain.botId, 'bot_aster');
  assert.deepEqual(privateAgain.sharedBotIds, []);
  const unassigned = saveServiceAccount(
    store,
    serviceInput({ roomId: room.id, botId: null, expectedRevision: privateAgain.revision }),
    service.id,
  );
  assert.equal(unassigned.botId, null);
  assert.deepEqual(unassigned.sharedBotIds, []);
  assert.equal(unassigned.roomId, room.id);
  assert.equal(unassigned.revision, service.revision + 2);
  assert.equal(unassigned.createdAt, service.createdAt);
  for (const patch of [{ botId: 'bot_aster' }, { sharedBotIds: ['bot_nova'] }]) {
    assert.throws(
      () =>
        saveServiceAccount(
          store,
          serviceInput({
            roomId: room.id,
            botId: null,
            ...patch,
            expectedRevision: unassigned.revision,
          }),
          service.id,
        ),
      /active room/,
    );
    assert.deepEqual(getServiceAccount(store, service.id), unassigned);
  }
  assert.throws(() => saveServiceAccount(store, serviceInput({ roomId: room.id })), /active room/);
  assert.equal(store.secret(`service.${service.id}.credential`), 'held-secret');
  assert.deepEqual(store.get<Room>('rooms', room.id)!.botIds, []);
});

test('same-room metadata edits retain stale mail links while new links and grants remain validated', async (t) => {
  const store = await fixture(t);
  const room = store.get<Room>('rooms', 'room_lounge')!;
  store.put('rooms', { ...room, id: 'room_other' });
  const stamp = new Date().toISOString();
  const mail: MailAccount = {
    id: 'mail_retained',
    name: 'Historical mailbox',
    address: 'history@example.test',
    provider: 'imap',
    enabled: true,
    botIds: ['bot_aster'],
    sendPolicy: 'ask',
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
  store.put('mailAccounts', mail);
  const fields = serviceInput({ roomId: room.id, mailAccountId: mail.id });
  const service = saveServiceAccount(store, { ...fields, credential: 'stale-link-secret' });
  store.patch<MailAccount>('mailAccounts', mail.id, { botIds: [] });
  const edited = saveServiceAccount(
    store,
    { ...fields, notes: 'Preserve the historical link', expectedRevision: service.revision },
    service.id,
  );
  assert.equal(edited.mailAccountId, mail.id);
  assert.deepEqual(store.get<MailAccount>('mailAccounts', mail.id)!.botIds, []);
  for (const patch of [
    { botId: 'bot_nova' },
    { sharedBotIds: ['bot_nova'] },
    { roomId: 'room_other' },
    { mailAccountId: 'missing_mail' },
  ]) {
    assert.throws(() =>
      saveServiceAccount(
        store,
        { ...fields, ...patch, expectedRevision: edited.revision },
        service.id,
      ),
    );
    assert.deepEqual(getServiceAccount(store, service.id), edited);
  }
  store.remove('mailAccounts', mail.id);
  const retained = saveServiceAccount(
    store,
    { ...fields, notes: 'Mailbox no longer exists', expectedRevision: edited.revision },
    service.id,
  );
  assert.equal(retained.mailAccountId, mail.id);
  assert.equal(store.get('mailAccounts', mail.id), undefined);
  assert.throws(() => saveServiceAccount(store, fields), /existing mail account/);
  const cleared = saveServiceAccount(
    store,
    { ...fields, mailAccountId: null, expectedRevision: retained.revision },
    service.id,
  );
  assert.equal(cleared.mailAccountId, null);
  assert.equal(cleared.revision, service.revision + 3);
  assert.equal(store.secret(`service.${service.id}.credential`), 'stale-link-secret');
});
