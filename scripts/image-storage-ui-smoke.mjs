import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Synthetic, app-owned originals only. No external provider or user files are used.
export async function checkImageStorage({ instance, page, origin, artifactDir, report, settle }) {
  const { store, controller } = instance;
  const roomId = 'ui_storage_room';
  const roomName = '画像の保存を確認';
  const messageId = 'ui_storage_message';
  const stamp = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const images = [];
  const savedPolicy = store.get('imageStorageSettings', 'main');
  const savedCleanup = store.get('imageStorageCleanup', 'last');
  const cleanupRequests = [];
  const inspectRequest = (request) => {
    if (request.url() === `${origin}/api/image-storage/cleanup` && request.method() === 'POST')
      cleanupRequests.push(JSON.parse(request.postData()));
  };
  report.imageStorage = { checks: [], views: {} };
  const click = async (scope, label) => {
    const handle = await page.evaluateHandle(
      (selector, text) =>
        [...document.querySelector(selector).querySelectorAll('button')].find(
          (button) => button.textContent.trim() === text,
        ),
      scope,
      label,
    );
    assert.ok(await handle.asElement(), `Storage control exists: ${label}`);
    await handle.asElement().click();
    await handle.dispose();
  };
  const openSettings = async (width, height) => {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const settings = await page.waitForSelector('#loom-navigation button[aria-label="設定"]');
    if (!(await settings.isIntersectingViewport()))
      await page.click('button[aria-label="メニューを開く"]');
    await settings.click();
    await page.waitForSelector('.storage-section');
    await click('.storage-section', '管理を開く');
    await page.waitForSelector('.storage-image-row');
    await page.waitForFunction(
      () => document.querySelector('#image-storage-panel')?.getAttribute('aria-busy') === 'false',
    );
  };
  const capture = async (name, selector = '.storage-gallery') => {
    await page.$eval(selector, (element) => element.scrollIntoView({ block: 'start' }));
    await settle();
    const metrics = await page.$eval(selector, (element) => {
      const box = (node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        panel: box(element),
        controls: [...element.querySelectorAll('button, select, input')]
          .filter((node) => node.getClientRects().length)
          .map(box),
      };
    });
    assert.ok(metrics.documentWidth <= metrics.viewport.width + 1, `${name}: no page overflow`);
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${name}: no panel overflow`);
    for (const bounds of [metrics.panel, ...metrics.controls])
      assert.ok(
        bounds.x >= -1 && bounds.x + bounds.width <= metrics.viewport.width + 1,
        `${name}: controls fit horizontally`,
      );
    report.imageStorage.views[name] = metrics;
    await page.screenshot({ path: join(artifactDir, `${name}.png`) });
  };
  page.on('request', inspectRequest);
  try {
    store.put('imageStorageSettings', { id: 'main', autoCleanup: false, unusedDays: 30 });
    store.put('rooms', {
      id: roomId,
      name: roomName,
      description: 'Synthetic storage cleanup check.',
      botIds: ['bot_aster'],
      pinned: false,
      archived: false,
      createdAt: stamp,
      updatedAt: stamp,
    });
    await mkdir(join(store.dataDir, 'generated-images'), { recursive: true });
    for (const [index, filename] of [
      '残す候補.png',
      '整理する候補.png',
      '添付した資料.png',
    ].entries()) {
      const encoded = await page.evaluate((value) => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext('2d');
        context.fillStyle = ['#edf3e7', '#f3e9dc', '#e6edf2'][value];
        context.fillRect(0, 0, 320, 180);
        context.fillStyle = '#405334';
        context.font = 'bold 22px sans-serif';
        context.fillText(`STORAGE IMAGE ${value + 1}`, 30, 100);
        return canvas.toDataURL('image/png').split(',')[1];
      }, index);
      const content = Buffer.from(encoded, 'base64');
      const id = `img_${createHash('sha256').update(`image-storage-ui:${filename}`).digest('hex')}`;
      const hash = createHash('sha256').update(content).digest('hex');
      const image = {
        id,
        type: 'image',
        mimeType: 'image/png',
        filename,
        byteLength: content.length,
        prompt: `Synthetic image storage fixture ${index + 1}.`,
        model: 'local-ui-fixture',
        createdAt: stamp,
        source: index === 2 ? 'uploaded' : 'generated',
      };
      images.push(image);
      await writeFile(join(store.dataDir, 'generated-images', `${id}.png`), content);
      store.put('images', image);
      store.put('imageRetention', {
        id,
        initializedAt: stamp,
        lastUsedAt: stamp,
        protected: index === 2,
        contentHash: hash,
      });
    }
    store.put('messages', {
      id: messageId,
      roomId,
      authorType: 'user',
      authorId: 'user',
      body: '画像管理の固定テストです。',
      status: 'complete',
      attachments: images,
      createdAt: stamp,
    });
    controller.changed();
    await openSettings(1416, 900);
    await page.waitForSelector(`.storage-image-row[data-image-id="${images[0].id}"]`);
    await capture('storage-desktop-1416x900', '.storage-section');
    await page.click(`.storage-image-row[data-image-id="${images[0].id}"] input`);
    await click('.storage-selection', '残す');
    await page.waitForSelector(`.storage-image-row[data-image-id="${images[0].id}"]`, {
      hidden: true,
    });
    assert.equal(store.get('imageRetention', images[0].id).protected, true);
    assert.equal(
      store.get('imageRetention', images[0].id).lastUsedAt,
      stamp,
      'thumbnail views do not mark an original used',
    );
    assert.equal(store.get('imageRetention', images[2].id).protected, true);
    await page.click(`.storage-image-row[data-image-id="${images[1].id}"] input`);
    await click('.storage-selection', '整理する画像を確認');
    await page.waitForSelector('dialog[open] .storage-cleanup-list');
    assert.match(
      await page.$eval('dialog[open]', (dialog) => dialog.textContent),
      /整理する候補.png/,
    );
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog[open]', { hidden: true });
    assert.deepEqual(cleanupRequests, []);
    assert.equal(store.get('imageRetention', images[1].id).deletedAt, undefined);
    report.imageStorage.checks.push(
      'storage expands on demand, protects the selected original, preserves uploaded images, and Escape cancels cleanup without a request',
    );

    await openSettings(390, 844);
    await page.waitForSelector(`.storage-image-row[data-image-id="${images[1].id}"]`);
    await capture('storage-mobile-390x844');
    await page.click(`.storage-image-row[data-image-id="${images[1].id}"] input`);
    await click('.storage-selection', '整理する画像を確認');
    await page.waitForSelector('dialog[open] .storage-cleanup-list');
    await capture('storage-cleanup-mobile-390x844', 'dialog[open]');
    await click('dialog[open]', '1枚の原本を整理');
    await page.waitForSelector('dialog[open]', { hidden: true });
    assert.deepEqual(cleanupRequests, [{ imageIds: [images[1].id] }]);
    assert.ok(store.get('imageRetention', images[1].id).deletedAt);
    assert.equal(store.get('imageRetention', images[0].id).deletedAt, undefined);
    assert.equal(store.get('imageRetention', images[2].id).deletedAt, undefined);
    assert.equal(store.get('messages', messageId).body, '画像管理の固定テストです。');

    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const roomButton = await page.waitForSelector(`.room-nav button[aria-label="${roomName}"]`);
    if (!(await roomButton.isIntersectingViewport()))
      await page.click('button[aria-label="メニューを開く"]');
    await roomButton.click();
    const retired = `[data-message-id="${messageId}"] [data-image-id="${images[1].id}"]`;
    await page.waitForSelector(`${retired} .generated-image-cleaned`);
    assert.equal(
      await page.$$eval(
        `${retired} img, ${retired} .generated-image-download`,
        (nodes) => nodes.length,
      ),
      0,
    );
    assert.match(
      await page.$eval(retired, (card) => card.textContent),
      /Synthetic image storage fixture 2/,
    );
    await capture('storage-retired-image-mobile-390x844', retired);
    report.imageStorage.checks.push(
      'mobile selection sends only the reviewed ID, keeps other originals and conversation text, and renders a retired image without broken pixels or download links',
    );
  } finally {
    page.off('request', inspectRequest);
    for (const image of images) {
      store.remove('images', image.id);
      store.remove('imageRetention', image.id);
      await rm(join(store.dataDir, 'generated-images', `${image.id}.png`), { force: true });
    }
    store.remove('messages', messageId);
    store.remove('rooms', roomId);
    if (savedPolicy) store.put('imageStorageSettings', savedPolicy);
    else store.remove('imageStorageSettings', 'main');
    if (savedCleanup) store.put('imageStorageCleanup', savedCleanup);
    else store.remove('imageStorageCleanup', 'last');
    controller.changed();
  }
}
