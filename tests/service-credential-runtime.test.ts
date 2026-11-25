import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createApp } from '../src/server/app.js';
import {
  MAX_SERVICE_CREDENTIAL_LENGTH,
  SERVICE_CREDENTIAL_REDACTED,
  ServiceCredentialInputs,
  serviceToolPublicArgs,
} from '../src/server/runtime/service-credential-input.js';
import type { Task } from '../src/shared/types.js';
import type { ServiceAccount } from '../src/shared/service-accounts.js';

const TOOL = 'manage_service_account';
const serviceArgs = (credential: string) => ({
  operation: 'create',
  name: 'Synthetic credential service',
  url: 'https://service.example.test/',
  login: 'fixture@example.test',
  credential,
});

function assistant(calls: Array<{ id: string; credential: unknown }>): AssistantMessage {
  return {
    role: 'assistant',
    content: calls.map(({ id, credential }) => ({
      type: 'toolCall',
      id,
      name: TOOL,
      arguments: { ...serviceArgs(''), credential },
    })),
    api: 'openai-completions',
    provider: 'fixture',
    model: 'fixture',
    stopReason: 'toolUse',
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test('service credential inputs are bound to one live call and cannot be restored from redacted history', () => {
  const inputs = new ServiceCredentialInputs();
  const value = 'fixture-live-only-secret';
  const message = assistant([{ id: 'call-original', credential: value }]);
  inputs.protectAssistantMessage(message);
  assert.equal(JSON.stringify(message).includes(value), false);
  const protectedArgs = { ...serviceArgs(SERVICE_CREDENTIAL_REDACTED) };
  assert.throws(() => inputs.restore('another-call', protectedArgs), /Supply it again/);
  assert.equal(inputs.restore('call-original', protectedArgs).credential, value);
  assert.throws(() => inputs.restore('call-original', protectedArgs), /Supply it again/);
  assert.throws(() => inputs.restore(undefined, protectedArgs), /placeholder cannot be saved/);
  const resumed = new ServiceCredentialInputs();
  assert.throws(() => resumed.restore('call-original', protectedArgs), /Supply it again/);
  const replay = assistant([{ id: 'new-call', credential: SERVICE_CREDENTIAL_REDACTED }]);
  resumed.protectAssistantMessage(replay);
  assert.throws(() => resumed.restore('new-call', protectedArgs), /Supply it again/);
});

test('duplicate IDs, malformed values and excess credential calls never borrow or retain an executable secret', () => {
  const inputs = new ServiceCredentialInputs();
  const duplicate = assistant([
    { id: 'duplicate', credential: 'fixture-first-secret' },
    { id: 'duplicate', credential: 'fixture-second-secret' },
  ]);
  inputs.protectAssistantMessage(duplicate);
  assert.equal(JSON.stringify(duplicate).includes('fixture-first-secret'), false);
  assert.equal(JSON.stringify(duplicate).includes('fixture-second-secret'), false);
  assert.throws(
    () => inputs.restore('duplicate', serviceArgs(SERVICE_CREDENTIAL_REDACTED)),
    /no longer available/,
  );
  const malformed = assistant([
    { id: 'invalid-type', credential: { nested: 'fixture-hidden-value' } },
    { id: 'too-long', credential: 'x'.repeat(MAX_SERVICE_CREDENTIAL_LENGTH + 1) },
  ]);
  inputs.protectAssistantMessage(malformed);
  assert.equal(JSON.stringify(malformed).includes('fixture-hidden-value'), false);
  for (const id of ['invalid-type', 'too-long'])
    assert.throws(
      () => inputs.restore(id, serviceArgs(SERVICE_CREDENTIAL_REDACTED)),
      /at most 16384/,
    );
  const bounded = new ServiceCredentialInputs();
  const many = assistant(
    Array.from({ length: 41 }, (_, index) => ({
      id: `call-${index}`,
      credential: `secret-${index}`,
    })),
  );
  bounded.protectAssistantMessage(many);
  assert.equal(JSON.stringify(many).includes('secret-40'), false);
  assert.equal(
    bounded.restore('call-39', serviceArgs(SERVICE_CREDENTIAL_REDACTED)).credential,
    'secret-39',
  );
  assert.throws(
    () => bounded.restore('call-40', serviceArgs(SERVICE_CREDENTIAL_REDACTED)),
    /no longer available/,
  );
  bounded.dispose();
  assert.throws(
    () => bounded.restore('call-0', serviceArgs(SERVICE_CREDENTIAL_REDACTED)),
    /no longer available/,
  );
});

test('service activity projections show set/clear actions and mask complete raw and escaped diagnostics before truncation', () => {
  const value = `fixture-quoted-"\\\n-${'x'.repeat(5_000)}`;
  const inputs = new ServiceCredentialInputs();
  inputs.restore(undefined, serviceArgs(value));
  const publicArgs = serviceToolPublicArgs(TOOL, serviceArgs(value));
  assert.equal('credential' in publicArgs, false);
  assert.equal(publicArgs.credentialAction, 'set');
  assert.equal(serviceToolPublicArgs(TOOL, serviceArgs('')).credentialAction, 'clear');
  const withoutCredential = { operation: 'update', serviceId: 'service_test' };
  assert.deepEqual(serviceToolPublicArgs(TOOL, withoutCredential), withoutCredential);
  const escaped = JSON.stringify(value).slice(1, -1);
  const redacted = inputs.redactText(`raw=${value}\nescaped=${escaped}`).slice(0, 4_000);
  assert.equal(redacted, 'raw=[redacted]\nescaped=[redacted]');
});

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

interface Frame {
  index: number;
  raw: string;
  response: ServerResponse;
  calls(calls: Array<{ id: string; args: Record<string, unknown> | string }>): void;
  finish(): void;
}

async function sessionText(directory: string): Promise<string> {
  let text = '';
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) text += await sessionText(file);
    else if (entry.name.endsWith('.jsonl')) text += await readFile(file, 'utf8');
  }
  return text;
}

