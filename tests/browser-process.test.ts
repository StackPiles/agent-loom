import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import {
  dedicatedBrowserErrorMessage,
  startDedicatedChrome,
  type ChromeControlConnection,
  type DedicatedChromeDependencies,
  type OwnedChromeProcess,
} from '../src/server/browser-process.js';

class FakeChrome extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stderr = new PassThrough();
  signals: Array<NodeJS.Signals | number> = [];
  onKill: (signal: NodeJS.Signals | number) => void = (signal) => this.exit(signal);
  constructor(readonly pid: number | undefined) {
    super();
  }
  kill(signal: NodeJS.Signals | number = 'SIGTERM') {
    this.signals.push(signal);
    this.onKill(signal);
    return true;
  }
  exit(signal?: NodeJS.Signals | number) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    if (typeof signal === 'string') this.signalCode = signal;
    else this.exitCode = 0;
    this.emit('exit', this.exitCode, this.signalCode);
    this.stderr.end();
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'loom-owned-chrome-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const children: FakeChrome[] = [];
  const launches: Array<{ executable: string; args: string[]; options: object }> = [];
  const connections: string[] = [];
  const closes: number[] = [];
  const disconnects: number[] = [];
  let processId = 1000;
  let port = 32100;
  const endpoint = (assignedPort: number) =>
    `ws://127.0.0.1:${assignedPort}/devtools/browser/fixture-${assignedPort}`;
  const dependencies: DedicatedChromeDependencies = {
    executablePath: async () => '/installed stable Chrome',
    reservePort: async () => ++port,
    spawn(executable, args, options) {
      const child = new FakeChrome(++processId);
      children.push(child);
      launches.push({ executable, args, options });
      const assignedPort = Number(
        args.find((arg) => arg.startsWith('--remote-debugging-port='))?.split('=')[1],
      );
      setImmediate(() => child.stderr.write(`DevTools listening on ${endpoint(assignedPort)}\n`));
      return child as OwnedChromeProcess;
    },
    async connect(value) {
      connections.push(value);
      const child = children.at(-1)!;
      return {
        target: () => ({
          createCDPSession: async () => ({
            send: async (method) => {
              assert.equal(method, 'SystemInfo.getProcessInfo');
              return {
                processInfo: [
                  { type: 'renderer', id: 77 },
                  { type: 'browser', id: child.pid },
                ],
              };
            },
            detach: async () => {},
          }),
        }),
        async close() {
          closes.push(child.pid!);
          child.exit();
        },
        async disconnect() {
          disconnects.push(child.pid!);
        },
      };
    },
    startupTimeoutMs: 5_000,
    closeTimeoutMs: 60,
  };
  const options = {
    profileDir: join(root, 'persistent profile'),
    env: { LANG: 'ja_JP.UTF-8', DISPLAY: ':99' },
  };
  return {
    root,
    options,
    dependencies,
    children,
    launches,
    connections,
    closes,
    disconnects,
    endpoint,
  };
}

