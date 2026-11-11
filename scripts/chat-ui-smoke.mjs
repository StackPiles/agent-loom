import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkInbox } from './inbox-ui-smoke.mjs';
import { checkTaskDiagnostics } from './task-diagnostics-ui-smoke.mjs';
import { checkAutonomousWork } from './autonomous-work-ui-smoke.mjs';
import { checkTaskScheduling } from './scheduling-ui-smoke.mjs';
import { checkChatImages } from './chat-images-ui-smoke.mjs';
import { checkMarkdownOutput } from './markdown-output-ui-smoke.mjs';
import { checkTaskInputs } from './task-inputs-ui-smoke.mjs';
import { checkTaskRecovery } from './task-recovery-ui-smoke.mjs';

// Run against a built app in CI. Chrome keeps its sandbox enabled; all data,
// model replies and workspaces belong to this disposable local fixture.
const artifactDir = resolve(process.env.LOOM_UI_ARTIFACT_DIR || join(tmpdir(), 'loom-chat-ui'));
const inputSelector = '.composer textarea';
const sendSelector = '.composer button[aria-label="送信"]';
const allMentionSelector = '#mention-menu [role="option"][data-mention-handle="all"]';
const pauseSelector =
  '.room-header button[aria-label="現在の生成・ツール実行が終わったらルームを休止"]';
const resumeSelector = '.room-header button[aria-label="このルームを再開"]';
const coordinatorName = '計画担当の佐藤（プロジェクト進行管理）';
const contextExamples = [
  {
    id: 'ui_message_08_context_request',
    kind: 'directed',
    label: '→ 2人',
    category: '→ 2人',
    titleIncludes: ['ノヴァ (@nova)', 'オービット (@orbit)', 'ルーム内で共有'],
  },
  {
    id: 'ui_message_09_context_user_reply',
    kind: 'user-reply',
    label: 'あなたの依頼への回答',
    category: 'あなたの依頼への回答',
    titleIncludes: ['ルーム内で共有'],
  },
  {
    id: 'ui_message_10_context_user_directed',
    kind: 'user-directed',
    label: '→ あなた',
    category: '→ あなた',
    titleIncludes: ['あなた宛て', 'ルーム内で共有'],
  },
  {
    id: 'ui_message_11_context_handoff_reply',
    kind: 'bot-reply',
    label: `ボット依頼への回答 · ${coordinatorName}`,
    category: 'ボット依頼への回答',
    titleIncludes: [coordinatorName, 'ルーム内で共有', '依頼元への自動返信ではありません'],
  },
  {
    id: 'ui_message_12_context_automation',
    kind: 'automation',
    label: '自動実行の報告',
    category: '自動実行の報告',
    titleIncludes: ['ルーム内で共有'],
  },
  {
    id: 'ui_message_13_context_legacy',
    kind: 'room',
    label: 'ルーム共有',
    category: 'ルーム共有',
    titleIncludes: ['ルーム内で共有'],
  },
];
const longMessage = [
  '次の企画について、調査・実装・検証の観点から整理してください。',
  ...Array.from(
    { length: 8 },
    (_, index) =>
      `${index + 1}. 対象となる利用者と必要な機能を確認し、具体的な手順と確認事項を短くまとめてください。`,
  ),
  '参考URL: https://example.test/reports/' + 'layout-check-'.repeat(16),
  '最後に、次に取り組む作業を一つ提案してください。',
].join('\n');

function fixtureRuntime(host) {
  const pending = new Map();
  const finish = (task) => {
    const stamp = new Date().toISOString();
    const output = 'UI確認用の固定応答です。依頼を受け取りました。次の作業と確認事項を整理します。';
    host.updateTask(task.id, {
      status: 'completed',
      startedAt: stamp,
      completedAt: stamp,
      output,
    });
    host.addMessage({
      roomId: task.roomId,
      authorType: 'bot',
      authorId: task.botId,
      taskId: task.id,
      body: output,
      status: 'complete',
    });
  };
  return {
    start(task) {
      if (host.getSnapshot().rooms.find((room) => room.id === task.roomId)?.paused)
        pending.set(task.id, task);
      else finish(task);
    },
    async stop(id) {
      pending.delete(id);
      host.updateTask(id, { status: 'stopped', completedAt: new Date().toISOString() });
    },
    setRoomPaused(roomId, paused) {
      if (!paused)
        for (const [id, task] of pending) {
          if (task.roomId !== roomId) continue;
          pending.delete(id);
          finish(task);
        }
    },
    queueState: () => ({
      active: 0,
      waiting: pending.size,
      capacity: 2,
      waitingTasks: [...pending.values()].map((task) => ({ taskId: task.id, reason: 'paused' })),
    }),
    async shutdown() {
      pending.clear();
    },
  };
}

