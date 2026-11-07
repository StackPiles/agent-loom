import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import ts from 'typescript';
import { writeBuildVersion } from '../scripts/build-version.mjs';
import { createApp } from '../src/server/app.js';
import { VERSION } from '../src/server/controller.js';

const run = promisify(execFile);

async function temporaryDirectory(t: TestContext, prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function compiledFixture(t: TestContext, version: string) {
  const root = await temporaryDirectory(t, 'loom-built-version-');
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', version }));
  const source = await readFile(new URL('../src/server/version.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
  }).outputText;
  const server = join(root, 'dist', 'server');
  await mkdir(server, { recursive: true });
  const module = join(server, 'version.js');
  await writeFile(module, compiled);
  return {
    root,
    read: () =>
      run(process.execPath, [
        '--input-type=module',
        '-e',
        `import { VERSION } from ${JSON.stringify(pathToFileURL(module).href)}; process.stdout.write(VERSION);`,
      ]),
  };
}

test('source runtime health, snapshots and update metadata use the package version', async (t) => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, metadata.version);
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-source-version-'));
  const f = await createApp({ dataDir, scheduler: false });
  t.after(async () => {
    await f.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const health = await f.app.inject({ url: '/api/health' });
  const state = await f.app.inject({ url: '/api/state' });
  const updates = await f.app.inject({ url: '/api/updates' });
  assert.equal(health.statusCode, 200);
  assert.equal(state.statusCode, 200);
  assert.equal(updates.statusCode, 200);
  assert.equal(health.json().version, metadata.version);
  assert.equal(state.json().version, metadata.version);
  assert.equal(updates.json().current.version, metadata.version);
});

test('production version stays tied to its build after the source package changes', async (t) => {
  const f = await compiledFixture(t, '9.8.7');
  await writeBuildVersion(f.root);
  assert.equal((await f.read()).stdout, '9.8.7');
  await writeFile(
    join(f.root, 'package.json'),
    JSON.stringify({ type: 'module', version: '9.8.8' }),
  );
  assert.equal(
    (await f.read()).stdout,
    '9.8.7',
    'A source-only update cannot relabel the old build',
  );
  await writeBuildVersion(f.root);
  assert.equal((await f.read()).stdout, '9.8.8');
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'dist', 'build-info.json'), 'utf8')), {
    version: '9.8.8',
  });
});

test('production requires valid build metadata instead of falling back to the source package', async (t) => {
  const f = await compiledFixture(t, '9.8.7');
  const rejects = () =>
    assert.rejects(f.read(), (error: Error & { stderr?: string }) => {
      assert.match(error.stderr || '', /build version metadata is missing or invalid/);
      assert.match(error.stderr || '', /Run npm run build/);
      return true;
    });
  await rejects();
  for (const content of ['{', JSON.stringify({ version: 987 }), JSON.stringify({ version: '' })]) {
    await writeFile(join(f.root, 'dist', 'build-info.json'), content);
    await rejects();
  }
  await writeFile(
    join(f.root, 'package.json'),
    JSON.stringify({ type: 'module', version: 'invalid' }),
  );
  await assert.rejects(writeBuildVersion(f.root), /valid version/);
});
