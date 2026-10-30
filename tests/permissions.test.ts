import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { createTools } from '../src/server/runtime/tools.js';
import { automaticApproval, isAutomaticWebRead } from '../src/server/runtime/approval-policy.js';
import { requestText } from '../src/server/runtime/network.js';
import type { ToolContext } from '../src/server/runtime/contract.js';
import type { Approval } from '../src/shared/types.js';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-permissions-'));
  const f = await createApp({
    dataDir,
    scheduler: false,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  t.after(async () => {
    await f.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const settings = {
    ...f.store.settings(),
    demoMode: true,
    autoLearn: false,
    permissions: { shell: 'auto', fileWrite: 'auto', network: 'auto' } as const,
  };
  f.store.put('settings', { ...settings, id: 'main' });
  const task = f.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Test only',
  });
  const message = f.controller.addMessage({
    roomId: task.roomId,
    authorType: 'bot',
    authorId: task.botId,
    taskId: task.id,
    body: '',
    status: 'streaming',
  });
  const context: ToolContext = {
    host: f.controller,
    task,
    settings,
    signal: new AbortController().signal,
    operationKeys: new Set(),
  };
  return { ...f, context, message, tools: createTools(context) };
}

async function pending(f: Awaited<ReturnType<typeof fixture>>): Promise<Approval> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const approval = f.store.list<Approval>('approvals').find((a) => a.status === 'pending');
    if (approval) return approval;
    await delay(10);
  }
  throw new Error('Expected a specific manual approval request.');
}

test('smart approval creates a new document and records its reason in the same chat message', async (t) => {
  const f = await fixture(t);
  await f.tools.invoke('write_file', {
    path: 'notes/result.md',
    content: '# Result\nVerified text.',
  });
  assert.equal(
    await readFile(join(f.context.settings.workspacePath, 'notes/result.md'), 'utf8'),
    '# Result\nVerified text.',
  );
  assert.equal(f.store.list('approvals').length, 0);
  const decision = f.controller
    .getSnapshot()
    .activities.find((a) => a.approvalRule === 'new_workspace_document');
  assert.equal(decision?.messageId, f.message.id);
  assert.match(decision?.detail ?? '', /Existing files cannot be overwritten/);
});

test('smart approval asks before overwrites and new executable code while denial preserves the file', async (t) => {
  const f = await fixture(t);
  const filename = join(f.context.settings.workspacePath, 'existing.md');
  await writeFile(filename, 'Keep this user edit.');
  const overwrite = f.tools.invoke('write_file', { path: 'existing.md', content: 'Replacement' });
  const denied = assert.rejects(overwrite, /denied or cancelled/);
  const approval = await pending(f);
  assert.equal(approval.args.content, 'Replacement');
  f.controller.decideApproval(approval.id, false);
  await denied;
  assert.equal(await readFile(filename, 'utf8'), 'Keep this user edit.');

  const code = f.tools.invoke('write_file', {
    path: 'script.js',
    content: 'console.log("reviewed")',
  });
  const codeApproval = await pending(f);
  assert.equal(codeApproval.args.path, 'script.js');
  f.controller.decideApproval(codeApproval.id, true);
  await code;
  assert.equal(
    await readFile(join(f.context.settings.workspacePath, 'script.js'), 'utf8'),
    'console.log("reviewed")',
  );
});

test('a file appearing after automatic approval is never overwritten', async (t) => {
  const f = await fixture(t);
  const filename = join(f.context.settings.workspacePath, 'race.md');
  const addActivity = f.controller.addActivity.bind(f.controller);
  f.controller.addActivity = (input) => {
    if (input.approvalRule === 'new_workspace_document')
      writeFileSync(filename, 'Concurrent user content.');
    return addActivity(input);
  };
  await assert.rejects(
    f.tools.invoke('write_file', { path: 'race.md', content: 'Agent content.' }),
    /EEXIST|already exists/i,
  );
  assert.equal(await readFile(filename, 'utf8'), 'Concurrent user content.');
});

test('switching to Deny during an automatic assessment prevents the operation', async (t) => {
  const f = await fixture(t);
  const secrets = f.controller.getSecrets.bind(f.controller);
  f.controller.getSecrets = () => {
    const settings = f.store.settings();
    f.store.put('settings', {
      ...settings,
      id: 'main',
      permissions: { ...settings.permissions, fileWrite: 'deny' },
    });
    return secrets();
  };
  await assert.rejects(
    f.tools.invoke('write_file', { path: 'revoked.md', content: 'Must not be written.' }),
    /disabled/,
  );
  await assert.rejects(readFile(join(f.context.settings.workspacePath, 'revoked.md')), /ENOENT/);
  assert.equal(
    f.controller.getSnapshot().activities.some((a) => a.approvalRule),
    false,
  );
});

