import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

type Scenario = 'resident' | 'temporary' | 'interrupted';

interface FixtureResult {
  type: 'result';
  scenario: Scenario;
  waitingAtRelease: number;
  completedWaiters: number;
  requestedWaiters: string[];
  expectedWaiters: string[];
  healthStatus: number;
  eventLoopResponded: boolean;
  cancellationPreserved: boolean;
  pausePreserved: boolean;
  queue: { active: number; waiting: number };
  memory: {
    resident: { bytes: number; count: number; waiting: number };
    temporary: { bytes: number; count: number; waiting: number };
  };
}

async function runFixture(t: TestContext, scenario: Scenario): Promise<FixtureResult> {
  const directory = await mkdtemp(join(tmpdir(), 'loom-capacity-progress-'));
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./fixtures/session-capacity-progress-child.ts', import.meta.url)),
      scenario,
      directory,
    ],
    {
      env: {
        ...process.env,
        LOOM_SESSION_MAX_LOADED: '4',
        LOOM_SESSION_MEMORY_MB: '384',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let output = '';
  let stage = 'starting child';
  let result: FixtureResult | undefined;
  let timedOut = false;
  const remember = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8_000);
  };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    if ('stage' in message) stage = String(message.stage);
    if ('type' in message && message.type === 'result') result = message as FixtureResult;
  });
  // The bug starves the child's event loop, including its timers and test
  // timeouts. Only this separate process can enforce a reliable deadline.
  const watchdog = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 40_000);
  const done = new Promise<FixtureResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(watchdog);
      if (timedOut || code !== 0 || !result) {
        reject(
          new Error(
            `Capacity fixture ${scenario} ${timedOut ? 'timed out' : 'failed'} at ${stage} (${code ?? signal}).\n${output}`,
          ),
        );
      } else resolve(result);
    });
  });
  t.after(async () => {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done.catch(() => {});
    // The parent also removes files after an unresponsive child is killed.
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  return done;
}

for (const [scenario, name] of [
  ['resident', 'six waiting conversations make progress through one newly available resident slot'],
  ['temporary', 'six preparing conversations make progress through one temporary allowance'],
  [
    'interrupted',
    'paused and cancelled waiters do not prevent six other conversations progressing',
  ],
] as const) {
  test(name, { timeout: 50_000 }, async (t) => {
    const result = await runFixture(t, scenario);
    assert.equal(result.waitingAtRelease, 6);
    assert.equal(result.completedWaiters, 6);
    assert.equal(new Set(result.requestedWaiters).size, 6);
    if (scenario !== 'temporary')
      assert.deepEqual(
        result.requestedWaiters,
        result.expectedWaiters,
        'FIFO grants retain progress',
      );
    else assert.deepEqual([...result.requestedWaiters].sort(), [...result.expectedWaiters].sort());
    assert.equal(result.healthStatus, 200);
    assert.equal(result.eventLoopResponded, true);
    assert.equal(result.cancellationPreserved, true);
    assert.equal(result.pausePreserved, true);
    assert.deepEqual(result.memory, {
      resident: { bytes: 0, count: 0, waiting: 0 },
      temporary: { bytes: 0, count: 0, waiting: 0 },
    });
    assert.equal(result.queue.active, 0);
    assert.equal(result.queue.waiting, 0);
  });
}
