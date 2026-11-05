import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createBrowserManager } from '../src/server/browser-manager.js';
import {
  createBrowserControl,
  type BrowserCommand,
  type BrowserPeer,
  type BrowserPeerOptions,
} from '../src/server/browser.js';
import { DEFAULT_BROWSER_SETTINGS } from '../src/shared/browser.js';
import type { Bot } from '../src/shared/types.js';

/** Keep the real browser adapter's page/state checks; replace only the MCP transport. */
class Peer implements BrowserPeer {
  closed = 0;
  calls: string[] = [];
  constructor(readonly options: BrowserPeerOptions) {}
  async callTool(name: string, _args: Record<string, unknown>, signal: AbortSignal) {
    signal.throwIfAborted();
    this.calls.push(name);
    if (name === 'list_pages')
      return {
        content: [],
        structuredContent: {
          pages: [{ id: 1, url: 'https://example.test/draft', title: 'Draft' }],
        },
      };
    if (name === 'take_snapshot')
      return {
        content: [],
        structuredContent: {
          snapshot: {
            id: '1_0',
            role: 'RootWebArea',
            name: 'Draft',
            children: [{ id: '1_1', role: 'button', name: 'Save draft' }],
          },
        },
      };
    return { content: [{ type: 'text', text: `${name} completed` }] };
  }
  async close() {
    this.closed++;
  }
}

async function until(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.ok(predicate(), message);
}

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-browser-task-residency-'));
  const bots = new Map<string, Bot>(
    ['alpha', 'beta'].map((id) => [
      id,
      {
        id,
        name: id,
        handle: id,
        role: 'Write a draft',
        systemPrompt: 'Test bot.',
        color: '#123456',
        avatar: 'character:aster',
        enabled: true,
        browser: { mode: 'dedicated' },
        createdAt: '2026-11-05T00:00:00.000Z',
      },
    ]),
  );
  const peers: Peer[] = [];
  const manager = createBrowserManager({
    dataDir,
    getSettings: () => ({
      ...DEFAULT_BROWSER_SETTINGS,
      enabled: true,
      permission: 'allow',
      maxConcurrentBrowsers: 1,
    }),
    getBot: (id) => bots.get(id),
    onChange() {},
    controlFactory: (options) =>
      createBrowserControl({
        ...options,
        peerFactory: async (peerOptions) => {
          const peer = new Peer(peerOptions);
          peers.push(peer);
          return peer;
        },
      }),
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  });
  const run = async (
    botId: string,
    taskId: string,
    command: BrowserCommand,
    signal: AbortSignal,
  ) => {
    const browser = await manager.forTask(botId, taskId, signal);
    return browser.execute(browser.prepare(command), AbortSignal.any([signal, browser.signal]));
  };
  return { manager, peers, run };
}

test(
  'a task keeps its browser between observation and action while another bot waits for capacity',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t);
    const alphaSignal = new AbortController().signal;
    const betaSignal = new AbortController().signal;
    await f.run('alpha', 'task-a', { operation: 'tabs' }, alphaSignal);
    const snapshot = await f.run(
      'alpha',
      'task-a',
      { operation: 'snapshot', pageId: 1 },
      alphaSignal,
    );
    const stateId = /State ID: ([a-f0-9-]+)/.exec(snapshot.text)![1];
    const alphaPeer = f.peers[0];

    // No browser operation or approval is active here: the model is deciding its next action.
    const beta = f.manager.forTask('beta', 'task-b', betaSignal);
    await until(
      () => f.manager.botStatus('beta').waiting === true,
      'The next bot must wait while the earlier task still owns its browser.',
    );
    assert.equal(alphaPeer.closed, 0);
    assert.equal(f.peers.length, 1);
    await f.run(
      'alpha',
      'task-a',
      { operation: 'click', pageId: 1, uid: '1_1', stateId },
      alphaSignal,
    );
    assert.equal(
      alphaPeer.calls.filter((name) => name === 'click').length,
      1,
      'The original observed page remains actionable after the reasoning gap.',
    );
    assert.equal(alphaPeer.closed, 0);

    f.manager.releaseTask('task-a');
    const betaBrowser = await beta;
    await betaBrowser.execute(betaBrowser.prepare({ operation: 'tabs' }), betaSignal);
    assert.equal(alphaPeer.closed, 1, 'The completed task can now yield its idle browser slot.');
    assert.equal(f.peers.length, 2);
    assert.equal(f.manager.status().pool!.active, 1);
    f.manager.releaseTask('task-b');
  },
);

test(
  'repeated and concurrent calls for one task share one lease and task cancellation releases it',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t);
    const alpha = new AbortController();
    const [first, second] = await Promise.all([
      f.manager.forTask('alpha', 'task-a', alpha.signal),
      f.manager.forTask('alpha', 'task-a', alpha.signal),
    ]);
    assert.equal(first, second);
    await f.run('alpha', 'task-a', { operation: 'tabs' }, alpha.signal);
    const beta = f.manager.forTask('beta', 'task-b', new AbortController().signal);
    await until(
      () => f.manager.botStatus('beta').waiting === true,
      'Another task must wait for the occupied slot.',
    );
    alpha.abort();
    const betaBrowser = await beta;
    await betaBrowser.execute(
      betaBrowser.prepare({ operation: 'tabs' }),
      new AbortController().signal,
    );
    assert.equal(
      f.peers[0].closed,
      1,
      'Cancellation must release every reference to the task lease.',
    );
    f.manager.releaseTask('task-a');
    f.manager.releaseTask('task-a');
    assert.equal(
      f.manager.status().pool!.active,
      1,
      'Late repeated cleanup must not release the new resident.',
    );
    f.manager.releaseTask('task-b');
  },
);

test(
  'cancelled capacity requests do not leak, and an explicit disconnect releases the owning task',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t);
    const alphaSignal = new AbortController().signal;
    const alpha = await f.manager.forTask('alpha', 'task-a', alphaSignal);
    await f.run('alpha', 'task-a', { operation: 'tabs' }, alphaSignal);
    const cancelled = new AbortController();
    const rejected = assert.rejects(
      f.manager.forTask('beta', 'cancelled-task', cancelled.signal),
      /stopped|aborted|cancelled/i,
    );
    await until(
      () => f.manager.botStatus('beta').waiting === true,
      'The second bot must be waiting.',
    );
    cancelled.abort();
    await rejected;
    assert.equal(f.manager.status().pool!.waiting, 0);

    const beta = f.manager.forTask('beta', 'next-task', new AbortController().signal);
    await until(
      () => f.manager.botStatus('beta').waiting === true,
      'A fresh task should wait independently.',
    );
    await f.manager.disconnectBot('alpha');
    assert.equal(alpha.signal.aborted, true);
    const betaBrowser = await beta;
    await betaBrowser.execute(
      betaBrowser.prepare({ operation: 'tabs' }),
      new AbortController().signal,
    );
    assert.equal(f.peers[0].closed, 1);
    assert.equal(f.manager.status().pool!.waiting, 0);
    assert.equal(f.manager.status().pool!.active, 1);
    f.manager.releaseTask('task-a');
    f.manager.releaseTask('next-task');
  },
);
