import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/server/controller.js';
import { Store } from '../src/server/store.js';
import { createTools } from '../src/server/runtime/tools.js';
import { WAKEUP_LIST_MAX_BYTES } from '../src/server/work-listing.js';
import type { Room, Task } from '../src/shared/types.js';
import {
  DEFAULT_AUTONOMOUS_WAKEUP_POLICY,
  type Wakeup,
  type WakeupListOptions,
  type WakeupSummaryListing,
  type WorkItem,
} from '../src/shared/work.js';

const checkpoint = {
  summary: 'Verified the first result.',
  completed: 'Saved its receipt.',
  nextStep: 'Inspect the next result.',
  references: ['receipt.json'],
  doneWhen: 'The requested result is verified.',
  pendingChecks: ['Check the next result without repeating the completed action.'],
  uncertainActions: [] as string[],
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'loom-wakeup-listing-'));
  const store = new Store(directory);
  store.seed();
  store.put('settings', { ...store.settings(), id: 'main', demoMode: true, maxHandoffs: null });
  store.patch<Room>('rooms', 'room_lounge', {
    autonomousWakeups: { ...DEFAULT_AUTONOMOUS_WAKEUP_POLICY, mode: 'room' },
  });
  const controller = new Controller(store);
  const task = controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Continue the authorized project.',
  });
  const { work, wakeup } = controller.work.manageWakeup(task.id, {
    operation: 'upsert',
    key: 'next-result',
    name: 'Verify the result',
    purpose: 'Give the user a verified result.',
    reason: 'Wait for the next result.',
    prompt: 'Inspect the next result and preserve the existing receipt.',
    checkpoint,
    schedule: {
      type: 'once',
      dateTime: '2099-06-15T09:00',
      timeZone: 'Asia/Tokyo',
      missedRunPolicy: 'run_once',
    },
  });
  const reader = controller.enqueueTask({
    roomId: task.roomId,
    botId: task.botId,
    prompt: 'Inspect the room work.',
  });
  const registry = createTools({
    host: controller,
    task: reader,
    settings: store.settings(),
    signal: new AbortController().signal,
    operationKeys: new Set(),
  });
  t.after(async () => {
    registry.dispose();
    await controller.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  function summary(options: WakeupListOptions = {}) {
    const result = controller.listWakeups(reader.id, undefined, options);
    assert.equal(result.view, 'summary');
    return result as WakeupSummaryListing;
  }
  return { store, controller, task, reader, registry, work, wakeup, summary };
}

test('large finished history is excluded by default, retained in full, and discoverable exactly once through pages', async (t) => {
  const f = await fixture(t);
  f.store.db.exec('BEGIN');
  try {
    for (let index = 0; index < 1200; index++) {
      const suffix = String(index).padStart(4, '0');
      f.store.put<WorkItem>('workItems', {
        ...f.work,
        id: `work_finished_${suffix}`,
        status: index % 2 ? 'completed' : 'cancelled',
        checkpoint: { ...checkpoint, summary: 'Stored evidence '.repeat(80) },
      });
      f.store.put<Wakeup>('wakeups', {
        ...f.wakeup,
        id: `wake_finished_${suffix}`,
        workId: f.work.id,
        status: index % 2 ? 'dispatched' : 'cancelled',
        prompt: 'Saved instructions '.repeat(80),
      });
    }
    for (const status of ['paused', 'blocked'] as const) {
      f.store.put<WorkItem>('workItems', {
        ...f.work,
        id: `work_${status}`,
        status,
        checkpoint: {
          ...checkpoint,
          uncertainActions:
            status === 'blocked' ? ['Submitted form has no confirmed receipt.'] : [],
        },
      });
    }
    f.store.db.exec('COMMIT');
  } catch (error) {
    f.store.db.exec('ROLLBACK');
    throw error;
  }

  // A list implementation which parses whole collections before filtering
  // would fail here even if it later sliced its returned arrays.
  const originalList = f.store.list.bind(f.store);
  const wholeCollectionReads: string[] = [];
  t.mock.method(f.store, 'list', (kind: string) => {
    if (kind === 'workItems' || kind === 'wakeups') {
      wholeCollectionReads.push(kind);
      throw new Error('Do not load complete work collections for a listing.');
    }
    return originalList(kind);
  });
  const first = f.summary();
  assert.equal(first.recordsComplete, false);
  assert.equal(first.currentWorkId, null);
  assert.equal(first.total.workItems, 3);
  assert.equal(first.total.wakeups, 1);
  assert.equal(first.omittedFinished.workItems, 1200);
  assert.equal(first.omittedFinished.wakeups, 1200);
  assert.deepEqual(
    new Set(first.workItems.map((item) => item.status)),
    new Set(['active', 'paused', 'blocked']),
  );
  assert.equal(first.workItems.find((item) => item.id === 'work_blocked')!.uncertainActionCount, 1);
  assert.equal(first.workItems.find((item) => item.id === f.work.id)!.pendingCheckCount, 1);
  assert.equal(first.hasMore, false);
  assert.match(first.detailInstructions, /never use this summary as a replacement checkpoint/i);
  assert.ok(first.workItems.every((item) => !('checkpoint' in item)));

  const seenWorks = new Set<string>();
  const seenWakes = new Set<string>();
  let page = f.summary({ includeFinished: true });
  let pages = 0;
  while (true) {
    pages++;
    assert.ok(pages < 200, 'pagination makes bounded forward progress');
    assert.equal(page.includeFinished, true);
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= WAKEUP_LIST_MAX_BYTES);
    assert.ok(page.workItems.length <= 20);
    assert.ok(page.wakeups.length <= 20);
    for (const work of page.workItems) {
      assert.ok(!seenWorks.has(work.id));
      seenWorks.add(work.id);
    }
    for (const wake of page.wakeups) {
      assert.ok(!seenWakes.has(wake.id));
      seenWakes.add(wake.id);
    }
    if (!page.nextCursor) break;
    // The cursor retains includeFinished; callers need not restate the filter.
    page = f.summary({ cursor: page.nextCursor });
  }
  assert.equal(seenWorks.size, 1203);
  assert.equal(seenWakes.size, 1201);
  assert.deepEqual(wholeCollectionReads, []);
  // A long-lived work must not return its entire reservation history simply
  // because its complete checkpoint was requested.
  const workWakeIds = new Set<string>();
  let workCursor: string | undefined;
  do {
    const detail = f.controller.listWakeups(f.reader.id, f.work.id, { cursor: workCursor });
    assert.equal(detail.view, 'detail');
    assert.ok(detail.view === 'detail' && !detail.wakeupsComplete);
    assert.equal(detail.workItemsComplete, true);
    assert.deepEqual(detail.workItems[0].checkpoint, f.work.checkpoint);
    assert.equal(detail.totalWakeups, 1201);
    assert.ok(detail.wakeups.length <= 20);
    assert.ok(Buffer.byteLength(JSON.stringify(detail.wakeups), 'utf8') <= WAKEUP_LIST_MAX_BYTES);
    for (const wake of detail.wakeups) {
      assert.ok(!workWakeIds.has(wake.id));
      assert.ok(!('prompt' in wake));
      workWakeIds.add(wake.id);
    }
    workCursor = detail.nextCursor ?? undefined;
  } while (workCursor);
  assert.equal(workWakeIds.size, 1201);
  assert.equal(
    f.store.get<WorkItem>('workItems', 'work_finished_0000')!.checkpoint.summary,
    'Stored evidence '.repeat(80),
  );
});

