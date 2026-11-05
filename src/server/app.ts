import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { Store } from './store.js';
import { ACTIVE, Controller, VERSION, problem } from './controller.js';
import { createRuntime } from './runtime/index.js';
import type { Runtime, RuntimeHost } from './runtime/contract.js';
import { createScheduler } from './scheduler.js';
import { registerRoutes } from './routes.js';
import { registerWorkspacePickerRoutes, type NativeFolderPicker } from './native-folder.js';
import {
  createAvatarGenerations,
  hasActiveAvatarGeneration,
  registerAvatarGenerationRoutes,
} from './avatar-generations.js';
import {
  createPromptGenerations,
  hasActivePromptGeneration,
  registerPromptGenerationRoutes,
} from './prompt-generations.js';
import { createBrowserControl } from './browser.js';
import { createBrowserManager } from './browser-manager.js';
import { DEFAULT_BROWSER_SETTINGS } from '../shared/browser.js';
import { registerMailRoutes, type MailConnectionAdapters } from './mail.js';
import { MailService } from './mail-accounts.js';
import { MailAccountError } from './mail-providers/types.js';
import { registerAccountRoutes } from './account-routes.js';
import { migrateLegacyMailAccounts } from './mail-account-migration.js';
import type { DataDirectoryLock } from './data-directory.js';
import { registerDataTransferRoutes, type DataTransferService } from './data-transfer.js';
import {
  createImageTests,
  registerImageTestRoutes,
  type ImageTestAdapters,
} from './image-tests.js';
import { ApplicationUpdates, updateProblem } from './updates.js';
import { isActiveUpdate, type UpdateJob } from '../shared/updates.js';
import { isActiveImageTest, type ImageTestJob } from '../shared/image-tests.js';
import type { Bot, Room, Task } from '../shared/types.js';

