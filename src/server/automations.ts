import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Automation, Bot, Room, Snapshot, Task } from '../shared/types.js';
import type { MailAccount } from '../shared/mail-accounts.js';
import { normalizeMailPassword, sameMailAccount } from '../shared/mail-settings.js';
import { mailConnectionSchema } from './mail.js';
import { id, now, type Store } from './store.js';

const short = z.string().trim().min(1).max(160);
const text = z.string().trim().min(1).max(32_000);
export const automationSchema = z.object({
  name: short,
  kind: z.enum(['interval', 'url_watch', 'webhook', 'imap']),
  roomId: short,
  botId: short,
  prompt: text,
  intervalMinutes: z.number().int().min(1).max(525600),
  sourceUrl: z.string().max(2000),
  enabled: z.boolean(),
  mailAccountId: short.nullish(),
  imap: mailConnectionSchema.optional(),
});
export type AutomationInput = z.infer<typeof automationSchema>;
export interface AutomationExpectation {
  id: string;
  revision: string;
}

function problem(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}

/** Only user-editable configuration participates: polling must not invalidate a review. */
export function automationRevision(automation: Automation): string {
  return createHash('sha256')
    .update(JSON.stringify(automationSchema.parse(automation)))
    .digest('hex');
}

export function saveAutomation(
  store: Store,
  input: AutomationInput,
  existing?: Automation,
): Automation {
  input = automationSchema.parse(input);
  const room = store.get<Room>('rooms', input.roomId);
  const bot = store.get<Bot>('bots', input.botId);
  if (!room || !bot) problem('Choose an existing room and bot.', 404);
  if (room.archived) problem('Restore this room before configuring an automation.', 409);
  if (!bot.enabled || !room.botIds.includes(bot.id))
    problem('Choose an enabled bot that belongs to this room.');
  if (input.kind === 'url_watch') {
    let url: URL;
    try {
      url = new URL(input.sourceUrl);
    } catch {
      problem('A valid page URL is required.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      problem('Use a public HTTP or HTTPS page URL without credentials.');
  }
  const mailAccountId = input.kind === 'imap' ? input.mailAccountId || undefined : undefined;
  if (input.kind === 'imap' && !mailAccountId && !input.imap)
    problem('Choose a connected mail account, or configure an IMAP connection.');
  if (mailAccountId) {
    const account = store.get<MailAccount>('mailAccounts', mailAccountId);
    if (!account) problem('The selected mail account is no longer connected.', 404);
    if (!account.botIds.includes(bot.id))
      problem('Assign this mail account to the selected bot in Accounts first.');
    if (input.enabled && !account.enabled)
      problem('Enable this mail account in Accounts before enabling its automation.');
  }
  const automationId = existing?.id ?? id('auto');
  const { imap: suppliedImap, ...fields } = input;
  const imap = input.kind === 'imap' && !mailAccountId ? suppliedImap : undefined;
  const { password, ...imapFields } = imap ?? {};
  const previousPassword = existing ? store.secret(`imap.${automationId}.password`) : '';
  const nextPassword = imap
    ? password !== undefined
      ? normalizeMailPassword(imap, password)
      : existing?.kind === 'imap' && existing.imap && sameMailAccount(existing.imap, imap)
        ? previousPassword
        : ''
    : '';
  if (input.kind === 'imap' && !mailAccountId && input.enabled && !nextPassword)
    problem('Add the mail app password before enabling this automation, or save it disabled.');
  const automation: Automation = {
    ...fields,
    mailAccountId,
    id: automationId,
    createdAt: existing?.createdAt ?? now(),
    nextRunAt:
      input.enabled && input.kind !== 'webhook'
        ? new Date(Date.now() + input.intervalMinutes * 60_000).toISOString()
        : undefined,
    lastRunAt: existing?.lastRunAt,
    imap: imap
      ? ({ ...imapFields, passwordConfigured: Boolean(nextPassword) } as Automation['imap'])
      : undefined,
  };
  if (
    existing &&
    (existing.kind !== input.kind ||
      (input.kind === 'url_watch' && existing.sourceUrl !== input.sourceUrl) ||
      existing.mailAccountId !== mailAccountId ||
      (!mailAccountId && JSON.stringify(existing.imap) !== JSON.stringify(automation.imap)))
  ) {
    const state = store.get<{ id: string; lastTaskId?: string; [key: string]: unknown }>(
      'automationState',
      automationId,
    ) ?? { id: automationId };
    // Retain the prior task so a source edit cannot bypass overlap prevention.
    for (const key of [
      'sourceIdentity',
      'sourceHash',
      'uidValidity',
      'lastUid',
      'mailCursor',
      'pendingMail',
      'coalescedMailCount',
      'legacyMailAccountId',
    ])
      delete state[key];
    if (input.kind === 'imap') state.mailSince = now();
    else delete state.mailSince;
    if (existing.kind !== input.kind) {
      delete state.pendingWebhooks;
      delete state.coalescedWebhookCount;
    }
    store.put('automationState', state);
  }
  store.setSecret(`imap.${automationId}.password`, nextPassword);
  if (existing?.kind === 'webhook' && input.kind !== 'webhook')
    store.setSecret(`hook.${automationId}`, '');
  store.put('automations', automation);
  return automation;
}

export function removeAutomation(store: Store, automationId: string): void {
  if (!store.get<Automation>('automations', automationId)) problem('Not found', 404);
  store.remove('automations', automationId);
  store.remove('automationState', automationId);
  store.setSecret(`imap.${automationId}.password`, '');
  store.setSecret(`hook.${automationId}`, '');
}

const botMailSchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .max(250)
      .regex(/^[a-zA-Z0-9.:-]+$/)
      .default('imap.gmail.com'),
    port: z.number().int().min(1).max(65535).default(993),
    secure: z.boolean().default(true),
    user: z.string().trim().min(1).max(250),
    mailbox: z.string().trim().min(1).max(250).default('INBOX'),
  })
  .strict();
