import assert from 'node:assert/strict';
import { join } from 'node:path';

// Uses a disposable room and the real archive API. The surrounding smoke app
// disables the scheduler and supplies a local runtime; history must not start it.
export async function checkTaskHistory({ instance, page, origin, artifactDir, report, settle }) {
  const { store, controller } = instance;
  const roomId = 'ui_task_history_room';
  const roomName = '停止した作業と履歴の整理';
  const primaryId = 'ui_task_history_primary';
  const secondaryId = 'ui_task_history_secondary';
  const interruptedId = 'ui_task_history_interrupted';
  const outputId = 'ui_task_history_output';
  const activeId = 'ui_task_history_active';
  const workId = 'ui_task_history_work';
  const wakeupId = 'ui_task_history_wakeup';
  const taskIds = [primaryId, secondaryId, interruptedId, outputId, activeId];
  const reviewIds = [primaryId, secondaryId, interruptedId];
  const stamp = new Date().toISOString();
  const originalPrompt = [
    '公開済みの資料を読み、確認できた内容をまとめてください。',
    'この作業への当初の指示は、履歴へ移した後も保存します。',
    '資料：https://example.test/reports/' + 'saved-request-'.repeat(15),
  ].join('\n');
  const originalError =
    '保存済みのエラー：接続が中断しました。記録の整理では、この作業を再実行しません。';
  const outputText =
    '登録結果を確認しました。この部分的な回答は、タスクを履歴へ移しても会話に残します。';
  const history = `[data-task-history="${roomId}"]`;
  const reviewAction = `[data-task-review-list="${roomId}"]`;
  const historyAction = `[data-task-history-open="${roomId}"]`;
  const details = `[data-task-details="${primaryId}"]`;
  const endpoint = `${origin}/api/tasks/archive`;
  const resumeRequests = [];
  const starts = [];
  const runtime = controller.runtime;
  const originalStart = runtime.start;
  const messageIds = [];
  let message;
  report.taskHistory = { views: {}, checks: [] };
  const recordRequest = (request) => {
    if (request.method() === 'POST' && /\/api\/tasks\/[^/]+\/resume$/.test(request.url()))
      resumeRequests.push(request.url());
  };
  const click = async (selector) => {
    await page.waitForSelector(selector, { visible: true });
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.disabled === false,
      {},
      selector,
    );
    await page.locator(selector).setVisibility('visible').click();
  };
  const keyboardOpen = async (selector, target) => {
    await page.waitForSelector(selector, { visible: true });
    await page.$eval(selector, (element) => {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      element.closest('.message-scroll')?.dispatchEvent(new Event('scroll'));
    });
    await page.focus(selector);
    await page.keyboard.press('Enter');
    await page.waitForSelector(target, { visible: true });
  };
  const openRoom = async (width, height) => {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const handle = await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('.room-nav button')].find(
          (element) => element.querySelector('.room-nav-name')?.textContent === name,
        ),
      {},
      roomName,
    );
    const roomButton = handle.asElement();
    assert.ok(roomButton);
    try {
      if (await page.$('#loom-navigation[aria-hidden="true"]'))
        await page.click('button[aria-label="メニューを開く"]');
      await roomButton.evaluate((element) =>
        element.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
      await page.waitForFunction(
        (element) => {
          const nav = element.closest('#loom-navigation');
          if (
            nav?.inert ||
            nav?.getAttribute('aria-hidden') === 'true' ||
            nav?.getBoundingClientRect().left < -1
          )
            return false;
          const rect = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
          );
        },
        {},
        roomButton,
      );
      await roomButton.click();
    } finally {
      await handle.dispose();
    }
    await page.waitForFunction(
      (name) => document.querySelector('.room-heading h1')?.textContent === name,
      {},
      roomName,
    );
    await page.waitForFunction(() => {
      const nav = document.querySelector('#loom-navigation');
      return (
        !document.querySelector('.sidebar-scrim') &&
        !document.querySelector('.workspace-main')?.inert &&
        (innerWidth > 850 || nav?.getBoundingClientRect().right <= 0)
      );
    });
  };
  const rowIds = () =>
    page.$$eval(`${history} [data-history-task-id]`, (elements) =>
      elements.map((element) => element.dataset.historyTaskId).sort(),
    );
  const waitRows = async (ids) =>
    page.waitForFunction(
      (selector, expected) =>
        JSON.stringify(
          [...document.querySelectorAll(`${selector} [data-history-task-id]`)]
            .map((element) => element.dataset.historyTaskId)
            .sort(),
        ) === JSON.stringify(expected),
      {},
      history,
      [...ids].sort(),
    );
  const change = async (selector, ids, archived) => {
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.disabled === false,
      {},
      selector,
    );
    const response = page.waitForResponse(
      (response) => response.url() === endpoint && response.request().method() === 'POST',
    );
    await click(selector);
    const result = await response;
    assert.equal(result.status(), 200, 'the real history mutation succeeds');
    const body = JSON.parse(result.request().postData());
    assert.deepEqual(
      { ...body, taskIds: [...body.taskIds].sort() },
      { roomId, taskIds: [...ids].sort(), archived },
    );
    for (const id of ids) assert.equal(Boolean(store.get('tasks', id).archivedAt), archived);
  };
  const capture = async (name, selector, focus = selector) => {
    await page.$eval(focus, (element) =>
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
    );
    await settle();
    const metrics = await page.$eval(
      selector,
      (element, focusSelector) => {
        const box = (node) => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        };
        const focus = document.querySelector(focusSelector);
        return {
          viewport: { width: innerWidth, height: innerHeight },
          documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          region: box(element),
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          focus: box(focus),
          fontFamily: getComputedStyle(focus).fontFamily,
          controls: [
            ...element.querySelectorAll(
              'button, input, pre, time, .task-history-prompt, .task-history-error-preview',
            ),
          ]
            .filter((node) => node.getClientRects().length)
            .map(box),
        };
      },
      focus,
    );
    report.taskHistory.views[name] = metrics;
    await page.screenshot({ path: join(artifactDir, `${name}.png`) });
    assert.ok(metrics.documentWidth <= metrics.viewport.width + 1, `${name}: no page overflow`);
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${name}: no content overflow`);
    assert.ok(
      metrics.focus.height > 0 &&
        metrics.focus.y < metrics.viewport.height &&
        metrics.focus.y + metrics.focus.height > 0,
      `${name}: the inspected text is visible`,
    );
    for (const bounds of [metrics.region, ...metrics.controls]) {
      assert.ok(bounds.width > 0 && bounds.height > 0, `${name}: positive dimensions`);
      assert.ok(
        bounds.x >= -1 && bounds.x + bounds.width <= metrics.viewport.width + 1,
        `${name}: controls remain within horizontal bounds`,
      );
    }
  };
  const closeHistory = async () => {
    await page.keyboard.press('Escape');
    await page.waitForSelector(history, { hidden: true });
  };
  const stripArchive = ({ archivedAt: _archivedAt, ...task }) => task;

  page.on('request', recordRequest);
  runtime.start = function (task, ...args) {
    starts.push(task.id);
    return originalStart.call(this, task, ...args);
  };
  try {
    store.put('rooms', {
      id: roomId,
      name: roomName,
      description: 'Disposable history visibility fixture.',
      botIds: ['bot_aster'],
      autonomousWakeups: {
        mode: 'room',
        minIntervalMinutes: 5,
        maxPendingWakeups: 24,
        maxRunsPerHour: 12,
      },
      parallelResponses: false,
      paused: false,
      pinned: false,
      archived: false,
      createdAt: stamp,
      updatedAt: stamp,
    });
    const workspacePath = controller.roomWorkspacePath(roomId);
    const makeTask = (id, status) => ({
      id,
      roomId,
      botId: 'bot_aster',
      rootTaskId: id,
      depth: 0,
      kind: 'automation',
      status,
      prompt: originalPrompt,
      output: id === outputId ? outputText : '',
      error: originalError,
      workspacePath,
      inputTokens: 10,
      outputTokens: 5,
      createdAt: stamp,
      startedAt: stamp,
      updatedAt: stamp,
      ...(status === 'running' ? {} : { completedAt: stamp }),
    });
    for (const [id, status] of [
      [primaryId, 'failed'],
      [secondaryId, 'stopped'],
      [interruptedId, 'interrupted'],
      [outputId, 'failed'],
      [activeId, 'running'],
    ])
      store.put('tasks', {
        ...makeTask(id, status),
        ...(id === primaryId ? { workId, workRunId: 'ui_task_history_run', wakeupId } : {}),
      });
    store.put('workItems', {
      id: workId,
      roomId,
      name: '資料登録後の確認',
      purpose: '登録結果と公開審査を記録します。',
      kind: 'task',
      status: 'blocked',
      createdByBotId: 'bot_aster',
      sourceTaskId: primaryId,
      scope: 'Disposable history visibility fixture.',
      workspacePath,
      revision: 2,
      createdAt: stamp,
      updatedAt: stamp,
      checkpoint: {
        summary: '資料は登録済みです。次の予約で公開審査の結果を確認します。',
        completed: '登録内容と資料IDを確認しました。',
        nextStep: '審査結果を確認します。',
        references: ['reports/receipt.md'],
        doneWhen: '公開審査の結果が記録されていること。',
        pendingChecks: ['公開審査の結果待ち。'],
        uncertainActions: [],
      },
    });
    const nextRunAt = new Date(
      Math.floor((Date.now() + 86_400_000) / 60_000) * 60_000,
    ).toISOString();
    store.put('wakeups', {
      id: wakeupId,
      roomId,
      workId,
      workRunId: 'ui_task_history_run',
      botId: 'bot_aster',
      createdByBotId: 'bot_aster',
      sourceTaskId: primaryId,
      key: 'history-review',
      reason: '公開審査の結果を次回確認します。',
      prompt: '次回予約の指示は、当初の指示とは別の記録です。',
      schedule: {
        type: 'once',
        dateTime: new Date(Date.parse(nextRunAt) + 9 * 3_600_000).toISOString().slice(0, 16),
        timeZone: 'Asia/Tokyo',
        missedRunPolicy: 'run_once',
      },
      status: 'scheduled',
      nextRunAt,
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
    });
    message = controller.addMessage({
      roomId,
      taskId: outputId,
      authorType: 'bot',
      authorId: 'bot_aster',
      body: outputText,
      status: 'error',
    });
    messageIds.push(message.id);
    const originalTasks = new Map(taskIds.map((id) => [id, store.get('tasks', id)]));
    const originalWork = store.get('workItems', workId);
    const originalWakeup = store.get('wakeups', wakeupId);
    const originalMessage = store.get('messages', message.id);
    const unchanged = () => {
      for (const id of taskIds)
        assert.deepEqual(
          stripArchive(store.get('tasks', id)),
          originalTasks.get(id),
          `${id}: only archivedAt may change`,
        );
      assert.deepEqual(store.get('workItems', workId), originalWork);
      assert.deepEqual(store.get('wakeups', wakeupId), originalWakeup);
      assert.deepEqual(store.get('messages', message.id), originalMessage);
      assert.deepEqual(resumeRequests, [], 'history never sends a task-resume request');
      assert.deepEqual(starts, [], 'history never starts the runtime');
    };
    controller.changed();

    await openRoom(1416, 900);
    await keyboardOpen(reviewAction, history);
    assert.equal(await page.$eval(history, (element) => element.dataset.historyMode), 'review');
    assert.deepEqual(await rowIds(), [...reviewIds].sort());
    await capture(
      'task-history-desktop-1416x900',
      history,
      `${history} [data-history-task-id="${primaryId}"]`,
    );
    await closeHistory();
    assert.equal(
      await page.$eval(reviewAction, (element) => document.activeElement === element),
      true,
      'Escape restores the history trigger focus',
    );
    await change(`.standalone-runs [data-task-archive-action="${primaryId}"]`, [primaryId], true);
    await page.waitForSelector(`.standalone-runs [data-task-id="${primaryId}"]`, { hidden: true });
    await change(
      `[data-message-id="${message.id}"] [data-task-archive-action="${outputId}"]`,
      [outputId],
      true,
    );
    await page.waitForSelector(
      `[data-message-id="${message.id}"] [data-task-restore-action="${outputId}"]`,
      { visible: true },
    );
    unchanged();

    // A fresh page must reconstruct history from the real persisted store.
    await openRoom(390, 844);
    assert.equal(await page.$(`.standalone-runs [data-task-id="${primaryId}"]`), null);
    assert.ok(
      await page.$(`.standalone-runs [data-task-id="${activeId}"]`),
      'active tasks remain visible',
    );
    const preservedText = await page.$eval(
      `[data-message-id="${message.id}"]`,
      (element) => element.textContent,
    );
    assert.ok(preservedText.includes(outputText));
    assert.ok(preservedText.includes(originalError));
    await keyboardOpen(historyAction, history);
    assert.equal(await page.$eval(history, (element) => element.dataset.historyMode), 'archived');
    assert.deepEqual(await rowIds(), [primaryId, outputId].sort());
    await capture(
      'task-history-mobile-390x844',
      history,
      `${history} [data-history-task-id="${primaryId}"]`,
    );
    const detailAction = `${history} [data-task-details-action="${primaryId}"]`;
    await keyboardOpen(detailAction, details);
    assert.equal(await page.$$eval('dialog[open]', (elements) => elements.length), 2);
    const originalSelector = `${details} [data-task-original-prompt]`;
    assert.equal(
      await page.$eval(originalSelector, (element) => element.textContent),
      originalPrompt,
    );
    assert.ok(
      (await page.$eval(details, (element) => element.textContent)).includes(originalError),
    );
    assert.equal(
      await page.$(`${details} [data-task-resume-action]`),
      null,
      'an archived task must first be restored',
    );
    await capture('task-history-details-mobile-390x844', details, originalSelector);
    await page.keyboard.press('Escape');
    await page.waitForSelector(details, { hidden: true });
    assert.equal(await page.$$eval('dialog[open]', (elements) => elements.length), 1);
    assert.equal(
      await page.$eval(detailAction, (element) => document.activeElement === element),
      true,
      'nested details close back to their history row',
    );
    await keyboardOpen(detailAction, details);
    const resultHandle = await page.evaluateHandle(
      (selector) =>
        [...document.querySelector(selector).querySelectorAll('button')].find(
          (button) => button.textContent.trim() === 'ルームで結果を見る',
        ),
      details,
    );
    const resultAction = resultHandle.asElement();
    assert.ok(resultAction);
    try {
      await resultAction.click();
    } finally {
      await resultHandle.dispose();
    }
    await page.waitForSelector('dialog', { hidden: true });
    assert.equal(
      await page.$eval('.room-heading h1', (element) => element.textContent),
      roomName,
      'viewing room results closes both history and details',
    );
    await keyboardOpen(historyAction, history);
    await click(`${history} [data-task-history-select="${primaryId}"]`);
    await change(`${history} [data-task-history-apply]`, [primaryId], false);
    await waitRows([outputId]);
    unchanged();
    await closeHistory();

    await keyboardOpen(reviewAction, history);
    await waitRows(reviewIds);
    await click(`${history} [data-task-select-visible]`);
    await change(`${history} [data-task-history-apply]`, reviewIds, true);
    await waitRows([]);
    assert.equal(
      await page.$eval(history, (element) => element.dataset.historyMode),
      'review',
      'bulk archive keeps the review dialog open',
    );
    await closeHistory();
    await keyboardOpen(historyAction, history);
    const allArchived = [...reviewIds, outputId];
    await waitRows(allArchived);
    await click(`${history} [data-task-select-visible]`);
    await change(`${history} [data-task-history-apply]`, allArchived, false);
    await waitRows([]);
    await closeHistory();
    unchanged();
    assert.ok(await page.$(`.standalone-runs [data-task-id="${primaryId}"]`));
    assert.ok(
      (
        await page.$eval(`[data-message-id="${message.id}"]`, (element) => element.textContent)
      ).includes(outputText),
    );
    report.taskHistory.checks.push(
      'single archive persists across reload and removes only standalone historical tasks, while the original message and error remain',
      'history details retain the exact original instruction and error; nested Escape restores row focus and room-results navigation closes both dialogs',
      'single restore and visible-row bulk archive/restore use the real API and preserve task state, timestamps, linked work and wake-ups',
      'archive and restore never send a task-resume request or start the model runtime',
      'desktop and 390px mobile history and details remain within horizontal bounds',
    );
    report.checks.push(...report.taskHistory.checks);
  } catch (error) {
    if (!page.isClosed())
      await page
        .screenshot({ path: join(artifactDir, 'task-history-failure.png') })
        .catch(() => {});
    throw error;
  } finally {
    page.off('request', recordRequest);
    runtime.start = originalStart;
    for (const id of messageIds) store.remove('messages', id);
    for (const activity of store.list('activities'))
      if (taskIds.includes(activity.taskId)) store.remove('activities', activity.id);
    for (const id of taskIds) store.remove('tasks', id);
    store.remove('wakeups', wakeupId);
    store.remove('workItems', workId);
    store.remove('rooms', roomId);
    controller.changed();
    if (!page.isClosed())
      await page.evaluate(() => localStorage.setItem('loom.room', 'room_lounge')).catch(() => {});
  }
}
