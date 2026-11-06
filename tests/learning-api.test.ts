import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import {
  normalizeMemory,
  normalizeSkill,
  type LearningActor,
  type SkillInput,
} from '../src/shared/learning.js';
import type { Bot, Memory, Room, Skill, Snapshot } from '../src/shared/types.js';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-learning-api-'));
  const context = await createApp({
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
    await context.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    context.app.inject({ method, url, payload, headers: { host: 'localhost' } });
  await call('POST', '/api/demo', { enabled: true });
  const actor: LearningActor = { kind: 'bot', botId: 'bot_aster', roomId: 'room_lounge' };
  const task = context.controller.enqueueTask({
    roomId: actor.roomId,
    botId: actor.botId,
    prompt: 'Complete a controlled test task.',
  });
  const provenance = {
    sourceTaskId: task.id,
    reason: 'Retain the verified result of this task.',
    evidence: 'The controlled task confirmed this fact and procedure.',
  };
  const createMemory = (content: string, extra: Partial<Memory> = {}) =>
    normalizeMemory(
      context.controller.saveMemory(
        {
          botId: actor.botId,
          content,
          ...provenance,
          ...extra,
        },
        actor,
      ),
    );
  const createSkill = (name: string, extra: Partial<Skill> = {}) =>
    normalizeSkill(
      context.controller.proposeSkill(
        {
          botId: actor.botId,
          name,
          description: `Use ${name} for the corresponding controlled task.`,
          content: `# ${name}\n\nPerform the verified procedure.`,
          ...provenance,
          ...extra,
        },
        actor,
      ),
    );
  return { ...context, dataDir, call, actor, task, provenance, createMemory, createSkill };
}

test('owner records are fixed by default and all existing API mutations require a current version', async (t) => {
  const { call, store } = await fixture(t);
  const memory = (
    await call('POST', '/api/memories', { content: 'Owner preference.' })
  ).json<Memory>();
  const skill = (
    await call('POST', '/api/skills', {
      name: 'owner-review',
      description: 'Review owner work.',
      content: 'Check the actual result.',
    })
  ).json<Skill>();
  assert.equal(memory.locked, true);
  assert.equal(memory.version, 1);
  assert.equal(memory.status, 'active');
  assert.equal(skill.locked, true);
  assert.equal(skill.status, 'candidate');
  assert.equal(skill.autoActivated, false);
  assert.deepEqual(memory.revisions?.[0].actor, { kind: 'user' });
  assert.deepEqual(skill.revisions[0].actor, { kind: 'user' });
  for (const kind of ['memories', 'skills'] as const) {
    const entry = kind === 'memories' ? memory : skill;
    const before = store.get(kind, entry.id);
    assert.equal(
      (await call('PATCH', `/api/${kind}/${entry.id}`, { content: 'Stale change' })).statusCode,
      400,
    );
    assert.equal(
      (await call('PATCH', `/api/${kind}/${entry.id}`, { baseVersion: 9, locked: false }))
        .statusCode,
      409,
    );
    assert.equal(
      (await call('POST', `/api/${kind}/${entry.id}/restore`, { version: 1 })).statusCode,
      400,
    );
    assert.deepEqual(store.get(kind, entry.id), before);
  }
  assert.equal((await call('DELETE', `/api/memories/${memory.id}`)).statusCode, 400);
  assert.equal(
    (
      await call('PATCH', `/api/skills/${skill.id}`, {
        baseVersion: 1,
        actor: { kind: 'bot', botId: 'bot_aster' },
        status: 'active',
      })
    ).statusCode,
    400,
    'the owner API does not accept a forged actor',
  );
});

test('bot-created skills are immediately active and later bot changes append evidence-linked versions', async (t) => {
  const { createSkill, createMemory, controller, actor, provenance } = await fixture(t);
  const skill = createSkill('verified-review');
  const memory = createMemory('A verified preference.');
  assert.equal(skill.status, 'active');
  assert.equal(skill.autoActivated, true);
  assert.equal(skill.locked, false);
  assert.equal(memory.locked, false);
  assert.deepEqual(skill.revisions[0].actor, actor);
  const updated = controller.updateSkill(
    skill.id,
    {
      ...provenance,
      content: 'Include the newly verified edge case.',
      reason: 'A real edge case was found.',
    },
    skill.version,
    actor,
  );
  assert.equal(updated.id, skill.id);
  assert.equal(updated.version, 2);
  assert.equal(updated.status, 'active');
  assert.equal(updated.revisions[0].content, skill.content);
  assert.equal(updated.revisions[1].reason, 'A real edge case was found.');
  assert.equal(updated.revisions[1].sourceTaskId, provenance.sourceTaskId);
  assert.equal(updated.revisions[1].evidence, provenance.evidence);
  assert.deepEqual(updated.revisions[1].actor, actor);
});

test('the replacement memory interface requires a base version and preserves the original revision', async (t) => {
  const { controller, createMemory, actor, provenance, store } = await fixture(t);
  const memory = createMemory('Use concise replies.');
  const updated = normalizeMemory(
    controller.saveMemory(
      {
        botId: actor.kind === 'bot' ? actor.botId : null,
        replacesId: memory.id,
        baseVersion: memory.version,
        content: 'Use concise replies except for detailed technical design.',
        ...provenance,
      },
      actor,
    ),
  );
  assert.equal(updated.id, memory.id);
  assert.equal(updated.version, 2);
  assert.equal(updated.revisions[0].content, 'Use concise replies.');
  const stale = {
    botId: updated.botId,
    replacesId: memory.id,
    content: 'Stale result.',
    ...provenance,
  };
  assert.throws(() => controller.saveMemory(stale, actor));
  assert.throws(() => controller.saveMemory({ ...stale, baseVersion: 1 }, actor), {
    statusCode: 409,
  });
  assert.deepEqual(store.get('memories', memory.id), updated);
});

test('an owner correction invalidates pending bot changes, and fixed records cannot be changed or cloned', async (t) => {
  const { controller, createMemory, createSkill, actor, provenance, store } = await fixture(t);
  const memory = createMemory('Original memory.');
  const skill = createSkill('fixed-workflow');
  const fixedMemory = controller.updateMemory(
    memory.id,
    {
      content: 'The owner corrected this fact.',
      locked: true,
      reason: 'Owner correction.',
    },
    memory.version,
  );
  const fixedSkill = controller.updateSkill(
    skill.id,
    {
      content: 'The owner corrected these steps.',
      name: 'renamed-workflow',
      locked: true,
    },
    skill.version,
  );
  assert.throws(
    () =>
      controller.updateMemory(memory.id, { content: 'Stale overwrite.', ...provenance }, 1, actor),
    { statusCode: 409 },
  );
  assert.throws(
    () =>
      controller.updateMemory(memory.id, { content: 'Fresh overwrite.', ...provenance }, 2, actor),
    { statusCode: 409 },
  );
  assert.throws(
    () =>
      controller.updateSkill(
        skill.id,
        { content: 'Overwrite fixed steps.', ...provenance },
        2,
        actor,
      ),
    { statusCode: 409 },
  );
  assert.throws(
    () => createMemory(memory.content),
    { statusCode: 409 },
    'historical content cannot bypass an owner correction',
  );
  assert.throws(() => createSkill('another-name', { content: skill.content }), { statusCode: 409 });
  assert.throws(
    () => createSkill(skill.name, { content: 'A different body.' }),
    { statusCode: 409 },
    'historical names remain protected',
  );
  assert.deepEqual(store.get('memories', memory.id), fixedMemory);
  assert.deepEqual(store.get('skills', skill.id), fixedSkill);
});

test('bot writes stay within their owner and room and cannot change control fields', async (t) => {
  const { controller, createMemory, createSkill, actor, provenance, call, store } =
    await fixture(t);
  const memory = createMemory('Owned fact.');
  const skill = createSkill('owned-procedure');
  const shared = controller.saveMemory({ botId: null, content: 'Shared fact.', locked: false });
  const other = controller.saveMemory({
    botId: 'bot_nova',
    content: 'Other bot fact.',
    locked: false,
  });
  for (const target of [shared, other])
    assert.throws(
      () => controller.updateMemory(target.id, { content: 'Hijacked.', ...provenance }, 1, actor),
      { statusCode: 403 },
    );
  for (const patch of [{ botId: null }, { roomId: null }, { locked: false }]) {
    assert.throws(() => controller.updateMemory(memory.id, { ...patch, ...provenance }, 1, actor), {
      statusCode: 403,
    });
    assert.throws(() => controller.updateSkill(skill.id, { ...patch, ...provenance }, 1, actor), {
      statusCode: 403,
    });
  }
  assert.throws(
    () => controller.updateSkill(skill.id, { status: 'archived', ...provenance }, 1, actor),
    { statusCode: 403 },
  );
  const secondRoom = (
    await call('POST', '/api/rooms', { name: 'Other room', botIds: ['bot_aster'] })
  ).json<Room>();
  const privateMemory = controller.saveMemory({
    botId: 'bot_aster',
    roomId: secondRoom.id,
    content: 'Other room only.',
    locked: false,
  });
  assert.throws(
    () =>
      controller.updateMemory(
        privateMemory.id,
        { content: 'Wrong room.', ...provenance },
        1,
        actor,
      ),
    { statusCode: 403 },
  );
  store.patch<Bot>('bots', 'bot_aster', { enabled: false });
  assert.throws(
    () => controller.updateMemory(memory.id, { content: 'Disabled bot.', ...provenance }, 1, actor),
    { statusCode: 403 },
  );
});

test('bot writes require real provenance and cannot invent another bot’s source task', async (t) => {
  const { controller, actor, provenance } = await fixture(t);
  const content = { botId: 'bot_aster', content: 'A fact.', ...provenance };
  assert.throws(() => controller.saveMemory({ ...content, evidence: '' }, actor));
  assert.throws(() => controller.saveMemory({ ...content, reason: '' }, actor));
  assert.throws(() => controller.saveMemory({ ...content, sourceTaskId: undefined }, actor));
  assert.throws(() => controller.saveMemory({ ...content, sourceTaskId: 'missing' }, actor), {
    statusCode: 404,
  });
  const otherTask = controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_nova',
    prompt: 'Other work.',
  });
  assert.throws(() => controller.saveMemory({ ...content, sourceTaskId: otherTask.id }, actor), {
    statusCode: 403,
  });
  assert.throws(() =>
    controller.proposeSkill(
      {
        botId: 'bot_aster',
        name: 'unsupported',
        description: 'Use for this task.',
        content: 'Unverified steps.',
        ...provenance,
        reason: '',
      },
      actor,
    ),
  );
  const { evidence: _, ...withoutEvidence } = {
    botId: 'bot_aster',
    name: 'missing-evidence',
    description: 'Use for the observed workflow.',
    content: 'Steps without provided evidence.',
    ...provenance,
  };
  assert.throws(
    () => controller.proposeSkill(withoutEvidence as SkillInput, actor),
    /observed evidence/,
  );
});

