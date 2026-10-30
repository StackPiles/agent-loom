import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { Snapshot, Task, Approval, Skill, Memory, Notification } from '../src/shared/types.js';
import type {
  NewTask,
  OperationRecord,
  Runtime,
  RuntimeHost,
} from '../src/server/runtime/contract.js';
import { createRuntime } from '../src/server/runtime/index.js';
import { InferenceGate } from '../src/server/runtime/gate.js';
import { createTools, operationKey } from '../src/server/runtime/tools.js';
import { isPublicAddress, requestText } from '../src/server/runtime/network.js';
import { readWorkspaceFile } from '../src/server/runtime/workspace.js';

function fixture(dataDir: string) {
  let counter = 0;
  const id = () => `test_${++counter}`;
  const now = () => new Date().toISOString();
  const snapshot: Snapshot = {
    version: 'test',
    settings: {
      model: {
        baseUrl: '',
        modelId: 'fixture-model',
        apiKeyConfigured: false,
        contextWindow: 32_768,
        maxOutputTokens: 1_024,
        temperature: 0,
      },
      demoMode: false,
      autoLearn: false,
      maxHandoffs: 2,
      workspacePath: path.join(dataDir, 'workspace'),
      permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
      search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
    },
    bots: ['aster', 'nova'].map((handle) => ({
      id: handle,
      name: handle,
      handle,
      role: 'test',
      systemPrompt: 'Use tools when requested.',
      color: '#789',
      avatar: 'sparkles',
      enabled: true,
      createdAt: now(),
    })),
    rooms: [
      {
        id: 'room',
        name: 'Test room',
        description: '',
        botIds: ['aster', 'nova'],
        pinned: false,
        archived: false,
        createdAt: now(),
        updatedAt: now(),
      },
    ],
    tasks: [],
    messages: [],
    activities: [],
    approvals: [],
    skills: [],
    memories: [],
    notifications: [],
    automations: [],
    queue: { active: 0, waiting: 0 },
  };
  const operations = new Map<string, OperationRecord>();
  const approvalResolvers = new Map<string, (approved: boolean) => void>();
  let runtime: Runtime | undefined;
  const host: RuntimeHost = {
    dataDir,
    getSnapshot: () => snapshot,
    getSecrets: () => ({}),
    changed: () => {},
    updateTask: (key, patch) => {
      Object.assign(
        snapshot.tasks.find((task) => task.id === key)!,
        patch,
      );
    },
    addMessage: (input) => {
      const message = { ...input, id: id(), createdAt: now() };
      snapshot.messages.push(message);
      return message;
    },
    appendMessage: (key, delta) => {
      snapshot.messages.find((message) => message.id === key)!.body += delta;
    },
    updateMessage: (key, patch) => {
      Object.assign(
        snapshot.messages.find((message) => message.id === key)!,
        patch,
      );
    },
    addActivity: (input) => {
      const activity = { ...input, id: id(), createdAt: now() };
      snapshot.activities.push(activity);
      return activity;
    },
    updateActivity: (key, patch) => {
      Object.assign(
        snapshot.activities.find((activity) => activity.id === key)!,
        patch,
      );
    },
    requestApproval: (input, signal) =>
      new Promise((resolve) => {
        const approval: Approval = { ...input, id: id(), status: 'pending', createdAt: now() };
        snapshot.approvals.push(approval);
        const decide = (approved: boolean) => {
          approval.status = signal.aborted ? 'cancelled' : approved ? 'approved' : 'denied';
          signal.removeEventListener('abort', abort);
          resolve(approved);
        };
        const abort = () => decide(false);
        signal.addEventListener('abort', abort, { once: true });
        approvalResolvers.set(approval.id, decide);
      }),
    enqueueTask: (input: NewTask) => {
      const key = id();
      const task: Task = {
        id: key,
        ...input,
        status: 'queued',
        kind: input.kind ?? 'chat',
        rootTaskId: input.rootTaskId ?? key,
        depth: input.depth ?? 0,
        output: '',
        createdAt: now(),
        updatedAt: now(),
        inputTokens: 0,
        outputTokens: 0,
      };
      snapshot.tasks.push(task);
      runtime?.start(task);
      return task;
    },
    proposeSkill: (input) => {
      const skill: Skill = {
        ...input,
        id: id(),
        status: 'candidate',
        version: 1,
        revisions: [],
        useCount: 0,
        createdAt: now(),
        updatedAt: now(),
      };
      snapshot.skills.push(skill);
      return skill;
    },
    saveMemory: (input) => {
      const memory: Memory = { ...input, id: id(), createdAt: now(), updatedAt: now() };
      snapshot.memories.push(memory);
      return memory;
    },
    notify: (input) => {
      const notification: Notification = { ...input, id: id(), read: false, createdAt: now() };
      snapshot.notifications.push(notification);
      return notification;
    },
    useSkill: (key) => {
      snapshot.skills.find((skill) => skill.id === key)!.useCount++;
    },
    getOperation: (key) => operations.get(key),
    saveOperation: (operation) => {
      operations.set(operation.key, operation);
    },
  };
  return {
    host,
    snapshot,
    approvalResolvers,
    operations,
    attach(value: Runtime) {
      runtime = value;
    },
  };
}

