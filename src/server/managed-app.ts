import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp, type AppOptions } from './app.js';
import {
  DataDirectoryLock,
  beginDataReplacement,
  recoverDataDirectory,
  readDataReplacementResult,
} from './data-directory.js';
import { exportDataArchive } from './data-transfer-archive.js';
import { DataTransferService, dataFingerprint, transferProblem } from './data-transfer.js';

export interface ManagedAppOptions extends Omit<AppOptions, 'dataDirectoryLock' | 'dataTransfer'> {
  host?: string;
  port?: number;
  onFatal?: (error: Error) => void;
}

type AppContext = Awaited<ReturnType<typeof createApp>>;

/** Own the data-directory lease across close, replacement, and reopening. */
export async function createManagedApp(options: ManagedAppOptions) {
  const dataDir = resolve(options.dataDir);
  const lock = new DataDirectoryLock(dataDir);
  let current: AppContext | undefined;
  let port = options.port ?? 3210;
  const host = options.host ?? '127.0.0.1';
  let address = '';
  let closing: Promise<void> | undefined;
  let service: DataTransferService;
  let updateVerification = options.updateVerification === true;

  const openApp = async () => {
    const next = await createApp({
      ...options,
      dataDir,
      dataDirectoryLock: lock,
      dataTransfer: service,
      updateVerification,
    });
    try {
      address = await next.app.listen({ host, port });
      const bound = next.app.server.address();
      if (bound && typeof bound !== 'string') port = bound.port;
      current = next;
    } catch (error) {
      await next.app.close();
      throw error;
    }
  };
  const closeApp = async () => {
    if (!current) return;
    const old = current;
    await old.app.close();
    current = undefined;
  };
  const fatal = (error: unknown) => {
    options.onFatal?.(error instanceof Error ? error : new Error('Agent Loom could not restart.'));
  };

  service = new DataTransferService(dataDir, {
    restoreResult: (jobId) => readDataReplacementResult(lock, jobId),
    store() {
      if (!current) transferProblem('Agent Loom is restarting. Please wait.', 503);
      return current.store;
    },
    async exportArchive(input) {
      await closeApp();
      try {
        return await exportDataArchive({ dataDir, ...input });
      } finally {
        try {
          await openApp();
        } catch (error) {
          fatal(error);
          throw error;
        }
      }
    },
    async restore({ stagingDir, jobId, fingerprint }) {
      await closeApp();
      let replacement: Awaited<ReturnType<typeof beginDataReplacement>> | undefined;
      try {
        // A request already in flight when the preview was accepted may have
        // finished during shutdown. Never silently overwrite its new data.
        const previous = new DatabaseSync(join(dataDir, 'loom.sqlite'), { readOnly: true });
        try {
          if (dataFingerprint(previous) !== fingerprint)
            transferProblem(
              'The destination changed while stopping. Check the copy file again before replacing it.',
            );
          const sessions = previous
            .prepare("SELECT * FROM objects WHERE kind='authSessions'")
            .all();
          const prepared = new DatabaseSync(join(stagingDir, 'loom.sqlite'));
          try {
            prepared.exec('BEGIN IMMEDIATE');
            prepared.exec("DELETE FROM objects WHERE kind='authSessions'");
            const insert = prepared.prepare(
              'INSERT INTO objects(kind,id,data,created_at,updated_at) VALUES(?,?,?,?,?)',
            );
            for (const row of sessions)
              insert.run(row.kind, row.id, row.data, row.created_at, row.updated_at);
            prepared.exec('COMMIT');
          } finally {
            prepared.close();
          }
        } finally {
          previous.close();
        }
        replacement = await beginDataReplacement(lock, stagingDir, jobId);
        await openApp();
        await replacement.commit();
        return replacement.backupPath;
      } catch (error) {
        try {
          await closeApp();
          if (replacement) await replacement.rollback();
          else await recoverDataDirectory(lock);
          await openApp();
        } catch (recoveryError) {
          fatal(recoveryError);
          throw new Error(
            'Agent Loom could not restart after the transfer. The restore journal and backup were retained.',
          );
        }
        throw error;
      }
    },
  });

  try {
    await recoverDataDirectory(lock);
    await service.initialize();
    await openApp();
  } catch (error) {
    await closeApp().catch(() => {});
    lock.close();
    throw error;
  }

  return {
    get current() {
      return current;
    },
    get address() {
      return address;
    },
    dataTransfer: service,
    activateUpdate() {
      updateVerification = false;
      current?.activateUpdate();
    },
    close() {
      if (!closing)
        closing = (async () => {
          await service.shutdown();
          try {
            await closeApp();
          } finally {
            lock.close();
          }
        })();
      return closing;
    },
  };
}
