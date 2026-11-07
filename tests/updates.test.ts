import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApplicationUpdates } from '../src/server/updates.js';
import type { UpdateJob } from '../src/shared/updates.js';

const CURRENT = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

function fixture(
  input: {
    version?: string;
    currentVersion?: string;
    currentCommit?: string | null;
    protocol?: number;
    conclusion?: string | null;
    status?: string;
    workflowSha?: string;
    supported?: boolean;
  } = {},
) {
  const urls: string[] = [];
  let time = Date.parse('2026-11-04T10:00:00Z');
  let offline = false;
  let job: UpdateJob | undefined;
  const installRequests: UpdateJob[] = [];
  const currentCommit = input.currentCommit === null ? undefined : (input.currentCommit ?? CURRENT);
  const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url);
    urls.push(path);
    assert.equal(options?.redirect, 'error');
    assert.equal(Object.hasOwn(options?.headers ?? {}, 'Authorization'), false);
    if (offline) throw new Error('proxy password = never-expose-this');
    if (path.endsWith('/commits/main'))
      return Response.json({ sha: NEXT, commit: { committer: { date: '2026-11-04T09:00:00Z' } } });
    if (path.includes('/contents/package.json')) {
      assert.ok(path.endsWith(`?ref=${NEXT}`), 'metadata is pinned to the observed commit');
      return Response.json({
        encoding: 'base64',
        content: Buffer.from(
          JSON.stringify({
            version: input.version ?? '0.6.0',
            loomUpdateProtocol: input.protocol ?? 1,
          }),
        ).toString('base64'),
      });
    }
    assert.ok(path.includes(`head_sha=${NEXT}`));
    return Response.json({
      workflow_runs: [
        {
          head_sha: input.workflowSha ?? NEXT,
          head_branch: 'main',
          event: 'push',
          status: input.status ?? 'completed',
          conclusion: input.conclusion === undefined ? 'success' : input.conclusion,
        },
      ],
    });
  }) as typeof fetch;
  const service = new ApplicationUpdates({
    version: input.currentVersion ?? '0.6.0',
    commit: currentCommit,
    supervised: true,
    clock: () => time,
    fetcher,
    inspect: async () => ({
      installation: {
        kind: 'managed-git',
        canUpdate: input.supported !== false,
        reason: 'Manual installation',
      },
      commit: currentCommit,
    }),
    readJob: async () => job,
    requestInstall: async (next) => {
      installRequests.push(next);
      job = next;
    },
  });
  return {
    service,
    urls,
    installRequests,
    advance: () => {
      time += 60_001;
    },
    offline: () => {
      offline = true;
    },
  };
}

test('update discovery pins metadata and CI to one commit, includes same-version fixes, and caches checks', async () => {
  const f = fixture();
  const initial = await f.service.info();
  assert.equal(initial.latest, undefined);
  assert.equal(initial.checkedAt, undefined);
  assert.equal(f.urls.length, 0);
  const [info, duplicate] = await Promise.all([f.service.check(), f.service.check()]);
  assert.equal(info.available, true);
  assert.equal(info.latest?.version, '0.6.0');
  assert.equal(info.latest?.commit, NEXT);
  assert.equal(info.latest?.checks, 'passed');
  assert.equal(info.current.commit, CURRENT);
  assert.equal(info.checkedAt, duplicate.checkedAt);
  assert.equal(f.urls.length, 3, 'concurrent windows share one network check');
  await f.service.check();
  await f.service.info();
  assert.equal(f.urls.length, 3);
});

test('pending, failed, or unrelated CI never authorizes installation', async () => {
  for (const input of [
    { status: 'in_progress', conclusion: null },
    { conclusion: 'failure' },
    { workflowSha: OTHER },
  ]) {
    const f = fixture(input);
    const info = await f.service.check();
    assert.equal(info.available, true);
    await assert.rejects(f.service.prepare(NEXT), /CI checks have not passed/);
  }
});

test('a known installed revision cannot be offered or sent for installation because its runtime version differs', async () => {
  const f = fixture({ currentVersion: '0.8.3', version: '0.8.4', currentCommit: NEXT });
  const info = await f.service.check();
  assert.equal(info.current.commit, info.latest!.commit);
  assert.equal(info.current.version, '0.8.3');
  assert.equal(info.latest!.version, '0.8.4');
  assert.equal(info.available, false);
  await assert.rejects(async () => {
    const job = await f.service.prepare(NEXT);
    await f.service.request(job);
  }, /update target changed/i);
  assert.equal(f.installRequests.length, 0, 'The identical revision never reaches the launcher');
});

