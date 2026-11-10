import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// All pixels and messages are synthetic. The fixture runtime never calls a model.
export async function checkChatImages({ instance, page, origin, artifactDir, report, settle }) {
  const { store, controller } = instance;
  const savedModel = store.settings().model;
  const roomId = 'room_lounge';
  const attach = '.composer button[aria-label="画像を添付"]';
  const input = '.composer textarea';
  const send = '.composer button[aria-label="送信"]';
  const fixturePath = join(artifactDir, 'chat-image-fixture.png');
  report.chatImages = { checks: [], views: {} };
  try {
    store.patch('settings', 'main', { model: { ...savedModel, imageInput: true } });
    controller.changed();
    await page.setViewport({ width: 1416, height: 900, deviceScaleFactor: 1 });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(attach, { visible: true });
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
    await page.waitForSelector(
      `[data-message-id="${result.message.id}"] [data-image-id="${image.id}"] img`,
      { visible: true },
    );
    await page.waitForSelector('.composer-image-item', { hidden: true });
    const readback = await page.evaluate(async (id) => {
      const response = await fetch(`/api/images/${id}`);
      return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
    }, image.id);
    assert.equal(readback.status, 200);
    assert.equal(readback.bytes, Buffer.from(encoded, 'base64').length);
    await settle();
    await page.screenshot({ path: join(artifactDir, 'desktop-chat-image-sent.png') });
    report.chatImages.checks.push(
      'real file selection sends an image-only message, saves pixels and binds the task input',
    );

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(input, { visible: true });
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
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(attach, { visible: true });
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
