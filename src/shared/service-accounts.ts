/** External service identities are retained independently of bots and rooms. */
export type ServiceAccountStatus = 'active' | 'pending' | 'disabled';

export interface ServiceAccount {
  id: string;
  name: string;
  url: string;
  login: string;
  botId: string | null;
  mailAccountId: string | null;
  status: ServiceAccountStatus;
  notes: string;
  credentialConfigured: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Credentials are write-only and encrypted separately from public records. */
export interface ServiceAccountInput {
  name: string;
  url: string;
  login: string;
  botId: string | null;
  mailAccountId: string | null;
  status: ServiceAccountStatus;
  notes: string;
  credential?: string;
  expectedRevision?: number;
}
