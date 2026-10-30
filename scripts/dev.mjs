import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const api = spawn(
  process.execPath,
  [
    '--env-file-if-exists=.env',
    '--import',
    'tsx',
    ...(process.env.LOOM_WATCH === '1' ? ['--watch'] : []),
    'src/server/index.ts',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, LOOM_PORT: '3211', LOOM_HOST: '127.0.0.1' },
  },
);
const web = spawn(
  process.execPath,
  [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  api.kill('SIGTERM');
  web.kill('SIGTERM');
  setTimeout(() => process.exit(code), 200).unref();
}
for (const child of [api, web]) {
  child.on('error', (e) => {
    console.error(e.message);
    stop(1);
  });
  child.on('exit', (code) => stop(code || 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
