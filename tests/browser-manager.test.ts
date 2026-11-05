import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createBrowserManager } from '../src/server/browser-manager.js';
import {
  createBrowserControl,
  chromeLaunchOptions,
  type BrowserCommand,
  type BrowserPeerOptions,
  type BrowserPeer,
} from '../src/server/browser.js';
import { DEFAULT_BROWSER_SETTINGS } from '../src/shared/browser.js';
import type { Bot, BrowserSettings } from '../src/shared/types.js';

class Peer implements BrowserPeer {
  closed = 0;
  active = 0;
  maximum = 0;
  calls: string[] = [];
  beforeCall?: (name: string, signal: AbortSignal) => Promise<void>;
  constructor(readonly options: BrowserPeerOptions) {}
  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    this.calls.push(name);
    this.maximum = Math.max(this.maximum, ++this.active);
    try {
      await this.beforeCall?.(name, signal);
      signal.throwIfAborted();
      if (name === 'list_pages')
        return {
          content: [],
          structuredContent: {
            pages: [{ id: 1, url: 'https://example.test/work', title: 'Work' }],
          },
        };
      if (name === 'take_snapshot')
        return {
          content: [],
          structuredContent: {
            snapshot: {
              id: '1_0',
              role: 'RootWebArea',
              name: 'Work',
              children: [{ id: '1_1', role: 'button', name: 'Submit' }],
            },
          },
        };
      return { content: [{ type: 'text', text: `${name} completed ${args.pageId ?? ''}` }] };
    } finally {
      this.active--;
    }
  }
  async close() {
    this.closed++;
  }
}

async function until(predicate: () => boolean) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.ok(predicate(), 'Expected asynchronous browser state');
}

function blocked() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    wait: async (signal: AbortSignal) => {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(new Error('cancelled'));
          else
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
      ]);
    },
  };
}

async function fixture(t: TestContext, limit = 3) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-browser-manager-'));
  const settings: BrowserSettings = {
    ...DEFAULT_BROWSER_SETTINGS,
    enabled: true,
    permission: 'allow',
    maxConcurrentBrowsers: limit,
  };
  const bots = new Map<string, Bot>();
  for (const [id, mode] of [
    ['alpha', 'dedicated'],
    ['beta', 'dedicated'],
    ['legacy', undefined],
    ['shared', 'shared'],
    ['off', 'disabled'],
  ] as const) {
    bots.set(id, {
      id,
      name: id,
      handle: id,
      role: '',
      systemPrompt: 'Work',
      color: '#123456',
      avatar: 'character:aster',
      enabled: true,
      createdAt: '2026-01-01',
      ...(mode ? { browser: { mode } } : {}),
    });
  }
  const peers: Peer[] = [];
  const manager = createBrowserManager({
    dataDir,
    getSettings: () => settings,
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
    id: string,
    command: BrowserCommand,
    signal = new AbortController().signal,
  ) => {
    const handle = manager.forBot(id);
    const combined = AbortSignal.any([signal, handle.signal]);
    const release = await handle.hold(combined);
    try {
      return await handle.execute(handle.prepare(command), combined);
    } finally {
      release();
    }
  };
  return { dataDir, settings, bots, peers, manager, run };
}

