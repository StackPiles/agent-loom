import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  isActiveUpdate,
  UPDATE_PROTOCOL,
  type UpdateInfo,
  type UpdateInstallation,
  type UpdateJob,
  type UpdateRelease,
} from '../shared/updates.js';

const run = promisify(execFile);
const REPOSITORY = 'StackPiles/agent-loom';
const API = `https://api.github.com/repos/${REPOSITORY}`;
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const CHECK_INTERVAL = 6 * 60 * 60_000;
const RETRY_INTERVAL = 60_000;
const FORCE_INTERVAL = 15_000;
const jobSchema = z.object({
  id: z.string().uuid(),
  phase: z.enum([
    'preparing',
    'stopping',
    'installing',
    'building',
    'verifying',
    'succeeded',
    'failed',
  ]),
  targetSha: z.string().regex(SHA),
  targetVersion: z.string().regex(VERSION),
  previousSha: z.string().regex(SHA),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  error: z.string().max(2_000).optional(),
  rolledBack: z.boolean().optional(),
});

export function updateProblem(message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { statusCode, code: 'update_unavailable' });
}

export interface UpdateOptions {
  version: string;
  root?: string;
  commit?: string;
  supervised?: boolean;
  development?: boolean;
  stateFile?: string;
  fetcher?: typeof fetch;
  clock?: () => number;
  inspect?: () => Promise<{ installation: UpdateInstallation; commit?: string }>;
  readJob?: () => Promise<UpdateJob | undefined>;
  requestInstall?: (job: UpdateJob) => Promise<void>;
  proceed?: (id: string) => void;
}

/** Read-only discovery is separate from the supervisor that owns process replacement. */
export class ApplicationUpdates {
  private readonly root: string;
  private readonly clock: () => number;
  private currentCommit?: string;
  private latest?: UpdateRelease;
  private checkedAt?: string;
  private checkError?: string;
  private lastAttempt = 0;
  private limitedUntil = 0;
  private checking?: Promise<void>;
  private localJob?: UpdateJob;
  private requesting = false;

  constructor(private readonly options: UpdateOptions) {
    this.root = resolve(options.root ?? '.');
    this.clock = options.clock ?? Date.now;
    this.currentCommit = SHA.test(options.commit ?? '') ? options.commit : undefined;
  }

  private async inspect() {
    if (this.options.inspect) return this.options.inspect();
    const git = async (...args: string[]) =>
      (
        await run('git', args, {
          cwd: this.root,
          timeout: 5_000,
          maxBuffer: 256_000,
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        })
      ).stdout.trim();
    const disabled = (kind: UpdateInstallation['kind'], reason: string, commit?: string) => ({
      installation: { kind, canUpdate: false, reason },
      commit,
    });
    if (this.options.development)
      return disabled(
        'development',
        'Development mode: build the app and start it with npm start.',
      );
    if (existsSync('/.dockerenv') && !existsSync(join(this.root, '.git')))
      return disabled('docker', 'Update the container image from the Docker host.');
    try {
      const root = await git('rev-parse', '--show-toplevel');
      const commit = await git('rev-parse', 'HEAD');
      if (resolve(root) !== this.root)
        return disabled('standalone', 'Start Loom from the root of its Git checkout.', commit);
      if (!this.options.supervised || !this.options.requestInstall)
        return disabled(
          'git',
          'Restart the built app with npm start to enable web updates.',
          commit,
        );
      const directory = await lstat(join(this.root, '.git'));
      if (!directory.isDirectory() || directory.isSymbolicLink())
        return disabled('managed-git', 'Linked Git worktrees need a manual update.', commit);
      const [branch, origin, changes] = await Promise.all([
        git('symbolic-ref', '--short', 'HEAD'),
        git('remote', 'get-url', 'origin'),
        git('status', '--porcelain', '--untracked-files=normal'),
      ]);
      if (branch !== 'main')
        return disabled('managed-git', 'Switch to the main branch before updating.', commit);
      if (
        ![
          `https://github.com/${REPOSITORY}.git`,
          `https://github.com/${REPOSITORY}`,
          `git@github.com:${REPOSITORY}.git`,
          `ssh://git@github.com/${REPOSITORY}.git`,
        ].includes(origin)
      )
        return disabled(
          'managed-git',
          'Web updates require the official repository as origin.',
          commit,
        );
      if (changes)
        return disabled(
          'managed-git',
          'The checkout has local changes. Save them before updating.',
          commit,
        );
      if (this.currentCommit && this.currentCommit !== commit)
        return disabled(
          'managed-git',
          'The checkout changed while Loom was running. Restart it first.',
          commit,
        );
      return {
        installation: { kind: 'managed-git', canUpdate: true } as UpdateInstallation,
        commit,
      };
    } catch {
      return disabled(
        this.options.supervised ? 'managed-git' : 'standalone',
        'A clean official Git checkout, Git, and npm start are required for web updates.',
      );
    }
  }

