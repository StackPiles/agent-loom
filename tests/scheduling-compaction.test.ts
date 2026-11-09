import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../src/server/app.js';
import type { Task } from '../src/shared/types.js';

async function until(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await delay(10);
  }
}

test(
  'real Pi summaries share the task grant and expose the active blocker without preemption',
  { timeout: 40_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'loom-scheduling-compaction-'));
    const f = await createApp({ dataDir: directory, scheduler: false });
    const requests: Array<{
      body: {
        messages: Array<{ role: string; content: unknown }>;
        tools?: unknown[];
        max_tokens?: number;
      };
      response: ServerResponse;
      finish(text: string, inputTokens?: number): void;
    }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const requestId = `summary-${requests.length}`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      requests.push({
        body,
        response,
        finish(text, inputTokens = 100) {
          if (response.writableEnded || response.destroyed) return;
          const base = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: 1,
            model: 'summary-fixture',
          };
          for (const [delta, finishReason] of [
            [{ role: 'assistant', content: text }, null],
            [{}, 'stop'],
          ] as const)
            response.write(
              `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
            );
          response.write(
            `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: 20, total_tokens: inputTokens + 20 } })}\n\n`,
          );
          response.end('data: [DONE]\n\n');
        },
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await f.app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const saved = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        model: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          modelId: 'summary-fixture',
          contextWindow: 32_768,
          maxOutputTokens: 1_024,
        },
        inference: { maxConcurrentRequests: 1 },
        autoLearn: false,
      },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const room = await f.app.inject({
      method: 'PATCH',
      url: '/api/rooms/room_lounge',
      payload: { parallelResponses: true },
    });
    assert.equal(room.statusCode, 200, room.body);
    const finished = (task: Task) => f.store.get<Task>('tasks', task.id)?.status === 'completed';
    const start = (prompt: string, botId = 'bot_aster') =>
      f.controller.enqueueTask({ roomId: 'room_lounge', botId, prompt });

    // Persist an actual earlier Pi turn so automatic compaction has history to summarize.
    const seed = start('Remember the completed setup for the later review.');
    await until(() => requests.length === 1, 'initial conversation request');
    requests[0].finish('Completed setup and verified its result. '.repeat(1_000));
    await until(() => finished(seed), 'initial conversation persisted');

    const task = start('Review the earlier setup and report the remaining work.');
    const grant = f.controller.prioritizeTask(task.id).grant!;
    await until(() => requests.length === 2, 'review request');
    assert.equal(f.controller.getTaskScheduling(task.id).grant?.remainingRequests, 2);
    requests[1].finish('The review is complete.', 30_000);
    await until(() => requests.length === 3, 'automatic Pi summary request');
    const summary = requests[2];
    assert.equal(
      summary.body.tools?.length ?? 0,
      0,
      'This is the real summary request, not a normal response',
    );
    assert.equal(summary.body.max_tokens, 1_024, 'The configured model output budget is preserved');
    const summarizing = f.controller
      .getSnapshot()
      .queue.scheduling?.find((entry) => entry.taskId === task.id);
    assert.equal(summarizing?.purpose, 'compaction');
    assert.equal(summarizing?.grant?.id, grant.id);
    assert.equal(
      summarizing?.grant?.remainingRequests,
      1,
      'Response and summary consumed the same allowance',
    );

    const urgent = start('Respond to the newly arrived urgent request.', 'bot_nova');
    f.controller.prioritizeTask(urgent.id);
    await until(
      () =>
        f.controller
          .getSnapshot()
          .queue.waitingTasks?.some((entry) => entry.taskId === urgent.id) === true,
      'urgent work queued',
    );
    const waiting = f.controller
      .getSnapshot()
      .queue.scheduling?.find((entry) => entry.taskId === urgent.id);
    assert.equal(waiting?.blockingTaskId, task.id);
    assert.equal(requests.length, 3, 'Priority does not interrupt an issued summary');
    assert.equal(summary.response.destroyed, false);

    summary.finish('The prior setup was completed and reviewed.');
    await until(() => requests.length >= 4, 'another work group admitted after the summary');
    const next = requests[3];
    assert.match(JSON.stringify(next.body.messages), /newly arrived urgent request/);
    assert.equal(
      f.controller.getTaskScheduling(urgent.id).grant?.remainingRequests,
      3,
      'The ordinary fair turn after two priority admissions does not spend the next job’s grant',
    );
    next.finish('The urgent request is complete.');
    await until(() => finished(urgent), 'urgent request completed');
    // Pi may split a large retained turn into a second summary; it must use the same path.
    const settleDeadline = Date.now() + 12_000;
    while (!finished(task)) {
      assert.ok(Date.now() < settleDeadline, 'Pi compaction should settle');
      for (const request of requests.slice(4))
        request.finish('All prior context has been retained in the checkpoint.');
      await delay(10);
    }
    const activity = f.controller
      .getSnapshot()
      .activities.find(
        (entry) => entry.taskId === task.id && entry.title === 'Session context summarized',
      );
    assert.equal(activity?.status, 'success');
    assert.equal(f.controller.getSnapshot().queue.active, 0);
  },
);