test('archive and inactive owner decisions prevent normalized clones and bot reactivation', async (t) => {
  const { controller, actor, provenance, createMemory, createSkill } = await fixture(t);
  const memory = createMemory('Full width Ａ and spaces.');
  const skill = createSkill('archived-workflow');
  controller.updateMemory(memory.id, { status: 'archived', ...provenance }, memory.version, actor);
  controller.updateSkill(skill.id, { status: 'archived' }, skill.version);
  assert.throws(() => createMemory(' full width A   AND spaces. '), { statusCode: 409 });
  assert.throws(() => createSkill('unrelated-name', { content: skill.content.toUpperCase() }), {
    statusCode: 409,
  });
  assert.throws(
    () => controller.updateMemory(memory.id, { status: 'active', ...provenance }, 2, actor),
    { statusCode: 409 },
  );
  const candidate = controller.proposeSkill({
    botId: 'bot_aster',
    name: 'owner-candidate',
    description: 'Candidate.',
    content: 'Owner candidate content.',
    evidence: '',
    locked: false,
  });
  assert.throws(() => createSkill(candidate.name, { content: 'Replacement candidate.' }), {
    statusCode: 409,
  });
  assert.throws(
    () =>
      controller.updateSkill(
        candidate.id,
        { ...provenance, content: 'Activate implicitly.' },
        1,
        actor,
      ),
    { statusCode: 409 },
  );
});