function seedFixture(store) {
  // Leave all seeded history before messages sent through the real composer.
  // Store.list orders by SQL insertion time, then ID, not JSON createdAt. Keep
  // message IDs in chronological order even when writes share a millisecond.
  const stamp = (index) => new Date(Date.now() - (20 - index) * 60_000).toISOString();
  const members = [
    ['aster', coordinatorName, '整理・計画', '#7c9885'],
    ['nova', 'ノヴァ', '調査・検証', '#c29a6c'],
    ['orbit', 'オービット', '設計・実装', '#7896ae'],
    ['moss', 'モス', 'レビュー', '#8e9f68'],
    ['luna', 'ルナ', '資料作成', '#a78dba'],
  ];
  for (const bot of store.list('bots')) store.remove('bots', bot.id);
  store.patch('settings', 'main', {
    demoMode: true,
    autoLearn: false,
    inference: { maxConcurrentRequests: 2 },
  });
  store.patch('rooms', 'room_lounge', {
    name: '月60万円以上を安定して稼ぐ精鋭たち',
    description: 'UI確認用のサンプルルーム。5人のボットが調査・実装・検証を分担します。',
    botIds: members.map(([handle]) => `bot_${handle}`),
    parallelResponses: true,
    paused: false,
  });
  store.put('messages', {
    id: 'ui_message_00_user',
    roomId: 'room_lounge',
    authorType: 'user',
    authorId: 'user',
    body: '今週の作業を整理して、役割ごとに進め方を提案してください。',
    status: 'complete',
    createdAt: stamp(0),
  });
  members.forEach(([handle, name, role, color], index) => {
    const botId = `bot_${handle}`;
    const taskId = `ui_task_${handle}`;
    const messageId = `ui_message_${String(index + 1).padStart(2, '0')}_${handle}`;
    const body =
      index === 1
        ? '調査結果を整理しました。\n\n- 利用者の課題を確認\n- 必要な機能と優先順位を比較\n- 次の検証で確かめる項目を記録\n\n根拠を確認してから、実装する範囲を決めましょう。'
        : `${name}です。${role}の観点から作業を確認しました。\n\nまず目的と完了条件をそろえ、担当する作業を一つずつ進めます。結果はこのルームに共有します。`;
    store.put('bots', {
      id: botId,
      handle,
      name,
      role,
      color,
      avatar: `character:${handle}`,
      enabled: true,
      systemPrompt: 'Synthetic UI fixture; no model is connected.',
      browser: { mode: 'disabled' },
      createdAt: stamp(0),
    });
    store.put('tasks', {
      id: taskId,
      roomId: 'room_lounge',
      botId,
      rootTaskId: taskId,
      depth: 0,
      prompt: `${role}の作業を確認してください。`,
      status: 'completed',
      kind: 'chat',
      output: body,
      createdAt: stamp(index),
      updatedAt: stamp(index + 1),
      startedAt: stamp(index),
      completedAt: stamp(index + 1),
      inputTokens: 120,
      outputTokens: 80,
    });
    store.put('messages', {
      id: messageId,
      roomId: 'room_lounge',
      authorType: 'bot',
      authorId: botId,
      taskId,
      body,
      status: 'complete',
      createdAt: stamp(index + 1),
    });
    store.put('activities', {
      id: `ui_activity_${handle}`,
      roomId: 'room_lounge',
      botId,
      taskId,
      messageId,
      kind: 'status',
      title: 'Task completed',
      detail: `${role}の確認が完了しました。`,
      status: 'success',
      createdAt: stamp(index + 1),
    });
  });

  const rootId = 'ui_context_root_task';
  const userReply = 'この方針で進めてよいですか？ このルームでお知らせください。';
  const userDirected = '相談です。次の施策について判断をお願いできますか？';
  const handoffReply = '依頼された調査が完了しました。結果をルームに共有します。';
  const automationReply = '定期確認が終わりました。変更が必要な点はありません。';
  const completedTask = (id, botId, output, index, extra = {}) => {
    store.put('tasks', {
      id,
      botId,
      roomId: 'room_lounge',
      rootTaskId: id,
      depth: 0,
      kind: 'chat',
      prompt: 'メッセージの宛先と依頼元を確認する固定UIサンプルです。',
      output,
      status: 'completed',
      createdAt: stamp(index - 1),
      updatedAt: stamp(index),
      startedAt: stamp(index - 1),
      completedAt: stamp(index),
      inputTokens: 20,
      outputTokens: 20,
      ...extra,
    });
  };
  completedTask(rootId, 'bot_aster', userReply, 9);
  completedTask('ui_context_proactive_task', 'bot_orbit', userDirected, 10, {
    kind: 'automation',
  });
  completedTask('ui_context_child_task', 'bot_nova', handoffReply, 11, {
    parentTaskId: rootId,
    rootTaskId: rootId,
    depth: 1,
  });
  completedTask('ui_context_automation_task', 'bot_moss', automationReply, 12, {
    kind: 'automation',
  });
  for (const message of [
    {
      id: 'ui_message_08_context_request',
      authorId: 'bot_aster',
      taskId: rootId,
      targetBotIds: ['bot_nova', 'bot_orbit'],
      body: 'ノヴァとオービットへ、調査と設計の確認をお願いします。',
      createdAt: stamp(8),
    },
    {
      id: 'ui_message_09_context_user_reply',
      authorId: 'bot_aster',
      taskId: rootId,
      body: userReply,
      createdAt: stamp(9),
    },
    {
      id: 'ui_message_10_context_user_directed',
      authorId: 'bot_orbit',
      taskId: 'ui_context_proactive_task',
      targetUser: true,
      body: userDirected,
      createdAt: stamp(10),
    },
    {
      id: 'ui_message_11_context_handoff_reply',
      authorId: 'bot_nova',
      taskId: 'ui_context_child_task',
      body: handoffReply,
      createdAt: stamp(11),
    },
    {
      id: 'ui_message_12_context_automation',
      authorId: 'bot_moss',
      taskId: 'ui_context_automation_task',
      body: automationReply,
      createdAt: stamp(12),
    },
    {
      id: 'ui_message_13_context_legacy',
      authorId: 'bot_luna',
      // A textual @mention alone must never be presented as routed bot work.
      body: '@nova の調査メモです。宛先情報のない過去の共有を残します。',
      createdAt: stamp(13),
    },
  ])
    store.put('messages', {
      roomId: 'room_lounge',
      authorType: 'bot',
      status: 'complete',
      ...message,
    });
  assert.deepEqual(
    store.list('messages').map((message) => message.id),
    [
      'ui_message_00_user',
      ...members.map(
        ([handle], index) => `ui_message_${String(index + 1).padStart(2, '0')}_${handle}`,
      ),
      ...contextExamples.map((example) => example.id),
    ],
    'the production store preserves the chronological fixture message order',
  );
}

