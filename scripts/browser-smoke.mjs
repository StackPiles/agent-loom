import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// CI uses the runner's installed stable Chrome in a desktop supplied by xvfb-run.
// Only an isolated temporary profile and these synthetic loopback pages are used.
const fixturePage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Loom Chrome smoke fixture</title>
<style>body{font:18px system-ui;max-width:640px;margin:60px auto;padding:24px}label,input,button{display:block;margin:16px 0}input,button{font:inherit;padding:10px}[hidden]{display:none!important}</style>
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
<h2>Binary attachments</h2>
<form id="upload-form" action="/upload/direct" method="post" enctype="multipart/form-data">
<label for="attachments">Attach binary files</label>
<input id="attachments" name="files" type="file" multiple>
<button type="submit">Submit binary files</button>
</form>
<p id="upload-selection" role="status">No binary files selected.</p>
<p id="upload-receipt" role="status">No binary upload received.</p>
<form id="proxy-upload-form" action="/upload/proxy" method="post" enctype="multipart/form-data">
<input id="proxy-attachment" name="files" type="file" hidden>
<button id="choose-hidden-upload" type="button">Choose hidden upload</button>
<button type="submit">Submit hidden upload</button>
</form>
<p id="proxy-selection" role="status">No hidden upload selected.</p>
<p id="proxy-receipt" role="status">No hidden upload received.</p>
<form id="large-upload-form" action="/upload/large" method="post" enctype="multipart/form-data">
<label for="large-attachment">Attach 100 MiB file</label>
<input id="large-attachment" name="files" type="file">
<button type="submit">Submit 100 MiB file</button>
</form>
<p id="large-selection" role="status">No large upload selected.</p>
<p id="large-receipt" role="status">No large upload received.</p>
<script>
document.querySelector('#draft-form').addEventListener('submit', (event) => {
  event.preventDefault();
  document.querySelector('#result').textContent = 'Saved draft: ' + document.querySelector('#message').value;
});
document.querySelector('#choose-hidden-upload').addEventListener('click', () => {
  document.querySelector('#proxy-attachment').click();
});
for (const [formId, inputId, selectionId, receiptId] of [
  ['upload-form', 'attachments', 'upload-selection', 'upload-receipt'],
  ['proxy-upload-form', 'proxy-attachment', 'proxy-selection', 'proxy-receipt'],
  ['large-upload-form', 'large-attachment', 'large-selection', 'large-receipt'],
]) {
  const form = document.getElementById(formId);
  const input = document.getElementById(inputId);
  input.addEventListener('change', () => {
    document.getElementById(selectionId).textContent = 'Selected: ' +
      [...input.files].map(file => file.name + ' (' + file.size + ' bytes)').join('; ');
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const receipt = document.getElementById(receiptId);
    receipt.textContent = 'Sending selected files.';
    try {
      const response = await fetch(form.action, {method: 'POST', body: new FormData(form)});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      receipt.textContent = 'Upload received: ' + result.route + '; ' +
        result.files.map(file => file.name + ' (' + file.size + ' bytes, SHA-256 ' + file.sha256 + ')').join('; ');
    } catch (error) {
      receipt.textContent = 'Upload failed: ' + error.message;
    }
  });
}
</script>
</body></html>`;
const nextPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Loom Chrome smoke next</title></head><body><h1>Navigation succeeded</h1><p>This is the second synthetic fixture page.</p></body></html>`;
const ownerPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Loom owner control fixture</title><link rel="stylesheet" href="/owner-style.css"></head><body><h1>Owner control page loaded</h1><p>Owners can open this page while bot tools cannot inspect or operate it.</p></body></html>`;

function binaryFixtures() {
  return [
    {
      path: '添付 バイナリ.bin',
      data: Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x0d, 0x0a, 0x22, 0x5c, 0xc3, 0x28]),
    },
    {
      path: 'second binary file.bin',
      data: Buffer.from(Array.from({ length: 1_024 }, (_, index) => index % 256)),
    },
  ];
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const LARGE_UPLOAD_BYTES = 104_857_600;
const LARGE_UPLOAD_NAME = 'large-100MiB.bin';
const LARGE_UPLOAD_CHUNK = Buffer.from(
  Array.from({ length: 64 * 1024 }, (_, index) => index % 256),
);
const fixtureSize = (file) => file.size ?? file.data.length;
const fixtureHash = (file) => file.sha256 ?? sha256(file.data);

// Reuse one small pattern buffer; the fixture itself never holds a 100 MiB copy.
function* largeUploadChunks() {
  for (let offset = 0; offset < LARGE_UPLOAD_BYTES; offset += LARGE_UPLOAD_CHUNK.length)
    yield LARGE_UPLOAD_CHUNK.subarray(
      0,
      Math.min(LARGE_UPLOAD_CHUNK.length, LARGE_UPLOAD_BYTES - offset),
    );
}
function largeUploadFixture() {
  const hash = createHash('sha256');
  for (const chunk of largeUploadChunks()) hash.update(chunk);
  return { path: LARGE_UPLOAD_NAME, size: LARGE_UPLOAD_BYTES, sha256: hash.digest('hex') };
}

// Decode this fixture's single large multipart file as a stream. Keep only its
// short headers/footer, compare every byte with the pattern, and retain metadata.
async function parseLargeMultipartUpload(contentType, chunks) {
  assert.equal(typeof contentType, 'string', 'The upload must declare its content type.');
  const match = /^multipart\/form-data;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))$/i.exec(contentType);
  assert.ok(match, 'Expected a multipart boundary.');
  const boundary = match[1] || match[2];
  assert.ok(boundary.length <= 200, 'The fixture boundary is too long.');
  const opening = `--${boundary}\r\n`;
  const ending = Buffer.from(`\r\n--${boundary}--`);
  let headers = Buffer.alloc(0);
  let footer = Buffer.alloc(0);
  let headerRead = false;
  let received = 0;
  let total = 0;
  const hash = createHash('sha256');
  for await (let chunk of chunks) {
    total += chunk.length;
    assert.ok(total <= LARGE_UPLOAD_BYTES + 16 * 1024, 'The large fixture upload is too big.');
    if (!headerRead) {
      headers = Buffer.concat([headers, chunk]);
      const end = headers.indexOf('\r\n\r\n');
      if (end < 0) {
        assert.ok(headers.length <= 16 * 1024, 'The multipart headers are too big.');
        continue;
      }
      assert.ok(end <= 16 * 1024, 'The multipart headers are too big.');
      const text = headers.subarray(0, end).toString('utf8');
      assert.ok(text.startsWith(opening), 'The multipart body must start with its boundary.');
      const lines = text.slice(opening.length).split('\r\n');
      assert.ok(
        lines.includes(
          `Content-Disposition: form-data; name="files"; filename="${LARGE_UPLOAD_NAME}"`,
        ),
        'Expected the original large filename in the files field.',
      );
      chunk = headers.subarray(end + 4);
      headers = Buffer.alloc(0);
      headerRead = true;
    }
    const length = Math.min(chunk.length, LARGE_UPLOAD_BYTES - received);
    const data = chunk.subarray(0, length);
    for (let offset = 0; offset < data.length;) {
      const patternOffset = (received + offset) % LARGE_UPLOAD_CHUNK.length;
      const count = Math.min(data.length - offset, LARGE_UPLOAD_CHUNK.length - patternOffset);
      assert.ok(
        data
          .subarray(offset, offset + count)
          .equals(LARGE_UPLOAD_CHUNK.subarray(patternOffset, patternOffset + count)),
        'Large multipart bytes must be unchanged.',
      );
      offset += count;
    }
    hash.update(data);
    received += data.length;
    if (chunk.length > length) {
      assert.ok(
        footer.length + chunk.length - length <= ending.length + 2,
        'Expected exactly one large multipart file.',
      );
      footer = Buffer.concat([footer, chunk.subarray(length)]);
    }
  }
  assert.equal(received, LARGE_UPLOAD_BYTES, 'The complete 100 MiB file must arrive.');
  assert.ok(
    footer.equals(ending) || footer.equals(Buffer.concat([ending, Buffer.from('\r\n')])),
    'The multipart closing boundary must be complete.',
  );
  return [
    {
      name: LARGE_UPLOAD_NAME,
      size: received,
      sha256: hash.digest('hex'),
      verifiedBytes: received,
    },
  ];
}

async function parseMultipartUpload(contentType, body) {
  assert.equal(typeof contentType, 'string', 'The upload must declare its content type.');
  assert.match(contentType, /^multipart\/form-data;\s*boundary=/i);
  const form = await new Request('http://127.0.0.1/upload', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  }).formData();
  const entries = [...form.entries()];
  assert.ok(entries.length > 0 && entries.length <= 3, 'Expected a bounded number of files.');
  return Promise.all(
    entries.map(async ([field, file]) => {
      assert.equal(field, 'files', 'Unexpected multipart field.');
      assert.ok(file instanceof File, 'The attachment must be a multipart file, not text.');
      const data = Buffer.from(await file.arrayBuffer());
      return { name: file.name, size: file.size, sha256: sha256(data), data };
    }),
  );
}

function assertUploadedFiles(actual, expected) {
  assert.equal(actual.length, expected.length, 'Every selected file must arrive exactly once.');
  for (let index = 0; index < expected.length; index++) {
    assert.equal(actual[index].name, expected[index].path, 'The original filename must survive.');
    assert.equal(actual[index].size, fixtureSize(expected[index]), 'File bytes must not be empty.');
    assert.equal(actual[index].sha256, fixtureHash(expected[index]));
    if (expected[index].data)
      assert.deepEqual(
        actual[index].data,
        expected[index].data,
        'Multipart bytes must be unchanged.',
      );
    else
      assert.equal(
        actual[index].verifiedBytes,
        fixtureSize(expected[index]),
        'Every large byte was checked.',
      );
  }
}

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

// This branch validates snapshot parsing and binary multipart decoding entirely
// in memory, without importing the browser service, starting a server or Chrome.
async function selfCheck() {
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
  const files = binaryFixtures();
  const form = new FormData();
  for (const file of files) form.append('files', new Blob([file.data]), file.path);
  const request = new Request('http://127.0.0.1/upload', { method: 'POST', body: form });
  const decoded = await parseMultipartUpload(
    request.headers.get('content-type'),
    Buffer.from(await request.arrayBuffer()),
  );
  assertUploadedFiles(decoded, files);
  assert.throws(
    () => assertUploadedFiles([{ ...decoded[0], data: Buffer.alloc(decoded[0].size) }], [files[0]]),
    /Multipart bytes must be unchanged/,
  );
  const boundary = 'large-self-check-boundary';
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${LARGE_UPLOAD_NAME}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  function* multipart() {
    // Force headers and footer to cross input chunks like an HTTP request can.
    for (let offset = 0; offset < header.length; offset += 11)
      yield header.subarray(offset, offset + 11);
    for (const chunk of largeUploadChunks()) {
      yield chunk.subarray(0, 113);
      yield chunk.subarray(113);
    }
    for (let offset = 0; offset < footer.length; offset += 7)
      yield footer.subarray(offset, offset + 7);
  }
  const large = await parseLargeMultipartUpload(
    `multipart/form-data; boundary=${boundary}`,
    multipart(),
  );
  assertUploadedFiles(large, [largeUploadFixture()]);
  const changed = Buffer.from(LARGE_UPLOAD_CHUNK);
  changed[0] ^= 0xff;
  await assert.rejects(
    parseLargeMultipartUpload(`multipart/form-data; boundary=${boundary}`, [header, changed]),
    /Large multipart bytes must be unchanged/,
  );
  console.log(
    'Chrome smoke parser, binary multipart and streamed 100 MiB self-check passed; no browser or server was started.',
  );
}

async function smoke() {
  const { createBrowserControl } = await import('../dist/server/browser.js');
  const { prepareBrowserUploads } = await import('../dist/server/browser-uploads.js');
  const { createBrowserUploadStorage } = await import('../dist/server/browser-upload-storage.js');
  assert.ok(process.env.DISPLAY, 'Run this desktop Chrome smoke under xvfb-run or an X display.');
  assert.notEqual(
    process.getuid?.(),
    0,
    'Run Chrome as an unprivileged user with its sandbox enabled.',
  );
  // Keep staging outside the MCP's implicit OS-temp root. Upload success must
  // exercise Loom's explicitly negotiated root, not accidentally rely on /tmp.
  const dataDir = await mkdtemp(join(process.cwd(), 'loom-chrome-smoke-'));
  const workspace = join(dataDir, 'workspace');
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
  const receivedUploads = [];
  let uploadFailure;
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
    if (request.method === 'POST' && /^\/upload\/(?:direct|proxy|large)$/.test(request.url ?? '')) {
      response.setHeader('content-type', 'application/json; charset=utf-8');
      void (async () => {
        try {
          const route = request.url.slice('/upload/'.length);
          let files;
          if (route === 'large') {
            async function* chunks() {
              for await (const chunk of request) {
                lifetime.signal.throwIfAborted();
                yield chunk;
              }
            }
            files = await parseLargeMultipartUpload(request.headers['content-type'], chunks());
          } else {
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
              lifetime.signal.throwIfAborted();
              size += chunk.length;
              assert.ok(size <= 1024 * 1024, 'The fixture upload exceeds 1 MiB.');
              chunks.push(chunk);
            }
            files = await parseMultipartUpload(
              request.headers['content-type'],
              Buffer.concat(chunks),
            );
          }
          receivedUploads.push({ route, files });
          response.end(
            JSON.stringify({
              route,
              files: files.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
            }),
          );
        } catch (error) {
          uploadFailure = error;
          response.statusCode = 400;
          response.end(JSON.stringify({ error: error.message }));
        }
      })();
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/') response.end(fixturePage.replace('__OWNER_ORIGIN__', ownerOrigin));
    else if (request.url === '/next') response.end(nextPage);
    else {
      response.statusCode = 404;
      response.end('Fixture route not found.');
    }
  });
  const getBrowserSettings = () => ({
    enabled: true,
    mode: 'dedicated',
    permission: 'allow',
    includeScreenshotsInModel: false,
  });
  const uploadStorage = createBrowserUploadStorage({ dataDir, getSettings: getBrowserSettings });
  const browser = createBrowserControl({
    dataDir,
    uploadStorage,
    getSettings: getBrowserSettings,
    onChange() {},
    connectTimeoutMs: 45_000,
    actionTimeoutMs: 15_000,
  });
  let stage = 'initialization';
  const mark = (name) => {
    stage = name;
    console.log(`Chrome smoke: ${name}`);
  };
  const run = (command, uploads) =>
    browser.execute(browser.prepare(command, uploads), lifetime.signal);
  try {
    const fromTemp = relative(await realpath(tmpdir()), await realpath(dataDir));
    assert.ok(
      isAbsolute(fromTemp) || fromTemp === '..' || fromTemp.startsWith('..' + sep),
      'Run the Chrome smoke from outside the OS temp directory to exercise explicit MCP roots.',
    );
    await mkdir(workspace);
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
    const uploadParent = join(dataDir, 'browser-uploads');
    const sessionNames = (await readdir(uploadParent)).filter((name) =>
      name.startsWith('session-'),
    );
    assert.equal(sessionNames.length, 1);
    const uploadSessionRoot = join(uploadParent, sessionNames[0]);
    const ownership = JSON.parse(
      await readFile(join(uploadSessionRoot, 'chrome-processes.json'), 'utf8'),
    );
    assert.ok(
      ownership.browsers.some((process) => process.pid > 0 && !process.exited),
      'The actual Chrome process must be recorded before accepting uploads.',
    );

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

    const verifyUpload = async (files, inputName, submitName, route, changeSources = false) => {
      for (const file of files)
        if (file.data) await writeFile(join(workspace, file.path), file.data);
      const uploads = await prepareBrowserUploads(
        workspace,
        files.map((file) => file.path),
        lifetime.signal,
      );
      let observed = await run({ operation: 'snapshot', pageId });
      const beforeCount = receivedUploads.length;
      await run(
        {
          operation: 'upload_file',
          pageId,
          stateId: readStateId(observed.text),
          uid: readUid(observed.text, 'button', inputName),
          filePaths: files.map((file) => file.path),
        },
        uploads,
      );
      try {
        await until(
          async () => {
            observed = await run({ operation: 'snapshot', pageId });
            return files.every((file) =>
              observed.text.includes(`${file.path} (${fixtureSize(file)} bytes)`),
            );
          },
          `the ${route} file selection and change-event display`,
          lifetime.signal,
        );
      } catch (error) {
        // Synthetic filenames and sizes only; make a real selection/size failure
        // distinguishable from accessibility or rendering timing in CI.
        console.error('Last upload selection snapshot:\n' + observed.text);
        throw error;
      }
      assert.equal(
        receivedUploads.length,
        beforeCount,
        'Selection alone must not submit this form.',
      );
      if (changeSources) {
        // Chrome may read the selected path only on this later submit. Emptying
        // the sources now catches cleanup or references to mutable originals.
        for (const file of files) await writeFile(join(workspace, file.path), Buffer.alloc(0));
      }
      await run({
        operation: 'click',
        pageId,
        stateId: readStateId(observed.text),
        uid: readUid(observed.text, 'button', submitName),
      });
      await until(
        () => {
          if (uploadFailure) throw uploadFailure;
          return receivedUploads.length > beforeCount;
        },
        `the ${route} multipart upload`,
        lifetime.signal,
      );
      assert.equal(receivedUploads.length, beforeCount + 1);
      const received = receivedUploads[beforeCount];
      assert.equal(received.route, route);
      assertUploadedFiles(received.files, files);
      await until(
        async () => {
          observed = await run({ operation: 'snapshot', pageId });
          return observed.text.includes(`Upload received: ${route};`);
        },
        `the ${route} upload receipt to appear in Chrome`,
        lifetime.signal,
      );
      for (const file of files) assert.ok(observed.text.includes(fixtureHash(file)));
    };

    mark('upload multiple binary files, change the originals, then verify exact multipart bytes');
    await verifyUpload(
      binaryFixtures(),
      'Attach binary files',
      'Submit binary files',
      'direct',
      true,
    );

    mark('upload through a visible chooser button for a hidden file input');
    await verifyUpload(
      [{ path: '代理 選択.bin', data: Buffer.from([0xff, 0x00, 0x01, 0x0d, 0x0a, 0x80]) }],
      'Choose hidden upload',
      'Submit hidden upload',
      'proxy',
    );
    mark('upload 100 MiB with default limits and verify immutable delayed multipart bytes');
    const largeFile = largeUploadFixture();
    await writeFile(join(workspace, largeFile.path), largeUploadChunks(), {
      flag: 'wx',
      mode: 0o600,
      signal: lifetime.signal,
    });
    await verifyUpload([largeFile], 'Attach 100 MiB file', 'Submit 100 MiB file', 'large', true);
    assert.equal(receivedUploads.length, 3, 'Each synthetic form must submit exactly once.');

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
    await until(
      async () => {
        await uploadStorage.sweep();
        try {
          await stat(uploadSessionRoot);
          return false;
        } catch (error) {
          if (error.code === 'ENOENT') return true;
          throw error;
        }
      },
      'the stopped Chrome process and its private upload copies to be reclaimed',
      lifetime.signal,
    );
    await browser.connect(lifetime.signal);
    assert.equal(browser.status().state, 'connected');
    await assert.rejects(browser.execute(priorPlan, lifetime.signal), /reconnected/i);
    const resumed = await run({ operation: 'tabs' });
    assert.match(resumed.text, /Chrome tab/);
    await browser.disconnect();
    assert.equal(browser.status().state, 'disconnected');
    console.log(
      `Real Chrome smoke passed: open, tabs, snapshot, fill, click, JPEG (${bytes.length} bytes), multipart uploads with exact binary bytes and Japanese filenames, 100 MiB (${LARGE_UPLOAD_BYTES} bytes) under default limits with streamed byte/hash verification, immutable delayed submission, hidden-input chooser fallback, actual Chrome ownership and copy reclamation after exit, protected owner tab loading with bot access denied, navigate, close, disconnect, paused-state refusal, and explicit reconnect.`,
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
      await uploadStorage.shutdown();
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
if (args.length === 1 && args[0] === '--self-check') await selfCheck();
else {
  assert.equal(args.length, 0, 'Supported argument: --self-check (no browser required).');
  await smoke();
}
