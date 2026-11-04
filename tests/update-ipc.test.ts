import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { supervisorUpdateBridge } from '../src/server/update-ipc.js';
import type { UpdateJob } from '../src/shared/updates.js';

type WireMessage = Record<string, unknown>;
class ParentProcess extends EventEmitter {
  connected = true;
  readonly messages: WireMessage[] = [];
  send: ((message: object, callback: (error: Error | null) => void) => boolean) | undefined = (
    message,
    callback,
  ) => {
    this.messages.push(structuredClone(message) as WireMessage);
    callback(null);
    return true;
  };

  disconnect() {
    this.connected = false;
    this.emit('disconnect');
  }

  acknowledge(request: WireMessage, type = 'loom:update:accepted', fields: WireMessage = {}) {
    this.emit('message', { type, requestId: request.requestId, id: request.id, ...fields });
  }
}
function fixture() {
  const parent = new ParentProcess();
  // The bridge must remove only its own listeners; index.ts also listens to these events.
  const otherMessage = () => {};
  const otherDisconnect = () => {};
  parent.on('message', otherMessage);
  parent.on('disconnect', otherDisconnect);
  const bridge = supervisorUpdateBridge(parent as unknown as NodeJS.Process);
  const job: UpdateJob = {
    id: randomUUID(),
    phase: 'preparing',
    targetSha: 'b'.repeat(40),
    previousSha: 'a'.repeat(40),
    targetVersion: '0.6.1',
    startedAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
  };
  const assertCleanedUp = () => {
    assert.deepEqual(parent.listeners('message'), [otherMessage]);
    assert.deepEqual(parent.listeners('disconnect'), [otherDisconnect]);
  };
  return { parent, bridge, job, assertCleanedUp };
}
function observe(promise: Promise<void>) {
  const outcome = { value: 'pending' };
  void promise.then(
    () => {
      outcome.value = 'resolved';
    },
    () => {
      outcome.value = 'rejected';
    },
  );
  return outcome;
}

test('only the matching request and job acknowledgement accepts an update, then removes its listeners', async () => {
  const { parent, bridge, job, assertCleanedUp } = fixture();
  const pending = bridge.requestInstall(job);
  const outcome = observe(pending);
  assert.equal(parent.messages.length, 1);
  const request = parent.messages[0];
  assert.match(String(request.requestId), /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.notEqual(request.requestId, job.id);
  assert.deepEqual(request, {
    type: 'loom:update',
    requestId: request.requestId,
    id: job.id,
    targetSha: job.targetSha,
    targetVersion: job.targetVersion,
  });
  assert.equal(parent.listenerCount('message'), 2);
  assert.equal(parent.listenerCount('disconnect'), 2);

  parent.emit('message', null);
  parent.emit('message', 'an unrelated launcher event');
  parent.acknowledge(request, 'loom:update:accepted', { requestId: randomUUID() });
  parent.acknowledge(request, 'loom:update:accepted', { id: randomUUID() });
  parent.acknowledge(request, 'loom:update:rejected', {
    requestId: randomUUID(),
    error: 'Ignore me.',
  });
  parent.acknowledge(request, 'loom:ready');
  await Promise.resolve();
  assert.equal(outcome.value, 'pending');
  assert.equal(parent.messages.length, 1, 'Unrelated messages must not trigger a resend.');

  parent.acknowledge(request);
  await pending;
  assert.equal(outcome.value, 'resolved');
  assertCleanedUp();
  parent.acknowledge(request, 'loom:update:rejected', { error: 'Late rejection.' });
  parent.disconnect();
  await Promise.resolve();
  assert.equal(outcome.value, 'resolved');
  assert.equal(parent.messages.length, 1, 'Accepting must not automatically proceed or resend.');
  assertCleanedUp();
});

test('a definite rejection preserves a bounded reason and leaves an explicit retry independent of old acknowledgements', async () => {
  const { parent, bridge, job, assertCleanedUp } = fixture();
  const first = bridge.requestInstall(job);
  const reason = 'The checkout changed. '.repeat(150);
  const rejected = assert.rejects(
    first,
    (error: Error & { statusCode?: number; uncertain?: boolean }) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.uncertain, undefined);
      assert.equal(error.message, reason.slice(0, 2_000));
      return true;
    },
  );
  parent.acknowledge(parent.messages[0], 'loom:update:rejected', { error: reason });
  await rejected;
  assertCleanedUp();
  assert.equal(parent.messages.length, 1, 'Rejection must not retry the installation by itself.');

  const retry = bridge.requestInstall(job);
  const outcome = observe(retry);
  assert.equal(parent.messages.length, 2);
  assert.equal(parent.messages[1].id, job.id, 'The durable job ID remains the same.');
  assert.notEqual(parent.messages[1].requestId, parent.messages[0].requestId);
  parent.acknowledge(parent.messages[0]);
  await Promise.resolve();
  assert.equal(
    outcome.value,
    'pending',
    'A late receipt from the first attempt cannot accept its retry.',
  );
  parent.acknowledge(parent.messages[1]);
  await retry;
  assertCleanedUp();
});

