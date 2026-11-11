import assert from 'node:assert/strict';
import { join } from 'node:path';

// A disposable stopped-task fixture. Review and work-resume use the real API,
// but no task-resume control is clicked and no model or external action runs.
export async function checkTaskRecovery({ instance, page, origin, artifactDir, report, settle }) {
  const { store, controller } = instance;
  const roomId = 'ui_task_recovery_room';
  const roomName = '停止した作業の内容確認';
  const taskId = 'ui_task_recovery_task';
  const workId = 'ui_task_recovery_work';
  const unrelatedWorkId = 'ui_task_recovery_unrelated_work';
  const stamp = new Date().toISOString();
  const originalPrompt = [
    '資料の登録前に、公開条件と保存内容を確認してください。',
    '作成時点の状況：登録はまだ行っていません。',
    '当初の参考資料：https://example.test/research/' + 'original-request-'.repeat(18),
  ].join('\n');
  const currentSummary = '現在は資料の登録まで完了し、公開審査の結果を待っています。';
  const pendingChecks = ['次の起床で公開審査の結果を確認してください。'];
  const details = `[data-task-details="${taskId}"]`;
  const card = `${details} [data-work-id="${workId}"]`;
  const prompt = `${details} [data-task-original-prompt]`;
  const taskResume = `${details} [data-task-resume-action="${taskId}"]`;
  const review = '.autonomous-work-review';
  const resumeRequests = [];
  const messageIds = [];
  const recordRequest = (request) => {
    if (request.method() === 'POST' && request.url() === `${origin}/api/tasks/${taskId}/resume`)
      resumeRequests.push(request.url());
  };
  report.taskRecovery = { views: {}, checks: [] };

  const button = async (scope, label) => {
    const handle = await page.evaluateHandle(
      (scope, label) =>
        [...(document.querySelector(scope)?.querySelectorAll('button') || [])].find(
          (element) =>
            element.textContent.trim() === label || element.getAttribute('aria-label') === label,
        ),
      scope,
      label,
    );
    const element = handle.asElement();
    assert.ok(element, `Missing button: ${label}`);
    return element;
  };
  const click = async (scope, label) => {
    const element = await button(scope, label);
    try {
      // Snapshot rendering can precede the event stream's connected state.
      await page.waitForFunction(
        (element) => element.isConnected && !element.disabled,
        {},
        element,
      );
      await element.click();
    } finally {
      await element.dispose();
    }
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
    assert.ok(roomButton, 'the recovery fixture room is present');
    try {
      if (await page.$('#loom-navigation[aria-hidden="true"]'))
        await page.click('button[aria-label="メニューを開く"]');
      await roomButton.evaluate((element) =>
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
      );
      await page.waitForFunction(
        (element) => {
          const navigation = element.closest('#loom-navigation');
          if (
            navigation?.inert ||
            navigation?.getAttribute('aria-hidden') === 'true' ||
            navigation?.getBoundingClientRect().left < -1
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
      const navigation = document.querySelector('#loom-navigation');
      return (
        !document.querySelector('.sidebar-scrim') &&
        !document.querySelector('.workspace-main')?.inert &&
        (innerWidth > 850 || navigation?.getBoundingClientRect().right <= 0)
      );
    });
  };
  const openDetails = async (action) => {
    await page.waitForSelector(action, { visible: true });
    await page.$eval(action, (element) => {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      element.closest('.message-scroll')?.dispatchEvent(new Event('scroll'));
    });
    await page.focus(action);
    await page.keyboard.press('Enter');
    await page.waitForSelector(details, { visible: true });
    await page.waitForSelector(card, { visible: true });
    assert.deepEqual(
      await page.$$eval(`${details} [data-work-id]`, (elements) =>
        elements.map((element) => element.dataset.workId),
      ),
      [workId],
      'the task opens exactly its own work, not every work item in the room',
    );
    const closedPrompt = await page.evaluateHandle((selector) => {
      const detail = document.querySelector(selector)?.closest('details');
      return detail && !detail.open ? detail.querySelector('summary') : null;
    }, prompt);
    try {
      await closedPrompt.asElement()?.click();
    } finally {
      await closedPrompt.dispose();
    }
    assert.equal(await page.$eval(prompt, (element) => element.textContent), originalPrompt);
    assert.match(
      await page.$eval(details, (element) => element.textContent),
      /この作業への当初の指示/,
    );
    assert.match(await page.$eval(details, (element) => element.textContent), /仕事の現在の状況/);
    assert.match(
      await page.$eval(card, (element) => element.textContent),
      new RegExp(currentSummary),
    );
    assert.doesNotMatch(
      await page.$eval(card, (element) => element.textContent),
      /作成時点の状況：登録はまだ行っていません/,
      'the current checkpoint is not replaced by the old instruction',
    );
  };
  const capture = async (name, selector, focus = selector) => {
    await page.$eval(focus, (element) =>
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
    );
    await settle();
    const metrics = await page.$eval(
      selector,
      (element, focusSelector) => {
        const bounds = (node) => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        };
        const focus = document.querySelector(focusSelector);
        const focused = bounds(focus);
        return {
          viewport: { width: innerWidth, height: innerHeight },
          documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          region: bounds(element),
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          focus: focused,
          focusVisible: focused.y < innerHeight && focused.y + focused.height > 0,
          fontFamily: getComputedStyle(focus).fontFamily,
          controls: [
            ...element.querySelectorAll(
              'h3, pre, dd, summary, button, textarea, input, .autonomous-work-status',
            ),
          ]
            .filter((node) => node.getClientRects().length)
            .map((node) => ({ tag: node.tagName, ...bounds(node) })),
        };
      },
      focus,
    );
    report.taskRecovery.views[name] = metrics;
    await page.screenshot({ path: join(artifactDir, `${name}.png`) });
    assert.ok(metrics.documentWidth <= metrics.viewport.width + 1, `${name}: no page overflow`);
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${name}: no content overflow`);
    assert.ok(metrics.focusVisible, `${name}: the inspected Japanese content is in view`);
    for (const bounds of [metrics.region, ...metrics.controls]) {
      assert.ok(bounds.width > 0 && bounds.height > 0, `${name}: positive dimensions`);
      assert.ok(
        bounds.x >= -1 && bounds.x + bounds.width <= metrics.viewport.width + 1,
        `${name}: content remains within horizontal bounds`,
      );
    }
  };
  const assertTaskUnchanged = (task) => {
    assert.deepEqual(store.get('tasks', taskId), task, 'work review does not resume the old task');
    assert.deepEqual(resumeRequests, [], 'no task-resume request was sent');
  };
  const resumeWork = async (scope, label) => {
    const response = page.waitForResponse(
      (response) =>
        response.url() === `${origin}/api/work-items/${workId}/resume` &&
        response.request().method() === 'POST',
    );
    await click(scope, label);
    assert.equal((await response).status(), 200, 'only the linked work is resumed');
    await page.waitForSelector(taskResume, { visible: true });
    assert.equal(store.get('workItems', workId).status, 'active');
  };
  const setReviewField = async (label, value) => {
    const handle = await page.evaluateHandle((label) => {
      const field = [...document.querySelectorAll('.autonomous-work-review label.field')].find(
        (element) => element.querySelector('.field-label')?.textContent === label,
      );
      return field?.querySelector('textarea');
    }, label);
    const field = handle.asElement();
    assert.ok(field, `Missing review field: ${label}`);
    try {
      await field.click();
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.sendCharacter(value);
    } finally {
      await handle.dispose();
    }
  };

  page.on('request', recordRequest);
  try {
    store.put('rooms', {
      id: roomId,
      name: roomName,
      description: 'Synthetic stopped-task navigation and work-review fixture.',
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
    const task = store.put('tasks', {
      id: taskId,
      roomId,
      botId: 'bot_aster',
      rootTaskId: taskId,
      workId,
      workRunId: 'ui_task_recovery_run',
      depth: 0,
      kind: 'automation',
      status: 'failed',
      prompt: originalPrompt,
      output: '登録結果の確認を別の作業へ引き継ぎました。',
      error: 'Synthetic fixture: connection interrupted after the saved report.',
      workspacePath,
      inputTokens: 10,
      outputTokens: 5,
      createdAt: stamp,
      startedAt: stamp,
      updatedAt: stamp,
      completedAt: stamp,
    });
    const work = store.put('workItems', {
      id: workId,
      roomId,
      name: '資料登録の結果確認と公開審査の追跡',
      purpose: '既存の登録結果を確認し、二重登録せずに審査結果を記録します。',
      kind: 'task',
      status: 'blocked',
      createdByBotId: 'bot_aster',
      sourceTaskId: taskId,
      scope: 'Synthetic work recovery.',
      workspacePath,
      checkpoint: {
        summary: currentSummary,
        completed: '登録済みの資料IDと保存内容を確認しました。',
        nextStep: '残っている公開審査の結果を確認します。',
        references: ['research/registration-result.md'],
        doneWhen: '公開審査の結果を記録したら、この仕事は完了です。',
        pendingChecks,
        uncertainActions: [],
      },
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
    });
    store.put('workItems', {
      ...work,
      id: unrelatedWorkId,
      name: '同じルームにある無関係な仕事',
      status: 'active',
    });
    const message = controller.addMessage({
      roomId,
      taskId,
      authorType: 'bot',
      authorId: 'bot_aster',
      body: task.output,
      status: 'error',
    });
    messageIds.push(message.id);
    controller.changed();
    const runAction = `[data-run-message-id="${message.id}"] [data-task-details-action="${taskId}"]`;
    const activityAction = `.room-activity [data-task-details-action="${taskId}"]`;

    await openRoom(1416, 900);
    await openDetails(runAction);
    assert.equal(await page.$(taskResume), null, 'blocked work has no task-resume control');
    await capture('task-recovery-desktop-1416x900', details, prompt);
    await resumeWork(card, '仕事を再開');
    assertTaskUnchanged(task);
    await page.keyboard.press('Escape');
    await page.waitForSelector(details, { hidden: true });
    assert.equal(
      await page.$eval(runAction, (element) => document.activeElement === element),
      true,
      'closing task details restores the original task action focus',
    );

    store.patch('workItems', workId, {
      status: 'blocked',
      checkpoint: {
        ...work.checkpoint,
        uncertainActions: ['公開設定の更新を送信しましたが、保存結果はまだ確認できていません。'],
      },
      revision: store.get('workItems', workId).revision + 1,
      updatedAt: new Date().toISOString(),
    });
    controller.changed();
    await openRoom(390, 844);
    await openDetails(runAction);
    assert.equal(await page.$(taskResume), null);
    await capture('task-recovery-mobile-390x844', details, prompt);
    await capture('task-recovery-work-mobile-390x844', details, `${card} h3`);
    await click(card, '確認して再開');
    await page.waitForSelector(review, { visible: true });
    assert.equal(await page.$$eval('dialog[open]', (elements) => elements.length), 2);
    // The previous-state label lives in a closed details element. Capture the
    // first required textarea: the visible field for the newly reviewed result.
    await capture('task-recovery-review-mobile-390x844', review, `${review} textarea[required]`);
    await page.keyboard.press('Escape');
    await page.waitForSelector(review, { hidden: true });
    assert.equal(await page.$$eval('dialog[open]', (elements) => elements.length), 1);
    assert.equal(
      await page.$eval(
        card,
        (element) =>
          element.contains(document.activeElement) &&
          document.activeElement.textContent.trim() === '確認して再開',
      ),
      true,
      'Escape closes only outcome review and returns focus to its work action',
    );
    assert.equal(store.get('workItems', workId).status, 'blocked');
    await click(card, '確認して再開');
    await page.waitForSelector(review, { visible: true });
    const submit = `${review} button[type="submit"]`;
    assert.equal(await page.$eval(submit, (element) => element.disabled), true);
    await setReviewField('確認した結果', '公開設定は保存済みでした。追加の送信は必要ありません。');
    await setReviewField('次に行うこと', '公開審査の結果だけを確認します。');
    assert.equal(await page.$eval(submit, (element) => element.disabled), true);
    await page.click(`${review} .autonomous-work-review-confirm input`);
    await resumeWork(review, '確認を記録して再開');
    await page.waitForSelector(review, { hidden: true });
    assert.equal(await page.$$eval('dialog[open]', (elements) => elements.length), 1);
    assertTaskUnchanged(task);
    const reviewed = store.get('workItems', workId);
    assert.deepEqual(reviewed.checkpoint.uncertainActions, []);
    assert.deepEqual(reviewed.checkpoint.pendingChecks, pendingChecks);
    assert.ok(reviewed.checkpoint.summary.startsWith(currentSummary));
    assert.equal(await page.$eval(prompt, (element) => element.textContent), originalPrompt);

    // A live snapshot change must not leave a stale task-resume action behind.
    for (const status of ['paused', 'completed', 'cancelled']) {
      store.patch('workItems', workId, { status });
      controller.changed();
      await page.waitForSelector(`${card} .autonomous-work-status-${status}`, { visible: true });
      assert.equal(await page.$(taskResume), null, `${status} work cannot resume its old task`);
    }
    store.put('workItems', reviewed);
    controller.changed();
    await page.waitForSelector(taskResume, { visible: true });
    store.remove('workItems', workId);
    controller.changed();
    await page.waitForSelector(card, { hidden: true });
    assert.equal(await page.$(taskResume), null, 'missing work cannot resume its old task');
    store.put('workItems', reviewed);
    controller.changed();
    await page.waitForSelector(taskResume, { visible: true });
    store.put('workItems', { ...reviewed, roomId: 'room_lounge' });
    controller.changed();
    await page.waitForSelector(card, { hidden: true });
    assert.equal(await page.$(card), null, 'a different room’s work is not offered for recovery');
    assert.equal(await page.$(taskResume), null, 'mismatched work cannot resume its old task');
    store.put('workItems', reviewed);
    controller.changed();
    await page.waitForSelector(taskResume, { visible: true });
    await click(card, 'ルームで結果を見る');
    await page.waitForSelector('dialog', { hidden: true });

    await openRoom(1416, 900);
    await openDetails(activityAction);
    await page.waitForSelector(taskResume, { visible: true });
    await click(card, 'ルームで結果を見る');
    await page.waitForSelector('dialog', { hidden: true });
    assert.equal(await page.$eval('.room-heading h1', (element) => element.textContent), roomName);
    assertTaskUnchanged(task);
    assert.equal(store.get('workItems', unrelatedWorkId).status, 'active');
    report.taskRecovery.checks.push(
      'run and room-activity actions open only the task’s work with its original instruction and current checkpoint',
      'desktop and 390px mobile instructions, work state and nested outcome review remain within horizontal bounds',
      'Escape closes only the nested review, restores focus, and room-results navigation closes task details',
      'simple work resume and explicit outcome review never send a task-resume request or replay the stopped task',
      'paused, completed, cancelled, missing and mismatched work do not expose a stale task-resume action',
    );
    report.checks.push(...report.taskRecovery.checks);
  } catch (error) {
    if (!page.isClosed())
      await page
        .screenshot({ path: join(artifactDir, 'task-recovery-failure.png') })
        .catch(() => {});
    throw error;
  } finally {
    page.off('request', recordRequest);
    for (const id of messageIds) store.remove('messages', id);
    for (const activity of store.list('activities'))
      if (activity.taskId === taskId) store.remove('activities', activity.id);
    store.remove('tasks', taskId);
    store.remove('workItems', workId);
    store.remove('workItems', unrelatedWorkId);
    store.remove('rooms', roomId);
    controller.changed();
    if (!page.isClosed())
      await page.evaluate(() => localStorage.setItem('loom.room', 'room_lounge')).catch(() => {});
  }
}
