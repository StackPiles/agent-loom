import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';

test('credential operation fingerprints survive restart and stay bound to the store and scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-service-fingerprints-'));
  let first: Store | undefined;
  let other: Store | undefined;
  try {
    first = new Store(join(directory, 'first'));
    other = new Store(join(directory, 'other'));
    const credential = ' synthetic-service-credential-with-whitespace \n';
    const scope = 'service-account-credential';
    const fingerprint = first.secretFingerprint(scope, credential);
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.notEqual(first.secretFingerprint(scope, credential.trim()), fingerprint);
    assert.notEqual(first.secretFingerprint(scope, ''), fingerprint);
    assert.notEqual(first.secretFingerprint('another-purpose', credential), fingerprint);
    assert.notEqual(other.secretFingerprint(scope, credential), fingerprint);
    assert.equal(first.db.prepare('SELECT COUNT(*) AS count FROM secrets').get()!.count, 0);

    first.close();
    first = new Store(join(directory, 'first'));
    assert.equal(first.secretFingerprint(scope, credential), fingerprint);
    assert.equal(first.db.prepare('SELECT COUNT(*) AS count FROM secrets').get()!.count, 0);
  } finally {
    first?.close();
    other?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