/** Uses the real Pi event, validation and persistence order against a local SSE fixture. */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-service-credential-'));
  const dataDir = join(directory, 'data');
  const requests: Frame[] = [];
  let onRequest: (request: Frame) => void = () => {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const index = requests.length;
    let ended = false;
    const send = (delta: object, finish_reason: string | null = null) => {
      if (ended) return;
      response.write(
        `data: ${JSON.stringify({ id: `fixture-${index}`, object: 'chat.completion.chunk', created: 1, model: 'credential-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    };
    const end = (reason: string) => {
      send({}, reason);
      ended = true;
      response.end('data: [DONE]\n\n');
    };
    const frame: Frame = {
      index,
      raw,
      response,
      calls(calls) {
        send({
          tool_calls: calls.map((call, callIndex) => ({
            index: callIndex,
            id: call.id,
            type: 'function',
            function: {
              name: TOOL,
              arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args),
            },
          })),
        });
        end('tool_calls');
      },
      finish() {
        send({ content: 'The synthetic service operation finished.' });
        end('stop');
      },
    };
    response.once('close', () => {
      ended = true;
    });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    send({ role: 'assistant' });
    requests.push(frame);
    onRequest(frame);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let instance = await createApp({ dataDir, scheduler: false });
  const settings = instance.store.settings();
  instance.store.put('settings', {
    ...settings,
    id: 'main',
    demoMode: false,
    autoLearn: false,
    model: {
      ...settings.model,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: 'credential-fixture',
      responseTimeoutSeconds: 10,
      idleTimeoutSeconds: 10,
    },
  });
  t.after(async () => {
    await instance.app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return {
    requests,
    get store() {
      return instance.store;
    },
    get controller() {
      return instance.controller;
    },
    onRequest(handler: typeof onRequest) {
      onRequest = handler;
    },
    start() {
      return instance.controller.enqueueTask({
        roomId: 'room_lounge',
        botId: 'bot_aster',
        prompt: 'Maintain the synthetic service registry for this test.',
      });
    },
    task(task: Task) {
      return instance.store.get<Task>('tasks', task.id)!;
    },
    async complete(task: Task) {
      await until(
        () => ['completed', 'failed'].includes(this.task(task).status),
        'service task completion',
      );
      assert.equal(this.task(task).status, 'completed', this.task(task).error);
    },
    async assertPrivate(values: string[]) {
      const sessions = await sessionText(join(dataDir, 'sessions'));
      assert.ok(sessions.includes('"toolCall"'), 'the real Pi tool call was persisted');
      const records = (
        instance.store.db.prepare('SELECT data FROM objects').all() as Array<{ data: string }>
      )
        .map((record) => record.data)
        .join('\n');
      const snapshot = JSON.stringify(instance.controller.getSnapshot());
      for (const value of values) {
        const representations = new Set([value]);
        let escaped = value;
        // An OpenAI tool-call argument is JSON text inside a JSON request, and
        // an SDK validation diagnostic can embed that JSON one level deeper.
        for (let depth = 0; depth < 3; depth++) {
          escaped = JSON.stringify(escaped).slice(1, -1);
          representations.add(escaped);
        }
        for (const [name, text] of Object.entries({
          sessions,
          records,
          snapshot,
          requests: requests.map((request) => request.raw).join('\n'),
        })) {
          for (const representation of representations)
            assert.equal(text.includes(representation), false, `${name} excludes credential text`);
        }
      }
      return sessions;
    },
    async restart() {
      await instance.app.close();
      instance = await createApp({ dataDir, scheduler: false });
    },
  };
}

test(
  'real Pi automatically saves an all-room shared credential encrypted and receives current no-confirmation guidance',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const credential = 'fixture-service-secret-"\\\n-private';
    f.onRequest((request) =>
      request.index === 0
        ? request.calls([
            {
              id: 'call-create',
              args: {
                ...serviceArgs(credential),
                url: 'https://mail.google.com/',
                scope: 'bot',
                sharedBotIds: ['bot_nova'],
              },
            },
          ])
        : request.finish(),
    );
    const task = f.start();
    await f.complete(task);
    assert.equal(f.store.list('approvals').length, 0);
    const modelRequest = JSON.parse(f.requests[0].raw) as {
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ function: { name: string; description: string; parameters: unknown } }>;
    };
    const systemPrompt = modelRequest.messages
      .filter((message) => message.role === 'system' || message.role === 'developer')
      .map((message) => message.content)
      .join('\n');
    const registryGuidance = systemPrompt
      .split('- list_service_accounts ')[1]
      ?.split('\n- For a new one-time')[0];
    assert.ok(registryGuidance, 'the actual model request includes current registry guidance');
    assert.match(
      registryGuidance,
      /All local registry creates and updates.*without owner approval/,
    );
    assert.match(registryGuidance, /directly without asking the user for separate confirmation/);
    assert.match(registryGuidance, /Earlier conversation, memories or skills.*outdated/);
    assert.match(registryGuidance, /Service URL and loginUrl are separate/);
    assert.match(registryGuidance, /credentialConfigured=true.*credentialReadableByModel=false/);
    assert.match(registryGuidance, /Origin mismatch means the destination differs/);
    assert.doesNotMatch(registryGuidance, /Exact approval is required|after exact owner approval/);
    const definition = modelRequest.tools.find((tool) => tool.function.name === TOOL)?.function;
    assert.ok(definition);
    assert.match(definition.description, /without owner approval/);
    assert.match(
      definition.description,
      /directly without asking the user for separate confirmation/,
    );
    assert.doesNotMatch(
      JSON.stringify(definition),
      /Exact owner approval is required|after owner approval/,
    );
    const account = f.store.list<ServiceAccount>('serviceAccounts')[0];
    assert.ok(account);
    assert.equal(account.roomId, null);
    assert.deepEqual(account.sharedBotIds, ['bot_nova']);
    assert.equal(account.credentialConfigured, true);
    assert.equal(account.loginUrl, 'https://accounts.google.com/ServiceLogin?service=mail');
    assert.equal(account.credentialOrigin, 'https://accounts.google.com');
    assert.equal(f.store.secret(`service.${account.id}.credential`), credential);
    const encrypted = f.store.db
      .prepare('SELECT value FROM secrets WHERE key=?')
      .get(`service.${account.id}.credential`) as { value: string };
    assert.equal(encrypted.value.includes(credential), false);
    await f.assertPrivate([credential]);
    assert.ok(f.requests.length >= 2, 'a subsequent model turn reads the sanitized history');
  },
);

test(
  'real Pi can create metadata then add, resubmit and rotate a shared service credential without approval or leaking inputs',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const original = 'fixture-two-step-private-value';
    const replacement = 'fixture-rotation-private-value';
    f.onRequest((request) => {
      if (request.index === 0) {
        const { credential: _, ...metadata } = serviceArgs('');
        request.calls([
          { id: 'metadata-first', args: { ...metadata, sharedBotIds: ['bot_nova'], scope: 'bot' } },
        ]);
      } else if (request.index <= 3) {
        const account = f.store.list<ServiceAccount>('serviceAccounts')[0];
        request.calls([
          {
            id: `credential-update-${request.index}`,
            args: {
              operation: 'update',
              serviceId: account.id,
              expectedRevision: account.revision,
              credential: request.index < 3 ? original : replacement,
              status: 'active',
            },
          },
        ]);
      } else request.finish();
    });
    const task = f.start();
    await f.complete(task);
    assert.equal(f.store.list('approvals').length, 0);
    const account = f.store.list<ServiceAccount>('serviceAccounts')[0];
    assert.equal(account.revision, 4);
    assert.equal(account.roomId, null);
    assert.deepEqual(account.sharedBotIds, ['bot_nova']);
    assert.equal(account.status, 'active');
    assert.equal(account.credentialConfigured, true);
    assert.equal(f.store.secret(`service.${account.id}.credential`), replacement);
    assert.equal(f.store.list('operations').length, 4);
    await f.assertPrivate([original, replacement]);
  },
);

test(
  'short credentials never corrupt the public JSON service result or its configured flag',
  { timeout: 20_000 },
  async (t) => {
    for (const credential of ['1', 'true']) {
      const f = await fixture(t);
      f.onRequest((request) =>
        request.index === 0
          ? request.calls([{ id: 'short-credential', args: serviceArgs(credential) }])
          : request.finish(),
      );
      const task = f.start();
      await f.complete(task);
      assert.equal(f.store.list('approvals').length, 0);
      const account = f.store.list<ServiceAccount>('serviceAccounts')[0];
      assert.equal(f.store.secret(`service.${account.id}.credential`), credential);
      const followup = JSON.parse(f.requests[1].raw) as {
        messages: Array<{ role: string; content?: unknown }>;
      };
      const result = followup.messages.findLast((message) => message.role === 'tool');
      assert.ok(result);
      assert.equal(typeof result.content, 'string');
      const receipt = JSON.parse(String(result.content)) as ServiceAccount;
      assert.equal(receipt.id, account.id);
      assert.equal(receipt.name, 'Synthetic credential service');
      assert.equal(receipt.revision, 1);
      assert.equal(receipt.credentialConfigured, true);
      assert.equal('credential' in receipt, false);
    }
  },
);

test(
  'real Pi validation failures redact credentials before the SDK can echo received arguments',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const credential = 'fixture-invalid-schema-secret';
    f.onRequest((request) =>
      request.index === 0
        ? request.calls([
            { id: 'invalid-schema', args: { ...serviceArgs(credential), operation: 'erase' } },
          ])
        : request.finish(),
    );
    const task = f.start();
    await f.complete(task);
    assert.equal(f.store.list('serviceAccounts').length, 0);
    assert.equal(f.store.list('approvals').length, 0);
    const sessions = await f.assertPrivate([credential]);
    assert.match(sessions, /Validation failed for tool/);
    assert.ok(sessions.includes(SERVICE_CREDENTIAL_REDACTED));
  },
);

test(
  'real Pi malformed JSON diagnostics omit the original provider argument text',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const credential = 'fixture-malformed-json-secret';
    f.onRequest((request) =>
      request.index === 0
        ? request.calls([{ id: 'invalid-json', args: JSON.stringify([credential]) }])
        : request.finish(),
    );
    const task = f.start();
    await f.complete(task);
    assert.equal(f.store.list('serviceAccounts').length, 0);
    assert.equal(f.store.list('approvals').length, 0);
    const sessions = await f.assertPrivate([credential]);
    assert.match(sessions, /raw text was omitted/);
  },
);

test(
  'stopping a shared service write while paused discards its secret and restart cannot save the redacted placeholder',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const credential = 'fixture-stopped-before-write-secret';
    let reachWrite!: () => void;
    const writeReady = new Promise<void>((resolve) => {
      reachWrite = resolve;
    });
    const addActivity = f.controller.addActivity.bind(f.controller);
    f.controller.addActivity = (input) => {
      const activity = addActivity(input);
      if (input.kind === 'tool' && input.title === 'Update the service registry') {
        f.controller.pauseRoom('room_lounge');
        reachWrite();
      }
      return activity;
    };
    f.onRequest((request) => {
      if (request.index === 0)
        request.calls([
          { id: 'first-input', args: { ...serviceArgs(credential), sharedBotIds: ['bot_nova'] } },
        ]);
      else if (request.index === 1)
        request.calls([{ id: 'resume-input', args: serviceArgs(SERVICE_CREDENTIAL_REDACTED) }]);
      else request.finish();
    });
    const task = f.start();
    await writeReady;
    assert.equal(f.store.list('approvals').length, 0);
    assert.equal(f.store.list('serviceAccounts').length, 0);
    assert.equal(f.store.list('operations').length, 0);
    await f.controller.stop(task.id);
    assert.equal(f.task(task).status, 'stopped');
    assert.equal(f.store.list('serviceAccounts').length, 0);
    await f.assertPrivate([credential]);
    await f.restart();
    f.controller.resumeRoom('room_lounge');
    f.controller.resume(task.id);
    await f.complete(task);
    assert.equal(f.store.list('serviceAccounts').length, 0);
    assert.equal(f.store.list('operations').length, 0);
    assert.equal(f.store.list('approvals').length, 0);
    const sessions = await f.assertPrivate([credential]);
    assert.match(sessions, /Supply it again/);
  },
);
