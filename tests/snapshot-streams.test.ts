import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { EventStreams } from '../src/server/event-streams.js';
import { applyEvent } from '../src/client/api.js';
import type { Message, Room, ServerEvent, Snapshot, SnapshotPatch } from '../src/shared/types.js';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-snapshot-stream-'));
  const context = await createApp({
    dataDir,
    scheduler: false,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  t.after(async () => {
    await context.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return context;
}

async function until(condition: () => boolean, label: string, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await delay(10);
  }
}

function nextPatch(events: EventEmitter, mutate: () => void) {
  return new Promise<SnapshotPatch>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let received: SnapshotPatch | undefined;
    let mutating = true;
    const cleanup = () => {
      clearTimeout(timeout);
      events.off('state_patch', onPatch);
    };
    const onPatch = (patch: SnapshotPatch) => {
      received = patch;
      cleanup();
      if (!mutating) resolve(patch);
    };
    events.once('state_patch', onPatch);
    try {
      mutate();
      mutating = false;
      if (received !== undefined) {
        resolve(received);
      } else {
        // Synchronous fixture writes must not consume the event delivery deadline.
        timeout = setTimeout(() => {
          cleanup();
          reject(new Error('No incremental state update.'));
        }, 2000);
      }
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function stream(url: string) {
  const abort = new AbortController();
  const response = await fetch(url, {
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: ServerEvent[] = [];
  let buffer = '';
  let state: Snapshot | null = null;
  return {
    events,
    get state() {
      return state;
    },
    async readUntil(condition: () => boolean) {
      while (!condition()) {
        const next = await reader.read();
        assert.equal(next.done, false, 'stream closed before the expected state');
        buffer += decoder.decode(next.value, { stream: true });
        for (let end; (end = buffer.indexOf('\n\n')) !== -1;) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (!data) continue;
          const event = JSON.parse(data.slice(6)) as ServerEvent;
          events.push(event);
          state = applyEvent(state, event);
        }
      }
    },
    async close() {
      await reader.cancel().catch(() => {});
      abort.abort();
    },
  };
}

test('changes without a connected UI do not build or parse a full snapshot', async (t) => {
  const { controller, store } = await fixture(t);
  const snapshot = t.mock.method(controller, 'getSnapshot', () => {
    throw new Error('No UI requested a snapshot.');
  });
  const list = t.mock.method(store, 'list');
  controller.changed();
  await delay(140);
  assert.equal(snapshot.mock.callCount(), 0);
  assert.equal(
    list.mock.calls.filter((call) => ['messages', 'activities'].includes(call.arguments[0])).length,
    0,
  );
});

test('protocol 2 keeps two rooms, tasks, settings and streamed output current without rereading history', async (t) => {
  const { app, controller, store, eventStreams } = await fixture(t);
  const room = store.get<Room>('rooms', 'room_lounge')!;
  store.put('rooms', { ...room, id: 'room_second', name: 'Second room' });
  store.put('settings', { ...store.settings(), id: 'main', demoMode: true });
  for (let index = 0; index < 16; index++)
    store.put<Message>('messages', {
      id: `old_${index.toString().padStart(2, '0')}`,
      roomId: room.id,
      authorType: 'bot',
      authorId: 'bot_aster',
      body: 'old history '.repeat(8192),
      status: 'complete',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  const snapshot = t.mock.method(controller, 'getSnapshot');
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = await stream(`${address}/api/events?protocol=2`);
  t.after(() => client.close());
  await client.readUntil(() => client.state !== null);
  assert.equal(client.state!.messages.length, 16);
  assert.equal(snapshot.mock.callCount(), 1);
  const list = t.mock.method(store, 'list');

  const task = controller.enqueueTask({
    roomId: room.id,
    botId: 'bot_aster',
    prompt: 'First task',
  });
  const second = controller.enqueueTask({
    roomId: 'room_second',
    botId: 'bot_nova',
    prompt: 'Second task',
  });
  const message = controller.addMessage({
    roomId: room.id,
    taskId: task.id,
    authorType: 'bot',
    authorId: task.botId,
    body: '',
    status: 'streaming',
  });
  const secondMessage = controller.addMessage({
    roomId: second.roomId,
    taskId: second.id,
    authorType: 'bot',
    authorId: second.botId,
    body: 'Second answer',
    status: 'complete',
  });
  const approvalAbort = new AbortController();
  const approval = controller.requestApproval(
    {
      taskId: task.id,
      roomId: room.id,
      botId: task.botId,
      toolName: 'write_file',
      summary: 'Review the exact update',
      target: 'result.txt',
      args: { path: 'result.txt', content: 'The reviewable content' },
    },
    approvalAbort.signal,
  );
  controller.appendMessage(message.id, 'A streamed answer');
  controller.appendReasoning(message.id, 'Visible reasoning');
  controller.updateMessage(message.id, { status: 'complete', reasoningStatus: 'complete' });
  controller.updateTask(task.id, { status: 'completed' });
  store.patch('rooms', second.roomId, { name: 'Renamed second room' });
  store.setSecret('model.apiKey', 'secret-must-not-be-in-events');
  store.patch('settings', 'main', { autoLearn: false });
  store.remove('messages', 'old_00');
  controller.changed();
  // Startup can flush a queue-only patch while the large initial snapshot is
  // still arriving. Wait for this mutation's receipt, not an unrelated patch.
  const isMessagePatch = (event: ServerEvent) =>
    event.type === 'state_patch' &&
    (event.data as SnapshotPatch).collections.messages?.upsert.some(
      (value) => value.id === message.id,
    );
  await client.readUntil(() => client.events.some(isMessagePatch));
  assert.equal(snapshot.mock.callCount(), 1, 'updates must not build another full snapshot');
  assert.equal(
    list.mock.calls.filter((call) => ['messages', 'activities'].includes(call.arguments[0])).length,
    0,
  );
  assert.equal(
    client.state!.messages.find((value) => value.id === message.id)?.body,
    'A streamed answer',
  );
  assert.equal(
    client.state!.messages.find((value) => value.id === message.id)?.reasoning,
    'Visible reasoning',
  );
  assert.ok(client.state!.messages.some((value) => value.id === secondMessage.id));
  assert.ok(!client.state!.messages.some((value) => value.id === 'old_00'));
  assert.equal(
    client.state!.rooms.find((value) => value.id === second.roomId)?.name,
    'Renamed second room',
  );
  assert.equal(client.state!.tasks.find((value) => value.id === task.id)?.status, 'completed');
  assert.equal(client.state!.settings.autoLearn, false);
  assert.equal(client.state!.settings.model.apiKeyConfigured, true);
  assert.deepEqual(client.state!.approvals[0]?.args, {
    path: 'result.txt',
    content: 'The reviewable content',
  });
  assert.ok(!JSON.stringify(client.events).includes('secret-must-not-be-in-events'));
  const patch = client.events.find(isMessagePatch)!.data as SnapshotPatch;
  assert.equal(patch.collections.messages?.upsert.length, 2, 'old messages are not retransmitted');
  assert.ok(Buffer.byteLength(JSON.stringify(patch)) < 16 * 1024);

  // A reverted write must publish the committed record, not its transient value.
  store.db.exec('BEGIN');
  store.patch('messages', message.id, { body: 'uncommitted secret' });
  store.db.exec('ROLLBACK');
  controller.changed();
  const count = client.events.filter((event) => event.type === 'state_patch').length;
  await client.readUntil(
    () => client.events.filter((event) => event.type === 'state_patch').length > count,
  );
  assert.equal(
    client.state!.messages.find((value) => value.id === message.id)?.body,
    'A streamed answer',
  );
  assert.ok(!JSON.stringify(client.events).includes('uncommitted secret'));
  assert.deepEqual(client.state, JSON.parse(JSON.stringify(controller.getSnapshot())));
  approvalAbort.abort();
  await approval;

  await client.close();
  await until(() => eventStreams.diagnostics().clientCount === 0, 'SSE client cleanup');
  assert.equal(controller.events.listenerCount('state_patch'), 0);
  controller.updateMessage(secondMessage.id, { body: 'Updated while disconnected' });
  const reconnected = await stream(`${address}/api/events?protocol=2`);
  t.after(() => reconnected.close());
  await reconnected.readUntil(() => reconnected.state !== null);
  assert.equal(
    reconnected.state!.messages.find((value) => value.id === secondMessage.id)?.body,
    'Updated while disconnected',
  );
});

test('incremental account and task-input projections omit private stored fields', async (t) => {
  const { controller, store, mail } = await fixture(t);
  const patch = await nextPatch(controller.events, () => {
    const stamp = new Date().toISOString();
    store.setSecret('service.service_test.credential', 'hidden-service-password');
    store.put('serviceAccounts', {
      id: 'service_test',
      name: 'Test service',
      url: 'https://example.invalid',
      login: 'test',
      botId: null,
      sharedBotIds: [],
      mailAccountId: null,
      status: 'active',
      notes: '',
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
      credential: 'hidden-extra-stored-credential',
    });
    store.put('taskInputs', {
      id: 'input_test',
      taskId: 'task_test',
      body: 'Visible additional instruction',
      createdAt: stamp,
      requestFingerprint: 'hidden-task-input-fingerprint',
    });
    mail.save({
      name: 'Test mailbox',
      address: 'test@example.invalid',
      provider: 'imap',
      imap: {
        host: 'imap.example.invalid',
        port: 993,
        secure: true,
        user: 'test',
        mailbox: 'INBOX',
        password: 'hidden-mail-password',
      },
      smtp: {
        host: 'smtp.example.invalid',
        port: 465,
        secure: true,
        user: 'test',
        password: 'hidden-smtp-password',
      },
    });
    controller.changed();
  });
  const text = JSON.stringify(patch);
  for (const hidden of [
    'hidden-service-password',
    'hidden-extra-stored-credential',
    'hidden-task-input-fingerprint',
    'hidden-mail-password',
    'hidden-smtp-password',
  ])
    assert.ok(!text.includes(hidden));
  assert.equal(patch.collections.serviceAccounts!.upsert[0].credentialConfigured, true);
  assert.equal(patch.collections.mailAccounts!.upsert[0].imap!.passwordConfigured, true);
  assert.deepEqual(patch.collections.taskInputs!.upsert, controller.getSnapshot().taskInputs);
  assert.deepEqual(
    patch.collections.serviceAccounts!.upsert,
    controller.getSnapshot().serviceAccounts,
  );
  assert.deepEqual(patch.collections.mailAccounts!.upsert, controller.getSnapshot().mailAccounts);
});

test('patch ordering matches persisted history even with restored dates, missing dates and clock reversal', async (t) => {
  const { controller, store } = await fixture(t);
  const message = {
    roomId: 'room_lounge',
    authorType: 'user',
    authorId: 'user',
    body: 'before',
    status: 'complete',
  };
  store.put('messages', { ...message, id: 'message_z', createdAt: '1900-01-01T00:00:00.000Z' });
  store.put('messages', { ...message, id: 'message_a', createdAt: '2099-01-01T00:00:00.000Z' });
  store.put('messages', { ...message, id: 'message_missing' });
  const created = (kind: string, id: string, date: string) =>
    store.db.prepare('UPDATE objects SET created_at=? WHERE kind=? AND id=?').run(date, kind, id);
  created('messages', 'message_z', '2026-01-02T00:00:00.000Z');
  created('messages', 'message_a', '2026-01-01T00:00:00.000Z');
  created('messages', 'message_missing', '2026-01-01T00:00:00.000Z');
  const notification = { title: 'Notice', body: 'before', read: false };
  store.put('notifications', {
    ...notification,
    id: 'notice_z',
    createdAt: '1900-01-01T00:00:00.000Z',
  });
  store.put('notifications', {
    ...notification,
    id: 'notice_a',
    createdAt: '2099-01-01T00:00:00.000Z',
  });
  created('notifications', 'notice_z', '2026-01-01T00:00:00.000Z');
  created('notifications', 'notice_a', '2026-01-01T00:00:00.000Z');
  let state = JSON.parse(JSON.stringify(controller.getSnapshot())) as Snapshot;
  assert.deepEqual(
    state.messages.map((value) => value.id),
    ['message_a', 'message_missing', 'message_z'],
  );
  const patch = await nextPatch(controller.events, () => {
    store.patch('messages', 'message_z', { body: 'after' });
    store.patch('messages', 'message_missing', { body: 'still without a date' });
    store.put('messages', {
      ...message,
      id: 'message_early',
      createdAt: '2098-01-01T00:00:00.000Z',
    });
    created('messages', 'message_early', '2025-12-31T00:00:00.000Z');
    for (const id of ['message_same_z', 'message_same_a']) {
      store.put('messages', { ...message, id });
      created('messages', id, '2026-01-01T00:00:00.000Z');
    }
    store.patch('notifications', 'notice_z', { body: 'after' });
    store.put('notifications', { ...notification, id: 'notice_b' });
    created('notifications', 'notice_b', '2026-01-01T00:00:00.000Z');
    controller.changed();
  });
  state = applyEvent(state, {
    id: 1,
    type: 'state_patch',
    data: JSON.parse(JSON.stringify(patch)),
  })!;
  assert.deepEqual(
    state.messages.map((value) => value.id),
    [
      'message_early',
      'message_a',
      'message_missing',
      'message_same_z',
      'message_same_a',
      'message_z',
    ],
  );
  assert.deepEqual(
    state.notifications.map((value) => value.id),
    ['notice_a', 'notice_b', 'notice_z'],
  );
  assert.deepEqual(state, JSON.parse(JSON.stringify(controller.getSnapshot())));
});

class WritableResponse extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  writableEnded = false;
  frames: Buffer[] = [];
  write(value: Buffer) {
    this.frames.push(value);
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit('close');
  }
  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

test('one broadcast is encoded once for multiple tabs and removes all listeners on close', () => {
  const events = new EventEmitter();
  const streams = new EventStreams({
    events,
    getSnapshot: () => ({ version: 'test' }) as Snapshot,
  });
  const first = new WritableResponse();
  const second = new WritableResponse();
  streams.add(first as unknown as ServerResponse, () => true, 2);
  streams.add(second as unknown as ServerResponse, () => true, 2);
  let serialized = 0;
  events.emit('state_patch', {
    toJSON() {
      serialized++;
      return { queue: { active: 1, waiting: 0 }, collections: {} };
    },
  });
  assert.equal(serialized, 1);
  assert.equal(events.listenerCount('state_patch'), 1);
  assert.equal(events.listenerCount('snapshot'), 0);
  assert.equal(events.listenerCount('snapshot_invalidated'), 0);
  assert.equal(first.frames.at(-1)!.buffer, second.frames.at(-1)!.buffer);
  assert.equal(first.frames.at(-1)!.byteOffset, second.frames.at(-1)!.byteOffset);
  assert.equal(
    first.frames.at(-1)!.byteLength,
    second.frames.at(-1)!.byteLength,
    'tabs share the encoded buffer range',
  );
  streams.close();
  assert.equal(streams.diagnostics().clientCount, 0);
  assert.equal(events.eventNames().length, 0);
});

test('a busy legacy stream coalesces full refreshes and sends the latest snapshot after draining', () => {
  const events = new EventEmitter();
  let revision = 0;
  let snapshots = 0;
  const streams = new EventStreams({
    events,
    getSnapshot: () => {
      snapshots++;
      return { version: String(revision) } as Snapshot;
    },
  });
  const response = new WritableResponse();
  response.write = (value) => {
    response.frames.push(value);
    return false;
  };
  streams.add(response as unknown as ServerResponse, () => true, 1);
  for (revision = 1; revision <= 100; revision++) events.emit('snapshot_invalidated');
  assert.equal(snapshots, 1, 'blocked clients must not repeatedly read/encode history');
  assert.equal(streams.diagnostics().pendingBytes, 0);
  response.write = (value) => {
    response.frames.push(value);
    return true;
  };
  response.emit('drain');
  assert.equal(snapshots, 2);
  assert.ok(Buffer.concat(response.frames).toString().includes(`"version":"${revision}"`));
  streams.close();
});

test(
  'a real paused receiver permits a small update queue, disconnects at its bound, and can resync',
  { timeout: 15_000 },
  async (t) => {
    const events = new EventEmitter();
    let revision = 0;
    const streams = new EventStreams(
      {
        events,
        getSnapshot: () =>
          ({
            version: String(revision),
            messages: [{ id: 'large', body: 'x'.repeat(8 * 1024 * 1024) }],
          }) as Snapshot,
      },
      { pendingBytes: 64 * 1024, chunkBytes: 4096, stallMs: 5000 },
    );
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      streams.add(res, () => true, 2);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const socket = connect(address.port, '127.0.0.1');
    t.after(async () => {
      socket.destroy();
      streams.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await once(socket, 'connect');
    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await once(socket, 'data');
    socket.pause();
    await until(() => streams.diagnostics().inFlightBytes > 0, 'blocked initial snapshot');
    revision = 1;
    events.emit('state_patch', { queue: { active: 1, waiting: 0 }, collections: {} });
    assert.equal(
      streams.diagnostics().clientCount,
      1,
      'a change during initial sync must not force a reconnect loop',
    );
    assert.ok(streams.diagnostics().pendingBytes > 0);
    for (let index = 0; index < 40 && streams.diagnostics().clientCount; index++) {
      revision++;
      events.emit('message_delta', { messageId: 'large', delta: 'y'.repeat(8192) });
      assert.ok(streams.diagnostics().pendingBytes <= 64 * 1024);
    }
    assert.equal(streams.diagnostics().clientCount, 0);
    assert.equal(streams.diagnostics().pendingBytes, 0);
    assert.equal(events.listenerCount('state_patch'), 0);

    const fresh = await stream(`http://127.0.0.1:${address.port}/`);
    t.after(() => fresh.close());
    events.emit('state_patch', { queue: { active: 2, waiting: 0 }, collections: {} });
    await fresh.readUntil(() => fresh.events.some((event) => event.type === 'state_patch'));
    assert.equal(fresh.state!.version, String(revision), 'reconnection receives current state');
    assert.equal(
      fresh.state!.queue.active,
      2,
      'an update queued during the large initial frame arrives after it',
    );
    await fresh.close();
  },
);

test('a silent stalled response is closed and releases its frame after the drain deadline', async () => {
  const events = new EventEmitter();
  const streams = new EventStreams(
    { events, getSnapshot: () => ({ version: 'test' }) as Snapshot },
    { stallMs: 40 },
  );
  const response = new WritableResponse();
  response.write = () => false;
  streams.add(response as unknown as ServerResponse, () => true, 2);
  assert.equal(streams.diagnostics().clientCount, 1);
  await until(() => streams.diagnostics().clientCount === 0, 'stalled stream timeout', 1000);
  assert.equal(response.destroyed, true);
  assert.equal(events.eventNames().length, 0);
});

test('revoking access discards queued events before another drain can send them', () => {
  const events = new EventEmitter();
  const streams = new EventStreams({
    events,
    getSnapshot: () => ({ version: 'test' }) as Snapshot,
  });
  const response = new WritableResponse();
  let authorized = true;
  response.write = (value) => {
    response.frames.push(value);
    response.writableLength += value.length;
    return false;
  };
  streams.add(response as unknown as ServerResponse, () => authorized, 2);
  events.emit('message_delta', { messageId: 'x', delta: 'queued private data' });
  assert.ok(streams.diagnostics().pendingBytes > 0);
  const written = response.frames.length;
  authorized = false;
  streams.closeUnauthorized();
  response.emit('drain');
  assert.equal(response.frames.length, written);
  assert.equal(response.destroyed, true);
  assert.equal(streams.diagnostics().clientCount, 0);
});
