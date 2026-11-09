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
      await element.click();
    } finally {
      await element.dispose();
    }
  };
  const setField = async (label, value) => {
    const handle = await page.evaluateHandle((label) => {
      const field = [...document.querySelectorAll('.autonomous-work-review label.field')].find(
        (element) => element.querySelector('.field-label')?.textContent === label,
      );
      return field?.querySelector('textarea');
    }, label);
    const element = handle.asElement();
    assert.ok(element, `Missing review field: ${label}`);
    try {
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
    await page.waitForSelector(`dialog[open] ${card}`, { visible: true });
    assert.equal(
      await page.$('dialog [data-work-id="ui_autonomous_other_work"]'),
      null,
      'room work stays scoped',
    );
    assert.match(await page.$eval(card, (element) => element.textContent), /Asia\/Tokyo/);
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
    await page.waitForSelector('.autonomous-work-policy-list', { visible: true });
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
  await page.waitForSelector(card, { visible: true });
  assert.equal(
    await page.$(`${card} .button-danger`),
    null,
    'terminal work has no lifecycle mutation buttons',
  );
  await capture(card, 'autonomous-cancelled-mobile-390x844');
  report.autonomousWork.checks.push(
    'desktop/mobile work, references, settings and review controls remain within horizontal bounds',
    'keyboard summary open and Escape restore focus; room dialogs exclude unrelated room work',
    'pause stops linked queued tasks and holds reservations; work resume does not replay those tasks',
    'individual cancellation affects only its reservation and records owner provenance',
    'uncertain review requires actual-result text, a next step and explicit confirmation, retains drafts after HTTP failure, and preserves earlier progress',
    'whole-work cancellation stops linked work and future reservations and retains terminal history',
  );
}