test('legacy bots preserve the shared profile; dedicated profiles are lazy, stable and keyed by immutable bot ID', async (t) => {
  const f = await fixture(t);
  f.manager.protectOrigin('https://loom.example');
  assert.equal(f.manager.botStatus('alpha').state, 'disconnected');
  assert.equal(f.manager.botStatus('legacy').botMode, 'shared');
  assert.equal(f.peers.length, 0);
  await f.run('legacy', { operation: 'tabs' });
  await f.run('shared', { operation: 'tabs' });
  assert.equal(f.peers.length, 1);
  assert.equal(f.peers[0].options.profileDir, undefined);
  assert.equal(f.peers[0].options.mode, 'existing');
  await f.run('alpha', { operation: 'tabs' });
  await f.run('beta', { operation: 'tabs' });
  assert.equal(f.peers.length, 3);
  const alphaPath = join(
    f.dataDir,
    'browser-profiles',
    createHash('sha256').update('alpha').digest('hex'),
  );
  assert.equal(f.peers[1].options.profileDir, alphaPath);
  assert.notEqual(f.peers[2].options.profileDir, alphaPath);
  assert.equal(f.peers[1].options.mode, 'dedicated');
  assert.ok(chromeLaunchOptions(f.peers[1].options).args.includes('--user-data-dir=' + alphaPath));
  assert.throws(
    () =>
      f.manager
        .forBot('alpha')
        .prepare({ operation: 'open', url: 'https://loom.example/settings' }),
    /control pages/,
  );
  f.bots.get('alpha')!.name = 'Renamed';
  await f.manager.disconnectBot('alpha');
  await f.manager.connectBot('alpha');
  assert.equal(f.peers.at(-1)!.options.profileDir, alphaPath);
  assert.equal(f.peers[1].closed, 1);
});

test('snapshot state and page IDs are isolated between bots; model arguments cannot choose another profile', async (t) => {
  const f = await fixture(t);
  await f.run('alpha', { operation: 'tabs' });
  await f.run('beta', { operation: 'tabs' });
  const first = await f.run('alpha', { operation: 'snapshot', pageId: 1 });
  const second = await f.run('beta', { operation: 'snapshot', pageId: 1 });
  const firstId = /State ID: ([a-f0-9-]+)/.exec(first.text)![1];
  const secondId = /State ID: ([a-f0-9-]+)/.exec(second.text)![1];
  assert.notEqual(firstId, secondId);
  assert.throws(
    () =>
      f.manager
        .forBot('beta')
        .prepare({ operation: 'click', pageId: 1, uid: '1_1', stateId: firstId }),
    /stale/,
  );
  assert.throws(
    () => f.manager.forBot('alpha').prepare({ operation: 'tabs', botId: 'beta' } as BrowserCommand),
    /Unrecognized key/,
  );
  await f.run('alpha', { operation: 'click', pageId: 1, uid: '1_1', stateId: firstId });
  assert.equal(f.peers[0].calls.filter((name) => name === 'click').length, 1);
  assert.equal(f.peers[1].calls.filter((name) => name === 'click').length, 0);
});

test('different bot browsers run concurrently; the same bot remains serial and cancellation is confined to its connection', async (t) => {
  const f = await fixture(t);
  await f.run('alpha', { operation: 'tabs' });
  await f.run('beta', { operation: 'tabs' });
  const alpha = f.peers[0],
    beta = f.peers[1];
  const a = blocked(),
    b = blocked();
  alpha.beforeCall = (_name, signal) => a.wait(signal);
  beta.beforeCall = (_name, signal) => b.wait(signal);
  const abort = new AbortController();
  const first = f.run('alpha', { operation: 'tabs' }, abort.signal);
  const firstRejected = assert.rejects(first, /cancelled|stopped/i);
  await until(() => alpha.active === 1);
  const queued = f.run('alpha', { operation: 'tabs' });
  const queuedRejected = assert.rejects(queued, /cancelled|stopped/i);
  const other = f.run('beta', { operation: 'tabs' });
  await until(() => beta.active === 1);
  assert.equal(alpha.active, 1);
  assert.equal(alpha.maximum, 1);
  abort.abort();
  await Promise.all([firstRejected, queuedRejected]);
  assert.equal(alpha.closed, 1);
  assert.equal(beta.closed, 0);
  b.release();
  await other;
  assert.equal(f.manager.botStatus('beta').state, 'connected');
});