test('room-specific protection cannot be bypassed by creating an all-room record from another room', async (t) => {
  const { controller, createMemory, createSkill, actor, provenance, call } = await fixture(t);
  const memory = createMemory('Room A protected fact.', { roomId: 'room_lounge' });
  const skill = createSkill('room-a-procedure', { roomId: 'room_lounge' });
  controller.updateMemory(memory.id, { status: 'archived' }, 1);
  controller.updateSkill(skill.id, { status: 'archived' }, 1);
  const room = (
    await call('POST', '/api/rooms', { name: 'Room B', botIds: ['bot_aster'] })
  ).json<Room>();
  const task = controller.enqueueTask({
    roomId: room.id,
    botId: 'bot_aster',
    prompt: 'Room B task.',
  });
  const actorB: LearningActor = { ...actor, kind: 'bot', botId: 'bot_aster', roomId: room.id };
  const source = { ...provenance, sourceTaskId: task.id };
  const fact = { botId: 'bot_aster', content: memory.content, ...source };
  const procedure = {
    botId: 'bot_aster',
    name: skill.name,
    description: skill.description,
    content: skill.content,
    ...source,
  };
  assert.throws(() => controller.saveMemory(fact, actorB), { statusCode: 409 });
  assert.throws(() => controller.proposeSkill(procedure, actorB), { statusCode: 409 });
  assert.equal(controller.saveMemory({ ...fact, roomId: room.id }, actorB).roomId, room.id);
  assert.equal(controller.proposeSkill({ ...procedure, roomId: room.id }, actorB).roomId, room.id);
});

