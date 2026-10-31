import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// CI uses the runner's installed stable Chrome in a desktop supplied by xvfb-run.
// Only an isolated temporary profile and these synthetic loopback pages are used.
const fixturePage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Loom Chrome smoke fixture</title>
<style>body{font:18px system-ui;max-width:640px;margin:60px auto;padding:24px}label,input,button{display:block;margin:16px 0}input,button{font:inherit;padding:10px}</style>
</head>
<body>
<h1>Loom Chrome smoke fixture</h1>
<form id="draft-form">
<label for="message">Draft message</label>
<input id="message" name="message" autocomplete="off">
<button type="submit">Save draft</button>
</form>
<p id="result" role="status">No draft saved.</p>
<a href="__OWNER_ORIGIN__/" target="_blank" rel="noopener">Open owner control page</a>
<script>
document.querySelector('#draft-form').addEventListener('submit', (event) => {
  event.preventDefault();
  document.querySelector('#result').textContent = 'Saved draft: ' + document.querySelector('#message').value;
});
</script>
</body></html>`;
const nextPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Loom Chrome smoke next</title></head><body><h1>Navigation succeeded</h1><p>This is the second synthetic fixture page.</p></body></html>`;
const ownerPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Loom owner control fixture</title><link rel="stylesheet" href="/owner-style.css"></head><body><h1>Owner control page loaded</h1><p>Owners can open this page while bot tools cannot inspect or operate it.</p></body></html>`;

function readStateId(text) {
  const matches = [...text.matchAll(/^State ID: ([0-9a-f-]{36})$/gim)];
  assert.equal(matches.length, 1, 'The explicit snapshot must contain one State ID.');
  return matches[0][1];
}

function readUid(text, role, name) {
  const label = `${role} ${JSON.stringify(name)}`;
  const matches = text
    .split('\n')
    .map((line) => /^\s*uid=([a-zA-Z0-9_-]+)\s+(.+)$/.exec(line))
    .filter((match) => match && (match[2] === label || match[2].startsWith(label + ' ')));
  assert.equal(matches.length, 1, `Expected exactly one observed ${role} named ${name}.`);
  return matches[0][1];
}

async function listen(server, signal) {
  const listening = once(server, 'listening', { signal });
  server.listen({ host: '127.0.0.1', port: 0, signal });
  await listening;
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function until(check, description, signal) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    signal.throwIfAborted();
    if (await check()) return;
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}.`);
    await delay(40, undefined, { signal });
  }
}

// This branch validates the formatting helpers without importing the browser
// service, starting a server, spawning any subprocess, or opening Chrome.
function selfCheck() {
  const text =
    'Page ID: 1\nState ID: 6986526e-a2de-4fd2-99b1-f0b6cf76dbf2\n' +
    '  uid=4_2 textbox "Draft message" value=""\n' +
    '  uid=4_3 button "Save draft"\n' +
    '  uid=4_4 link "Open owner control page" url="http://127.0.0.1:4321/"\n';
  assert.equal(readStateId(text), '6986526e-a2de-4fd2-99b1-f0b6cf76dbf2');
  assert.equal(readUid(text, 'textbox', 'Draft message'), '4_2');
  assert.equal(readUid(text, 'button', 'Save draft'), '4_3');
  assert.equal(readUid(text, 'link', 'Open owner control page'), '4_4');
  assert.throws(() => readStateId('Missing state'), /one State ID/);
  assert.throws(() => readUid(text, 'button', 'Missing button'), /exactly one observed/);
  assert.throws(
    () => readUid(text + 'uid=4_8 button "Save draft"\n', 'button', 'Save draft'),
    /exactly one observed/,
  );
  console.log('Chrome smoke parser self-check passed; no browser or server was started.');
}

