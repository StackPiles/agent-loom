import assert from 'node:assert/strict';
import { join } from 'node:path';

// Extends the disposable Chrome fixture. The scheduler is disabled, tasks are
// synthetic, and every mutation stays in the temporary app store. No model or
// external operation is invoked by these controls.
export async function checkAutonomousWork({ instance, page, origin, artifactDir, report, settle }) {
  const { store, controller } = instance;
  const roomId = 'room_lounge';
  const room = store.get('rooms', roomId);
  const workspacePath = room.workspacePath || store.settings().workspacePath;
  const stamp = new Date().toISOString();
  const nextRunAt = new Date(Math.floor((Date.now() + 86_400_000) / 60_000) * 60_000).toISOString();
  const dateTime = new Date(Date.parse(nextRunAt) + 9 * 3_600_000).toISOString().slice(0, 16);
  const policy = { mode: 'room', minIntervalMinutes: 5, maxPendingWakeups: 24, maxRunsPerHour: 12 };
  const workId = 'ui_autonomous_work';
  const sourceTaskId = 'ui_autonomous_source';
  const runId = 'ui_autonomous_run';
  const pendingChecks = [
    '登録済み資料の審査結果と公開予定日を、次の起床で確認します。',
    '資料差し替え時の公開枠の扱いを、公式の説明で調べます。',
    'ノヴァの台帳更新を確認してから、レポートに反映します。',
  ];
  store.patch('rooms', roomId, { autonomousWakeups: policy, paused: false });
  const task = (id, botId, status = 'queued') => ({
    id,
    roomId,
    botId,
    rootTaskId: sourceTaskId,
    depth: 0,
    kind: 'automation',
    status,
    workId,
    workRunId: runId,
    workspacePath,
    prompt: 'Synthetic continuation; no external effects.',
    output: '',
    inputTokens: 0,
    outputTokens: 0,
    createdAt: stamp,
    updatedAt: stamp,
  });
  store.put('tasks', { ...task(sourceTaskId, 'bot_aster', 'completed'), completedAt: stamp });
  const work = store.put('workItems', {
    id: workId,
    roomId,
    name: '製品リリースの継続調査と週次レポートの更新',
    purpose: '公式資料の変更点を確認し、根拠を付けて週次レポートを更新する仕事です。',
    kind: 'standing',
    status: 'active',
    createdByBotId: 'bot_aster',
    sourceTaskId,
    scope: room.description,
    workspacePath,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
    checkpoint: {
      summary: '公式資料を2件確認しました。残り1件は明日の公開を待っています。',
      completed: '新バージョンの変更点と、確認済みの根拠を記録しました。',
      nextStep: 'ノヴァが未確認の資料を確認し、オービットがレポートの差分を検証します。',
      references: [
        'research/weekly-report.md',
        'https://example.test/research/' + 'long-reference-'.repeat(16),
      ],
      doneWhen: 'すべての変更点の根拠を確認し、週次レポートを更新できたら今週分を完了します。',
      pendingChecks,
      uncertainActions: [],
    },
  });
  for (const [id, botId] of [
    ['ui_autonomous_nova', 'bot_nova'],
    ['ui_autonomous_orbit', 'bot_orbit'],
  ]) {
    store.put('wakeups', {
      id,
      workId,
      roomId,
      botId,
      createdByBotId: 'bot_aster',
      sourceTaskId,
      key: `review-${botId}`,
      reason: '明日の資料公開後に、残りの根拠を確認するため。',
      prompt: '一次資料を確認し、結果と次に行うことを引き継いでください。',
      schedule: { type: 'once', dateTime, timeZone: 'Asia/Tokyo', missedRunPolicy: 'run_once' },
      status: 'scheduled',
      nextRunAt,
      workRunId: runId,
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  const otherRoomId = 'ui_autonomous_other_room';
  store.put('rooms', {
    id: otherRoomId,
    name: '別ルームの確認',
    description: 'Independent synthetic work.',
    botIds: ['bot_aster'],
    autonomousWakeups: policy,
    archived: false,
    pinned: false,
    createdAt: stamp,
    updatedAt: stamp,
  });
  store.put('workItems', {
    ...work,
    id: 'ui_autonomous_other_work',
    roomId: otherRoomId,
    name: '別ルームの仕事',
  });
  controller.changed();
  report.autonomousWork = { views: {}, settingsNavigation: {}, checks: [] };
  const card = `[data-work-id="${workId}"]`;
  const compact = `[data-work-summary-id="${workId}"]`;

  const button = async (scope, label) => {
    const handle = await page.evaluateHandle(
      (scope, label) => {
        const parent = document.querySelector(scope);
        return [...(parent?.querySelectorAll('button') || [])].find(
          (element) =>
            element.textContent.trim() === label || element.getAttribute('aria-label') === label,
        );
      },
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
      await element.evaluate((node) =>
        node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
      );
      // A closing modal can disappear visually before its hit area is gone.
      // Use a real pointer click only once the intended button is the hit target.
      const hit = await page.waitForFunction(
        (node) => {
          const rect = node.getBoundingClientRect();
          const front = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          );
          return Boolean(
            node.isConnected &&
            !node.disabled &&
            !node.closest('[inert]') &&
            rect.width > 0 &&
            rect.height > 0 &&
            front &&
            node.contains(front),
          );
        },
        { polling: 'raf' },
        element,
      );
      await hit.dispose();
      await element.click();
    } finally {
      await element.dispose();
    }
  };
  const setField = async (label, value, scope = '.autonomous-work-review') => {
    const handle = await page.evaluateHandle(
      (label, scope) => {
        const field = [...document.querySelectorAll(`${scope} label.field`)].find(
          (element) => element.querySelector('.field-label')?.textContent === label,
        );
        return field?.querySelector('input,textarea,select');
      },
      label,
      scope,
    );
    const element = handle.asElement();
    assert.ok(element, `Missing review field: ${label}`);
    try {
      if (await element.evaluate((node) => node.tagName === 'SELECT')) {
        await element.select(value);
        return;
      }
      await element.click();
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await element.type(value);
    } finally {
      await element.dispose();
    }
  };
  const mutate = async (path, scope, label) => {
    const response = page.waitForResponse(
      (item) => item.url() === origin + path && item.request().method() === 'POST',
    );
    await click(scope, label);
    assert.equal((await response).status(), 200, `${path} succeeds`);
  };
  const capture = async (selector, name, focus = selector) => {
    await page.$eval(focus, (element) =>
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }),
    );
    await settle();
    const metrics = await page.$eval(selector, (element) => {
      const bounds = (node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      const controls = [
        ...element.querySelectorAll(
          'button, input, textarea, select, h3, dd, .autonomous-work-wakeup, .autonomous-work-detail li',
        ),
      ]
        .filter((node) => node.getClientRects().length)
        .map((node) => ({ tag: node.tagName, ...bounds(node) }));
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        region: bounds(element),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        controls,
      };
    });
    report.autonomousWork.views[name] = metrics;
    await page.screenshot({ path: join(artifactDir, `${name}.png`) });
    assert.ok(metrics.documentWidth <= metrics.viewport.width + 1, `${name}: no page overflow`);
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${name}: no region overflow`);
    for (const region of [metrics.region, ...metrics.controls]) {
      assert.ok(region.width > 0 && region.height > 0, `${name}: visible dimensions`);
      assert.ok(
        region.x >= -1 && region.x + region.width <= metrics.viewport.width + 1,
        `${name}: horizontal bounds`,
      );
    }
  };
  const setWorkOpen = async (selector, open) => {
    if ((await page.$eval(selector, (element) => element.open)) !== open) {
      await page.focus(`${selector} > summary`);
      await page.keyboard.press('Enter');
    }
    await page.waitForFunction(
      (selector, open) => document.querySelector(selector)?.open === open,
      {},
      selector,
      open,
    );
  };
  const openRoom = async (width, height) => {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.room-work-summary', { visible: true });
    await page.waitForFunction(() => {
      const control = document.querySelector(
        '.room-header button[aria-label="現在の生成・ツール実行が終わったらルームを休止"]',
      );
      return Boolean(control && !control.disabled);
    });
  };
  const openWork = async () => {
    await page.focus('.room-work-summary');
    await page.keyboard.press('Enter');
    await page.waitForSelector(`dialog[open] ${compact} > summary`, { visible: true });
    await setWorkOpen(compact, false);
    assert.equal(
      await page.$eval(compact, (element) => element.hasAttribute('data-needs-attention')),
      false,
      'ordinary scheduled work has no attention warning',
    );
    await capture(`${compact} > summary`, `autonomous-compact-${page.viewport().width}`);
    await setWorkOpen(compact, true);
    await page.waitForSelector(`dialog[open] ${card}`, { visible: true });
    assert.equal(
      await page.$('dialog [data-work-id="ui_autonomous_other_work"]'),
      null,
      'room work stays scoped',
    );
    assert.match(await page.$eval(card, (element) => element.textContent), /Asia\/Tokyo/);
    assert.deepEqual(
      await page.$$eval(`${card} .autonomous-work-pending-checks li`, (elements) =>
        elements.map((element) => element.textContent),
      ),
      pendingChecks,
    );
    assert.equal(await page.$(`${card} .autonomous-work-notice`), null);
    assert.equal(
      await page.$eval(`${card} .autonomous-work-status`, (element) => element.textContent),
      '起床待ち',
      'ordinary pending checks leave the existing wake-ups active',
    );
    await page.click(`${card} .autonomous-work-detail > summary`);
  };
  const navigationState = () =>
    page.evaluate(() => ({
      sidebarRight: document.querySelector('.sidebar')?.getBoundingClientRect().right,
      sidebarOpen: Boolean(document.querySelector('.sidebar-open')),
      scrim: Boolean(document.querySelector('.sidebar-scrim')),
      mainInert: Boolean(document.querySelector('.workspace-main')?.inert),
    }));
  const openAutomations = async (name) => {
    if (page.viewport().width <= 850) await page.click('button[aria-label="メニューを開く"]');
    await page.click('.main-nav button[title="自動化"]');
    await page.waitForSelector('.automation-workspace [role="tablist"]', { visible: true });
    const diagnostic = (report.autonomousWork.settingsNavigation[name] = {
      before: await navigationState(),
    });
    // The page can mount before the mobile sidebar has left its hit area.
    // Wait for actual geometry and inert/backdrop state, not an animation delay.
    await page.waitForFunction(() => {
      const sidebar = document.querySelector('.sidebar');
      return (
        !document.querySelector('.sidebar-scrim') &&
        !document.querySelector('.workspace-main')?.inert &&
        (innerWidth > 850 || (sidebar && sidebar.getBoundingClientRect().right <= 0))
      );
    });
    diagnostic.ready = await navigationState();
    const tablist = '.automation-workspace [role="tablist"]';
    await page.focus(`${tablist} [aria-selected="true"]`);
    await page.keyboard.press('Home');
    assert.equal(
      await page.$eval('.automation-workspace [role="tabpanel"]', (element) => element.hidden),
      false,
      'execution rules are visible without full work cards above them',
    );
    assert.equal(
      await page.$eval(
        '.autonomous-work-section',
        (element) => element.closest('[role="tabpanel"]').hidden,
      ),
      true,
      'ongoing work is hidden on the rules tab',
    );
    await capture(tablist, `automation-rules-${page.viewport().width}`);
    await page.keyboard.press('End');
    await page.waitForSelector('.autonomous-work-policy-list', { visible: true });
    assert.equal(
      await page.$eval(
        `${tablist} [aria-selected="true"]`,
        (element) => document.activeElement === element,
      ),
      true,
      'keyboard tab changes move focus with selection',
    );
    if (name.includes('desktop')) {
      assert.equal(
        await page.$eval(`${tablist} .subtle-tag`, (element) => element.textContent),
        '2',
      );
      await setWorkOpen(compact, false);
      await capture(`${compact} > summary`, 'automation-work-list-desktop');
      await setWorkOpen(compact, true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      // The app opens Chat after reload; return to Automations to check its saved view.
      await page.waitForSelector('.main-nav button[title="自動化"]', { visible: true });
      await page.click('.main-nav button[title="自動化"]');
      await page.waitForSelector('.autonomous-work-policy-list', { visible: true });
      assert.equal(
        await page.$eval(compact, (element) => element.open),
        true,
        'expanded work survives reload',
      );
      assert.match(
        await page.$eval(`${tablist} [aria-selected="true"]`, (element) => element.textContent),
        /継続中の仕事/,
        'selected work tab survives reload',
      );
      await setWorkOpen(compact, false);
    }
    await settle();
  };
  const checkSettings = async (name) => {
    await openAutomations(name);
    const target = await button('.autonomous-work-policy-list', `${room.name}の自律予約を設定`);
    try {
      await target.evaluate((element) =>
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
      );
      const hit = await page.waitForFunction(
        (element) => {
          const rect = element.getBoundingClientRect();
          const x = rect.x + rect.width / 2;
          const y = rect.y + rect.height / 2;
          const front = document.elementFromPoint(x, y);
          if (
            !element.isConnected ||
            element.disabled ||
            element.closest('[inert]') ||
            rect.width <= 0 ||
            rect.height <= 0 ||
            !front ||
            !element.contains(front)
          )
            return false;
          return {
            x,
            y,
            width: rect.width,
            height: rect.height,
            button: element.getAttribute('aria-label'),
            hitTag: front.tagName,
            hitClass: front.getAttribute('class'),
          };
        },
        { polling: 'raf' },
        target,
      );
      report.autonomousWork.settingsNavigation[name].hit = await hit.jsonValue();
      await hit.dispose();
      await target.click();
    } finally {
      await target.dispose();
    }
    await page.waitForSelector('.autonomous-wake-settings', { visible: true });
    assert.equal(
      await page.$eval('.autonomous-wake-settings select', (element) => element.value),
      'room',
    );
    await page.click('.autonomous-wake-limits summary');
    await capture('.autonomous-wake-settings', name);
    const columns = await page.$eval(
      '.autonomous-wake-limit-grid',
      (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
    );
    assert.equal(columns, page.viewport().width <= 580 ? 1 : 3, 'policy bounds stack on mobile');
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog', { hidden: true });
    await settle();
  };

  await openRoom(1416, 900);
  await capture('.room-work-summary', 'autonomous-summary-desktop-1416x900');
  await openWork();
  await capture(card, 'autonomous-work-desktop-1416x900');
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog', { hidden: true });
  assert.equal(
    await page.evaluate(() => document.activeElement?.classList.contains('room-work-summary')),
    true,
    'Escape restores summary focus',
  );
  await checkSettings('autonomous-settings-desktop-1416x900');

  await openRoom(390, 844);
  await capture('.room-work-summary', 'autonomous-summary-mobile-390x844');
  await openWork();
  await capture(card, 'autonomous-work-mobile-390x844');
  const pausedTasks = ['ui_autonomous_pending_aster', 'ui_autonomous_pending_nova'];
  pausedTasks.forEach((id, index) =>
    store.put('tasks', task(id, index ? 'bot_nova' : 'bot_aster')),
  );
  controller.changed();
  await mutate(`/api/work-items/${workId}/pause`, card, '仕事を一時停止');
  await page.waitForFunction(
    (selector) =>
      document.querySelector(`${selector} .autonomous-work-status`)?.textContent === '一時停止',
    {},
    card,
  );
  assert.equal(store.get('workItems', workId).status, 'paused');
  for (const id of pausedTasks) assert.equal(store.get('tasks', id).status, 'stopped');
  assert.equal(store.get('wakeups', 'ui_autonomous_nova').status, 'scheduled');
  await capture(card, 'autonomous-paused-mobile-390x844', `${card} .autonomous-work-actions`);
  await mutate(`/api/work-items/${workId}/resume`, card, '仕事を再開');
  await page.waitForFunction(
    (selector) =>
      document.querySelector(`${selector} .autonomous-work-status`)?.textContent === '起床待ち',
    {},
    card,
  );
  assert.equal(store.get('workItems', workId).status, 'active');
  for (const id of pausedTasks)
    assert.equal(
      store.get('tasks', id).status,
      'stopped',
      'work resume does not replay stopped tasks',
    );
  await mutate(
    '/api/wakeups/ui_autonomous_nova/cancel',
    card,
    `${store.get('bots', 'bot_nova').name}の起床予約を取り消す`,
  );
  await page.waitForSelector('[data-wakeup-id="ui_autonomous_nova"]', { hidden: true });
  assert.equal(store.get('wakeups', 'ui_autonomous_nova').cancelledBy, 'owner');
  assert.equal(store.get('wakeups', 'ui_autonomous_orbit').status, 'scheduled');

  const originalCheckpoint = store.get('workItems', workId).checkpoint;
  store.patch('workItems', workId, {
    status: 'blocked',
    checkpoint: {
      ...originalCheckpoint,
      uncertainActions: ['週次レポートの下書きが保存済みか確認してください。'],
    },
    lastError: 'UI確認用：保存結果の確認が必要です。',
    revision: store.get('workItems', workId).revision + 1,
    updatedAt: new Date().toISOString(),
  });
  controller.changed();
  await page.waitForFunction(
    (selector) =>
      [...document.querySelectorAll(`${selector} button`)].some(
        (element) => element.textContent.trim() === '確認して再開',
      ),
    {},
    card,
  );
  assert.equal(
    await page.$eval(`${card} .autonomous-work-status`, (element) => element.textContent),
    '操作結果の確認待ち',
  );
  assert.equal(await page.$eval(compact, (element) => element.dataset.needsAttention), 'true');
  await capture(card, 'autonomous-outcome-review-mobile-390x844');
  await click(card, '確認して再開');
  await page.waitForSelector('.autonomous-work-review', { visible: true });
  const review = '.autonomous-work-review';
  const submit = `${review} button[type="submit"]`;
  assert.equal(await page.$eval(submit, (element) => element.disabled), true);
  await setField(
    '確認した結果',
    '保存済みの下書きを確認しました。再作成せず、内容の確認から続けます。',
  );
  await setField('次に行うこと', '保存済みの下書きと一次資料を比較します。');
  assert.equal(
    await page.$eval(submit, (element) => element.disabled),
    true,
    'outcome confirmation is explicit',
  );
  await page.click(`${review} .autonomous-work-review-confirm input`);
  assert.equal(await page.$eval(submit, (element) => element.disabled), false);
  await capture(review, 'autonomous-review-mobile-390x844', submit);

  // One synthetic HTTP rejection verifies that the modal retains its review
  // draft and displays a readable error before a normal real-app retry.
  let rejectOnce = true;
  const intercept = (request) => {
    if (
      rejectOnce &&
      request.method() === 'POST' &&
      request.url() === `${origin}/api/work-items/${workId}/resume`
    ) {
      rejectOnce = false;
      void request.respond({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: '確認結果を保存できませんでした（UI確認用）。もう一度お試しください。',
        }),
      });
    } else void request.continue();
  };
  await page.setRequestInterception(true);
  page.on('request', intercept);
  try {
    const rejected = page.waitForResponse(
      (response) =>
        response.url() === `${origin}/api/work-items/${workId}/resume` &&
        response.request().method() === 'POST',
    );
    await page.click(submit);
    assert.equal((await rejected).status(), 409);
    await page.waitForSelector(`${review} [role="alert"]`, { visible: true });
    assert.match(
      await page.$eval(`${review} [role="alert"]`, (element) => element.textContent),
      /確認結果を保存できませんでした/,
    );
    assert.equal(store.get('workItems', workId).status, 'blocked');
    assert.equal(
      await page.$eval(
        `${review} .autonomous-work-review-confirm input`,
        (element) => element.checked,
      ),
      true,
    );
    await capture(review, 'autonomous-review-error-mobile-390x844', submit);
  } finally {
    await page.setRequestInterception(false);
    page.off('request', intercept);
  }
  await mutate(`/api/work-items/${workId}/resume`, review, '確認を記録して再開');
  await page.waitForSelector(review, { hidden: true });
  const resumed = store.get('workItems', workId);
  assert.equal(resumed.status, 'active');
  assert.deepEqual(resumed.checkpoint.uncertainActions, []);
  assert.deepEqual(resumed.checkpoint.pendingChecks, pendingChecks);
  assert.ok(resumed.checkpoint.summary.startsWith(originalCheckpoint.summary));
  assert.ok(resumed.checkpoint.summary.includes('保存済みの下書きを確認しました'));
  assert.equal(resumed.checkpoint.completed, originalCheckpoint.completed);
  assert.deepEqual(resumed.checkpoint.references, originalCheckpoint.references);
  assert.equal(
    await page.$eval('dialog', (element) => element.open),
    true,
    'review closes only its nested dialog',
  );

  store.put('tasks', task('ui_autonomous_pending_cancel', 'bot_orbit'));
  controller.changed();
  await mutate(`/api/work-items/${workId}/stop`, card, '仕事を中止');
  await page.waitForSelector('.room-work-summary', { hidden: true });
  await page.waitForSelector('dialog', { hidden: true });
  assert.equal(store.get('workItems', workId).status, 'cancelled');
  assert.equal(store.get('wakeups', 'ui_autonomous_orbit').status, 'cancelled');
  assert.equal(store.get('tasks', 'ui_autonomous_pending_cancel').status, 'stopped');
  await checkSettings('autonomous-settings-mobile-390x844');
  await click('.autonomous-work-history', '終了した仕事を表示（1件）');
  await page.waitForSelector(`${compact} > summary`, { visible: true });
  await setWorkOpen(compact, true);
  await page.waitForSelector(card, { visible: true });
  assert.equal(
    await page.$(`${card} .button-danger`),
    null,
    'terminal work has no lifecycle mutation buttons',
  );
  await capture(card, 'autonomous-cancelled-mobile-390x844');

  // Review an unfinished peer and optional future scope without stopping either
  // implicitly. This is a separate fixture so the pause/cancel coverage remains
  // independent of completion disposition.
  const completionWorkId = 'ui_completion_work';
  const completionSourceId = 'ui_completion_source';
  const completionPeerId = 'ui_completion_peer';
  const completionCard = `[data-work-id="${completionWorkId}"]`;
  const completionSummary = `[data-work-summary-id="${completionWorkId}"]`;
  const completionForm = '.autonomous-work-completion-review';
  store.put('tasks', {
    ...task(completionSourceId, 'bot_aster', 'completed'),
    workId: completionWorkId,
    rootTaskId: completionSourceId,
    completedAt: stamp,
  });
  store.put('tasks', {
    ...task(completionPeerId, 'bot_nova'),
    workId: completionWorkId,
    rootTaskId: completionSourceId,
    parentTaskId: completionSourceId,
    prompt: '公開資料の確認結果を回答してください。',
  });
  store.put('workItems', {
    ...work,
    id: completionWorkId,
    sourceTaskId: completionSourceId,
    name: '確認待ちと後日の改善案を整理してレポートを完了する',
    kind: 'task',
    checkpoint: {
      ...work.checkpoint,
      pendingChecks: ['次回のレポートに向けた任意の表示改善を検討する。'],
    },
  });
  controller.changed();
  await openRoom(390, 844);
  await page.focus('.room-work-summary');
  await page.keyboard.press('Enter');
  await page.waitForSelector(`dialog[open] ${completionSummary} > summary`, { visible: true });
  await setWorkOpen(completionSummary, true);
  await mutate(`/api/work-items/${completionWorkId}/complete`, completionCard, '完了にする');
  await page.waitForSelector(completionForm, { visible: true });
  assert.equal(
    store.get('tasks', completionPeerId).status,
    'queued',
    'initial complete preserves a required peer',
  );
  assert.equal(store.get('workItems', completionWorkId).status, 'active');
  assert.equal(
    await page.$eval(`${completionForm} button[type="submit"]`, (node) => node.disabled),
    true,
  );
  assert.equal(
    await page.$eval(`${completionForm} select`, (node) => node.value),
    '',
    'no disposition is selected silently',
  );
  await setField(
    'これまでの成果と判断の根拠',
    '本体の調査は済みました。資料の確認結果を待ち、任意の表示改善は次回の仕事として残します。',
    completionForm,
  );
  const completionItems = store.get('workItems', completionWorkId).completionReview.items;
  for (const [index, item] of completionItems.entries()) {
    await setField(
      `作業 ${index + 1} の扱い`,
      item.kind === 'task' ? 'wait' : 'defer',
      completionForm,
    );
    await setField(
      `作業 ${index + 1} の理由`,
      item.kind === 'task'
        ? '今回の根拠を確定するため回答が必要です。'
        : '今回の必須成果は変更せず、任意の改善案を次回に回します。',
      completionForm,
    );
  }
  await setField('後続の仕事名', '次回レポートの表示改善', completionForm);
  await setField(
    '後続の仕事の目的',
    '保存した改善案を後日確認し、必要なものを次回のレポートに反映します。',
    completionForm,
  );
  await capture(completionForm, 'autonomous-completion-review-mobile-390x844');
  await mutate(`/api/work-items/${completionWorkId}/complete`, completionForm, '整理内容を適用');
  await page.waitForSelector(completionForm, { hidden: true });
  assert.equal(store.get('workItems', completionWorkId).completionReview.status, 'waiting');
  assert.equal(store.get('tasks', completionPeerId).status, 'queued');
  const followUpId = store.get('workItems', completionWorkId).completionReview.followUpWorkId;
  assert.ok(followUpId);
  assert.equal(store.get('workItems', followUpId).deferredFromWorkId, completionWorkId);
  assert.equal(
    store.list('tasks').some((item) => item.workId === followUpId),
    false,
    'deferral saves scope without replaying tasks',
  );
  assert.equal(
    store.list('wakeups').some((item) => item.workId === followUpId),
    false,
  );
  await capture(completionCard, 'autonomous-completion-wait-mobile-390x844');

  // The remaining answer became redundant after equivalent evidence arrived.
  // Reopening a wait must not defer the already saved optional item a second time.
  await click(completionCard, '残りの作業を整理');
  await page.waitForSelector(completionForm, { visible: true });
  assert.equal(
    await page.$$eval(
      `${completionForm} .autonomous-work-completion-items fieldset`,
      (nodes) => nodes.length,
    ),
    1,
  );
  await setField(
    'これまでの成果と判断の根拠',
    '別の一次資料で必要な根拠を確認できたため、回答待ちの依頼は重複になりました。',
    completionForm,
  );
  await setField('作業 1 の扱い', 'dismiss', completionForm);
  await setField(
    '作業 1 の理由',
    '同じ確認事項を一次資料で解決済みです。必要な成果は揃っています。',
    completionForm,
  );
  await mutate(`/api/work-items/${completionWorkId}/complete`, completionForm, '整理内容を適用');
  await page.waitForSelector(completionForm, { hidden: true });
  assert.equal(store.get('workItems', completionWorkId).status, 'completed');
  assert.equal(store.get('tasks', completionPeerId).stopContext.reason, 'work_superseded');
  assert.equal(store.get('tasks', completionPeerId).stopContext.actorType, 'owner');
  assert.equal(
    store.list('workItems').filter((item) => item.deferredFromWorkId === completionWorkId).length,
    1,
  );
  const followUpCard = `[data-work-id="${followUpId}"]`;
  await page.waitForSelector(`[data-work-summary-id="${followUpId}"] > summary`, { visible: true });
  await setWorkOpen(`[data-work-summary-id="${followUpId}"]`, true);
  await capture(followUpCard, 'autonomous-saved-follow-up-mobile-390x844');
  assert.match(await page.$eval(followUpCard, (node) => node.textContent), /後続の仕事・未着手/);
  await mutate(`/api/work-items/${followUpId}/stop`, followUpCard, '仕事を中止');
  await page.waitForSelector('dialog', { hidden: true });
  report.autonomousWork.checks.push(
    'desktop/mobile work, references, settings and review controls remain within horizontal bounds',
    'keyboard summary open and Escape restore focus; room dialogs exclude unrelated room work',
    'execution rules and ongoing work occupy separate tabs with keyboard selection and correct visible panels',
    'compact work summaries, selected tab and expanded work survive navigation and reload without runtime mutations',
    'ordinary wake-up waits have no attention warning; unresolved outcomes do',
    'pause stops linked queued tasks and holds reservations; work resume does not replay those tasks',
    'individual cancellation affects only its reservation and records owner provenance',
    'uncertain review requires actual-result text, a next step and explicit confirmation, retains drafts after HTTP failure, and preserves earlier progress',
    'whole-work cancellation stops linked work and future reservations and retains terminal history',
    'completion review requires explicit decisions and evidence, preserving a required queued peer while saving optional scope without replay',
    'reassessing a wait can dismiss a redundant peer and complete the work without duplicating an earlier follow-up; mobile controls stay in bounds',
  );
}
