import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Run against a built app in CI. Chrome keeps its sandbox enabled; all data,
// model replies and workspaces belong to this disposable local fixture.
const artifactDir = resolve(process.env.LOOM_UI_ARTIFACT_DIR || join(tmpdir(), 'loom-chat-ui'));
const inputSelector = '.composer textarea';
const pauseSelector = '.room-header button[aria-label="現在の処理が終わったらルームを休止"]';
const resumeSelector = '.room-header button[aria-label="このルームを再開"]';
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
  const stamp = (index) => new Date(Date.now() - (6 - index) * 60_000).toISOString();
  const members = [
    ['aster', 'アスター', '整理・計画', '#7c9885'],
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
    id: 'ui_user',
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
      id: `ui_message_${handle}`,
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
      messageId: `ui_message_${handle}`,
      kind: 'status',
      title: 'Task completed',
      detail: `${role}の確認が完了しました。`,
      status: 'success',
      createdAt: stamp(index + 1),
    });
  });
}

async function smoke() {
  assert.notEqual(
    process.getuid?.(),
    0,
    'Run Chrome as an unprivileged user with its sandbox enabled.',
  );
  await mkdir(artifactDir, { recursive: true });
  const dataDir = await mkdtemp(join(tmpdir(), 'loom-chat-ui-fixture-'));
  const report = { views: {}, checks: [], pageErrors: [] };
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
          textarea: box('.composer textarea'),
          activity: box('.activity-panel'),
          activityCount: document.querySelectorAll('.room-activity').length,
          composerActivityCount: document.querySelectorAll('.composer-area .room-activity').length,
          sidebarActivityCount: document.querySelectorAll('.activity-panel .room-activity').length,
        };
      });
    const capture = async (name) => {
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
      assert.ok(metrics.conversation.height > 0, `${name}: conversation remains visible`);
      return metrics;
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
      await page.click('.composer button[aria-label="送信"]');
      const response = await responsePromise;
      assert.equal(response.status(), 200);
      const result = await response.json();
      assert.equal(result.message.body, body);
      await page.waitForSelector(`[data-message-id="${result.message.id}"]`);
      await page.waitForFunction(
        (selector) => document.querySelector(selector)?.value === '',
        {},
        inputSelector,
      );
      report.checks.push(`sent ${body.length}-character message through the composer`);
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
    await checkGrowth('desktop-1416x900', false);
    const shortMessage = '次の作業をお願いします。';
    await input(shortMessage);
    assert.ok((await measure()).textarea.height <= 64, 'short input remains compact');
    await send(shortMessage);
    await input(longMessage);
    await send(longMessage);

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
    await checkGrowth('mobile-390x844', false);
    await page.click('.room-header .room-activity-toggle');
    await page.waitForSelector('.activity-panel .room-activity', { visible: true });
    const mobileActivity = await capture('mobile-activity-390x844');
    assert.equal(mobileActivity.sidebarActivityCount, 1);
    assert.ok(mobileActivity.activity.x >= -1);
    assert.ok(mobileActivity.activity.x + mobileActivity.activity.width <= 391);
    await page.click('.activity-header button[aria-label="アクティビティを閉じる"]');
    await page.waitForSelector('.activity-panel', { hidden: true });
    assert.equal(
      await page.$eval('.room-activity-toggle', (element) => element.getAttribute('aria-expanded')),
      'false',
    );
    report.checks.push('mobile Activity opens and closes without horizontal overflow');
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