async function smoke() {
  const { createBrowserControl } = await import('../dist/server/browser.js');
  assert.ok(process.env.DISPLAY, 'Run this desktop Chrome smoke under xvfb-run or an X display.');
  assert.notEqual(
    process.getuid?.(),
    0,
    'Run Chrome as an unprivileged user with its sandbox enabled.',
  );
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-chrome-smoke-'));
  const lifetime = new AbortController();
  const deadline = setTimeout(
    () => lifetime.abort(new Error('Chrome smoke exceeded its 150-second deadline.')),
    150_000,
  );
  const stop = () => lifetime.abort(new Error('Chrome smoke interrupted.'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let ownerOrigin = '';
  const ownerRequests = new Set();
  const ownerServer = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.on('finish', () => ownerRequests.add(request.url));
    if (request.url === '/') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(ownerPage);
    } else if (request.url === '/owner-style.css') {
      response.setHeader('content-type', 'text/css; charset=utf-8');
      response.end('body{font:18px system-ui;margin:40px;color:#18382b}');
    } else {
      response.statusCode = 404;
      response.end('Owner fixture route not found.');
    }
  });
  const server = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/') response.end(fixturePage.replace('__OWNER_ORIGIN__', ownerOrigin));
    else if (request.url === '/next') response.end(nextPage);
    else {
      response.statusCode = 404;
      response.end('Fixture route not found.');
    }
  });
  const browser = createBrowserControl({
    dataDir,
    getSettings: () => ({
      enabled: true,
      mode: 'dedicated',
      permission: 'allow',
      includeScreenshotsInModel: false,
    }),
    onChange() {},
    connectTimeoutMs: 45_000,
    actionTimeoutMs: 15_000,
  });
  let stage = 'initialization';
  const mark = (name) => {
    stage = name;
    console.log(`Chrome smoke: ${name}`);
  };
  const run = (command) => browser.execute(browser.prepare(command), lifetime.signal);
  try {
    ownerOrigin = await listen(ownerServer, lifetime.signal);
    const origin = await listen(server, lifetime.signal);
    assert.notEqual(origin, ownerOrigin);
    browser.protectOrigin(ownerOrigin);
    assert.equal(browser.status().state, 'disconnected');
    assert.equal(browser.status().tabs.length, 0);

    mark('connect to dedicated stable Chrome');
    const connected = await browser.connect(lifetime.signal);
    assert.equal(connected.state, 'connected');
    assert.equal(connected.mode, 'dedicated');

    mark('open a fixture tab and read its accessibility snapshot');
    await run({ operation: 'open', url: `${origin}/` });
    const tabList = await run({ operation: 'tabs' });
    assert.ok(tabList.text.includes(`${origin}/`));
    const tab = browser.status().tabs.find((candidate) => candidate.url === `${origin}/`);
    assert.ok(tab, 'The opened fixture must appear in the real tab list.');
    assert.equal(tab.protected, false);
    const pageId = tab.pageId;
    let snapshot = await run({ operation: 'snapshot', pageId });
    assert.match(snapshot.text, /Loom Chrome smoke fixture/);
    assert.match(snapshot.text, /No draft saved\./);

    mark('fill an observed field and click an observed button');
    const draft = 'Verified Chrome smoke draft';
    await run({
      operation: 'fill',
      pageId,
      stateId: readStateId(snapshot.text),
      uid: readUid(snapshot.text, 'textbox', 'Draft message'),
      text: draft,
    });
    snapshot = await run({ operation: 'snapshot', pageId });
    assert.ok(snapshot.text.includes(`value=${JSON.stringify(draft)}`));
    await run({
      operation: 'click',
      pageId,
      stateId: readStateId(snapshot.text),
      uid: readUid(snapshot.text, 'button', 'Save draft'),
    });
    snapshot = await run({ operation: 'snapshot', pageId });
    assert.ok(
      snapshot.text.includes(`Saved draft: ${draft}`),
      'The page must reflect the actual click.',
    );

    mark('capture a real viewport screenshot');
    const screenshot = await run({ operation: 'screenshot', pageId });
    assert.ok(screenshot.image, 'Chrome must return screenshot bytes.');
    assert.equal(screenshot.image.mimeType, 'image/jpeg');
    const bytes = Buffer.from(screenshot.image.data, 'base64');
    assert.ok(bytes.length > 1_000 && bytes.length <= 10 * 1024 * 1024);
    assert.equal(bytes.readUInt16BE(0), 0xffd8, 'The screenshot must start with a JPEG marker.');
    assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9, 'The JPEG must be complete.');

    mark('load a protected owner control page in a new tab without exposing it to bot tools');
    assert.equal(ownerRequests.size, 0);
    snapshot = await run({ operation: 'snapshot', pageId });
    await run({
      operation: 'click',
      pageId,
      stateId: readStateId(snapshot.text),
      uid: readUid(snapshot.text, 'link', 'Open owner control page'),
    });
    // This is ordinary Chrome navigation through a target=_blank link, not a
    // browser-tool open of the protected URL or a JavaScript-evaluation escape.
    await until(
      () => ownerRequests.has('/') && ownerRequests.has('/owner-style.css'),
      'the protected owner document and stylesheet to load normally',
      lifetime.signal,
    );
    let ownerTab;
    await until(
      async () => {
        await run({ operation: 'tabs' });
        ownerTab = browser.status().tabs.find((candidate) => candidate.url === `${ownerOrigin}/`);
        return Boolean(ownerTab);
      },
      'the protected owner tab to appear',
      lifetime.signal,
    );
    assert.equal(ownerTab.protected, true);
    assert.notEqual(ownerTab.pageId, pageId);
    assert.throws(
      () => browser.prepare({ operation: 'snapshot', pageId: ownerTab.pageId }),
      /control pages.*cannot be operated/i,
    );
    assert.throws(
      () => browser.prepare({ operation: 'screenshot', pageId: ownerTab.pageId }),
      /control pages.*cannot be operated/i,
    );
    assert.throws(
      () =>
        browser.prepare({
          operation: 'close',
          pageId: ownerTab.pageId,
          stateId: readStateId(snapshot.text),
        }),
      /control pages.*cannot be operated/i,
    );
    assert.throws(
      () => browser.prepare({ operation: 'open', url: `${ownerOrigin}/` }),
      /control pages.*cannot be opened/i,
    );

    mark('navigate the observed tab and close it');
    snapshot = await run({ operation: 'snapshot', pageId });
    await run({
      operation: 'navigate',
      pageId,
      stateId: readStateId(snapshot.text),
      url: `${origin}/next`,
    });
    assert.equal(
      browser.status().tabs.find((candidate) => candidate.pageId === pageId)?.url,
      `${origin}/next`,
    );
    snapshot = await run({ operation: 'snapshot', pageId });
    assert.match(snapshot.text, /Navigation succeeded/);
    await run({ operation: 'close', pageId, stateId: readStateId(snapshot.text) });
    await run({ operation: 'tabs' });
    assert.ok(!browser.status().tabs.some((candidate) => candidate.pageId === pageId));

    mark('disconnect, reject paused operations, then explicitly reconnect');
    const priorPlan = browser.prepare({ operation: 'tabs' });
    await browser.disconnect();
    assert.equal(browser.status().state, 'disconnected');
    assert.equal(browser.status().tabs.length, 0);
    assert.throws(() => browser.prepare({ operation: 'tabs' }), /disconnected by the user/i);
    await assert.rejects(browser.execute(priorPlan, lifetime.signal), /disconnected by the user/i);
    assert.equal(browser.status().state, 'disconnected');
    await browser.connect(lifetime.signal);
    assert.equal(browser.status().state, 'connected');
    await assert.rejects(browser.execute(priorPlan, lifetime.signal), /reconnected/i);
    const resumed = await run({ operation: 'tabs' });
    assert.match(resumed.text, /Chrome tab/);
    await browser.disconnect();
    assert.equal(browser.status().state, 'disconnected');
    console.log(
      `Real Chrome smoke passed: open, tabs, snapshot, fill, click, JPEG (${bytes.length} bytes), protected owner tab loading with bot access denied, navigate, close, disconnect, paused-state refusal, and explicit reconnect.`,
    );
  } catch (error) {
    console.error(`Chrome smoke failed during: ${stage}`);
    console.error(JSON.stringify(browser.status(), null, 2));
    throw error;
  } finally {
    lifetime.abort();
    // Closing the dedicated MCP session closes the Chrome process it launched.
    // Keep HTTP/profile cleanup in finally even when connection or shutdown fails.
    try {
      await browser.shutdown();
    } finally {
      await Promise.all(
        [server, ownerServer].map(async (http) => {
          http.closeAllConnections();
          await new Promise((resolve) => http.close(() => resolve()));
        }),
      );
      await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      clearTimeout(deadline);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--self-check') selfCheck();
else {
  assert.equal(args.length, 0, 'Supported argument: --self-check (no browser required).');
  await smoke();
}