test('active duplicates reuse their identity and conflicting names require updating the existing skill', async (t) => {
  const { createMemory, createSkill, controller } = await fixture(t);
  const memory = createMemory('One verified fact.');
  assert.equal(createMemory(' ONE   verified fact. ').id, memory.id);
  const skill = createSkill('repeatable-review');
  assert.equal(createSkill('another-label', { content: skill.content }).id, skill.id);
  assert.throws(() => createSkill('repeatable-review', { content: 'Different instructions.' }), {
    statusCode: 409,
  });
  assert.equal(controller.getSnapshot().memories.length, 1);
  assert.equal(controller.getSnapshot().skills.length, 1);
});

test('a duplicate owner creation cannot silently discard a fixed choice or change a record without its version', async (t) => {
  const { createMemory, createSkill, call, store } = await fixture(t);
  const memory = createMemory('Already learned preference.');
  const skill = createSkill('already-learned');
  const memoryResponse = await call('POST', '/api/memories', {
    botId: 'bot_aster',
    content: memory.content,
  });
  const skillResponse = await call('POST', '/api/skills', {
    botId: 'bot_aster',
    name: skill.name,
    content: skill.content,
    description: skill.description,
  });
  assert.equal(memoryResponse.statusCode, 409);
  assert.equal(skillResponse.statusCode, 409);
  assert.equal(store.get<Memory>('memories', memory.id)?.locked, false);
  assert.equal(store.get<Skill>('skills', skill.id)?.locked, false);
  assert.equal(store.get<Memory>('memories', memory.id)?.version, 1);
  assert.equal(store.get<Skill>('skills', skill.id)?.version, 1);
});

