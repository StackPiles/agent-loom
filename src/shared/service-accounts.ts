/** External service identities are retained independently of bots and rooms. */
export type ServiceAccountStatus = 'active' | 'pending' | 'disabled';
export const SERVICE_ACCOUNT_SHARED_BOT_LIMIT = 100;

export interface ServiceAccount {
  id: string;
  name: string;
  url: string;
  login: string;
  /** The managing bot; shared bots may use the service but cannot change its record. */
  botId: string | null;
  /** Explicit additional recipients. Legacy records omit this and remain private. */
  sharedBotIds?: string[];
  mailAccountId: string | null;
  status: ServiceAccountStatus;
  notes: string;
  credentialConfigured: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Credentials are encrypted separately and omitted from public records and bot tools. */
export interface ServiceAccountInput {
  name: string;
  url: string;
  login: string;
  botId: string | null;
  /** Omit on update to preserve recipients, or send [] to remove all shares. */
  sharedBotIds?: string[];
  mailAccountId: string | null;
  status: ServiceAccountStatus;
  notes: string;
  credential?: string;
  expectedRevision?: number;
}

/** Server-only value except for an explicit credential request in the user's settings. */
export interface ServiceAccountCredential {
  accountId: string;
  revision: number;
  credential: string;
}

/** Assignment alone does not grant browser, mail, or other tool permissions. */
export function serviceAccountAccessibleByBot(
  account: Pick<ServiceAccount, 'botId' | 'sharedBotIds'>,
  botId: string,
): boolean {
  return account.botId === botId || (account.sharedBotIds ?? []).includes(botId);
}