test('ordinary Chrome startup uses the persistent profile and exact owned endpoint, and closes idempotently', async (t) => {
  const f = await fixture(t);
  const owned = await startDedicatedChrome(f.options, f.dependencies);
  assert.equal(owned.process, f.children[0]);
  assert.equal(owned.wsEndpoint, f.endpoint(32101));
  assert.deepEqual(f.connections, [owned.wsEndpoint]);
  const launch = f.launches[0];
  assert.equal(launch.executable, '/installed stable Chrome');
  assert.ok(launch.args.includes('--user-data-dir=' + (await realpath(f.options.profileDir))));
  assert.ok(launch.args.includes('--remote-debugging-port=32101'));
  assert.ok(launch.args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(
    !launch.args.some((arg) =>
      /enable-automation|remote-debugging-pipe|remote-debugging-port=0|headless|no-sandbox|disable-blink-features/.test(
        arg,
      ),
    ),
  );
  assert.deepEqual(launch.options, {
    env: f.options.env,
    stdio: ['ignore', 'ignore', 'pipe'],
    shell: false,
    detached: false,
    windowsHide: false,
  });
  await Promise.all([owned.close(), owned.close()]);
  await owned.exited;
  assert.deepEqual(f.closes, [1001]);
  assert.deepEqual(f.children[0].signals, []);
  const reopened = await startDedicatedChrome(f.options, f.dependencies);
  await reopened.close();
  assert.equal(f.launches.length, 2);
});

test('concurrent starts cannot use the same persistent profile and an unexpected exit releases it', async (t) => {
  const f = await fixture(t);
  let exits = 0;
  const first = await startDedicatedChrome({ ...f.options, onExit: () => ++exits }, f.dependencies);
  await assert.rejects(
    startDedicatedChrome(f.options, f.dependencies),
    /profile is already in use/,
  );
  assert.equal(f.launches.length, 1);
  f.children[0].exit();
  await first.exited;
  assert.equal(exits, 1);
  await first.close();
  assert.deepEqual(f.children[0].signals, []);
  const second = await startDedicatedChrome(f.options, f.dependencies);
  await second.close();
});

test('a debugging endpoint for another PID is never closed or accepted', async (t) => {
  const f = await fixture(t);
  let foreignCloses = 0;
  let foreignDisconnects = 0;
  f.dependencies.connect = async () => ({
    target: () => ({
      createCDPSession: async () => ({
        send: async () => ({ processInfo: [{ type: 'browser', id: 9898 }] }),
        detach: async () => {},
      }),
    }),
    close: async () => {
      ++foreignCloses;
    },
    disconnect: async () => {
      ++foreignDisconnects;
    },
  });
  await assert.rejects(startDedicatedChrome(f.options, f.dependencies), /does not belong/);
  assert.equal(foreignCloses, 0);
  assert.equal(foreignDisconnects, 1);
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
});

test('a loopback port race retries only after the failed owned child has exited', async (t) => {
  const f = await fixture(t);
  const spawn = f.dependencies.spawn;
  f.dependencies.spawn = (executable, args, options) => {
    const child = spawn(executable, args, options) as FakeChrome;
    if (f.children.length === 1) {
      queueMicrotask(() =>
        child.stderr.write(
          'bind() failed: Address already in use (98)\nCannot start http server for devtools.\n',
        ),
      );
    } else {
      assert.equal(f.children[0].signalCode, 'SIGTERM');
    }
    return child;
  };
  const owned = await startDedicatedChrome(f.options, f.dependencies);
  assert.equal(f.launches.length, 2);
  assert.equal(owned.wsEndpoint, f.endpoint(32102));
  assert.deepEqual(f.connections, [f.endpoint(32102)]);
  await owned.close();
});

test('startup rejects a mismatched endpoint without connecting to or killing an unrelated process', async (t) => {
  const f = await fixture(t);
  const spawn = f.dependencies.spawn;
  f.dependencies.spawn = (...args) => {
    const child = spawn(...args) as FakeChrome;
    queueMicrotask(() =>
      child.stderr.write('DevTools listening on ws://127.0.0.1:9999/devtools/browser/unrelated\n'),
    );
    return child;
  };
  await assert.rejects(
    startDedicatedChrome(f.options, f.dependencies),
    /unexpected debugging endpoint/,
  );
  assert.deepEqual(f.connections, []);
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
});

test('startup reads a complete stderr endpoint even when it is split across chunks', async (t) => {
  const f = await fixture(t);
  f.dependencies.spawn = (_executable, _args, _options) => {
    const child = new FakeChrome(1080);
    f.children.push(child);
    setImmediate(() => {
      child.stderr.write('DevTools listening on ws://127.0.0.1:32101/devtools/browser/par');
      setImmediate(() => child.stderr.write('tial-endpoint\n'));
    });
    return child;
  };
  const owned = await startDedicatedChrome(f.options, f.dependencies);
  assert.equal(owned.wsEndpoint, 'ws://127.0.0.1:32101/devtools/browser/partial-endpoint');
  await owned.close();
});

test('startup cancellation terminates only the owned child and disconnects a late connection', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let finishConnect!: (connection: ChromeControlConnection) => void;
  f.dependencies.connect = () => {
    queueMicrotask(() => controller.abort(new Error('cancel requested')));
    return new Promise((resolve) => {
      finishConnect = resolve;
    });
  };
  await assert.rejects(
    startDedicatedChrome({ ...f.options, signal: controller.signal }, f.dependencies),
    /cancel requested/,
  );
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  let disconnects = 0;
  finishConnect({
    target: () => {
      throw new Error('late connection must not inspect or close the browser');
    },
    close: async () => {
      throw new Error('late connection must not close the browser');
    },
    disconnect: async () => {
      ++disconnects;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disconnects, 1);
});

test('an uncertain shutdown retains profile ownership until the child actually exits', async (t) => {
  const f = await fixture(t);
  const connect = f.dependencies.connect;
  f.dependencies.connect = async (endpoint) => {
    const connection = await connect(endpoint);
    connection.close = () => new Promise(() => {});
    return connection;
  };
  const first = await startDedicatedChrome(f.options, f.dependencies);
  f.children[0].onKill = () => {};
  await assert.rejects(first.close(), /has not confirmed its exit/);
  assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL']);
  await assert.rejects(
    startDedicatedChrome(f.options, f.dependencies),
    /profile is already in use/,
  );
  f.children[0].exit();
  await first.exited;
  f.dependencies.connect = connect;
  const next = await startDedicatedChrome(f.options, f.dependencies);
  await next.close();
});

test('a stale profile lock error never causes adoption or termination of the existing Chrome', async (t) => {
  const f = await fixture(t);
  f.dependencies.spawn = () => {
    const child = new FakeChrome(1090);
    f.children.push(child);
    setImmediate(() => {
      child.stderr.write('Failed to create a ProcessSingleton for your profile directory.\n');
      child.exit();
    });
    return child;
  };
  await assert.rejects(
    startDedicatedChrome(f.options, f.dependencies),
    /profile is already in use/,
  );
  assert.deepEqual(f.connections, []);
  assert.deepEqual(f.children[0].signals, []);
});

test('an already cancelled start performs no process or connection work', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    startDedicatedChrome(
      { ...f.options, signal: AbortSignal.abort(new Error('already cancelled')) },
      f.dependencies,
    ),
    /already cancelled/,
  );
  assert.deepEqual(f.launches, []);
  assert.deepEqual(f.connections, []);
});

