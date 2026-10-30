import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { SettingsManager, shouldCompact } from '@earendil-works/pi-coding-agent';
import { createApp } from '../src/server/app.js';
import type { Task } from '../src/shared/types.js';

test(
  'large token budgets persist exactly and real Pi sends every newly supported output limit',
  { timeout: 45_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'loom-token-budgets-'));
    const f = await createApp({ dataDir: directory, scheduler: false });
    t.after(async () => {
      await f.app.close();
      await rm(directory, { recursive: true, force: true });
    });
    const originalSettings = SettingsManager.inMemory;
    const createdSettings: SettingsManager[] = [];
    t.mock.method(
      SettingsManager,
      'inMemory',
      (settings: Parameters<typeof originalSettings>[0]) => {
        const manager = originalSettings(settings);
        createdSettings.push(manager);
        return manager;
      },
    );
    const requests: Array<{ path?: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push({ path: request.url, body });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finishReason] of [
        [{ content: 'Token budget received.' }, null],
        [{}, 'stop'],
      ] as const) {
        response.write(
          `data: ${JSON.stringify({ id: `tokens-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'token-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
        );
      }
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const save = (payload: object) =>
      f.app.inject({ method: 'PUT', url: '/api/settings', payload });

    for (const [contextWindow, maxOutputTokens] of [
      [2 ** 19, 2 ** 18],
      [2 ** 20, 2 ** 19],
      [2 ** 21, 2 ** 20],
    ]) {
      const saved = await save({
        model: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          modelId: 'token-fixture',
          contextWindow,
          maxOutputTokens,
        },
        autoLearn: false,
      });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(saved.json().model.contextWindow, contextWindow);
      assert.equal(saved.json().model.maxOutputTokens, maxOutputTokens);
      assert.equal(f.store.settings().model.contextWindow, contextWindow);
      assert.equal(f.store.settings().model.maxOutputTokens, maxOutputTokens);
      const before = requests.length;
      const task = f.controller.enqueueTask({
        roomId: 'room_lounge',
        botId: 'bot_aster',
        prompt: `Confirm output limit ${maxOutputTokens}.`,
      });
      const deadline = Date.now() + 12_000;
      while (!['completed', 'failed'].includes(f.store.get<Task>('tasks', task.id)!.status)) {
        if (Date.now() > deadline)
          throw new Error('Timed out waiting for the token budget fixture.');
        await delay(10);
      }
      const finished = f.store.get<Task>('tasks', task.id)!;
      assert.equal(finished.status, 'completed', finished.error);
      assert.equal(requests.length, before + 1);
      assert.equal(requests.at(-1)?.path, '/v1/chat/completions');
      assert.equal(requests.at(-1)?.body.max_tokens, maxOutputTokens);
      const compaction = createdSettings.at(-1)?.getCompactionSettings();
      assert.ok(compaction, 'Use the settings actually supplied to the real agent session');
      assert.equal(
        shouldCompact(contextWindow - maxOutputTokens - 1, contextWindow, compaction),
        true,
        'Compact before history takes space reserved for the configured output',
      );
      assert.equal(
        shouldCompact(contextWindow - maxOutputTokens - 8_192, contextWindow, compaction),
        false,
        'Retain history while there is still room for output and safety overhead',
      );
    }

    const baseline = f.store.settings();
    for (const model of [
      { maxOutputTokens: 2 ** 20 + 1 },
      { contextWindow: 2 ** 21 + 1 },
      { contextWindow: 2 ** 20, maxOutputTokens: 2 ** 20 },
    ]) {
      const rejected = await save({ model });
      assert.equal(rejected.statusCode, 400, rejected.body);
      assert.deepEqual(f.store.settings(), baseline, 'An invalid budget must not partially save');
    }
  },
);
