import assert from 'node:assert/strict';
import { join } from 'node:path';

// Extends the disposable real-browser fixture in chat-ui-smoke.mjs. No user
// data, model connection or external messaging service is involved.
export async function checkInbox({ instance, page, origin, artifactDir, report, settle }) {
  const { store, controller } = instance;
  const roomId = 'room_lounge';
  const sender = store.get('bots', 'bot_aster');
  const other = store.get('bots', 'bot_nova');
  const title = '企画の進め方を確認させてください';
  const body =
    '次の企画は、A案の検証から進めるか、B案の実装から進めるかを確認したいです。\nどちらから取り組むか、このお知らせから返信してください。';
  const stamp = new Date().toISOString();
  const system = controller.notify({
    title: '接続設定のお知らせ',
    body: 'これはアプリが表示するシステム通知の確認用サンプルです。',
    roomId,
  });
  const legacy = store.put('notifications', {
    id: 'ui_notice_legacy',
    title: '以前のお知らせ',
    body: '元のタスクから担当ボットを確認できる過去の通知です。',
    roomId,
    taskId: 'ui_task_nova',
    read: false,
    createdAt: stamp,
  });
  const unknown = store.put('notifications', {
    id: 'ui_notice_unknown',
    title: '送信元の記録がないお知らせ',
    body: '@aster と本文に書かれていても送信元を推測しません。',
    roomId,
    read: false,
    createdAt: stamp,
  });
  const removed = store.put('notifications', {
    id: 'ui_notice_removed',
    title: '以前の担当からのお知らせ',
    body: '削除されたボットも送信時の名前を保持します。',
    sender: { kind: 'bot', botId: 'bot_removed', name: '以前の担当ボット', handle: 'previous' },
    roomId,
    read: false,
    createdAt: stamp,
  });
  const alternate = controller.notify({
    title,
    body,
    roomId,
    taskId: 'ui_task_nova',
    senderBotId: other.id,
  });
  const sourceMessage = controller.addMessage({
    roomId,
    authorType: 'bot',
    authorId: sender.id,
    taskId: 'ui_context_root_task',
    body,
    targetUser: true,
    status: 'complete',
  });
  const notice = controller.notify({
    title,
    body,
    roomId,
    taskId: 'ui_context_root_task',
    senderBotId: sender.id,
    messageId: sourceMessage.id,
  });
  assert.notEqual(notice.id, alternate.id, 'same text from different bots remains distinct');
  controller.changed();
  const card = (id) => `[data-notification-id="${id}"]`;
  const primary = card(notice.id);
  const textarea = `${primary} [data-notification-reply-form] textarea`;
  const submit = `${primary} [data-notification-reply-form] button[type="submit"]`;
  report.inbox = { views: {}, checks: [] };

  const capture = async (name, editing = false) => {
    await page.$eval(primary, (element) =>
      element.scrollIntoView({ block: 'start', behavior: 'instant' }),
    );
    if (editing)
      await page.$eval(submit, (element) =>
        element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }),
      );
    await settle();
    const metrics = await page.$eval(primary, (element) => {
      const box = (selector) => {
        const found = selector ? element.querySelector(selector) : element;
        if (!found) return null;
        const { x, y, width, height } = found.getBoundingClientRect();
        return { x, y, width, height, text: found.textContent.trim() };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        card: box(),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        sender: box('.notification-sender'),
        room: box('.notification-room'),
        title: box('h2'),
        textarea: box('textarea'),
        submit: box('button[type="submit"]'),
      };
    });
    report.inbox.views[name] = metrics;
    await page.screenshot({ path: join(artifactDir, `${name}.png`) });
    assert.ok(
      metrics.documentWidth <= metrics.viewport.width + 1,
      `${name}: document has no horizontal overflow`,
    );
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${name}: card does not overflow`);
    for (const key of [
      'card',
      'sender',
      'room',
      'title',
      ...(editing ? ['textarea', 'submit'] : []),
    ]) {
      const bounds = metrics[key];
      assert.ok(bounds && bounds.width > 0 && bounds.height > 0, `${name}: ${key} is rendered`);
      assert.ok(
        bounds.x >= -1 && bounds.x + bounds.width <= metrics.viewport.width + 1,
        `${name}: ${key} fits horizontally`,
      );
    }
    assert.ok(metrics.sender.text.includes(sender.name), `${name}: full sender name is rendered`);
    assert.ok(metrics.sender.text.includes('@aster'), `${name}: sender handle is rendered`);
    assert.ok(
      metrics.room.text.includes(store.get('rooms', roomId).name),
      `${name}: original room is identified`,
    );
    for (const key of editing ? ['textarea', 'submit'] : ['sender', 'room']) {
      const bounds = metrics[key];
      assert.ok(
        bounds.y >= -1 && bounds.y + bounds.height <= metrics.viewport.height + 1,
        `${name}: ${key} is visible in the screenshot`,
      );
    }
  };

  await page.setViewport({ width: 1416, height: 900, deviceScaleFactor: 1 });
  await settle();
  await page.click('.main-nav button[title="お知らせ"]');
  await page.waitForSelector(primary, { visible: true });
  assert.ok(
    (
      await page.$eval(
        `${card(alternate.id)} .notification-sender`,
        (element) => element.textContent,
      )
    ).includes('@nova'),
    'the other bot has its own visible sender',
  );
  assert.match(
    await page.$eval(`${card(legacy.id)} .notification-sender`, (element) => element.textContent),
    /担当ボット/,
    'legacy task-based attribution is distinguished from a saved sender',
  );
  assert.match(
    await page.$eval(`${card(system.id)} .notification-sender`, (element) => element.textContent),
    /Agent Loom|システム/,
    'system notifications identify the application',
  );
  assert.ok(
    (
      await page.$eval(`${card(removed.id)} .notification-sender`, (element) => element.textContent)
    ).includes('以前の担当ボット'),
    'removed bots retain their saved identity',
  );
  for (const item of [system, unknown, removed])
    assert.equal(
      await page.$eval(card(item.id), (element) => {
        const button = element.querySelector('[data-notification-reply]');
        return Boolean(button && !button.disabled);
      }),
      false,
      `${item.id}: unavailable targets have no enabled reply action`,
    );
  await capture('inbox-desktop-1416x900');
  await page.click(`${primary} [data-notification-reply]`);
  await page.waitForSelector(textarea, { visible: true });
  const reply =
    'まずA案の検証をお願いします。\n@all と @nova は引用です。このお知らせの送り主への返信として受け取ってください。';
  await page.focus(textarea);
  await page.keyboard.sendCharacter(reply);
  await page.waitForFunction(
    (selector, expected) => document.querySelector(selector)?.value === expected,
    {},
    textarea,
    reply,
  );
  await capture('inbox-reply-desktop-1416x900', true);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await settle();
  assert.equal(
    await page.$eval(textarea, (element) => element.value),
    reply,
    'changing viewport retains the in-progress reply',
  );
  await capture('inbox-mobile-390x844');
  await capture('inbox-reply-mobile-390x844', true);

  const beforeTasks = store.list('tasks').length;
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${origin}/api/notifications/${notice.id}/reply` &&
      response.request().method() === 'POST',
  );
  await page.click(submit);
  const response = await responsePromise;
  assert.equal(response.status(), 200, 'reply is accepted through the real owner route');
  const payload = JSON.parse(response.request().postData());
  assert.deepEqual(Object.keys(payload).sort(), ['body', 'requestId']);
  assert.equal(payload.body, reply);
  assert.equal(typeof payload.requestId, 'string');
  const result = await response.json();
  assert.equal(result.message.body, reply);
  assert.deepEqual(result.message.targetBotIds, [sender.id]);
  assert.equal(result.tasks.length, 1, 'one notification reply creates exactly one task');
  assert.equal(result.tasks[0].botId, sender.id);
  assert.equal(store.list('tasks').length, beforeTasks + 1);
  const task = store.get('tasks', result.tasks[0].id);
  assert.equal(task.kind, 'chat');
  assert.equal(task.rootTaskId, task.id);
  assert.equal(task.parentTaskId, undefined);
  assert.equal(task.notificationReply.notificationId, notice.id);
  assert.equal(task.notificationReply.messageId, sourceMessage.id);
  assert.equal(task.notificationReply.body, body);
  assert.equal(result.message.notificationReply.notificationId, notice.id);
  assert.equal(store.get('notifications', notice.id).read, true);
  await page.waitForSelector('.composer textarea', { visible: true });
  await page.waitForSelector(`[data-message-id="${result.message.id}"]`, { visible: true });
  await page.waitForSelector(
    `[data-message-id="${result.message.id}"] [data-notification-reply-quote="${notice.id}"]`,
    { visible: true },
  );
  await page.$eval(`[data-message-id="${result.message.id}"]`, (element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await settle();
  const quoteVisible = await page.$eval(
    `[data-message-id="${result.message.id}"] [data-notification-reply-quote="${notice.id}"]`,
    (element) => {
      const quote = element.getBoundingClientRect();
      const viewport = element.closest('.message-scroll').getBoundingClientRect();
      return (
        quote.width > 0 &&
        quote.height > 0 &&
        quote.left >= viewport.left - 1 &&
        quote.right <= viewport.right + 1 &&
        quote.top >= viewport.top - 1 &&
        quote.bottom <= viewport.bottom + 1
      );
    },
  );
  assert.equal(quoteVisible, true, 'the sent reply source is visible in the mobile chat capture');
  await page.screenshot({ path: join(artifactDir, 'inbox-reply-sent-mobile-390x844.png') });
  report.inbox.checks.push(
    'saved, task-derived, system, unknown and removed senders are distinct',
    'long Japanese sender and room labels fit desktop and mobile with an inline reply',
    'the accepted reply preserves its source and reaches exactly the saved sender despite mentions',
    'successful submission marks the notice read and opens the original room',
  );
}
