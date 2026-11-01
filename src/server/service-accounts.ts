import { z } from 'zod';
import type { Bot } from '../shared/types.js';
import type { MailAccount } from '../shared/mail-accounts.js';
import type { ServiceAccount, ServiceAccountInput } from '../shared/service-accounts.js';
import { Store, id, now } from './store.js';

const fail = (message: string, statusCode = 400): never => {
  throw Object.assign(new Error(message), { statusCode });
};

const cleanText = (limit: number) =>
  z
    .string()
    .trim()
    .max(limit)
    .refine((value) => !value.includes('\0'), 'NUL is not allowed.');

export const serviceAccountSchema = z
  .object({
    name: cleanText(160).min(1),
    url: cleanText(2_000)
      .min(1)
      .transform((value, context) => {
        try {
          const url = new URL(value);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
            throw new Error('Invalid service URL.');
          if (
            [...url.searchParams.keys()].some((key) =>
              /password|secret|token|api[_-]?key/i.test(key),
            )
          )
            throw new Error('Credentials belong in the separate credential field.');
          return url.toString();
        } catch {
          context.addIssue({
            code: 'custom',
            message: 'Use an HTTP(S) service URL without credentials.',
          });
          return z.NEVER;
        }
      }),
    login: cleanText(320),
    botId: z.string().trim().min(1).max(160).nullable(),
    mailAccountId: z.string().trim().min(1).max(160).nullable(),
    status: z.enum(['active', 'pending', 'disabled']),
    notes: cleanText(8_000),
    credential: z.string().max(16_384).optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict();

const secretName = (accountId: string) => `service.${accountId}.credential`;

/** Explicit public projection: the registry never returns encrypted or plaintext credentials. */
export function publicServiceAccount(store: Store, account: ServiceAccount): ServiceAccount {
  return {
    id: account.id,
    name: account.name,
    url: account.url,
    login: account.login,
    botId: account.botId,
    mailAccountId: account.mailAccountId,
    status: account.status,
    notes: account.notes,
    credentialConfigured: Boolean(store.secret(secretName(account.id))),
    revision: account.revision,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export function listServiceAccounts(store: Store): ServiceAccount[] {
  return store
    .list<ServiceAccount>('serviceAccounts')
    .map((account) => publicServiceAccount(store, account));
}

export function getServiceAccount(store: Store, accountId: string): ServiceAccount {
  const account = store.get<ServiceAccount>('serviceAccounts', accountId);
  return account ? publicServiceAccount(store, account) : fail('Service account not found.', 404);
}

export function saveServiceAccount(
  store: Store,
  raw: ServiceAccountInput,
  accountId?: string,
): ServiceAccount {
  const input = serviceAccountSchema.parse(raw);
  const existing = accountId ? getServiceAccount(store, accountId) : undefined;
  if (existing && input.expectedRevision !== existing.revision)
    fail('This service account changed. Reload it before saving.', 409);
  if (!existing && input.expectedRevision !== undefined)
    fail('A new service account must not specify a revision.');
  if (input.botId && !store.get<Bot>('bots', input.botId)) fail('Choose an existing bot.');
  if (input.mailAccountId) {
    const mail =
      store.get<MailAccount>('mailAccounts', input.mailAccountId) ??
      fail('Choose an existing mail account.');
    if (input.botId && !mail.botIds.includes(input.botId))
      fail('Assign this mail account to the selected bot first.');
  }
  const { credential, expectedRevision: _, ...fields } = input;
  const stamp = now();
  const key = existing?.id ?? id('service');
  const identityChanged = Boolean(
    existing &&
    (new URL(existing.url).origin !== new URL(fields.url).origin ||
      existing.login !== fields.login),
  );
  const storedCredential = credential ?? (identityChanged ? '' : store.secret(secretName(key)));
  const account: ServiceAccount = {
    ...fields,
    id: key,
    credentialConfigured: Boolean(storedCredential),
    revision: (existing?.revision ?? 0) + 1,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
  };
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.setSecret(secretName(key), storedCredential);
    store.put('serviceAccounts', account);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return publicServiceAccount(store, account);
}

/** Disconnect the local registry entry only; this never deletes an external identity. */
export function removeServiceAccount(store: Store, accountId: string, expectedRevision?: number) {
  const account = getServiceAccount(store, accountId);
  if (expectedRevision !== undefined && expectedRevision !== account.revision)
    fail('This service account changed. Reload it before disconnecting.', 409);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.setSecret(secretName(account.id), '');
    store.remove('serviceAccounts', account.id);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}

/** Keep externally owned identities when a bot/mail connection is removed. */
export function detachServiceAccounts(
  store: Store,
  reference: { botId?: string; mailAccountId?: string },
) {
  for (const account of store.list<ServiceAccount>('serviceAccounts')) {
    const detachBot = reference.botId && account.botId === reference.botId;
    const detachMail = reference.mailAccountId && account.mailAccountId === reference.mailAccountId;
    if (!detachBot && !detachMail) continue;
    store.patch<ServiceAccount>('serviceAccounts', account.id, {
      ...(detachBot ? { botId: null } : {}),
      ...(detachMail ? { mailAccountId: null } : {}),
      revision: account.revision + 1,
      updatedAt: now(),
    });
  }
}
