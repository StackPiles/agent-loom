import { randomUUID } from 'node:crypto';
import type { UpdateJob } from '../shared/updates.js';

/** The inherited IPC channel is the only path from the HTTP service to its launcher. */
export function supervisorUpdateBridge(parent: NodeJS.Process = process) {
  const send = (message: object) => {
    if (!parent.connected || !parent.send)
      throw Object.assign(
        new Error('The update supervisor is disconnected. Restart Loom with npm start.'),
        { statusCode: 503 },
      );
    parent.send(message, () => {
      /* A missing receipt is handled separately. */
    });
  };
  return {
    requestInstall(job: UpdateJob): Promise<void> {
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const finish = (error?: Error) => {
          clearTimeout(timer);
          parent.off('message', receive);
          parent.off('disconnect', disconnected);
          if (error) reject(error);
          else resolve();
        };
        const receive = (value: unknown) => {
          const message = value as Record<string, unknown> | null;
          if (!message || message.requestId !== requestId) return;
          if (message.type === 'loom:update:accepted' && message.id === job.id) finish();
          else if (message.type === 'loom:update:rejected')
            finish(
              Object.assign(
                new Error(
                  typeof message.error === 'string'
                    ? message.error.slice(0, 2_000)
                    : 'The update supervisor rejected this update.',
                ),
                { statusCode: 409 },
              ),
            );
        };
        const disconnected = () =>
          finish(
            Object.assign(
              new Error(
                'The update result is not confirmed. Wait for Loom to reconnect before retrying.',
              ),
              { statusCode: 503, uncertain: true },
            ),
          );
        const timer = setTimeout(disconnected, 30_000);
        timer.unref();
        parent.on('message', receive);
        parent.once('disconnect', disconnected);
        try {
          send({
            type: 'loom:update',
            requestId,
            id: job.id,
            targetSha: job.targetSha,
            targetVersion: job.targetVersion,
          });
        } catch (error) {
          finish(error as Error);
        }
      });
    },
    proceed(id: string) {
      try {
        send({ type: 'loom:update:proceed', id });
      } catch {
        /* Parent loss closes the app; the durable journal decides recovery. */
      }
    },
  };
}
