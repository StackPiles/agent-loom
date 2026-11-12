import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  browserUploadProcessesEnded,
  installBrowserUploadProcessTracker,
  readBrowserUploadProcesses,
  type BrowserUploadProcessProof,
  type BrowserUploadTrackedBrowser,
} from '../src/server/browser-upload-processes.js';

const token = 'a'.repeat(64);
const fixtureProof = (
  browsers: BrowserUploadProcessProof['browsers'],
): BrowserUploadProcessProof => ({
  version: 1,
  token,
  mcpPid: 100,
  browsers,
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly pid: number) {
    super();
  }
  exit() {
    this.exitCode = 0;
    this.emit('exit', 0, null);
  }
}
class FakeBrowser extends EventEmitter implements BrowserUploadTrackedBrowser {
  constructor(readonly child: FakeProcess | null) {
    super();
  }
  process() {
    return this.child;
  }
}
class FakeManager {
  ensureCalls = 0;
  closeCalls = 0;
  onClose = async () => {};
  constructor(public browser: BrowserUploadTrackedBrowser) {}
  async ensureBrowser() {
    ++this.ensureCalls;
    return this.browser;
  }
  async close() {
    ++this.closeCalls;
    await this.onClose();
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'loom-browser-process-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, filename: join(root, 'chrome-processes.json') };
}

test('records actual dedicated processes before returning and atomically records their exits', async (t) => {
  const f = await fixture(t);
  const child = new FakeProcess(101);
  const browser = new FakeBrowser(child);
  const manager = new FakeManager(browser);
  const tracker = installBrowserUploadProcessTracker(manager, f.root, token, { mcpPid: 100 });
  await tracker.flush();
  assert.deepEqual(await readBrowserUploadProcesses(f.root, token), fixtureProof([]));
  assert.equal(await manager.ensureBrowser(), browser);
  assert.deepEqual(
    await readBrowserUploadProcesses(f.root, token),
    fixtureProof([{ pid: 101, exited: false }]),
  );
  browser.emit('disconnected');
  await tracker.flush();
  assert.equal(
    browserUploadProcessesEnded(await readBrowserUploadProcesses(f.root, token), () => true),
    false,
  );
  child.exit();
  await tracker.flush();
  assert.deepEqual(
    await readBrowserUploadProcesses(f.root, token),
    fixtureProof([{ pid: 101, exited: true }]),
  );
  assert.deepEqual(await readdir(f.root), ['chrome-processes.json']);
});

test('serializes generations and late exits while a previous manifest write is blocked', async () => {
  const childA = new FakeProcess(101);
  const childB = new FakeProcess(102);
  const manager = new FakeManager(new FakeBrowser(childA));
  const blocked = deferred();
  const release = deferred();
  const writes: BrowserUploadProcessProof[] = [];
  let active = 0;
  let peak = 0;
  const tracker = installBrowserUploadProcessTracker(manager, 'unused', token, {
    mcpPid: 100,
    writeProof: async (_root, proof) => {
      peak = Math.max(peak, ++active);
      if (proof.browsers.length === 1 && !proof.browsers[0].exited) {
        blocked.resolve();
        await release.promise;
      }
      writes.push(structuredClone(proof));
      --active;
    },
  });
  await tracker.flush();
  let firstReturned = false;
  const first = manager.ensureBrowser().then(() => {
    firstReturned = true;
  });
  await blocked.promise;
  assert.equal(firstReturned, false);
  childA.exit();
  manager.browser = new FakeBrowser(childB);
  const second = manager.ensureBrowser();
  await turn();
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(peak, 1);
  assert.deepEqual(writes.at(-1)?.browsers, [
    { pid: 101, exited: true },
    { pid: 102, exited: false },
  ]);
  const count = writes.length;
  childA.emit('close', 0, null);
  await manager.ensureBrowser();
  await tracker.flush();
  assert.equal(
    writes.length,
    count,
    'late close and repeated ensure do not rewrite or lose generations',
  );
});

test('keeps a reused PID distinct from an already exited generation', async () => {
  const first = new FakeProcess(101);
  const manager = new FakeManager(new FakeBrowser(first));
  let saved: BrowserUploadProcessProof | undefined;
  const tracker = installBrowserUploadProcessTracker(manager, 'unused', token, {
    writeProof: async (_root, proof) => {
      saved = proof;
    },
  });
  await manager.ensureBrowser();
  first.exit();
  await tracker.flush();
  const reused = new FakeProcess(101);
  manager.browser = new FakeBrowser(reused);
  await manager.ensureBrowser();
  first.emit('close', 0, null);
  await tracker.flush();
  assert.deepEqual(saved?.browsers, [
    { pid: 101, exited: true },
    { pid: 101, exited: false },
  ]);
  assert.equal(
    browserUploadProcessesEnded(saved, () => true),
    false,
  );
});

test('recognizes a process that exited before tracking and accepts a close event as termination', async () => {
  const exited = new FakeProcess(101);
  exited.exit();
  const manager = new FakeManager(new FakeBrowser(exited));
  let saved: BrowserUploadProcessProof | undefined;
  installBrowserUploadProcessTracker(manager, 'unused', token, {
    writeProof: async (_root, proof) => {
      saved = proof;
    },
  });
  await manager.ensureBrowser();
  assert.equal(saved?.browsers[0].exited, true);
  const closed = new FakeProcess(102);
  manager.browser = new FakeBrowser(closed);
  await manager.ensureBrowser();
  manager.onClose = async () => {
    closed.emit('close', null, 'SIGKILL');
  };
  await manager.close();
  assert.equal(saved?.browsers[1].exited, true);
});

test('manager close waits for pending exit evidence after its own shutdown completes', async () => {
  const child = new FakeProcess(101);
  const manager = new FakeManager(new FakeBrowser(child));
  const blocked = deferred();
  const release = deferred();
  let saved: BrowserUploadProcessProof | undefined;
  installBrowserUploadProcessTracker(manager, 'unused', token, {
    writeProof: async (_root, proof) => {
      if (proof.browsers.some((entry) => entry.exited)) {
        blocked.resolve();
        await release.promise;
      }
      saved = proof;
    },
  });
  await manager.ensureBrowser();
  manager.onClose = async () => {
    child.exit();
  };
  let returned = false;
  const closing = manager.close().then(() => {
    returned = true;
  });
  await blocked.promise;
  assert.equal(returned, false);
  assert.equal(saved?.browsers[0].exited, false);
  release.resolve();
  await closing;
  assert.equal(saved?.browsers[0].exited, true);
});

test('initial ownership write failure prevents even the next launch attempt', async (t) => {
  const f = await fixture(t);
  const manager = new FakeManager(new FakeBrowser(new FakeProcess(101)));
  const tracker = installBrowserUploadProcessTracker(manager, join(f.root, 'missing'), token);
  await assert.rejects(tracker.flush(), /Could not persist Chrome process ownership/);
  await assert.rejects(manager.ensureBrowser(), /Could not persist Chrome process ownership/);
  assert.equal(manager.ensureCalls, 0);
});

test('failed generation and exit writes block subsequent tools without publishing false completion', async () => {
  for (const failedPhase of ['launch', 'exit']) {
    const child = new FakeProcess(101);
    const manager = new FakeManager(new FakeBrowser(child));
    let saved: BrowserUploadProcessProof | undefined;
    const tracker = installBrowserUploadProcessTracker(
      manager,
      'private-path-not-for-errors',
      token,
      {
        writeProof: async (_root, proof) => {
          if (proof.browsers.length && (failedPhase === 'launch' || proof.browsers[0].exited))
            throw new Error('EACCES /private-path-not-for-errors/chrome-processes.json');
          saved = proof;
        },
      },
    );
    await tracker.flush();
    if (failedPhase === 'launch') {
      await assert.rejects(manager.ensureBrowser(), (error: Error) => {
        assert.match(error.message, /Could not persist Chrome process ownership/);
        assert.doesNotMatch(error.message, /private-path/);
        return true;
      });
      assert.deepEqual(saved?.browsers, []);
    } else {
      await manager.ensureBrowser();
      child.exit();
      await assert.rejects(tracker.flush(), /Could not persist Chrome process ownership/);
      assert.deepEqual(saved?.browsers, [{ pid: 101, exited: false }]);
    }
    assert.equal(
      browserUploadProcessesEnded(saved, () => true),
      false,
    );
    await assert.rejects(manager.ensureBrowser(), /Could not persist Chrome process ownership/);
    await assert.rejects(manager.close(), /Could not persist Chrome process ownership/);
    assert.equal(manager.closeCalls, 1, 'shutdown still runs after a proof failure');
  }
});

test('reads existing Chrome PID through a transient browser CDP session and never equates detach with exit', async () => {
  const calls: unknown[][] = [];
  let detachCount = 0;
  const browser: BrowserUploadTrackedBrowser = {
    process: () => null,
    target: () => ({
      createCDPSession: async () => ({
        send: async (...args) => {
          calls.push(args);
          return {
            processInfo: [
              { type: 'renderer', id: 102 },
              { type: 'browser', id: 101 },
            ],
          };
        },
        detach: async () => {
          ++detachCount;
        },
      }),
    }),
  };
  const manager = new FakeManager(browser);
  let saved: BrowserUploadProcessProof | undefined;
  let writes = 0;
  installBrowserUploadProcessTracker(manager, 'unused', token, {
    writeProof: async (_root, proof) => {
      saved = proof;
      ++writes;
    },
  });
  await manager.ensureBrowser();
  assert.deepEqual(calls, [['SystemInfo.getProcessInfo', undefined, { timeout: 3000 }]]);
  assert.equal(detachCount, 1);
  assert.deepEqual(saved?.browsers, [{ pid: 101, exited: false }]);
  await manager.ensureBrowser();
  await manager.close();
  assert.equal(calls.length, 1);
  assert.equal(writes, 2);
  assert.equal(
    browserUploadProcessesEnded(saved, () => true),
    false,
  );
  assert.equal(
    browserUploadProcessesEnded(saved, () => false),
    true,
  );
});

test('an attached dedicated browser must match its owned child and records actual exit evidence', async (t) => {
  const f = await fixture(t);
  const child = new FakeProcess(101);
  let lookups = 0;
  const attached = (): BrowserUploadTrackedBrowser => ({
    process: () => null,
    target: () => ({
      createCDPSession: async () => ({
        send: async () => {
          ++lookups;
          return { processInfo: [{ type: 'browser', id: 101 }] };
        },
        detach: async () => {},
      }),
    }),
  });
  const manager = new FakeManager(attached());
  const tracker = installBrowserUploadProcessTracker(manager, f.root, token, {
    mcpPid: 100,
    ownedProcess: child,
  });
  await manager.ensureBrowser();
  await manager.ensureBrowser();
  assert.equal(lookups, 1);
  assert.deepEqual(
    await readBrowserUploadProcesses(f.root, token),
    fixtureProof([{ pid: 101, exited: false }]),
  );
  // A new CDP connection must prove its identity again, while one live Chrome
  // remains one generation even after more than the historical generation cap.
  for (let index = 0; index < 130; ++index) {
    manager.browser = attached();
    await manager.ensureBrowser();
  }
  assert.equal(lookups, 131);
  assert.equal((await readBrowserUploadProcesses(f.root, token))?.browsers.length, 1);
  child.exit();
  await tracker.flush();
  assert.deepEqual(
    await readBrowserUploadProcesses(f.root, token),
    fixtureProof([{ pid: 101, exited: true }]),
  );
  const calls = manager.ensureCalls;
  await assert.rejects(manager.ensureBrowser(), /dedicated Chrome process has ended/);
  assert.equal(manager.ensureCalls, calls, 'An ended child cannot reconnect to a reused port.');
});

test('a mismatched or unidentifiable dedicated attachment fails before returning a browser', async () => {
  for (const id of [999, undefined]) {
    const child = new FakeProcess(101);
    let detached = 0;
    const manager = new FakeManager({
      // Even a seemingly valid process() cannot substitute for CDP identity.
      process: () => child,
      target: () => ({
        createCDPSession: async () => ({
          send: async () => ({ processInfo: id ? [{ type: 'browser', id }] : [] }),
          detach: async () => {
            ++detached;
          },
        }),
      }),
    });
    let saved: BrowserUploadProcessProof | undefined;
    installBrowserUploadProcessTracker(manager, 'unused', token, {
      ownedProcess: child,
      writeProof: async (_root, proof) => {
        saved = proof;
      },
    });
    await assert.rejects(manager.ensureBrowser(), /dedicated process started by Loom/);
    assert.equal(detached, 1);
    assert.deepEqual(saved?.browsers, []);
    assert.equal(
      browserUploadProcessesEnded(saved, () => false),
      false,
    );
    await assert.rejects(manager.ensureBrowser(), /dedicated process started by Loom/);
    assert.equal(manager.ensureCalls, 1, 'A failed identity proof blocks subsequent tools.');
    assert.equal(child.exitCode, null, 'The tracker never kills a discovered PID.');
  }
});

test('an unidentified attached generation permanently prevents incomplete cleanup proof', async () => {
  const child = new FakeProcess(101);
  const manager = new FakeManager(new FakeBrowser(child));
  let saved: BrowserUploadProcessProof | undefined;
  const tracker = installBrowserUploadProcessTracker(manager, 'unused', token, {
    writeProof: async (_root, proof) => {
      saved = proof;
    },
  });
  await manager.ensureBrowser();
  child.exit();
  await tracker.flush();
  assert.equal(browserUploadProcessesEnded(saved), true);
  let detached = false;
  manager.browser = {
    process: () => null,
    target: () => ({
      createCDPSession: async () => ({
        send: async () => {
          throw new Error('Unsupported browser target command');
        },
        detach: async () => {
          detached = true;
        },
      }),
    }),
  };
  await manager.ensureBrowser();
  assert.equal(detached, true);
  assert.deepEqual(saved?.browsers, []);
  const later = new FakeProcess(102);
  manager.browser = new FakeBrowser(later);
  await manager.ensureBrowser();
  later.exit();
  await tracker.flush();
  assert.deepEqual(saved?.browsers, []);
  assert.equal(
    browserUploadProcessesEnded(saved, () => false),
    false,
  );
});

test('bounds generations by pruning exited entries while retaining every live entry', async () => {
  const manager = new FakeManager(new FakeBrowser(new FakeProcess(101)));
  let saved: BrowserUploadProcessProof | undefined;
  const tracker = installBrowserUploadProcessTracker(manager, 'unused', token, {
    writeProof: async (_root, proof) => {
      saved = proof;
    },
  });
  await manager.ensureBrowser();
  for (let index = 1; index < 128; ++index) {
    const child = new FakeProcess(101 + index);
    manager.browser = new FakeBrowser(child);
    await manager.ensureBrowser();
    child.exit();
    await tracker.flush();
  }
  assert.equal(saved?.browsers.length, 128);
  manager.browser = new FakeBrowser(new FakeProcess(1000));
  await manager.ensureBrowser();
  assert.deepEqual(saved?.browsers, [
    { pid: 101, exited: false },
    { pid: 1000, exited: false },
  ]);
});

test('refuses another untrackable generation rather than dropping live owners at the bound', async () => {
  const manager = new FakeManager(new FakeBrowser(new FakeProcess(101)));
  let saved: BrowserUploadProcessProof | undefined;
  installBrowserUploadProcessTracker(manager, 'unused', token, {
    writeProof: async (_root, proof) => {
      saved = proof;
    },
  });
  for (let index = 0; index < 128; ++index) {
    manager.browser = new FakeBrowser(new FakeProcess(101 + index));
    await manager.ensureBrowser();
  }
  manager.browser = new FakeBrowser(new FakeProcess(1000));
  await assert.rejects(manager.ensureBrowser(), /Too many unclosed Chrome generations/);
  assert.equal(saved?.browsers.length, 128);
  assert.equal(saved?.browsers[0].pid, 101);
});

test('cleanup requires at least one valid owner and treats unknown liveness conservatively', (t) => {
  const running = fixtureProof([{ pid: 101, exited: false }]);
  assert.equal(browserUploadProcessesEnded(undefined), false);
  assert.equal(browserUploadProcessesEnded(fixtureProof([])), false);
  assert.equal(
    browserUploadProcessesEnded(running, () => false),
    true,
  );
  assert.equal(
    browserUploadProcessesEnded(running, () => true),
    false,
  );
  assert.equal(
    browserUploadProcessesEnded(running, () => {
      throw new Error('unknown');
    }),
    false,
  );
  assert.equal(
    browserUploadProcessesEnded(fixtureProof([{ pid: 101, exited: true }]), () => {
      throw new Error('not needed');
    }),
    true,
  );
  assert.equal(
    browserUploadProcessesEnded(
      fixtureProof([
        { pid: 101, exited: true },
        { pid: 102, exited: false },
      ]),
      () => true,
    ),
    false,
  );
  assert.equal(browserUploadProcessesEnded(fixtureProof([{ pid: -101, exited: true }])), false);
  for (const code of ['ESRCH', 'EPERM', 'EACCES', 'UNKNOWN']) {
    const mock = t.mock.method(process, 'kill', (pid: number, signal: number) => {
      assert.equal(pid, 101);
      assert.equal(signal, 0);
      throw Object.assign(new Error(code), { code });
    });
    assert.equal(browserUploadProcessesEnded(running), code === 'ESRCH');
    mock.mock.restore();
  }
});

test('manifest reads reject invalid shape, wrong tokens, oversized data, links, and nonfiles', async (t) => {
  const f = await fixture(t);
  assert.equal(await readBrowserUploadProcesses(f.root, token), undefined);
  const good = fixtureProof([{ pid: 101, exited: false }]);
  for (const value of [
    null,
    [],
    {},
    { ...good, version: 2 },
    { ...good, token: 'wrong' },
    { ...good, mcpPid: 0 },
    { ...good, mcpPid: 1.5 },
    { ...good, browsers: {} },
    { ...good, browsers: [{ pid: 0, exited: true }] },
    { ...good, browsers: [{ pid: 101, exited: 'true' }] },
    { ...good, browsers: Array.from({ length: 129 }, () => ({ pid: 101, exited: true })) },
  ]) {
    await writeFile(f.filename, JSON.stringify(value));
    assert.equal(await readBrowserUploadProcesses(f.root, token), undefined);
  }
  await writeFile(f.filename, '{');
  assert.equal(await readBrowserUploadProcesses(f.root, token), undefined);
  await writeFile(f.filename, ' '.repeat(32 * 1024 + 1));
  assert.equal(await readBrowserUploadProcesses(f.root, token), undefined);
  await writeFile(f.filename, JSON.stringify(good));
  assert.deepEqual(await readBrowserUploadProcesses(f.root, token), good);
  const linked = join(f.root, 'hardlink.json');
  await link(f.filename, linked);
  assert.equal(await readBrowserUploadProcesses(f.root, token), undefined);
  await rm(linked);
  await rm(f.filename);
  await mkdir(f.filename);
  assert.equal(await readBrowserUploadProcesses(f.root, token), undefined);
});

test('neither the proof reader nor writer follows a manifest symlink', async (t) => {
  const f = await fixture(t);
  const target = join(f.root, 'outside.json');
  const contents = JSON.stringify(fixtureProof([{ pid: 101, exited: true }]));
  await writeFile(target, contents);
  try {
    await symlink(target, f.filename, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('This filesystem does not permit symbolic-link fixtures.');
      return;
    }
    throw error;
  }
  assert.equal(await readBrowserUploadProcesses(f.root, token), undefined);
  const manager = new FakeManager(new FakeBrowser(new FakeProcess(101)));
  const tracker = installBrowserUploadProcessTracker(manager, f.root, token);
  await assert.rejects(tracker.flush(), /Could not persist Chrome process ownership/);
  assert.equal(await readFile(target, 'utf8'), contents);
});
