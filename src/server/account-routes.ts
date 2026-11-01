import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Automation } from '../shared/types.js';
import type { MailAccount, MailAccountInput, MailDraftInput } from '../shared/mail-accounts.js';
import type { ServiceAccountInput } from '../shared/service-accounts.js';
import type { MailService } from './mail-accounts.js';
import type { Controller } from './controller.js';
import { problem } from './controller.js';
import type { Store } from './store.js';
import { now } from './store.js';
import {
  detachServiceAccounts,
  getServiceAccount,
  listServiceAccounts,
  removeServiceAccount,
  saveServiceAccount,
} from './service-accounts.js';

const key = z.string().trim().min(1).max(160);
const listSchema = z
  .object({
    query: z.string().trim().max(256).optional(),
    cursor: z.string().min(1).max(24_000).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
const revisionSchema = z
  .object({
    expectedRevision: z.coerce.number().int().positive().optional(),
  })
  .strict();
const sendSchema = z
  .object({
    requestId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    expectedAccountRevision: z.number().int().positive().optional(),
  })
  .strict();

function transportIdentity(account: MailAccount): string {
  return JSON.stringify({
    provider: account.provider,
    address: account.address,
    ...(account.provider === 'imap'
      ? {
          host: account.imap?.host.toLowerCase(),
          port: account.imap?.port,
          secure: account.imap?.secure,
          user: account.imap?.user,
          mailbox: account.imap?.mailbox,
        }
      : { inboxId: account.api?.inboxId }),
  });
}

/** Request cancellation closes transports, while persisted send outcomes survive navigation. */
async function connectionRequest<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const close = () => {
    if (!reply.raw.writableEnded) cancel();
  };
  request.raw.once('aborted', cancel);
  reply.raw.once('close', close);
  try {
    return await operation(abort.signal);
  } finally {
    request.raw.removeListener('aborted', cancel);
    reply.raw.removeListener('close', close);
  }
}

export function registerAccountRoutes(
  app: FastifyInstance,
  store: Store,
  controller: Controller,
  mail: MailService,
) {
  app.get('/api/mail/accounts', async () => mail.list());
  app.get<{ Params: { id: string } }>('/api/mail/accounts/:id', async (request) =>
    mail.get(key.parse(request.params.id)),
  );
  app.post('/api/mail/accounts', async (request) => {
    const account = mail.save(request.body as MailAccountInput);
    controller.changed();
    return account;
  });
  app.put<{ Params: { id: string } }>('/api/mail/accounts/:id', async (request) => {
    const accountId = key.parse(request.params.id);
    const previous = mail.get(accountId);
    const account = mail.save(request.body as MailAccountInput, accountId);
    const sourceChanged = transportIdentity(previous) !== transportIdentity(account);
    for (const rule of store.list<Automation>('automations')) {
      if (rule.mailAccountId !== account.id) continue;
      if (sourceChanged) {
        const state = store.get<{ id: string; [key: string]: unknown }>(
          'automationState',
          rule.id,
        ) ?? { id: rule.id };
        for (const field of [
          'mailCursor',
          'uidValidity',
          'lastUid',
          'legacyMailAccountId',
          'pendingMail',
          'coalescedMailCount',
        ])
          delete state[field];
        store.put('automationState', { ...state, mailSince: now() });
      }
      if (!rule.enabled) continue;
      if (account.enabled && account.botIds.includes(rule.botId)) continue;
      store.patch<Automation>('automations', rule.id, {
        enabled: false,
        nextRunAt: undefined,
        lastError: 'Paused because the mail account was disabled or unassigned from this bot.',
      });
    }
    controller.changed();
    return account;
  });
  app.delete<{ Params: { id: string } }>('/api/mail/accounts/:id', async (request) => {
    const accountId = key.parse(request.params.id);
    const { expectedRevision } = revisionSchema.parse(request.query);
    const account = mail.get(accountId);
    if (expectedRevision !== undefined && account.revision !== expectedRevision)
      problem('This mail account changed. Reload it before disconnecting.', 409);
    mail.remove(accountId);
    detachServiceAccounts(store, { mailAccountId: accountId });
    for (const rule of store.list<Automation>('automations')) {
      if (rule.mailAccountId !== accountId) continue;
      // A migrated watcher may still hold its compatibility credential until
      // the first edit. Disconnect must remove that copy as well.
      store.setSecret(`imap.${rule.id}.password`, '');
      store.patch<Automation>('automations', rule.id, {
        enabled: false,
        nextRunAt: undefined,
        ...(rule.imap ? { imap: { ...rule.imap, passwordConfigured: false } } : {}),
        lastError: 'The mail account was disconnected. Select another connected account.',
      });
    }
    controller.changed();
    return { ok: true };
  });
  app.post('/api/mail/accounts/test', async (request, reply) => {
    const body = z
      .object({ input: z.unknown(), existingId: key.optional() })
      .strict()
      .parse(request.body);
    return connectionRequest(request, reply, (signal) =>
      mail.test(body.input as MailAccountInput, body.existingId, signal),
    );
  });
  app.get<{ Params: { id: string } }>('/api/mail/accounts/:id/messages', async (request, reply) => {
    const accountId = key.parse(request.params.id);
    const options = listSchema.parse(request.query);
    return connectionRequest(request, reply, (signal) =>
      mail.listMessages(accountId, options, signal),
    );
  });
  app.get<{ Params: { id: string; messageId: string } }>(
    '/api/mail/accounts/:id/messages/:messageId',
    async (request, reply) => {
      const accountId = key.parse(request.params.id);
      const messageId = z.string().min(1).max(24_000).parse(request.params.messageId);
      return connectionRequest(request, reply, (signal) =>
        mail.readMessage(accountId, messageId, signal),
      );
    },
  );
  app.get('/api/mail/drafts', async (request) => {
    const { accountId } = z.object({ accountId: key.optional() }).strict().parse(request.query);
    return mail.listDrafts(accountId);
  });
  app.get<{ Params: { id: string } }>('/api/mail/drafts/:id', async (request) =>
    mail.getDraft(key.parse(request.params.id)),
  );
  app.post('/api/mail/drafts', async (request) => mail.saveDraft(request.body as MailDraftInput));
  app.put<{ Params: { id: string } }>('/api/mail/drafts/:id', async (request) =>
    mail.saveDraft(request.body as MailDraftInput, key.parse(request.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/mail/drafts/:id/send', async (request, reply) => {
    const draftId = key.parse(request.params.id);
    const options = sendSchema.parse(request.body);
    return connectionRequest(request, reply, (signal) => mail.sendDraft(draftId, options, signal));
  });

  app.get('/api/service-accounts', async () => listServiceAccounts(store));
  app.get<{ Params: { id: string } }>('/api/service-accounts/:id', async (request) =>
    getServiceAccount(store, key.parse(request.params.id)),
  );
  app.post('/api/service-accounts', async (request) => {
    const account = saveServiceAccount(store, request.body as ServiceAccountInput);
    controller.changed();
    return account;
  });
  app.put<{ Params: { id: string } }>('/api/service-accounts/:id', async (request) => {
    const account = saveServiceAccount(
      store,
      request.body as ServiceAccountInput,
      key.parse(request.params.id),
    );
    controller.changed();
    return account;
  });
  app.delete<{ Params: { id: string } }>('/api/service-accounts/:id', async (request) => {
    const { expectedRevision } = revisionSchema.parse(request.query);
    removeServiceAccount(store, key.parse(request.params.id), expectedRevision);
    controller.changed();
    return { ok: true };
  });
}