test('restore appends a new revision, restores matching evidence and source, and preserves owner control', async (t) => {
  const { controller, call, createSkill, task, provenance, actor } = await fixture(t);
  const skill = createSkill('restore-procedure');
  const nextTask = controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'A later task.',
  });
  const edited = controller.updateSkill(
    skill.id,
    {
      name: 'later-name',
      description: 'Later description.',
      content: 'Later instructions.',
      evidence: 'Later evidence.',
      sourceTaskId: nextTask.id,
      locked: true,
      status: 'archived',
    },
    1,
  );
  const restored = (
    await call('POST', `/api/skills/${skill.id}/restore`, { version: 1, baseVersion: 2 })
  ).json<Skill>();
  assert.equal(restored.version, 3);
  assert.equal(restored.name, skill.name);
  assert.equal(restored.content, skill.content);
  assert.equal(restored.evidence, provenance.evidence);
  assert.equal(restored.sourceTaskId, task.id);
  assert.equal(restored.locked, true);
  assert.equal(restored.status, 'archived');
  assert.equal(restored.revisions[1].sourceTaskId, nextTask.id);
  assert.deepEqual(restored.revisions[2].actor, { kind: 'user' });
  assert.equal(edited.revisions.length, 2);
  const memory = normalizeMemory(
    controller.saveMemory({
      botId: 'bot_aster',
      content: 'Owner fact without task.',
      locked: false,
    }),
  );
  controller.updateMemory(
    memory.id,
    { content: 'Bot revision with task.', ...provenance },
    1,
    actor,
  );
  const restoredMemory = normalizeMemory(controller.restoreMemory(memory.id, 1, 2));
  assert.equal(
    restoredMemory.sourceTaskId,
    undefined,
    'restoring an unsourced fact clears the later source',
  );
  assert.equal(restoredMemory.revisions[1].sourceTaskId, task.id);
  assert.equal(restoredMemory.revisions[2].sourceTaskId, undefined);
});

test('memory archive remains inspectable and versioned, including the legacy DELETE endpoint', async (t) => {
  const { call, store } = await fixture(t);
  const memory = (
    await call('POST', '/api/memories', { content: 'Keep this history.' })
  ).json<Memory>();
  const archived = await call('DELETE', `/api/memories/${memory.id}`, { baseVersion: 1 });
  assert.equal(archived.statusCode, 200);
  assert.equal(archived.json().memory.status, 'archived');
  assert.equal(archived.json().memory.version, 2);
  assert.equal(store.get<Memory>('memories', memory.id)?.revisions?.length, 2);
  const snapshot = (await call('GET', '/api/state')).json<Snapshot>();
  assert.equal(snapshot.memories.find((item) => item.id === memory.id)?.status, 'archived');
  assert.equal(
    (await call('DELETE', `/api/memories/${memory.id}`, { baseVersion: 1 })).statusCode,
    409,
  );
});

