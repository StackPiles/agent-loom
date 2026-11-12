import assert from 'node:assert/strict';
import { join } from 'node:path';

// Synthetic credentials only. Uses the real encrypted store and read API in
// the disposable Chrome fixture; never opens a real external service.
export async function checkServiceSecrets({ instance, page, origin, artifactDir, report, settle }) {
  const { saveServiceAccount, removeServiceAccount } =
    await import('../dist/server/service-accounts.js');
  const { store, controller } = instance;
  const name = '秘密情報の検証用サービス';
  const secret = `fixture-only-secret_${'long-key-'.repeat(18)}end`;
  const fields = {
    name,
    url: 'https://fixture.example/login',
    login: 'fixture@example.test',
    botId: 'bot_aster',
    mailAccountId: null,
    status: 'active',
    notes: '画面とコピーの動作を確認するための架空のサービスです。',
  };
  let account = saveServiceAccount(store, { ...fields, credential: secret });
  const endpoint = `${origin}/api/service-accounts/${account.id}/credential`;
  const section = '[data-service-saved-credential]';
  const valueSelector = '[data-service-credential-value]';
  const show = 'button[aria-label="秘密情報を表示"]';
  const hide = 'button[aria-label="秘密情報を隠す"]';
  const copy = 'button[aria-label="秘密情報をコピー"]';
  const edit = `button[aria-label="${name}を編集"]`;
  const requests = [];
  const recordRequest = (request) => {
    if (request.url() === endpoint)
      requests.push({ method: request.method(), body: JSON.parse(request.postData() || '{}') });
  };
  report.serviceSecrets = { views: {}, checks: [] };
  const click = async (selector) => {
    await page.waitForSelector(selector, { visible: true });
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.disabled === false,
      {},
      selector,
    );
    await page.locator(selector).click();
  };
  const openSettings = async (width, height) => {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button[aria-label="メール・サービス"]');
    if (await page.$('#loom-navigation[aria-hidden="true"]'))
      await page.click('button[aria-label="メニューを開く"]');
    await click('button[aria-label="メール・サービス"]');
    await page.waitForFunction(
      () =>
        !document.querySelector('.sidebar-scrim') &&
        !document.querySelector('.workspace-main')?.inert,
    );
    await click('#service-accounts-tab');
    await click(edit);
    await page.waitForSelector('dialog[open] .account-settings-section summary', { visible: true });
    await page.focus('dialog[open] .account-settings-section summary');
    await page.keyboard.press('Enter');
    await page.waitForSelector(section, { visible: true });
  };
  const capture = async (name) => {
    await page.$eval(section, (element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await settle();
    const metrics = await page.$eval(section, (element) => {
      const bounds = (node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        region: bounds(element),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        controls: [...element.querySelectorAll('button,textarea')].map(bounds),
      };
    });
    assert.ok(metrics.documentWidth <= metrics.viewport.width + 1, `${name}: document fits`);
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${name}: credential region fits`);
    for (const box of [metrics.region, ...metrics.controls]) {
      assert.ok(box.width > 0 && box.height > 0, `${name}: control is painted`);
      assert.ok(
        box.x >= -1 && box.x + box.width <= metrics.viewport.width + 1,
        `${name}: control fits horizontally`,
      );
      assert.ok(
        box.y >= -1 && box.y + box.height <= metrics.viewport.height + 1,
        `${name}: control is visible`,
      );
    }
    report.serviceSecrets.views[name] = metrics;
    await page.screenshot({ path: join(artifactDir, `${name}.png`) });
  };
  const readBy = async (selector, keyboard = false) => {
    const response = page.waitForResponse(
      (response) => response.url() === endpoint && response.request().method() === 'POST',
    );
    if (keyboard) {
      await page.focus(selector);
      await page.keyboard.press('Enter');
    } else await click(selector);
    const result = await response;
    assert.equal(result.status(), 200);
    assert.equal(result.headers()['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(result.request().postData()), {
      expectedRevision: account.revision,
    });
    return result.json();
  };

  page.on('request', recordRequest);
  controller.changed();
  try {
    await openSettings(1416, 900);
    assert.equal(requests.length, 0, 'opening the editor does not request secrets');
    assert.equal(await page.$(valueSelector), null);
    const shown = await readBy(show, true);
    assert.equal(shown.credential, secret);
    await page.waitForFunction(
      (selector, value) => document.querySelector(selector)?.value === value,
      {},
      valueSelector,
      secret,
    );
    assert.equal(await page.$eval('dialog input[type="password"]', (element) => element.value), '');
    await capture('desktop-service-secret-revealed');
    await click(hide);
    await page.waitForSelector(valueSelector, { hidden: true });

    await page.browserContext().overridePermissions(origin, ['clipboard-read', 'clipboard-write']);
    await readBy(copy);
    await page.waitForFunction(
      (selector) =>
        document.querySelector(`${selector} [role="status"]`)?.textContent === 'コピーしました',
      {},
      section,
    );
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), secret);
    assert.equal(await page.$(valueSelector), null, 'copy does not expose the value on screen');
    await capture('desktop-service-secret-copied');
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog', { hidden: true });
    assert.equal(await page.$eval(edit, (element) => document.activeElement === element), true);
    report.serviceSecrets.checks.push(
      'keyboard reveal uses the real revision-bound no-store API and keeps the replacement field empty',
      'native Chrome clipboard receives the exact synthetic value without showing it on screen',
      'Escape closes the credential view and restores focus to the service edit action',
    );

    await openSettings(390, 844);
    const beforeCopy = requests.length;
    await page.evaluate(() => {
      globalThis.__loomServiceClipboardDescriptor = Object.getOwnPropertyDescriptor(
        navigator,
        'clipboard',
      );
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          async writeText() {
            throw new DOMException('Synthetic permission denial', 'NotAllowedError');
          },
        },
      });
    });
    await readBy(copy);
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.includes('手動でコピー'),
      {},
      `${section} [role="alert"]`,
    );
    assert.equal(requests.length, beforeCopy + 1);
    assert.equal(await page.$eval(valueSelector, (element) => element.value), secret);
    await page.focus(valueSelector);
    assert.deepEqual(
      await page.$eval(valueSelector, (element) => [element.selectionStart, element.selectionEnd]),
      [0, secret.length],
    );
    await capture('mobile-service-secret-copy-fallback');

    const beforeChange = requests.length;
    account = saveServiceAccount(
      store,
      { ...fields, credential: 'fixture-rotated-secret', expectedRevision: account.revision },
      account.id,
    );
    controller.changed();
    await page.waitForSelector(section, { hidden: true });
    assert.equal(
      await page.$(valueSelector),
      null,
      'a live revision change discards the visible credential',
    );
    assert.equal(
      requests.length,
      beforeChange,
      'a revision change never fetches a credential automatically',
    );
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog', { hidden: true });
    await click(edit);
    await page.focus('dialog[open] .account-settings-section summary');
    await page.keyboard.press('Enter');
    await page.waitForSelector(section, { visible: true });
    const rotated = await readBy(show);
    assert.equal(rotated.credential, 'fixture-rotated-secret');
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.value === 'fixture-rotated-secret',
      {},
      valueSelector,
    );
    assert.equal(
      await page.$eval(valueSelector, (element) => element.value),
      'fixture-rotated-secret',
    );
    const publicState = await page.evaluate(async () => (await fetch('/api/state')).text());
    assert.equal(publicState.includes('fixture-only-secret'), false);
    assert.equal(publicState.includes('fixture-rotated-secret'), false);
    report.serviceSecrets.checks.push(
      'mobile clipboard rejection offers a selectable value and honest manual-copy guidance without overflow',
      'a live service revision hides old credentials and reopening reads only the current revision',
      'normal API snapshots contain neither original nor rotated secrets',
    );
  } finally {
    page.off('request', recordRequest);
    await page
      .evaluate(() => {
        const descriptor = globalThis.__loomServiceClipboardDescriptor;
        if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
        else Reflect.deleteProperty(navigator, 'clipboard');
        delete globalThis.__loomServiceClipboardDescriptor;
      })
      .catch(() => {});
    await page
      .browserContext()
      .clearPermissionOverrides()
      .catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    removeServiceAccount(store, account.id, account.revision);
    controller.changed();
  }
}
