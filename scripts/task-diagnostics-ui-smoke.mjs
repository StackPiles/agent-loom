import assert from 'node:assert/strict';
import { join } from 'node:path';

// A disposable browser fixture: copies only synthetic task diagnostics into
// this isolated Chrome profile, without invoking a model or resuming a task.
export async function checkTaskDiagnostics({
  instance,
  page,
  origin,
  artifactDir,
  report,
  settle,
}) {
  const { taskInterruptionMessage } = await import('../dist/shared/task-interruption.js');
  const { store, controller } = instance;
  const roomId = 'room_lounge';
  const stamp = new Date().toISOString();
  const startedAt = new Date(Date.now() - 10_600).toISOString();
  const timeout =
    'The connection to the model server timed out after 10.6 seconds (UND_ERR_CONNECT_TIMEOUT). Check the model server address, network/proxy, and TLS connection. This request was not retried automatically.';
  const cases = [
    {
      id: 'ui_diagnostic_connection',
      status: 'failed',
      error: timeout,
      botId: 'bot_aster',
      title: 'Task failed',
    },
    {
      id: 'ui_diagnostic_supervisor',
      status: 'interrupted',
      error: taskInterruptionMessage('supervisor_disconnect'),
      botId: 'bot_nova',
      title: 'Task interrupted',
    },
    {
      id: 'ui_diagnostic_legacy',
      status: 'stopped',
      error:
        'Stopped. You can resume explicitly; completed side effects will not be replayed automatically.',
      botId: 'bot_orbit',
      title: 'Task stopped',
    },
  ];
  for (const entry of cases) {
    store.put('tasks', {
      ...entry,
      roomId,
      rootTaskId: entry.id,
      kind: 'chat',
      depth: 0,
      prompt: 'PRIVATE_PROMPT_NOT_FOR_DIAGNOSTICS',
      output: '途中までの応答を保持しています。',
      createdAt: startedAt,
      startedAt,
      updatedAt: stamp,
      completedAt: stamp,
      workspacePath: store.settings().workspacePath,
    });
    const message = controller.addMessage({
      roomId,
      taskId: entry.id,
      authorType: 'bot',
      authorId: entry.botId,
      body: '途中までの応答を保持しています。',
      reasoning: 'PRIVATE_REASONING_NOT_FOR_DIAGNOSTICS',
      reasoningStatus: 'interrupted',
      status: 'error',
    });
    entry.messageId = message.id;
    controller.addActivity({
      roomId,
      taskId: entry.id,
      botId: entry.botId,
      messageId: message.id,
      kind: 'status',
      title: entry.title,
      detail: entry.error,
      status: 'error',
    });
  }
  controller.changed();
  const run = (entry) => `[data-run-message-id="${entry.messageId}"]`;
  const panel = (entry) => `${run(entry)} [data-task-diagnostics="current"]`;
  report.taskDiagnostics = { views: {}, checks: [] };

  await page.setViewport({ width: 1416, height: 900, deviceScaleFactor: 1 });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  for (const entry of cases) {
    await page.waitForSelector(panel(entry), { visible: true });
    assert.equal(
      await page.$eval(`${panel(entry)} [data-task-error]`, (element) => element.textContent),
      entry.error,
      'the originating error remains readable alongside its explanation',
    );
  }
  assert.equal(
    await page.$eval(panel(cases[2]), (element) => element.dataset.taskErrorReason),
    'unknown',
    'legacy cause is not invented',
  );
  assert.equal(
    await page.$eval(panel(cases[0]), (element) => element.dataset.taskErrorReason),
    'connect_timeout',
  );
  assert.equal(
    await page.$eval(panel(cases[1]), (element) => element.dataset.taskErrorReason),
    'supervisor_disconnect',
  );

  const capture = async (entry, name) => {
    await page.$eval(panel(entry), (element) =>
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
    );
    await settle();
    const metrics = await page.$eval(panel(entry), (element) => {
      const bounds = (node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      return {
        width: innerWidth,
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        panel: bounds(element),
        copy: bounds(element.querySelector('[data-copy-task-diagnostics]')),
        error: bounds(element.querySelector('[data-task-error]')),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      };
    });
    assert.ok(metrics.documentWidth <= metrics.width + 1, name + ': no page overflow');
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, name + ': no panel overflow');
    for (const box of [metrics.panel, metrics.copy, metrics.error]) {
      assert.ok(box.width > 0 && box.height > 0, name + ': controls have visible dimensions');
      assert.ok(
        box.x >= -1 && box.x + box.width <= metrics.width + 1,
        name + ': horizontal bounds',
      );
    }
    report.taskDiagnostics.views[name] = metrics;
    await page.screenshot({ path: join(artifactDir, name + '.png') });
  };

  await capture(cases[0], 'task-timeout-desktop-1416x900');
  await capture(cases[1], 'task-interruption-desktop-1416x900');
  await page.bringToFront();
  // Puppeteer's clipboard-write maps to clipboardReadWrite, not the separate
  // clipboardSanitizedWrite permission used by writeText(). Unlisted grants
  // are denied by this override, even for a user-initiated click.
  await page
    .browserContext()
    .overridePermissions(origin, [
      'clipboard-read',
      'clipboard-write',
      'clipboard-sanitized-write',
    ]);
  const clipboardPermissions = await page.evaluate(async () => ({
    secureContext: window.isSecureContext,
    focused: document.hasFocus(),
    canRead: typeof navigator.clipboard?.readText === 'function',
    canWrite: typeof navigator.clipboard?.writeText === 'function',
    read: (await navigator.permissions.query({ name: 'clipboard-read' })).state,
    write: (await navigator.permissions.query({ name: 'clipboard-write' })).state,
  }));
  report.taskDiagnostics.clipboard = { permissions: clipboardPermissions };
  assert.deepEqual(
    clipboardPermissions,
    {
      secureContext: true,
      focused: true,
      canRead: true,
      canWrite: true,
      read: 'granted',
      write: 'granted',
    },
    'the focused Chrome fixture must allow real text clipboard reads and writes',
  );
  await page.$eval(`${panel(cases[0])} [data-copy-task-diagnostics]`, (element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await page.click(`${panel(cases[0])} [data-copy-task-diagnostics]`);
  await page.waitForFunction(
    (selector) => {
      const element = document.querySelector(selector);
      return (
        element?.querySelector('.run-diagnostic-copy-status') ||
        element
          ?.querySelector('[data-copy-task-diagnostics]')
          ?.textContent?.includes('コピーしました')
      );
    },
    {},
    panel(cases[0]),
  );
  const copyState = await page.$eval(panel(cases[0]), (element) => ({
    button: element.querySelector('[data-copy-task-diagnostics]')?.textContent?.trim(),
    error: element.querySelector('.run-diagnostic-copy-status')?.textContent?.trim() || '',
  }));
  report.taskDiagnostics.clipboard.copyState = copyState;
  assert.equal(copyState.error, '', 'diagnostic clipboard write must succeed without fallback');
  assert.equal(copyState.button, 'コピーしました', 'the UI must confirm the clipboard write');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(copied.includes(cases[0].id), 'clipboard text belongs to the selected task');
  assert.ok(copied.includes(timeout));
  assert.equal(copied.includes('PRIVATE_PROMPT'), false);
  assert.equal(copied.includes('PRIVATE_REASONING'), false);

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await capture(cases[0], 'task-timeout-mobile-390x844');
  await capture(cases[1], 'task-interruption-mobile-390x844');
  // HTTP LAN contexts may not expose the Clipboard API. The same UI must
  // reveal selectable details when clipboard access is unavailable.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  });
  await page.$eval(`${panel(cases[0])} [data-copy-task-diagnostics]`, (element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await page.click(`${panel(cases[0])} [data-copy-task-diagnostics]`);
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.open === true,
    {},
    `${panel(cases[0])} [data-task-diagnostic-details]`,
  );
  const fallback = await page.$eval(
    `${panel(cases[0])} [data-task-diagnostic-text]`,
    (element) => element.textContent,
  );
  assert.ok(fallback.includes(cases[0].id));
  assert.ok(fallback.includes(timeout));
  assert.equal(fallback.includes('PRIVATE_PROMPT'), false);
  assert.equal(fallback.includes('PRIVATE_REASONING'), false);
  await capture(cases[0], 'task-timeout-details-mobile-390x844');
  report.taskDiagnostics.checks.push(
    'current timeout, supervisor interruption and unknown legacy causes preserve the exact error',
    'desktop and mobile errors and copy controls remain inside the viewport width',
    'real Clipboard API receives only the selected task diagnostics',
    'unavailable clipboard reveals selectable details without copying prompts or reasoning',
  );
}
