import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImapFlowOptions } from 'imapflow';
import { createApp } from '../src/server/app.js';
import type { MailConnectionClient } from '../src/server/mail.js';
import type { Runtime } from '../src/server/runtime/contract.js';
import type { Automation } from '../src/shared/types.js';
import {
  GMAIL_CONNECTION,
  normalizeMailPassword,
  sameMailAccount,
} from '../src/shared/mail-settings.js';

const gmail = { ...GMAIL_CONNECTION, user: 'owner@example.test' };
const password = 'abcd efgh ijkl mnop';

class MailFixture implements MailConnectionClient {
  calls: string[] = [];
  onConnect?: () => Promise<void>;
  onOpen?: () => Promise<void>;
  async connect() {
    this.calls.push('connect');
    await this.onConnect?.();
  }
  async mailboxOpen(path: string, options: { readOnly: true }) {
    this.calls.push(`open:${path}:${options.readOnly}`);
    await this.onOpen?.();
    return { uidValidity: 3n, uidNext: 42 };
  }
  async logout() {
    this.calls.push('logout');
  }
  close() {
    this.calls.push('close');
  }
  on() {
    return this;
  }
}

async function fixture(
  t: TestContext,
  configure?: (client: MailFixture) => void,
  timeoutMs?: number,
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'loom-mail-'));
  const clients: MailFixture[] = [];
  const configurations: ImapFlowOptions[] = [];
  const runtimeFactory = (): Runtime => ({
    start() {},
    async stop() {},
    async shutdown() {},
    queueState() {
      return { active: 0, waiting: 0 };
    },
  });
  try {
    const instance = await createApp({
      dataDir,
      scheduler: false,
      runtimeFactory,
      mailAdapters: {
        timeoutMs,
        createClient(options) {
          configurations.push(options);
          const client = new MailFixture();
          configure?.(client);
          clients.push(client);
          return client;
        },
      },
    });
    await instance.app.ready();
    t.after(async () => {
      await instance.app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    return { ...instance, clients, configurations };
  } catch (error) {
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}

function savedAutomation(f: Awaited<ReturnType<typeof fixture>>) {
  const rule: Automation = {
    id: 'mail_rule',
    name: 'Inbox',
    kind: 'imap',
    enabled: false,
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Report important new subjects.',
    intervalMinutes: 5,
    sourceUrl: '',
    imap: { ...gmail, passwordConfigured: true },
    createdAt: '2026-11-01T00:00:00.000Z',
  };
  f.store.put('automations', rule);
  f.store.setSecret(`imap.${rule.id}.password`, 'saved-synthetic-password');
  return rule;
}

test('mail test opens the mailbox read-only without reading mail, saving credentials or scheduling work', async (t) => {
  const f = await fixture(t);
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/mail/test',
    payload: { imap: { ...gmail, password } },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    ok: true,
    host: gmail.host,
    user: gmail.user,
    mailbox: 'INBOX',
  });
  assert.deepEqual(f.clients[0].calls, ['connect', 'open:INBOX:true', 'logout']);
  assert.equal(f.configurations[0].auth?.pass, 'abcdefghijklmnop');
  assert.equal(f.configurations[0].secure, true);
  assert.equal(f.configurations[0].logger, false);
  assert.equal(f.configurations[0].logRaw, false);
  assert.deepEqual(f.store.list('automations'), []);
  assert.deepEqual(f.store.list('automationState'), []);
  assert.deepEqual(f.store.list('tasks'), []);
  assert.deepEqual(f.store.list('notifications'), []);
  assert.equal(response.body.includes('abcdefghijklmnop'), false);
});

test('mail credential reuse is bound to the original account and endpoint while mailbox-only changes remain testable', async (t) => {
  const f = await fixture(t);
  const rule = savedAutomation(f);
  f.store.put('automationState', { id: rule.id, lastUid: 9, uidValidity: '7' });
  const same = await f.app.inject({
    method: 'POST',
    url: '/api/mail/test',
    payload: {
      automationId: rule.id,
      imap: { ...gmail, host: 'IMAP.GMAIL.COM', mailbox: 'Archive' },
    },
  });
  assert.equal(same.statusCode, 200, same.body);
  assert.equal(f.configurations[0].auth?.pass, 'saved-synthetic-password');
  assert.deepEqual(f.store.get('automations', rule.id), rule);
  assert.deepEqual(f.store.get('automationState', rule.id), {
    id: rule.id,
    lastUid: 9,
    uidValidity: '7',
  });
  for (const patch of [
    { host: 'another.example.test' },
    { user: 'other@example.test' },
    { port: 143 },
    { secure: false },
  ]) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/mail/test',
      payload: { automationId: rule.id, imap: { ...gmail, ...patch } },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'credentials_required');
  }
  assert.equal(f.clients.length, 1);
  const replacement = await f.app.inject({
    method: 'POST',
    url: '/api/mail/test',
    payload: {
      automationId: rule.id,
      imap: { ...gmail, host: 'another.example.test', password: 'explicit-new-password' },
    },
  });
  assert.equal(replacement.statusCode, 200);
  assert.equal(f.configurations[1].auth?.pass, 'explicit-new-password');
  assert.equal(f.store.secret(`imap.${rule.id}.password`), 'saved-synthetic-password');
});

