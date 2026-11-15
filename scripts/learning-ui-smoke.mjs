import assert from 'node:assert/strict';
import { join } from 'node:path';

// Exercise owner scope selection against the real API using only disposable data.
export async function checkLearningScope({ instance, page, origin, artifactDir, report, settle }) {
  const { store, controller } = instance;
  const currentRoom = store.get('rooms', 'room_lounge');
  const alternateId = 'ui_learning_other_room';
  const holdingId = 'ui_learning_review_room';
  const holdingMemoryId = 'ui_learning_review_memory';
  const holdingText = '保存元のルームを確認してから割り当てる、検証専用の記憶です。';
  const created = [];
  const stamp = new Date().toISOString();
  report.learningScope = { views: {}, checks: [] };
  assert.ok(currentRoom && !currentRoom.archived);
  for (const id of [alternateId, holdingId]) assert.equal(store.get('rooms', id), undefined);
  assert.equal(store.get('memories', holdingMemoryId), undefined);

  const clickText = async (scope, label) => {
    const handle = await page.evaluateHandle(
      (scope, label) =>
        [...document.querySelector(scope).querySelectorAll('button')].find(
          (element) =>
            element.textContent.trim() === label || element.getAttribute('aria-label') === label,
        ),
      scope,
      label,
    );
    try {
      assert.ok(handle.asElement(), `Missing learning button: ${label}`);
      await handle.asElement().click();
    } finally {
      await handle.dispose();
    }
  };
  const withField = async (label, operation) => {
    // React commits the dialog and then opens it from an effect. A completed
    // browser click does not establish that the labeled field is visible yet.
    const handle = await page.waitForFunction(
      (label) => {
        const field = [...document.querySelectorAll('dialog[open] label.field')]
          .find((element) => element.querySelector('.field-label')?.textContent === label)
          ?.querySelector('input,select,textarea');
        return field?.checkVisibility() ? field : false;
      },
      { timeout: 5_000 },
      label,
    );
    try {
      assert.ok(handle.asElement(), `Missing learning field: ${label}`);
      return await operation(handle.asElement());
    } finally {
      await handle.dispose();
    }
  };
  const fill = (label, value) =>
    withField(label, async (element) => {
      await element.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.keyboard.sendCharacter(value);
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
    assert.equal(await roomScope(), id, 'keyboard selects exactly the requested room scope');
  };
  const save = async (kind, id) => {
    const path = `/api/${kind}${id ? '/' + id : ''}`;
    const response = page.waitForResponse(
      (item) =>
        new URL(item.url()).pathname === path &&
        item.request().method() === (id ? 'PATCH' : 'POST'),
    );
    await clickText('dialog[open]', '保存');
    const accepted = await response;
    assert.equal(accepted.status(), 200);
    const record = await accepted.json();
    if (!id) created.push({ kind, id: record.id });
    const body = JSON.parse(accepted.request().postData());
    assert.equal(Object.hasOwn(body, 'roomId'), true, 'every owner write carries explicit scope');
    assert.equal(record.roomId, body.roomId);
    await page.waitForSelector('dialog[open]', { hidden: true });
    return record;
  };
  const capture = async (name) => {
    await page.$eval('dialog[open] .form-grid', (element) => {
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
      if (element.nextElementSibling?.matches('.learning-status-note'))
        element.nextElementSibling.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
    await settle();
    const metrics = await page.$eval('dialog[open] .form-grid', (element) => {
      const box = (node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      const container = element.closest('.modal-content');
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        clientWidth: container.clientWidth,
        scrollWidth: container.scrollWidth,
        region: box(element),
        controls: [...element.querySelectorAll('label, select')].map(box),
      };
    });
    assert.ok(metrics.documentWidth <= metrics.viewport.width + 1, `${name}: page fits`);
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${name}: editor fits`);
    for (const bounds of [metrics.region, ...metrics.controls]) {
      assert.ok(bounds.width > 0 && bounds.height > 0, `${name}: scope controls are painted`);
      assert.ok(
        bounds.x >= -1 && bounds.x + bounds.width <= metrics.viewport.width + 1,
        `${name}: scope controls fit horizontally`,
      );
    }
    report.learningScope.views[name] = metrics;
    await page.screenshot({ path: join(artifactDir, `${name}.png`) });
  };

  store.put('rooms', {
    ...currentRoom,
    id: alternateId,
    name: '別ルームの記憶検証',
    pinned: false,
    createdAt: stamp,
    updatedAt: stamp,
  });
  store.put('rooms', {
    ...currentRoom,
    id: holdingId,
    name: '記憶・スキルの整理待ち',
    botIds: [],
    paused: true,
    autonomousWakeups: { mode: 'off' },
    archived: true,
    pinned: false,
    createdAt: stamp,
    updatedAt: stamp,
  });
  store.put('memories', {
    id: holdingMemoryId,
    botId: 'bot_aster',
    roomId: holdingId,
    content: holdingText,
    version: 1,
    status: 'active',
    locked: true,
    evidence: 'Synthetic migration holding-room fixture.',
    revisions: [],
    createdAt: stamp,
    updatedAt: stamp,
  });
  controller.changed();
  try {
    await page.setViewport({ width: 1416, height: 900, deviceScaleFactor: 1 });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button[aria-label="記憶とスキル"]');
    await page.click('button[aria-label="記憶とスキル"]');
    await page.waitForSelector('.learning-page .page-tabs');
    await page.click('.learning-page .page-tabs button:nth-child(2)');
    await clickText('.learning-page', '記憶を追加');
    assert.equal(await roomScope(), currentRoom.id);
    await fill('内容', 'このルームだけで使用する、検証専用の手順です。');
    await capture('learning-scope-desktop-1416x900');
    await chooseRoom(alternateId);
    assert.equal((await save('memories')).roomId, alternateId);

    await clickText('.learning-page', '記憶を追加');
    assert.equal(await roomScope(), currentRoom.id);
    await fill('内容', '全ルームへの共有を明示的に選ぶ、検証専用の記憶です。');
    await chooseRoom('');
    assert.match(await page.$eval('dialog[open]', (node) => node.textContent), /明示的に共有/);
    assert.equal((await save('memories')).roomId, null);
    await page.click('.learning-page .page-tabs button:first-child');
    await clickText('.learning-page', 'スキルを追加');
    assert.equal(await roomScope(), currentRoom.id);
    await fill('名前', 'このルームの検証用スキル');
    await fill('手順（Markdown）', 'このルームの目的と結果を確認します。');
    assert.equal((await save('skills')).roomId, currentRoom.id);
    report.learningScope.checks.push(
      'new memories and skills default to the current room; keyboard selection routes to one other room; all-room sharing requires a deliberate choice and sends roomId null',
    );

    await page.click('.learning-page .page-tabs button:nth-child(2)');
    const holdingCard = await page.evaluateHandle(
      (text) =>
        [...document.querySelectorAll('.memory-card')].find((card) =>
          card.textContent.includes(text),
        ),
      holdingText,
    );
    try {
      assert.ok(holdingCard.asElement());
      assert.match(await holdingCard.evaluate((node) => node.textContent), /整理待ち.*アーカイブ/s);
      const edit = await holdingCard.asElement().$('button[aria-label="編集と履歴"]');
      assert.ok(edit);
      try {
        await edit.click();
      } finally {
        await edit.dispose();
      }
    } finally {
      await holdingCard.dispose();
    }
    assert.equal(await roomScope(), holdingId);
    assert.match(
      await page.$eval('dialog[open]', (node) => node.textContent),
      /稼働中のルームでは参照されません/,
    );
    for (const [width, height] of [
      [390, 844],
      [320, 740],
    ]) {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await capture(`learning-scope-archived-mobile-${width}x${height}`);
    }
    await chooseRoom(currentRoom.id);
    const reassigned = await save('memories', holdingMemoryId);
    assert.equal(reassigned.roomId, currentRoom.id);
    assert.equal(reassigned.botId, 'bot_aster');
    assert.equal(reassigned.locked, true);
    assert.equal(reassigned.status, 'active');
    assert.equal(reassigned.content, holdingText);
    report.learningScope.checks.push(
      'archived holding-room records remain visible and reassignable; the notice and controls fit desktop, 390px and 320px layouts without horizontal overflow',
    );
    report.checks.push(...report.learningScope.checks);
  } catch (error) {
    // Preserve the actual failing state before cleanup closes the dialog and
    // removes synthetic records; the parent also captures its final state.
    await page
      .screenshot({ path: join(artifactDir, 'learning-scope-failure.png') })
      .catch(() => {});
    throw error;
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
    for (const { kind, id } of created) store.remove(kind, id);
    store.remove('memories', holdingMemoryId);
    store.remove('rooms', holdingId);
    store.remove('rooms', alternateId);
    controller.changed();
  }
}