test('escaped Japanese summaries respect the serialized byte cap without skipping records', async (t) => {
  const f = await fixture(t);
  const text = '資料😀"\\\n'.repeat(500);
  for (let index = 0; index < 40; index++) {
    f.store.put<WorkItem>('workItems', {
      ...f.work,
      id: `work_large_${index}`,
      name: '資料😀"\\\n'.repeat(20),
      checkpoint: { ...checkpoint, summary: text, nextStep: text },
      lastError: text,
    });
    f.store.put<Wakeup>('wakeups', {
      ...f.wakeup,
      id: `wake_large_${index}`,
      workId: `work_large_${index}`,
      reason: text.slice(0, 2000),
      prompt: text,
      lastError: text,
    });
  }
  const output = await f.registry.invoke('list_wakeups', {});
  assert.ok(Buffer.byteLength(output, 'utf8') <= WAKEUP_LIST_MAX_BYTES);
  let page = JSON.parse(output) as WakeupSummaryListing;
  assert.ok(page.workItems.length < 20 || page.wakeups.length < 20);
  assert.equal(page.hasMore, true);
  const workIds = new Set<string>();
  const wakeIds = new Set<string>();
  let count = 0;
  while (true) {
    assert.ok(++count < 50);
    const serialized = JSON.stringify(page);
    assert.ok(Buffer.byteLength(serialized, 'utf8') <= WAKEUP_LIST_MAX_BYTES);
    assert.ok(!serialized.includes('\ufffd'));
    for (const item of page.workItems) {
      assert.ok(!workIds.has(item.id));
      workIds.add(item.id);
    }
    for (const item of page.wakeups) {
      assert.ok(!wakeIds.has(item.id));
      wakeIds.add(item.id);
    }
    if (!page.nextCursor) break;
    page = f.summary({ cursor: page.nextCursor });
  }
  assert.equal(workIds.size, 41);
  assert.equal(wakeIds.size, 41);
});