test('automatic workspace inspections never turn shell syntax into a blanket grant', async (t) => {
  const f = await fixture(t);
  assert.match(await f.tools.invoke('run_command', { command: 'pwd' }), /no shell execution/);
  assert.match(
    await f.tools.invoke('run_command', { command: 'node --version' }),
    new RegExp(process.version.replaceAll('.', '\\.')),
  );
  assert.equal(f.store.list('approvals').length, 0);
  const unsafe = f.tools.invoke('run_command', { command: 'pwd; node -e "process.exit(9)"' });
  const denied = assert.rejects(unsafe, /denied or cancelled/);
  const approval = await pending(f);
  assert.equal(approval.args.command, 'pwd; node -e "process.exit(9)"');
  f.controller.decideApproval(approval.id, false);
  await denied;
  const settings = f.store.settings();
  f.store.put('settings', {
    ...settings,
    id: 'main',
    permissions: { ...settings.permissions, shell: 'deny' },
  });
  await assert.rejects(f.tools.invoke('run_command', { command: 'ls' }), /disabled/);
});

test('smart rules keep credential-bearing reads, hidden files, large documents and scripts for review', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await automaticApproval(f.context, 'web_fetch', { url: 'https://example.com/document' }))
      ?.rule,
    'public_web_read',
  );
  assert.equal(
    await automaticApproval(f.context, 'web_fetch', {
      url: 'https://example.com/?access_token=private',
    }),
    undefined,
  );
  assert.equal(
    await automaticApproval(f.context, 'web_fetch', { url: 'http://127.0.0.1/admin' }),
    undefined,
  );
  assert.equal(
    await automaticApproval(f.context, 'write_file', { path: '.hidden.txt', content: 'x' }),
    undefined,
  );
  assert.equal(
    await automaticApproval(f.context, 'write_file', { path: 'script.sh', content: 'echo x' }),
    undefined,
  );
  assert.equal(
    await automaticApproval(f.context, 'write_file', {
      path: 'large.md',
      content: 'x'.repeat(65_537),
    }),
    undefined,
  );
  await assert.rejects(
    automaticApproval(f.context, 'write_file', { path: '../outside.md', content: 'x' }),
    /outside/,
  );
  f.store.setSecret('model.apiKey', 'synthetic-private-model-key');
  assert.equal(
    await automaticApproval(f.context, 'web_fetch', {
      url: 'https://example.com/?q=synthetic-private-model-key',
    }),
    undefined,
  );
  assert.equal(
    await automaticApproval(f.context, 'write_file', {
      path: 'key.md',
      content: 'synthetic-private-model-key',
    }),
    undefined,
  );
  const escapedKey = 'synthetic-"key"\\path/+ value';
  f.store.setSecret('model.apiKey', escapedKey);
  assert.equal(
    await automaticApproval(f.context, 'write_file', {
      path: 'escaped-key.md',
      content: `Credential: ${escapedKey}`,
    }),
    undefined,
    'JSON quoting must not conceal a literal credential from the policy',
  );
  const encodedUrl = new URL('https://example.com/');
  encodedUrl.searchParams.set('q', escapedKey);
  assert.equal(
    await automaticApproval(f.context, 'web_fetch', { url: encodedUrl.href }),
    undefined,
    'URL encoding must not conceal a known credential',
  );
  assert.equal(
    isAutomaticWebRead(`https://example.com/${encodeURIComponent(escapedKey)}`, [escapedKey]),
    false,
  );
  f.context.settings.search.provider = 'searxng';
  assert.equal(
    (await automaticApproval(f.context, 'web_search', { query: 'public documentation' }))?.rule,
    'configured_web_search',
  );
});

test('redirect policy runs before a credential-bearing destination is contacted', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(302, { Location: 'https://redirect.invalid/?access_token=synthetic-only' });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let checked = 0;
  await assert.rejects(
    requestText(`http://127.0.0.1:${address.port}/`, {
      allowPrivate: true, // The initial local server is a transport fixture only.
      timeoutMs: 2_000,
      validateRedirect(url) {
        checked++;
        if (!isAutomaticWebRead(url.href)) throw new Error('Manual network review is required.');
      },
    }),
    /Manual network review is required/,
  );
  assert.equal(checked, 1);
});