test('an installation reporting an older runtime version can install a newer distinct revision', async () => {
  const f = fixture({ currentVersion: '0.8.3', version: '0.8.5' });
  const info = await f.service.check();
  assert.equal(info.available, true);
  const job = await f.service.prepare(NEXT);
  assert.equal(job.previousSha, CURRENT);
  assert.equal(job.targetSha, NEXT);
  assert.equal(job.targetVersion, '0.8.5');
  await f.service.request(job);
  assert.deepEqual(f.installRequests, [job]);
  assert.equal((await f.service.info()).job?.id, job.id);
});

test('unknown revisions retain version discovery without offering a downgrade or an unverifiable same-version fix', async () => {
  for (const [currentVersion, version, available] of [
    ['0.8.3', '0.8.4', true],
    ['0.8.4', '0.8.4', false],
    ['0.8.5', '0.8.4', false],
  ] as const) {
    const f = fixture({ currentVersion, version, currentCommit: null, supported: false });
    const info = await f.service.check();
    assert.equal(info.current.commit, undefined);
    assert.equal(info.available, available);
    await assert.rejects(f.service.prepare(NEXT), /Manual installation/);
    assert.equal(f.installRequests.length, 0);
  }
});

test('pending CI is rechecked after a minute while verified metadata keeps its normal cache', async () => {
  const pending = fixture({ status: 'in_progress', conclusion: null });
  await pending.service.check();
  pending.advance();
  await pending.service.check();
  assert.equal(pending.urls.length, 6);
  const verified = fixture();
  await verified.service.check();
  verified.advance();
  await verified.service.check();
  assert.equal(verified.urls.length, 3);
});

test('GitHub rate limits are respected even when multiple windows request a forced check', async () => {
  let time = Date.parse('2026-11-04T10:00:00Z');
  let requests = 0;
  const service = new ApplicationUpdates({
    version: '0.6.0',
    clock: () => time,
    inspect: async () => ({ installation: { kind: 'standalone', canUpdate: false } }),
    fetcher: (async () => {
      requests++;
      return new Response('', { status: 429, headers: { 'retry-after': '3600' } });
    }) as typeof fetch,
  });
  assert.match((await service.check()).checkError!, /temporarily limited/);
  time += 60_000;
  await service.check(true);
  assert.equal(requests, 1);
  time += 3_600_000;
  await service.check(true);
  assert.equal(requests, 2);
});

test('offline checks retain the previous result, expose uncertainty, and prevent installation', async () => {
  const f = fixture();
  const previous = await f.service.check();
  f.advance();
  f.offline();
  const info = await f.service.check(true);
  assert.equal(info.latest?.commit, NEXT);
  assert.equal(info.checkedAt, previous.checkedAt);
  assert.match(info.checkError!, /could not be verified/);
  assert.doesNotMatch(JSON.stringify(info), /never-expose/);
  await assert.rejects(f.service.prepare(NEXT), /could not be verified/);
});

test('installation binds the exact reviewed SHA, protocol, and installation capability', async () => {
  await assert.rejects(fixture().service.prepare(OTHER), /target changed/);
  await assert.rejects(fixture({ protocol: 0 }).service.prepare(NEXT), /manual update/);
  await assert.rejects(fixture({ supported: false }).service.prepare(NEXT), /Manual installation/);
  const f = fixture({ version: '0.5.0' });
  assert.equal(
    (await f.service.check()).available,
    false,
    'newer local versions are not downgraded',
  );
  await assert.rejects(f.service.prepare(NEXT), /target changed/);
});

test('one request ID produces one durable installation receipt and cannot be retargeted', async () => {
  const f = fixture();
  const id = randomUUID();
  const job = await f.service.prepare(NEXT, id);
  assert.equal(job.id, id);
  await f.service.request(job);
  assert.deepEqual(await f.service.prepare(NEXT, id), job);
  await assert.rejects(f.service.prepare(OTHER, id), /different version/);
  await assert.rejects(f.service.prepare(NEXT, randomUUID()), /already in progress/);
});

test('a restarted service reads bounded, schema-validated supervisor results', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'loom-update-result-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = join(root, 'status.json');
  const job: UpdateJob = {
    id: randomUUID(),
    targetSha: NEXT,
    targetVersion: '0.6.0',
    previousSha: CURRENT,
    phase: 'failed',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: 'The build failed.',
    rolledBack: true,
  };
  await writeFile(stateFile, JSON.stringify({ ...job, secret: 'must-not-be-returned' }));
  const service = new ApplicationUpdates({
    version: '0.6.0',
    stateFile,
    inspect: async () => ({ installation: { kind: 'standalone', canUpdate: false } }),
  });
  assert.deepEqual((await service.info()).job, job);
  await writeFile(
    stateFile,
    JSON.stringify({ ...job, targetSha: '../unexpected', error: 'x'.repeat(33_000) }),
  );
  assert.equal((await service.info()).job, undefined);
});
