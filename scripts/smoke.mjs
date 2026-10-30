import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
const dataDir = await mkdtemp(join(tmpdir(), 'loom-production-'));
const token = `smoke-${randomUUID()}`;
const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'dist/server/index.js'], {
  env: {
    ...process.env,
    LOOM_HOST: '127.0.0.1',
    LOOM_PORT: String(port),
    LOOM_DATA_DIR: dataDir,
    LOOM_API_TOKEN: token,
    LOOM_DEV: '0',
    LOOM_MODEL_BASE_URL: '',
    LOOM_MODEL_ID: '',
    LOOM_MODEL_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
let output = '';
child.stdout.on('data', (chunk) => {
  output = (output + chunk).slice(-10_000);
});
child.stderr.on('data', (chunk) => {
  output = (output + chunk).slice(-10_000);
});
const origin = `http://127.0.0.1:${port}`;
try {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) break;
    } catch {
      /* Wait for the production entry point. */
    }
    if (child.exitCode !== null || Date.now() > deadline)
      throw new Error(`Production server did not start.\n${output}`);
    await delay(75);
  }
  const health = await (await fetch(`${origin}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.configured, false);
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Agent Loom/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((match) => match[1]);
  assert.ok(assets.some((asset) => asset.endsWith('.js')));
  for (const asset of new Set(assets)) {
    const response = await fetch(`${origin}${asset}`);
    assert.equal(response.status, 200, asset);
    assert.match(
      response.headers.get('content-type') || '',
      asset.endsWith('.css') ? /css/ : /javascript/,
      asset,
    );
    assert.match(response.headers.get('cache-control') || '', /immutable/, asset);
  }
  const characters = ['aster', 'nova', 'orbit', 'moss'];
  let avatarBytes = 0;
  for (const character of characters) {
    const asset = `/avatars/${character}.webp`;
    const response = await fetch(`${origin}${asset}`);
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get('content-type') || '', /^image\/webp(?:;|$)/i, asset);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length >= 1_024 && bytes.length <= 128 * 1_024, `${asset}: bounded asset size`);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', asset);
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP', asset);
    assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, `${asset}: complete WebP container`);
    avatarBytes += bytes.length;
  }
  assert.ok(avatarBytes <= 256 * 1_024, 'Bundled avatars remain lightweight');
  assert.equal((await fetch(`${origin}/api/state`)).status, 401);
  const state = await (
    await fetch(`${origin}/api/state`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  assert.equal(state.bots.length, 2);
  assert.equal(state.bots.find((bot) => bot.id === 'bot_aster')?.avatar, 'character:aster');
  assert.equal(state.bots.find((bot) => bot.id === 'bot_nova')?.avatar, 'character:nova');
  assert.equal(state.messages.length, 0);
  console.log(
    `Production HTTP smoke passed: health, HTML, ${new Set(assets).size} compiled assets, ${characters.length} WebP character avatars (${avatarBytes.toLocaleString('en-US')} bytes), authentication, and initial state.`,
  );
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
  force.unref();
  await exited;
  clearTimeout(force);
  await rm(dataDir, { recursive: true, force: true });
}
