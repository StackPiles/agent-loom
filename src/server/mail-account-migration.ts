import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Automation, Bot } from '../shared/types.js';
import type { MailAccount } from '../shared/mail-accounts.js';
import { normalizeMailPassword } from '../shared/mail-settings.js';
import { mailAccountSecretKey } from './mail-accounts.js';
import { now, type Store } from './store.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function sourceIdentity(automation: Automation): string {
  const imap = automation.imap!;
  return digest(
    JSON.stringify(['imap', imap.host, imap.port, imap.secure, imap.user, imap.mailbox || 'INBOX']),
  );
}

/**
 * Existing mail watchers become read-only account connections without network I/O.
 * A username that is not an email address stays on the working legacy path: it
 * cannot safely be guessed into a From address. Repeated startup is idempotent.
 */
export function migrateLegacyMailAccounts(store: Store): number {
  const bots = new Set(store.list<Bot>('bots').map((bot) => bot.id));
  const rules = store
    .list<Automation>('automations')
    .filter(
      (rule) =>
        rule.kind === 'imap' &&
        !rule.mailAccountId &&
        rule.imap &&
        z.email().safeParse(rule.imap.user.trim()).success,
    );
  if (!rules.length) return 0;
  const groups = new Map<string, { rules: Automation[]; password: string }>();
  for (const rule of rules) {
    const password = normalizeMailPassword(rule.imap!, store.secret(`imap.${rule.id}.password`));
    // Only an in-memory key includes the credential; no password-derived value
    // is exposed as the new account's ID or persisted in its metadata.
    const groupKey = JSON.stringify([sourceIdentity(rule), password]);
    const group = groups.get(groupKey) ?? { rules: [], password };
    group.rules.push(rule);
    groups.set(groupKey, group);
  }
  let migrated = 0;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const { rules: groupedRules, password } of groups.values()) {
      groupedRules.sort((a, b) => a.id.localeCompare(b.id));
      const first = groupedRules[0];
      const imap = first.imap!;
      const legacyIdentity = sourceIdentity(first);
      const existing = store
        .list<MailAccount>('mailAccounts')
        .find(
          (account) =>
            account.id.startsWith('mail_legacy_') &&
            account.provider === 'imap' &&
            !account.smtp &&
            account.address === imap.user.trim() &&
            account.imap &&
            sourceIdentity({ ...first, imap: account.imap }) === legacyIdentity &&
            store.secret(mailAccountSecretKey(account.id, 'imap')) === password,
        );
      const baseId = `mail_legacy_${digest(first.id).slice(0, 20)}`;
      let accountId = existing?.id ?? baseId;
      // A previously migrated rule may later be changed back to a different
      // inline connection. Never overwrite its earlier, independently owned account.
      if (!existing) {
        let suffix = 1;
        while (store.get('mailAccounts', accountId)) accountId = `${baseId}_${++suffix}`;
      }
      const stamp = now();
      const botIds = [
        ...new Set([
          ...(existing?.botIds ?? []),
          ...groupedRules.map((rule) => rule.botId).filter((botId) => bots.has(botId)),
        ]),
      ];
      const { passwordConfigured: _, ...connection } = imap;
      const account: MailAccount = {
        ...(existing ?? {}),
        id: accountId,
        name: existing?.name ?? first.name.slice(0, 160),
        address: imap.user.trim(),
        provider: 'imap',
        enabled: existing?.enabled ?? Boolean(password),
        botIds,
        sendPolicy: existing?.sendPolicy ?? 'ask',
        imap: {
          ...connection,
          mailbox: connection.mailbox || 'INBOX',
          passwordConfigured: Boolean(password),
        },
        revision: existing ? existing.revision + 1 : 1,
        createdAt: existing?.createdAt ?? groupedRules.map((rule) => rule.createdAt).sort()[0],
        updatedAt: stamp,
      };
      store.setSecret(mailAccountSecretKey(accountId, 'imap'), password);
      store.put('mailAccounts', account);
      for (const rule of groupedRules) {
        store.patch<Automation>('automations', rule.id, { mailAccountId: accountId });
        const state = store.get<{
          id: string;
          sourceIdentity?: string;
          uidValidity?: string;
          lastUid?: number;
          [key: string]: unknown;
        }>('automationState', rule.id);
        if (
          state?.sourceIdentity === sourceIdentity(rule) &&
          state.uidValidity !== undefined &&
          state.lastUid !== undefined
        )
          store.put('automationState', { ...state, legacyMailAccountId: accountId });
        migrated++;
      }
    }
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return migrated;
}
