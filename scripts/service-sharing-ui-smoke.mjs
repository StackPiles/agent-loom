import assert from 'node:assert/strict';
import { join } from 'node:path';

// Exercise the real registration API with synthetic bots and a synthetic secret.
// Sharing service access must leave linked mailbox permissions and secrets intact.
export async function checkServiceSharing({ instance, page, origin, artifactDir, report, settle }) {
  const { getServiceAccount, readServiceCredential, removeServiceAccount } =
    await import('../dist/server/service-accounts.js');
  const { store, controller } = instance;
  const manager = store.get('bots', 'bot_aster');
  const teammate = store.get('bots', 'bot_nova');
  const disabled = {
    ...teammate,
    id: 'ui_service_shared_disabled',
    name: '停止中の共有ボット',
    handle: 'sharing_disabled',
    enabled: false,
  };
  const name = '共有設定の検証用サービス';
  const secret = 'fixture-only-service-sharing-secret';
  const region = 'dialog[open] .service-sharing-section';
  const requests = [];
  const mailAssignments = store.list('mailAccounts').map(({ id, botIds }) => ({ id, botIds }));
  let account;
  report.serviceSharing = { views: {}, checks: [] };
  const recordRequest = (request) => {
    if (request.url().startsWith(`${origin}/api/service-accounts`))
      requests.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
        body: request.postData() ? JSON.parse(request.postData()) : undefined,
      });
  };
  const click = async (scope, label) => {
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
    assert.ok(element, `Missing service button: ${label}`);
    try {
      await element.click();
    } finally {
      await handle.dispose();
    }
  };
  const field = async (label, value) => {
    const handle = await page.evaluateHandle(
      (label) =>
        [...document.querySelectorAll('dialog[open] label.field')]
          .find((element) => element.querySelector('.field-label')?.textContent === label)
          ?.querySelector('input,select'),
      label,
    );
    const element = handle.asElement();
    assert.ok(element, `Missing service field: ${label}`);
    try {
      if ((await element.evaluate((element) => element.tagName)) === 'SELECT')
        await element.select(value);
      else {
        await element.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.keyboard.sendCharacter(value);
      }
    } finally {
      await handle.dispose();
    }
  };
  const shareSelector = (bot) => `${region} input[aria-label="${bot.name}に共有"]`;
  const openServices = async (width, height) => {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button[aria-label="メール・サービス"]');
    if (await page.$('#loom-navigation[aria-hidden="true"]'))
      await page.click('button[aria-label="メニューを開く"]');
    await page.click('button[aria-label="メール・サービス"]');
    await page.waitForFunction(
      () =>
        !document.querySelector('.sidebar-scrim') &&
        !document.querySelector('.workspace-main')?.inert,
    );
    await page.click('#service-accounts-tab');
    await page.waitForSelector('#service-accounts-content', { visible: true });
  };
  const capture = async (name) => {
    await page.$eval(region, (element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await settle();
    const metrics = await page.$eval(region, (element) => {
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
        controls: [...element.querySelectorAll('label, input')].map(bounds),
      };
    });
    assert.ok(metrics.documentWidth <= metrics.viewport.width + 1, `${name}: page fits`);
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${name}: shared bot list fits`);
    for (const box of [metrics.region, ...metrics.controls]) {
      assert.ok(box.width > 0 && box.height > 0, `${name}: control is painted`);
      assert.ok(
        box.x >= -1 && box.x + box.width <= metrics.viewport.width + 1,
        `${name}: control fits horizontally`,
      );
    }
    report.serviceSharing.views[name] = metrics;
    await page.screenshot({ path: join(artifactDir, `${name}.png`) });
  };
  const save = async (method) => {
    const response = page.waitForResponse(
      (response) =>
        response.url().startsWith(`${origin}/api/service-accounts`) &&
        response.request().method() === method,
    );
    await click('dialog[open]', 'サービスを保存');
    const result = await response;
    assert.equal(result.status(), 200);
    account = await result.json();
    await page.waitForSelector('dialog[open]', { hidden: true });
    return JSON.parse(result.request().postData());
  };

  store.put('bots', disabled);
  controller.changed();
  page.on('request', recordRequest);
  try {
    await openServices(1416, 900);
    await click('.accounts-toolbar', 'サービスを登録');
    await page.waitForSelector(region, { visible: true });
    await field('サービス名', name);
    await field('サービスURL', 'https://sharing.fixture.example/login');
    await field('ログイン名', 'sharing@example.test');
    await field('管理するボット', manager.id);
    assert.equal(await page.$(shareSelector(manager)), null, 'manager is not an extra share');
    assert.equal(await page.$eval(shareSelector(teammate), (input) => input.checked), false);
    assert.equal(await page.$eval(shareSelector(disabled), (input) => input.disabled), false);
    await page.click(shareSelector(teammate));
    await page.click(shareSelector(disabled));
    await capture('desktop-service-sharing');
    await page.click('dialog[open] details summary');
    await field('パスワードまたはAPIキー', secret);
    const created = await save('POST');
    assert.deepEqual(created.sharedBotIds, [teammate.id, disabled.id]);
    assert.deepEqual(account.sharedBotIds, [teammate.id, disabled.id]);
    assert.equal(account.botId, manager.id);
    assert.equal(account.credentialConfigured, true);
    const card = await page.$eval(
      `button[aria-label="${name}を編集"]`,
      (element) => element.closest('.service-card').textContent,
    );
    for (const bot of [manager, teammate, disabled]) assert.ok(card.includes(bot.name));
    report.serviceSharing.checks.push(
      'registration saves several explicit shared bots and shows them on the service card',
    );

    await openServices(390, 844);
    await click('#service-accounts-content', `${name}を編集`);
    await page.waitForSelector(region, { visible: true });
    assert.equal(await page.$eval(shareSelector(teammate), (input) => input.checked), true);
    assert.equal(await page.$eval(shareSelector(disabled), (input) => input.checked), true);
    await capture('mobile-service-sharing');
    await field('管理するボット', teammate.id);
    assert.equal(await page.$(shareSelector(teammate)), null);
    assert.equal(await page.$eval(shareSelector(manager), (input) => input.checked), false);
    await page.click(shareSelector(disabled));
    const updated = await save('PUT');
    assert.deepEqual(updated.sharedBotIds, []);
    assert.equal(Object.hasOwn(updated, 'credential'), false);
    assert.equal(account.botId, teammate.id);
    assert.deepEqual(account.sharedBotIds, []);
    assert.equal(readServiceCredential(store, account.id, account.revision).credential, secret);
    assert.deepEqual(
      store.list('mailAccounts').map(({ id, botIds }) => ({ id, botIds })),
      mailAssignments,
    );
    assert.equal(
      requests.some((request) => request.path.endsWith('/credential')),
      false,
    );
    report.serviceSharing.checks.push(
      'mobile editing revokes shares, transfers management without implicit grants, and retains the saved secret and mailbox permissions',
    );
  } finally {
    page.off('request', recordRequest);
    await page.keyboard.press('Escape').catch(() => {});
    if (account) {
      const current = getServiceAccount(store, account.id);
      removeServiceAccount(store, current.id, current.revision);
    }
    store.remove('bots', disabled.id);
    controller.changed();
  }
}
