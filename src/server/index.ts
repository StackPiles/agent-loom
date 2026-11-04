import { resolve } from 'node:path';
import { createManagedApp } from './managed-app.js';

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
const managed = await createManagedApp({
  dataDir: resolve(process.env.LOOM_DATA_DIR || '.loom'),
  apiToken: process.env.LOOM_API_TOKEN,
  dev: process.env.LOOM_DEV === '1',
  logger: true,
  host,
  port,
  onFatal(error) {
    console.error(error.message);
    process.exitCode = 1;
  },
});
console.log(`Agent Loom is ready at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    managed.close().then(
      () => process.exit(0),
      (error) => {
        console.error(error.message);
        process.exit(1);
      },
    );
  });
