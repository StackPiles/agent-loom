import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { Store } from './store.js';
import { Controller, VERSION, problem } from './controller.js';
import { createRuntime } from './runtime/index.js';
import type { Runtime, RuntimeHost } from './runtime/contract.js';
import { createScheduler } from './scheduler.js';
import { registerRoutes } from './routes.js';

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
}
export async function createApp(options: AppOptions) {
  const store = new Store(options.dataDir);
  store.seed();
  const controller = new Controller(store);
  const runtime = (options.runtimeFactory ?? createRuntime)(controller);
  controller.runtime = runtime;
  const scheduler = createScheduler({
    store,
    enqueueTask: controller.enqueueTask,
    notify: controller.notify,
    changed: controller.changed,
  });
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 512_000,
    requestTimeout: 30_000,
    routerOptions: { maxParamLength: 200 },
  });
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
    const e = error as Error & { statusCode?: number };
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    if (status >= 500 && options.logger) app.log.error({ message: e.message }, 'Request failed');
    return reply.code(status).send({
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
  });
  app.get('/api/health', async () => ({
    ok: true,
    version: VERSION,
    configured: Boolean(store.settings().model.baseUrl && store.settings().model.modelId),
    demoMode: store.settings().demoMode,
  }));
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
    const snapshot = (data: unknown) => send('snapshot', data),
      delta = (data: unknown) => send('message_delta', data);
    controller.events.on('snapshot', snapshot);
    controller.events.on('message_delta', delta);
    send('snapshot', controller.getSnapshot());
    const heartbeat = setInterval(() => send('heartbeat', null), 15_000);
    heartbeat.unref();
    reply.raw.on('close', () => {
      clearInterval(heartbeat);
      controller.events.off('snapshot', snapshot);
      controller.events.off('message_delta', delta);
      clients.delete(reply.raw);
    });
  });
  registerRoutes(app, { store, controller, scheduler });
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
    if (options.scheduler !== false) scheduler.start();
  });
  app.addHook('preClose', async () => {
    await scheduler.stop();
    for (const response of clients.keys()) response.end();
    clients.clear();
    await controller.shutdown();
  });
  app.addHook('onClose', async () => {
    store.close();
  });
  return { app, store, controller, runtime, scheduler };
}
