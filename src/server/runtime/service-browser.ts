import { serviceAccountAccessibleByBot } from '../../shared/service-accounts.js';
import type { BrowserCredentialBinding } from '../browser.js';
import type { ToolContext } from './contract.js';

/** Bind a public service reference to one server-only, just-in-time credential read. */
export function prepareServiceBrowserCredential(
  context: ToolContext,
  args: { operation: string; text?: unknown; serviceId?: unknown; expectedRevision?: unknown },
):
  | {
      assertCurrent(): void;
      binding: BrowserCredentialBinding;
      summary: string;
      args: Record<string, unknown>;
    }
  | undefined {
  if (args.serviceId === undefined && args.expectedRevision === undefined) return;
  const { serviceId, expectedRevision } = args;
  if (
    args.operation !== 'fill' ||
    args.text !== undefined ||
    typeof serviceId !== 'string' ||
    !serviceId ||
    serviceId.length > 160 ||
    !Number.isSafeInteger(expectedRevision) ||
    Number(expectedRevision) < 1
  )
    throw new Error(
      'Saved credential use requires fill, serviceId and the current expectedRevision, without text.',
    );
  if (!context.host.readServiceCredentialForBot)
    throw new Error('Saved service credential use is unavailable.');
  const revision = expectedRevision as number;
  const current = () => {
    const snapshot = context.host.getSnapshot();
    const bot = snapshot.bots.find((item) => item.id === context.task.botId);
    const room = snapshot.rooms.find((item) => item.id === context.task.roomId);
    const account = snapshot.serviceAccounts?.find((item) => item.id === serviceId);
    if (!bot?.enabled || !room || room.archived || !room.botIds.includes(bot.id))
      throw new Error('This bot is no longer enabled in the current room.');
    if (!account || !serviceAccountAccessibleByBot(account, bot.id))
      throw new Error('This service is not shared with the current bot.');
    if (account.revision !== revision)
      throw new Error('The service changed. List its current revision and review a new action.');
    if (account.status === 'disabled' || !account.credentialConfigured)
      throw new Error('This service is disabled or has no saved credential.');
    return account;
  };
  const account = current();
  const origin = new URL(account.url).origin;
  return {
    assertCurrent: () => {
      current();
    },
    binding: {
      origin,
      resolve: () => {
        current();
        return context.host.readServiceCredentialForBot!(serviceId, revision, context.task.botId)
          .credential;
      },
    },
    summary: `Use the saved credential for ${account.name} in this service's password field. The site may receive it immediately.`,
    args: {
      serviceId,
      expectedRevision: revision,
      serviceName: account.name,
      serviceOrigin: origin,
      serviceLogin: account.login,
      credentialAction: 'use_saved',
    },
  };
}