test('capacity waits preserve approval leases, cancel promptly, and reuse an idle slot without erasing profiles', async (t) => {
  const f = await fixture(t, 1);
  await f.run('alpha', { operation: 'tabs' });
  const alpha = f.manager.forBot('alpha');
  const releaseApproval = await alpha.hold(new AbortController().signal);
  const abort = new AbortController();
  const waiting = f.run('beta', { operation: 'tabs' }, abort.signal);
  const rejected = assert.rejects(waiting, /stopped/i);
  await until(() => f.manager.botStatus('beta').waiting === true);
  assert.equal(f.peers.length, 1);
  assert.equal(f.peers[0].closed, 0, 'Pending review pins the current browser');
  abort.abort();
  await rejected;
  assert.equal(f.manager.status().pool!.waiting, 0);
  releaseApproval();
  await f.run('beta', { operation: 'tabs' });
  assert.equal(f.peers[0].closed, 1);
  assert.equal(f.manager.status().pool!.active, 1);
  const originalPath = f.peers[0].options.profileDir;
  await f.run('alpha', { operation: 'tabs' });
  assert.equal(f.peers.at(-1)!.options.profileDir, originalPath);
  assert.equal(f.manager.status().pool!.active, 1);
});

test('explicit bot disconnect cancels a waiting start and stale handles, but permits an explicit reconnect', async (t) => {
  const f = await fixture(t, 1);
  const active = f.manager.forBot('alpha');
  const release = await active.hold(new AbortController().signal);
  const pending = f.manager.connectBot('beta');
  const rejected = assert.rejects(pending, /stopped/i);
  await until(() => f.manager.botStatus('beta').waiting === true);
  await f.manager.disconnectBot('beta');
  await rejected;
  release();
  await f.manager.connectBot('beta');
  const previous = f.manager.forBot('beta');
  await f.manager.disconnectBot('beta');
  assert.equal(previous.signal.aborted, true);
  assert.throws(() => previous.prepare({ operation: 'tabs' }), /stopped/);
  await assert.rejects(f.run('beta', { operation: 'tabs' }), /disconnected by the user/);
  await f.manager.connectBot('beta');
  await f.run('beta', { operation: 'tabs' });
});

test('denial and shutdown cancel every capacity wait and close every dedicated and shared connection', async (t) => {
  const f = await fixture(t, 2);
  await f.run('alpha', { operation: 'tabs' });
  await f.run('legacy', { operation: 'tabs' });
  const a = f.manager.forBot('alpha'),
    shared = f.manager.forBot('legacy');
  const releases = await Promise.all([
    a.hold(new AbortController().signal),
    shared.hold(new AbortController().signal),
  ]);
  const queued = f.run('beta', { operation: 'tabs' });
  const rejected = assert.rejects(queued, /stopped/);
  await until(() => f.manager.botStatus('beta').waiting === true);
  f.settings.permission = 'deny';
  await f.manager.disconnectAll();
  await rejected;
  assert.equal(a.signal.aborted, true);
  assert.equal(shared.signal.aborted, true);
  assert.ok(f.peers.every((peer) => peer.closed === 1));
  releases.forEach((release) => release());
  assert.equal(f.manager.status().pool!.active, 0);
  f.settings.permission = 'allow';
  await f.manager.connectBot('alpha');
  await f.manager.connect();
  const held = await f.manager.forBot('alpha').hold(new AbortController().signal);
  const heldShared = await f.manager.forBot('legacy').hold(new AbortController().signal);
  const finalWait = f.run('beta', { operation: 'tabs' });
  const finalRejected = assert.rejects(finalWait, /stopped|shutting down/i);
  await until(() => f.manager.status().pool!.waiting === 1);
  await f.manager.shutdown();
  await finalRejected;
  held();
  heldShared();
  assert.ok(f.peers.every((peer) => peer.closed === 1));
});

test('changing a bot binding invalidates the old handle and never transfers another bot’s profile', async (t) => {
  const f = await fixture(t);
  await f.run('alpha', { operation: 'tabs' });
  const handle = f.manager.forBot('alpha');
  f.bots.get('alpha')!.browser = { mode: 'shared' };
  assert.throws(() => handle.prepare({ operation: 'tabs' }), /browser changed/);
  await f.manager.releaseBot('alpha');
  await f.run('alpha', { operation: 'tabs' });
  assert.equal(f.peers.at(-1)!.options.profileDir, undefined);
  assert.equal(f.peers[0].closed, 1);
  assert.throws(() => f.manager.forBot('off').prepare({ operation: 'tabs' }), /disabled/);
});
