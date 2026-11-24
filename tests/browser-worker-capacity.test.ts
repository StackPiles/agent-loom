import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../src/server/app.js';
import { createBrowserControl, type BrowserPeer } from '../src/server/browser.js';
import type { ToolContext } from '../src/server/runtime/contract.js';
import { RoomTaskScheduler } from '../src/server/runtime/pause.js';
import { WorkSchedulingLedger } from '../src/server/runtime/scheduling.js';
import { createTools } from '../src/server/runtime/tools.js';
import { DEFAULT_BROWSER_SETTINGS } from '../src/shared/browser.js';

class Peer implements BrowserPeer {
  closed = 0;
  readonly calls: string[] = [];
  async callTool(name: string, _args: Record<string, unknown>, signal: AbortSignal) {
    signal.throwIfAborted();
    this.calls.push(name);
    if (name === 'list_pages')
      return {
        content: [],
        structuredContent: {
          pages: [{ id: 1, url: 'https://example.test/login', title: 'Login' }],
        },
      };
    if (name === 'take_snapshot')
      return {
        content: [],
        structuredContent: {
          snapshot: {
            id: '1_0',
            role: 'RootWebArea',
            name: 'Login',
            children: [{ id: '1_1', role: 'button', name: 'Sign in' }],
          },
        },
      };
    return { content: [{ type: 'text', text: `${name} completed` }] };
  }
  async close() {
    this.closed++;
  }
}

test(
  'one worker and one Chrome slot preserve the lent workflow while browser waiters return their workers',
  { timeout: 10_000 },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'loom-browser-worker-capacity-'));
    const peers: Peer[] = [];
    const f = await createApp({
      dataDir,
      scheduler: false,
      runtimeFactory: () => ({
        start() {},
        async stop() {},
        async shutdown() {},
        queueState: () => ({ active: 0, waiting: 0 }),
      }),
      browserFactory: (options) =>
        createBrowserControl({
          ...options,
          peerFactory: async () => {
            const peer = new Peer();
            peers.push(peer);
            return peer;
          },
        }),
    });
    const scheduling = new WorkSchedulingLedger();
    const suspensions: Array<{ taskId: string; reason: string }> = [];
    const workers = new RoomTaskScheduler({
      capacity: 1,
      scheduling,
      onSuspend: (taskId, reason) => {
        suspensions.push({ taskId, reason });
        if (reason === 'paused') f.browser.releaseTask(taskId);
      },
    });
    f.store.put('settings', {
      ...f.store.settings(),
      id: 'main',
      demoMode: true,
      autoLearn: false,
      browser: {
        ...DEFAULT_BROWSER_SETTINGS,
        enabled: true,
        permission: 'allow',
        maxConcurrentBrowsers: 1,
      },
    });
    const make = (botId: string) => {
      const task = f.controller.enqueueTask({
        botId,
        roomId: 'room_lounge',
        prompt: 'Inspect the sign-in workflow.',
      });
      const abort = new AbortController();
      const context: ToolContext = {
        host: f.controller,
        task,
        settings: f.store.settings(),
        signal: abort.signal,
        operationKeys: new Set(),
        waitForRoom: async (signal) => {
          await workers.checkpoint(task.id, signal);
          scheduling.clearWaiting(task.id);
        },
        roomPauseSignal: () => workers.pauseSignal(task.roomId),
        acquireCapacity: (signal, acquire) => workers.acquireCapacity(task.id, signal, acquire),
      };
      return { task, abort, tools: createTools(context) };
    };
    const alpha = make('bot_aster');
    const beta = make('bot_nova');
    t.after(async () => {
      for (const run of [alpha, beta]) {
        run.abort.abort();
        workers.finish(run.task.id);
      }
      await f.app.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    assert.equal(workers.tryStart(alpha.task.id, alpha.task.roomId), true);
    await alpha.tools.invoke('browser_use', { operation: 'tabs' });
    const observed = await alpha.tools.invoke('browser_use', { operation: 'snapshot', pageId: 1 });
    const stateId = /State ID: ([a-f0-9-]+)/.exec(observed)![1];
    const alphaPeer = peers[0];

    // An ordinary approval/inference rebalance lends the worker, not the form.
    workers.lend(alpha.task.id);
    assert.equal(workers.isRoomPaused(alpha.task.roomId), false);
    assert.equal(
      f.browser.hasTaskReservation(alpha.task.id, alpha.task.botId, alpha.task.roomId),
      true,
    );
    assert.equal(workers.tryStart(beta.task.id, beta.task.roomId), true);
    let betaFinished = false;
    const betaAction = beta.tools.invoke('browser_use', { operation: 'tabs' }).then((result) => {
      betaFinished = true;
      return result;
    });
    void betaAction.catch(() => {});
    for (let attempt = 0; attempt < 200 && !workers.isSuspended(beta.task.id); attempt++)
      await delay(5);
    assert.equal(workers.isSuspended(beta.task.id), true, 'Chrome wait lends the occupied worker');
    assert.equal(workers.activeCount, 0);
    assert.equal(f.browser.botStatus(beta.task.botId, beta.task.roomId).waiting, true);
    assert.equal(alphaPeer.closed, 0, 'worker rebalance does not evict an unfinished login');

    await alpha.tools.invoke('browser_use', {
      operation: 'click',
      pageId: 1,
      uid: '1_1',
      stateId,
    });
    assert.equal(alphaPeer.calls.filter((name) => name === 'click').length, 1);
    assert.equal(alphaPeer.closed, 0);
    assert.equal(betaFinished, false);

    await alpha.tools.invoke('browser_release', { reason: 'The browser workflow completed.' });
    await nextTurn();
    assert.equal(betaFinished, false, 'a Chrome grant alone cannot run without a task worker');
    assert.equal(
      f.browser.hasTaskReservation(beta.task.id, beta.task.botId, beta.task.roomId),
      false,
    );
    workers.finish(alpha.task.id);
    await betaAction;
    assert.equal(betaFinished, true);
    assert.equal(alphaPeer.closed, 1);
    assert.equal(peers.length, 2);
    assert.equal(workers.activeCount, 1);
    assert.ok(
      suspensions.some((item) => item.taskId === alpha.task.id && item.reason === 'worker'),
    );
    assert.ok(suspensions.some((item) => item.taskId === beta.task.id && item.reason === 'worker'));
  },
);