  private async readJob(): Promise<UpdateJob | undefined> {
    if (this.options.readJob) return this.options.readJob();
    if (!this.options.stateFile) return this.localJob;
    try {
      const stat = await lstat(this.options.stateFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) return this.localJob;
      const parsed = jobSchema.safeParse(
        JSON.parse(await readFile(this.options.stateFile, 'utf8')),
      );
      if (!parsed.success) return this.localJob;
      return this.localJob &&
        this.localJob.id !== parsed.data.id &&
        Date.parse(this.localJob.startedAt) >= Date.parse(parsed.data.startedAt)
        ? this.localJob
        : parsed.data;
    } catch {
      return this.localJob;
    }
  }

  async info(): Promise<UpdateInfo> {
    const [local, job] = await Promise.all([this.inspect(), this.readJob()]);
    this.currentCommit ??= SHA.test(local.commit ?? '') ? local.commit : undefined;
    // A manually installed newer version must not be offered a downgrade.
    const rank = (v: string) => v.split(/[.-]/).slice(0, 3).map(Number);
    const current = rank(this.options.version),
      latest = rank(this.latest?.version ?? '0.0.0');
    const difference = latest[0] - current[0] || latest[1] - current[1] || latest[2] - current[2];
    const available = Boolean(
      this.latest &&
      (difference > 0 ||
        (difference === 0 && this.currentCommit && this.latest.commit !== this.currentCommit)),
    );
    return {
      current: {
        version: this.options.version,
        ...(this.currentCommit ? { commit: this.currentCommit } : {}),
      },
      ...(this.latest ? { latest: this.latest } : {}),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      ...(this.checkError ? { checkError: this.checkError } : {}),
      available,
      installation: local.installation,
      ...(job ? { job } : {}),
    };
  }

