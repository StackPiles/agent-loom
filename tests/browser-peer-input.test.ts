import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { bufferBrowserPeerInput } from '../src/server/browser-peer-input.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('startup input observes real EOF before the MCP transport exists', async () => {
  const input = new PassThrough();
  let ended = 0;
  let overflowed = 0;
  const buffering = bufferBrowserPeerInput(input, {
    onEof: () => ++ended,
    onOverflow: () => ++overflowed,
  });
  input.end(Buffer.from('{"method":"initialize"}\n'));
  await tick();
  assert.equal(ended, 1);
  assert.equal(overflowed, 0);
  assert.throws(() => buffering.replay(), /closed before the MCP handshake/);
  input.destroy();
  await tick();
  assert.equal(ended, 1, 'end and close must not run shutdown twice');
  assert.equal(input.listenerCount('data'), 0);
});

test('startup chunks replay byte-exactly once before subsequent live protocol data', async () => {
  const input = new PassThrough();
  let ended = 0;
  const buffering = bufferBrowserPeerInput(input, {
    onEof: () => ++ended,
    onOverflow: () => assert.fail('bounded initialization must fit'),
  });
  const request = Buffer.from('{"method":"initialize","name":"日本語 😀"}\n');
  // Split through UTF-8 code points and JSON tokens, like arbitrary pipe reads.
  for (let offset = 0; offset < request.length; offset += 5)
    input.write(request.subarray(offset, offset + 5));
  await tick();
  buffering.replay();
  buffering.replay();
  const received: Buffer[] = [];
  input.on('data', (chunk: Buffer) => received.push(Buffer.from(chunk)));
  // An explicitly paused stream does not flow merely because a listener exists.
  await tick();
  assert.equal(received.length, 0);
  buffering.resume();
  buffering.resume();
  const next = Buffer.from('{"method":"notifications/initialized"}\n');
  const finished = once(input, 'end');
  input.end(next);
  await finished;
  assert.deepEqual(Buffer.concat(received), Buffer.concat([request, next]));
  assert.equal(ended, 0, 'after replay the installed transport owns EOF');
  buffering.dispose();
});

test('startup buffering has a byte limit and stops reading after overflow', async () => {
  const input = new PassThrough();
  let ended = 0;
  let overflowed = 0;
  const buffering = bufferBrowserPeerInput(input, {
    maximumBytes: 6,
    onEof: () => ++ended,
    onOverflow: () => ++overflowed,
  });
  input.write(Buffer.from('日本'));
  await tick();
  assert.equal(overflowed, 0, 'the exact byte limit is accepted');
  input.write(Buffer.from('a'));
  await tick();
  assert.equal(overflowed, 1);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.isPaused(), true);
  input.write(Buffer.alloc(32));
  input.destroy();
  await tick();
  assert.equal(overflowed, 1);
  assert.equal(ended, 0);
  assert.throws(() => buffering.replay(), /closed before the MCP handshake/);
});

test('disposal removes only startup listeners and prevents further capture', async () => {
  const input = new PassThrough();
  let helperCalls = 0;
  let otherCloseCalls = 0;
  input.on('close', () => ++otherCloseCalls);
  const buffering = bufferBrowserPeerInput(input, {
    maximumBytes: 2,
    onEof: () => ++helperCalls,
    onOverflow: () => ++helperCalls,
  });
  buffering.dispose();
  buffering.dispose();
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.listenerCount('end'), 0);
  assert.equal(input.listenerCount('close'), 1);
  input.write(Buffer.alloc(32));
  input.destroy();
  await tick();
  assert.equal(helperCalls, 0);
  assert.equal(otherCloseCalls, 1);
});

test('replay owns copied bytes even if a startup writer reuses its buffer', async () => {
  const input = new PassThrough();
  const buffering = bufferBrowserPeerInput(input, {
    onEof: () => assert.fail('unexpected early EOF'),
    onOverflow: () => assert.fail('unexpected overflow'),
  });
  const original = Buffer.from('initialize\n');
  const expected = Buffer.from(original);
  input.write(original);
  await tick();
  original.fill(0);
  buffering.replay();
  const received: Buffer[] = [];
  input.on('data', (chunk: Buffer) => received.push(Buffer.from(chunk)));
  buffering.resume();
  const finished = once(input, 'end');
  input.end();
  await finished;
  assert.deepEqual(Buffer.concat(received), expected);
});