test('explicit detail reads preserve long checkpoint fields and support lossless revision-checked updates', async (t) => {
  const f = await fixture(t);
  const fullCheckpoint = {
    summary: '確認😀"\\\n'.repeat(500),
    completed: 'Confirmed receipts '.repeat(200).trim(),
    nextStep: '次の確認事項 '.repeat(300).trim(),
    doneWhen: 'All specified results have been checked.',
    references: Array.from({ length: 24 }, (_, index) => `result-${index}: ${'内容'.repeat(200)}`),
    pendingChecks: Array.from(
      { length: 24 },
      (_, index) => `check-${index}: ${'未確認'.repeat(180)}`,
    ),
    uncertainActions: [] as string[],
  };
  const saved = f.store.patch<WorkItem>('workItems', f.work.id, { checkpoint: fullCheckpoint });
  const prompt = '予約😀"\\\n'.repeat(1500);
  f.store.patch<Wakeup>('wakeups', f.wakeup.id, { prompt });
  const summary = JSON.parse(await f.registry.invoke('list_wakeups', {}));
  const revision = summary.workItems.find((work: { id: string }) => work.id === saved.id).revision;
  const operationsBefore = f.store.list('operations').length;
  for (const operation of ['update', 'complete', 'cancel'])
    for (const baseRevision of [revision, undefined])
      await assert.rejects(
        f.registry.invoke('manage_work', {
          operation,
          workId: saved.id,
          ...(baseRevision === undefined ? {} : { baseRevision }),
          checkpoint: { ...checkpoint, pendingChecks: [], references: [] },
        }),
        /complete current work.*list_wakeups/i,
      );
  assert.equal(
    f.store.list('operations').length,
    operationsBefore,
    'preflight rejection must not journal a failed write that would poison a corrected retry',
  );
  assert.deepEqual(f.store.get<WorkItem>('workItems', saved.id), saved);
  const detail = JSON.parse(await f.registry.invoke('list_wakeups', { workId: saved.id }));
  assert.equal(detail.view, 'detail');
  assert.equal(detail.workItemsComplete, true);
  assert.equal(detail.wakeupsComplete, false);
  assert.deepEqual(detail.workItems[0], saved);
  assert.equal(detail.wakeups[0].prompt, undefined);
  assert.ok(
    Buffer.byteLength(JSON.stringify(detail), 'utf8') > WAKEUP_LIST_MAX_BYTES,
    'explicit detail preserves complete requested records',
  );
  const one = JSON.parse(await f.registry.invoke('list_wakeups', { wakeupId: f.wakeup.id }));
  assert.equal(one.selection.wakeupId, f.wakeup.id);
  assert.equal(one.recordsComplete, true);
  assert.equal(one.wakeups.length, 1);
  assert.equal(one.wakeups[0].prompt, prompt);
  assert.deepEqual(one.workItems[0].checkpoint, fullCheckpoint);

  const updated = JSON.parse(
    await f.registry.invoke('manage_work', {
      operation: 'update',
      workId: saved.id,
      baseRevision: detail.workItems[0].revision,
      checkpoint: { ...detail.workItems[0].checkpoint, summary: 'Verified the latest result.' },
    }),
  ) as WorkItem;
  assert.deepEqual(updated.checkpoint, {
    ...fullCheckpoint,
    summary: 'Verified the latest result.',
  });
  await assert.rejects(
    f.registry.invoke('manage_work', {
      operation: 'update',
      workId: saved.id,
      baseRevision: detail.workItems[0].revision,
      checkpoint: fullCheckpoint,
    }),
    /revision|changed/i,
  );
  await assert.rejects(
    f.registry.invoke('list_wakeups', { wakeupId: f.wakeup.id, limit: 1 }),
    /reservation detail read accepts only/i,
  );
});

