import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { botBrowserMode, DEFAULT_BROWSER_SETTINGS } from '../shared/browser.js';
import type { Bot, BrowserSettings, BrowserStatus, Room } from '../shared/types.js';
import { createBrowserControl, type BrowserControl } from './browser.js';
import { createBrowserUploadStorage } from './browser-upload-storage.js';
import { abortError, throwIfAborted } from './runtime/gate.js';

export interface BotBrowserHandle {
  readonly signal: AbortSignal;
  /** Explicit disconnect/settings cancellation, without task residency release on room pause. */
  readonly approvalSignal?: AbortSignal;
  prepare: BrowserControl['prepare'];
  execute: BrowserControl['execute'];
  /** Keep the browser resident while an action is being reviewed or issued. */
  hold(signal: AbortSignal, continuation?: boolean, onWait?: () => void): Promise<() => void>;
  assertCurrent(): void;
}

interface Entry {
  key: string;
  botId?: string;
  roomId?: string;
  control: BrowserControl;
  generation: AbortController;
  leases: number;
  used: number;
  closing?: Promise<void>;
}
interface Waiter {
  entry: Entry;
  continuation: boolean;
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  abort: () => void;
}
interface ResidentTask {
  botId: string;
  roomId: string;
  control: BrowserControl;
  stop: AbortController;
  signal: AbortSignal;
  abort: () => void;
  ready: Promise<BotBrowserHandle>;
  operations: number;
  release?: () => void;
}

