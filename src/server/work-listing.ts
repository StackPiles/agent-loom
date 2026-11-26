import { z } from 'zod';
import type {
  AutonomousWakeupPolicy,
  WakeupListOptions,
  WakeupSummary,
  WakeupSummaryListing,
  WorkItemSummary,
} from '../shared/work.js';
import type { Store } from './store.js';

export const WAKEUP_LIST_MAX_BYTES = 32 * 1024;
export const WAKEUP_LIST_PAGE_SIZE = 20;

const positionSchema = z.object({ at: z.string().max(100), id: z.string().max(160) }).strict();
const cursorSchema = z
  .object({
    version: z.literal(1),
    roomId: z.string().max(160),
    workId: z.string().max(160).nullable(),
    includeFinished: z.boolean(),
    work: positionSchema.nullable(),
    wakeup: positionSchema.nullable(),
    workDone: z.boolean(),
    wakeupDone: z.boolean(),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;
interface Row<T> {
  at: string;
  id: string;
  value: T;
}

function badCursor(): never {
  throw new Error('Invalid wake-up listing cursor. Start a new room listing without a cursor.');
}

function readCursor(roomId: string, options: WakeupListOptions, workId?: string): Cursor {
  if (!options.cursor)
    return {
      version: 1,
      roomId,
      workId: workId ?? null,
      includeFinished: options.includeFinished ?? !!workId,
      work: null,
      wakeup: null,
      workDone: !!workId,
      wakeupDone: false,
    };
  try {
    if (options.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) badCursor();
    const cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')),
    );
    if (
      cursor.roomId !== roomId ||
      cursor.workId !== (workId ?? null) ||
      (options.includeFinished !== undefined && options.includeFinished !== cursor.includeFinished)
    )
      badCursor();
    return cursor;
  } catch {
    return badCursor();
  }
}

// SQLite projects only the short fields requested here. Full checkpoints, prompts
// and completion reviews are not parsed into JavaScript for a summary listing.
const WORK_PROJECTION = `json_object(
  'id', o.id,
  'name', substr(json_extract(o.data, '$.name'), 1, 160),
  'kind', json_extract(o.data, '$.kind'),
  'status', json_extract(o.data, '$.status'),
  'createdByBotId', json_extract(o.data, '$.createdByBotId'),
  'revision', json_extract(o.data, '$.revision'),
  'summaryExcerpt', substr(coalesce(json_extract(o.data, '$.checkpoint.summary'), ''), 1, 240),
  'nextStepExcerpt', substr(coalesce(json_extract(o.data, '$.checkpoint.nextStep'), ''), 1, 240),
  'pendingCheckCount', coalesce(json_array_length(o.data, '$.checkpoint.pendingChecks'), 0),
  'uncertainActionCount', coalesce(json_array_length(o.data, '$.checkpoint.uncertainActions'), 0),
  'completionReviewStatus', json_extract(o.data, '$.completionReview.status'),
  'completionReviewItemCount', coalesce(json_array_length(o.data, '$.completionReview.items'), 0),
  'deferredItemCount', coalesce(json_array_length(o.data, '$.deferredItems'), 0),
  'lastErrorExcerpt', substr(coalesce(json_extract(o.data, '$.lastError'), ''), 1, 240)
)`;
const WAKEUP_PROJECTION = `json_object(
  'id', o.id,
  'workId', json_extract(o.data, '$.workId'),
  'botId', json_extract(o.data, '$.botId'),
  'createdByBotId', json_extract(o.data, '$.createdByBotId'),
  'key', json_extract(o.data, '$.key'),
  'status', json_extract(o.data, '$.status'),
  'revision', json_extract(o.data, '$.revision'),
  'reasonExcerpt', substr(coalesce(json_extract(o.data, '$.reason'), ''), 1, 240),
  'promptExcerpt', substr(coalesce(json_extract(o.data, '$.prompt'), ''), 1, 240),
  'schedule', json_extract(o.data, '$.schedule'),
  'nextRunAt', json_extract(o.data, '$.nextRunAt'),
  'lastTaskId', json_extract(o.data, '$.lastTaskId'),
  'cancelledBy', json_extract(o.data, '$.cancelledBy'),
  'lastErrorExcerpt', substr(coalesce(json_extract(o.data, '$.lastError'), ''), 1, 240)
)`;

export function summarizeWakeups(
  store: Store,
  roomId: string,
  currentWorkId: string | undefined,
  policy: AutonomousWakeupPolicy,
  options: WakeupListOptions,
  selectedWorkId?: string,
): WakeupSummaryListing {
  const cursor = readCursor(roomId, options, selectedWorkId);
  const limit = options.limit ?? WAKEUP_LIST_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WAKEUP_LIST_PAGE_SIZE)
    throw new Error(`Wake-up listing limit must be from 1 to ${WAKEUP_LIST_PAGE_SIZE}.`);

  function query<T>(kind: 'workItems' | 'wakeups', projection: string) {
    const isWork = kind === 'workItems';
    if (isWork && selectedWorkId) return { rows: [] as Row<T>[], total: 0, omitted: 0 };
    const position = isWork ? cursor.work : cursor.wakeup;
    const done = isWork ? cursor.workDone : cursor.wakeupDone;
    const active = isWork
      ? "json_extract(o.data, '$.status') NOT IN ('completed', 'cancelled')"
      : "json_extract(o.data, '$.status') = 'scheduled'";
    const room = `o.kind = '${kind}' AND json_extract(o.data, '$.roomId') = ?${
      isWork
        ? ''
        : " AND EXISTS (SELECT 1 FROM objects AS parent WHERE parent.kind = 'workItems' AND parent.id = json_extract(o.data, '$.workId') AND json_extract(parent.data, '$.roomId') = json_extract(o.data, '$.roomId'))"
    }${selectedWorkId ? " AND json_extract(o.data, '$.workId') = ?" : ''}`;
    const roomArgs = selectedWorkId ? [roomId, selectedWorkId] : [roomId];
    const counts = store.db
      .prepare(
        `SELECT count(*) AS allCount, coalesce(sum(CASE WHEN ${active} THEN 1 ELSE 0 END), 0) AS activeCount FROM objects AS o WHERE ${room}`,
      )
      .get(...roomArgs) as { allCount: number; activeCount: number };
    const total = cursor.includeFinished ? counts.allCount : counts.activeCount;
    const omitted = counts.allCount - total;
    if (done) return { rows: [] as Row<T>[], total, omitted };
    const after = position ? ' AND (o.created_at < ? OR (o.created_at = ? AND o.id < ?))' : '';
    const statement = store.db.prepare(
      `SELECT o.created_at AS at, o.id, ${projection} AS data FROM objects AS o WHERE ${room}${cursor.includeFinished ? '' : ` AND ${active}`}${after} ORDER BY o.created_at DESC, o.id DESC LIMIT ?`,
    );
    const args = position
      ? [...roomArgs, position.at, position.at, position.id, limit + 1]
      : [...roomArgs, limit + 1];
    const rows = Array.from(
      statement.iterate(...args) as IterableIterator<{ at: string; id: string; data: string }>,
      (row) => ({ at: row.at, id: row.id, value: JSON.parse(row.data) as T }),
    );
    return { rows, total, omitted };
  }

  const works = query<WorkItemSummary>('workItems', WORK_PROJECTION);
  const wakes = query<WakeupSummary>('wakeups', WAKEUP_PROJECTION);
  const selectedWorks = works.rows.slice(0, limit);
  const selectedWakes = wakes.rows.slice(0, limit);
  const currentTimeUtc = new Date().toISOString();
  function result(): WakeupSummaryListing {
    const workMore = works.rows.length > selectedWorks.length;
    const wakeupMore = wakes.rows.length > selectedWakes.length;
    const lastWork = selectedWorks.at(-1);
    const lastWake = selectedWakes.at(-1);
    const next: Cursor = {
      ...cursor,
      work: lastWork ? { at: lastWork.at, id: lastWork.id } : cursor.work,
      wakeup: lastWake ? { at: lastWake.at, id: lastWake.id } : cursor.wakeup,
      workDone: !workMore,
      wakeupDone: !wakeupMore,
    };
    return {
      currentTimeUtc,
      policy,
      view: 'summary',
      recordsComplete: false,
      detailInstructions:
        'Excerpts and counts are not complete records. Read list_wakeups with workId for the full work checkpoint and paginated reservation summaries, or wakeupId for one complete reservation and its work. Never use this summary as a replacement checkpoint. Use nextCursor for more records; includeFinished:true starts a listing that includes finished history.',
      currentWorkId: currentWorkId ?? null,
      includeFinished: cursor.includeFinished,
      total: { workItems: works.total, wakeups: wakes.total },
      omittedFinished: { workItems: works.omitted, wakeups: wakes.omitted },
      workItems: selectedWorks.map((row) => row.value),
      wakeups: selectedWakes.map((row) => row.value),
      hasMore: workMore || wakeupMore,
      nextCursor:
        workMore || wakeupMore ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
    };
  }
  let page = result();
  while (Buffer.byteLength(JSON.stringify(page), 'utf8') > WAKEUP_LIST_MAX_BYTES) {
    // Keep progress in both collections while fitting escaped UTF-8 JSON too.
    if (selectedWorks.length > 1 && selectedWorks.length >= selectedWakes.length)
      selectedWorks.pop();
    else if (selectedWakes.length > 1) selectedWakes.pop();
    else if (selectedWorks.length > 1) selectedWorks.pop();
    else
      throw new Error(
        'A work summary exceeds the listing byte limit. Read the current work by ID.',
      );
    page = result();
  }
  return page;
}
