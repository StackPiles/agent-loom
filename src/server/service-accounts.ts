import { assertRoomWritable } from './room-state.js';
import { z } from 'zod';
import type { Bot, Room } from '../shared/types.js';
import type { MailAccount } from '../shared/mail-accounts.js';
import {
  SERVICE_ACCOUNT_SHARED_BOT_LIMIT,
  serviceAccountAccessibleByBot,
  type ServiceAccount,
  type ServiceAccountCredential,
  type ServiceAccountInput,
} from '../shared/service-accounts.js';
import { Store, id, now } from './store.js';
import { normalizeServiceLoginUrl, resolveServiceLogin } from '../shared/service-login.js';

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
          return normalizeServiceLoginUrl(value);
        } catch {
          context.addIssue({
            code: 'custom',
            message: 'Use an HTTP(S) service URL without credentials.',
          });
          return z.NEVER;
        }
      }),
    loginUrl: cleanText(2_000)
      .min(1)
      .transform((value, context) => {
        try {
          return normalizeServiceLoginUrl(value);
        } catch {
          context.addIssue({
            code: 'custom',
            message: 'Use an HTTP(S) login URL without credentials.',
          });
          return z.NEVER;
        }
      })
      .optional(),
    login: cleanText(320),
    botId: z.string().trim().min(1).max(160).nullable(),
    roomId: z.string().trim().min(1).max(160).nullable().optional(),
    sharedBotIds: z
      .array(z.string().trim().min(1).max(160))
      .max(SERVICE_ACCOUNT_SHARED_BOT_LIMIT)
      .refine((value) => new Set(value).size === value.length, 'Choose each shared bot only once.')
      .optional(),
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
  let loginUrl = '';
  let credentialOrigin: string | undefined;
  try {
    ({ loginUrl, credentialOrigin } = resolveServiceLogin(account.url, account.loginUrl));
  } catch {
    // Preserve access to settings for malformed legacy/imported entries. Empty
    // loginUrl is deliberately invalid, so runtime resolution cannot fall back
    // to another recipient when an explicit saved entry was invalid.
  }
  return {
    id: account.id,
    name: account.name,
    url: account.url,
    loginUrl,
    credentialOrigin,
    login: account.login,
    botId: account.botId,
    roomId: account.roomId,
    sharedBotIds: [...(account.sharedBotIds ?? [])],
    mailAccountId: account.mailAccountId,
    status: account.status,
    notes: account.notes,
    // Presence is public metadata; decrypt only for an explicit owner read or
    // the validated just-in-time browser resolver. setSecret removes empty rows.
    credentialConfigured: Boolean(
      store.db.prepare('SELECT 1 FROM secrets WHERE key=?').get(secretName(account.id)),
    ),
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

/** Deliberate user-only read. Never include this result in snapshots or bot tool output. */
export function readServiceCredential(
  store: Store,
  accountId: string,
  expectedRevision: number,
): ServiceAccountCredential {
  const account =
    store.get<ServiceAccount>('serviceAccounts', accountId) ??
    fail('Service account not found.', 404);
  if (account.revision !== expectedRevision)
    fail('This service account changed. Reopen its settings before reading the credential.', 409);
  let credential: string;
  try {
    credential = store.secret(secretName(account.id));
  } catch {
    // Never forward a storage/decryption diagnostic to the API or request log.
    return fail('The saved service credential could not be read.', 500);
  }
  if (!credential) fail('This service account has no saved credential.', 404);
  return { accountId: account.id, revision: account.revision, credential };
}

/** Resolve only for server-side credential application; never return this value in bot output. */
export function readServiceCredentialForBot(
  store: Store,
  accountId: string,
  expectedRevision: number,
  botId: string,
  roomId: string,
): ServiceAccountCredential {
  const unavailable = () =>
    fail('The service credential is unavailable to this bot. Refresh assigned services.', 403);
  const bot = store.get<Bot>('bots', botId);
  const room = store.get<Room>('rooms', roomId);
  const account = store.get<ServiceAccount>('serviceAccounts', accountId);
  if (
    bot?.enabled !== true ||
    !room ||
    room.archived ||
    room.deletion ||
    !room.botIds.includes(botId) ||
    !account ||
    account.status === 'disabled' ||
    account.revision !== expectedRevision ||
    !serviceAccountAccessibleByBot(account, botId, roomId)
  )
    return unavailable();
  let credential: string;
  try {
    credential = store.secret(secretName(account.id));
  } catch {
    return unavailable();
  }
  if (!credential) return unavailable();
  return { accountId: account.id, revision: account.revision, credential };
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
  if (input.botId && input.sharedBotIds?.includes(input.botId))
    fail('The managing bot already has access. Choose other bots for sharing.');
  const sharedBotIds = (input.sharedBotIds ?? existing?.sharedBotIds ?? []).filter(
    (botId) => botId !== input.botId,
  );
  const proposedRoomId = input.roomId === undefined ? existing?.roomId : input.roomId;
  const roomId =
    proposedRoomId === undefined
      ? fail('Choose a room or explicitly share this service with all rooms.')
      : proposedRoomId;
  if (existing?.roomId) assertRoomWritable(store, existing.roomId);
  if (roomId) assertRoomWritable(store, roomId);
  // Retain historical assignments without recreating missing bots or room grants.
  // Owners may also revoke access while a service in an archived room awaits reassignment.
  const preservesOrReducesAssignments = Boolean(
    existing &&
    existing.roomId === roomId &&
    (input.botId === existing.botId || input.botId === null) &&
    sharedBotIds.every((botId) => (existing.sharedBotIds ?? []).includes(botId)),
  );
  if (!preservesOrReducesAssignments) {
    if (input.botId && !store.get<Bot>('bots', input.botId)) fail('Choose an existing bot.');
    if (sharedBotIds.some((botId) => !store.get<Bot>('bots', botId)))
      fail('Choose existing bots for sharing.');
    if (roomId !== null) {
      const room = store.get<Room>('rooms', roomId) ?? fail('Choose an existing room.');
      if (room.archived) fail('Choose an active room for a new service assignment.');
      if ([input.botId, ...sharedBotIds].some((botId) => botId && !room.botIds.includes(botId)))
        fail('Choose managing and shared bots that belong to the selected room.');
    }
  }
  if (
    input.mailAccountId &&
    (!preservesOrReducesAssignments || input.mailAccountId !== existing?.mailAccountId)
  ) {
    const mail =
      store.get<MailAccount>('mailAccounts', input.mailAccountId) ??
      fail('Choose an existing mail account.');
    if (input.botId && !mail.botIds.includes(input.botId))
      fail('Assign this mail account to the selected bot first.');
  }
  const { credential, expectedRevision: _, ...fields } = input;
  const stamp = now();
  const key = existing?.id ?? id('service');
  // A working-page edit must neither erase a password nor authorize a new
  // recipient. Only an explicit login entry edit can change its bound origin.
  const { loginUrl, credentialOrigin } = resolveServiceLogin(
    fields.url,
    input.loginUrl ?? existing?.loginUrl,
  );
  const identityChanged = Boolean(
    existing && (existing.credentialOrigin !== credentialOrigin || existing.login !== fields.login),
  );
  const storedCredential = credential ?? (identityChanged ? '' : store.secret(secretName(key)));
  const account: ServiceAccount = {
    ...fields,
    loginUrl,
    credentialOrigin,
    roomId,
    sharedBotIds,
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
    const detachSharedBot = reference.botId && account.sharedBotIds?.includes(reference.botId);
    const detachMail = reference.mailAccountId && account.mailAccountId === reference.mailAccountId;
    if (!detachBot && !detachSharedBot && !detachMail) continue;
    store.patch<ServiceAccount>('serviceAccounts', account.id, {
      ...(detachBot ? { botId: null } : {}),
      ...(detachSharedBot
        ? { sharedBotIds: account.sharedBotIds!.filter((botId) => botId !== reference.botId) }
        : {}),
      ...(detachMail ? { mailAccountId: null } : {}),
      revision: account.revision + 1,
      updatedAt: now(),
    });
  }
}