/** A persistent profile per room and bot, plus the explicitly selected shared browser. */
export function createBrowserManager(options: {
  dataDir: string;
  getSettings: () => BrowserSettings;
  getBot: (id: string) => Bot | undefined;
  getRoom: (id: string) => Room | undefined;
  onChange: () => void;
  controlFactory?: typeof createBrowserControl;
}) {
  const entries = new Map<string, Entry>();
  const occupied = new Set<Entry>();
  const waiters: Waiter[] = [];
  const tasks = new Map<string, ResidentTask>();
  const origins = new Set<string>();
  let pumping = false;
  let stopped = false;
  let closingAll = false;
  let clock = 0;
  const settings = () => ({ ...DEFAULT_BROWSER_SETTINGS, ...options.getSettings() });
  const uploadStorage = createBrowserUploadStorage({
    dataDir: options.dataDir,
    getSettings: settings,
  });
  // Recovery does not launch Chrome. Unknown/live browser ownership is retained.
  void uploadStorage.initialize().catch(() => {});
  const capacity = () => Math.max(1, Math.min(16, settings().maxConcurrentBrowsers ?? 3));
  const changed = () => {
    options.onChange();
    void pump();
  };
  const pool = () => ({ active: occupied.size, limit: capacity(), waiting: waiters.length });
  const allowed = () => {
    if (stopped || closingAll)
      throw new Error('The browser service is disconnected or shutting down.');
    const current = settings();
    if (!current.enabled || current.permission === 'deny')
      throw new Error('Chrome control is disabled or denied in Settings.');
  };

  function entryFor(scope?: { botId: string; roomId: string }): Entry {
    const key =
      scope === undefined ? 'shared' : `room-bot:${JSON.stringify([scope.roomId, scope.botId])}`;
    const saved = entries.get(key);
    if (saved) return saved;
    const entry: Entry = {
      key,
      ...scope,
      generation: new AbortController(),
      leases: 0,
      used: ++clock,
      control: (options.controlFactory ?? createBrowserControl)({
        dataDir: options.dataDir,
        uploadStorage,
        ...(scope === undefined
          ? {}
          : {
              // Archive identifiers and model arguments never become filesystem paths.
              profileDir: join(
                resolve(options.dataDir),
                'browser-profiles',
                'rooms',
                createHash('sha256').update(scope.roomId).digest('hex'),
                createHash('sha256').update(scope.botId).digest('hex'),
              ),
            }),
        getSettings: () => {
          const current = settings();
          if (scope === undefined) return current;
          const bot = options.getBot(scope.botId);
          const room = options.getRoom(scope.roomId);
          return {
            ...current,
            mode: 'dedicated',
            enabled:
              current.enabled &&
              !!bot?.enabled &&
              botBrowserMode(bot) === 'dedicated' &&
              !!room &&
              !room.deletion &&
              room.botIds.includes(scope.botId),
          };
        },
        onChange: changed,
      }),
    };
    for (const origin of origins) entry.control.protectOrigin(origin);
    entries.set(key, entry);
    return entry;
  }

  async function closeEntry(entry: Entry, pause: boolean) {
    if (pause) {
      entry.generation.abort();
      entry.generation = new AbortController();
    }
    if (entry.closing) await entry.closing;
    const closing = Promise.resolve().then(async () => {
      if (pause) await entry.control.disconnect();
      else await entry.control.suspend();
      occupied.delete(entry);
    });
    entry.closing = closing;
    try {
      await closing;
    } finally {
      if (entry.closing === closing) entry.closing = undefined;
      changed();
    }
  }

  function remove(waiter: Waiter) {
    const index = waiters.indexOf(waiter);
    if (index !== -1) waiters.splice(index, 1);
    waiter.signal.removeEventListener('abort', waiter.abort);
  }

  function grant(waiter: Waiter) {
    remove(waiter);
    const entry = waiter.entry;
    occupied.add(entry);
    entry.leases++;
    entry.used = ++clock;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      entry.leases--;
      entry.used = ++clock;
      changed();
    });
    options.onChange();
  }

  async function pump() {
    if (pumping || stopped || closingAll) return;
    pumping = true;
    try {
      while (!stopped && !closingAll) {
        // Let an admitted workflow finish without lending its tab mid-form.
        // A *new* task using the same profile must still join the admission queue.
        const resident = waiters.find(
          (item) =>
            item.continuation &&
            occupied.has(item.entry) &&
            item.entry.leases > 0 &&
            !item.entry.closing,
        );
        if (resident) {
          grant(resident);
          continue;
        }
        const next = waiters.find((item) => !item.entry.closing);
        if (next && occupied.has(next.entry)) {
          grant(next);
          continue;
        }
        if (next && occupied.size < capacity()) {
          grant(next);
          continue;
        }
        if (!next && occupied.size <= capacity()) break;
        const idle = [...occupied]
          .filter((entry) => !entry.leases && !entry.closing)
          .sort((a, b) => a.used - b.used)[0];
        if (!idle) break;
        // Approval waits hold leases too. Only idle browsers can be evicted.
        await closeEntry(idle, false);
      }
    } catch (error) {
      for (const waiter of [...waiters]) {
        remove(waiter);
        waiter.reject(
          new Error('Chrome capacity could not be released: ' + (error as Error).message),
        );
      }
      options.onChange();
    } finally {
      pumping = false;
    }
  }

  function hold(entry: Entry, signal: AbortSignal, continuation = true, onWait?: () => void) {
    allowed();
    signal = AbortSignal.any([signal, entry.generation.signal]);
    throwIfAborted(signal);
    return new Promise<() => void>((resolveHold, reject) => {
      const waiter: Waiter = {
        entry,
        continuation,
        signal,
        resolve: resolveHold,
        reject,
        abort: () => {
          remove(waiter);
          reject(abortError());
          changed();
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      waiters.push(waiter);
      changed();
      // A blocked browser acquisition must not occupy a worker needed by the
      // workflow that currently holds Chrome. An immediate grant needs no yield.
      if (onWait && waiters.includes(waiter)) {
        try {
          onWait();
        } catch (error) {
          remove(waiter);
          reject(error);
          changed();
        }
      }
    });
  }

  function assertRoom(botId: string, roomId: string) {
    if (!roomId) throw new Error('A room is required to select this bot’s Chrome.');
    const room = options.getRoom(roomId);
    if (!room || room.deletion) throw new Error('This room is unavailable for browser use.');
    if (!room.botIds.includes(botId)) throw new Error('This bot does not belong to this room.');
  }

  function target(botId: string, roomId: string) {
    assertRoom(botId, roomId);
    const bot = options.getBot(botId);
    if (!bot) throw new Error('This bot no longer exists.');
    const mode = botBrowserMode(bot);
    return { bot, mode, entry: mode === 'dedicated' ? entryFor({ botId, roomId }) : entryFor() };
  }

  function forBot(botId: string, roomId: string): BotBrowserHandle {
    const { mode, entry } = target(botId, roomId);
    const generation = entry.generation.signal;
    const assertCurrent = () => {
      allowed();
      throwIfAborted(generation);
      assertRoom(botId, roomId);
      const bot = options.getBot(botId);
      if (!bot?.enabled || botBrowserMode(bot) === 'disabled')
        throw new Error('Browser use is disabled for this bot.');
      if (botBrowserMode(bot) !== mode)
        throw new Error('This bot’s browser changed. Take a new snapshot before continuing.');
    };
    return {
      signal: generation,
      approvalSignal: generation,
      assertCurrent,
      hold: async (signal, continuation = true, onWait) => {
        assertCurrent();
        const release = await hold(entry, signal, continuation, onWait);
        try {
          assertCurrent();
          return release;
        } catch (error) {
          release();
          throw error;
        }
      },
      prepare: (input, uploads, credential) => {
        assertCurrent();
        return entry.control.prepare(input, uploads, credential);
      },
      execute: async (plan, signal, guard = () => {}) => {
        assertCurrent();
        const release = await hold(entry, signal);
        try {
          const check = () => {
            assertCurrent();
            guard();
          };
          check();
          return await entry.control.execute(plan, signal, check);
        } finally {
          release();
        }
      },
    };
  }

  function releaseTask(taskId: string) {
    const task = tasks.get(taskId);
    if (!task) return;
    tasks.delete(taskId);
    task.signal.removeEventListener('abort', task.abort);
    task.stop.abort();
    task.release?.();
    task.release = undefined;
  }

  /** Release only this task's reservation at an explicitly completed browser checkpoint. */
  function yieldTask(taskId: string, botId: string, roomId: string): boolean {
    const task = tasks.get(taskId);
    if (!task) return false;
    if (task.botId !== botId || task.roomId !== roomId)
      throw new Error('A task cannot release another room or bot’s browser.');
    if (task.operations)
      throw new Error(
        'Chrome is still in use by this task. Finish the browser operation before releasing it.',
      );
    if (task.control.status().recovering)
      throw new Error(
        'Chrome is recovering an interrupted operation. Read tabs and a fresh snapshot to inspect its outcome before releasing it.',
      );
    // This only makes the browser eligible for eviction. A live form must be
    // completed first; profiles remain on disk even if another task needs the slot.
    releaseTask(taskId);
    return true;
  }

  function hasTaskReservation(taskId: string, botId: string, roomId: string): boolean {
    const task = tasks.get(taskId);
    if (!task) return false;
    if (task.botId !== botId || task.roomId !== roomId)
      throw new Error('A task cannot inspect another room or bot’s browser reservation.');
    return !!task.release && !task.signal.aborted;
  }

  async function releaseProfiles(matches: (scope: { botId?: string; roomId?: string }) => boolean) {
    for (const [taskId, task] of tasks) if (matches(task)) releaseTask(taskId);
    await Promise.all(
      [...entries.values()].filter(matches).map(async (entry) => {
        await closeEntry(entry, true);
        await entry.control.shutdown();
        if (entries.get(entry.key) === entry) entries.delete(entry.key);
      }),
    );
  }

  async function forTask(
    botId: string,
    roomId: string,
    taskId: string,
    signal: AbortSignal,
    acquireSignal = signal,
    onWait?: () => void,
  ): Promise<BotBrowserHandle> {
    const resident = tasks.get(taskId);
    if (resident) {
      if (resident.botId !== botId || resident.roomId !== roomId)
        throw new Error('A task cannot use another room or bot’s browser.');
      throwIfAborted(signal);
      if (!resident.release) onWait?.();
      const handle = await resident.ready;
      handle.assertCurrent();
      return handle;
    }
    const handle = forBot(botId, roomId);
    const { entry } = target(botId, roomId);
    const stop = new AbortController();
    signal = AbortSignal.any([signal, handle.signal, stop.signal]);
    const check = () => {
      throwIfAborted(signal);
      handle.assertCurrent();
    };
    check();
    let task: ResidentTask;
    const scoped: BotBrowserHandle = {
      signal,
      approvalSignal: handle.approvalSignal ?? handle.signal,
      assertCurrent: check,
      hold: async (operationSignal) => {
        check();
        task.operations++;
        try {
          const release = await handle.hold(AbortSignal.any([signal, operationSignal]));
          let released = false;
          return () => {
            if (released) return;
            released = true;
            task.operations--;
            release();
          };
        } catch (error) {
          task.operations--;
          throw error;
        }
      },
      prepare: (input, uploads, credential) => {
        check();
        return handle.prepare(input, uploads, credential);
      },
      execute: async (plan, operationSignal, guard = () => {}) => {
        check();
        task.operations++;
        try {
          return await handle.execute(plan, AbortSignal.any([signal, operationSignal]), () => {
            check();
            guard();
          });
        } finally {
          task.operations--;
        }
      },
    };
    task = {
      botId,
      roomId,
      control: entry.control,
      stop,
      signal,
      abort: () => releaseTask(taskId),
      ready: Promise.resolve(scoped),
      operations: 0,
    };
    tasks.set(taskId, task);
    signal.addEventListener('abort', task.abort, { once: true });
    // Preserve tabs while the model thinks between tools, as well as during approval.
    // Each task uses one browser only, so no task holds one profile while awaiting another.
    task.ready = Promise.resolve()
      .then(() => handle.hold(AbortSignal.any([signal, acquireSignal]), false, onWait))
      .then((release) => {
        if (signal.aborted || tasks.get(taskId) !== task) {
          release();
          throw abortError();
        }
        task.release = release;
        return scoped;
      })
      .catch((error) => {
        if (tasks.get(taskId) === task) releaseTask(taskId);
        throw error;
      });
    return task.ready;
  }

  function status(entry: Entry): BrowserStatus {
    const current = entry.control.status();
    return {
      ...current,
      busy: current.busy || entry.leases > 0,
      waiting: waiters.some((item) => item.entry === entry),
      pool: pool(),
    };
  }

  async function connect(entry: Entry, signal = new AbortController().signal, guard = () => {}) {
    const generation = entry.generation.signal;
    const release = await hold(entry, signal, false);
    try {
      guard();
      await entry.control.connect(AbortSignal.any([signal, generation]));
      return status(entry);
    } finally {
      release();
    }
  }

  const shared = entryFor();
  return {
    forBot,
    forTask,
    releaseTask,
    yieldTask,
    hasTaskReservation,
    status: () => status(shared),
    connect: (signal?: AbortSignal) => connect(shared, signal),
    async disconnect() {
      await closeEntry(shared, true);
      return status(shared);
    },
    botStatus(botId: string, roomId: string): BrowserStatus {
      const { mode, entry } = target(botId, roomId);
      if (mode === 'disabled')
        return {
          state: 'disconnected',
          mode: 'dedicated',
          platform: process.platform,
          busy: false,
          tabs: [],
          botMode: mode,
          pool: pool(),
        };
      return { ...status(entry), botMode: mode };
    },
    async connectBot(botId: string, roomId: string, signal?: AbortSignal) {
      const handle = forBot(botId, roomId);
      handle.assertCurrent();
      const { mode, entry } = target(botId, roomId);
      const result = await connect(entry, signal, handle.assertCurrent);
      handle.assertCurrent();
      return { ...result, botMode: mode };
    },
    async disconnectBot(botId: string, roomId: string) {
      const { mode, entry } = target(botId, roomId);
      if (mode !== 'disabled') await closeEntry(entry, true);
      return { ...status(entry), botMode: mode };
    },
    async releaseBot(botId: string) {
      await releaseProfiles((scope) => scope.botId === botId);
    },
    async releaseRoom(roomId: string) {
      await releaseProfiles((scope) => scope.roomId === roomId);
    },
    async releaseRoomBot(botId: string, roomId: string) {
      // Membership may already be removed. Release owned entries without resolving a new target.
      await releaseProfiles((scope) => scope.botId === botId && scope.roomId === roomId);
    },
    configure() {
      changed();
    },
    async disconnectAll() {
      closingAll = true;
      try {
        await Promise.all([...entries.values()].map((entry) => closeEntry(entry, true)));
      } finally {
        closingAll = false;
        changed();
      }
    },
    protectOrigin(value: string) {
      origins.add(value);
      for (const entry of entries.values()) entry.control.protectOrigin(value);
    },
    async shutdown() {
      stopped = true;
      for (const entry of entries.values()) entry.generation.abort();
      await Promise.all(
        [...entries.values()].map(async (entry) => {
          await entry.closing;
          await entry.control.shutdown();
        }),
      );
      occupied.clear();
      await uploadStorage.shutdown();
    },
  };
}

export type BrowserManager = ReturnType<typeof createBrowserManager>;