test('a startup timeout closes its child and permits a later start with the same profile', async (t) => {
  const f = await fixture(t);
  const spawn = f.dependencies.spawn;
  f.dependencies.startupTimeoutMs = 30;
  f.dependencies.spawn = () => {
    const child = new FakeChrome(1100);
    f.children.push(child);
    return child;
  };
  await assert.rejects(
    startDedicatedChrome(f.options, f.dependencies),
    /debugging connection in time/,
  );
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  assert.deepEqual(f.connections, []);
  f.dependencies.spawn = spawn;
  f.dependencies.startupTimeoutMs = 5_000;
  const next = await startDedicatedChrome(f.options, f.dependencies);
  await next.close();
});

test('a missing Chrome executable reports a useful error and releases the unused profile', async (t) => {
  const f = await fixture(t);
  const spawn = f.dependencies.spawn;
  f.dependencies.spawn = () => {
    const child = new FakeChrome(undefined);
    f.children.push(child);
    setImmediate(() =>
      child.emit('error', Object.assign(new Error('private path not found'), { code: 'ENOENT' })),
    );
    return child;
  };
  await assert.rejects(startDedicatedChrome(f.options, f.dependencies), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Stable Google Chrome is not installed/);
    assert.doesNotMatch(error.message, /private path/);
    return true;
  });
  assert.deepEqual(f.children[0].signals, []);
  assert.deepEqual(f.connections, []);
  f.dependencies.spawn = spawn;
  const next = await startDedicatedChrome(f.options, f.dependencies);
  await next.close();
});

test('cancellation while reserving a port never starts a late Chrome process', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.dependencies.reservePort = async () => {
    controller.abort(new Error('reservation cancelled'));
    return 32123;
  };
  await assert.rejects(
    startDedicatedChrome({ ...f.options, signal: controller.signal }, f.dependencies),
    /reservation cancelled/,
  );
  assert.deepEqual(f.launches, []);
  assert.deepEqual(f.connections, []);
});

test('startup diagnostics omit private executable and websocket paths', async (t) => {
  const f = await fixture(t);
  const executablePath = f.dependencies.executablePath;
  f.dependencies.executablePath = async () => {
    throw new Error('/private/profile/secret could not be read');
  };
  await assert.rejects(startDedicatedChrome(f.options, f.dependencies), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Could not find installed stable Google Chrome/);
    assert.equal(dedicatedBrowserErrorMessage(error), error.message);
    assert.doesNotMatch(error.message, /private|profile|secret/);
    return true;
  });
  f.dependencies.executablePath = executablePath;
  f.dependencies.connect = async () => {
    throw new Error('ws://127.0.0.1:32100/devtools/browser/private-endpoint from /private/profile');
  };
  await assert.rejects(startDedicatedChrome(f.options, f.dependencies), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /verified connection/);
    assert.equal(dedicatedBrowserErrorMessage(error), error.message);
    assert.doesNotMatch(error.message, /private|devtools|32100/);
    return true;
  });
  assert.doesNotMatch(
    dedicatedBrowserErrorMessage(new Error('/private/profile/secret')),
    /private|profile|secret/,
  );
});