test('owners can maintain orphaned historical records while new scope assignments stay validated', async (t) => {
  const { createMemory, createSkill, store, call, controller, actor, provenance } =
    await fixture(t);
  const memory = createMemory('History for a removed bot.');
  const skill = createSkill('removed-bot-procedure');
  store.remove('bots', 'bot_aster');
  for (const [kind, entry] of [
    ['memories', memory],
    ['skills', skill],
  ] as const) {
    assert.equal(
      (
        await call('PATCH', `/api/${kind}/${entry.id}`, {
          baseVersion: 1,
          botId: 'missing-bot',
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await call('PATCH', `/api/${kind}/${entry.id}`, {
          baseVersion: 1,
          status: 'archived',
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await call('POST', `/api/${kind}/${entry.id}/restore`, {
          baseVersion: 2,
          version: 1,
        })
      ).statusCode,
      200,
    );
  }
  assert.throws(
    () =>
      controller.updateMemory(memory.id, { content: 'Removed bot edit.', ...provenance }, 3, actor),
    { statusCode: 403 },
  );
});

test('restoring stored history preserves unavailable source links without accepting fresh invented sources', async (t) => {
  const { controller, createMemory, createSkill, task, store, call } = await fixture(t);
  const memory = createMemory('Earlier memory with an actual source.');
  const skill = createSkill('historical-source');
  const later = controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Later source task.',
  });
  controller.updateMemory(
    memory.id,
    {
      content: 'Later memory.',
      evidence: 'Later evidence.',
      sourceTaskId: later.id,
      status: 'archived',
      locked: true,
    },
    1,
  );
  controller.updateSkill(
    skill.id,
    {
      content: 'Later steps.',
      evidence: 'Later evidence.',
      sourceTaskId: later.id,
      status: 'archived',
      locked: true,
    },
    1,
  );
  store.remove('tasks', task.id);
  for (const [kind, entry] of [
    ['memories', memory],
    ['skills', skill],
  ] as const) {
    const fresh = await call('PATCH', `/api/${kind}/${entry.id}`, {
      baseVersion: 2,
      sourceTaskId: task.id,
    });
    assert.equal(fresh.statusCode, 404, 'new provenance must refer to an existing task');
    const restored = await call('POST', `/api/${kind}/${entry.id}/restore`, {
      baseVersion: 2,
      version: 1,
    });
    assert.equal(restored.statusCode, 200);
    const value = restored.json<Memory | Skill>();
    assert.equal(
      value.sourceTaskId,
      task.id,
      'historical provenance remains inspectable even if its task is unavailable',
    );
    assert.equal(value.content, entry.content);
    assert.equal(value.locked, true);
    assert.equal(value.status, 'archived');
    assert.equal(value.version, 3);
  }
});

test('memory merge atomically keeps one identity and archives source versions with provenance', async (t) => {
  const { controller, createMemory, actor, provenance, store } = await fixture(t);
  const target = createMemory('Prefers short ordinary replies.');
  const source = createMemory('Prefers detailed design explanations.');
  const result = normalizeMemory(
    controller.mergeMemories(
      {
        targetId: target.id,
        baseVersion: 1,
        sources: [{ id: source.id, baseVersion: 1 }],
        content: 'Use short ordinary replies and detailed design explanations.',
        ...provenance,
      },
      actor,
    ),
  );
  assert.equal(result.id, target.id);
  assert.equal(result.version, 2);
  assert.deepEqual(result.revisions[1].mergedFrom, [{ id: source.id, version: 1 }]);
  const archived = normalizeMemory(store.get<Memory>('memories', source.id)!);
  assert.equal(archived.status, 'archived');
  assert.equal(archived.version, 2);
  assert.equal(archived.revisions[0].content, source.content);
  assert.match(archived.revisions[1].reason, new RegExp(target.id));
  assert.deepEqual(archived.revisions[1].actor, actor);
});

test('a consolidated memory can refresh its evidence even when its content matches an archived source', async (t) => {
  const { controller, createMemory, actor, provenance } = await fixture(t);
  const target = createMemory('An older phrasing of the preference.');
  const source = createMemory('The final complete preference.');
  const merged = normalizeMemory(
    controller.mergeMemories(
      {
        targetId: target.id,
        baseVersion: 1,
        sources: [{ id: source.id, baseVersion: 1 }],
        content: source.content,
        ...provenance,
      },
      actor,
    ),
  );
  const confirmation = controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'The user confirmed the same preference.',
  });
  const confirmed = normalizeMemory(
    controller.updateMemory(
      merged.id,
      {
        reason: 'The user confirmed the preference again.',
        evidence: 'A later direct confirmation.',
        sourceTaskId: confirmation.id,
      },
      merged.version,
      actor,
    ),
  );
  assert.equal(confirmed.version, 3);
  assert.equal(confirmed.content, source.content);
  assert.equal(confirmed.sourceTaskId, confirmation.id);
  assert.equal(confirmed.revisions[2].evidence, 'A later direct confirmation.');
  const refreshed = normalizeMemory(
    controller.saveMemory(
      {
        botId: 'bot_aster',
        replacesId: merged.id,
        baseVersion: 3,
        content: source.content,
        ...provenance,
      },
      actor,
    ),
  );
  assert.equal(refreshed.version, 4);
  assert.equal(refreshed.id, target.id);
});

test('invalid, stale, fixed, and cross-scope merge sources make no partial change', async (t) => {
  const { controller, createMemory, actor, provenance, store } = await fixture(t);
  const target = createMemory('Merge target.');
  const source = createMemory('Merge source.');
  const fixed = normalizeMemory(
    controller.saveMemory({ botId: 'bot_aster', content: 'Owner fixed source.' }),
  );
  const scoped = createMemory('Room scoped source.', { roomId: 'room_lounge' });
  const before = store.list('memories');
  for (const sources of [
    [{ id: source.id, baseVersion: 2 }],
    [{ id: 'missing', baseVersion: 1 }],
    [{ id: target.id, baseVersion: 1 }],
    [
      { id: source.id, baseVersion: 1 },
      { id: source.id, baseVersion: 1 },
    ],
    [
      { id: source.id, baseVersion: 1 },
      { id: fixed.id, baseVersion: 1 },
    ],
    [{ id: scoped.id, baseVersion: 1 }],
  ]) {
    assert.throws(() =>
      controller.mergeMemories(
        {
          targetId: target.id,
          baseVersion: 1,
          sources,
          content: 'Combined.',
          ...provenance,
        },
        actor,
      ),
    );
    assert.deepEqual(store.list('memories'), before);
  }
});