  private async json(path: string): Promise<unknown> {
    const response = await (this.options.fetcher ?? fetch)(`${API}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Agent-Loom-Update-Check',
      },
      signal: AbortSignal.timeout(12_000),
      redirect: 'error',
    });
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        const retry = Number(response.headers.get('retry-after')) * 1_000;
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1_000 - this.clock();
        this.limitedUntil =
          this.clock() +
          Math.min(3_600_000, Math.max(60_000, retry > 0 ? retry : reset > 0 ? reset : 300_000));
      }
      throw new Error(
        response.status === 403 || response.status === 429
          ? 'GitHub temporarily limited update checks. Try again later.'
          : 'The official update information could not be retrieved. Try again later.',
      );
    }
    if (Number(response.headers.get('content-length')) > 512_000)
      throw new Error('The update response was too large.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The update response was empty.');
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 512_000) throw new Error('The update response was too large.');
        parts.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }

  async check(force = false): Promise<UpdateInfo> {
    const pendingChecks = this.latest?.checks === 'pending' || this.latest?.checks === 'unknown';
    const interval = force
      ? FORCE_INTERVAL
      : this.checkError || pendingChecks
        ? RETRY_INTERVAL
        : CHECK_INTERVAL;
    if (this.checking) await this.checking;
    else if (
      this.clock() >= this.limitedUntil &&
      (!this.lastAttempt || this.clock() - this.lastAttempt >= interval)
    ) {
      this.lastAttempt = this.clock();
      this.checking = (async () => {
        try {
          const commit = z
            .object({
              sha: z.string().regex(SHA),
              commit: z.object({ committer: z.object({ date: z.string() }).nullable() }),
            })
            .parse(await this.json('/commits/main'));
          const [contents, runs] = await Promise.all([
            this.json(`/contents/package.json?ref=${commit.sha}`),
            this.json(
              `/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${commit.sha}&per_page=10`,
            ),
          ]);
          const file = z
            .object({ encoding: z.literal('base64'), content: z.string().max(128_000) })
            .parse(contents);
          const metadata = z
            .object({
              version: z.string().regex(VERSION),
              loomUpdateProtocol: z.number().int().optional(),
            })
            .parse(JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')));
          const workflow = z
            .object({
              workflow_runs: z.array(
                z.object({
                  head_sha: z.string(),
                  event: z.string(),
                  head_branch: z.string().nullable(),
                  status: z.string(),
                  conclusion: z.string().nullable(),
                }),
              ),
            })
            .parse(runs)
            .workflow_runs.find(
              (run) =>
                run.head_sha === commit.sha && run.event === 'push' && run.head_branch === 'main',
            );
          this.latest = {
            version: metadata.version,
            commit: commit.sha,
            url: `https://github.com/${REPOSITORY}/commit/${commit.sha}`,
            ...(commit.commit.committer?.date ? { publishedAt: commit.commit.committer.date } : {}),
            protocol: metadata.loomUpdateProtocol ?? 0,
            checks: !workflow
              ? 'unknown'
              : workflow.status !== 'completed'
                ? 'pending'
                : workflow.conclusion === 'success'
                  ? 'passed'
                  : 'failed',
          };
          this.checkedAt = new Date(this.clock()).toISOString();
          this.checkError = undefined;
        } catch (error) {
          // Transport/schema details may contain user proxy credentials: expose a bounded summary only.
          this.checkError =
            error instanceof Error && /^GitHub temporarily|^The official update/.test(error.message)
              ? error.message
              : 'Update information could not be verified. Check the connection and try again.';
        }
      })().finally(() => {
        this.checking = undefined;
      });
      await this.checking;
    }
    return this.info();
  }

  async prepare(commit: string, requestId: string = randomUUID()): Promise<UpdateJob> {
    if (this.requesting) updateProblem('An update is already being prepared.');
    this.requesting = true;
    try {
      const info = await this.check(true);
      if (info.job?.id === requestId) {
        if (info.job.targetSha !== commit)
          updateProblem('This update request ID belongs to a different version.');
        return info.job;
      }
      if (isActiveUpdate(info.job)) updateProblem('An update is already in progress.');
      if (!info.installation.canUpdate || !this.options.requestInstall)
        updateProblem(
          info.installation.reason ?? 'Start Loom with npm start to enable web updates.',
        );
      if (info.checkError) updateProblem(info.checkError);
      if (!info.available || !info.latest || info.latest.commit !== commit)
        updateProblem('The update target changed. Check for updates again.');
      if (info.latest.checks !== 'passed')
        updateProblem('The official CI checks have not passed for this update.');
      if (info.latest.protocol !== UPDATE_PROTOCOL)
        updateProblem('This version requires a manual update.');
      if (!info.current.commit) updateProblem('The running Git revision could not be verified.');
      const stamp = new Date(this.clock()).toISOString();
      this.localJob = {
        id: requestId,
        phase: 'preparing',
        targetSha: commit,
        targetVersion: info.latest.version,
        previousSha: info.current.commit,
        startedAt: stamp,
        updatedAt: stamp,
      };
      return this.localJob;
    } finally {
      this.requesting = false;
    }
  }

  async request(job: UpdateJob): Promise<void> {
    if (job.id !== this.localJob?.id) updateProblem('The update reservation expired.');
    await this.options.requestInstall!(job);
  }

  proceed(id: string): void {
    this.options.proceed?.(id);
  }

  reject(job: UpdateJob, message: string): void {
    if (this.localJob?.id === job.id)
      this.localJob = {
        ...job,
        phase: 'failed',
        updatedAt: new Date(this.clock()).toISOString(),
        error: message.slice(0, 2_000),
      };
  }
}
