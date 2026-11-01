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