const digest = (s: string) => createHash('sha256').update(s).digest();
export const equalToken = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
export interface AppOptions {
  dataDir: string;
  apiToken?: string;
  dev?: boolean;
  logger?: boolean;
  staticDir?: string;
  scheduler?: boolean;
  runtimeFactory?: (host: RuntimeHost) => Runtime;
  folderPicker?: NativeFolderPicker;
  browserFactory?: typeof createBrowserControl;
  mailAdapters?: MailConnectionAdapters;
  mailAccountAdapters?: ConstructorParameters<typeof MailService>[2];
  dataDirectoryLock?: DataDirectoryLock;
  dataTransfer?: DataTransferService;
  imageTestAdapters?: ImageTestAdapters;
  updates?: ApplicationUpdates;
  /** The supervisor must explicitly activate a newly installed process. */
  updateVerification?: boolean;
}
export async function createApp(options: AppOptions) {
  const store = new Store(options.dataDir, options.dataDirectoryLock);
  const startupCleanup: (() => void | Promise<void>)[] = [() => store.close()];
  try {
    store.seed();
    const controller = new Controller(store);
    let updateMaintenance = options.updateVerification === true;
    let verified = !updateMaintenance;
    controller.maintenance = updateMaintenance;
    startupCleanup.push(() => controller.shutdown());
    const mail = new MailService(store, controller.changed, options.mailAccountAdapters);
    startupCleanup.push(() => mail.shutdown());
    controller.mail = mail;
    migrateLegacyMailAccounts(store);
    const browser = createBrowserManager({
      dataDir: store.dataDir,
      getSettings: () => ({ ...DEFAULT_BROWSER_SETTINGS, ...store.settings().browser }),
      getBot: (id) => store.get<Bot>('bots', id),
      controlFactory: options.browserFactory,
      onChange: controller.changed,
    });
    startupCleanup.push(() => browser.shutdown());
    controller.browser = browser;
    const runtime = (options.runtimeFactory ?? createRuntime)(controller);
    controller.runtime = runtime;
    const avatarGenerations = createAvatarGenerations(store, controller);
    startupCleanup.push(() => avatarGenerations.shutdown());
    const promptGenerations = createPromptGenerations(store, controller);
    startupCleanup.push(() => promptGenerations.shutdown());
    const imageTests = createImageTests(store, controller, options.imageTestAdapters);
    startupCleanup.push(() => imageTests.shutdown());
    const scheduler = createScheduler({
      store,
      enqueueTask: controller.enqueueTask,
      notify: controller.notify,
      changed: controller.changed,
      mail,
    });
    startupCleanup.push(() => scheduler.stop());
    const updates =
      options.updates ?? new ApplicationUpdates({ version: VERSION, development: options.dev });
    const inFlight = new Map<string, { started: boolean; settled: boolean; finished: boolean }>();
    let pendingUpdate: string | undefined;
    let updateReservation: string | undefined;
    const resumeAfterUpdate = (id?: string) => {
      if (!verified || (id && id !== pendingUpdate)) return;
      pendingUpdate = undefined;
      updateMaintenance = false;
      controller.maintenance = false;
      if (options.scheduler !== false) scheduler.start();
    };
    const activateUpdate = () => {
      verified = true;
      resumeAfterUpdate();
    };
    const app = Fastify({
      logger: options.logger ?? false,
      bodyLimit: 512_000,
      requestTimeout: 30_000,
      routerOptions: { maxParamLength: 24_000 },
    });
    // A disconnected caller does not cancel an asynchronous handler. Retain
    // admission until both its work and its response/abort have settled.
    app.addHook('onRoute', (route) => {
      if (!route.url.startsWith('/api/')) return;
      const handler = route.handler;
      route.handler = async function (request, reply) {
        const state = inFlight.get(request.id);
        if (state) state.started = true;
        try {
          return await handler.call(this, request, reply);
        } finally {
          if (state) {
            state.settled = true;
            if (state.finished) inFlight.delete(request.id);
          }
        }
      };
    });
    const finishRequest = (id: string) => {
      const state = inFlight.get(id);
      if (!state) return;
      state.finished = true;
      if (!state.started || state.settled) inFlight.delete(id);
    };
    const apiToken = options.apiToken || '';
    const clients = new Map<ServerResponse, () => boolean>();
    let eventId = 0;
    const cookieValue = (header?: string) =>
      (header ?? '')
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('loom_session='))
        ?.slice('loom_session='.length) ?? '';
    const authenticated = (headers: Record<string, unknown>) => {
      if (!apiToken) return true;
      const authorization = typeof headers.authorization === 'string' ? headers.authorization : '';
      if (authorization.startsWith('Bearer ') && equalToken(authorization.slice(7), apiToken))
        return true;
      const cookie = cookieValue(typeof headers.cookie === 'string' ? headers.cookie : '');
      if (!cookie) return false;
      const session = store.get<{ id: string; expiresAt: number; tokenFingerprint: string }>(
        'authSessions',
        digest(cookie).toString('hex'),
      );
      return Boolean(
        session &&
        session.expiresAt > Date.now() &&
        session.tokenFingerprint === digest(apiToken).toString('hex'),
      );
    };
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof z.ZodError)
        return reply.code(400).send({
          error: error.issues
            .map((i) => `${i.path.join('.') || 'request'}: ${i.message}`)
            .slice(0, 5)
            .join('; '),
        });
      const e = error as Error & { statusCode?: number; code?: string };
      const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
      if (status >= 500 && options.logger) app.log.error({ message: e.message }, 'Request failed');
      return reply.code(status).send({
        ...(typeof e.code === 'string' && /^[a-z][a-z_]{1,63}$/.test(e.code)
          ? { code: e.code }
          : {}),
        ...(e instanceof MailAccountError &&
        (e.connectionStage === 'imap' || e.connectionStage === 'smtp')
          ? { connectionStage: e.connectionStage }
          : {}),
        error:
          status >= 500
            ? 'The server could not complete this request. Check the server log.'
            : e.message,
      });
    });
    app.addHook('onRequest', async (request, reply) => {
      // Authorize the router's matched path, not the raw URL: percent-encoded
      // characters can still match an API route (for example /%61pi/state).
      const path = request.routeOptions.url ?? request.url.split('?')[0];
      reply
        .header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Frame-Options', 'DENY');
      if (path.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
      if (path === '/api/health') return;
      if (!apiToken && !options.dev) {
        let hostname = '';
        try {
          hostname = new URL(`http://${request.headers.host ?? ''}`).hostname;
        } catch {
          /* invalid host */
        }
        if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname))
          return reply.code(403).send({
            error:
              'Local mode accepts localhost only. Set LOOM_API_TOKEN to enable access through another host.',
          });
      }
      const origin = request.headers.origin;
      if (origin) {
        let originHost = '';
        try {
          originHost = new URL(origin).host;
        } catch {
          /* invalid origin */
        }
        if (originHost !== request.headers.host)
          return reply.code(403).send({ error: 'Cross-origin requests are not allowed.' });
      }
      if (!path.startsWith('/api/') || path === '/api/auth' || /^\/api\/hooks\/[^/]+$/.test(path))
        return;
      if (!authenticated(request.headers))
        return reply.code(401).send({ error: 'Sign in with your LOOM_API_TOKEN.' });
      browser.protectOrigin(`${request.protocol}://${request.headers.host || 'localhost'}`);
      if (origin) browser.protectOrigin(origin);
    });
    app.addHook('onListen', async () => {
      const address = app.server.address();
      if (address && typeof address !== 'string') {
        for (const host of ['localhost', '127.0.0.1', '[::1]'])
          browser.protectOrigin(`http://${host}:${address.port}`);
      }
    });
    app.addHook('onRequest', async (request, reply) => {
      const path = request.routeOptions.url ?? request.url.split('?')[0];
      if (
        updateMaintenance &&
        path.startsWith('/api/') &&
        path !== '/api/health' &&
        !path.startsWith('/api/updates')
      )
        return reply.code(503).send({
          code: 'update_in_progress',
          error: 'Agent Loom is updating. Please wait for it to restart.',
        });
      if (
        options.dataTransfer?.maintenance &&
        path.startsWith('/api/') &&
        path !== '/api/health' &&
        !path.startsWith('/api/data-transfer')
      )
        return reply.code(503).send({
          code: 'data_transfer_in_progress',
          error: 'Agent Loom is preparing a data transfer. Please wait for it to restart.',
        });
      if (
        path.startsWith('/api/') &&
        !['/api/health', '/api/events', '/api/state'].includes(path) &&
        !path.startsWith('/api/updates')
      )
        inFlight.set(request.id, { started: false, settled: false, finished: false });
    });
    app.addHook('onResponse', async (request) => {
      finishRequest(request.id);
    });
    app.addHook('onError', async (request) => {
      finishRequest(request.id);
    });
    app.addHook('onRequestAbort', async (request) => {
      finishRequest(request.id);
    });
    app.get('/api/health', async () => ({
      ok: true,
      version: VERSION,
      configured: Boolean(store.settings().model.baseUrl && store.settings().model.modelId),
      demoMode: store.settings().demoMode,
      updating: updateMaintenance,
    }));
    app.get('/api/updates', async () => updates.info());
    app.post('/api/updates/check', async (request) => {
      const { force } = z.object({ force: z.boolean().optional() }).parse(request.body ?? {});
      return updates.check(force);
    });
    app.post('/api/updates/install', async (request, reply) => {
      const input = z
        .object({
          commit: z.string().regex(/^[a-f0-9]{40}$/),
          requestId: z.string().uuid(),
        })
        .strict()
        .parse(request.body);
      const existing = (await updates.info()).job;
      if (existing?.id === input.requestId) {
        if (existing.targetSha !== input.commit)
          updateProblem('This update request ID belongs to a different version.');
        return reply.code(isActiveUpdate(existing) ? 202 : 200).send(existing);
      }
      if (updateMaintenance || updateReservation)
        updateProblem('An update is already in progress.');
      const assertIdle = () => {
        if (
          inFlight.size ||
          options.dataTransfer?.info().busy ||
          store
            .list<Task>('tasks')
            .some(
              (task) =>
                ACTIVE.has(task.status) &&
                !(
                  task.status === 'queued' &&
                  typeof task.roomId === 'string' &&
                  store.get<Room>('rooms', task.roomId)?.paused === true
                ),
            ) ||
          hasActiveAvatarGeneration(store) ||
          hasActivePromptGeneration(store) ||
          store.list<ImageTestJob>('imageTests').some(isActiveImageTest) ||
          ['mailSends', 'mailDrafts'].some((kind) =>
            store.list<{ status?: string }>(kind).some((job) => job.status === 'sending'),
          )
        )
          updateProblem(
            'Wait for running tasks, generation, mail, and data transfers to finish before updating.',
          );
      };
      assertIdle();
      updateReservation = input.requestId;
      let job: UpdateJob | undefined;
      let ownsMaintenance = false;
      try {
        job = await updates.prepare(input.commit, input.requestId);
        // A request may have started while the network check was pending.
        assertIdle();
        updateMaintenance = true;
        controller.maintenance = true;
        pendingUpdate = job.id;
        ownsMaintenance = true;
        await scheduler.stop();
        assertIdle();
        await updates.request(job);
        let proceeded = false;
        const proceed = () => {
          if (proceeded) return;
          proceeded = true;
          updates.proceed(job!.id);
        };
        reply.raw.once('finish', proceed);
        reply.raw.once('close', proceed);
        if (reply.raw.destroyed) proceed();
        return reply.code(202).send(job);
      } catch (error) {
        // If the IPC receipt was lost, keep admission paused until the parent
        // reports a definitive outcome. Never restart work under an updater.
        if (!(error as { uncertain?: boolean }).uncertain) {
          if (job)
            updates.reject(
              job,
              error instanceof Error ? error.message : 'The update could not start.',
            );
          if (ownsMaintenance) resumeAfterUpdate(job!.id);
        }
        throw error;
      } finally {
        if (updateReservation === input.requestId) updateReservation = undefined;
      }
    });
    app.get('/api/auth', async (req) => ({
      required: Boolean(apiToken),
      authenticated: authenticated(req.headers),
    }));
    const loginAttempts = new Map<string, { count: number; started: number }>();
    app.post('/api/auth', async (req, reply) => {
      const data = z.object({ token: z.string().max(4096) }).parse(req.body);
      const attempt = loginAttempts.get(req.ip);
      if (attempt && attempt.started > Date.now() - 60_000 && attempt.count >= 12)
        problem('Too many attempts. Please wait one minute.', 429);
      if (apiToken && !equalToken(data.token, apiToken)) {
        const recent = attempt && attempt.started > Date.now() - 60_000;
        loginAttempts.set(req.ip, {
          count: recent ? attempt.count + 1 : 1,
          started: recent ? attempt.started : Date.now(),
        });
        problem('The access token is incorrect.', 401);
      }
      loginAttempts.delete(req.ip);
      const token = randomBytes(32).toString('base64url');
      store.put('authSessions', {
        id: digest(token).toString('hex'),
        expiresAt: Date.now() + 7 * 86400_000,
        tokenFingerprint: digest(apiToken).toString('hex'),
      });
      reply.header(
        'Set-Cookie',
        `loom_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${req.protocol === 'https' ? '; Secure' : ''}`,
      );
      return { required: Boolean(apiToken), authenticated: true };
    });
    app.delete('/api/auth', async (req, reply) => {
      const token = cookieValue(req.headers.cookie);
      if (token) store.remove('authSessions', digest(token).toString('hex'));
      for (const [response, authorized] of clients) if (!authorized()) response.end();
      reply.header('Set-Cookie', 'loom_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return { ok: true };
    });
    app.get('/api/state', async () => controller.getSnapshot());
    app.get('/api/events', async (req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      clients.set(reply.raw, () => authenticated(req.headers));
      const send = (type: string, data: unknown) => {
        if (!authenticated(req.headers)) {
          reply.raw.end();
          return;
        }
        if (!reply.raw.destroyed && !reply.raw.writableEnded)
          reply.raw.write(
            `id: ${++eventId}\ndata: ${JSON.stringify({ id: eventId, type, data })}\n\n`,
          );
      };
      const forwarders = [
        'snapshot',
        'message_delta',
        'message_reasoning_delta',
        'message_updated',
      ].map((type) => ({ type, listener: (data: unknown) => send(type, data) }));
      for (const { type, listener } of forwarders) controller.events.on(type, listener);
      send('snapshot', controller.getSnapshot());
      const heartbeat = setInterval(() => send('heartbeat', null), 15_000);
      heartbeat.unref();
      reply.raw.on('close', () => {
        clearInterval(heartbeat);
        for (const { type, listener } of forwarders) controller.events.off(type, listener);
        clients.delete(reply.raw);
      });
    });
    registerWorkspacePickerRoutes(app, options.folderPicker);
    registerAvatarGenerationRoutes(app, avatarGenerations);
    registerPromptGenerationRoutes(app, promptGenerations);
    registerMailRoutes(app, store, options.mailAdapters);
    registerAccountRoutes(app, store, controller, mail);
    const browserConnectionRequest = async (
      request: FastifyRequest,
      reply: FastifyReply,
      connect: (signal: AbortSignal) => Promise<unknown>,
    ) => {
      const cancellation = new AbortController();
      const abort = () => cancellation.abort();
      const close = () => {
        if (!reply.raw.writableEnded) abort();
      };
      request.raw.once('aborted', abort);
      reply.raw.once('close', close);
      try {
        return await connect(AbortSignal.any([cancellation.signal, AbortSignal.timeout(125_000)]));
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error);
        for (const secret of [...Object.values(controller.getSecrets()), options.apiToken])
          if (secret) message = message.split(secret).join('[redacted]');
        problem(message.slice(0, 4_000), 400);
      } finally {
        request.raw.off('aborted', abort);
        reply.raw.off('close', close);
      }
    };
    app.get('/api/browser', async () => browser.status());
    app.post('/api/browser/connect', async (request, reply) =>
      browserConnectionRequest(request, reply, (signal) => browser.connect(signal)),
    );
    app.delete('/api/browser/connect', async () => {
      await browser.disconnect();
      return browser.status();
    });
    app.get<{ Params: { id: string } }>('/api/bots/:id/browser', async (request) => {
      if (!store.get<Bot>('bots', request.params.id)) problem('Bot not found', 404);
      return browser.botStatus(request.params.id);
    });
    app.post<{ Params: { id: string } }>(
      '/api/bots/:id/browser/connect',
      async (request, reply) => {
        if (!store.get<Bot>('bots', request.params.id)) problem('Bot not found', 404);
        return browserConnectionRequest(request, reply, (signal) =>
          browser.connectBot(request.params.id, signal),
        );
      },
    );
    app.delete<{ Params: { id: string } }>('/api/bots/:id/browser/connect', async (request) => {
      if (!store.get<Bot>('bots', request.params.id)) problem('Bot not found', 404);
      return browser.disconnectBot(request.params.id);
    });
    registerRoutes(app, { store, controller, scheduler });
    registerDataTransferRoutes(app, options.dataTransfer);
    registerImageTestRoutes(app, imageTests);
    const staticDir = options.staticDir ?? resolve('dist/client');
    if (existsSync(join(staticDir, 'index.html'))) {
      app.register(staticFiles, {
        root: staticDir,
        wildcard: false,
        index: 'index.html',
        setHeaders(response, filename) {
          if (/[-][A-Za-z0-9_-]{8,}\.(js|css)$/.test(filename))
            response.header('Cache-Control', 'public, max-age=31536000, immutable');
          else response.header('Cache-Control', 'no-cache');
        },
      });
      app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith('/api/'))
          return reply.code(404).send({ error: 'Unknown API route.' });
        return reply.type('text/html').sendFile('index.html');
      });
    }
    app.addHook('onReady', async () => {
      if (options.scheduler !== false && !updateMaintenance) scheduler.start();
    });
    app.addHook('preClose', async () => {
      await scheduler.stop();
      for (const response of clients.keys()) response.end();
      clients.clear();
      await Promise.all([
        avatarGenerations.shutdown(),
        promptGenerations.shutdown(),
        imageTests.shutdown(),
      ]);
      await controller.shutdown();
      await mail.shutdown();
      await browser.shutdown();
    });
    app.addHook('onClose', async () => {
      store.close();
    });
    return {
      app,
      store,
      controller,
      runtime,
      scheduler,
      avatarGenerations,
      promptGenerations,
      imageTests,
      browser,
      mail,
      updates,
      activateUpdate,
      resumeAfterUpdate,
    };
  } catch (error) {
    // A failed restored configuration must not leave its Store/runtime alive:
    // the manager may need to reopen the automatically backed-up generation.
    for (const cleanup of startupCleanup.reverse()) {
      try {
        await cleanup();
      } catch {
        /* Preserve the original initialization failure. */
      }
    }
    throw error;
  }
}
