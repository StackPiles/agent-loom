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
<p id="environment" role="status"></p>
<p id="profile-state" role="status"></p>
<button id="save-profile" type="button">Save profile marker</button>
<form id="draft-form">
<label for="message">Draft message</label>
<input id="message" name="message" autocomplete="off">
<button type="submit">Save draft</button>
</form>
<p id="result" role="status">No draft saved.</p>
<h2>Controlled email form</h2>
<form id="email-form">
<label for="email">Email address</label>
<input id="email" type="email" value="old@fixture.invalid" required autocomplete="off">
<button id="email-continue" type="submit">Continue with email</button>
</form>
<p id="email-state" role="status"></p>
<p id="email-result" role="status">Email step not submitted.</p>
<label for="password">Synthetic password</label>
<input id="password" type="password" value="old-synthetic-password" autocomplete="off">
<label for="notes">Multiline notes</label>
<textarea id="notes">Old notes</textarea>
<div id="editor" contenteditable="true" role="textbox" aria-label="Rich draft">Old rich draft</div>
<p id="replacement-state" role="status"></p>
<p id="saved-credential-state" role="status"></p>
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
document.querySelector('#environment').textContent = 'Navigator webdriver: ' + navigator.webdriver;
const profileState = () => {
  document.querySelector('#profile-state').textContent = 'Profile marker: ' +
    (localStorage.getItem('loom-smoke-profile') || 'absent') + '; Cookie marker: ' +
    (document.cookie.split('; ').includes('loomSmokeProfile=retained') ? 'retained' : 'absent');
};
document.querySelector('#save-profile').addEventListener('click', () => {
  localStorage.setItem('loom-smoke-profile', 'retained');
  document.cookie = 'loomSmokeProfile=retained; Max-Age=3600; Path=/; SameSite=Strict';
  profileState();
});
profileState();
const email = document.querySelector('#email');
const emailContinue = document.querySelector('#email-continue');
let emailModel = email.value;
let emailInputEvents = 0;
let emailChangeEvents = 0;
const emailState = () => {
  emailContinue.disabled = !email.validity.valid || emailModel !== email.value;
  document.querySelector('#email-state').textContent = 'Email valid: ' + email.validity.valid +
    '; Continue disabled: ' + emailContinue.disabled + '; Input events: ' + emailInputEvents +
    '; Change events: ' + emailChangeEvents + '; Email length: ' + email.value.length;
};
// A controlled app restores its current model on focus. Clearing the DOM value
// without an input event before focusing must not append new text to this value.
email.addEventListener('focus', () => { email.value = emailModel; emailState(); });
email.addEventListener('input', () => { emailModel = email.value; ++emailInputEvents; emailState(); });
email.addEventListener('change', () => { ++emailChangeEvents; emailState(); });
emailState();
document.querySelector('#email-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (emailContinue.disabled || emailModel !== email.value) return;
  document.querySelector('#email-result').textContent = 'Email next step reached for ' + emailModel;
});
const replacementState = () => {
  document.querySelector('#saved-credential-state').textContent = 'Saved credential accepted: ' + (document.querySelector('#password').value === 'synthetic-saved-password');
  document.querySelector('#replacement-state').textContent =
    'Password replacement accepted: ' + (document.querySelector('#password').value === 'synthetic-new-password') +
    '; Multiline replacement accepted: ' + (document.querySelector('#notes').value === 'First line\\n日本語の二行目') +
    '; Rich replacement accepted: ' + (document.querySelector('#editor').textContent === 'New rich draft');
};
for (const id of ['password', 'notes', 'editor']) {
  document.getElementById(id).addEventListener('input', replacementState);
  document.getElementById(id).addEventListener('change', replacementState);
}
replacementState();
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
const recoveryPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Loom browser recovery fixture</title></head><body>
<h1>Browser recovery fixture</h1>
<p id="page-instance"></p><p id="recovery-state" role="status">Not signed in.</p>
<form id="sign-in"><button type="submit">Submit synthetic sign in</button></form>
<button id="check-session" type="button">Check synthetic session</button>
<form id="retained-upload" action="/upload/recovery" method="post" enctype="multipart/form-data">
<label for="recovery-attachment">Retained recovery attachment</label>
<input id="recovery-attachment" name="files" type="file">
<button type="submit">Submit retained recovery attachment</button>
</form><p id="retained-upload-state" role="status">No retained upload sent.</p>
<script>
const pageInstance = crypto.randomUUID();
document.querySelector('#page-instance').textContent = 'Page instance: ' + pageInstance;
const show = (result) => {
  document.querySelector('#recovery-state').textContent =
    'Server session: ' + (result.signedIn ? 'retained' : 'absent') +
    '; Tab session: ' + (sessionStorage.getItem('loomRecoveryTab') || 'absent') +
    '; Submission count: ' + result.submissions;
};
document.querySelector('#sign-in').addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await fetch('/recovery/submit', {method: 'POST'});
  sessionStorage.setItem('loomRecoveryTab', 'retained');
  show(await response.json());
});
document.querySelector('#check-session').addEventListener('click', async () => {
  show(await (await fetch('/recovery/status')).json());
});
document.querySelector('#retained-upload').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await (await fetch('/upload/recovery', {method: 'POST', body: new FormData(event.target)})).json();
  document.querySelector('#retained-upload-state').textContent =
    'Retained upload received: ' + result.files.map(file => file.sha256).join(', ');
});
</script></body></html>`;

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

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function ownedChromePid(sessionRoot) {
  const ownership = JSON.parse(await readFile(join(sessionRoot, 'chrome-processes.json'), 'utf8'));
  const livePids = [
    ...new Set(ownership.browsers.filter((child) => !child.exited).map((child) => child.pid)),
  ];
  assert.equal(livePids.length, 1, 'Exactly one owned Chrome must be live in this session.');
  const pid = livePids[0];
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.notEqual(pid, process.pid, 'The recorded Chrome must be a separate process.');
  assert.ok(processAlive(pid), 'The recorded Chrome must be running.');
  return pid;
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
  for (const page of [fixturePage, recoveryPage])
    for (const [, script] of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(script); // Parse the generated inline fixture without executing it.
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

async function checkRuntimeBrowserJournal({
  browser,
  dataDir,
  workspace,
  url,
  signal,
  nextVersion,
  requestCount,
}) {
  const { createApp } = await import('../dist/server/app.js');
  const { createTools } = await import('../dist/server/runtime/tools.js');
  const { DEFAULT_BROWSER_SETTINGS } = await import('../dist/shared/browser.js');
  const { DEFAULT_AUTONOMOUS_WAKEUP_POLICY } = await import('../dist/shared/work.js');
  // Exercise the real runtime journal and browser manager with the already
  // connected Chrome. No language model, scheduled dispatch or external site.
  const fixture = await createApp({
    dataDir: join(dataDir, 'runtime-journal'),
    scheduler: false,
    browserFactory: () => browser,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  const registries = [];
  try {
    await fixture.app.ready();
    fixture.store.put('settings', {
      ...fixture.store.settings(),
      id: 'main',
      workspacePath: workspace,
      demoMode: true,
      autoLearn: false,
      browser: {
        ...DEFAULT_BROWSER_SETTINGS,
        enabled: true,
        mode: 'dedicated',
        permission: 'allow',
      },
    });
    fixture.store.patch('bots', 'bot_aster', { browser: { mode: 'shared' } });
    fixture.store.patch('rooms', 'room_lounge', {
      autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'self' },
    });
    const make = (parentTaskId) => {
      const task = fixture.controller.enqueueTask({
        roomId: 'room_lounge',
        botId: 'bot_aster',
        prompt: 'Inspect the synthetic page again.',
        ...(parentTaskId ? { parentTaskId, kind: 'automation' } : {}),
      });
      const context = {
        host: fixture.controller,
        task,
        settings: fixture.store.settings(),
        signal,
        operationKeys: new Set(),
      };
      return { task, context };
    };
    const callOpen = async (context, toolCallId) => {
      // Recreate the registry to model recovery, preserving the supplied call ID.
      const registry = createTools({ ...context, operationKeys: new Set() });
      registries.push(registry);
      const tool = registry.definitions.find((entry) => entry.name === 'browser_use');
      assert.ok(tool, 'The runtime must expose browser_use.');
      const result = await tool.execute(toolCallId, { operation: 'open', url }, signal);
      return result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
    };
    const assertHistorical = (text) => {
      assert.match(text, /already completed.*not repeated/i);
      assert.match(text, /current page state has not been observed/i);
      assert.doesNotMatch(text, /Journal version [12]|^Page ID:|^State ID:/m);
    };

    const first = make();
    const firstResult = await callOpen(first.context, 'chrome-journal-first-open');
    assert.match(firstResult, /Journal version 1/);
    assert.equal(requestCount(), 1);
    const firstTab = browser.status().tabs.find((tab) => tab.url === url);
    assert.ok(firstTab);
    // Bind the first task after its operation to cover pre-reservation receipts.
    const reserved = fixture.controller.manageWakeup(first.task.id, {
      operation: 'upsert',
      key: 'chrome-journal-review',
      name: 'Review the changed fixture',
      purpose: 'Verify current page content after a work continuation.',
      reason: 'The synthetic page will change.',
      prompt: 'Open the fixture and read its current version.',
      schedule: {
        type: 'once',
        dateTime: new Date(Date.now() + 3_600_000).toISOString().slice(0, 16),
        timeZone: 'UTC',
        missedRunPolicy: 'run_once',
      },
      checkpoint: {
        summary: 'The first version was inspected.',
        completed: 'Opened the synthetic page.',
        nextStep: 'Read its changed version.',
        references: [url],
        doneWhen: 'The current version is observed.',
        uncertainActions: [],
      },
    });
    const firstTabCount = browser.status().tabs.length;
    assertHistorical(await callOpen(first.context, 'chrome-journal-first-open'));
    assert.equal(requestCount(), 1, 'Recovering an open must not request the page again.');
    assert.equal(browser.status().tabs.length, firstTabCount);
    await browser.execute(
      browser.prepare({
        operation: 'close',
        pageId: firstTab.pageId,
        stateId: readStateId(firstResult),
      }),
      signal,
    );
    assert.ok(!browser.status().tabs.some((tab) => tab.pageId === firstTab.pageId));

    nextVersion();
    const later = make(first.task.id);
    assert.equal(later.task.workId, reserved.work.id);
    assert.equal(later.task.workRunId, reserved.wakeup.workRunId);
    const laterResult = await callOpen(later.context, 'chrome-journal-later-open');
    assert.match(laterResult, /Journal version 2/);
    assert.doesNotMatch(laterResult, /Journal version 1/);
    assert.notEqual(readStateId(laterResult), readStateId(firstResult));
    assert.equal(requestCount(), 2, 'A continuation must fetch the changed page.');
    const laterTabCount = browser.status().tabs.length;
    assertHistorical(await callOpen(later.context, 'chrome-journal-later-open'));
    assert.equal(requestCount(), 2);
    assert.equal(browser.status().tabs.length, laterTabCount);
  } finally {
    for (const registry of registries) registry.dispose();
    // This fixture runs last: app shutdown also closes the reused Chrome.
    await fixture.app.close();
  }
}

async function checkRoomScopedBrowsers({ dataDir, origin, signal }) {
  const { createApp } = await import('../dist/server/app.js');
  const { createTools } = await import('../dist/server/runtime/tools.js');
  const { DEFAULT_BROWSER_SETTINGS } = await import('../dist/shared/browser.js');
  // Use production routes, the real manager and actual Chrome processes. The
  // runtime stub prevents model calls; browser_use still follows its real task.
  const fixture = await createApp({
    dataDir: join(dataDir, 'room-isolation'),
    scheduler: false,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  const registries = [];
  try {
    await fixture.app.ready();
    fixture.store.put('settings', {
      ...fixture.store.settings(),
      id: 'main',
      demoMode: true,
      autoLearn: false,
      browser: {
        ...DEFAULT_BROWSER_SETTINGS,
        enabled: true,
        // Dedicated tasks must not attach to the configured existing Chrome.
        mode: 'existing',
        permission: 'allow',
        maxConcurrentBrowsers: 2,
      },
    });
    const roomA = 'room_lounge';
    const roomB = 'room_smoke_other';
    fixture.store.put('rooms', {
      ...fixture.store.get('rooms', roomA),
      id: roomB,
      name: 'Other browser isolation room',
    });
    const request = async (method, roomId) => {
      const response = await fixture.app.inject({
        method,
        url: `/api/rooms/${roomId}/bots/bot_aster/browser${method === 'GET' ? '' : '/connect'}`,
        signal,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    for (const roomId of [roomA, roomB]) {
      const status = await request('GET', roomId);
      assert.equal(status.state, 'disconnected');
      assert.equal(status.pool.active, 0, 'Reading room status must not launch Chrome.');
    }
    assert.equal(fixture.controller.browser.status().state, 'disconnected');
    assert.equal((await request('POST', roomA)).state, 'connected');
    assert.equal((await request('POST', roomB)).state, 'connected');
    const resident = await request('GET', roomA);
    assert.equal(resident.pool.active, 2);
    assert.equal(resident.pool.limit, 2);
    assert.equal(fixture.controller.browser.status().state, 'disconnected');
    const sessionsRoot = join(dataDir, 'room-isolation', 'browser-uploads');
    const sessions = (await readdir(sessionsRoot)).filter((name) => name.startsWith('session-'));
    assert.equal(sessions.length, 2);
    const chromePids = await Promise.all(
      sessions.map((name) => ownedChromePid(join(sessionsRoot, name))),
    );
    assert.equal(new Set(chromePids).size, 2, 'Each room must own a distinct Chrome process.');

    const make = (roomId) => {
      const task = fixture.controller.enqueueTask({
        roomId,
        botId: 'bot_aster',
        prompt: 'Check only this room’s synthetic browser page.',
      });
      const registry = createTools({
        host: fixture.controller,
        task,
        settings: fixture.store.settings(),
        signal,
        operationKeys: new Set(),
      });
      registries.push(registry);
      const tool = registry.definitions.find((entry) => entry.name === 'browser_use');
      assert.ok(tool);
      let sequence = 0;
      return async (command) => {
        const result = await tool.execute(`room-smoke-${roomId}-${++sequence}`, command, signal);
        return result.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
      };
    };
    const runA = make(roomA);
    const runB = make(roomB);
    const urlA = `${origin}/room-isolation/a`;
    const urlB = `${origin}/room-isolation/b`;
    await runA({ operation: 'open', url: urlA });
    const tabA = (await request('GET', roomA)).tabs.find((tab) => tab.url === urlA);
    assert.ok(tabA);
    let stateA = await runA({ operation: 'snapshot', pageId: tabA.pageId });
    assert.match(stateA, /Profile marker: absent; Cookie marker: absent/);
    await runA({
      operation: 'click',
      pageId: tabA.pageId,
      stateId: readStateId(stateA),
      uid: readUid(stateA, 'button', 'Save profile marker'),
    });
    stateA = await runA({ operation: 'snapshot', pageId: tabA.pageId });
    assert.match(stateA, /Profile marker: retained; Cookie marker: retained/);
    // Load room B only after A saves the same-origin markers, so its displayed
    // values read current storage rather than a DOM snapshot from before A's write.
    await runB({ operation: 'open', url: urlB });
    const statusA = await request('GET', roomA);
    const statusB = await request('GET', roomB);
    const tabB = statusB.tabs.find((tab) => tab.url === urlB);
    assert.ok(tabB);
    assert.ok(!statusA.tabs.some((tab) => tab.url === urlB));
    assert.ok(!statusB.tabs.some((tab) => tab.url === urlA));
    let stateB = await runB({ operation: 'snapshot', pageId: tabB.pageId });
    assert.match(stateB, /Profile marker: absent; Cookie marker: absent/);
    assert.notEqual(readStateId(stateA), readStateId(stateB));
    await assert.rejects(
      runB({
        operation: 'click',
        pageId: tabB.pageId,
        stateId: readStateId(stateA),
        uid: readUid(stateA, 'button', 'Save profile marker'),
      }),
      /state is stale or missing/i,
    );
    stateB = await runB({ operation: 'snapshot', pageId: tabB.pageId });
    assert.match(stateB, /Profile marker: absent; Cookie marker: absent/);
    assert.equal((await request('DELETE', roomA)).state, 'disconnected');
    const remaining = await request('GET', roomB);
    assert.equal(remaining.state, 'connected');
    assert.equal(remaining.pool.active, 1);
    stateB = await runB({ operation: 'snapshot', pageId: tabB.pageId });
    await runB({
      operation: 'click',
      pageId: tabB.pageId,
      stateId: readStateId(stateB),
      uid: readUid(stateB, 'button', 'Save profile marker'),
    });
    assert.match(
      await runB({ operation: 'snapshot', pageId: tabB.pageId }),
      /Profile marker: retained; Cookie marker: retained/,
    );
    assert.equal((await request('GET', roomA)).state, 'disconnected');
    assert.equal(fixture.controller.browser.status().state, 'disconnected');
    assert.equal((await request('DELETE', roomB)).state, 'disconnected');
  } finally {
    for (const registry of registries) registry.dispose();
    await fixture.app.close();
  }
}

async function checkBrowserRecovery({
  dataDir,
  origin,
  signal,
  submissionCount,
  receivedUploads,
  uploadFailure,
}) {
  const { createBrowserControl, createChromePeer } = await import('../dist/server/browser.js');
  const { startBrowserOwner } = await import('../dist/server/browser-owner.js');
  const { prepareBrowserUploads } = await import('../dist/server/browser-uploads.js');
  const { createBrowserUploadStorage } = await import('../dist/server/browser-upload-storage.js');
  const scopeDataDir = join(dataDir, 'browser-recovery');
  const getSettings = () => ({ enabled: true, mode: 'dedicated', permission: 'allow' });
  const uploadStorage = createBrowserUploadStorage({ dataDir: scopeDataDir, getSettings });
  const peers = [];
  let failAfterNextClick = false;
  let delayedObservation = false;
  let injectedTimeouts = 0;
  const browser = createBrowserControl({
    dataDir: scopeDataDir,
    getSettings,
    uploadStorage,
    onChange() {},
    connectTimeoutMs: 45_000,
    actionTimeoutMs: 15_000,
    dedicatedFactory: startBrowserOwner,
    peerFactory: async (options, peerSignal) => {
      assert.ok(options.dedicatedEndpoint, 'Real recovery uses the independent Chrome owner.');
      const peer = await createChromePeer(options, peerSignal);
      peers.push(peer);
      return {
        get pid() {
          return peer.pid;
        },
        close: () => peer.close(),
        async callTool(name, args, callSignal, timeoutMs) {
          if (name === 'take_snapshot' && delayedObservation) {
            delayedObservation = false;
            injectedTimeouts++;
            // Drop exactly one post-action observation at the transport boundary.
            // The click already ran in real Chrome. A short injected deadline
            // exercises timeout recovery without adding 15 seconds to this suite.
            const deadline = AbortSignal.timeout(80);
            try {
              await delay(60_000, undefined, { signal: AbortSignal.any([callSignal, deadline]) });
            } catch {
              callSignal.throwIfAborted();
              throw deadline.reason;
            }
            assert.fail('The injected observation deadline must expire.');
          }
          const result = await peer.callTool(name, args, callSignal, timeoutMs);
          if (name === 'click' && failAfterNextClick) {
            failAfterNextClick = false;
            delayedObservation = true;
          }
          return result;
        },
      };
    },
  });
  const run = (command, uploads) => browser.execute(browser.prepare(command, uploads), signal);
  const pageInstance = (text) => {
    const match = /Page instance: ([0-9a-f-]{36})/.exec(text);
    assert.ok(match, 'The live page must expose its synthetic in-memory identity.');
    return match[1];
  };
  const currentPage = () => {
    const pages = browser.status().tabs.filter((tab) => tab.url === `${origin}/recovery`);
    assert.equal(
      pages.length,
      1,
      'Recovery must keep the original page, without reopening its URL.',
    );
    return pages[0];
  };
  const verifySession = async (expectedInstance) => {
    await run({ operation: 'tabs' });
    const page = currentPage();
    let observed = await run({ operation: 'snapshot', pageId: page.pageId });
    assert.equal(
      pageInstance(observed.text),
      expectedInstance,
      'MCP recovery must not reload the page.',
    );
    await run({
      operation: 'click',
      pageId: page.pageId,
      stateId: readStateId(observed.text),
      uid: readUid(observed.text, 'button', 'Check synthetic session'),
    });
    observed = await run({ operation: 'snapshot', pageId: page.pageId });
    assert.match(
      observed.text,
      /Server session: retained; Tab session: retained; Submission count: 1/,
    );
    assert.equal(pageInstance(observed.text), expectedInstance);
    assert.equal(
      submissionCount(),
      1,
      'Recovery must never repeat the synthetic login submission.',
    );
  };
  try {
    await run({ operation: 'open', url: `${origin}/recovery` });
    const page = currentPage();
    let observed = await run({ operation: 'snapshot', pageId: page.pageId });
    const instance = pageInstance(observed.text);
    const sessionsRoot = join(scopeDataDir, 'browser-uploads');
    const sessions = (await readdir(sessionsRoot)).filter((name) => name.startsWith('session-'));
    assert.equal(sessions.length, 1);
    const sessionRoot = join(sessionsRoot, sessions[0]);
    const chromePid = await ownedChromePid(sessionRoot);
    const workspace = join(scopeDataDir, 'workspace');
    await mkdir(workspace);
    const file = binaryFixtures()[0];
    await writeFile(join(workspace, file.path), file.data);
    const uploads = await prepareBrowserUploads(workspace, [file.path], signal);
    await run(
      {
        operation: 'upload_file',
        pageId: page.pageId,
        stateId: readStateId(observed.text),
        uid: readUid(observed.text, 'button', 'Retained recovery attachment'),
        filePaths: [file.path],
      },
      uploads,
    );
    await writeFile(join(workspace, file.path), Buffer.alloc(0));
    observed = await run({ operation: 'snapshot', pageId: page.pageId });
    const loginPlan = browser.prepare({
      operation: 'click',
      pageId: page.pageId,
      stateId: readStateId(observed.text),
      uid: readUid(observed.text, 'button', 'Submit synthetic sign in'),
    });
    failAfterNextClick = true;
    const receipt = await browser.execute(loginPlan, signal);
    assert.equal(injectedTimeouts, 1);
    assert.match(receipt.text, /action returned[\s\S]*observation unavailable/i);
    assert.doesNotMatch(
      receipt.text,
      /^State ID:/m,
      'An unavailable observation cannot authorize another write.',
    );
    await until(() => submissionCount() === 1, 'the real one-time login submission', signal);
    assert.equal(await ownedChromePid(sessionRoot), chromePid);
    await uploadStorage.sweep();
    assert.ok((await readdir(sessionRoot)).some((name) => name.startsWith('files-')));
    await verifySession(instance);
    assert.equal(
      peers.length,
      2,
      'The next read must recreate the disposable MCP connection automatically.',
    );
    await assert.rejects(browser.execute(loginPlan, signal), /reconnected|stale|fresh snapshot/i);
    assert.equal(submissionCount(), 1);

    // This PID comes directly from the fixture's own Stdio transport, never
    // process-name discovery or another browser on the machine.
    const mcpPid = peers.at(-1).pid;
    assert.ok(Number.isSafeInteger(mcpPid) && mcpPid > 0);
    assert.notEqual(mcpPid, chromePid);
    assert.notEqual(mcpPid, process.pid);
    process.kill(mcpPid, 'SIGKILL');
    await until(
      () => browser.status().state !== 'connected',
      'the owned MCP transport failure',
      signal,
    );
    assert.equal(
      await ownedChromePid(sessionRoot),
      chromePid,
      'MCP death must leave its Chrome owner alive.',
    );
    await uploadStorage.sweep();
    assert.ok((await readdir(sessionRoot)).some((name) => name.startsWith('files-')));
    await verifySession(instance);
    assert.equal(peers.length, 3);
    assert.equal(await ownedChromePid(sessionRoot), chromePid);
    await uploadStorage.sweep();
    const recoveredPage = currentPage();
    observed = await run({ operation: 'snapshot', pageId: recoveredPage.pageId });
    const uploadsBefore = receivedUploads.length;
    await run({
      operation: 'click',
      pageId: recoveredPage.pageId,
      stateId: readStateId(observed.text),
      uid: readUid(observed.text, 'button', 'Submit retained recovery attachment'),
    });
    await until(
      () => {
        if (uploadFailure()) throw uploadFailure();
        return receivedUploads.length > uploadsBefore;
      },
      'the selected upload bytes after both MCP recoveries',
      signal,
    );
    assert.equal(receivedUploads.length, uploadsBefore + 1);
    assert.equal(receivedUploads[uploadsBefore].route, 'recovery');
    assertUploadedFiles(receivedUploads[uploadsBefore].files, [file]);
    await browser.disconnect();
    await until(
      () => !processAlive(chromePid),
      'explicit disconnect to close the retained Chrome',
      signal,
    );
    assert.equal(browser.status().state, 'disconnected');
    await until(
      async () => {
        await uploadStorage.sweep();
        try {
          await stat(sessionRoot);
          return false;
        } catch (error) {
          if (error.code === 'ENOENT') return true;
          throw error;
        }
      },
      'retained upload copies to be reclaimed after actual Chrome exit',
      signal,
    );
  } finally {
    try {
      await browser.shutdown();
    } finally {
      await uploadStorage.shutdown();
    }
  }
}

async function checkAutonomousBrowserCapacity({ dataDir, origin, signal }) {
  const { createBrowserManager } = await import('../dist/server/browser-manager.js');
  const { DEFAULT_BROWSER_SETTINGS } = await import('../dist/shared/browser.js');
  const scopes = [
    { roomId: 'room_capacity_a', botId: 'bot_capacity_alpha', taskId: 'task_capacity_a' },
    { roomId: 'room_capacity_b', botId: 'bot_capacity_alpha', taskId: 'task_capacity_b' },
    { roomId: 'room_capacity_b', botId: 'bot_capacity_beta', taskId: 'task_capacity_c' },
  ];
  const scopeDataDir = join(dataDir, 'autonomous-capacity');
  const bots = new Map(
    scopes.map(({ botId }) => [
      botId,
      { id: botId, enabled: true, browser: { mode: 'dedicated' } },
    ]),
  );
  const rooms = new Map(
    scopes.map(({ roomId }) => [
      roomId,
      {
        id: roomId,
        botIds: [
          ...new Set(scopes.filter((scope) => scope.roomId === roomId).map((scope) => scope.botId)),
        ],
      },
    ]),
  );
  const manager = createBrowserManager({
    dataDir: scopeDataDir,
    getSettings: () => ({
      ...DEFAULT_BROWSER_SETTINGS,
      enabled: true,
      permission: 'allow',
      maxConcurrentBrowsers: 1,
    }),
    getBot: (id) => bots.get(id),
    getRoom: (id) => rooms.get(id),
    onChange() {},
  });
  const status = (scope) => manager.botStatus(scope.botId, scope.roomId);
  const acquire = (scope) => manager.forTask(scope.botId, scope.roomId, scope.taskId, signal);
  const run = (handle, command) => handle.execute(handle.prepare(command), signal);
  const currentPid = async () => {
    const sessionRoot = join(scopeDataDir, 'browser-uploads');
    const sessions = (await readdir(sessionRoot)).filter((name) => name.startsWith('session-'));
    const live = [];
    for (const name of sessions) {
      try {
        const ownership = JSON.parse(
          await readFile(join(sessionRoot, name, 'chrome-processes.json'), 'utf8'),
        );
        for (const child of ownership.browsers)
          if (!child.exited && processAlive(child.pid)) live.push(child.pid);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    assert.equal(
      new Set(live).size,
      1,
      'The one-browser limit must apply to actual live Chrome processes.',
    );
    return live[0];
  };
  const inspect = async (scope, handle, retained) => {
    await run(handle, { operation: 'open', url: `${origin}/room-isolation/a` });
    const own = status(scope);
    assert.equal(own.pool.active, 1);
    assert.equal(own.pool.limit, 1);
    const page = own.tabs.find((tab) => tab.url === `${origin}/room-isolation/a`);
    assert.ok(page);
    const observed = await run(handle, { operation: 'snapshot', pageId: page.pageId });
    assert.match(
      observed.text,
      retained
        ? /Profile marker: retained; Cookie marker: retained/
        : /Profile marker: absent; Cookie marker: absent/,
    );
    if (!retained)
      await run(handle, {
        operation: 'click',
        pageId: page.pageId,
        stateId: readStateId(observed.text),
        uid: readUid(observed.text, 'button', 'Save profile marker'),
      });
    return currentPid();
  };
  const [scopeA, scopeB, scopeC] = scopes;
  try {
    for (const scope of scopes) assert.equal(status(scope).state, 'disconnected');
    const handleA = await acquire(scopeA);
    const pidA = await inspect(scopeA, handleA, false);
    // Tasks request their own browsers; no settings or connect API participates.
    const waitingB = acquire(scopeB);
    const waitingC = acquire(scopeC);
    // Keep eventual cleanup rejections handled if an earlier assertion fails.
    void waitingB.catch(() => {});
    void waitingC.catch(() => {});
    await until(
      () => status(scopeA).pool.waiting === 2,
      'two autonomous browser requests to queue',
      signal,
    );
    assert.equal(
      await currentPid(),
      pidA,
      'Queued tasks must not interrupt the current browser task.',
    );
    assert.equal(manager.yieldTask(scopeA.taskId, scopeA.botId, scopeA.roomId), true);
    const handleB = await waitingB;
    const pidB = await inspect(scopeB, handleB, false);
    assert.notEqual(pidB, pidA);
    assert.equal(processAlive(pidA), false, 'Capacity reuse must wait for actual Chrome exit.');
    assert.equal(status(scopeC).waiting, true);
    assert.equal(manager.yieldTask(scopeB.taskId, scopeB.botId, scopeB.roomId), true);
    const handleC = await waitingC;
    const pidC = await inspect(scopeC, handleC, false);
    assert.notEqual(pidC, pidB);
    assert.equal(processAlive(pidB), false);
    manager.releaseTask(scopeC.taskId);
    const resumedA = await acquire(scopeA);
    const resumedPidA = await inspect(scopeA, resumedA, true);
    assert.notEqual(resumedPidA, pidA, 'Evicted scopes must reopen their own persistent profile.');
    assert.equal(processAlive(pidC), false);
    manager.releaseTask(scopeA.taskId);
  } finally {
    await manager.shutdown();
  }
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
    () => lifetime.abort(new Error('Chrome smoke exceeded its 210-second deadline.')),
    210_000,
  );
  const stop = () => lifetime.abort(new Error('Chrome smoke interrupted.'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let ownerOrigin = '';
  const ownerRequests = new Set();
  const receivedUploads = [];
  let uploadFailure;
  let journalVersion = 1;
  let journalRequests = 0;
  let recoverySubmissions = 0;
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
    if (request.url === '/recovery/submit' && request.method === 'POST') {
      recoverySubmissions++;
      // No Max-Age or Expires: this intentionally covers a session cookie,
      // independently of the existing persistent-cookie restart coverage.
      response.setHeader(
        'set-cookie',
        'loomRecoverySession=signed-in; Path=/; HttpOnly; SameSite=Strict',
      );
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ signedIn: true, submissions: recoverySubmissions }));
      return;
    }
    if (request.url === '/recovery/status') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          signedIn: (request.headers.cookie ?? '')
            .split('; ')
            .includes('loomRecoverySession=signed-in'),
          submissions: recoverySubmissions,
        }),
      );
      return;
    }
    if (
      request.method === 'POST' &&
      /^\/upload\/(?:direct|proxy|large|recovery)$/.test(request.url ?? '')
    ) {
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
    if (request.url === '/' || /^\/room-isolation\/[ab]$/.test(request.url ?? ''))
      response.end(fixturePage.replace('__OWNER_ORIGIN__', ownerOrigin));
    else if (request.url === '/next') response.end(nextPage);
    else if (request.url === '/recovery') response.end(recoveryPage);
    else if (request.url === '/journal') {
      journalRequests++;
      response.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Journal freshness fixture</title></head><body><h1>Journal version ${journalVersion}</h1></body></html>`,
      );
    } else {
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
  const isolatedBrowser = createBrowserControl({
    dataDir,
    profileDir: join(dataDir, 'browser-profiles', 'isolated-smoke'),
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
  const run = (command, uploads, credential) =>
    browser.execute(browser.prepare(command, uploads, credential), lifetime.signal);
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
    const initialChromePid = await ownedChromePid(uploadSessionRoot);

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
    assert.match(snapshot.text, /Navigator webdriver: false/);
    assert.match(snapshot.text, /Profile marker: absent; Cookie marker: absent/);

    mark('persist a profile marker using the page');
    await run({
      operation: 'click',
      pageId,
      stateId: readStateId(snapshot.text),
      uid: readUid(snapshot.text, 'button', 'Save profile marker'),
    });
    snapshot = await run({ operation: 'snapshot', pageId });
    assert.match(snapshot.text, /Profile marker: retained; Cookie marker: retained/);

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

    mark('replace controlled email values and verify actual validation and the next step');
    let previousInputEvents = 0;
    for (const [value, valid] of [
      ['first@fixture.invalid', true],
      ['second@fixture.invalid', true],
      ['second@fixture.invalid.more', true],
      ['not-an-email', false],
      ['', false],
      ['verified@fixture.invalid', true],
    ]) {
      await run({
        operation: 'fill',
        pageId,
        stateId: readStateId(snapshot.text),
        uid: readUid(snapshot.text, 'textbox', 'Email address'),
        text: value,
      });
      snapshot = await run({ operation: 'snapshot', pageId });
      const emailUid = readUid(snapshot.text, 'textbox', 'Email address');
      const emailLine = snapshot.text.split('\n').find((line) => line.includes(`uid=${emailUid} `));
      if (value)
        assert.ok(
          emailLine.includes(`value=${JSON.stringify(value)}`),
          'Fill must replace the entire email value.',
        );
      assert.ok(snapshot.text.includes(`Email length: ${value.length}`));
      assert.ok(snapshot.text.includes(`Email valid: ${valid}; Continue disabled: ${!valid}`));
      const continueUid = readUid(snapshot.text, 'button', 'Continue with email');
      const continueLine = snapshot.text
        .split('\n')
        .find((line) => line.includes(`uid=${continueUid} `));
      assert.equal(
        continueLine.includes('disabled=true'),
        !valid,
        'The real button disabled state must match validation.',
      );
      const inputEvents = Number(/Input events: (\d+)/.exec(snapshot.text)?.[1]);
      assert.ok(
        inputEvents > previousInputEvents,
        'Every changed value must update the app through an input event.',
      );
      previousInputEvents = inputEvents;
    }
    await run({
      operation: 'click',
      pageId,
      stateId: readStateId(snapshot.text),
      uid: readUid(snapshot.text, 'button', 'Continue with email'),
    });
    snapshot = await run({ operation: 'snapshot', pageId });
    assert.match(snapshot.text, /Email next step reached for verified@fixture\.invalid/);

    mark('replace password, multiline and rich-text fields with input events');
    for (const [name, value] of [
      ['Synthetic password', 'synthetic-new-password'],
      ['Multiline notes', 'First line\n日本語の二行目'],
      ['Rich draft', 'New rich draft'],
    ]) {
      await run({
        operation: 'fill',
        pageId,
        stateId: readStateId(snapshot.text),
        uid: readUid(snapshot.text, 'textbox', name),
        text: value,
      });
      snapshot = await run({ operation: 'snapshot', pageId });
    }
    assert.match(
      snapshot.text,
      /Password replacement accepted: true; Multiline replacement accepted: true; Rich replacement accepted: true/,
    );

    mark(
      'apply a saved credential from an independent working URL through the registered login origin',
    );
    const { createApp } = await import('../dist/server/app.js');
    const { prepareServiceBrowserCredential } =
      await import('../dist/server/runtime/service-browser.js');
    const credentialFixture = await createApp({
      dataDir: join(dataDir, 'credential-registry'),
      scheduler: false,
      runtimeFactory: () => ({
        start() {},
        async stop() {},
        async shutdown() {},
        queueState: () => ({ active: 0, waiting: 0 }),
      }),
    });
    try {
      const savedSecret = 'synthetic-saved-password';
      const service = credentialFixture.controller.saveServiceAccount({
        name: 'Synthetic separated authentication',
        url: 'https://working-page.example.invalid/app',
        loginUrl: origin,
        login: 'fixture@example.invalid',
        botId: 'bot_aster',
        roomId: 'room_lounge',
        sharedBotIds: ['bot_nova'],
        mailAccountId: null,
        status: 'active',
        notes: '',
        credential: savedSecret,
      });
      const preparedCredential = prepareServiceBrowserCredential(
        { host: credentialFixture.controller, task: { botId: 'bot_nova', roomId: 'room_lounge' } },
        { operation: 'fill', serviceId: service.id, expectedRevision: service.revision },
      );
      assert.equal(preparedCredential.binding.origin, origin);
      assert.notEqual(new URL(service.url).origin, origin);
      const savedBinding = preparedCredential.binding;
      const savedCommand = {
        operation: 'fill',
        pageId,
        stateId: readStateId(snapshot.text),
        uid: readUid(snapshot.text, 'textbox', 'Synthetic password'),
      };
      let wrongOriginResolved = false;
      assert.throws(
        () =>
          browser.prepare(savedCommand, undefined, {
            origin: new URL(service.url).origin,
            resolve: () => {
              wrongOriginResolved = true;
              return savedSecret;
            },
          }),
        /credential_origin_mismatch/,
      );
      assert.equal(
        wrongOriginResolved,
        false,
        'wrong destination is rejected before resolving a saved value',
      );
      const savedPlan = browser.prepare(savedCommand, undefined, savedBinding);
      assert.ok(!JSON.stringify(savedPlan).includes(savedSecret));
      const savedResult = await browser.execute(
        savedPlan,
        lifetime.signal,
        preparedCredential.assertCurrent,
      );
      assert.ok(!savedResult.text.includes(savedSecret));
      snapshot = await run({ operation: 'snapshot', pageId });
      assert.match(snapshot.text, /Saved credential accepted: true/);
      assert.ok(!snapshot.text.includes(savedSecret));
      await assert.rejects(
        run(
          {
            operation: 'fill',
            pageId,
            stateId: readStateId(snapshot.text),
            uid: readUid(snapshot.text, 'textbox', 'Email address'),
          },
          undefined,
          savedBinding,
        ),
        /password field|could not be verified/,
      );
      snapshot = await run({ operation: 'snapshot', pageId });
      assert.match(snapshot.text, /value="verified@fixture.invalid"/);
    } finally {
      await credentialFixture.app.close();
    }

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
    await uploadStorage.sweep();
    assert.ok(processAlive(initialChromePid));
    assert.ok(
      (await readdir(uploadSessionRoot)).some((name) => name.startsWith('files-')),
      'Issued upload copies must remain available while their Chrome is alive.',
    );

    mark('open an isolated profile and keep the first Chrome running');
    const priorSessions = new Set(await readdir(uploadParent));
    await isolatedBrowser.connect(lifetime.signal);
    const isolatedSessions = (await readdir(uploadParent)).filter(
      (name) => name.startsWith('session-') && !priorSessions.has(name),
    );
    assert.equal(isolatedSessions.length, 1);
    const isolatedChromePid = await ownedChromePid(join(uploadParent, isolatedSessions[0]));
    assert.notEqual(isolatedChromePid, initialChromePid);
    const isolatedRun = (command) =>
      isolatedBrowser.execute(isolatedBrowser.prepare(command), lifetime.signal);
    await isolatedRun({ operation: 'open', url: `${origin}/` });
    const isolatedTab = isolatedBrowser
      .status()
      .tabs.find((candidate) => candidate.url === `${origin}/`);
    assert.ok(isolatedTab);
    const isolatedSnapshot = await isolatedRun({
      operation: 'snapshot',
      pageId: isolatedTab.pageId,
    });
    assert.match(isolatedSnapshot.text, /Navigator webdriver: false/);
    assert.match(isolatedSnapshot.text, /Profile marker: absent; Cookie marker: absent/);
    await isolatedBrowser.disconnect();
    await until(
      () => !processAlive(isolatedChromePid),
      'the isolated Chrome to exit',
      lifetime.signal,
    );
    assert.ok(
      processAlive(initialChromePid),
      'Closing one profile must not close the other Chrome.',
    );

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
      () => !processAlive(initialChromePid),
      'the owned Chrome process to exit',
      lifetime.signal,
    );
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
    await run({ operation: 'open', url: `${origin}/` });
    const resumedTab = browser.status().tabs.find((candidate) => candidate.url === `${origin}/`);
    assert.ok(resumedTab);
    let resumedSnapshot = await run({ operation: 'snapshot', pageId: resumedTab.pageId });
    assert.match(resumedSnapshot.text, /Navigator webdriver: false/);
    assert.match(resumedSnapshot.text, /Profile marker: retained; Cookie marker: retained/);
    const resumedSessions = (await readdir(uploadParent)).filter((name) =>
      name.startsWith('session-'),
    );
    assert.equal(resumedSessions.length, 1);
    const resumedChromePid = await ownedChromePid(join(uploadParent, resumedSessions[0]));
    assert.notEqual(resumedChromePid, initialChromePid);

    mark('observe an owned Chrome exit, then explicitly reconnect its persistent profile');
    // This PID came from this session's verified ownership record, never discovery
    // of unrelated Chrome processes on the runner.
    process.kill(resumedChromePid, 'SIGTERM');
    await until(
      () => ['error', 'disconnected'].includes(browser.status().state),
      'Loom to observe the unexpected Chrome exit',
      lifetime.signal,
    );
    await until(
      () => !processAlive(resumedChromePid),
      'the terminated Chrome to exit',
      lifetime.signal,
    );
    await browser.connect(lifetime.signal);
    assert.equal(browser.status().state, 'connected');
    await run({ operation: 'open', url: `${origin}/` });
    const recoveredTab = browser.status().tabs.find((candidate) => candidate.url === `${origin}/`);
    assert.ok(recoveredTab);
    resumedSnapshot = await run({ operation: 'snapshot', pageId: recoveredTab.pageId });
    assert.match(resumedSnapshot.text, /Profile marker: retained; Cookie marker: retained/);
    mark('read fresh pages through the runtime journal after a work continuation');
    await checkRuntimeBrowserJournal({
      browser,
      dataDir,
      workspace,
      url: `${origin}/journal`,
      signal: lifetime.signal,
      nextVersion: () => journalVersion++,
      requestCount: () => journalRequests,
    });
    await browser.disconnect();
    assert.equal(browser.status().state, 'disconnected');
    mark('isolate the same bot across rooms through production routes and runtime browser tools');
    // The preceding browsers are closed before this check opens its two rooms.
    assert.equal(isolatedBrowser.status().state, 'disconnected');
    await checkRoomScopedBrowsers({ dataDir, origin, signal: lifetime.signal });
    mark('recover a timed-out observation and a dead MCP without losing the live login page');
    await checkBrowserRecovery({
      dataDir,
      origin,
      signal: lifetime.signal,
      submissionCount: () => recoverySubmissions,
      receivedUploads,
      uploadFailure: () => uploadFailure,
    });
    mark('rotate three autonomous room-and-bot requests through one Chrome slot');
    await checkAutonomousBrowserCapacity({ dataDir, origin, signal: lifetime.signal });
    console.log(
      `Real Chrome smoke passed: ordinary headed Chrome with navigator.webdriver=false, controlled email replacement/clearing with input events and actual validation/next-step UI, password/multiline/rich-text replacement, open, tabs, snapshot, click, JPEG (${bytes.length} bytes), multipart uploads with exact binary bytes and Japanese filenames, 100 MiB (${LARGE_UPLOAD_BYTES} bytes) under default limits with streamed byte/hash verification, immutable delayed submission, hidden-input chooser fallback, actual Chrome ownership and copy reclamation after process exit, simultaneous isolated profiles, persistent cookies/storage across normal and unexpected exit/reconnect, protected owner tab loading with bot access denied, fresh same-URL runtime opens after closing a tab and continuing work, exact-call recovery without new tabs or stale snapshots, same-bot room isolation through production HTTP routes and runtime tools with separate processes/tabs/cookies/storage, cross-room snapshot refusal, independent disconnect, same-PID recovery after an injected post-submit observation timeout and actual MCP process death with unchanged page identity/session cookie/sessionStorage and exactly one submission, selected upload bytes retained across both recoveries and reclaimed only after Chrome exit, autonomous FIFO room-and-bot capacity with safe checkpoints and persistent profile reuse, navigate, close, disconnect, and paused-state refusal.`,
    );
  } catch (error) {
    console.error(`Chrome smoke failed during: ${stage}`);
    console.error(JSON.stringify(browser.status(), null, 2));
    throw error;
  } finally {
    lifetime.abort();
    // Explicit shutdown closes each fixture's own guardian and Chrome.
    // Keep HTTP/profile cleanup in finally even when connection or shutdown fails.
    try {
      const shutdowns = await Promise.allSettled([browser.shutdown(), isolatedBrowser.shutdown()]);
      for (const result of shutdowns) if (result.status === 'rejected') throw result.reason;
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
