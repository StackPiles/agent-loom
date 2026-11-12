import assert from 'node:assert/strict';
import { join } from 'node:path';

// Every update endpoint is intercepted in this disposable browser. In particular,
// install requests never reach the updater, launcher, repository, or a restart.
export async function checkAppUpdates({ instance, page, origin, artifactDir, report, settle }) {
  const version = instance.controller.getSnapshot().version;
  const savedSettings = instance.store.settings();
  const previousSha = 'a'.repeat(40);
  const targetSha = 'b'.repeat(40);
  const nextVersion = '99.0.0';
  const notice = '.topbar .app-update-notice';
  const panel = '[data-app-update-dialog]';
  const requests = [];
  let info = {
    current: { version, commit: previousSha },
    latest: {
      version,
      commit: previousSha,
      url: `https://github.com/StackPiles/agent-loom/commit/${previousSha}`,
      checks: 'passed',
      protocol: 1,
    },
    available: false,
    installation: { kind: 'managed-git', canUpdate: true },
    checkedAt: new Date().toISOString(),
  };
  const installRequests = () => requests.filter((item) => item.path === '/api/updates/install');
  const intercept = (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin || !url.pathname.startsWith('/api/updates')) {
      void request.continue();
      return;
    }
    const body = request.postData() ? JSON.parse(request.postData()) : undefined;
    requests.push({ path: url.pathname, method: request.method(), body });
    if (url.pathname === '/api/updates/install') {
      const stamp = new Date().toISOString();
      info = {
        ...info,
        job: {
          id: body.requestId,
          phase: 'preparing',
          targetSha: body.commit,
          targetVersion: nextVersion,
          previousSha,
          startedAt: stamp,
          updatedAt: stamp,
        },
      };
      void request.respond({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify(info.job),
      });
    } else if (url.pathname === '/api/updates' || url.pathname === '/api/updates/check') {
      void request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(info),
      });
    } else {
      void request.respond({ status: 404, contentType: 'application/json', body: '{}' });
    }
  };
  report.appUpdates = { views: {}, checks: [] };

  const button = async (scope, label) => {
    const handle = await page.evaluateHandle(
      (scope, label) =>
        [...document.querySelector(scope).querySelectorAll('button')].find(
          (element) =>
            element.textContent.trim() === label || element.getAttribute('aria-label') === label,
        ),
      scope,
      label,
    );
    const element = handle.asElement();
    assert.ok(element, `Missing update button: ${label}`);
    return element;
  };
  const click = async (scope, label) => {
    const element = await button(scope, label);
    try {
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
  const open = async (width, height) => {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.composer textarea', { visible: true });
    await page.waitForSelector(notice, { visible: true });
  };
  const openUpdates = async () => {
    await page.focus(notice);
    await page.keyboard.press('Enter');
    await page.waitForSelector(panel, { visible: true });
    // Opening may join an already-running status or discovery request. Wait for
    // the shared UI state to settle, without requiring another HTTP request.
    await page.waitForFunction(
      (selector) =>
        document.querySelector(`${selector} .app-update-actions button`)?.disabled === false,
      {},
      panel,
    );
  };
  const closeUpdates = async () => {
    await page.keyboard.press('Escape');
    await page.waitForSelector(panel, { hidden: true });
    assert.equal(
      await page.$eval(notice, (element) => document.activeElement === element),
      true,
      'Escape restores focus to the update action',
    );
  };
  const capture = async (name) => {
    await page.$eval(`${panel} .app-update-versions`, (element) =>
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }),
    );
    await settle();
    const metrics = await page.$eval(panel, (element) => {
      const bounds = (node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        panel: bounds(element),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        notice: bounds(document.querySelector('.topbar .app-update-notice')),
        controls: [
          ...element.querySelectorAll(
            'h2, dl, button, .app-update-summary, .app-update-result, .app-update-hint',
          ),
        ]
          .filter((node) => node.getClientRects().length)
          .map(bounds),
      };
    });
    report.appUpdates.views[name] = metrics;
    await page.screenshot({ path: join(artifactDir, `${name}.png`) });
    assert.ok(metrics.documentWidth <= metrics.viewport.width + 1, `${name}: no page overflow`);
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${name}: no update-panel overflow`);
    for (const box of [metrics.panel, metrics.notice, ...metrics.controls]) {
      assert.ok(box.width > 0 && box.height > 0, `${name}: visible dimensions`);
      assert.ok(
        box.x >= -1 && box.x + box.width <= metrics.viewport.width + 1,
        `${name}: horizontal bounds`,
      );
    }
  };

  await page.setRequestInterception(true);
  page.on('request', intercept);
  try {
    await open(1416, 900);
    await page.waitForSelector(`${notice}[data-update-state="idle"]`, { visible: true });
    // Settle initial discovery before changing the synthetic upstream release.
    // This also verifies that the permanent idle action opens a usable dialog.
    await openUpdates();
    assert.equal(await page.$eval(notice, (element) => element.dataset.updateState), 'idle');
    await closeUpdates();
    const draft = '更新画面を閉じても残す、送信前の下書きです。';
    await page.focus('.composer textarea');
    await page.keyboard.sendCharacter(draft);
    info = {
      ...info,
      available: true,
      latest: { ...info.latest, version: nextVersion, commit: targetSha },
    };
    await openUpdates();
    assert.equal(await page.$eval('.composer textarea', (element) => element.value), draft);
    assert.equal(await page.$$eval('dialog[open]', (elements) => elements.length), 1);
    await capture('app-updates-desktop-1416x900');
    const manualCheck = page.waitForResponse(
      (response) =>
        response.url() === `${origin}/api/updates/check` && response.request().method() === 'POST',
    );
    await click(panel, '更新を確認');
    const checked = await manualCheck;
    assert.equal(checked.status(), 200);
    assert.equal(
      JSON.parse(checked.request().postData()).force,
      true,
      'manual checking explicitly refreshes discovery',
    );
    assert.equal(installRequests().length, 0);
    await closeUpdates();
    assert.equal(await page.$eval('.composer textarea', (element) => element.value), draft);

    // Native modal focus isolation keeps the global action behind any other dialog.
    await page.click('.room-details-trigger');
    await page.waitForSelector('dialog[open]', { visible: true });
    await page.focus(notice);
    assert.equal(await page.$eval(notice, (element) => document.activeElement === element), false);
    assert.equal(await page.$(panel), null);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog', { hidden: true });

    await page.click('#loom-navigation button[aria-label="設定"]');
    const modelInput = 'input[list="model-ids"]';
    await page.waitForSelector(modelInput, { visible: true });
    const settingsDraft = 'unsaved-ui-update-fixture';
    await page.focus(modelInput);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.sendCharacter(settingsDraft);
    await page.waitForSelector('.settings-savebar.has-changes');
    await openUpdates();
    const install = await button(panel, '更新して再起動');
    assert.equal(
      await install.evaluate((element) => element.disabled),
      true,
      'global dialog retains the settings dirty guard',
    );
    await install.dispose();
    assert.match(
      await page.$eval(panel, (element) => element.textContent),
      /未保存の設定があります/,
    );
    assert.equal(await page.$$eval('.app-update-settings', (elements) => elements.length), 2);
    const duplicateIds = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    });
    assert.deepEqual(duplicateIds, [], 'embedded and global update panels use distinct IDs');
    await capture('app-updates-settings-draft-desktop-1416x900');
    await closeUpdates();
    assert.equal(await page.$eval(modelInput, (element) => element.value), settingsDraft);
    assert.equal(installRequests().length, 0);
    assert.deepEqual(
      instance.store.settings(),
      savedSettings,
      'opening updates never saves the settings draft',
    );

    // Reload only the disposable fixture to discard its intentionally unsaved test draft.
    await open(390, 844);
    await openUpdates();
    await capture('app-updates-mobile-390x844');
    const installed = page.waitForResponse(
      (response) =>
        response.url() === `${origin}/api/updates/install` &&
        response.request().method() === 'POST',
    );
    await click(panel, '更新して再起動');
    assert.equal((await installed).status(), 202);
    await page.waitForSelector(`${notice}[data-update-state="updating"]`, { visible: true });
    assert.equal(installRequests().length, 1);
    assert.equal(installRequests()[0].method, 'POST');
    assert.equal(installRequests()[0].body.commit, targetSha);
    assert.match(
      installRequests()[0].body.requestId,
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,
    );
    await closeUpdates();
    info = { ...info, job: { ...info.job, phase: 'verifying' } };
    await openUpdates();
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent.includes('起動を確認しています'),
      {},
      panel,
    );
    assert.equal(installRequests().length, 1, 'reopening progress does not repeat installation');
    info = {
      ...info,
      available: false,
      current: { version: nextVersion, commit: targetSha },
      job: { ...info.job, phase: 'succeeded' },
    };
    await click(panel, '状況を再確認');
    await page.waitForSelector(`${notice}[data-update-state="complete"]`, { visible: true });
    const reload = await button(panel, '画面を再読み込み');
    assert.equal(await reload.evaluate((element) => element.disabled), false);
    await reload.dispose();
    await capture('app-updates-complete-mobile-390x844');
    assert.equal(installRequests().length, 1);
    assert.deepEqual(instance.store.settings(), savedSettings);
    await closeUpdates();
    report.appUpdates.checks.push(
      'a permanent top-bar update action opens in place on chat and settings, preserving drafts and native-modal focus isolation',
      'desktop and 390px mobile update panels, state indicators and controls stay within horizontal bounds',
      'an unsaved settings owner blocks the separate global panel and both panels use unique IDs',
      'manual discovery uses force and one explicitly requested synthetic install retains its exact SHA and receipt across dialog reopening',
      'completion requires an explicit reload; no install request reaches the real updater or restarts the fixture',
    );
    report.checks.push(...report.appUpdates.checks);
  } catch (error) {
    if (!page.isClosed())
      await page.screenshot({ path: join(artifactDir, 'app-updates-failure.png') }).catch(() => {});
    throw error;
  } finally {
    // Reset provider state before restoring real, read-only status handling.
    info = {
      ...info,
      current: { version, commit: previousSha },
      latest: { ...info.latest, version, commit: previousSha },
      available: false,
      job: undefined,
    };
    if (!page.isClosed()) {
      await page.evaluate(() => sessionStorage.removeItem('loom.updateRequest')).catch(() => {});
      await page.goto(origin, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page
        .waitForSelector(`${notice}[data-update-state="idle"]`, { visible: true })
        .catch(() => {});
    }
    page.off('request', intercept);
    await page.setRequestInterception(false).catch(() => {});
  }
}
