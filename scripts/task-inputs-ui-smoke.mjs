import assert from 'node:assert/strict';
import { join } from 'node:path';

// Exercise the real route and SSE UI with synthetic task state. The fixture
// runtime never calls a model; real Pi delivery/cancellation has separate tests.
export async function checkTaskInputs({ instance, page, origin, artifactDir, report, settle }) {
  const { store, controller } = instance;
  const savedSettings = store.settings();
  const runtime = controller.runtime;
  const savedNotify = runtime.notifyTaskInput;
  const roomId = 'ui_task_inputs_room';
  const roomName = '作業への追加指示を確認';
  const taskId = 'ui_task_inputs_task';
  const firstMessageId = 'ui_task_inputs_first_answer';
  const target = `[data-task-input-target="${taskId}"]`;
  const action = `[data-task-input-action="${taskId}"]`;
  const textarea = '.composer textarea';
  const send = '.composer button[aria-label="追加指示を送信"]';
  const immediate = '.task-input-immediate input[type="checkbox"]';
  const clear = `${target} button[aria-label="追加指示の対象を解除して新しい依頼にする"]`;
  const endpoint = `${origin}/api/tasks/${taskId}/inputs`;
  const notified = [];
  let approvalController;
  let interception;
  report.taskInputs = { checks: [], views: {} };

  const openRoom = async (width, height) => {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    // The accessible label includes live task/approval status. Match the stable
    // room name, and treat a closed mobile drawer separately from nav overflow.
    const roomHandle = await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('.room-nav button')].find(
          (button) => button.querySelector('.room-nav-name')?.textContent === name,
        ),
      {},
      roomName,
    );
    const roomButton = roomHandle.asElement();
    assert.ok(roomButton, 'the named room is present in navigation');
    try {
      if (await page.$('#loom-navigation[aria-hidden="true"]'))
        await page.click('button[aria-label="メニューを開く"]');
      await roomButton.evaluate((button) =>
        button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
      );
      await page.waitForFunction(
        (button) => {
          const navigation = button.closest('#loom-navigation');
          if (
            navigation?.inert ||
            navigation?.getAttribute('aria-hidden') === 'true' ||
            navigation?.getBoundingClientRect().left < -1
          )
            return false;
          const rect = button.getBoundingClientRect();
          return button.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
          );
        },
        {},
        roomButton,
      );
      await roomButton.click();
    } finally {
      await roomHandle.dispose();
    }
    await page.waitForFunction(
      (name) => document.querySelector('.room-heading h1')?.textContent === name,
      {},
      roomName,
    );
    await page.waitForSelector(textarea, { visible: true });
  };
  const selectTarget = async () => {
    if (!(await page.$(target))) {
      await page.waitForSelector(action, { visible: true });
      await page.click(action);
    }
    await page.waitForSelector(target, { visible: true });
    await page.waitForSelector(send, { visible: true });
  };
  const write = async (body) => {
    await page.focus(textarea);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.sendCharacter(body);
    await page.waitForFunction(
      (selector, expected) => document.querySelector(selector)?.value === expected,
      {},
      textarea,
      body,
    );
  };
  const submit = async () => {
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.disabled === false,
      {},
      send,
    );
    const responsePromise = page.waitForResponse(
      (response) => response.url() === endpoint && response.request().method() === 'POST',
    );
    await page.click(send);
    return responsePromise;
  };
  const capture = async (name) => {
    await settle();
    const metrics = await page.evaluate((targetSelector) => {
      const rectangle = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        composer: rectangle('.composer'),
        target: rectangle(targetSelector),
        send: rectangle('.composer button[aria-label="追加指示を送信"]'),
      };
    }, target);
    assert.ok(metrics.scrollWidth <= metrics.width + 1, 'task instructions cause no page overflow');
    for (const key of ['composer', 'target', 'send']) {
      const bounds = metrics[key];
      assert.ok(bounds && bounds.width > 0 && bounds.height > 0, `${key} is visible`);
      assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= metrics.width + 1);
    }
    assert.ok(metrics.send.y >= 0 && metrics.send.y + metrics.send.height <= metrics.height + 1);
    report.taskInputs.views[name] = metrics;
    await page.screenshot({ path: join(artifactDir, `${name}.png`) });
  };

  try {
    runtime.notifyTaskInput = (id) => notified.push(id);
    const stamp = new Date().toISOString();
    store.patch('settings', 'main', {
      demoMode: false,
      model: {
        ...savedSettings.model,
        baseUrl: 'http://127.0.0.1:1/v1',
        modelId: 'synthetic-task-instruction-fixture',
        imageInput: true,
      },
    });
    store.put('rooms', {
      id: roomId,
      name: roomName,
      description: 'Synthetic task-input API and responsive composer verification.',
      botIds: ['bot_aster'],
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
      botId: 'bot_aster',
      rootTaskId: taskId,
      depth: 0,
      kind: 'chat',
      prompt: '調査を進めて結果を整理してください。',
      workspacePath: controller.roomWorkspacePath(roomId),
      status: 'running',
      output: '',
      createdAt: stamp,
      updatedAt: stamp,
      startedAt: stamp,
      inputTokens: 10,
      outputTokens: 5,
    });
    store.put('messages', {
      id: firstMessageId,
      roomId,
      authorType: 'bot',
      authorId: 'bot_aster',
      taskId,
      body: '調査の方針を整理しています。',
      status: 'streaming',
      reasoning: 'UI検証用の固定の途中経過です。',
      reasoningStatus: 'streaming',
      createdAt: stamp,
    });
    controller.changed();
    const taskCount = store.list('tasks').length;
    await openRoom(1416, 900);
    await selectTarget();
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.disabled === false,
      {},
      immediate,
    );
    await page.click(immediate);
    const firstBody = '対象を中小企業向けに変更してください。@nova への新しい依頼は作成しません。';
    await write(firstBody);
    const firstResponse = await submit();
    assert.equal(firstResponse.status(), 200);
    const firstPayload = JSON.parse(firstResponse.request().postData());
    assert.equal(firstPayload.mode, 'immediate');
    const first = await firstResponse.json();
    assert.equal(first.input.taskId, taskId);
    assert.equal(first.input.botId, 'bot_aster');
    assert.equal(first.input.status, 'pending');
    assert.equal(first.message.taskInputId, first.input.id);
    assert.deepEqual(first.message.targetBotIds, ['bot_aster']);
    assert.equal(
      store.list('tasks').length,
      taskCount,
      'an instruction does not create another task',
    );
    assert.deepEqual(notified, [taskId]);
    await page.waitForSelector(
      `[data-task-input-id="${first.input.id}"][data-task-input-status="pending"]`,
      { visible: true },
    );
    await capture('desktop-task-instruction-pending');

    // Simulate the model-dispatch boundary, not mere HTTP acceptance.
    controller.markTaskInputsDelivered(taskId, [first.input.id]);
    controller.updateMessage(firstMessageId, {
      status: 'complete',
      reasoningStatus: 'interrupted',
    });
    const continued = controller.addMessage({
      roomId,
      authorType: 'bot',
      authorId: 'bot_aster',
      taskId,
      body: '追加指示を受けて、対象を変更した調査を続けます。',
      status: 'streaming',
      reasoning: '追加指示後のUI検証用の固定出力です。',
      reasoningStatus: 'streaming',
    });
    await page.waitForSelector(
      `[data-task-input-id="${first.input.id}"][data-task-input-status="delivered"]`,
      { visible: true },
    );
    await page.waitForSelector(`[data-message-id="${continued.id}"]`, { visible: true });
    const order = await page.$$eval('[data-message-id]', (nodes) =>
      nodes.map((node) => node.getAttribute('data-message-id')),
    );
    assert.ok(order.indexOf(continued.id) > order.indexOf(first.message.id));
    report.taskInputs.checks.push(
      'explicit task target, immediate mode, no new task, accepted then delivered receipt',
    );

    await openRoom(390, 844);
    await selectTarget();
    if (await page.$eval(immediate, (node) => node.checked)) await page.click(immediate);
    store.patch('rooms', roomId, { paused: true });
    controller.updateTask(taskId, { status: 'awaiting_approval' });
    approvalController = new AbortController();
    const approvalResult = controller
      .requestApproval(
        {
          taskId,
          roomId,
          botId: 'bot_aster',
          toolName: 'browser_use',
          summary: 'UI確認用の古い送信計画',
          target: 'https://example.test/synthetic-form',
          args: { action: 'click', uid: 'synthetic-submit' },
        },
        approvalController.signal,
      )
      .then(
        () => {
          throw new Error('The stale approval should be superseded.');
        },
        (error) => error,
      );
    const oldApproval = store.list('approvals').find((approval) => approval.taskId === taskId);
    controller.changed();
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.disabled === true,
      {},
      immediate,
    );
    const secondBody = '送信は待ってください。先に下書きだけを確認したいです。';
    await write(secondBody);
    const secondResponse = await submit();
    assert.equal(secondResponse.status(), 200);
    const second = await secondResponse.json();
    assert.equal(second.input.mode, 'boundary');
    assert.equal(second.input.status, 'pending');
    assert.equal(store.get('rooms', roomId).paused, true, 'sending does not resume a room');
    assert.equal(store.list('tasks').length, taskCount);
    assert.equal((await approvalResult).code, 'task_input_superseded');
    assert.equal(store.get('approvals', oldApproval.id).status, 'cancelled');
    assert.equal(store.get('approvals', oldApproval.id).cancellationReason, 'superseded');
    await page.waitForSelector(
      `[data-task-input-id="${second.input.id}"][data-task-input-status="pending"]`,
      { visible: true },
    );
    await capture('mobile-task-instruction-paused');
    report.taskInputs.checks.push(
      'mobile composer, paused acceptance, stale approval superseded without room resume',
    );

    store.patch('rooms', roomId, { paused: false });
    controller.updateTask(taskId, { status: 'running' });
    await write('この入力は終了競合後も下書きに残してください。');
    const retainedDraft = await page.$eval(textarea, (node) => node.value);
    await page.setRequestInterception(true);
    interception = (request) => {
      if (request.url() === endpoint && request.method() === 'POST') {
        controller.updateTask(taskId, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        });
      }
      void request.continue().catch(() => {});
    };
    page.on('request', interception);
    const staleResponse = await submit();
    assert.equal(staleResponse.status(), 409, 'finished-task race is explicit');
    page.off('request', interception);
    interception = undefined;
    await page.setRequestInterception(false);
    await page.waitForFunction(
      (selector, body) => document.querySelector(selector)?.value === body,
      {},
      textarea,
      retainedDraft,
    );
    assert.equal(store.list('taskInputs').filter((input) => input.taskId === taskId).length, 2);
    assert.equal(store.list('tasks').length, taskCount);
    await page.waitForSelector(target, { visible: true });
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.disabled === false,
      {},
      clear,
    );
    await page.click(clear);
    await page.waitForSelector(target, { hidden: true });
    const ordinarySend = '.composer button[aria-label="送信"]';
    const newRequest = page.waitForResponse(
      (response) =>
        response.url() === `${origin}/api/rooms/${roomId}/messages` &&
        response.request().method() === 'POST',
    );
    await page.click(ordinarySend);
    const normalResponse = await newRequest;
    assert.equal(normalResponse.status(), 200);
    const normal = await normalResponse.json();
    assert.equal(normal.tasks.length, 1);
    assert.notEqual(normal.tasks[0].id, taskId);
    assert.equal(normal.tasks[0].prompt, retainedDraft);
    assert.equal(store.list('tasks').length, taskCount + 1);
    report.taskInputs.checks.push(
      'completion race keeps draft and target, explicit target clearing sends a new request',
    );
    report.checks.push(...report.taskInputs.checks);
  } finally {
    if (interception) {
      page.off('request', interception);
      await page.setRequestInterception(false).catch(() => {});
    }
    approvalController?.abort();
    if (savedNotify) runtime.notifyTaskInput = savedNotify;
    else delete runtime.notifyTaskInput;
    store.patch('settings', 'main', {
      demoMode: savedSettings.demoMode,
      model: savedSettings.model,
    });
    controller.changed();
  }
}