test('a rejection without a textual reason produces a definite bounded error', async () => {
  const { parent, bridge, job, assertCleanedUp } = fixture();
  const pending = bridge.requestInstall(job);
  const rejected = assert.rejects(pending, {
    message: 'The update supervisor rejected this update.',
    statusCode: 409,
  });
  parent.acknowledge(parent.messages[0], 'loom:update:rejected', { error: { unexpected: true } });
  await rejected;
  assertCleanedUp();
});

test('disconnect after sending is uncertain, cleans up, and never resends when the parent returns', async () => {
  const { parent, bridge, job, assertCleanedUp } = fixture();
  const pending = bridge.requestInstall(job);
  const rejected = assert.rejects(
    pending,
    (error: Error & { statusCode?: number; uncertain?: boolean }) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.uncertain, true);
      assert.match(error.message, /not confirmed/);
      return true;
    },
  );
  parent.disconnect();
  await rejected;
  assertCleanedUp();
  parent.connected = true;
  parent.emit('message', { type: 'loom:ready' });
  parent.acknowledge(parent.messages[0]);
  await Promise.resolve();
  assert.equal(parent.messages.length, 1);
  assertCleanedUp();
});

test('an unavailable IPC channel fails definitively before sending and does not leak listeners', async () => {
  for (const unavailable of ['disconnected', 'no-send'] as const) {
    const { parent, bridge, job, assertCleanedUp } = fixture();
    if (unavailable === 'disconnected') parent.connected = false;
    else parent.send = undefined;
    await assert.rejects(
      bridge.requestInstall(job),
      (error: Error & { statusCode?: number; uncertain?: boolean }) => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.uncertain, undefined);
        assert.match(error.message, /supervisor is disconnected/);
        return true;
      },
    );
    assert.equal(parent.messages.length, 0);
    assertCleanedUp();
  }
});

test('a missing receipt times out as uncertain without a second install request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { parent, bridge, job, assertCleanedUp } = fixture();
  const pending = bridge.requestInstall(job);
  const outcome = observe(pending);
  const rejected = assert.rejects(pending, { statusCode: 503, uncertain: true });
  t.mock.timers.tick(29_999);
  await Promise.resolve();
  assert.equal(outcome.value, 'pending');
  t.mock.timers.tick(1);
  await rejected;
  assertCleanedUp();
  t.mock.timers.tick(60_000);
  assert.equal(parent.messages.length, 1);
});

test('proceed sends exactly the requested job ID once and tolerates a lost parent', async () => {
  const { parent, bridge, job, assertCleanedUp } = fixture();
  const pending = bridge.requestInstall(job);
  parent.acknowledge(parent.messages[0]);
  await pending;
  bridge.proceed(job.id);
  assert.deepEqual(parent.messages.slice(1), [{ type: 'loom:update:proceed', id: job.id }]);
  assertCleanedUp();
  parent.connected = false;
  assert.doesNotThrow(() => bridge.proceed(job.id));
  assert.equal(parent.messages.length, 2);
  assertCleanedUp();
});
