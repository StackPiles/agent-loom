import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/server/controller.js';
import { Store } from '../src/server/store.js';
import { createTools, operationKey } from '../src/server/runtime/tools.js';
import { learningPromptContext } from '../src/server/runtime/learning-tools.js';
import { createRuntime } from '../src/server/runtime/index.js';
import type {
  NewTask,
  OperationRecord,
  RuntimeHost,
  ToolContext,
} from '../src/server/runtime/contract.js';
import { normalizeMemory, normalizeSkill } from '../src/shared/learning.js';
import type { Activity, Memory, Room, Skill, Task } from '../src/shared/types.js';

const evidence = {
  reason: 'Retain the explicit preference or procedure observed in the source task.',
  evidence: 'The source task contains the user’s stated preference and recorded tool results.',
};

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-learning-runtime-'));
  let store = new Store(dataDir);
  store.seed();
  store.put('settings', { ...store.settings(), id: 'main', demoMode: true, autoLearn: false });
  const lounge = store.get<Room>('rooms', 'room_lounge')!;
  store.put('rooms', { ...lounge, id: 'room_other', name: 'Other project' });
  let host = new Controller(store);
  t.after(async () => {
    await host.shutdown();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const task = (input: Partial<NewTask> = {}) =>
    host.enqueueTask({
      roomId: 'room_lounge',
      botId: 'bot_aster',
      prompt: 'Use the observed procedure.',
      ...input,
    });
  const tools = (work: Task, extra: Partial<ToolContext> = {}) =>
    createTools({
      host,
      task: work,
      settings: store.settings(),
      signal: new AbortController().signal,
      operationKeys: new Set(),
      ...extra,
    });
  return {
    get host() {
      return host;
    },
    get store() {
      return store;
    },
    task,
    tools,
    memory(id?: string) {
      const records = host.getSnapshot().memories;
      return normalizeMemory(id ? records.find((item) => item.id === id)! : records.at(-1)!);
    },
    skill(id?: string) {
      const records = host.getSnapshot().skills;
      return normalizeSkill(id ? records.find((item) => item.id === id)! : records.at(-1)!);
    },
    async restart() {
      await host.shutdown();
      store.close();
      store = new Store(dataDir);
      host = new Controller(store);
    },
  };
}

test('memory discovery reaches records beyond the prompt and respects bot, room, and archival scope', async (t) => {
  const f = await fixture(t);
  const work = f.task();
  for (let index = 0; index < 45; index++) {
    const stamp = new Date(Date.UTC(2025, 0, index + 1)).toISOString();
    f.store.put<Memory>('memories', {
      id: `old_${String(index).padStart(2, '0')}`,
      botId: work.botId,
      content:
        index === 0
          ? 'Vintage-only fact: reports belong in the archive folder.'
          : `Ordinary remembered fact ${index}.`,
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  const shared = f.host.saveMemory({ botId: null, content: 'Shared visible fact.' });
  const otherBot = f.host.saveMemory({ botId: 'bot_nova', content: 'Private Nova fact.' });
  const otherRoom = f.host.saveMemory({
    botId: work.botId,
    roomId: 'room_other',
    content: 'Other project fact.',
  });
  const archived = f.host.saveMemory({ botId: work.botId, content: 'Retired fact.' });
  f.host.updateMemory(archived.id, { status: 'archived' }, archived.version!);
  const prompt = learningPromptContext(f.host.getSnapshot(), work);
  assert.ok(!prompt.memories.includes('Vintage-only'));
  assert.ok(!prompt.memories.includes('Private Nova'));
  assert.ok(!prompt.memories.includes('Other project'));
  assert.ok(!prompt.memories.includes('Retired fact'));

  const tools = f.tools(work);
  const found = JSON.parse(await tools.invoke('search_memories', { query: 'Vintage-only' }));
  assert.equal(found.total, 1);
  assert.equal(found.items[0].id, 'old_00');
  assert.equal(found.items[0].version, 1, 'legacy records expose a version for replacement');
  const full = JSON.parse(await tools.invoke('read_memory', { id: 'old_00' }));
  assert.match(full.content, /archive folder/);
  assert.equal(full.history[0].reason, 'Preserved existing memory');
  assert.match(await tools.invoke('read_memory', { id: shared.id }), /Shared visible/);
  await assert.rejects(tools.invoke('read_memory', { id: otherBot.id }), /available/);
  await assert.rejects(tools.invoke('read_memory', { id: otherRoom.id }), /available/);
  assert.equal(JSON.parse(await tools.invoke('search_memories', { query: 'Retired' })).total, 0);
  const retired = JSON.parse(
    await tools.invoke('search_memories', { query: 'Retired', includeInactive: true }),
  );
  assert.equal(retired.items[0].status, 'archived');
  const first = JSON.parse(await tools.invoke('search_memories', { limit: 10 }));
  const second = JSON.parse(
    await tools.invoke('search_memories', { limit: 10, offset: first.nextOffset }),
  );
  assert.equal(first.items.length, 10);
  assert.equal(second.items.length, 10);
  assert.equal(first.total, 46);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 20);
});

test('bot memory replacement preserves scope and history and detects stale or protected updates', async (t) => {
  const f = await fixture(t);
  const work = f.task();
  const tools = f.tools(work);
  await tools.invoke('save_memory', {
    content: 'This project uses short reports.',
    scope: 'room',
    ...evidence,
  });
  const memory = f.memory();
  assert.equal(memory.roomId, work.roomId);
  assert.equal(memory.locked, false);
  assert.deepEqual(memory.revisions[0].actor, {
    kind: 'bot',
    botId: work.botId,
    roomId: work.roomId,
  });
  await tools.invoke('save_memory', {
    replacesId: memory.id,
    baseVersion: 1,
    content: 'This project uses short reports except for design reviews.',
    ...evidence,
  });
  const updated = f.memory(memory.id);
  assert.equal(updated.version, 2);
  assert.equal(
    updated.roomId,
    work.roomId,
    'replace does not attempt an owner-only scope mutation',
  );
  assert.equal(updated.revisions[0].content, memory.content);
  assert.equal(updated.revisions[1].sourceTaskId, work.id);
  await assert.rejects(
    tools.invoke('save_memory', {
      replacesId: memory.id,
      baseVersion: 1,
      content: 'Stale replacement must not win.',
      ...evidence,
    }),
    /changed|latest version/,
  );
  await assert.rejects(
    tools.invoke('save_memory', {
      replacesId: memory.id,
      content: 'Missing version must not win.',
      ...evidence,
    }),
    /baseVersion/,
  );
  await assert.rejects(
    tools.invoke('save_memory', {
      replacesId: memory.id,
      baseVersion: 2,
      scope: 'bot',
      content: 'Wrong scope must not win.',
      ...evidence,
    }),
    /scope/,
  );
  assert.equal(f.memory(memory.id).version, 2);
  f.host.updateMemory(memory.id, { locked: true }, 2);
  await assert.rejects(
    tools.invoke('save_memory', {
      replacesId: memory.id,
      baseVersion: 3,
      content: 'Cannot change a fixed preference.',
      ...evidence,
    }),
    /unlocked|locked/,
  );
  await assert.rejects(
    tools.invoke('archive_memory', {
      id: memory.id,
      baseVersion: 3,
      ...evidence,
    }),
    /unlocked|locked/,
  );
  const shared = f.host.saveMemory({
    botId: null,
    content: 'The owner controls shared instructions.',
    locked: false,
  });
  await assert.rejects(
    tools.invoke('save_memory', {
      replacesId: shared.id,
      baseVersion: shared.version,
      content: 'Cannot replace team memory.',
      ...evidence,
    }),
    /unlocked|Shared/,
  );
  assert.equal(
    f.host.getSnapshot().approvals.length,
    0,
    'ordinary own-bot learning needs no approval',
  );
});

test('memory merge is atomic across version conflicts, archives sources, and is not replayed', async (t) => {
  const f = await fixture(t);
  const work = f.task();
  const tools = f.tools(work);
  const ids: string[] = [];
  for (const content of [
    'Reports are concise.',
    'Design reports include detailed reasoning.',
    'Japanese is preferred.',
  ]) {
    await tools.invoke('save_memory', { content, ...evidence });
    ids.push(f.host.getSnapshot().memories.find((item) => item.content === content)!.id);
  }
  f.host.updateMemory(ids[2], { content: 'Japanese is preferred for this work.' }, 1);
  const args = {
    targetId: ids[0],
    baseVersion: 1,
    content: 'Use Japanese. Keep reports concise, with detailed reasoning for design reviews.',
    sources: [
      { id: ids[1], baseVersion: 1 },
      { id: ids[2], baseVersion: 1 },
    ],
    ...evidence,
  };
  await assert.rejects(tools.invoke('merge_memories', args), /changed|latest version/);
  assert.equal(f.memory(ids[0]).version, 1);
  assert.equal(f.memory(ids[1]).status, 'active');
  const currentArgs = {
    ...args,
    sources: [
      { id: ids[1], baseVersion: 1 },
      { id: ids[2], baseVersion: 2 },
    ],
  };
  await tools.invoke('merge_memories', currentArgs);
  assert.equal(f.memory(ids[0]).version, 2);
  assert.deepEqual(f.memory(ids[0]).revisions.at(-1)?.mergedFrom, [
    { id: ids[1], version: 1 },
    { id: ids[2], version: 2 },
  ]);
  assert.equal(f.memory(ids[1]).status, 'archived');
  assert.equal(f.memory(ids[2]).status, 'archived');
  assert.equal(f.memory(ids[1]).revisions[0].content, 'Design reports include detailed reasoning.');
  assert.match(await tools.invoke('merge_memories', currentArgs), /already completed/);
  assert.equal(f.memory(ids[0]).version, 2);
});

test('bot skills activate automatically, update in place, and pin execution separately from maintenance reads', async (t) => {
  const f = await fixture(t);
  const work = f.task();
  const tools = f.tools(work);
  await tools.invoke('propose_skill', {
    name: 'Release review',
    description: 'Use before a local release.',
    content: 'Version one: inspect the test results.',
    ...evidence,
  });
  const skill = f.skill();
  assert.equal(skill.status, 'active');
  assert.equal(skill.autoActivated, true);
  assert.equal(skill.locked, false);
  assert.equal(skill.sourceTaskId, work.id);
  assert.equal(
    f.host.getSnapshot().settings.autoLearn,
    false,
    'explicit learning tools work independently of background review preference',
  );
  assert.match(await tools.invoke('read_skill', { id: skill.id }), /Version: 1\n/);
  const before = f.host.getSnapshot().tasks.find((item) => item.id === work.id)!.skillUses!;
  assert.equal(before[0].content, skill.content);
  await tools.invoke('update_skill', {
    id: skill.id,
    baseVersion: 1,
    description: 'Use before a release, including formatting checks.',
    content: 'Version two: inspect tests and the formatting results.',
    ...evidence,
  });
  assert.equal(f.host.getSnapshot().skills.length, 1);
  assert.equal(f.skill(skill.id).version, 2);
  assert.equal(f.skill(skill.id).revisions[0].content, skill.content);
  const selected = await tools.invoke('read_skill', { id: skill.id });
  assert.match(selected, /Version: 1\n/);
  assert.match(selected, /Version one/);
  assert.ok(!selected.includes('Version two:'));
  const latest = JSON.parse(await tools.invoke('inspect_skill', { id: skill.id }));
  assert.equal(latest.version, 2);
  assert.equal(latest.pinnedVersionForTask, 1);
  assert.match(latest.content, /Version two/);
  const metadata = JSON.parse(learningPromptContext(f.host.getSnapshot(), work).skills);
  assert.equal(metadata.version, 1);
  assert.equal(metadata.latestVersion, 2);
  const fresh = f.task();
  assert.match(await f.tools(fresh).invoke('read_skill', { id: skill.id }), /Version: 2\n/);
  await assert.rejects(
    tools.invoke('update_skill', {
      id: skill.id,
      baseVersion: 1,
      content: 'Stale skill replacement.',
      ...evidence,
    }),
    /changed|latest version/,
  );
  assert.equal(f.skill(skill.id).version, 2);
  assert.equal(f.host.getSnapshot().approvals.length, 0);
  assert.equal(f.host.getSnapshot().settings.permissions.shell, 'ask');
});

test('skill versions survive pause and process restart while live archive, scope, and membership still apply', async (t) => {
  const f = await fixture(t);
  const work = f.task();
  const tools = f.tools(work);
  await tools.invoke('propose_skill', {
    name: 'Recovery procedure',
    description: 'Use for recoverable work.',
    content: 'Original instructions retained for this task.',
    ...evidence,
  });
  const skill = f.skill();
  await tools.invoke('read_skill', { id: skill.id });
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reread = f
    .tools(work, { waitForRoom: () => paused })
    .invoke('read_skill', { id: skill.id });
  f.host.updateSkill(
    skill.id,
    { content: 'New instructions for subsequent work.', locked: false },
    1,
  );
  release();
  assert.match(await reread, /Original instructions/);
  assert.equal(
    f.host.getSnapshot().tasks.find((item) => item.id === work.id)?.skillUses?.length,
    1,
  );
  await f.restart();
  assert.equal(
    f.host.getSnapshot().tasks.find((item) => item.id === work.id)?.status,
    'interrupted',
  );
  const resumed = f.host.resume(work.id);
  const recovered = f.tools(resumed);
  assert.match(await recovered.invoke('read_skill', { id: skill.id }), /Original instructions/);
  assert.equal(
    f.host.getSnapshot().tasks.find((item) => item.id === work.id)?.skillUses?.[0].version,
    1,
  );
  const next = f.task();
  assert.match(await f.tools(next).invoke('read_skill', { id: skill.id }), /New instructions/);

  f.host.updateSkill(skill.id, { status: 'archived' }, 2);
  await assert.rejects(recovered.invoke('read_skill', { id: skill.id }), /No active skill/);
  assert.ok(!learningPromptContext(f.host.getSnapshot(), resumed).skills.includes(skill.id));
  f.host.updateSkill(skill.id, { status: 'active', roomId: 'room_other' }, 3);
  await assert.rejects(recovered.invoke('read_skill', { id: skill.id }), /available/);
  f.host.updateSkill(skill.id, { roomId: null }, 4);
  f.store.patch('bots', work.botId, { enabled: false });
  await assert.rejects(recovered.invoke('read_skill', { id: skill.id }), /enabled member/);
});

test('learning review tools retain one change per type across registry recreation and keep external actions unavailable', async (t) => {
  const f = await fixture(t);
  const source = f.task();
  f.host.updateTask(source.id, { status: 'completed' });
  const work = f.task({ kind: 'learning', parentTaskId: source.id });
  const tools = f.tools(work);
  const names = tools.definitions.map((item) => item.name);
  for (const name of [
    'search_memories',
    'read_memory',
    'archive_memory',
    'merge_memories',
    'search_skills',
    'inspect_skill',
    'update_skill',
  ])
    assert.ok(names.includes(name));
  for (const name of [
    'run_command',
    'send_message',
    'send_user_message',
    'generate_image',
    'manage_automation',
  ])
    assert.ok(!names.includes(name));
  await tools.invoke('save_memory', { content: 'One evidence-supported memory.', ...evidence });
  assert.equal(f.memory().sourceTaskId, source.id);
  await tools.invoke('propose_skill', {
    name: 'Evidence review',
    description: 'Review actual evidence.',
    content: 'Read the recorded result before drawing a conclusion.',
    ...evidence,
  });
  assert.equal(f.skill().sourceTaskId, source.id);
  await assert.rejects(
    tools.invoke('save_memory', { content: 'A second memory.', ...evidence }),
    /at most one memory/,
  );
  const resumed = f.tools(f.host.getSnapshot().tasks.find((item) => item.id === work.id)!);
  await assert.rejects(
    resumed.invoke('update_skill', {
      id: f.skill().id,
      baseVersion: 1,
      content: 'A second skill change.',
      ...evidence,
    }),
    /at most one skill/,
  );
  await assert.rejects(
    resumed.invoke('archive_memory', { id: f.memory().id, baseVersion: 1, ...evidence }),
    /at most one memory/,
  );
  assert.match(
    await resumed.invoke('read_memory', { id: f.memory().id }),
    /One evidence-supported/,
  );
  assert.equal(f.host.getSnapshot().notifications.length, 0);
});

for (const journalStatus of ['completed', 'started'] as const) {
  test(`interrupted learning activity spends its quota after restart with a ${journalStatus} journal`, async (t) => {
    const f = await fixture(t);
    const source = f.task();
    f.host.updateTask(source.id, { status: 'completed' });
    const work = f.task({ kind: 'learning', parentTaskId: source.id });
    const tools = f.tools(work);
    const memoryArgs = { content: 'Persisted before the activity terminal update.', ...evidence };
    const skillArgs = {
      name: 'Interrupted review procedure',
      description: 'Retain the actual observed result.',
      content: 'A procedure saved before the activity terminal update.',
      ...evidence,
    };
    const terminalUpdates = new Set<string>();
    const updateActivity = f.host.updateActivity.bind(f.host);
    // Fault injection: retain exactly the durable state from the window after
    // the domain/journal write but before the outer activity success update.
    f.host.updateActivity = (id, patch) => {
      if (
        patch.status === 'success' &&
        f.store.get<Activity>('activities', id)?.kind === 'learning'
      ) {
        terminalUpdates.add(id);
        return;
      }
      updateActivity(id, patch);
    };
    try {
      await tools.invoke('save_memory', memoryArgs);
      await tools.invoke('propose_skill', skillArgs);
    } finally {
      f.host.updateActivity = updateActivity;
    }
    assert.equal(terminalUpdates.size, 2);
    for (const id of terminalUpdates)
      assert.equal(f.store.get<Activity>('activities', id)?.status, 'running');
    for (const [toolName, args] of [
      ['save_memory', memoryArgs],
      ['propose_skill', skillArgs],
    ] as const) {
      const operation = f.host.getOperation(operationKey(work.id, toolName, args))!;
      assert.equal(operation.status, 'completed');
      if (journalStatus === 'started')
        f.host.saveOperation({ ...operation, status: 'started', result: undefined });
    }
    const newMemoryArgs = { content: 'A second change must remain blocked.', ...evidence };
    await assert.rejects(f.tools(work).invoke('save_memory', newMemoryArgs), /at most one memory/);
    await f.restart();
    for (const id of terminalUpdates) {
      const activity = f.store.get<Activity>('activities', id)!;
      assert.equal(activity.status, 'error');
      assert.ok(activity.detail.endsWith('\nInterrupted by server restart.'));
    }
    const resumed = f.tools(f.host.resume(work.id));
    await assert.rejects(
      resumed.invoke('save_memory', {
        content: 'A different second change after restart.',
        ...evidence,
      }),
      /at most one memory/,
    );
    await assert.rejects(
      resumed.invoke('propose_skill', {
        ...skillArgs,
        name: 'A different procedure after restart',
        content: 'No second change is permitted.',
      }),
      /at most one skill/,
    );
    if (journalStatus === 'completed') {
      assert.match(await resumed.invoke('save_memory', memoryArgs), /already completed/);
      assert.match(await resumed.invoke('propose_skill', skillArgs), /already completed/);
    } else {
      await assert.rejects(resumed.invoke('save_memory', memoryArgs), /uncertain or failed/);
      await assert.rejects(resumed.invoke('propose_skill', skillArgs), /uncertain or failed/);
    }
    assert.equal(f.host.getSnapshot().memories.length, 1);
    assert.equal(f.host.getSnapshot().skills.length, 1);
  });
}

test('a confirmed learning version conflict leaves its quota available after recovery', async (t) => {
  const f = await fixture(t);
  const source = f.task();
  f.host.updateTask(source.id, { status: 'completed' });
  const memory = f.host.saveMemory({
    botId: source.botId,
    content: 'Original observed fact.',
    locked: false,
  });
  f.host.updateMemory(memory.id, { content: 'The owner’s intervening correction.' }, 1);
  const work = f.task({ kind: 'learning', parentTaskId: source.id });
  await assert.rejects(
    f.tools(work).invoke('save_memory', {
      replacesId: memory.id,
      baseVersion: 1,
      content: 'A stale proposal.',
      ...evidence,
    }),
    /changed|latest version/,
  );
  await f.restart();
  const resumed = f.tools(f.host.resume(work.id));
  const latest = JSON.parse(await resumed.invoke('read_memory', { id: memory.id }));
  assert.equal(latest.version, 2);
  await resumed.invoke('save_memory', {
    replacesId: memory.id,
    baseVersion: latest.version,
    content: `${latest.content} Include the newly verified condition.`,
    ...evidence,
  });
  assert.equal(f.memory(memory.id).version, 3);
  assert.match(f.memory(memory.id).content, /intervening correction/);
});

test(
  'real Pi completes a sequential search-inspect-update review for both memories and skills before its final answer',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const source = f.task();
    f.host.updateTask(source.id, { status: 'completed' });
    const memory = f.host.saveMemory({
      botId: source.botId,
      content: 'Learning fixture memory before review.',
      locked: false,
    });
    const candidate = f.host.proposeSkill({
      botId: source.botId,
      name: 'Learning fixture procedure',
      description: 'Use for the observed workflow.',
      content: 'Original fixture procedure.',
      evidence: 'Owner-supplied starting procedure.',
      locked: false,
    });
    const skill = f.host.updateSkill(candidate.id, { status: 'active' }, 1);
    const calls = [
      { name: 'search_memories', args: { query: 'Learning fixture memory' } },
      { name: 'read_memory', args: { id: memory.id } },
      {
        name: 'save_memory',
        args: {
          replacesId: memory.id,
          baseVersion: 1,
          content: 'Learning fixture memory corrected from the actual evidence.',
          ...evidence,
        },
      },
      { name: 'search_skills', args: { query: 'Learning fixture procedure' } },
      { name: 'inspect_skill', args: { id: skill.id } },
      {
        name: 'update_skill',
        args: {
          id: skill.id,
          baseVersion: skill.version,
          content: 'Updated fixture procedure with the observed verification step.',
          ...evidence,
        },
      },
    ];
    const requests: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const step = requests.length;
      requests.push(payload);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = {
        id: `learning-fixture-${step}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1_000),
        model: 'learning-fixture-model',
      };
      const call = calls[step];
      const delta = call
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `learning_call_${step}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          }
        : {
            role: 'assistant',
            content: 'Both records were reviewed and updated from the observed evidence.',
          };
      response.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      demoMode: false,
      model: {
        ...f.store.settings().model,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'learning-fixture-model',
      },
    });
    f.host.runtime = createRuntime(f.host);
    const review = f.task({
      kind: 'learning',
      parentTaskId: source.id,
      prompt: 'Review both recorded facts and procedures, then report the result.',
    });
    const deadline = Date.now() + 12_000;
    while (
      !['completed', 'failed'].includes(
        f.host.getSnapshot().tasks.find((item) => item.id === review.id)!.status,
      )
    ) {
      if (Date.now() > deadline) throw new Error('The multi-step learning review did not finish.');
      await delay(10);
    }
    const result = f.host.getSnapshot().tasks.find((item) => item.id === review.id)!;
    assert.equal(result.status, 'completed', result.error);
    assert.match(result.output, /Both records were reviewed and updated/);
    assert.equal(
      requests.length,
      7,
      'six sequential learning tools still leave capacity for the final answer',
    );
    for (const request of requests) {
      const names = request.tools!.map((tool) => tool.function.name);
      for (const call of calls) assert.ok(names.includes(call.name));
      for (const name of [
        'run_command',
        'send_message',
        'send_user_message',
        'generate_image',
        'manage_automation',
      ])
        assert.ok(!names.includes(name));
    }
    assert.equal(f.memory(memory.id).version, 2);
    assert.equal(f.memory(memory.id).sourceTaskId, source.id);
    assert.equal(f.skill(skill.id).version, skill.version + 1);
    assert.equal(f.skill(skill.id).sourceTaskId, source.id);
    assert.equal(
      f.store
        .list<OperationRecord>('operations')
        .filter(
          (item) =>
            item.taskId === review.id &&
            ['save_memory', 'update_skill'].includes(item.toolName) &&
            item.status === 'completed',
        ).length,
      2,
    );
    assert.equal(f.host.getSnapshot().approvals.length, 0);
  },
);

