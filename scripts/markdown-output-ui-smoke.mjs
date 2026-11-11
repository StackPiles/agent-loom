import assert from 'node:assert/strict';
import { join } from 'node:path';

// Exercise actual rendered prose and scroll containers with synthetic data.
// No model, external link, image, mailbox or operating-system notification is used.
export async function checkMarkdownOutput({ instance, page, origin, artifactDir, report, settle }) {
  const startedAt = Date.now();
  const { store, controller } = instance;
  const roomId = 'ui_markdown_output_room';
  const roomName = 'Markdownの表示確認';
  const taskId = 'ui_markdown_output_task';
  const stamp = new Date().toISOString();
  const sender = store.get('bots', 'bot_aster');
  const columns = Array.from({ length: 10 }, (_, index) => `列${index + 1}`);
  const prose = [
    '## 表示の確認',
    '',
    '**重要な点**と*補足*を読み取れます。',
    '',
    '- 箇条書きの一項目',
    '- 二つ目は `inline_code`',
    '',
    '```text',
    'wide_code_' + '0123456789'.repeat(28),
    '```',
    '',
    '| ' + columns.join(' | ') + ' |',
    '| ' + columns.map(() => '---').join(' | ') + ' |',
    '| ' + columns.map(() => '確認済み').join(' | ') + ' |',
    '',
    '> **内側の引用**も本文として表示します。',
  ].join('\n');
  const rawLog = '# RAW_TOOL_LOG\n**literal_output**\n- this is raw output';
  const reasoning =
    prose + '\n\n' + Array.from({ length: 24 }, (_, i) => `確認手順 ${i + 1}。`).join('\n\n');
  report.markdownOutput = { views: {}, checks: [] };
  store.put('rooms', {
    id: roomId,
    name: roomName,
    description: 'Independent Markdown display and streaming-scroll fixture.',
    botIds: [sender.id],
    parallelResponses: false,
    paused: false,
    pinned: false,
    archived: false,
    createdAt: stamp,
    updatedAt: stamp,
  });
  store.put('tasks', {
    id: taskId,
    roomId,
    botId: sender.id,
    rootTaskId: taskId,
    depth: 0,
    kind: 'chat',
    prompt: 'Synthetic Markdown and scrolling check.',
    output: '',
    status: 'running',
    createdAt: stamp,
    startedAt: stamp,
    updatedAt: stamp,
    inputTokens: 0,
    outputTokens: 0,
  });
  const message = controller.addMessage({
    roomId,
    authorType: 'bot',
    authorId: sender.id,
    taskId,
    body: '**表示を確認しています。**',
    reasoning,
    reasoningStatus: 'streaming',
    status: 'streaming',
  });
  controller.addActivity({
    roomId,
    botId: sender.id,
    taskId,
    messageId: message.id,
    kind: 'progress',
    title: 'Markdown progress fixture',
    detail: prose,
    status: 'success',
  });
  controller.addActivity({
    roomId,
    botId: sender.id,
    taskId,
    messageId: message.id,
    kind: 'tool',
    title: 'run_command',
    detail: rawLog,
    status: 'success',
  });
  // A notification source is a separate user-directed post. The streaming
  // task-output message must stay undirected so Chat keeps its reasoning panel.
  const sourcePost = controller.addMessage({
    roomId,
    authorType: 'bot',
    authorId: sender.id,
    taskId,
    targetUser: true,
    body: prose,
    status: 'complete',
  });
  const notice = controller.notify({
    title: 'Markdownのお知らせ',
    body: prose,
    roomId,
    taskId,
    senderBotId: sender.id,
    messageId: sourcePost.id,
  });
  const reply = controller.addMessage({
    roomId,
    authorType: 'user',
    authorId: 'user',
    body: '確認しました。',
    status: 'complete',
    notificationReply: {
      notificationId: notice.id,
      roomId,
      botId: sender.id,
      senderName: sender.name,
      senderHandle: sender.handle,
      title: notice.title,
      body: notice.body,
      createdAt: notice.createdAt,
      messageId: sourcePost.id,
      taskId,
    },
  });
  controller.changed();
  const reasoningSelector = `[data-message-id="${message.id}"] .reasoning-text`;
  const noticeSelector = `[data-notification-id="${notice.id}"] .notification-body`;
  const quoteSelector = `[data-message-id="${reply.id}"] [data-notification-reply-quote="${notice.id}"]`;
  const openRoom = async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    // A running room's accessible label includes its changing task state.
    const handle = await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('.room-nav-item')].find(
          (item) => item.querySelector('.room-nav-name')?.textContent === name,
        ),
      {},
      roomName,
    );
    const room = handle.asElement();
    assert.ok(room, 'the named room is present in navigation');
    if (await page.$('#loom-navigation[aria-hidden="true"]'))
      await page.click('button[aria-label="メニューを開く"]');
    await room.click();
    await page.waitForFunction(
      (name) => document.querySelector('.room-heading h1')?.textContent === name,
      {},
      roomName,
    );
    await page.waitForSelector(reasoningSelector, { visible: true });
  };
  const checkProse = async (selector) => {
    const counts = await page.$eval(selector, (element) => ({
      headings: element.querySelectorAll('.markdown h2').length,
      strong: element.querySelectorAll('.markdown strong').length,
      emphasis: element.querySelectorAll('.markdown em').length,
      items: element.querySelectorAll('.markdown li').length,
      code: element.querySelectorAll('.markdown pre code').length,
      tables: element.querySelectorAll('.markdown table').length,
    }));
    for (const [kind, count] of Object.entries(counts))
      assert.ok(count > 0, `${selector}: Markdown ${kind} are rendered as elements`);
    return counts;
  };
  const capture = async (name, selector) => {
    await page.$eval(selector, (element) => {
      const heading = element.querySelector('.markdown h2');
      heading.scrollIntoView({ block: 'center', behavior: 'instant' });
      // Record the fixture's programmatic scroll before a layout pass can
      // restore the outer chat's previous follow-latest position.
      heading.closest('.message-scroll')?.dispatchEvent(new Event('scroll'));
    });
    await settle();
    const metrics = await page.$eval(selector, (element) => {
      const box = (target) => {
        const { x, y, width, height } = target.getBoundingClientRect();
        return { x, y, width, height };
      };
      const heading = element.querySelector('.markdown h2');
      const headingBounds = heading.getBoundingClientRect();
      const front = document.elementFromPoint(
        headingBounds.left + Math.min(20, headingBounds.width / 2),
        headingBounds.top + headingBounds.height / 2,
      );
      let visible = headingBounds.top >= 0 && headingBounds.bottom <= innerHeight;
      for (let parent = heading.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          const bounds = parent.getBoundingClientRect();
          visible &&=
            headingBounds.top >= bounds.top - 1 && headingBounds.bottom <= bounds.bottom + 1;
        }
      }
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        content: box(element),
        heading: box(heading),
        headingVisible: visible && !!front && heading.contains(front),
        containers: [...element.querySelectorAll('.markdown pre, .markdown table')].map(
          (target) => ({
            tag: target.tagName,
            ...box(target),
            clientWidth: target.clientWidth,
            scrollWidth: target.scrollWidth,
            overflowX: getComputedStyle(target).overflowX,
          }),
        ),
      };
    });
    report.markdownOutput.views[name] = metrics;
    assert.ok(
      metrics.documentWidth <= metrics.viewport.width + 1,
      `${name}: document fits horizontally`,
    );
    assert.ok(
      metrics.headingVisible,
      `${name}: the rendered heading is actually visible in the screenshot`,
    );
    for (const bounds of [metrics.content, ...metrics.containers])
      assert.ok(
        bounds.x >= -1 && bounds.x + bounds.width <= metrics.viewport.width + 1,
        `${name}: content and code/table containers fit the viewport`,
      );
    await page.screenshot({ path: join(artifactDir, `${name}.png`) });
  };

  try {
    await page.setViewport({ width: 1416, height: 900, deviceScaleFactor: 1 });
    await openRoom();
    await checkProse(reasoningSelector);
    await page.waitForFunction(
      (selector) => {
        const element = document.querySelector(selector);
        return (
          element.scrollHeight > element.clientHeight + 100 &&
          element.scrollHeight - element.scrollTop - element.clientHeight < 3
        );
      },
      {},
      reasoningSelector,
    );
    controller.appendReasoning(message.id, '\n\n**末尾への追従を確認**');
    await page.waitForFunction(
      (selector) => {
        const element = document.querySelector(selector);
        return (
          element.textContent.includes('末尾への追従を確認') &&
          element.scrollHeight - element.scrollTop - element.clientHeight < 3
        );
      },
      {},
      reasoningSelector,
    );
    await page.$eval(reasoningSelector, (element) => {
      element.scrollTop = 20;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    controller.appendReasoning(message.id, '\n\n**読み返し中の追従停止を確認**');
    await page.waitForFunction(
      (selector) =>
        document.querySelector(selector).textContent.includes('読み返し中の追従停止を確認'),
      {},
      reasoningSelector,
    );
    await settle();
    assert.ok(
      Math.abs((await page.$eval(reasoningSelector, (element) => element.scrollTop)) - 20) <= 1,
      'a reasoning update does not jump to the bottom after scrolling up',
    );
    report.markdownOutput.checks.push(
      'streamed reasoning follows the bottom, and preserves manual scroll-up after an actual controller delta',
    );
    await capture('markdown-reasoning-desktop', reasoningSelector);

    if (!(await page.$('.activity-panel'))) await page.click('.room-activity-toggle');
    await page.waitForSelector('.activity-timeline .timeline-item details', { visible: true });
    await page.$$eval('.activity-timeline .timeline-item details', (elements) => {
      for (const element of elements) element.open = true;
    });
    const timelineProse = '.activity-timeline .timeline-item:has(.markdown)';
    await page.waitForSelector(`${timelineProse} .markdown h2`, { visible: true });
    await checkProse(timelineProse);
    assert.ok(
      await page.$$eval(
        '.activity-timeline pre',
        (elements, expected) =>
          elements.some(
            (element) =>
              element.textContent === expected && !element.querySelector('strong, h1, li'),
          ),
        rawLog,
      ),
      'raw tool output remains literal alongside the rendered progress note',
    );
    await capture('markdown-progress-desktop', timelineProse);

    await page.click('.main-nav button[title="お知らせ"]');
    await page.waitForSelector(noticeSelector, { visible: true });
    await checkProse(noticeSelector);
    await capture('markdown-notification-desktop', noticeSelector);
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await capture('markdown-notification-mobile', noticeSelector);
    const mobile = report.markdownOutput.views['markdown-notification-mobile'];
    assert.ok(
      mobile.containers.some((box) => box.tag === 'PRE' && box.scrollWidth > box.clientWidth + 100),
      'wide code scrolls inside its own bounded container',
    );

    await openRoom();
    await page.$eval(quoteSelector, (element) => {
      element.open = true;
    });
    const quoteBody = `${quoteSelector} > blockquote`;
    await checkProse(quoteBody);
    const quoteStyles = await page.$eval(quoteBody, (outer) => {
      const inner = outer.querySelector('.markdown blockquote');
      return {
        outerMaxHeight: getComputedStyle(outer).maxHeight,
        innerMaxHeight: getComputedStyle(inner).maxHeight,
        innerOverflowY: getComputedStyle(inner).overflowY,
        innerBorderTop: getComputedStyle(inner).borderTopWidth,
      };
    });
    assert.equal(
      quoteStyles.innerMaxHeight,
      'none',
      'nested Markdown quotes do not inherit the outer scroll limit',
    );
    assert.equal(quoteStyles.innerOverflowY, 'visible');
    assert.equal(quoteStyles.innerBorderTop, '0px');
    report.markdownOutput.quoteStyles = quoteStyles;
    await capture('markdown-quote-mobile', quoteBody);
    report.markdownOutput.checks.push(
      'reasoning, sidebar progress, notification and quoted notification render headings, emphasis, lists, code and GFM tables',
      'desktop and mobile containers bound wide content without horizontal page overflow',
      'nested Markdown blockquotes keep ordinary quote styling instead of another scrolling notification wrapper',
    );
  } finally {
    report.markdownOutput.durationMs = Date.now() - startedAt;
    controller.updateTask(taskId, { status: 'completed', completedAt: new Date().toISOString() });
    controller.updateMessage(message.id, { status: 'complete', reasoningStatus: 'complete' });
  }
}
