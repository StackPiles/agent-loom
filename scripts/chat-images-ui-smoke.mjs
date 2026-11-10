import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// All pixels and messages are synthetic. The fixture runtime never calls a model.
export async function checkChatImages({ instance, page, origin, artifactDir, report, settle }) {
  const { store, controller } = instance;
  const savedModel = store.settings().model;
  const roomId = 'ui_chat_images_room';
  const roomName = '画像の添付を確認';
  const attach = '.composer button[aria-label="画像を添付"]';
  const send = '.composer button[aria-label="送信"]';
  const fixturePath = join(artifactDir, 'chat-image-fixture.png');
  report.chatImages = { checks: [], views: {} };
  const openRoom = async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const roomSelector = `.room-nav button[aria-label="${roomName}"]`;
    const roomButton = await page.waitForSelector(roomSelector);
    if (!(await roomButton.isIntersectingViewport()))
      await page.click('button[aria-label="メニューを開く"]');
    await page.click(roomSelector);
    await page.waitForFunction(
      (name) => document.querySelector('.room-heading h1')?.textContent === name,
      {},
      roomName,
    );
    await page.waitForSelector(attach, { visible: true });
  };
  try {
    // Earlier checks leave message-less stopped tasks in room_lounge. Those
    // standalone cards render below messages, so isolate this send/scroll check.
    const stamp = new Date().toISOString();
    store.put('rooms', {
      id: roomId,
      name: roomName,
      description: 'Independent synthetic image attachment check.',
      botIds: ['bot_aster'],
      parallelResponses: false,
      paused: false,
      pinned: false,
      archived: false,
      createdAt: stamp,
      updatedAt: stamp,
    });
    store.patch('settings', 'main', { model: { ...savedModel, imageInput: true } });
    controller.changed();
    await page.setViewport({ width: 1416, height: 900, deviceScaleFactor: 1 });
    await openRoom();
    const encoded = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d');
      context.fillStyle = '#edf3e7';
      context.fillRect(0, 0, 320, 180);
      context.fillStyle = '#728b5f';
      context.fillRect(26, 28, 68, 68);
      context.fillStyle = '#405334';
      context.font = 'bold 20px sans-serif';
      context.fillText('IMAGE ATTACHMENT', 26, 140);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await writeFile(fixturePath, Buffer.from(encoded, 'base64'));
    const picker = await page.$('.composer input[type="file"]');
    await picker.uploadFile(fixturePath);
    await page.waitForSelector('.composer-image-thumb img', { visible: true });
    await page.waitForFunction((selector) => !document.querySelector(selector).disabled, {}, send);
    await settle();
    await page.screenshot({ path: join(artifactDir, 'desktop-chat-image-draft.png') });
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url() === `${origin}/api/rooms/${roomId}/messages` &&
        response.request().method() === 'POST',
    );
    await page.click(send);
    const response = await responsePromise;
    assert.equal(response.status(), 200, 'image-only message is accepted by the real route');
    const payload = JSON.parse(response.request().postData());
    assert.equal(payload.body, '');
    assert.equal(payload.images.length, 1);
    assert.equal(payload.images[0].data, encoded);
    const result = await response.json();
    const image = result.message.attachments[0];
    assert.equal(image.source, 'uploaded');
    assert.deepEqual(result.tasks[0].inputImageIds, [image.id]);
    const sentImage = `[data-message-id="${result.message.id}"] [data-image-id="${image.id}"] img`;
    await page.waitForSelector(sentImage, { visible: true });
    await page.waitForSelector('.composer-image-item', { hidden: true });
    const readback = await page.evaluate(async (id) => {
      const response = await fetch(`/api/images/${id}`);
      return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
    }, image.id);
    assert.equal(readback.status, 200);
    assert.equal(readback.bytes, Buffer.from(encoded, 'base64').length);
    await settle();
    // Puppeteer's visible:true accepts offscreen elements. Verify the full card
    // is inside the conversation viewport without scrolling it into view here.
    await page.waitForFunction(
      (selector) => {
        const image = document.querySelector(selector);
        const card = image?.closest('[data-image-id]')?.getBoundingClientRect();
        const viewport = image?.closest('.message-scroll')?.getBoundingClientRect();
        return (
          image?.complete &&
          image.naturalWidth > 0 &&
          card &&
          viewport &&
          card.top >= viewport.top - 1 &&
          card.bottom <= viewport.bottom + 1
        );
      },
      {},
      sentImage,
    );
    const sentMetrics = await page.$eval(sentImage, (image) => {
      const bounds = (element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      const rectangle = image.getBoundingClientRect();
      const front = document.elementFromPoint(
        rectangle.x + rectangle.width / 2,
        rectangle.y + rectangle.height / 2,
      );
      return {
        viewport: { width: innerWidth, height: innerHeight },
        conversation: bounds(image.closest('.message-scroll')),
        card: bounds(image.closest('[data-image-id]')),
        image: bounds(image),
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        unobscured: !!front && image.closest('.generated-image-preview').contains(front),
      };
    });
    for (const bounds of [sentMetrics.card, sentMetrics.image]) {
      const conversation = sentMetrics.conversation;
      assert.ok(bounds.width > 0 && bounds.height > 0, 'sent image is painted');
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= sentMetrics.viewport.width + 1);
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= sentMetrics.viewport.height + 1);
      assert.ok(bounds.x >= conversation.x - 1);
      assert.ok(bounds.x + bounds.width <= conversation.x + conversation.width + 1);
      assert.ok(bounds.y >= conversation.y - 1);
      assert.ok(bounds.y + bounds.height <= conversation.y + conversation.height + 1);
    }
    assert.equal(sentMetrics.naturalWidth, 320);
    assert.equal(sentMetrics.naturalHeight, 180);
    assert.equal(sentMetrics.unobscured, true, 'sent image is visible in front of other content');
    report.chatImages.views.desktopSent = sentMetrics;
    await page.screenshot({ path: join(artifactDir, 'desktop-chat-image-sent.png') });
    report.chatImages.checks.push(
      'real file selection sends an image-only message, saves pixels and binds the task input',
      'the sent image card is fully visible in the conversation viewport without corrective scrolling',
    );

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await openRoom();
    await page.evaluate((data) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([bytes], 'pasted-reference.png', { type: 'image/png' }));
      document.querySelector('.composer textarea').dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
      const dropped = new DataTransfer();
      dropped.items.add(new File([bytes], 'dropped-reference.png', { type: 'image/png' }));
      document.querySelector('form.composer').dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dropped,
        }),
      );
    }, encoded);
    await page.waitForFunction(
      () => document.querySelectorAll('.composer-image-thumb img').length === 2,
    );
    await settle();
    const metrics = await page.evaluate(() => {
      const bounds = (selector) => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
        composer: bounds('.composer'),
        images: bounds('.composer-image-list'),
        textarea: bounds('.composer textarea'),
        send: bounds('.send-button'),
      };
    });
    assert.ok(
      metrics.documentWidth <= 391,
      'mobile attachments do not cause horizontal page overflow',
    );
    for (const bounds of [metrics.composer, metrics.images, metrics.textarea, metrics.send]) {
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391);
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 845);
    }
    report.chatImages.views.mobile = metrics;
    await page.screenshot({ path: join(artifactDir, 'mobile-chat-image-draft.png') });
    await page.click('[aria-label="pasted-reference.pngを削除"]');
    await page.waitForFunction(
      () => document.querySelectorAll('.composer-image-item').length === 1,
    );
    await page.click('[aria-label="dropped-reference.pngを削除"]');
    await page.waitForSelector('.composer-image-item', { hidden: true });
    assert.equal(await page.$eval(send, (button) => button.disabled), true);
    report.chatImages.checks.push(
      'mobile paste and drop preview correctly; removing images restores an empty composer',
    );

    store.patch('settings', 'main', { model: { ...savedModel, imageInput: false } });
    controller.changed();
    await openRoom();
    await page.click(attach);
    await page.waitForSelector('.composer-image-hint', { visible: true });
    assert.match(
      await page.$eval('.composer-image-hint', (element) => element.textContent),
      /画像入力を有効にする/,
    );
    report.chatImages.checks.push(
      'disabled image input presents the conversation-model setting instead of silently discarding images',
    );
  } finally {
    store.patch('settings', 'main', { model: savedModel });
    controller.changed();
  }
}
