import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Delete only synthetic rooms in the parent smoke's disposable data directory. */
export async function checkRoomDeletion({ instance, page, origin, artifactDir, report, settle }) {
  const { store, controller } = instance;
  const keptRoom = store.get('rooms', 'room_lounge');
  assert.ok(keptRoom);
  const roomId = 'ui_delete_room';
  const archiveId = 'ui_delete_archive';
  const stamp = new Date().toISOString();
  const name = '不要になった検証用Loom・削除対象';
  const archiveName = 'アーカイブ済みの削除検証';
  const workspacePath = join(store.dataDir, 'deletion-ui-workspace');
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, 'keep.txt'), 'Keep the user workspace.');
  const keptBot = structuredClone(store.get('bots', keptRoom.botIds[0]));
  const keptTask = structuredClone(store.list('tasks').find((task) => task.roomId === keptRoom.id));
  report.roomDeletion = { views: {}, checks: [] };
  for (const [id, roomName, archived] of [
    [roomId, name, false],
    [archiveId, archiveName, true],
  ]) {
    assert.equal(store.get('rooms', id), undefined);
    store.put('rooms', {
      ...keptRoom,
      id,
      name: roomName,
      archived,
      pinned: false,
      paused: false,
      workspacePath,
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  store.put('tasks', {
    id: 'ui_delete_task',
    roomId,
    botId: keptBot.id,
    prompt: 'Synthetic deletable work',
    status: 'running',
    kind: 'chat',
    rootTaskId: 'ui_delete_task',
    depth: 0,
    output: '',
    inputTokens: 0,
    outputTokens: 0,
    createdAt: stamp,
    updatedAt: stamp,
  });
  store.put('messages', {
    id: 'ui_delete_message',
    roomId,
    authorType: 'user',
    authorId: 'user',
    body: '削除するLoomだけに属する確認用の会話です。',
    status: 'complete',
    createdAt: stamp,
  });
  store.put('memories', {
    id: 'ui_delete_memory',
    roomId,
    botId: keptBot.id,
    content: '削除するLoomだけに属する記憶です。',
    createdAt: stamp,
    updatedAt: stamp,
  });
  controller.changed();

  const click = async (scope, label) => {
    const handle = await page.evaluateHandle(
      (scope, label) =>
        [...document.querySelector(scope).querySelectorAll('button')].find(
          (button) =>
            button.textContent.trim() === label ||
            button.getAttribute('aria-label') === label ||
            button.querySelector('.room-nav-name')?.textContent === label,
        ),
      scope,
      label,
    );
    try {
      assert.ok(handle.asElement(), `Missing deletion control: ${label}`);
      await handle.asElement().click();
    } finally {
      await handle.dispose();
    }
  };
  const capture = async (name) => {
    await settle();
    const metrics = await page.$eval('dialog[open] .room-deletion-confirm', (node) => {
      const box = (element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      const content = node.closest('.modal-content');
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        scrollWidth: content.scrollWidth,
        clientWidth: content.clientWidth,
        controls: [...node.querySelectorAll('button')].map(box),
      };
    });
    assert.ok(metrics.documentWidth <= metrics.viewport.width + 1, `${name}: page fits`);
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${name}: confirmation fits`);
    for (const box of metrics.controls) {
      assert.ok(box.width > 0 && box.height > 0);
      assert.ok(
        box.x >= -1 && box.x + box.width <= metrics.viewport.width + 1,
        `${name}: buttons fit`,
      );
    }
    report.roomDeletion.views[name] = metrics;
    await page.screenshot({ path: join(artifactDir, `${name}.png`) });
  };
  try {
    await page.setViewport({ width: 1416, height: 900, deviceScaleFactor: 1 });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('.room-nav-item')].some(
          (button) => button.querySelector('.room-nav-name')?.textContent === name,
        ),
      {},
      name,
    );
    await click('.room-nav', name);
    await page.waitForFunction(
      (name) => document.querySelector('.room-header h1')?.textContent === name,
      {},
      name,
    );
    await page.type('.composer textarea', '削除時に消える下書き');
    await page.click('.room-menu summary');
    await click('.room-menu', 'Loomを削除');
    await page.waitForSelector('dialog[open] .room-deletion-confirm');
    assert.match(await page.$eval('dialog[open]', (node) => node.textContent), /1件を停止/);
    await click('dialog[open]', 'キャンセル');
    assert.ok(store.get('rooms', roomId), 'Cancel preserves the room');
    assert.equal(
      store.get('tasks', 'ui_delete_task').status,
      'running',
      'Cancel does not stop work',
    );
    await page.click('.room-menu summary');
    await click('.room-menu', 'Loomを削除');
    await page.waitForSelector('dialog[open] .room-deletion-confirm');
    for (const [width, height] of [
      [1416, 900],
      [390, 844],
      [320, 740],
    ]) {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await capture(`room-deletion-${width}x${height}`);
    }
    const response = page.waitForResponse(
      (response) =>
        response.url() === `${origin}/api/rooms/${roomId}` &&
        response.request().method() === 'DELETE',
    );
    await click('dialog[open]', '停止して削除');
    const deleted = await response;
    assert.equal(deleted.status(), 200, await deleted.text());
    await page.waitForSelector('dialog[open] .room-deletion-confirm', { hidden: true });
    // The DELETE response can precede the refreshed selection and draft cleanup.
    await page.waitForFunction(
      (name, id) => {
        const header = document.querySelector('.room-header h1');
        const selectedId = localStorage.getItem('loom.room');
        return Boolean(
          header &&
          header.textContent !== name &&
          selectedId &&
          selectedId !== id &&
          !Object.hasOwn(JSON.parse(localStorage.getItem('loom.drafts') || '{}'), id),
        );
      },
      {},
      name,
      roomId,
    );
    for (const [kind, id] of [
      ['rooms', roomId],
      ['messages', 'ui_delete_message'],
      ['memories', 'ui_delete_memory'],
      ['tasks', 'ui_delete_task'],
    ])
      assert.equal(store.get(kind, id), undefined, `${kind} owned by the deleted room is gone`);
    assert.deepEqual(store.get('bots', keptBot.id), keptBot);
    if (keptTask) assert.deepEqual(store.get('tasks', keptTask.id), keptTask);
    assert.ok(store.get('rooms', keptRoom.id));
    assert.equal(
      await readFile(join(workspacePath, 'keep.txt'), 'utf8'),
      'Keep the user workspace.',
    );
    assert.equal(
      await page.evaluate(
        (id) => Object.hasOwn(JSON.parse(localStorage.getItem('loom.drafts') || '{}'), id),
        roomId,
      ),
      false,
    );
    report.roomDeletion.checks.push(
      'one confirmation stops and deletes the selected Loom through the real DELETE API; cancellation preserves activity; another room, shared bot and workspace file survive',
    );

    await page.setViewport({ width: 1416, height: 900, deviceScaleFactor: 1 });
    await page.click('.archived-rooms > button');
    await click('.archived-rooms', `${archiveName}を完全に削除`);
    await page.waitForSelector('dialog[open] .room-deletion-confirm');
    const archivedResponse = page.waitForResponse(
      (response) =>
        response.url() === `${origin}/api/rooms/${archiveId}` &&
        response.request().method() === 'DELETE',
    );
    await click('dialog[open]', '完全に削除');
    assert.equal((await archivedResponse).status(), 200);
    await page.waitForSelector('dialog[open] .room-deletion-confirm', { hidden: true });
    assert.equal(store.get('rooms', archiveId), undefined);
    report.roomDeletion.checks.push(
      'archived Looms can be permanently deleted directly; the confirmation fits desktop, 390px and 320px without horizontal overflow; deleted-room drafts are removed',
    );
    report.checks.push(...report.roomDeletion.checks);
  } catch (error) {
    await page.screenshot({ path: join(artifactDir, 'room-deletion-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
    // The whole parent fixture is temporary; only these synthetic records are cleaned here.
    for (const [kind, id] of [
      ['messages', 'ui_delete_message'],
      ['memories', 'ui_delete_memory'],
      ['tasks', 'ui_delete_task'],
      ['rooms', roomId],
      ['rooms', archiveId],
    ])
      store.remove(kind, id);
    controller.changed();
  }
}
