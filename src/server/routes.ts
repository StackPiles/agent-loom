import type { FastifyInstance } from 'fastify';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Store, id, now } from './store.js';
import { Controller, ACTIVE, problem, required } from './controller.js';
import { registerIntegrationRoutes } from './integrations.js';
import { readGeneratedImage } from './runtime/images.js';
import { getAvatarImageId, isValidAvatar } from '../shared/avatars.js';
import { BOT_BROWSER_MODES, botBrowserMode } from '../shared/browser.js';
import type { createScheduler } from './scheduler.js';
import type { MailAccount } from '../shared/mail-accounts.js';
import { detachServiceAccounts } from './service-accounts.js';
import { autonomousWakeupPolicySchema, workCheckpointSchema } from './work.js';
import {
  learningVersionSchema,
  memoryInputSchema,
  memoryMergeSchema,
  memoryPatchSchema,
  skillInputSchema,
  skillPatchSchema,
} from './learning.js';
import type {
  Automation,
  Bot,
  GeneratedImage,
  Notification,
  Room,
  Skill,
  Task,
  WorkItem,
  Wakeup,
} from '../shared/types.js';

export interface RouteContext {
  store: Store;
  controller: Controller;
  scheduler: ReturnType<typeof createScheduler>;
}
export const short = z.string().trim().min(1).max(160);
export const text = z.string().trim().min(1).max(32_000);
const botSchema = z.object({
  name: short,
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_-]{0,23}$/),
  role: z.string().trim().max(160),
  systemPrompt: text,
  color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  avatar: z
    .string()
    .max(80)
    .refine(isValidAvatar, 'Choose a character, symbol, or generated image.'),
  enabled: z.boolean(),
  browser: z
    .object({ mode: z.enum(BOT_BROWSER_MODES) })
    .strict()
    .optional(),
});
const roomSchema = z.object({
  name: short,
  description: z.string().trim().max(1000),
  botIds: z.array(z.string()).min(1).max(24),
  parallelResponses: z.boolean().optional(),
  autonomousWakeups: autonomousWakeupPolicySchema.optional(),
  workspacePath: z
    .string()
    .min(1)
    .max(2000)
    .refine((value) => !value.includes('\0'), 'The path must not contain NUL characters.')
    .nullable()
    .optional(),
});

function prepareRoomWorkspace(value: string): string {
  const workspace = resolve(value);
  try {
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
  } catch {
    problem(
      'This workspace folder could not be opened or created. Choose an accessible directory.',
      400,
    );
  }
  return workspace;
}