async function smoke() {
  assert.notEqual(
    process.getuid?.(),
    0,
    'Run Chrome as an unprivileged user with its sandbox enabled.',
  );
  await mkdir(artifactDir, { recursive: true });
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-chat-ui-fixture-'));
  const report = { views: {}, contexts: {}, checks: [], pageErrors: [] };
  let instance;
  let browser;
  let page;
  let stage = 'initialization';
  const mark = (name) => {
    stage = name;
    console.log(`Chat UI smoke: ${name}`);
  };
  try {
    const { createApp } = await import('../dist/server/app.js');
    const { puppeteer } = await import(
      new URL('./third_party/index.js', import.meta.resolve('chrome-devtools-mcp')).href
    );
    instance = await createApp({
      dataDir,
      dev: true,
      scheduler: false,
      runtimeFactory: fixtureRuntime,
    });
    seedFixture(instance.store);
    const origin = await instance.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await puppeteer.launch({
      executablePath: process.env.LOOM_CHROME_EXECUTABLE_PATH || '/usr/bin/google-chrome',
      headless: true,
      userDataDir: join(dataDir, 'chrome-profile'),
      args: ['--lang=ja-JP'],
      timeout: 20_000,
      protocolTimeout: 20_000,
    });
    page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(20_000);
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('loom.locale', 'ja');
      localStorage.setItem('loom.room', 'room_lounge');
      localStorage.setItem('loom.chatFocus', 'false');
      localStorage.setItem('loom.activity', 'true');
    });

    const settle = async () => {
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
    };
    const open = async (width, height) => {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(inputSelector, { visible: true });
      await page.waitForFunction(
        (selector) => document.querySelector(selector)?.disabled === false,
        {},
        pauseSelector,
      );
      await settle();
    };
    const measure = () =>
      page.evaluate(() => {
        const box = (selector) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          viewport: { width: innerWidth, height: innerHeight },
          documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          header: box('.room-header'),
          conversation: box('.message-scroll'),
          composer: box('.composer-area'),
          composerForm: box('.composer'),
          textarea: box('.composer textarea'),
          send: box('.composer button[aria-label="送信"]'),
          draftLength: document.querySelector('.composer textarea')?.value.length,
          recipientSelectCount: document.querySelectorAll('.composer select').length,
          mentionTriggerCount: document.querySelectorAll('.composer [data-mention-trigger]').length,
          keyboardHintCount: document.querySelectorAll('.composer #composer-help, .composer kbd')
            .length,
          activity: box('.activity-panel'),
          activityCount: document.querySelectorAll('.room-activity').length,
          composerActivityCount: document.querySelectorAll('.composer-area .room-activity').length,
          sidebarActivityCount: document.querySelectorAll('.activity-panel .room-activity').length,
        };
      });
    const assertIdleComposer = (name, metrics) => {
      const { composerForm: form, textarea, send } = metrics;
      assert.ok(form && textarea && send, `${name}: composer form, input and Send are present`);
      assert.ok(
        form.height > 0 && form.height <= 58,
        `${name}: idle composer must be one compact row (height ${form.height}px, maximum 58px)`,
      );
      assert.ok(
        send.x >= textarea.x + textarea.width - 1 && send.x + send.width <= form.x + form.width + 1,
        `${name}: Send sits beside the textarea within the composer`,
      );
      const overlap =
        Math.min(textarea.y + textarea.height, send.y + send.height) - Math.max(textarea.y, send.y);
      assert.ok(
        overlap >= Math.min(textarea.height, send.height) * 0.8,
        `${name}: textarea and Send occupy the same horizontal row`,
      );
      for (const [label, region] of [
        ['textarea', textarea],
        ['Send', send],
      ])
        assert.ok(
          region.y >= form.y - 1 && region.y + region.height <= form.y + form.height + 1,
          `${name}: ${label} fits vertically inside the composer row`,
        );
      assert.equal(metrics.recipientSelectCount, 0, `${name}: no explicit recipient dropdown`);
      assert.equal(metrics.mentionTriggerCount, 0, `${name}: no separate @ trigger button`);
      assert.equal(metrics.keyboardHintCount, 0, `${name}: no separate keyboard hint row`);
    };
    const capture = async (name, { activityOnly = false } = {}) => {
      await settle();
      const metrics = await measure();
      report.views[name] = metrics;
      await page.screenshot({ path: join(artifactDir, `${name}.png`) });
      assert.ok(
        metrics.documentWidth <= metrics.viewport.width + 1,
        `${name}: horizontal overflow`,
      );
      assert.equal(
        metrics.composerActivityCount,
        0,
        `${name}: activity must not duplicate in composer`,
      );
      assert.equal(
        metrics.activityCount,
        metrics.sidebarActivityCount,
        `${name}: activity belongs to the sidebar`,
      );
      if (!activityOnly && metrics.draftLength === 0) assertIdleComposer(name, metrics);
      // A clipped grid child can exceed the viewport while document.scrollWidth
      // still fits. Check the actual content rectangles, not just the document.
      // While the mobile drawer is open, its scroll lock can shift the inactive
      // background; validate the foreground drawer instead for that capture.
      for (const region of activityOnly ? ['activity'] : ['header', 'conversation', 'composer']) {
        const bounds = metrics[region];
        assert.ok(bounds && bounds.width > 0 && bounds.height > 0, `${name}: ${region} is visible`);
        assert.ok(
          bounds.x >= -1 && bounds.x + bounds.width <= metrics.viewport.width + 1,
          `${name}: ${region} horizontal bounds [${bounds.x}, ${bounds.x + bounds.width}] exceed viewport width ${metrics.viewport.width}`,
        );
        assert.ok(
          bounds.y >= -1 && bounds.y + bounds.height <= metrics.viewport.height + 1,
          `${name}: ${region} vertical bounds [${bounds.y}, ${bounds.y + bounds.height}] exceed viewport height ${metrics.viewport.height}`,
        );
      }
      return metrics;
    };
    const contextMetrics = (example) =>
      page.$eval(
        `[data-message-id="${example.id}"]`,
        (article, category) => {
          const rect = (element) => {
            if (!element) return null;
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          };
          const header = article.querySelector('.message-header');
          const badge = header?.querySelector('.message-context-badge');
          const label = badge?.querySelector('.message-context-label');
          const style = badge ? getComputedStyle(badge) : undefined;
          const text = label?.firstChild;
          let categoryBounds = null;
          if (text?.nodeType === Node.TEXT_NODE && text.textContent.startsWith(category)) {
            const range = document.createRange();
            range.setStart(text, 0);
            range.setEnd(text, category.length);
            categoryBounds = rect(range);
          }
          return {
            id: article.dataset.messageId,
            kind: badge?.dataset.messageContext,
            label: label?.textContent.trim(),
            title: badge?.getAttribute('title'),
            badgeCount: header?.querySelectorAll('.message-context-badge').length,
            header: rect(header),
            headerClientWidth: header?.clientWidth,
            headerScrollWidth: header?.scrollWidth,
            sender: rect(header?.querySelector('strong')),
            badge: rect(badge),
            time: rect(header?.querySelector('time')),
            answer: rect(article.querySelector('.message-answer')),
            conversation: rect(article.closest('.message-scroll')),
            categoryBounds,
            badgeClipped: badge ? badge.scrollWidth > badge.clientWidth + 1 : false,
            badgePaddingRight: Number.parseFloat(style?.paddingRight || '0'),
            badgeFontSize: Number.parseFloat(style?.fontSize || '0'),
            badgeWhiteSpace: style?.whiteSpace,
          };
        },
        example.category,
      );
    const contextVisible = (bounds, conversation) =>
      bounds &&
      conversation &&
      bounds.x >= conversation.x - 1 &&
      bounds.x + bounds.width <= conversation.x + conversation.width + 1 &&
      bounds.y >= conversation.y - 1 &&
      bounds.y + bounds.height <= conversation.y + conversation.height + 1;
    const centerContext = async (id, comparisonIds = []) => {
      await page.waitForSelector(
        `[data-message-id="${id}"] .message-header .message-context-badge`,
        { visible: true },
      );
      const frame = await page.$eval(
        `[data-message-id="${id}"]`,
        (article, comparisonIds) => {
          const scroll = article.closest('.message-scroll');
          const targets = [article.querySelector('.message-header')];
          if (comparisonIds.length) {
            targets.push(article.querySelector('.message-answer'));
            for (const otherId of comparisonIds)
              targets.push(scroll.querySelector(`[data-message-id="${otherId}"] .message-header`));
          }
          const bounds = targets.map((element) => element.getBoundingClientRect());
          const top = Math.min(...bounds.map((bound) => bound.top));
          const bottom = Math.max(...bounds.map((bound) => bound.bottom));
          const viewport = scroll.getBoundingClientRect();
          scroll.scrollTo({
            top: scroll.scrollTop + (top + bottom) / 2 - viewport.y - viewport.height / 2,
            behavior: 'instant',
          });
          return { height: bottom - top, viewportHeight: viewport.height };
        },
        comparisonIds,
      );
      assert.ok(
        frame.height <= frame.viewportHeight,
        `${id}: all comparison content fits in the viewport`,
      );
      await settle();
    };
    const checkMessageContexts = async (name) => {
      const checked = [];
      for (const example of contextExamples) {
        await centerContext(example.id);
        const row = await contextMetrics(example);
        const label = `${name}: ${example.kind}`;
        assert.equal(row.badgeCount, 1, `${label} has one compact context badge`);
        assert.equal(row.kind, example.kind, `${label} preserves the saved message context`);
        assert.equal(row.label, example.label, `${label} uses the correct visible label`);
        for (const detail of example.titleIncludes)
          assert.ok(row.title?.includes(detail), `${label} exposes its full meaning: ${detail}`);
        assert.ok(
          contextVisible(row.header, row.conversation),
          `${label} is actually visible in the chat viewport`,
        );
        assert.ok(row.header.height <= 34, `${label} stays in the existing compact header row`);
        assert.ok(
          row.headerScrollWidth <= row.headerClientWidth + 1,
          `${label} does not overflow its header`,
        );
        for (const part of ['sender', 'badge', 'time']) {
          const bounds = row[part];
          assert.ok(
            bounds && bounds.width > 0 && bounds.height > 0,
            `${label}: ${part} remains visible`,
          );
          assert.ok(
            bounds.x >= row.header.x - 1 &&
              bounds.x + bounds.width <= row.header.x + row.header.width + 1 &&
              bounds.y >= row.header.y - 1 &&
              bounds.y + bounds.height <= row.header.y + row.header.height + 1,
            `${label}: ${part} fits inside the header`,
          );
        }
        assert.ok(
          row.sender.x + row.sender.width <= row.badge.x + 1,
          `${label}: sender and context do not overlap`,
        );
        assert.ok(
          row.badge.x + row.badge.width <= row.time.x + 1,
          `${label}: context and timestamp do not overlap`,
        );
        assert.equal(row.badgeWhiteSpace, 'nowrap', `${label} does not add a second header line`);
        assert.ok(row.categoryBounds, `${label} has a measurable category prefix`);
        // The long requester name may be ellipsized. Its preceding category must
        // still be readable, including space occupied by the ellipsis glyph.
        const readableRight =
          row.badge.x +
          row.badge.width -
          row.badgePaddingRight -
          (row.badgeClipped ? row.badgeFontSize : 0);
        assert.ok(
          row.categoryBounds.x + row.categoryBounds.width <= readableRight + 1,
          `${label}: category remains readable before a possibly shortened requester name`,
        );
        checked.push(row);
      }
      // Prioritize the new proactive bot → user message in the two additional
      // screenshots. Center the full comparison span, not just one header.
      const comparisonIds = [
        'ui_message_09_context_user_reply',
        'ui_message_10_context_user_directed',
        'ui_message_11_context_handoff_reply',
      ];
      await centerContext('ui_message_10_context_user_directed', comparisonIds);
      await capture(name);
      const screenshotRows = await Promise.all(contextExamples.map(contextMetrics));
      for (const id of comparisonIds) {
        const row = screenshotRows.find((entry) => entry.id === id);
        assert.ok(
          contextVisible(row.header, row.conversation),
          `${name}: ${id} is visible in the screenshot`,
        );
      }
      const proactive = screenshotRows.find(
        (entry) => entry.id === 'ui_message_10_context_user_directed',
      );
      assert.ok(
        contextVisible(proactive.answer, proactive.conversation),
        `${name}: the proactive question is visible`,
      );
      report.contexts[name] = {
        checked,
        visibleInScreenshot: screenshotRows
          .filter((row) => contextVisible(row.header, row.conversation))
          .map((row) => row.id),
      };
      report.checks.push(
        `${name}: six message contexts are distinct and fit the header, including proactive → you`,
      );
      await page.$eval('.message-scroll', (scroll) =>
        scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'instant' }),
      );
      await settle();
    };
    const input = async (value) => {
      await page.focus(inputSelector);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      // Puppeteer's sendCharacter uses CDP Input.insertText for the whole string,
      // preserving Japanese and line breaks without Enter keydowns that submit.
      if (value) await page.keyboard.sendCharacter(value);
      await page.waitForFunction(
        (selector, expected) => document.querySelector(selector)?.value === expected,
        {},
        inputSelector,
        value,
      );
      await settle();
    };
    const send = async (body) => {
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url() === `${origin}/api/rooms/room_lounge/messages` &&
          response.request().method() === 'POST',
      );
      await page.click(sendSelector);
      const response = await responsePromise;
      assert.equal(response.status(), 200);
      const result = await response.json();
      const payload = JSON.parse(response.request().postData());
      assert.deepEqual(
        Object.keys(payload),
        ['body'],
        'inline mentions route through the message body',
      );
      assert.equal(result.message.body, body);
      await page.waitForSelector(`[data-message-id="${result.message.id}"]`);
      await page.waitForFunction(
        (selector) => document.querySelector(selector)?.value === '',
        {},
        inputSelector,
      );
      report.checks.push(`sent ${body.length}-character message through the composer`);
      return result;
    };
    const checkGrowth = async (name, compact) => {
      const initial = await measure();
      assert.ok(
        initial.textarea.height >= 40 && initial.textarea.height <= 64,
        `${name}: empty textarea starts compact`,
      );
      await input(longMessage);
      const expanded = await capture(`${name}-expanded`);
      assert.ok(
        expanded.textarea.height > initial.textarea.height + 20,
        `${name}: textarea grows with real input`,
      );
      assert.ok(
        expanded.textarea.height <= (compact ? 96 : 160) + 1,
        `${name}: textarea growth stays bounded`,
      );
      await input('');
      const shrunk = await measure();
      assert.ok(
        shrunk.textarea.height <= initial.textarea.height + 2,
        `${name}: clearing input shrinks it`,
      );
      assertIdleComposer(`${name} after clearing`, shrunk);
      report.checks.push(`${name}: textarea grows and shrinks`);
    };

    mark('desktop layout and real short/long message input');
    await open(1416, 900);
    const desktop = await capture('desktop-1416x900');
    assert.equal(
      desktop.sidebarActivityCount,
      1,
      'one activity section is visible in the desktop sidebar',
    );
    assert.ok(
      desktop.conversation.height > desktop.composer.height,
      'conversation gets the main vertical space',
    );
    await checkMessageContexts('desktop-message-contexts-1416x900');
    await checkGrowth('desktop-1416x900', false);
    const shortMessage = '次の作業をお願いします。';
    await input(shortMessage);
    assert.ok((await measure()).textarea.height <= 64, 'short input remains compact');
    await send(shortMessage);
    await input(longMessage);
    await send(longMessage);

    mark('inline @ completion and @all reach every enabled room bot once');
    const mentionPrefix = '次の確認を ';
    await input(mentionPrefix + '@no');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#mention-menu [role="option"]')].some((option) =>
        option.textContent.includes('@nova'),
      ),
    );
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (selector, expected) => document.querySelector(selector)?.value === expected,
      {},
      inputSelector,
      mentionPrefix + '@nova ',
    );
    await settle();
    await page.keyboard.sendCharacter('@al');
    await page.waitForSelector(allMentionSelector, { visible: true });
    await capture('desktop-all-mentions-1416x900');
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (selector, expected) => document.querySelector(selector)?.value === expected,
      {},
      inputSelector,
      mentionPrefix + '@nova @all ',
    );
    await settle();
    const allMessage = mentionPrefix + '@nova @all 全員で分担してください。';
    await page.keyboard.sendCharacter('全員で分担してください。');
    await page.waitForFunction(
      (selector, expected) => document.querySelector(selector)?.value === expected,
      {},
      inputSelector,
      allMessage,
    );
    const enabledBotIds = instance.store
      .get('rooms', 'room_lounge')
      .botIds.filter((id) => instance.store.get('bots', id)?.enabled);
    assert.equal(enabledBotIds.length, 5, 'the fixture has five enabled room bots');
    const allResult = await send(allMessage);
    assert.equal(allResult.tasks.length, 5, '@all creates one task for each of the five bots');
    assert.equal(
      new Set(allResult.tasks.map((task) => task.id)).size,
      5,
      'all task IDs are unique',
    );
    assert.deepEqual(
      allResult.tasks.map((task) => task.botId).sort(),
      [...enabledBotIds].sort(),
      'an individual mention plus @all addresses every enabled room bot exactly once',
    );
    report.checks.push(
      'inline @nova and @all completion sends exactly one task to each of five room bots',
    );

    mark('header pause and resume reach the server and update the UI');
    const pauseResponse = page.waitForResponse(
      (response) => response.url() === `${origin}/api/rooms/room_lounge/pause`,
    );
    await page.click(pauseSelector);
    assert.equal((await pauseResponse).status(), 200);
    await page.waitForSelector(resumeSelector, { visible: true });
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.disabled === false,
      {},
      resumeSelector,
    );
    assert.equal(instance.store.get('rooms', 'room_lounge').paused, true);
    await capture('desktop-paused-1416x900');
    const resumeResponse = page.waitForResponse(
      (response) => response.url() === `${origin}/api/rooms/room_lounge/resume`,
    );
    await page.click(resumeSelector);
    assert.equal((await resumeResponse).status(), 200);
    await page.waitForSelector(pauseSelector, { visible: true });
    assert.equal(instance.store.get('rooms', 'room_lounge').paused, false);
    report.checks.push('header pause/resume persisted and rendered');

    mark('compact-height layout');
    await open(1180, 640);
    const compact = await capture('compact-1180x640');
    assert.equal(compact.sidebarActivityCount, 1);
    assert.ok(compact.conversation.height > compact.composer.height);
    await checkGrowth('compact-1180x640', true);

    mark('mobile layout and Activity access');
    await open(390, 844);
    const mobile = await capture('mobile-390x844');
    assert.equal(mobile.activityCount, 0, 'mobile starts with the Activity drawer closed');
    await checkMessageContexts('mobile-message-contexts-390x844');
    await checkGrowth('mobile-390x844', false);
    await page.click('.room-header .room-activity-toggle');
    await page.waitForSelector('.activity-panel .room-activity', { visible: true });
    const mobileActivity = await capture('mobile-activity-390x844', { activityOnly: true });
    assert.equal(mobileActivity.sidebarActivityCount, 1);
    await page.click('.activity-header button[aria-label="アクティビティを閉じる"]');
    await page.waitForSelector('.activity-panel', { hidden: true });
    assert.equal(
      await page.$eval('.room-activity-toggle', (element) => element.getAttribute('aria-expanded')),
      'false',
    );
    report.checks.push('mobile Activity opens and closes without horizontal overflow');
    mark('notification senders and direct replies on desktop and mobile');
    await checkInbox({ instance, page, origin, artifactDir, report, settle });
    mark('task interruption and timeout diagnostics on desktop and mobile');
    await checkTaskDiagnostics({ instance, page, origin, artifactDir, report, settle });
    mark('autonomous work, room policy and outcome review on desktop and mobile');
    await checkAutonomousWork({ instance, page, origin, artifactDir, report, settle });
    mark('fair scheduling and shared priority controls on desktop and mobile');
    await checkTaskScheduling({ instance, page, origin, artifactDir, report, settle });
    mark('chat image upload, paste and drop on desktop and mobile');
    await checkChatImages({ instance, page, origin, artifactDir, report, settle });
    mark('Markdown reasoning, notifications and progress on desktop and mobile');
    await checkMarkdownOutput({ instance, page, origin, artifactDir, report, settle });
    mark('task instructions, approval supersession and completion races on desktop and mobile');
    await checkTaskInputs({ instance, page, origin, artifactDir, report, settle });
    mark('stopped-task context and linked work recovery on desktop and mobile');
    await checkTaskRecovery({ instance, page, origin, artifactDir, report, settle });
    assert.deepEqual(report.pageErrors, [], 'no uncaught page errors');
    report.ok = true;
    console.log(`Chat UI smoke passed. Screenshots and metrics: ${artifactDir}`);
  } catch (error) {
    report.ok = false;
    report.failure = { stage, message: error.message, stack: error.stack };
    console.error(`Chat UI smoke failed during: ${stage}`);
    if (page && !page.isClosed())
      await page.screenshot({ path: join(artifactDir, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    try {
      await writeFile(join(artifactDir, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
    } finally {
      try {
        await browser?.close();
      } finally {
        try {
          await instance?.app.close();
        } finally {
          await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
      }
    }
  }
}

await smoke();
