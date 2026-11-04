import { resolve } from 'node:path';
import { createManagedApp } from './managed-app.js';
import { VERSION } from './controller.js';
import { ApplicationUpdates } from './updates.js';
import { supervisorUpdateBridge } from './update-ipc.js';

const host = process.env.LOOM_HOST || '127.0.0.1';
const port = Number(process.env.LOOM_PORT || 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('LOOM_PORT must be a valid port number.');
if (
  !['127.0.0.1', 'localhost', '::1'].includes(host) &&
  (!process.env.LOOM_API_TOKEN || process.env.LOOM_API_TOKEN.length < 24)
) {
  throw new Error(
    'Binding to a non-loopback interface requires LOOM_API_TOKEN with at least 24 characters.',
  );
}
const supervised =
  process.env.LOOM_UPDATE_SUPERVISOR === '1' && Boolean(process.send && process.connected);
const bridge = supervised ? supervisorUpdateBridge() : undefined;
const updates = new ApplicationUpdates({
  version: VERSION,
  development: process.env.LOOM_DEV === '1',
  supervised,
  ...(supervised
    ? {
        commit: process.env.LOOM_UPDATE_COMMIT,
        stateFile: process.env.LOOM_UPDATE_STATE_FILE,
        ...bridge,
      }
    : {}),
});
const verifying = supervised && process.env.LOOM_UPDATE_VERIFY === '1';
const nonce = process.env.LOOM_UPDATE_NONCE;
const managed = await createManagedApp({
  dataDir: resolve(process.env.LOOM_DATA_DIR || '.loom'),
  apiToken: process.env.LOOM_API_TOKEN,
  dev: process.env.LOOM_DEV === '1',
  logger: true,
  host,
  port,
  updates,
  updateVerification: verifying,
  onFatal(error) {
    console.error(error.message);
    process.exitCode = 1;
  },
});
console.log(`Agent Loom is ready at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  managed.close().then(
    () => process.exit(0),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
};
if (process.send && process.connected) {
  process.on('message', (value: unknown) => {
    const message = value as Record<string, unknown> | null;
    if (!message || shuttingDown) return;
    if (message.type === 'loom:shutdown') shutdown();
    else if (
      supervised &&
      message.type === 'loom:activate' &&
      message.nonce === nonce &&
      verifying
    ) {
      managed.activateUpdate();
      process.send?.({ type: 'loom:activated', nonce });
    } else if (
      supervised &&
      message.type === 'loom:update:finished' &&
      typeof message.id === 'string'
    ) {
      managed.current?.resumeAfterUpdate(message.id);
    }
  });
  // An orphan must release the data lease instead of continuing automation.
  process.once('disconnect', shutdown);
  if (supervised)
    process.send?.({
      type: 'loom:ready',
      version: VERSION,
      commit: process.env.LOOM_UPDATE_COMMIT,
      nonce,
    });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
