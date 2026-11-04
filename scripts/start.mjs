import { lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createUpdateLauncher } from './update-launcher.mjs';

const root = process.cwd();
const gitDirectory = await lstat(resolve(root, '.git')).catch(() => undefined);

if (!gitDirectory?.isDirectory() || gitDirectory.isSymbolicLink()) {
  // ZIP/source copies still run; only a standalone clone supports Web updates.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('LOOM_UPDATE_')) delete env[key];
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env,
  });
  let stopping = false;
  let exited = false;
  let timeout;
  function stop() {
    if (stopping || exited) return;
    stopping = true;
    if (child.connected) child.send({ type: 'loom:shutdown' }, () => {});
    timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
  }
  child.once('error', (error) => {
    exited = true;
    console.error(error.message);
    process.exitCode = 1;
    clearTimeout(timeout);
    if (process.connected) process.disconnect();
  });
  child.once('exit', (code) => {
    exited = true;
    clearTimeout(timeout);
    process.exitCode = code ?? 1;
    if (process.connected) process.disconnect();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  if (process.send) {
    process.on('message', (message) => {
      if (message?.type === 'loom:shutdown') stop();
    });
    process.on('disconnect', stop);
  }
} else {
  const launcher = createUpdateLauncher({
    root,
    dataDir: resolve(process.env.LOOM_DATA_DIR || '.loom'),
    onExit(result) {
      void stop(result.code ?? 1);
    },
    onFatal(error) {
      console.error(error.message);
      void stop(1);
    },
  });
  let stopping;
  function stop(code = 0) {
    if (!stopping)
      stopping = launcher.close().then(
        () => {
          process.exitCode = code;
          if (process.connected) process.disconnect();
        },
        (error) => {
          console.error(error.message);
          process.exitCode = 1;
          if (process.connected) process.disconnect();
        },
      );
    return stopping;
  }
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      void stop();
    });
  if (process.send) {
    process.on('message', (message) => {
      if (message?.type === 'loom:shutdown') void stop();
    });
    process.on('disconnect', () => {
      void stop();
    });
  }
  try {
    await launcher.start();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}