test('skill maintenance cannot activate candidates, edit locked records, or regenerate an owner-disabled procedure', async (t) => {
  const f = await fixture(t);
  const work = f.task();
  const tools = f.tools(work);
  const candidate = f.host.proposeSkill({
    botId: work.botId,
    name: 'Owner draft',
    description: 'Not active yet.',
    content: 'Draft procedure that must remain a candidate.',
    evidence: 'Owner-authored draft.',
  });
  assert.equal(
    JSON.parse(await tools.invoke('inspect_skill', { id: candidate.id })).status,
    'candidate',
  );
  await assert.rejects(tools.invoke('read_skill', { id: candidate.id }), /No active skill/);
  await assert.rejects(
    tools.invoke('update_skill', {
      id: candidate.id,
      baseVersion: 1,
      content: 'Attempted implicit activation.',
      ...evidence,
    }),
    /active, unlocked/,
  );
  await tools.invoke('propose_skill', {
    name: 'Disabled workflow',
    description: 'An observed procedure.',
    content: 'Step one: read the evidence. Step two: report only what it supports.',
    ...evidence,
  });
  const active = f.host.getSnapshot().skills.find((item) => item.name === 'Disabled workflow')!;
  f.host.updateSkill(active.id, { status: 'archived' }, 1);
  await assert.rejects(
    tools.invoke('propose_skill', {
      name: 'Different name',
      description: 'Try to copy the same archived workflow.',
      content: active.content,
      ...evidence,
    }),
    /fixed|inactive|owner/,
  );
  await assert.rejects(
    tools.invoke('propose_skill', {
      name: '  DISABLED   WORKFLOW  ',
      description: 'Try to rewrite an archived workflow.',
      content: 'Rewritten procedure under the archived identity.',
      ...evidence,
    }),
    /fixed|inactive|owner/,
  );
  assert.equal(f.host.getSnapshot().skills.length, 2);
});