test('pagination and detail reads remain room scoped and reject malformed or incompatible cursors', async (t) => {
  const f = await fixture(t);
  const room = f.store.get<Room>('rooms', f.task.roomId)!;
  f.store.put<Room>('rooms', { ...room, id: 'other_room', name: 'Other room' });
  f.store.put<WorkItem>('workItems', { ...f.work, id: 'other_work', roomId: 'other_room' });
  f.store.put<Wakeup>('wakeups', {
    ...f.wakeup,
    id: 'other_wake',
    roomId: 'other_room',
    workId: 'other_work',
  });
  f.store.put<WorkItem>('workItems', { ...f.work, id: 'second_work' });
  const first = f.summary({ limit: 1 });
  assert.equal(first.total.workItems, 2);
  assert.equal(first.total.wakeups, 1);
  assert.ok(first.nextCursor);
  assert.ok(!JSON.stringify(first).includes('other_work'));
  await assert.rejects(f.registry.invoke('list_wakeups', { workId: 'other_work' }), /this room/);
  await assert.rejects(f.registry.invoke('list_wakeups', { wakeupId: 'other_wake' }), /this room/);
  await assert.rejects(
    f.registry.invoke('list_wakeups', { workId: 'second_work', wakeupId: f.wakeup.id }),
    /this room and work/,
  );
  assert.throws(() => f.summary({ cursor: 'not-a-cursor' }), /invalid.*cursor/i);
  assert.throws(
    () => f.summary({ cursor: first.nextCursor!, includeFinished: true }),
    /invalid.*cursor/i,
  );
  const otherReader = f.controller.enqueueTask({
    roomId: 'other_room',
    botId: f.task.botId,
    prompt: 'Inspect this room.',
  });
  assert.throws(
    () => f.controller.listWakeups(otherReader.id, undefined, { cursor: first.nextCursor! }),
    /invalid.*cursor/i,
  );
});

test('reservation text replacements require a complete read while omitted fields and new reservations stay intact', async (t) => {
  const f = await fixture(t);
  const saved = f.store.patch<Wakeup>('wakeups', f.wakeup.id, {
    prompt: 'Preserve every instruction, including the final evidence. '.repeat(180).trim(),
    reason: 'Keep waiting until all requested results are available. '.repeat(25).trim(),
  });
  await f.registry.invoke('list_wakeups', {});
  // The full WORK read still returns reservation excerpts, so it cannot qualify
  // as a complete RESERVATION read.
  await f.registry.invoke('list_wakeups', { workId: f.work.id });
  const beforeOperations = f.store.list('operations').length;
  for (const selector of [
    { wakeupId: saved.id },
    { workId: f.work.id, key: saved.key },
    { workId: f.work.id, key: saved.key, botHandle: '@aster' },
  ]) {
    for (const text of [{ prompt: 'Only an excerpt.' }, { reason: 'Only a short preview.' }]) {
      await assert.rejects(
        f.registry.invoke('manage_wakeup', {
          operation: 'upsert',
          ...selector,
          baseRevision: saved.revision,
          ...text,
        }),
        /complete current reservation.*list_wakeups/i,
      );
    }
  }
  assert.deepEqual(f.store.get<Wakeup>('wakeups', saved.id), saved);
  assert.equal(f.store.list('operations').length, beforeOperations);

  // Changing only a schedule preserves all unseen text and returns a complete
  // reservation, which is itself sufficient for the next text edit.
  const rescheduled = JSON.parse(
    await f.registry.invoke('manage_wakeup', {
      operation: 'upsert',
      wakeupId: saved.id,
      baseRevision: saved.revision,
      schedule: { ...saved.schedule, dateTime: '2099-06-16T09:00' },
    }),
  ) as { wakeup: Wakeup };
  assert.equal(rescheduled.wakeup.prompt, saved.prompt);
  assert.equal(rescheduled.wakeup.reason, saved.reason);
  const changed = JSON.parse(
    await f.registry.invoke('manage_wakeup', {
      operation: 'upsert',
      workId: f.work.id,
      key: saved.key,
      baseRevision: rescheduled.wakeup.revision,
      reason: 'A revised reason supported by the complete saved reservation.',
    }),
  ) as { wakeup: Wakeup };
  assert.equal(changed.wakeup.prompt, saved.prompt);
  assert.deepEqual(changed.wakeup.schedule, rescheduled.wakeup.schedule);

  const newReservation = JSON.parse(
    await f.registry.invoke('manage_wakeup', {
      operation: 'upsert',
      workId: f.work.id,
      key: 'new-independent-step',
      reason: 'A newly requested check.',
      prompt: 'Run this new check, preserving the other reservation.',
      schedule: saved.schedule,
    }),
  ) as { wakeup: Wakeup };
  assert.notEqual(newReservation.wakeup.id, saved.id);
  assert.equal(newReservation.wakeup.revision, 1);
  assert.equal(f.store.get<Wakeup>('wakeups', saved.id)!.prompt, saved.prompt);
});

