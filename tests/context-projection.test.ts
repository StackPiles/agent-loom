import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  toToolDeclaration,
  type AssistantMessage,
  type Message,
  type Model,
} from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import {
  buildSessionProjection,
  convertToLlm,
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from '@sinclair/typebox';
import { projectUpcomingSessionContext } from '../src/server/runtime/context-projection.js';

function tool(name: string, description: string, parameters: TSchema): ToolDefinition {
  return {
    name,
    label: name,
    description,
    parameters,
    async execute() {
      throw new Error('A measurement or history replay must not execute a tool.');
    },
  };
}

function sessionView(systemPrompt: string, tools: ToolDefinition[]) {
  return {
    systemPrompt,
    getActiveToolNames: () => tools.map((definition) => definition.name),
    getToolDefinition: (name: string) => tools.find((definition) => definition.name === name),
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}

test('upcoming projection replaces old prompt sections, retains raw instructions and does not mutate its source', () => {
  const definition = tool(
    'inspect',
    'Inspect the current item.',
    Type.Object({ id: Type.String() }),
  );
  const owner: Message = {
    role: 'user',
    content: [
      { type: 'text', text: 'Preserve this pending owner instruction.' },
      { type: 'image', data: 'image-fixture', mimeType: 'image/png' },
    ],
    timestamp: 3,
  };
  const messages = freeze<Message[]>([
    {
      role: 'system',
      content: 'Legacy raw instruction.',
      sections: { preamble: 'Obsolete prompt.', room: 'Obsolete room context.' },
      toolsAdded: [toToolDeclaration(definition)],
      timestamp: 1,
    },
    {
      role: 'system',
      content: [{ type: 'text', text: 'Later raw instruction.' }],
      sections: { room: 'Updated but still old room context.' },
      timestamp: 2,
    },
    owner,
  ]);
  const original = structuredClone(messages);
  const session = freeze(
    sessionView('The current full prompt with updated memory and room context.', [definition]),
  );
  const projection = projectUpcomingSessionContext(session, messages);
  assert.equal(projection.messages.filter((message) => message.role === 'system').length, 1);
  assert.equal(
    getCurrentSystemPrompt(projection.messages),
    'Legacy raw instruction.\n\nLater raw instruction.\n\n' + session.systemPrompt,
  );
  assert.doesNotMatch(getCurrentSystemPrompt(projection.messages), /Obsolete|still old/);
  assert.deepEqual(getCurrentTools(projection.messages), [toToolDeclaration(definition)]);
  assert.equal(projection.messages[1], owner, 'owner content and image pixels remain unchanged');
  assert.deepEqual(messages, original);
  assert.equal(
    session.systemPrompt,
    'The current full prompt with updated memory and room context.',
  );
});

test('fresh sessions include the latest loadout once and missing active definitions fail explicitly', () => {
  const definition = tool('finish', 'Finish an item.', Type.Object({ id: Type.String() }));
  const projected = projectUpcomingSessionContext(sessionView('Current prompt.', [definition]), []);
  assert.equal(getCurrentSystemPrompt(projected.messages), 'Current prompt.');
  assert.deepEqual(getCurrentTools(projected.messages), [toToolDeclaration(definition)]);
  assert.equal(projected.messages.length, 1);
  assert.throws(
    () =>
      projectUpcomingSessionContext(
        {
          systemPrompt: 'Current prompt.',
          getActiveToolNames: () => ['missing'],
          getToolDefinition: () => undefined,
        },
        [],
      ),
    /active tool definition is missing/,
  );
});

test('an unchanged preview preserves valid usage while prompt, tool and later prefix changes invalidate it', () => {
  const definition = tool('inspect', 'Inspect an item.', Type.Object({ id: Type.String() }));
  const response: AssistantMessage = {
    role: 'assistant',
    api: 'openai-completions',
    provider: 'loom-local',
    model: 'fixture',
    content: [{ type: 'text', text: 'OK' }],
    stopReason: 'stop',
    timestamp: 3,
    usage: {
      input: 15_000,
      output: 110_020,
      reasoning: 110_000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 125_020,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const messages = freeze<Message[]>([
    {
      role: 'system',
      content: '',
      sections: { preamble: 'Current prompt.' },
      toolsAdded: [toToolDeclaration(definition)],
      timestamp: 1,
    },
    { role: 'user', content: 'Start.', timestamp: 2 },
    response,
  ]);
  const session = sessionView('Current prompt.', [definition]);
  const unchanged = projectUpcomingSessionContext(session, messages);
  assert.equal(estimateContextTokens(unchanged).lastUsageIndex, 2);
  assert.equal(estimateContextTokens(unchanged).tokens, 125_020);
  const changedPrompt = projectUpcomingSessionContext(
    sessionView('Updated prompt.', [definition]),
    messages,
  );
  assert.equal(estimateContextTokens(changedPrompt).lastUsageIndex, null);
  const changedTool = projectUpcomingSessionContext(
    sessionView('Current prompt.', [
      tool('inspect', 'Inspect a new schema.', Type.Object({ next: Type.Number() })),
    ]),
    messages,
  );
  assert.equal(estimateContextTokens(changedTool).lastUsageIndex, null);
  const laterDelta = projectUpcomingSessionContext(session, [
    ...messages,
    { role: 'system', content: '', sections: { preamble: 'Current prompt.' }, timestamp: 4 },
  ]);
  assert.equal(estimateContextTokens(laterDelta).lastUsageIndex, null);
  assert.equal(response.usage.totalTokens, 125_020);
});

function resources(prompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => prompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function assistant(model: Model<'openai-completions'>): AssistantMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'historical-call', name: 'archive', arguments: { id: 'op-17' } },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: 'toolUse',
    timestamp: 3,
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

test('projection matches the next real AgentSession payload after prompt and tool changes, including old receipts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-context-projection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(directory, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider('loom-local', {
    api: 'openai-completions',
    baseUrl: 'https://fixture.invalid/v1',
    models: [
      {
        id: 'projection-fixture',
        name: 'Projection fixture',
        api: 'openai-completions',
        input: ['text'],
        reasoning: false,
        contextWindow: 32_768,
        maxTokens: 2_048,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsMidConvoSystemMessages: false, supportsStrictMode: false },
      },
    ],
  });
  await runtime.setRuntimeApiKey('loom-local', 'test-only');
  const selected = runtime.getModel(
    'loom-local',
    'projection-fixture',
  )! as Model<'openai-completions'>;
  const inspectOld = tool('inspect', 'Inspect an old schema.', Type.Object({ old: Type.String() }));
  const inspectNew = tool(
    'inspect',
    'Inspect the current schema.',
    Type.Object({ id: Type.String(), revision: Type.Number() }),
  );
  const stable = tool('stable', 'An unchanged tool.', Type.Object({}));
  const archive = tool('archive', 'An obsolete tool.', Type.Object({ id: Type.String() }));
  const added = tool('added', 'A newly available tool.', Type.Object({ path: Type.String() }));
  const manager = SessionManager.inMemory(directory);
  manager.appendMessage({
    role: 'system',
    content: 'Legacy raw safety instruction.',
    sections: { preamble: 'Old bot prompt and old memory.', cwd: `<cwd>\n${directory}\n</cwd>` },
    toolsAdded: [inspectOld, stable, archive].map(toToolDeclaration),
    timestamp: 1,
  });
  manager.appendMessage({ role: 'user', content: 'Archive the old item.', timestamp: 2 });
  manager.appendMessage(assistant(selected));
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'historical-call',
    toolName: 'archive',
    content: [{ type: 'text', text: 'Receipt op-17: completed; never repeat this action.' }],
    isError: false,
    timestamp: 4,
  });
  manager.appendMessage({ role: 'system', content: 'Keep the explicit receipt.', timestamp: 5 });
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    model: selected,
    modelRuntime: runtime,
    thinkingLevel: 'off',
    noTools: 'builtin',
    tools: ['added', 'inspect', 'stable'],
    customTools: [added, inspectNew, stable],
    resourceLoader: resources(
      'New bot prompt with updated memory, mail context, and room instructions.',
    ),
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      cacheWarming: 'off',
      defaultProjectTrust: 'never',
      enableInstallTelemetry: false,
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0 },
    }),
  });
  t.after(() => session.dispose());
  session.setActiveToolsByName(['added', 'inspect', 'stable']);

  const prompt = 'Continue from receipt op-17 under the new instructions.';
  const priorBranch = structuredClone(manager.getBranch());
  const projection = projectUpcomingSessionContext(session, [
    ...convertToLlm(buildSessionProjection(manager.getBranch()).messages),
    { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() },
  ]);
  assert.deepEqual(
    manager.getBranch(),
    priorBranch,
    'measurement must not append prompt/tool entries',
  );
  const payloads: Array<Record<string, unknown>> = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init!.body as string) as Record<string, unknown>);
    return new Response(
      `data: ${JSON.stringify({ id: 'projection-fixture', choices: [{ index: 0, delta: { content: 'Checked.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  session.agent.streamFunction = (_model, context, options) =>
    stream(selected, context, { ...options, apiKey: 'test-only', fetch, maxRetries: 0 });
  await session.prompt(prompt);
  assert.equal(payloads.length, 1);
  const actual = payloads[0];
  const projectedResponse = stream(selected, projection, {
    apiKey: 'test-only',
    fetch,
    maxRetries: 0,
  });
  assert.equal((await projectedResponse.result()).stopReason, 'stop');
  assert.equal(payloads.length, 2);
  const preview = payloads[1];
  assert.deepEqual(preview.messages, actual.messages);
  assert.deepEqual(preview.tools, actual.tools);
  assert.doesNotMatch(JSON.stringify(preview.tools), /obsolete tool|old schema/);
  assert.match(JSON.stringify(preview.messages), /Receipt op-17: completed/);
  assert.match(JSON.stringify(preview.messages), /historical-call/);
  assert.doesNotMatch(JSON.stringify(preview.messages), /Old bot prompt and old memory/);
  assert.deepEqual(
    getCurrentTools(projection.messages).map((definition) => definition.name),
    ['stable', 'added', 'inspect'],
  );
});