test('a persistence failure rolls back every part of a memory merge', async (t) => {
  const { controller, createMemory, actor, provenance, store } = await fixture(t);
  const target = createMemory('Atomic target.');
  const source = createMemory('Atomic source.');
  const before = store.list('memories');
  const put = store.put.bind(store);
  let writes = 0;
  store.put = (kind, value) => {
    if (kind === 'memories' && ++writes === 2) throw new Error('Controlled persistence failure.');
    return put(kind, value);
  };
  try {
    assert.throws(
      () =>
        controller.mergeMemories(
          {
            targetId: target.id,
            baseVersion: 1,
            sources: [{ id: source.id, baseVersion: 1 }],
            content: 'Combined atomic fact.',
            ...provenance,
          },
          actor,
        ),
      /Controlled persistence failure/,
    );
  } finally {
    store.put = put;
  }
  assert.deepEqual(store.list('memories'), before);
});

test('legacy normalization does not mutate storage and preserves candidates and complete prior content', async (t) => {
  const { store, controller, provenance, actor } = await fixture(t);
  const stamp = new Date().toISOString();
  const memory: Memory = {
    id: 'memory_legacy',
    botId: 'bot_aster',
    content: 'Legacy fact.',
    sourceTaskId: provenance.sourceTaskId,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const skill: Skill = {
    id: 'skill_legacy',
    name: 'legacy-candidate',
    description: 'Existing candidate.',
    content: 'Legacy instructions.',
    botId: 'bot_aster',
    status: 'candidate',
    version: 1,
    revisions: [
      {
        version: 1,
        content: 'Legacy instructions.',
        reason: 'Proposed after a task',
        createdAt: stamp,
      } as Skill['revisions'][number],
    ],
    sourceTaskId: provenance.sourceTaskId,
    evidence: 'Original evidence.',
    useCount: 0,
    createdAt: stamp,
    updatedAt: stamp,
  };
  store.put('memories', memory);
  store.put('skills', skill);
  const normalized = controller.getSnapshot();
  assert.equal(normalized.memories[0].locked, false, 'legacy memory editability is preserved');
  assert.equal(normalized.memories[0].version, 1);
  assert.equal(
    normalized.skills[0].status,
    'candidate',
    'existing candidates are not silently activated',
  );
  assert.equal(
    normalized.skills[0].locked,
    false,
    'clear untouched bot history remains updatable after owner activation',
  );
  assert.deepEqual(store.get('memories', memory.id), memory);
  assert.deepEqual(store.get('skills', skill.id), skill);
  const changed = normalizeMemory(
    controller.updateMemory(
      memory.id,
      { content: 'Updated legacy fact.', ...provenance },
      1,
      actor,
    ),
  );
  assert.equal(changed.revisions[0].content, memory.content);
  assert.equal(changed.revisions[0].version, 1);
  const activated = controller.updateSkill(skill.id, { status: 'active', locked: false }, 1);
  assert.equal(
    activated.revisions[0].description,
    skill.description,
    'missing legacy revision fields are completed before editing',
  );
  assert.equal(activated.revisions[0].name, skill.name);
  assert.equal(activated.revisions[0].evidence, skill.evidence);
  const manuallyEdited = {
    ...skill,
    revisions: [{ ...skill.revisions[0], reason: 'Edited by the user' }],
  };
  assert.equal(normalizeSkill(manuallyEdited).locked, true);
  assert.equal(normalizeSkill({ ...skill, sourceTaskId: undefined }).locked, true);
});
