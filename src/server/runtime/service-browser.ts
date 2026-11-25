import { serviceAccountAccessibleByBot } from '../../shared/service-accounts.js';
import { resolveServiceLogin } from '../../shared/service-login.js';
import type { BrowserCredentialBinding } from '../browser.js';
import { ServiceCredentialUseError } from '../service-credential-error.js';
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
    throw new ServiceCredentialUseError({
      code: 'credential_reference_invalid',
      message:
        'Saved credential use requires fill, serviceId and the current expectedRevision, without text.',
      actionIssued: false,
      nextAction: 'refresh_services',
    });
  if (!context.host.readServiceCredentialForBot)
    throw new ServiceCredentialUseError({
      code: 'credential_unavailable',
      message: 'Saved service credential use is unavailable.',
      actionIssued: false,
      nextAction: 'refresh_services',
    });
  const revision = expectedRevision as number;
  const current = () => {
    const { host, task } = context;
    // Keep each check current across approval, queueing and MCP calls, while
    // reading only this actor and service. Older hosts retain snapshot support.
    const snapshot =
      host.getBot && host.getRoom && host.getServiceAccount ? undefined : host.getSnapshot();
    const bot = host.getBot
      ? host.getBot(task.botId)
      : snapshot!.bots.find((item) => item.id === task.botId);
    const room = host.getRoom
      ? host.getRoom(task.roomId)
      : snapshot!.rooms.find((item) => item.id === task.roomId);
    const account = host.getServiceAccount
      ? host.getServiceAccount(serviceId)
      : snapshot!.serviceAccounts?.find((item) => item.id === serviceId);
    if (!bot?.enabled || !room || room.archived || room.deletion || !room.botIds.includes(bot.id))
      throw new ServiceCredentialUseError({
        code: 'credential_access_denied',
        message: 'This bot is no longer enabled in the current room.',
        actionIssued: false,
        nextAction: 'refresh_services',
      });
    if (!account || !serviceAccountAccessibleByBot(account, bot.id, room.id))
      throw new ServiceCredentialUseError({
        code: 'credential_access_denied',
        message: 'This service is not shared with the current bot in this room.',
        actionIssued: false,
        nextAction: 'refresh_services',
      });
    if (account.revision !== revision)
      throw new ServiceCredentialUseError({
        code: 'service_revision_stale',
        message: 'The service changed. List its current revision and review a new action.',
        actionIssued: false,
        nextAction: 'refresh_services',
      });
    if (account.status === 'disabled')
      throw new ServiceCredentialUseError({
        code: 'service_disabled',
        message: 'This service is disabled.',
        actionIssued: false,
        nextAction: 'refresh_services',
      });
    if (!account.credentialConfigured)
      throw new ServiceCredentialUseError({
        code: 'credential_missing',
        message: 'This service has no saved credential.',
        actionIssued: false,
        credentialStored: false,
        nextAction: 'configure_credential',
      });
    return account;
  };
  const account = current();
  let login: ReturnType<typeof resolveServiceLogin>;
  try {
    login = resolveServiceLogin(account.url, account.loginUrl);
  } catch {
    throw new ServiceCredentialUseError({
      code: 'service_login_invalid',
      message: 'This service has no valid registered login destination.',
      actionIssued: false,
      nextAction: 'configure_service_login',
    });
  }
  const origin = login.credentialOrigin;
  return {
    assertCurrent: () => {
      current();
    },
    binding: {
      origin,
      resolve: () => {
        current();
        try {
          return context.host.readServiceCredentialForBot!(
            serviceId,
            revision,
            context.task.botId,
            context.task.roomId,
          ).credential;
        } catch {
          throw new ServiceCredentialUseError({
            code: 'credential_unavailable',
            message: 'The saved service credential is unavailable. Refresh assigned services.',
            actionIssued: false,
            nextAction: 'refresh_services',
          });
        }
      },
    },
    summary: `Use the saved credential for ${account.name} in this service's password field. The site may receive it immediately.`,
    args: {
      serviceId,
      expectedRevision: revision,
      serviceName: account.name,
      serviceOrigin: origin,
      serviceLoginUrl: login.loginUrl,
      serviceLogin: account.login,
      serviceRoomId: account.roomId,
      credentialAction: 'use_saved',
    },
  };
}
