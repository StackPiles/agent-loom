import assert from 'node:assert/strict';
import { join } from 'node:path';

// Exercise the real registration API with synthetic bots and a synthetic secret.
// Sharing service access must leave linked mailbox permissions and secrets intact.
export async function checkServiceSharing({ instance, page, origin, artifactDir, report, settle }) {
  const { getServiceAccount, saveServiceAccount, readServiceCredential, removeServiceAccount } =
    await import('../dist/server/service-accounts.js');
  const { store, controller } = instance;
  const manager = store.get('bots', 'bot_aster');
  const teammate = store.get('bots', 'bot_nova');
  const currentRoom = store.get('rooms', 'room_lounge');
  const alternateId = 'ui_service_other_room';
  const holdingId = 'ui_service_holding_room';
  const disabled = {
    ...teammate,
    id: 'ui_service_shared_disabled',
    name: '停止中の共有ボット',
    handle: 'sharing_disabled',
    enabled: false,
  };
  const outsider = {
    ...teammate,
    id: 'ui_service_other_room_bot',
    name: '別ルームのボット',
    handle: 'service_other_room',
    enabled: true,
  };
  const name = '共有設定の検証用サービス';
  const secret = 'fixture-only-service-sharing-secret';
  const region = 'dialog[open] .service-sharing-section';
  const scopeRegion = 'dialog[open] .service-room-scope';
  const requests = [];
  const mailAssignments = store.list('mailAccounts').map(({ id, botIds }) => ({ id, botIds }));
  const createdIds = new Set();
  let account;
  report.serviceSharing = { views: {}, checks: [] };
  assert.ok(currentRoom && !currentRoom.archived);
  for (const id of [disabled.id, outsider.id]) assert.equal(store.get('bots', id), undefined);
  for (const id of [alternateId, holdingId]) assert.equal(store.get('rooms', id), undefined);
  const recordRequest = (request) => {
    if (request.url().startsWith(`${origin}/api/service-accounts`))
      requests.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
        body: request.postData() ? JSON.parse(request.postData()) : undefined,
      });
  };
  const click = async (scope, label) => {
    const handle = await page.waitForFunction(
      (scope, label) => {
        const button = [...(document.querySelector(scope)?.querySelectorAll('button') || [])].find(
          (element) =>
            element.textContent.trim() === label || element.getAttribute('aria-label') === label,
        );
        return button?.checkVisibility() ? button : false;
      },
      { timeout: 5_000 },
      scope,
      label,
    );
    const element = handle.asElement();
    assert.ok(element, `Missing service button: ${label}`);
    try {
      await element.evaluate((node) =>
        node.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
      await page.waitForFunction(
        (node) => {
          const bounds = node.getBoundingClientRect();
          return (
            !node.disabled &&
            node.contains(
              document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
            )
          );
        },
        { timeout: 3_000 },
        element,
      );
      await element.click();
    } finally {
      await handle.dispose();
    }
  };
  const withField = async (label, operation) => {
    const handle = await page.waitForFunction(
      (label) => {
        const input = [...document.querySelectorAll('dialog[open] label.field')]
          .find((element) => element.querySelector('.field-label')?.textContent === label)
          ?.querySelector('input,select');
        return input?.checkVisibility() ? input : false;
      },
      { timeout: 5_000 },
      label,
    );
    const element = handle.asElement();
    assert.ok(element, `Missing service field: ${label}`);
    try {
      return await operation(element);
    } finally {
      await handle.dispose();
    }
  };
  const field = (label, value) =>
    withField(label, async (element) => {
      if ((await element.evaluate((element) => element.tagName)) === 'SELECT')
        await element.select(value);
      else {
        await element.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.keyboard.sendCharacter(value);
      }
    });
  const roomScope = () =>
    withField('対象ルーム', (element) => element.evaluate((node) => node.value));
  const chooseRoom = async (id) => {
    await withField('対象ルーム', async (element) => {
      const choices = await element.evaluate((node) =>
        [...node.options].filter((option) => !option.disabled).map((option) => option.value),
      );
      const index = choices.indexOf(id);
      assert.ok(index >= 0, `Room scope is selectable: ${id}`);
      await element.focus();
      await page.keyboard.press('Home');
      for (let step = 0; step < index; step++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Tab');
    });
    assert.equal(await roomScope(), id, 'keyboard selects the requested service scope');
  };
  const dismissNotices = async () => {
    for (let index = 0; index < 4; index++) {
      const dismiss = await page.$('.toast-stack .toast > button');
      if (!dismiss) break;
      try {
        await dismiss.click();
        await page.waitForFunction((node) => !node.isConnected, { timeout: 3_000 }, dismiss);
      } finally {
        await dismiss.dispose();
      }
    }
    await page.waitForSelector('.toast-stack .toast', { hidden: true, timeout: 3_000 });
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
  const capture = async (name, selector = region) => {
    await page.$eval(selector, (element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await settle();
    const metrics = await page.$eval(selector, (element) => {
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
        editorClientWidth: element.closest('.modal-content').clientWidth,
        editorScrollWidth: element.closest('.modal-content').scrollWidth,
        controls: [...element.querySelectorAll('label, input, select')].map(bounds),
      };
    });
    assert.ok(metrics.documentWidth <= metrics.viewport.width + 1, `${name}: page fits`);
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${name}: shared bot list fits`);
    assert.ok(metrics.editorScrollWidth <= metrics.editorClientWidth + 1, `${name}: editor fits`);
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
    if (method === 'POST') createdIds.add(account.id);
    const body = JSON.parse(result.request().postData());
    assert.equal(Object.hasOwn(body, 'roomId'), true, 'every owner save explicitly sends scope');
    assert.equal(account.roomId, body.roomId);
    await page.waitForSelector('dialog[open]', { hidden: true });
    await dismissNotices();
    return body;
  };

  store.put('bots', disabled);
  store.put('bots', outsider);
  store.put('rooms', { ...currentRoom, botIds: [...currentRoom.botIds, disabled.id] });
  store.put('rooms', {
    ...currentRoom,
    id: alternateId,
    name: '別ルームのサービス検証',
    botIds: [manager.id, teammate.id, outsider.id],
    pinned: false,
    paused: true,
    autonomousWakeups: { mode: 'off' },
  });
  store.put('rooms', {
    ...currentRoom,
    id: holdingId,
    name: 'サービスの整理待ち',
    botIds: [],
    pinned: false,
    paused: true,
    archived: true,
    autonomousWakeups: { mode: 'off' },
  });
  controller.changed();
  page.on('request', recordRequest);
  try {
    await openServices(1416, 900);
    await click('.accounts-toolbar', 'サービスを登録');
    await page.waitForSelector(region, { visible: true });
    assert.equal(await roomScope(), currentRoom.id, 'new service defaults to the current room');
    assert.equal(
      await page.$(shareSelector(outsider)),
      null,
      'other-room bots are not new share choices',
    );
    assert.equal(
      await withField('管理するボット', (element) =>
        element.evaluate(
          (node, id) => [...node.options].some((option) => option.value === id),
          outsider.id,
        ),
      ),
      false,
    );
    await capture('service-scope-desktop-1416x900', scopeRegion);
    await chooseRoom(alternateId);
    await chooseRoom(currentRoom.id);
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
    await page.click('dialog[open] [data-service-credential-section] summary');
    await field('パスワードまたはAPIキー', secret);
    const created = await save('POST');
    assert.equal(created.roomId, currentRoom.id);
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
      'registration defaults to the current room, supports keyboard scope selection, and only offers that room’s bots including disabled members',
      'registration saves several explicit shared bots and shows their room scope on the service card',
    );

    await openServices(390, 844);
    await click('#service-accounts-content', `${name}を編集`);
    await page.waitForSelector(region, { visible: true });
    assert.equal(await roomScope(), currentRoom.id);
    assert.equal(await page.$eval(shareSelector(teammate), (input) => input.checked), true);
    assert.equal(await page.$eval(shareSelector(disabled), (input) => input.checked), true);
    await chooseRoom(alternateId);
    assert.equal(
      await page.$eval(shareSelector(disabled), (input) => input.checked),
      true,
      'scope change retains saved recipients',
    );
    assert.match(
      await page.$eval(shareSelector(disabled), (input) => input.closest('label').textContent),
      /対象ルームでは利用不可/,
    );
    assert.equal(
      await page.$eval('dialog[open] button[type="submit"]', (button) => button.disabled),
      true,
    );
    await chooseRoom(currentRoom.id);
    await capture('mobile-service-sharing');
    await field('管理するボット', teammate.id);
    assert.equal(await page.$(shareSelector(teammate)), null);
    assert.equal(await page.$eval(shareSelector(manager), (input) => input.checked), false);
    await page.click(shareSelector(disabled));
    await chooseRoom('');
    assert.match(
      await withField('対象ルーム', (element) =>
        element.evaluate((node) => node.selectedOptions[0].textContent),
      ),
      /明示的に共有/,
    );
    assert.ok(
      await page.$(shareSelector(outsider)),
      'explicit global scope makes other-room sharing available',
    );
    const updated = await save('PUT');
    assert.equal(updated.roomId, null);
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
      'mobile scope changes retain unavailable recipients and block saving until access is corrected; all-room sharing requires a deliberate choice and sends null',
      'mobile editing revokes shares, transfers management without implicit grants, and retains the saved secret and mailbox permissions',
    );

    const holdingName = '整理待ちのサービス検証';
    const linkedMail = store.list('mailAccounts').find((mail) => mail.botIds.includes(manager.id));
    const held = saveServiceAccount(store, {
      name: holdingName,
      url: 'https://holding.fixture.example/login',
      login: 'held@example.test',
      botId: manager.id,
      sharedBotIds: [teammate.id, disabled.id],
      roomId: currentRoom.id,
      mailAccountId: linkedMail?.id || null,
      status: 'disabled',
      notes: '整理待ちの内容をそのまま保持します。',
      credential: `${secret}-held`,
    });
    createdIds.add(held.id);
    // Model migration without registering a new runnable service in an archived room.
    store.put('serviceAccounts', { ...held, roomId: holdingId });
    controller.changed();
    await page.waitForSelector(`button[aria-label="${holdingName}を編集"]`, { visible: true });
    const holdingCard = await page.$eval(
      `button[aria-label="${holdingName}を編集"]`,
      (button) => button.closest('.service-card').textContent,
    );
    assert.match(holdingCard, /サービスの整理待ち.*アーカイブ/s);
    await click('#service-accounts-content', `${holdingName}を編集`);
    assert.equal(await roomScope(), holdingId);
    assert.match(
      await page.$eval(scopeRegion, (node) => node.textContent),
      /稼働中のルームでは利用されません/,
    );
    for (const [width, height] of [
      [390, 844],
      [320, 740],
    ]) {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await capture(`service-scope-archived-mobile-${width}x${height}`, scopeRegion);
    }
    await chooseRoom(currentRoom.id);
    assert.equal(
      await withField('管理するボット', (element) => element.evaluate((node) => node.value)),
      manager.id,
    );
    assert.equal(await page.$eval(shareSelector(teammate), (input) => input.checked), true);
    assert.equal(await page.$eval(shareSelector(disabled), (input) => input.checked), true);
    const reassigned = await save('PUT');
    assert.equal(account.id, held.id);
    for (const key of ['name', 'url', 'login', 'botId', 'mailAccountId', 'status', 'notes'])
      assert.equal(account[key], held[key], `reassignment retains ${key}`);
    assert.equal(account.roomId, currentRoom.id);
    assert.deepEqual(account.sharedBotIds, held.sharedBotIds);
    assert.equal(Object.hasOwn(reassigned, 'credential'), false);
    assert.equal(
      readServiceCredential(store, account.id, account.revision).credential,
      `${secret}-held`,
    );
    assert.deepEqual(
      store.list('mailAccounts').map(({ id, botIds }) => ({ id, botIds })),
      mailAssignments,
    );
    assert.equal(
      requests.some((request) => request.path.endsWith('/credential')),
      false,
    );
    report.serviceSharing.checks.push(
      'archived holding-room services expose a reassignment control and notice at 390px and 320px without horizontal overflow',
      'reassigning a held service preserves manager, disabled/shared bots, credential, status, notes, and linked mail without reading its secret',
    );
    report.checks.push(...report.serviceSharing.checks);
  } catch (error) {
    await page.screenshot({ path: join(artifactDir, 'service-scope-failure.png') }).catch(() => {});
    throw error;
  } finally {
    page.off('request', recordRequest);
    await page.keyboard.press('Escape').catch(() => {});
    for (const id of createdIds) {
      const current = getServiceAccount(store, id);
      removeServiceAccount(store, current.id, current.revision);
    }
    store.remove('bots', disabled.id);
    store.remove('bots', outsider.id);
    store.put('rooms', currentRoom);
    store.remove('rooms', alternateId);
    store.remove('rooms', holdingId);
    controller.changed();
  }
}
