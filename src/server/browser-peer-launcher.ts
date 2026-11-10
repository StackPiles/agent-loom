import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  installBrowserUploadProcessTracker,
  type BrowserUploadProcessManager,
} from './browser-upload-processes.js';

// Keep the installed CLI and its arguments intact, including its narrow env.
const entrypoint = process.argv[2];
const root = process.env.LOOM_BROWSER_UPLOAD_ROOT;
const token = process.env.LOOM_BROWSER_UPLOAD_TOKEN;
delete process.env.LOOM_BROWSER_UPLOAD_ROOT;
delete process.env.LOOM_BROWSER_UPLOAD_TOKEN;
if (!entrypoint || !root || !token)
  throw new Error('The Chrome upload lifecycle launcher is missing its private configuration.');

const require = createRequire(import.meta.url);
const packagePath = require.resolve('chrome-devtools-mcp/package.json');
const sourceRoot = join(dirname(packagePath), 'build', 'src');
if (resolve(entrypoint) !== join(sourceRoot, 'bin', 'chrome-devtools-mcp.js'))
  throw new Error('The Chrome upload lifecycle launcher requires the installed MCP entrypoint.');
process.argv = [process.argv[0], entrypoint, ...process.argv.slice(3)];
const { BrowserManager } = (await import(
  pathToFileURL(join(sourceRoot, 'BrowserManager.js')).href
)) as {
  BrowserManager: { prototype: BrowserUploadProcessManager };
};
const tracker = installBrowserUploadProcessTracker(BrowserManager.prototype, root, token);
await tracker.flush();
await import(pathToFileURL(entrypoint).href);
