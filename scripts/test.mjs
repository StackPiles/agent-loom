import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Enumerate explicitly so the same command works in Windows cmd and POSIX shells.
const files = readdirSync('tests')
  .filter((name) => /\.test\.tsx?$/.test(name))
  .sort()
  .map((name) => `tests/${name}`);
if (!files.length) throw new Error('No test files found.');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