export const botAutomationSchema = z
  .object({
    operation: z.enum(['create', 'update', 'pause', 'resume']),
    automationId: short.optional(),
    name: short.optional(),
    kind: z.enum(['interval', 'url_watch', 'webhook', 'imap']).optional(),
    botHandle: short.optional(),
    prompt: text.optional(),
    intervalMinutes: z.number().int().min(1).max(525600).optional(),
    sourceUrl: z.string().max(2000).optional(),
    enabled: z.boolean().optional(),
    mailAccountId: short.nullish(),
    imap: botMailSchema.optional(),
  })
  .strict();
export type BotAutomationInput = z.infer<typeof botAutomationSchema>;

export interface AutomationPlan {
  input: AutomationInput;
  expected?: AutomationExpectation;
  summary: string;
  target: string;
  details: Record<string, unknown>;
}

export function prepareAutomationChange(
  snapshot: Snapshot,
  task: Task,
  args: BotAutomationInput,
): AutomationPlan {
  if (task.kind !== 'chat' || task.parentTaskId || task.depth !== 0)
    problem('Only a direct user chat task can configure automations.');
  const room = snapshot.rooms.find((candidate) => candidate.id === task.roomId);
  const actor = snapshot.bots.find((candidate) => candidate.id === task.botId);
  if (!room || room.archived || !actor?.enabled || !room.botIds.includes(actor.id))
    problem('The requesting bot must still be an enabled member of this active room.', 409);
  const existing = args.automationId
    ? snapshot.automations.find(
        (candidate) => candidate.id === args.automationId && candidate.roomId === room.id,
      )
    : undefined;
  if (args.operation === 'create' && args.automationId)
    problem('Do not supply an automationId when creating a new rule.');
  if (args.operation !== 'create' && !existing)
    problem('Choose an existing automation in this room using list_automations.', 404);
  if (
    ['pause', 'resume'].includes(args.operation) &&
    Object.keys(args).some((key) => !['operation', 'automationId'].includes(key))
  )
    problem('Pause and resume accept only operation and automationId. Use update to edit fields.');
  const handle = args.botHandle?.replace(/^@/, '').toLowerCase();
  const bot = handle
    ? snapshot.bots.find((candidate) => candidate.handle.replace(/^@/, '').toLowerCase() === handle)
    : snapshot.bots.find((candidate) => candidate.id === (existing?.botId ?? task.botId));
  if (!bot?.enabled || !room.botIds.includes(bot.id))
    problem('Choose an enabled @handle that belongs to this room.');
  const input = automationSchema.parse({
    name: args.name ?? existing?.name,
    kind: args.kind ?? existing?.kind,
    roomId: room.id,
    botId: bot.id,
    prompt: args.prompt ?? existing?.prompt,
    intervalMinutes: args.intervalMinutes ?? existing?.intervalMinutes ?? 60,
    sourceUrl: args.sourceUrl ?? existing?.sourceUrl ?? '',
    enabled:
      args.operation === 'pause'
        ? false
        : args.operation === 'resume'
          ? true
          : (args.enabled ?? existing?.enabled ?? true),
    imap: args.imap ?? existing?.imap,
    mailAccountId: args.mailAccountId !== undefined ? args.mailAccountId : existing?.mailAccountId,
  });
  if (input.kind === 'url_watch') {
    let url: URL;
    try {
      url = new URL(input.sourceUrl);
    } catch {
      problem('A valid page URL is required.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      problem('Use a public HTTP or HTTPS page URL without credentials.');
  }
  if (input.kind === 'imap') {
    if (input.mailAccountId) {
      const account = snapshot.mailAccounts?.find((item) => item.id === input.mailAccountId);
      if (!account || !account.botIds.includes(bot.id))
        problem('Choose a mail account already assigned to the selected bot in Accounts.');
      if (!account.enabled && input.enabled)
        problem('Enable the mail account in Accounts before enabling its automation.');
      if (args.imap)
        problem('Use mailAccountId for a connected account; do not supply inline IMAP settings.');
      input.imap = undefined;
    } else {
      if (!input.imap)
        problem('Choose mailAccountId, or provide imap.user for a disabled setup draft.');
      if (existing?.imap?.passwordConfigured && !sameMailAccount(existing.imap, input.imap))
        problem('Change a connected mail account in the automation editor, not through a bot.');
      const configured = Boolean(
        existing?.kind === 'imap' &&
        existing.imap?.passwordConfigured &&
        sameMailAccount(existing.imap, input.imap),
      );
      if (!configured) {
        if (args.operation === 'resume')
          problem('Add the mail app password in the automation editor before resuming this rule.');
        input.enabled = false;
      }
    }
  } else {
    input.imap = undefined;
    input.mailAccountId = undefined;
  }
  const operationLabel = {
    create: 'Create automation',
    update: 'Update automation',
    pause: 'Pause automation',
    resume: 'Resume automation',
  }[args.operation];
  const trigger =
    input.kind === 'webhook'
      ? 'Incoming webhook'
      : `${input.kind === 'imap' ? 'New email' : input.kind === 'url_watch' ? 'Page changes' : 'Scheduled task'}; every ${input.intervalMinutes} minute(s)`;
  return {
    input,
    expected: existing ? { id: existing.id, revision: automationRevision(existing) } : undefined,
    summary: `${operationLabel}: ${input.name}${input.enabled ? '' : ' (disabled)'}`,
    target: `${room.name} → ${bot.name} (@${bot.handle.replace(/^@/, '')})`,
    details: {
      operation: args.operation,
      ...(existing ? { automationId: existing.id } : {}),
      name: input.name,
      room: { id: room.id, name: room.name },
      bot: { id: bot.id, name: bot.name, handle: bot.handle },
      trigger,
      kind: input.kind,
      intervalMinutes: input.intervalMinutes,
      enabled: input.enabled,
      instructions: input.prompt,
      ...(input.kind === 'url_watch' ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.imap ? { imap: input.imap } : {}),
      ...(input.mailAccountId
        ? {
            mailAccount: snapshot.mailAccounts
              ?.filter((item) => item.id === input.mailAccountId)
              .map((item) => ({
                id: item.id,
                name: item.name,
                address: item.address,
                provider: item.provider,
              }))[0],
          }
        : {}),
      note:
        input.kind === 'imap' && !input.mailAccountId && !existing?.imap?.passwordConfigured
          ? 'Saved disabled. Enter the app password and test the connection in Automations, then enable. Never paste credentials into chat.'
          : input.kind === 'webhook'
            ? 'Generate or manage its webhook token in Automations. The bot cannot read it.'
            : 'Runs while the Loom server is on. Intervals are measured from saving; exact clock-time schedules are not supported. Existing tasks are not cancelled by pausing.',
    },
  };
}
