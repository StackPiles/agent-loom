import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeBrowserCredential,
  encodeBrowserCredential,
} from '../src/server/browser-credential.js';

const channel = 'fixture-credential-channel';
const origin = 'https://login.example.test';
const secret = 'PRIVATE_VALUE_65291_"日本語"\\suffix';

test('private credential transport round-trips exact Unicode and boundary-length values only on its channel', () => {
  for (const value of [secret, '1', 'x'.repeat(16_384)]) {
    const encoded = encodeBrowserCredential(channel, origin, value);
    assert.deepEqual(decodeBrowserCredential(channel, encoded), { origin, value });
    assert.equal(decodeBrowserCredential('another-channel', encoded), undefined);
    assert.equal(decodeBrowserCredential(undefined, encoded), undefined);
  }
  assert.equal(decodeBrowserCredential(channel, 'ordinary input text'), undefined);
});

test('private credential transport rejects malformed payloads and noncanonical or non-web origins without echoing secrets', () => {
  const payloads: unknown[] = [
    null,
    [],
    { origin },
    { origin, value: '' },
    { origin, value: 123 },
    { origin, value: 'x'.repeat(16_385) },
    { origin: 'https://login.example.test/', value: secret },
    { origin: 'https://login.example.test/path', value: secret },
    { origin: 'https://user:password@login.example.test', value: secret },
    { origin: 'https://login.example.test:443', value: secret },
    { origin: 'data:text/html,example', value: secret },
    { origin: 'file:///example', value: secret },
    { origin: 'not a URL', value: secret },
  ];
  const prefix = '\u001eAgentLoom:' + channel + ':';
  for (const input of [prefix + secret, ...payloads.map((data) => prefix + JSON.stringify(data))]) {
    assert.throws(
      () => decodeBrowserCredential(channel, input),
      (error: Error) => {
        assert.equal(error.message, 'The private browser credential input is invalid.');
        assert.ok(!error.stack?.includes(secret));
        assert.ok(!error.stack?.includes(channel));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});
