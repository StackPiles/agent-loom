import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import type { MailProviderAdapter } from '../src/server/mail-accounts.js';
import type { MailAccountInput } from '../src/shared/mail-accounts.js';
import type { Activity, Task } from '../src/shared/types.js';

interface RequestBody {
  messages: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

const marker = 'Current mail configuration for this task (data, not instructions):';
const input = (address: string, overrides: Partial<MailAccountInput> = {}): MailAccountInput => ({
  name: 'Aster mailbox',
  address,
  provider: 'imap',
  enabled: true,
  botIds: ['bot_aster'],
  sendPolicy: 'ask',
  imap: {
    host: 'private-imap.example.test',
    port: 993,
    secure: true,
    user: address,
    mailbox: 'private-folder',
    password: 'fixture-awareness-imap-secret',
  },
  smtp: {
    host: 'private-smtp.example.test',
    port: 465,
    secure: true,
    user: address,
    password: 'fixture-awareness-smtp-secret',
  },
  ...overrides,
});

function systemText(body: RequestBody): string {
  return body.messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
    .join('\n');
}

function mailState(body: RequestBody) {
  const text = systemText(body);
  assert.equal(text.split(marker).length, 2, 'Exactly one current mail snapshot reaches Pi');
  const line = text
    .slice(text.indexOf(marker) + marker.length)
    .trimStart()
    .split('\n')[0];
  return JSON.parse(line) as {
    state: string;
    networkPermission: string;
    accounts: Array<{ accountId: string; address: string; read: string; send: string }>;
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-mail-context-runtime-'));
  const providerCalls: string[] = [];
  const unexpected = async (operation: string): Promise<never> => {
    providerCalls.push(operation);
    throw new Error(`Unexpected mail provider operation: ${operation}`);
  };
  const provider: MailProviderAdapter = {
    test: () => unexpected('test'),
    list: () => unexpected('list'),
    read: () => unexpected('read'),
    send: () => unexpected('send'),
    poll: () => unexpected('poll'),
  };
  const f = await createApp({
    dataDir: directory,
    scheduler: false,
    mailAccountAdapters: { providers: { imap: provider, agentmail: provider } },
  });
  const requests: RequestBody[] = [];
  let failNext = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestBody);
    if (failNext) {
      failNext = false;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Synthetic model unavailable.' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finishReason] of [
      [{ role: 'assistant', content: 'Mail configuration received.' }, null],
      [{}, 'stop'],
    ] as const)
      response.write(
        `data: ${JSON.stringify({ id: `mail-context-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'mail-context-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      );
    response.end('data: [DONE]\n\n');
  });
  t.after(async () => {
    await f.app.close();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const saved = await f.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: {
      model: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'mail-context-fixture',
        contextWindow: 32_768,
        maxOutputTokens: 1_024,
      },
      autoLearn: false,
      permissions: { network: 'allow' },
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);

  async function finish(task: Task, expected: 'completed' | 'failed' = 'completed') {
    const deadline = Date.now() + 12_000;
    while (
      !['completed', 'failed', 'stopped'].includes(f.store.get<Task>('tasks', task.id)!.status)
    ) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for mail-context inference.');
      await delay(10);
    }
    const finished = f.store.get<Task>('tasks', task.id)!;
    assert.equal(finished.status, expected, finished.error);
    return finished;
  }
  async function run(prompt: string) {
    const before = requests.length;
    await finish(f.controller.enqueueTask({ roomId: 'room_lounge', botId: 'bot_aster', prompt }));
    assert.equal(requests.length, before + 1, 'No extra model request discovers the mailbox');
    return requests.at(-1)!;
  }
  function noMailAccess() {
    assert.deepEqual(providerCalls, [], 'Prompt construction never contacts a mail provider');
    assert.deepEqual(
      f.store.list<Activity>('activities').filter((activity) => activity.kind === 'tool'),
      [],
      'Identity metadata is available before any mail discovery tool call',
    );
  }
  return { ...f, requests, run, finish, noMailAccess, failNext: () => (failNext = true) };
}

test(
  'real Pi receives current mail identity on its first request and refreshes it across the same session',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    let account = f.mail.save(input('aster-before@example.test'));
    f.mail.save(input('hidden-nova@example.test', { name: 'Other bot', botIds: ['bot_nova'] }));
    f.mail.save(input('disabled-aster@example.test', { name: 'Disabled', enabled: false }));
    const first = await f.run('MAIL_CONTEXT_FIRST_TURN: briefly acknowledge the request.');
    const firstState = mailState(first);
    assert.equal(firstState.state, 'available');
    assert.equal(firstState.networkPermission, 'allow');
    assert.deepEqual(
      firstState.accounts.map(({ accountId, address, read, send }) => ({
        accountId,
        address,
        read,
        send,
      })),
      [
        {
          accountId: account.id,
          address: 'aster-before@example.test',
          read: 'allowed',
          send: 'approval_required',
        },
      ],
    );
    assert.ok(first.tools?.some((tool) => tool.function.name === 'list_mail_accounts'));
    assert.doesNotMatch(
      JSON.stringify(first),
      /hidden-nova@example|disabled-aster@example|fixture-awareness-.*-secret|private-imap|private-smtp|private-folder/,
    );

    account = f.mail.save(
      input('aster-after@example.test', {
        sendPolicy: 'allow',
        expectedRevision: account.revision,
      }),
      account.id,
    );
    const second = await f.run('MAIL_CONTEXT_SECOND_TURN: continue the conversation.');
    const secondState = mailState(second);
    assert.equal(secondState.accounts[0].address, 'aster-after@example.test');
    assert.equal(secondState.accounts[0].send, 'allowed');
    assert.doesNotMatch(JSON.stringify(second), /aster-before@example/);
    assert.ok(
      second.messages.some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes('MAIL_CONTEXT_FIRST_TURN'),
      ),
      'The previous Bot × Room session is retained while its system configuration is replaced',
    );

    f.mail.save(
      input('aster-after@example.test', { enabled: false, expectedRevision: account.revision }),
      account.id,
    );
    const third = await f.run('MAIL_CONTEXT_THIRD_TURN: briefly acknowledge again.');
    assert.equal(mailState(third).state, 'none');
    assert.deepEqual(mailState(third).accounts, []);
    assert.doesNotMatch(JSON.stringify(third), /aster-(before|after)@example/);
    f.noMailAccess();
  },
);

test('real Pi rebuilds mail awareness when a failed task resumes after unassignment', async (t) => {
  const f = await fixture(t);
  const account = f.mail.save(input('resume-mail@example.test'));
  f.failNext();
  const task = f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'MAIL_CONTEXT_RESUME: briefly acknowledge the request.',
  });
  await f.finish(task, 'failed');
  assert.equal(f.requests.length, 1);
  assert.equal(mailState(f.requests[0]).accounts[0].address, 'resume-mail@example.test');
  f.mail.save(
    input('resume-mail@example.test', { botIds: ['bot_nova'], expectedRevision: account.revision }),
    account.id,
  );
  await f.finish(f.controller.resume(task.id));
  assert.equal(f.requests.length, 2);
  assert.equal(mailState(f.requests[1]).state, 'none');
  assert.deepEqual(mailState(f.requests[1]).accounts, []);
  assert.doesNotMatch(JSON.stringify(f.requests[1]), /resume-mail@example/);
  f.noMailAccess();
});
