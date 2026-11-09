import assert from 'node:assert/strict';
import { join } from 'node:path';

// Seed waiting work directly so this browser fixture never invokes a model.
// Priority changes still pass through the real HTTP route and scheduling service.
export async function checkTaskScheduling({ instance, page, origin, artifactDir, report, settle }) {
  const { store, controller } = instance;
  const roomId = 'room_lounge';
  const room = store.get('rooms', roomId);
  const workspacePath = room.workspacePath || store.settings().workspacePath;
  const stamp = new Date().toISOString();
  const runningId = 'ui_scheduling_running';
  const queuedId = 'ui_scheduling_queued';
  const siblingId = 'ui_scheduling_sibling';
  const taskIds = [runningId, queuedId, siblingId];
  const makeTask = (id, botId, patch = {}) => ({
    id,
    botId,
    roomId,
    rootTaskId: id,
    kind: 'chat',
    status: 'queued',
    depth: 0,
    prompt: '次の応答を準備してください。',
    output: '',
    createdAt: stamp,
    updatedAt: stamp,
    workspacePath,
    ...patch,
  });
  store.patch('rooms', roomId, { paused: false });
  store.put(
    'tasks',
    makeTask(runningId, 'bot_aster', {
      status: 'running',
      startedAt: stamp,
      prompt: '長い会話を要約し、これまでの作業内容を次の応答へ引き継いでいます。',
    }),
  );
  store.put(
    'tasks',
    makeTask(queuedId, 'bot_aster', {
      prompt: '同じボットの前の作業を待ちながら、急ぎの質問への回答を準備します。',
    }),
  );
  store.put(
    'tasks',
    makeTask(siblingId, 'bot_nova', {
      rootTaskId: queuedId,
      parentTaskId: queuedId,
      depth: 1,
      prompt: '引き継いだ調査を進め、同じ仕事の残りの先行回数を共有します。',
    }),
  );
  const originalQueueState = controller.runtime.queueState;
  controller.runtime.queueState = () => ({
    active: 1,
    waiting: 2,
    capacity: 1,
    waitingTasks: [
      { taskId: queuedId, reason: 'session' },
      { taskId: siblingId, reason: 'inference' },
    ],
    scheduling: taskIds.map((taskId) => ({
      taskId,
      ...controller.getTaskScheduling(taskId),
      purpose: taskId === runningId ? 'compaction' : 'response',
      occupiedMs: taskId === runningId ? 1000 : 0,
      ...(taskId === runningId
        ? { lastDispatchReason: 'fair', lastDispatchedAt: stamp }
        : { waitingSince: stamp, blockingTaskId: runningId }),
    })),
  });
  const row = (id) => `[data-queue-task="${id}"]`;
  const action = (id, kind = 'request') => `${row(id)} [data-priority-action="${kind}"]`;
  report.scheduling = { views: {}, checks: [] };

  const capture = async (name, id = queuedId) => {
    await page.$eval(row(id), (element) =>
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
    );
    await settle();
    const metrics = await page.$eval(row(id), (element) => {
      const bounds = (node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      return {
        width: innerWidth,
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        panel: bounds(element.closest('dialog')),
        row: bounds(element),
        actions: [...element.querySelectorAll('[data-priority-action]')].map(bounds),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      };
    });
    assert.ok(metrics.documentWidth <= metrics.width + 1, name + ': no page overflow');
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, name + ': no row overflow');
    for (const box of [metrics.panel, metrics.row, ...metrics.actions]) {
      assert.ok(box.width > 0 && box.height > 0, name + ': controls are visible');
      assert.ok(
        box.x >= -1 && box.x + box.width <= metrics.width + 1,
        name + ': horizontal bounds',
      );
    }
    report.scheduling.views[name] = metrics;
    await page.screenshot({ path: join(artifactDir, name + '.png') });
  };
  const changePriority = async (id, method, kind) => {
    const response = page.waitForResponse(
      (candidate) =>
        candidate.url() === `${origin}/api/tasks/${id}/priority` &&
        candidate.request().method() === method,
    );
    await page.click(action(id, kind));
    assert.equal((await response).ok(), true, `${method} priority succeeds through the real API`);
  };
  try {
    controller.changed();
    await page.setViewport({ width: 1416, height: 900, deviceScaleFactor: 1 });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.task-queue-trigger', { visible: true });
    await page.click('.task-queue-trigger');
    await page.waitForSelector(row(queuedId), { visible: true });
    for (const id of taskIds) assert.ok(await page.$(row(id)), `${id} is reachable in the queue`);
    assert.match(await page.$eval(row(runningId), (element) => element.textContent), /会話の要約/);
    assert.match(
      await page.$eval(row(queuedId), (element) => element.textContent),
      /このボットの前の作業/,
    );
    assert.match(
      await page.$eval(row(siblingId), (element) => element.textContent),
      /会話を要約中/,
    );
    await changePriority(queuedId, 'POST', 'request');
    for (const id of [queuedId, siblingId]) {
      await page.waitForFunction(
        (selector) => document.querySelector(selector)?.textContent.includes('残り3回'),
        {},
        row(id),
      );
      assert.equal(await page.$eval(action(id), (element) => element.disabled), true);
    }
    await capture('scheduling-queue-desktop-1416x900');
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog', { hidden: true });
    assert.equal(
      await page.evaluate(() => document.activeElement?.classList.contains('task-queue-trigger')),
      true,
      'closing the queue restores focus to its trigger',
    );

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await settle();
    const trigger = await page.$eval('.task-queue-trigger', (element) => {
      const rect = element.getBoundingClientRect();
      const front = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return {
        x: rect.x,
        width: rect.width,
        viewport: innerWidth,
        reachable: !!front && element.contains(front),
      };
    });
    assert.ok(trigger.x >= 0 && trigger.x + trigger.width <= trigger.viewport);
    assert.equal(trigger.reachable, true, 'mobile queue trigger remains reachable');
    await page.click('.task-queue-trigger');
    await page.waitForSelector(row(queuedId), { visible: true });
    await capture('scheduling-queue-mobile-390x844');
    await changePriority(siblingId, 'DELETE', 'revoke');
    for (const id of [queuedId, siblingId]) {
      await page.waitForFunction(
        (selector) => document.querySelector(selector)?.textContent.includes('優先は解除済み'),
        {},
        row(id),
      );
      assert.equal(await page.$eval(action(id), (element) => element.disabled), true);
      assert.equal(store.get('tasks', id).status, 'queued', 'removing priority does not stop work');
    }
    await capture('scheduling-revoked-mobile-390x844', siblingId);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog', { hidden: true });
    report.scheduling.checks.push(
      'Every active task remains reachable, including queued work for a running bot.',
      'Session waiting and another bot’s conversation summary are explained.',
      'A real priority mutation displays one shared allowance across delegated work.',
      'Revoking from a sibling keeps work queued and preserves the cooldown.',
      'Desktop and mobile controls fit the viewport; closing restores trigger focus.',
    );
  } finally {
    controller.runtime.queueState = originalQueueState;
    for (const id of taskIds)
      store.patch('tasks', id, { status: 'stopped', completedAt: new Date().toISOString() });
    controller.changed();
  }
}
