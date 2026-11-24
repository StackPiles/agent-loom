import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import test from 'node:test';
import { startBrowserOwner, isOwnedBrowserEndpoint } from '../src/server/browser-owner.js';
import { runBrowserOwner } from '../src/server/browser-owner-runtime.js';
import type {
  DedicatedChromeOptions,
  DedicatedChromeProcess,
  OwnedChromeProcess,
} from '../src/server/browser-process.js';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class FakeHost extends EventEmitter {
  connected = true;
  messages: object[] = [];
  exits: number[] = [];
  onSend = async (_message: object) => {};
  async send(message: object) {
    this.messages.push(message);
    await this.onSend(message);
  }
  exit(code: number) {
    this.exits.push(code);
    this.emit('exit', code);
  }
}
class FakeChrome extends EventEmitter {
  pid = 2001;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: Array<NodeJS.Signals | number> = [];
  kill(signal: NodeJS.Signals | number = 'SIGTERM') {
    this.signals.push(signal);
    this.exit();
    return true;
  }
  exit() {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit('exit');
  }
}
function runtimeFixture() {
  const host = new FakeHost();
  const child = new FakeChrome();
  const exited = deferred();
  child.once('exit', () => exited.resolve());
  let closes = 0;
  const owner: DedicatedChromeProcess = {
    process: child as unknown as OwnedChromeProcess,
    wsEndpoint: 'ws://127.0.0.1:32100/devtools/browser/fixture',
    exited: exited.promise,
    close: async () => {
      closes++;
      child.exit();
    },
  };
  let options: DedicatedChromeOptions | undefined;
  const startChrome = async (value: DedicatedChromeOptions) => {
    options = value;
    value.onSpawn?.(owner.process);
    return owner;
  };
  return { host, child, owner, startChrome, options: () => options!, closes: () => closes };
}

test('parent IPC loss closes the exact Chrome while ordinary owner lifetime leaves it running', async () => {
  const f = runtimeFixture();
  await runBrowserOwner({
    profileDir: 'fixture',
    env: {},
    host: f.host,
    startChrome: f.startChrome,
  });
  assert.equal(f.closes(), 0);
  assert.deepEqual(
    f.host.messages.map((message) => (message as { type: string }).type),
    ['spawned', 'ready'],
  );
  f.host.connected = false;
  f.host.emit('disconnect');
  await turn();
  assert.equal(f.closes(), 1);
  assert.deepEqual(f.host.exits, [0]);
  assert.equal(f.child.exitCode, 0);
  assert.deepEqual(f.child.signals, []);
});

test('explicit owner close flushes Chrome exit proof before exiting', async () => {
  const f = runtimeFixture();
  const flushed = deferred();
  f.host.onSend = async (message) => {
    if ((message as { type: string }).type === 'closed') await flushed.promise;
  };
  await runBrowserOwner({
    profileDir: 'fixture',
    env: {},
    host: f.host,
    startChrome: f.startChrome,
  });
  f.host.emit('message', { type: 'close' });
  await turn();
  assert.equal(f.child.exitCode, 0);
  assert.deepEqual(f.host.exits, []);
  flushed.resolve();
  await turn();
  assert.deepEqual(f.host.exits, [0]);
});

test('unconfirmed Chrome close retains the owner until the actual child exits', async () => {
  const f = runtimeFixture();
  f.owner.close = async () => {
    throw new Error('not exited');
  };
  await runBrowserOwner({
    profileDir: 'fixture',
    env: {},
    host: f.host,
    startChrome: f.startChrome,
  });
  f.host.emit('message', { type: 'close' });
  await turn();
  assert.deepEqual(f.host.exits, []);
  assert.equal(
    f.host.messages.some((message) => (message as { type: string }).type === 'closed'),
    false,
  );
  f.child.exit();
  await turn();
  assert.deepEqual(f.host.exits, [1]);
});

test('parent loss during startup closes a late child without publishing a ready endpoint', async () => {
  const f = runtimeFixture();
  const starting = deferred<DedicatedChromeProcess>();
  const running = runBrowserOwner({
    profileDir: 'fixture',
    env: {},
    host: f.host,
    startChrome: async (options) => {
      await f.startChrome(options);
      return starting.promise;
    },
  });
  f.host.connected = false;
  f.host.emit('disconnect');
  assert.equal(f.options().signal?.aborted, true);
  starting.resolve(f.owner);
  await running;
  assert.equal(f.closes(), 1);
  assert.equal(
    f.host.messages.some((message) => (message as { type: string }).type === 'ready'),
    false,
  );
  assert.equal(f.child.exitCode, 0);
});

