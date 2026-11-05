import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { botBrowserMode, DEFAULT_BROWSER_SETTINGS } from '../shared/browser.js';
import type { Bot, BrowserSettings, BrowserStatus } from '../shared/types.js';
import { createBrowserControl, type BrowserControl } from './browser.js';
import { abortError, throwIfAborted } from './runtime/gate.js';

export interface BotBrowserHandle {
  readonly signal: AbortSignal;
  /** Explicit disconnect/settings cancellation, without task residency release on room pause. */
  readonly approvalSignal?: AbortSignal;
  prepare: BrowserControl['prepare'];
  execute: BrowserControl['execute'];
  /** Keep the browser resident while an action is being reviewed or issued. */
  hold(signal: AbortSignal): Promise<() => void>;
  assertCurrent(): void;
}

interface Entry {
  key: string;
  control: BrowserControl;
  generation: AbortController;
  leases: number;
  used: number;
  closing?: Promise<void>;
}
interface Waiter {
  entry: Entry;
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  abort: () => void;
}
interface ResidentTask {
  botId: string;
  stop: AbortController;
  signal: AbortSignal;
  abort: () => void;
  ready: Promise<BotBrowserHandle>;
  release?: () => void;
}

/** A persistent profile per bot, plus the unchanged legacy shared browser. */
export function createBrowserManager(options: {
  dataDir: string;
  getSettings: () => BrowserSettings;
  getBot: (id: string) => Bot | undefined;
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

  function entryFor(botId?: string): Entry {
    const key = botId === undefined ? 'shared' : `bot:${botId}`;
    const saved = entries.get(key);
    if (saved) return saved;
    const entry: Entry = {
      key,
      generation: new AbortController(),
      leases: 0,
      used: ++clock,
      control: (options.controlFactory ?? createBrowserControl)({
        dataDir: options.dataDir,
        ...(botId === undefined
          ? {}
          : {
              // Archive identifiers and model arguments never become filesystem paths.
              profileDir: join(
                resolve(options.dataDir),
                'browser-profiles',
                createHash('sha256').update(botId).digest('hex'),
              ),
            }),
        getSettings: () => {
          const current = settings();
          if (botId === undefined) return current;
          const bot = options.getBot(botId);
          return {
            ...current,
            mode: 'dedicated',
            enabled: current.enabled && !!bot?.enabled && botBrowserMode(bot) === 'dedicated',
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
        // Existing residents may finish their work while a different bot waits.
        const resident = waiters.find((item) => occupied.has(item.entry) && !item.entry.closing);
        if (resident) {
          grant(resident);
          continue;
        }
        const next = waiters.find((item) => !item.entry.closing);
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

  function hold(entry: Entry, signal: AbortSignal) {
    allowed();
    signal = AbortSignal.any([signal, entry.generation.signal]);
    throwIfAborted(signal);
    return new Promise<() => void>((resolveHold, reject) => {
      const waiter: Waiter = {
        entry,
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
    });
  }

  function target(botId: string) {
    const bot = options.getBot(botId);
    if (!bot) throw new Error('This bot no longer exists.');
    const mode = botBrowserMode(bot);
    return { bot, mode, entry: mode === 'dedicated' ? entryFor(botId) : entryFor() };
  }

  function forBot(botId: string): BotBrowserHandle {
    const { mode, entry } = target(botId);
    const generation = entry.generation.signal;
    const assertCurrent = () => {
      allowed();
      throwIfAborted(generation);
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
      hold: (signal) => {
        assertCurrent();
        return hold(entry, signal);
      },
      prepare: (input) => {
        assertCurrent();
        return entry.control.prepare(input);
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

  async function forTask(
    botId: string,
    taskId: string,
    signal: AbortSignal,
    acquireSignal = signal,
  ): Promise<BotBrowserHandle> {
    const resident = tasks.get(taskId);
    if (resident) {
      if (resident.botId !== botId) throw new Error('A task cannot use another bot’s browser.');
      throwIfAborted(signal);
      return resident.ready;
    }
    const handle = forBot(botId);
    const stop = new AbortController();
    signal = AbortSignal.any([signal, handle.signal, stop.signal]);
    const check = () => {
      throwIfAborted(signal);
      handle.assertCurrent();
    };
    check();
    const scoped: BotBrowserHandle = {
      signal,
      approvalSignal: handle.approvalSignal ?? handle.signal,
      assertCurrent: check,
      hold: (operationSignal) => {
        check();
        return handle.hold(AbortSignal.any([signal, operationSignal]));
      },
      prepare: (input) => {
        check();
        return handle.prepare(input);
      },
      execute: (plan, operationSignal, guard = () => {}) => {
        check();
        return handle.execute(plan, AbortSignal.any([signal, operationSignal]), () => {
          check();
          guard();
        });
      },
    };
    const task: ResidentTask = {
      botId,
      stop,
      signal,
      abort: () => releaseTask(taskId),
      ready: Promise.resolve(scoped),
    };
    tasks.set(taskId, task);
    signal.addEventListener('abort', task.abort, { once: true });
    // Preserve tabs while the model thinks between tools, as well as during approval.
    // Each task uses one browser only, so no task holds one profile while awaiting another.
    task.ready = Promise.resolve()
      .then(() => handle.hold(AbortSignal.any([signal, acquireSignal])))
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

  async function connect(entry: Entry, signal = new AbortController().signal) {
    const generation = entry.generation.signal;
    const release = await hold(entry, signal);
    try {
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
    status: () => status(shared),
    connect: (signal?: AbortSignal) => connect(shared, signal),
    async disconnect() {
      await closeEntry(shared, true);
      return status(shared);
    },
    botStatus(botId: string): BrowserStatus {
      const { mode, entry } = target(botId);
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
    async connectBot(botId: string, signal?: AbortSignal) {
      const handle = forBot(botId);
      handle.assertCurrent();
      const { mode, entry } = target(botId);
      const result = await connect(entry, signal);
      handle.assertCurrent();
      return { ...result, botMode: mode };
    },
    async disconnectBot(botId: string) {
      const { mode, entry } = target(botId);
      if (mode !== 'disabled') await closeEntry(entry, true);
      return { ...status(entry), botMode: mode };
    },
    async releaseBot(botId: string) {
      const entry = entries.get(`bot:${botId}`);
      if (entry) {
        await closeEntry(entry, true);
        await entry.control.shutdown();
        entries.delete(entry.key);
      }
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
    },
  };
}

export type BrowserManager = ReturnType<typeof createBrowserManager>;