export function registerRoutes(app: FastifyInstance, context: RouteContext) {
  const { store, controller } = context;
  const activeTasks = () => store.list<Task>('tasks').filter((t) => ACTIVE.has(t.status));
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    '/api/images/:id',
    async (req, reply) => {
      if (!/^img_[a-f0-9]{64}$/.test(req.params.id)) problem('Image not found', 404);
      const image = required<GeneratedImage>(store, 'images', req.params.id);
      let content: Buffer;
      try {
        content = await readGeneratedImage(store.dataDir, image);
      } catch {
        problem('The generated image is unavailable or could not be read safely.', 404);
      }
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[
        image.mimeType
      ];
      const filename = `generated-${image.id.slice(4, 16)}.${extension}`;
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Content-Disposition',
          `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`,
        )
        .type(image.mimeType)
        .send(content);
    },
  );
  function checkHandle(handle: string, except?: string) {
    if (
      handle === 'all' &&
      (!except || store.get<Bot>('bots', except)?.handle.toLowerCase() !== 'all')
    )
      problem(
        'The handle “all” is reserved for messaging all enabled members of a room. Choose another handle.',
      );
    if (store.list<Bot>('bots').some((b) => b.handle.toLowerCase() === handle && b.id !== except))
      problem('That handle is already in use.', 409);
  }
  function checkAvatar(value: string | undefined) {
    if (value === undefined) return;
    const imageId = getAvatarImageId(value);
    if (imageId && !store.get<GeneratedImage>('images', imageId))
      problem('This generated avatar is unavailable. Generate or select another image.');
  }
  function checkBots(ids: string[]) {
    for (const botId of ids) required<Bot>(store, 'bots', botId);
    return [...new Set(ids)];
  }
  function pauseRules(matches: (rule: Automation) => boolean, reason: string) {
    for (const rule of store.list<Automation>('automations'))
      if (rule.enabled && matches(rule))
        store.patch<Automation>('automations', rule.id, {
          enabled: false,
          nextRunAt: undefined,
          lastError: reason,
        });
  }
  async function pauseBotWork(botId: string) {
    const affected = new Set(
      store
        .list<Wakeup>('wakeups')
        .filter(
          (wake) =>
            wake.status === 'scheduled' && (wake.botId === botId || wake.createdByBotId === botId),
        )
        .map((wake) => wake.workId),
    );
    await Promise.all(
      store
        .list<WorkItem>('workItems')
        .filter(
          (work) =>
            ['active', 'blocked'].includes(work.status) &&
            (work.createdByBotId === botId || affected.has(work.id)),
        )
        .map((work) => controller.work.changeStatus(work.id, 'paused')),
    );
  }
  app.post('/api/bots', async (req) => {
    const input = botSchema.parse({
      enabled: true,
      browser: { mode: 'dedicated' },
      ...z.record(z.string(), z.unknown()).parse(req.body),
    });
    checkHandle(input.handle);
    checkAvatar(input.avatar);
    const bot = store.put<Bot>('bots', { ...input, id: id('bot'), createdAt: now() });
    controller.changed();
    return bot;
  });
  app.patch<{ Params: { id: string } }>('/api/bots/:id', async (req) => {
    const existing = required<Bot>(store, 'bots', req.params.id);
    const input = botSchema.partial().parse(req.body);
    checkAvatar(input.avatar);
    if (activeTasks().some((t) => t.botId === existing.id))
      problem('Stop this bot’s tasks before editing it.', 409);
    if (input.handle) checkHandle(input.handle, existing.id);
    const bot = store.patch<Bot>('bots', existing.id, input);
    if (!bot.enabled || botBrowserMode(bot) !== botBrowserMode(existing))
      await controller.browser?.releaseBot(bot.id);
    if (!bot.enabled) {
      pauseRules((rule) => rule.botId === bot.id, 'Paused because the assigned bot was disabled.');
      await pauseBotWork(bot.id);
    }
    controller.changed();
    return bot;
  });
  app.delete<{ Params: { id: string } }>('/api/bots/:id', async (req) => {
    required<Bot>(store, 'bots', req.params.id);
    if (activeTasks().some((t) => t.botId === req.params.id))
      problem('Stop this bot’s tasks before deleting it.', 409);
    await controller.browser?.releaseBot(req.params.id);
    store.remove('bots', req.params.id);
    for (const account of store.list<MailAccount>('mailAccounts')) {
      if (!account.botIds.includes(req.params.id)) continue;
      store.patch<MailAccount>('mailAccounts', account.id, {
        botIds: account.botIds.filter((botId) => botId !== req.params.id),
        revision: account.revision + 1,
        updatedAt: now(),
      });
    }
    detachServiceAccounts(store, { botId: req.params.id });
    for (const room of store.list<Room>('rooms'))
      if (room.botIds.includes(req.params.id))
        store.patch<Room>('rooms', room.id, {
          botIds: room.botIds.filter((b) => b !== req.params.id),
        });
    for (const automation of store.list<Automation>('automations'))
      if (automation.botId === req.params.id)
        store.patch<Automation>('automations', automation.id, {
          enabled: false,
          lastError: 'The assigned bot was deleted.',
        });
    await pauseBotWork(req.params.id);
    controller.changed();
    return { ok: true };
  });
  app.post('/api/rooms', async (req) => {
    const input = roomSchema.parse({
      description: '',
      ...z.record(z.string(), z.unknown()).parse(req.body),
    });
    const botIds = checkBots(input.botIds);
    const room = store.put<Room>('rooms', {
      ...input,
      workspacePath: input.workspacePath ? prepareRoomWorkspace(input.workspacePath) : undefined,
      botIds,
      id: id('room'),
      pinned: false,
      archived: false,
      createdAt: now(),
      updatedAt: now(),
    });
    controller.changed();
    return room;
  });
  app.patch<{ Params: { id: string } }>('/api/rooms/:id', async (req) => {
    const room = required<Room>(store, 'rooms', req.params.id);
    const patch = roomSchema
      .partial()
      .extend({ pinned: z.boolean().optional(), archived: z.boolean().optional() })
      .parse(req.body);
    const oldWorkspace = controller.roomWorkspacePath(room.id);
    const nextWorkspace =
      patch.workspacePath === undefined
        ? oldWorkspace
        : resolve(patch.workspacePath || store.settings().workspacePath);
    const workspaceChanged = nextWorkspace !== oldWorkspace;
    const roomBusy = activeTasks().some((task) => task.roomId === room.id);
    if (workspaceChanged && roomBusy)
      problem('Stop this room’s active tasks before changing its workspace folder.', 409);
    if (
      roomBusy &&
      patch.parallelResponses !== undefined &&
      patch.parallelResponses !== Boolean(room.parallelResponses)
    )
      problem('Stop this room’s active tasks before changing concurrent generation.', 409);
    if (patch.botIds) patch.botIds = checkBots(patch.botIds);
    const membersChanged =
      patch.botIds &&
      (patch.botIds.length !== room.botIds.length ||
        patch.botIds.some((botId) => !room.botIds.includes(botId)));
    if (roomBusy && (patch.archived || membersChanged))
      problem('Stop the room’s active tasks before changing members or archiving.', 409);
    if (workspaceChanged) controller.pinLegacyWorkspaces(room.id);
    const { workspacePath, ...fields } = patch;
    const updated = store.patch<Room>('rooms', room.id, {
      ...fields,
      ...(workspacePath !== undefined
        ? {
            workspacePath: workspacePath === null ? undefined : prepareRoomWorkspace(workspacePath),
          }
        : {}),
      updatedAt: now(),
    });
    pauseRules(
      (rule) =>
        rule.roomId === room.id && (updated.archived || !updated.botIds.includes(rule.botId)),
      'Paused because the room was archived or its assigned bot was removed.',
    );
    const narrowedWakeupScope =
      room.autonomousWakeups?.mode === 'room' && patch.autonomousWakeups?.mode === 'self';
    if (
      patch.autonomousWakeups?.mode === 'off' ||
      narrowedWakeupScope ||
      updated.archived ||
      membersChanged ||
      workspaceChanged
    ) {
      await Promise.all(
        store
          .list<WorkItem>('workItems')
          .filter((work) => work.roomId === room.id && ['active', 'blocked'].includes(work.status))
          .map((work) => controller.work.changeStatus(work.id, 'paused')),
      );
    }
    controller.changed();
    return updated;
  });
  app.post<{ Params: { id: string } }>('/api/rooms/:id/pause', async (req) => ({
    room: controller.pauseRoom(req.params.id),
  }));
  app.post<{ Params: { id: string } }>('/api/rooms/:id/resume', async (req) => ({
    room: controller.resumeRoom(req.params.id),
  }));
  app.post<{ Params: { id: string } }>('/api/rooms/:id/messages', async (req) => {
    const input = z
      .object({ body: text, botIds: z.array(z.string()).max(24).optional() })
      .parse(req.body);
    const room = required<Room>(store, 'rooms', req.params.id);
    const bots = store.list<Bot>('bots').filter((b) => b.enabled && room.botIds.includes(b.id));
    const handles = [...input.body.matchAll(/(?:^|\s)@([a-z][a-z0-9_-]*)/gi)].map((m) =>
      m[1].toLowerCase(),
    );
    const mentioned = handles.includes('all')
      ? bots
      : bots.filter((bot) => handles.includes(bot.handle.toLowerCase()));
    let selected = input.botIds?.length
      ? [...new Set(input.botIds)]
      : mentioned.map((bot) => bot.id);
    if (!selected.length && bots[0]) selected = [bots[0].id];
    if (!selected.length) problem('Add an enabled bot to this room before sending.', 409);
    selected.forEach((botId) => controller.validateTarget(room.id, botId));
    const settings = store.settings();
    if (!settings.demoMode && (!settings.model.modelId || !settings.model.baseUrl))
      problem('Connect a model in Settings, or enable demo mode.', 409);
    if (activeTasks().length + selected.length > 200)
      problem('The task queue does not have enough space for these recipients.', 429);
    const message = controller.addMessage({
      roomId: room.id,
      authorType: 'user',
      authorId: 'user',
      body: input.body,
      status: 'complete',
      targetBotIds: selected,
    });
    const tasks = selected.map((botId) =>
      controller.enqueueTask({ roomId: room.id, botId, prompt: input.body }),
    );
    return { message, tasks };
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/stop', async (req) =>
    controller.stop(req.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/tasks/:id/resume', async (req) =>
    controller.resume(req.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/tasks/:id/priority', async (req) => {
    const input = z
      .object({ reason: z.string().trim().min(1).max(500).optional() })
      .strict()
      .parse(req.body ?? {});
    return controller.prioritizeTask(req.params.id, input);
  });
  app.delete<{ Params: { id: string } }>('/api/tasks/:id/priority', async (req) =>
    controller.revokeTaskPriority(req.params.id),
  );
  app.post('/api/tasks/stop-all', async () => {
    await Promise.all(activeTasks().map((t) => controller.stop(t.id)));
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/work-items/:id/stop', async (req) =>
    controller.work.changeStatus(req.params.id, 'cancelled'),
  );
  app.post<{ Params: { id: string } }>('/api/work-items/:id/pause', async (req) =>
    controller.work.changeStatus(req.params.id, 'paused'),
  );
  app.post<{ Params: { id: string } }>('/api/work-items/:id/complete', async (req) =>
    controller.work.changeStatus(req.params.id, 'completed'),
  );
  app.post<{ Params: { id: string } }>('/api/work-items/:id/resume', async (req) => {
    const input = z
      .object({ checkpoint: workCheckpointSchema.optional() })
      .strict()
      .parse(req.body ?? {});
    return controller.work.resume(req.params.id, input.checkpoint);
  });
  app.post<{ Params: { id: string } }>('/api/wakeups/:id/cancel', async (req) =>
    controller.work.cancelWakeup(req.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/approvals/:id', async (req) => {
    const { decision } = z.object({ decision: z.enum(['approve', 'deny']) }).parse(req.body);
    return controller.decideApproval(req.params.id, decision === 'approve');
  });
  app.post('/api/skills', async (req) => {
    return controller.proposeSkill(skillInputSchema.parse(req.body));
  });
  app.patch<{ Params: { id: string } }>('/api/skills/:id', async (req) => {
    const { baseVersion, ...patch } = skillPatchSchema
      .extend({ baseVersion: learningVersionSchema })
      .parse(req.body);
    return controller.updateSkill(req.params.id, patch, baseVersion);
  });
  app.post<{ Params: { id: string } }>('/api/skills/:id/restore', async (req) => {
    const { version, baseVersion } = z
      .object({
        version: learningVersionSchema,
        baseVersion: learningVersionSchema,
      })
      .strict()
      .parse(req.body);
    return controller.restoreSkill(req.params.id, version, baseVersion);
  });
  app.get<{ Params: { id: string } }>('/api/skills/:id/export', async (req, reply) => {
    const skill = required<Skill>(store, 'skills', req.params.id);
    reply.header(
      'Content-Disposition',
      `attachment; filename="${
        skill.name
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')
          .slice(0, 60) || 'skill'
      }.md"`,
    );
    return reply
      .type('text/markdown; charset=utf-8')
      .send(
        `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\nmetadata:\n  version: ${JSON.stringify(String(skill.version))}\n---\n\n${skill.content}\n`,
      );
  });
  app.post('/api/memories', async (req) =>
    controller.saveMemory(
      memoryInputSchema.omit({ replacesId: true, baseVersion: true }).parse(req.body),
    ),
  );
  app.patch<{ Params: { id: string } }>('/api/memories/:id', async (req) => {
    const { baseVersion, ...patch } = memoryPatchSchema
      .extend({ baseVersion: learningVersionSchema })
      .parse(req.body);
    return controller.updateMemory(req.params.id, patch, baseVersion);
  });
  app.post<{ Params: { id: string } }>('/api/memories/:id/restore', async (req) => {
    const { version, baseVersion } = z
      .object({
        version: learningVersionSchema,
        baseVersion: learningVersionSchema,
      })
      .strict()
      .parse(req.body);
    return controller.restoreMemory(req.params.id, version, baseVersion);
  });
  app.post('/api/memories/merge', async (req) => {
    return controller.mergeMemories(memoryMergeSchema.parse(req.body));
  });
  app.delete<{ Params: { id: string } }>('/api/memories/:id', async (req) => {
    const { baseVersion } = z
      .object({ baseVersion: learningVersionSchema })
      .strict()
      .parse(req.body);
    const memory = controller.updateMemory(
      req.params.id,
      {
        status: 'archived',
        reason: 'Archived by the user',
      },
      baseVersion,
    );
    return { ok: true, memory };
  });
  app.post('/api/notifications/read', async (req) => {
    const input = z.object({ id: z.string().optional() }).parse(req.body ?? {});
    for (const notification of store.list<Notification>('notifications'))
      if (!input.id || input.id === notification.id)
        store.patch<Notification>('notifications', notification.id, { read: true });
    controller.changed();
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/notifications/:id/reply', async (req) =>
    controller.replyToNotification(req.params.id, req.body),
  );
  registerIntegrationRoutes(app, context);
}