test('fresh registries can replay completed work and reservation receipts before full-read preflight', async (t) => {
  const f = await fixture(t);
  await f.registry.invoke('list_wakeups', { wakeupId: f.wakeup.id });
  const wakeArgs = {
    operation: 'upsert',
    wakeupId: f.wakeup.id,
    baseRevision: f.wakeup.revision,
    prompt: 'The complete updated reservation instructions.',
  };
  const wakeResult = JSON.parse(await f.registry.invoke('manage_wakeup', wakeArgs)) as {
    wakeup: Wakeup;
  };
  const workArgs = {
    operation: 'update',
    workId: f.work.id,
    baseRevision: f.work.revision,
    checkpoint: { ...checkpoint, summary: 'The verified checkpoint was saved.' },
  };
  const workResult = JSON.parse(await f.registry.invoke('manage_work', workArgs)) as WorkItem;
  const savedOperations = f.store.list('operations').length;

  const fresh = createTools({
    host: f.controller,
    task: f.store.get<Task>('tasks', f.reader.id)!,
    settings: f.store.settings(),
    signal: new AbortController().signal,
    operationKeys: new Set(),
  });
  t.after(() => fresh.dispose());
  assert.match(await fresh.invoke('manage_wakeup', wakeArgs), /already completed.*not repeated/);
  assert.match(await fresh.invoke('manage_work', workArgs), /already completed.*not repeated/);
  assert.equal(f.store.list('operations').length, savedOperations);
  assert.deepEqual(f.store.get<WorkItem>('workItems', f.work.id), workResult);
  assert.deepEqual(f.store.get<Wakeup>('wakeups', f.wakeup.id), wakeResult.wakeup);

  const nextWakeArgs = {
    ...wakeArgs,
    baseRevision: wakeResult.wakeup.revision,
    prompt: 'Another deliberate full instruction update.',
  };
  const nextWorkArgs = {
    ...workArgs,
    baseRevision: workResult.revision,
    checkpoint: { ...workResult.checkpoint, summary: 'A later verified checkpoint.' },
  };
  await assert.rejects(fresh.invoke('manage_wakeup', nextWakeArgs), /complete current reservation/);
  await assert.rejects(fresh.invoke('manage_work', nextWorkArgs), /complete current work/);
  assert.equal(f.store.list('operations').length, savedOperations);
  await fresh.invoke('list_wakeups', { wakeupId: f.wakeup.id });
  await fresh.invoke('manage_wakeup', nextWakeArgs);
  await fresh.invoke('manage_work', nextWorkArgs);
  assert.equal(f.store.get<Wakeup>('wakeups', f.wakeup.id)!.prompt, nextWakeArgs.prompt);
  assert.equal(
    f.store.get<WorkItem>('workItems', f.work.id)!.checkpoint.summary,
    nextWorkArgs.checkpoint.summary,
  );
});