async function until(
  predicate: () => boolean,
  description: string,
  timeout = 15_000,
): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${description}`);
    await delay(20);
  }
}

test('inference gate is FIFO, skips cancelled waiters, and releases idempotently', async () => {
  const gate = new InferenceGate();
  const first = await gate.acquire();
  const cancelled = new AbortController();
  const rejected = gate.acquire(cancelled.signal);
  const second = gate.acquire();
  const assertion = assert.rejects(rejected, { name: 'AbortError' });
  cancelled.abort();
  await assertion;
  assert.deepEqual(gate.state, { active: 1, waiting: 1 });
  first();
  first();
  const release = await second;
  assert.deepEqual(gate.state, { active: 1, waiting: 0 });
  release();
  assert.deepEqual(gate.state, { active: 0, waiting: 0 });
});

test('file permissions, symlink boundary, operation replay, handoff budget and SSRF guard', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'loom-tools-'));
  try {
    const { host, snapshot, approvalResolvers, operations } = fixture(dataDir);
    const task = host.enqueueTask({ roomId: 'room', botId: 'aster', prompt: 'Write a note.' });
    const tools = createTools({
      host,
      task,
      settings: snapshot.settings,
      signal: new AbortController().signal,
      operationKeys: new Set(),
    });
    const writing = tools.invoke('write_file', { path: 'note.txt', content: 'approved content' });
    await until(() => snapshot.approvals.length === 1, 'approval requested');
    assert.equal(snapshot.approvals[0].args.content, 'approved content');
    assert.match(snapshot.approvals[0].target, /note\.txt$/);
    approvalResolvers.get(snapshot.approvals[0].id)!(true);
    await writing;
    assert.equal(
      await readFile(path.join(snapshot.settings.workspacePath, 'note.txt'), 'utf8'),
      'approved content',
    );
    await writeFile(path.join(snapshot.settings.workspacePath, 'note.txt'), 'user edit');
    assert.match(
      await tools.invoke('write_file', { path: 'note.txt', content: 'approved content' }),
      /not repeated/,
    );
    assert.equal(snapshot.approvals.length, 1);
    assert.equal(
      await readFile(path.join(snapshot.settings.workspacePath, 'note.txt'), 'utf8'),
      'user edit',
    );
    const uncertainArgs = { path: 'uncertain.txt', content: 'Do not repeat.' };
    const uncertainKey = operationKey(task.id, 'write_file', uncertainArgs);
    operations.set(uncertainKey, {
      key: uncertainKey,
      taskId: task.id,
      toolName: 'write_file',
      args: uncertainArgs,
      status: 'started',
      updatedAt: new Date().toISOString(),
    });
    await assert.rejects(tools.invoke('write_file', uncertainArgs), /uncertain/);
    assert.equal(
      snapshot.approvals.length,
      1,
      'an uncertain action is refused before requesting redundant approval',
    );
    const outside = path.join(dataDir, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'private.txt'), 'private');
    await symlink(
      outside,
      path.join(snapshot.settings.workspacePath, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      readWorkspaceFile(snapshot.settings.workspacePath, 'escape/private.txt'),
      /symlink outside/,
    );
    await assert.rejects(
      readWorkspaceFile(snapshot.settings.workspacePath, '../outside/private.txt'),
      /outside/,
    );
    await writeFile(path.join(snapshot.settings.workspacePath, '.env'), 'A_PRIVATE_KEY=example');
    try {
      await symlink('.env', path.join(snapshot.settings.workspacePath, 'innocent.txt'));
      await assert.rejects(
        readWorkspaceFile(snapshot.settings.workspacePath, 'innocent.txt'),
        /Credential/,
      );
    } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM')
        throw error;
    }
    await tools.invoke('send_message', { handle: 'nova', message: 'Review one.' });
    await tools.invoke('send_message', { handle: 'nova', message: 'Review two.' });
    await assert.rejects(
      tools.invoke('send_message', { handle: 'nova', message: 'Review three.' }),
      /budget/,
    );
    assert.equal(snapshot.tasks.length, 3);
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      '::ffff:127.0.0.1',
      'fe80::1',
      '2002:7f00:1::',
    ])
      assert.equal(isPublicAddress(address), false, address);
    assert.equal(isPublicAddress('8.8.8.8'), true);
    await assert.rejects(requestText('http://127.0.0.1:1/'), /private/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('learning review tools cannot perform actions or activate their own skill candidates', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'loom-learning-'));
  try {
    const { host, snapshot } = fixture(dataDir);
    const source = host.enqueueTask({
      roomId: 'room',
      botId: 'aster',
      prompt: 'An observed workflow.',
    });
    const task = host.enqueueTask({
      roomId: 'room',
      botId: 'aster',
      prompt: 'Review the evidence.',
      kind: 'learning',
      parentTaskId: source.id,
    });
    const tools = createTools({
      host,
      task,
      settings: snapshot.settings,
      signal: new AbortController().signal,
      operationKeys: new Set(),
    });
    await assert.rejects(tools.invoke('run_command', { command: 'echo blocked' }), /not available/);
    await assert.rejects(
      tools.invoke('send_message', { handle: 'nova', message: 'Do this.' }),
      /not available/,
    );
    await tools.invoke('propose_skill', {
      name: 'Evidence checklist',
      description: 'A reviewable procedure.',
      content: '1. Check the actual tool result. 2. Report its limitations.',
      evidence: `The completed source task is ${source.id}; no independent quality claim.`,
    });
    assert.equal(snapshot.skills.length, 1);
    assert.equal(snapshot.skills[0].status, 'candidate');
    assert.equal(snapshot.skills[0].sourceTaskId, source.id);
    await assert.rejects(
      tools.invoke('read_skill', { id: snapshot.skills[0].id }),
      /No active skill/,
    );
    await assert.rejects(
      tools.invoke('propose_skill', {
        name: 'Second change',
        description: 'Must be refused.',
        content: 'Different proposed content.',
        evidence: 'None.',
      }),
      /at most one/,
    );
    await tools.invoke('save_memory', { content: 'The user wants evidence-linked summaries.' });
    assert.equal(snapshot.memories[0].sourceTaskId, source.id);
    await assert.rejects(
      tools.invoke('save_memory', { content: 'A second background memory.' }),
      /at most one/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test(
  'real Pi SDK streams through a serial local endpoint, frees inference during approvals, persists sessions and stops work',
  { timeout: 30_000 },
  async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'loom-sdk-'));
    const context = fixture(dataDir);
    let active = 0;
    let maximumActive = 0;
    let sawTools = false;
    let sawPriorConversation = false;
    let allowRecovery = false;
    let recoveryPaused = false;
    let failNextRequest = true;
    let forceLength = false;
    const authorizationHeaders: Array<string | undefined> = [];
    const requests: string[] = [];
    const send = (response: ServerResponse, chunk: unknown) =>
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      const payload = JSON.parse(raw) as {
        model: string;
        messages: Array<{ role: string; content?: string }>;
        tools?: Array<{ function: { name: string } }>;
      };
      requests.push(raw);
      authorizationHeaders.push(request.headers.authorization);
      active++;
      maximumActive = Math.max(maximumActive, active);
      let closed = false;
      const finish = () => {
        if (!closed) {
          closed = true;
          active--;
        }
      };
      response.on('close', finish);
      const names = payload.tools?.map((tool) => tool.function.name) ?? [];
      sawTools ||=
        names.includes('write_file') && !names.includes('bash') && !names.includes('edit');
      const lastUser = JSON.stringify(
        [...payload.messages].reverse().find((message) => message.role === 'user')?.content ?? '',
      );
      const last = payload.messages.at(-1);
      if (lastUser.includes('FAIL_HTTP') && failNextRequest) {
        failNextRequest = false;
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { message: 'Fixture inference server unavailable.' } }),
        );
        finish();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (lastUser.includes('WAIT_FOR_STOP')) {
        await delay(3_000);
        if (closed) return;
      } else if (lastUser.includes('RECOVERY_WRITE') && last?.role === 'tool' && !allowRecovery) {
        recoveryPaused = true;
        await delay(3_000);
        if (closed) return;
      } else await delay(60);
      const base = {
        id: `fixture-${requests.length}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'fixture-model',
      };
      if (
        (lastUser.includes('FIRST_WRITE') ||
          lastUser.includes('RECOVERY_WRITE') ||
          lastUser.includes('LEARNING_TOGGLE')) &&
        last?.role !== 'tool' &&
        names.includes('write_file')
      ) {
        const toolCalls = [
          {
            index: 0,
            id: `call_write_${requests.length}`,
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({
                path: lastUser.includes('RECOVERY_WRITE')
                  ? 'recovery.txt'
                  : lastUser.includes('LEARNING_TOGGLE')
                    ? 'learning-toggle.txt'
                    : 'sdk-note.txt',
                content: 'Written by the real Pi tool loop.',
              }),
            },
          },
        ];
        if (lastUser.includes('LEARNING_TOGGLE'))
          toolCalls.unshift({
            index: 1,
            id: `call_context_${requests.length}`,
            type: 'function',
            function: { name: 'room_context', arguments: JSON.stringify({ limit: 5 }) },
          });
        send(response, {
          ...base,
          choices: [
            { index: 0, delta: { role: 'assistant', tool_calls: toolCalls }, finish_reason: null },
          ],
        });
        send(response, {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        });
      } else {
        if (lastUser.includes('SECOND_TURN'))
          sawPriorConversation = payload.messages.some(
            (message) =>
              message.role === 'user' && JSON.stringify(message.content).includes('FIRST_WRITE'),
          );
        send(response, {
          ...base,
          choices: [
            { index: 0, delta: { role: 'assistant', content: 'Verified ' }, finish_reason: null },
          ],
        });
        await delay(30);
        send(response, {
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                content: lastUser.includes('LEARNING_TOGGLE')
                  ? 'fixture response. The room context was read and the approved note was saved. This completed answer is deliberately substantive enough to meet the background review threshold, so the current preference must control whether a review is queued.'
                  : 'fixture response.',
              },
              finish_reason: null,
            },
          ],
        });
        send(response, {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: forceLength ? 'length' : 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 10, total_tokens: 130 },
        });
      }
      response.end('data: [DONE]\n\n');
      finish();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    context.snapshot.settings.model.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const runtime = createRuntime(context.host);
    context.attach(runtime);
    try {
      const first = context.host.enqueueTask({
        roomId: 'room',
        botId: 'aster',
        prompt: 'FIRST_WRITE: create the note with write_file.',
      });
      await until(
        () => ['awaiting_approval', 'failed', 'completed'].includes(first.status),
        'first task waiting for approval',
      );
      assert.equal(first.status, 'awaiting_approval', first.error || first.output);
      assert.equal(runtime.queueState().active, 0, 'approval does not hold the inference slot');
      const second = context.host.enqueueTask({
        roomId: 'room',
        botId: 'nova',
        prompt: 'Give a short answer.',
      });
      await until(
        () => second.status === 'completed' || second.status === 'failed',
        'second bot completes during approval',
      );
      assert.equal(second.status, 'completed', second.error);
      assert.equal(first.status, 'awaiting_approval');
      context.approvalResolvers.get(context.snapshot.approvals[0].id)!(true);
      await until(
        () => first.status === 'completed' || first.status === 'failed',
        'first task completes',
      );
      assert.equal(first.status, 'completed', first.error);
      assert.equal(
        await readFile(path.join(context.snapshot.settings.workspacePath, 'sdk-note.txt'), 'utf8'),
        'Written by the real Pi tool loop.',
      );
      assert.ok(sawTools, 'custom tools supplied; privileged Pi defaults absent');
      assert.ok(
        authorizationHeaders.every((header) => header === undefined),
        'keyless local model receives no placeholder bearer token',
      );
      assert.match(first.output, /Verified fixture response/);
      assert.equal(first.inputTokens, 220, 'provider-reported input usage recorded exactly once');
      assert.equal(first.outputTokens, 30, 'provider-reported output usage recorded exactly once');
      const followup = context.host.enqueueTask({
        roomId: 'room',
        botId: 'aster',
        prompt: 'SECOND_TURN: answer briefly.',
      });
      await until(
        () => followup.status === 'completed' || followup.status === 'failed',
        'persisted followup completes',
      );
      assert.equal(followup.status, 'completed', followup.error);
      assert.ok(sawPriorConversation, 'Bot × Room Pi history was restored');

      context.snapshot.settings.autoLearn = true;
      const learningToggle = context.host.enqueueTask({
        roomId: 'room',
        botId: 'aster',
        prompt: 'LEARNING_TOGGLE: read the room and write a note, then summarize both.',
      });
      await until(
        () => learningToggle.status === 'awaiting_approval' || learningToggle.status === 'failed',
        'learning-toggle task awaits approval',
      );
      assert.equal(learningToggle.status, 'awaiting_approval', learningToggle.error);
      context.snapshot.settings.autoLearn = false;
      context.approvalResolvers.get(context.snapshot.approvals.at(-1)!.id)!(true);
      await until(
        () => ['completed', 'failed'].includes(learningToggle.status),
        'task finishes after automatic learning is disabled',
      );
      assert.equal(learningToggle.status, 'completed', learningToggle.error);
      assert.ok(
        learningToggle.output.length > 120,
        'the answer meets the learning length threshold',
      );
      assert.equal(
        context.snapshot.activities.filter(
          (activity) =>
            activity.taskId === learningToggle.id &&
            activity.kind === 'tool' &&
            activity.status === 'success',
        ).length,
        2,
        'two successful tools satisfy the learning tool threshold',
      );
      assert.equal(
        context.snapshot.tasks.filter(
          (task) => task.kind === 'learning' && task.parentTaskId === learningToggle.id,
        ).length,
        0,
        'disabling automatic learning during a running task prevents a new review',
      );

      const concurrentA = context.host.enqueueTask({
        roomId: 'room',
        botId: 'aster',
        prompt: 'CONCURRENT_A',
      });
      const concurrentB = context.host.enqueueTask({
        roomId: 'room',
        botId: 'nova',
        prompt: 'CONCURRENT_B',
      });
      await until(
        () =>
          ['completed', 'failed'].includes(concurrentA.status) &&
          ['completed', 'failed'].includes(concurrentB.status),
        'simultaneous jobs complete serially',
      );
      assert.equal(concurrentA.status, 'completed', concurrentA.error);
      assert.equal(concurrentB.status, 'completed', concurrentB.error);

      const recovery = context.host.enqueueTask({
        roomId: 'room',
        botId: 'aster',
        prompt: 'RECOVERY_WRITE: write and then summarize.',
      });
      await until(
        () => recovery.status === 'awaiting_approval' || recovery.status === 'failed',
        'recovery write approval',
      );
      assert.equal(recovery.status, 'awaiting_approval', recovery.error);
      context.approvalResolvers.get(context.snapshot.approvals.at(-1)!.id)!(true);
      await until(() => recoveryPaused, 'write finished before interruption');
      await runtime.stop(recovery.id);
      assert.equal(recovery.status, 'stopped');
      await writeFile(
        path.join(context.snapshot.settings.workspacePath, 'recovery.txt'),
        'User edit after stopping.',
      );
      const approvalsBeforeResume = context.snapshot.approvals.length;
      allowRecovery = true;
      runtime.start(recovery);
      await until(
        () => ['completed', 'failed'].includes(recovery.status),
        'explicit resume finishes',
      );
      assert.equal(recovery.status, 'completed', recovery.error);
      assert.equal(
        context.snapshot.approvals.length,
        approvalsBeforeResume,
        'completed write did not ask or execute again',
      );
      assert.equal(
        await readFile(path.join(context.snapshot.settings.workspacePath, 'recovery.txt'), 'utf8'),
        'User edit after stopping.',
      );

      const failure = context.host.enqueueTask({
        roomId: 'room',
        botId: 'aster',
        prompt: 'FAIL_HTTP: check error recovery.',
      });
      await until(
        () => ['completed', 'failed'].includes(failure.status),
        'HTTP failure is visible',
      );
      assert.equal(failure.status, 'failed');
      assert.match(failure.error ?? '', /503|unavailable/);
      assert.equal(runtime.queueState().active, 0, 'provider error releases the slot');
      runtime.start(failure);
      await until(
        () => ['completed', 'failed'].includes(failure.status),
        'HTTP failure can be explicitly resumed',
      );
      assert.equal(failure.status, 'completed', failure.error);

      forceLength = true;
      const truncated = context.host.enqueueTask({
        roomId: 'room',
        botId: 'aster',
        prompt: 'LIMIT_OUTPUT',
      });
      await until(
        () => ['completed', 'failed'].includes(truncated.status),
        'token-limited output is visible',
      );
      assert.equal(truncated.status, 'failed');
      assert.match(truncated.error ?? '', /output-token limit/);
      assert.match(truncated.output, /Verified fixture response/);
      forceLength = false;

      const slow = context.host.enqueueTask({
        roomId: 'room',
        botId: 'nova',
        prompt: 'WAIT_FOR_STOP',
      });
      await until(() => active > 0, 'slow request starts');
      const queued = context.host.enqueueTask({
        roomId: 'room',
        botId: 'aster',
        prompt: 'NEVER_START',
      });
      await until(() => queued.status === 'waiting_model', 'second model request is queued');
      await runtime.stop(queued.id);
      assert.equal(queued.status, 'stopped');
      await runtime.stop(slow.id);
      assert.equal(slow.status, 'stopped');
      assert.equal(runtime.queueState().active, 0);
      assert.equal(maximumActive, 1, 'never more than one physical model request');
      assert.ok(
        !requests.some((request) => request.includes('NEVER_START')),
        'cancelled queued request did not reach the model',
      );
    } finally {
      await runtime.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'network timeout and shell timeout are finite and release their resources',
  { timeout: 10_000 },
  async () => {
    const server = createServer((_request, _response) => {});
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'loom-timeout-'));
    try {
      await assert.rejects(
        requestText(`http://127.0.0.1:${address.port}/`, { allowPrivate: true, timeoutMs: 50 }),
        /abort|cancel|time/i,
      );
      const { host, snapshot } = fixture(dataDir);
      snapshot.settings.permissions.shell = 'allow';
      const task = host.enqueueTask({
        roomId: 'room',
        botId: 'aster',
        prompt: 'Test a bounded shell command.',
      });
      const tools = createTools({
        host,
        task,
        settings: snapshot.settings,
        signal: new AbortController().signal,
        operationKeys: new Set(),
      });
      const started = Date.now();
      await assert.rejects(
        tools.invoke('run_command', {
          command: 'node -e "setTimeout(() => {}, 10000)"',
          timeoutSeconds: 1,
        }),
        /exceeded 1 seconds/,
      );
      assert.ok(Date.now() - started < 5_000, 'the timed-out process was terminated');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