test('explicit empty password never falls back to a saved secret and invalid inputs create no transport', async (t) => {
  const f = await fixture(t);
  const rule = savedAutomation(f);
  for (const payload of [
    { automationId: rule.id, imap: { ...gmail, password: '' } },
    { automationId: rule.id, imap: { ...gmail, password: '    ' } },
  ]) {
    const response = await f.app.inject({ method: 'POST', url: '/api/mail/test', payload });
    assert.equal(response.json().code, 'credentials_required');
  }
  for (const imap of [
    { ...gmail, host: 'https://imap.gmail.com' },
    { ...gmail, port: 0 },
    { ...gmail, mailbox: '' },
    { ...gmail, user: '' },
    { ...gmail, accessToken: 'not-an-accepted-field' },
  ]) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/mail/test',
      payload: { imap },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'invalid_configuration');
  }
  assert.equal(f.clients.length, 0);
});

test('mail test honors network denial; an explicit user check is allowed by Ask without starting unattended polling', async (t) => {
  const f = await fixture(t);
  const settings = f.store.settings();
  f.store.put('settings', {
    ...settings,
    id: 'main',
    permissions: { ...settings.permissions, network: 'deny' },
  });
  const denied = await f.app.inject({
    method: 'POST',
    url: '/api/mail/test',
    payload: { imap: { ...gmail, password } },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, 'network_denied');
  assert.equal(f.clients.length, 0);
  f.store.put('settings', {
    ...settings,
    id: 'main',
    permissions: { ...settings.permissions, network: 'ask' },
  });
  const allowed = await f.app.inject({
    method: 'POST',
    url: '/api/mail/test',
    payload: { imap: { ...gmail, password } },
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(f.store.settings().permissions.network, 'ask');
  assert.deepEqual(f.store.list('approvals'), []);
  assert.deepEqual(f.store.list('tasks'), []);
});

test('provider failures have useful categories without exposing authentication secrets or server diagnostics', async (t) => {
  const f = await fixture(t, (client) => {
    client.onConnect = async () => {
      throw Object.assign(new Error('SECRET provider response abcdefghijklmnop'), {
        authenticationFailed: true,
      });
    };
  });
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/mail/test',
    payload: { imap: { ...gmail, password } },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'authentication_failed');
  assert.equal(response.body.includes('SECRET'), false);
  assert.equal(response.body.includes('abcdefghijklmnop'), false);
  assert.deepEqual(f.clients[0].calls, ['connect', 'close']);
});

test('invalid mailbox failure logs out cleanly without treating authentication as successful setup', async (t) => {
  const f = await fixture(t, (client) => {
    client.onOpen = async () => {
      throw new Error('Untrusted mailbox diagnostic');
    };
  });
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/mail/test',
    payload: { imap: { ...gmail, password } },
  });
  assert.equal(response.json().code, 'mailbox_unavailable');
  assert.equal(response.body.includes('Untrusted'), false);
  assert.deepEqual(f.clients[0].calls, ['connect', 'open:INBOX:true', 'logout']);
});

test('connection timeout closes a stalled transport and releases admission for another test', async (t) => {
  const f = await fixture(
    t,
    (client) => {
      client.onConnect = () => new Promise(() => {});
    },
    20,
  );
  for (let count = 0; count < 2; count++) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/mail/test',
      payload: { imap: { ...gmail, password } },
    });
    assert.equal(response.json().code, 'timeout');
    assert.ok(f.clients[count].calls.includes('close'));
  }
});

test('concurrent connection tests do not open a second client or save test state', async (t) => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, (client) => {
    client.onConnect = () => {
      started();
      return waiting;
    };
  });
  const first = f.app
    .inject({ method: 'POST', url: '/api/mail/test', payload: { imap: { ...gmail, password } } })
    .then((response) => response);
  await entered;
  const second = await f.app.inject({
    method: 'POST',
    url: '/api/mail/test',
    payload: { imap: { ...gmail, password } },
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, 'busy');
  assert.equal(f.clients.length, 1);
  release();
  assert.equal((await first).statusCode, 200);
});

test('network revocation during connection prevents opening a mailbox', async (t) => {
  // The seam changes policy at the instant the transport reports a successful connection.
  let revoke = () => {};
  const f = await fixture(t, (client) => {
    client.onConnect = async () => revoke();
  });
  const settings = f.store.settings();
  revoke = () =>
    f.store.put('settings', {
      ...settings,
      id: 'main',
      permissions: { ...settings.permissions, network: 'deny' },
    });
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/mail/test',
    payload: { imap: { ...gmail, password } },
  });
  assert.equal(response.json().code, 'network_denied');
  assert.equal(
    f.clients[0].calls.some((call) => call.startsWith('open:')),
    false,
  );
});

test('app password spacing is Gmail-specific and a non-TLS IMAP setting requires STARTTLS', async (t) => {
  assert.equal(normalizeMailPassword(gmail, password), 'abcdefghijklmnop');
  assert.equal(normalizeMailPassword({ ...gmail, host: 'mail.example.test' }, password), password);
  assert.equal(sameMailAccount(gmail, { ...gmail, mailbox: 'Other' }), true);
  const f = await fixture(t);
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/mail/test',
    payload: { imap: { ...gmail, host: 'mail.example.test', secure: false, port: 143, password } },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(f.configurations[0].auth?.pass, password);
  assert.equal(f.configurations[0].doSTARTTLS, true);
});