class FakeGuardian extends EventEmitter {
  pid = 2000;
  connected = true;
  onSend = (_message: object) => {};
  send(message: object, callback?: () => void) {
    this.onSend(message);
    callback?.();
    return true;
  }
}

test('guardian death alone cannot prove Chrome exit or authorize profile release', async () => {
  const guardian = new FakeGuardian();
  let alive = true;
  let exits = 0;
  const owner = await startBrowserOwner(
    {
      profileDir: 'fixture',
      env: {},
      signal: new AbortController().signal,
      onExit: () => {
        exits++;
      },
    },
    {
      spawn: () => {
        queueMicrotask(() =>
          guardian.emit('message', {
            type: 'ready',
            pid: 2001,
            wsEndpoint: 'ws://127.0.0.1:32100/devtools/browser/fixture',
          }),
        );
        return guardian as unknown as ChildProcess;
      },
      isProcessAlive: (pid) => {
        assert.equal(pid, 2001);
        return alive;
      },
    },
  );
  let chromeEnded = false;
  void owner.exited.then(() => {
    chromeEnded = true;
  });
  guardian.connected = false;
  guardian.emit('exit', null, 'SIGKILL');
  await turn();
  assert.equal(exits, 1);
  assert.equal(chromeEnded, false);
  await assert.rejects(owner.close(), /without confirming Chrome exit/);
  await assert.rejects(owner.close(), /without confirming Chrome exit/);
  alive = false;
  await owner.close();
  await owner.exited;
  assert.equal(chromeEnded, true);
});

test('confirmed closed IPC proves Chrome exit even when its old PID is already reused', async () => {
  const guardian = new FakeGuardian();
  guardian.onSend = () => {
    guardian.emit('message', { type: 'closed' });
    guardian.emit('exit', 0, null);
  };
  const owner = await startBrowserOwner(
    { profileDir: 'fixture', env: {}, signal: new AbortController().signal, onExit: () => {} },
    {
      spawn: () => {
        queueMicrotask(() =>
          guardian.emit('message', {
            type: 'ready',
            pid: 2001,
            wsEndpoint: 'ws://127.0.0.1:32100/devtools/browser/fixture',
          }),
        );
        return guardian as unknown as ChildProcess;
      },
      isProcessAlive: () => true,
    },
  );
  await owner.close();
  await owner.exited;
});

test('failed startup exposes cleanup ownership before readiness so a live Chrome is not forgotten', async () => {
  const guardian = new FakeGuardian();
  let alive = true;
  let cleanup: Pick<Awaited<ReturnType<typeof startBrowserOwner>>, 'close' | 'exited'> | undefined;
  await assert.rejects(
    startBrowserOwner(
      {
        profileDir: 'fixture',
        env: {},
        signal: new AbortController().signal,
        onExit: () => {},
        onOwnership: (owner) => {
          cleanup = owner;
        },
      },
      {
        spawn: () => {
          queueMicrotask(() => {
            guardian.emit('message', { type: 'spawned', pid: 2001 });
            guardian.connected = false;
            guardian.emit('exit', null, 'SIGKILL');
          });
          return guardian as unknown as ChildProcess;
        },
        isProcessAlive: () => alive,
      },
    ),
    /without confirming Chrome exit/,
  );
  assert.ok(cleanup);
  await assert.rejects(cleanup.close(), /without confirming Chrome exit/);
  alive = false;
  await cleanup.close();
});

test('owned endpoint validation rejects remote hosts, credentials, zero ports and injected paths', () => {
  for (const endpoint of [
    'ws://example.test:3210/devtools/browser/x',
    'ws://name@127.0.0.1:3210/devtools/browser/x',
    'ws://127.0.0.1:0/devtools/browser/x',
    'ws://127.0.0.1:3210/devtools/browser/x?next=other',
    'http://127.0.0.1:3210/devtools/browser/x',
  ])
    assert.equal(isOwnedBrowserEndpoint(endpoint), false);
});