test('learning schemas reject forged ownership and require evidence before creating activity or receipts', async (t) => {
  const f = await fixture(t);
  const work = f.task();
  const tools = f.tools(work);
  const activityCount = f.host.getSnapshot().activities.length;
  await assert.rejects(
    tools.invoke('save_memory', {
      content: 'Cannot impersonate a different bot.',
      botId: 'bot_nova',
      ...evidence,
    }),
    /Unrecognized|unrecognized/,
  );
  await assert.rejects(
    tools.invoke('save_memory', { content: 'No evidence provided.' }),
    /reason|evidence/,
  );
  await assert.rejects(
    tools.invoke('propose_skill', {
      name: 'Forged scope',
      description: 'Not allowed.',
      content: 'Do something.',
      roomId: 'room_other',
      ...evidence,
    }),
    /Unrecognized|unrecognized/,
  );
  assert.equal(f.host.getSnapshot().activities.length, activityCount);
  assert.equal(f.store.list('operations').length, 0);
  assert.equal(f.host.getSnapshot().memories.length, 0);
  assert.equal(f.host.getSnapshot().skills.length, 0);
});

test('learning context and revision inspection remain bounded without cutting a memory in half', async (t) => {
  const f = await fixture(t);
  const work = f.task();
  const tools = f.tools(work);
  const first = f.host.saveMemory({
    botId: work.botId,
    content: 'a'.repeat(7_900) + ' full-first-ending',
  });
  const second = f.host.saveMemory({
    botId: work.botId,
    content: 'b'.repeat(7_900) + ' full-second-ending',
  });
  let edited = first;
  for (let index = 0; index < 25; index++)
    edited = f.host.updateMemory(
      first.id,
      {
        content: `revision ${index} ` + 'a'.repeat(7_800) + ' full-first-ending',
        reason: 'r'.repeat(1_000),
        evidence: 'e'.repeat(4_000),
      },
      edited.version!,
    );
  const prompt = learningPromptContext(f.host.getSnapshot(), work);
  assert.ok(prompt.memories.length <= 12_000);
  const entries = prompt.memories.split('\n').map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, first.id);
  assert.ok(entries[0].content.endsWith('full-first-ending'));
  assert.ok(!prompt.memories.includes(second.id));
  const inspected = JSON.parse(await tools.invoke('read_memory', { id: first.id }));
  assert.equal(inspected.content, edited.content);
  assert.equal(inspected.evidence.length, 4_000, 'current evidence remains complete');
  assert.equal(inspected.revisionCount, 26);
  assert.equal(inspected.historyTruncated, true);
  assert.ok(
    inspected.history.every(
      (item) => item.reason.length <= 300 && (item.evidence?.length ?? 0) <= 500,
    ),
  );
  assert.ok(JSON.stringify(inspected.history).length < 6_100);

  for (let index = 0; index < 30; index++) {
    const skill = f.host.proposeSkill({
      botId: work.botId,
      name: `Long catalog entry ${index}`,
      description: 'd'.repeat(1_000),
      content: `Procedure ${index}.`,
      evidence: 'Catalog size fixture.',
    });
    f.host.updateSkill(skill.id, { status: 'active' }, skill.version);
  }
  const ids = new Set<string>();
  let offset: number | null = 0;
  while (offset !== null) {
    const result = await tools.invoke('search_skills', {
      query: 'Long catalog entry',
      limit: 50,
      offset,
    });
    assert.ok(result.length < 20_000, 'long descriptions cannot flood the next model request');
    const current = JSON.parse(result);
    for (const item of current.items) {
      assert.ok(!ids.has(item.id), 'continuation advances by the actual returned item count');
      ids.add(item.id);
    }
    offset = current.nextOffset;
  }
  assert.equal(ids.size, 30, 'bounded pages still expose every matching skill');
});

test('new learning mutations fail closed on a host without update capabilities', async (t) => {
  const f = await fixture(t);
  const work = f.task();
  const tools = f.tools(work);
  await tools.invoke('propose_skill', {
    name: 'Fixture skill',
    description: 'Used by this test.',
    content: 'Original instructions.',
    ...evidence,
  });
  const limited = Object.create(f.host) as RuntimeHost;
  limited.updateSkill = undefined;
  await assert.rejects(
    f.tools(work, { host: limited }).invoke('update_skill', {
      id: f.skill().id,
      baseVersion: 1,
      content: 'Changed instructions.',
      ...evidence,
    }),
    /updates are unavailable/,
  );
  assert.equal(f.skill().version, 1);
});
