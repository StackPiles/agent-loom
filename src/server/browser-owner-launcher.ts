import { runBrowserOwner } from './browser-owner-runtime.js';

// The private IPC channel belongs to Loom, not to a disposable MCP worker.
// Losing this channel closes Chrome even after an abrupt Loom process death.
const profileDir = process.env.LOOM_BROWSER_OWNER_PROFILE;
delete process.env.LOOM_BROWSER_OWNER_PROFILE;
if (!profileDir || !process.send) throw new Error('Missing private Chrome owner configuration.');
await runBrowserOwner({
  profileDir,
  env: process.env,
  host: {
    get connected() {
      return process.connected;
    },
    on: (event, callback) => process.on(event, callback),
    once: (event, callback) => process.once(event, callback),
    send: (message) =>
      new Promise<void>((resolve, reject) => {
        process.send!(message, (error) => (error ? reject(error) : resolve()));
      }),
    exit: (code) => process.exit(code),
  },
});
