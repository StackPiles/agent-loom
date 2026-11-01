import type { FastifyInstance } from 'fastify';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { z } from 'zod';
import type { Automation } from '../shared/types.js';
import {
  normalizeMailPassword,
  sameMailAccount,
  type MailConnectionSettings,
  type MailTestErrorCode,
  type MailTestResult,
} from '../shared/mail-settings.js';
import type { Store } from './store.js';

export const mailConnectionSchema = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .max(250)
    .regex(/^[a-zA-Z0-9.:-]+$/),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().min(1).max(250),
  mailbox: z.string().trim().min(1).max(250),
  password: z.string().max(4096).optional(),
});

/** Identical bounded, encrypted transport for polling and explicit connection tests. */
export function mailClientOptions(
  config: MailConnectionSettings,
  password: string,
): ImapFlowOptions {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    doSTARTTLS: config.secure ? undefined : true,
    auth: { user: config.user, pass: normalizeMailPassword(config, password) },
    logger: false,
    logRaw: false,
    disableAutoIdle: true,
    disableCompression: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    maxLineLength: 1_000_000,
    maxLiteralSize: 1_000_000,
    maxResponseSize: 2_000_000,
  };
}

export interface MailConnectionClient {
  connect(): Promise<unknown>;
  mailboxOpen(path: string, options: { readOnly: true }): Promise<unknown>;
  logout(): Promise<unknown>;
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface MailConnectionAdapters {
  createClient?: (options: ImapFlowOptions) => MailConnectionClient;
  timeoutMs?: number;
}

const testSchema = z
  .object({
    automationId: z.string().trim().min(1).max(160).optional(),
    imap: mailConnectionSchema.strict(),
  })
  .strict();

const errors: Record<MailTestErrorCode, string> = {
  invalid_configuration: 'Check the mail server, account and mailbox settings.',
  network_denied: 'Mail connections are disabled by the network permission in Settings.',
  credentials_required:
    'Enter an app password for this account. A saved password is only reused for its original server and account.',
  authentication_failed:
    'The mail server rejected sign-in. Check the email address and app password; your provider or organization may restrict access.',
  mailbox_unavailable:
    'The mailbox could not be opened read-only. Check its name and access permissions.',
  connection_failed:
    'The mail server could not be reached securely. Check the address, port, network and TLS configuration.',
  timeout: 'The mail connection test timed out. Check your network and try again.',
  busy: 'Another mail connection test is in progress. Wait for it to finish.',
};

function authenticationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = error as { authenticationFailed?: unknown; serverResponseCode?: unknown };
  return (
    details.authenticationFailed === true ||
    ['AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'LOGINFAILED'].includes(
      String(details.serverResponseCode || '').toUpperCase(),
    )
  );
}

/** Owner-initiated check: never fetches a message or changes a rule/baseline. */
export function registerMailRoutes(
  app: FastifyInstance,
  store: Store,
  adapters: MailConnectionAdapters = {},
) {
  const createClient = adapters.createClient ?? ((options) => new ImapFlow(options));
  let active: { abort: AbortController; finished: Promise<void> } | undefined;
  let closing = false;

  app.post('/api/mail/test', async (request, reply) => {
    const fail = (code: MailTestErrorCode, status = 400) =>
      reply.code(status).send({ error: errors[code], code });
    if (store.settings().permissions.network === 'deny') return fail('network_denied', 403);
    if (active || closing) return fail('busy', 409);
    const parsed = testSchema.safeParse(request.body);
    if (!parsed.success) return fail('invalid_configuration');
    const { imap, automationId } = parsed.data;
    const existing = automationId ? store.get<Automation>('automations', automationId) : undefined;
    // Do not look up a different account's secret, even if a valid rule ID is supplied.
    const stored =
      existing?.kind === 'imap' && sameMailAccount(existing.imap, imap)
        ? store.secret(`imap.${existing.id}.password`)
        : '';
    const password = normalizeMailPassword(imap, imap.password ?? stored);
    if (!password) return fail('credentials_required');

    const abort = new AbortController();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    active = { abort, finished };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, adapters.timeoutMs ?? 25_000);
    const cancel = () => abort.abort();
    const disconnected = () => {
      if (!reply.raw.writableEnded) cancel();
    };
    request.raw.once('aborted', cancel);
    reply.raw.once('close', disconnected);
    let client: MailConnectionClient | undefined;
    let openingMailbox = false;
    let connected = false;
    const close = () => {
      try {
        client?.close();
      } catch {
        /* Already closed. */
      }
    };
    let rejectAbort!: (reason: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    // Observe abort before creating/awaiting transport work. Races always stay bounded.
    const onAbort = () => {
      close();
      rejectAbort(new Error('Mail test cancelled.'));
    };
    abort.signal.addEventListener('abort', onAbort, { once: true });
    try {
      client = createClient(mailClientOptions(imap, password));
      client.on('error', () => {});
      if (abort.signal.aborted) onAbort();
      await Promise.race([client.connect(), aborted]);
      connected = true;
      if (store.settings().permissions.network === 'deny') return fail('network_denied', 403);
      openingMailbox = true;
      await Promise.race([client.mailboxOpen(imap.mailbox, { readOnly: true }), aborted]);
      if (store.settings().permissions.network === 'deny') return fail('network_denied', 403);
      return {
        ok: true,
        host: imap.host,
        user: imap.user,
        mailbox: imap.mailbox,
      } satisfies MailTestResult;
    } catch (error) {
      // Never echo provider diagnostics: they may contain passwords, server banners or mail.
      const code: MailTestErrorCode = timedOut
        ? 'timeout'
        : authenticationFailure(error)
          ? 'authentication_failed'
          : openingMailbox && !abort.signal.aborted
            ? 'mailbox_unavailable'
            : 'connection_failed';
      return fail(code);
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', onAbort);
      request.raw.removeListener('aborted', cancel);
      reply.raw.removeListener('close', disconnected);
      if (client && connected && !abort.signal.aborted) {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            client.logout(),
            new Promise<void>((resolve) => {
              cleanupTimer = setTimeout(() => {
                close();
                resolve();
              }, 1_000);
            }),
          ]);
        } catch {
          close();
        } finally {
          if (cleanupTimer) clearTimeout(cleanupTimer);
        }
      } else close();
      active = undefined;
      finish();
    }
  });

  app.addHook('preClose', async () => {
    closing = true;
    const pending = active;
    pending?.abort.abort();
    await pending?.finished;
  });
}
