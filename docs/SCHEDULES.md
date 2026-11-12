# Scheduled wake-ups and autonomous work

Scheduled wake-ups give a bot work at a specified local date or clock time. Loom has two ways to arrange them. Both create ordinary bot tasks through the existing inference queue and tool permissions.

| Path                     | Who chooses the next reservation                                                                                                                                          | Where it appears                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Owner-managed automation | The owner saves a rule in the automation editor. A direct-chat bot can propose changes to an existing rule for approval.                                                  | The ordinary automation cards.                                         |
| Autonomous work          | After the owner enables a room policy, new bot-created calendar reservations, including direct user requests, are saved without a separate approval for each reservation. | **Automations → Autonomous work** and the room's ongoing-work summary. |

Autonomous scheduling is **off by default**, including in existing rooms. It does not grant permission to perform the actions requested in a wake-up.

## Set up an owner-managed wake-up

Open **Automations → New automation → Scheduled wake-up**. Choose **Once**, **Every day**, or **Selected weekdays**. Enter the local date/time or recurring time, select the time zone, and review **Next wake-up** before saving with the rule enabled. Shortcuts select Monday–Friday or all days; individual weekday buttons also let you select weekends or any other combination.

The initial time zone follows the browser. Choose **Asia/Tokyo** for Japan. Loom saves that explicit zone; moving the server or opening the UI on another computer does not reinterpret the reservation.

Use an interval rule for “every 30 minutes.” Use a calendar wake-up for “every morning at 09:00”; a 1,440-minute interval is not a fixed local clock-time schedule.

## Timing, recovery and overlapping work

The scheduler checks about every **five seconds**. This is task admission timing, not a guarantee that inference starts at the exact second. Available model capacity and approvals can delay the resulting task.

The backend must remain running. Closing the browser is fine; suspending, sleeping or shutting down its host prevents execution. Loom does not power on the computer or wake its operating system.

Choose a missed-wake-up policy:

| UI choice                   | Behavior                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Run once when available** | Keep one overdue occurrence and dispatch one catch-up task when possible. Multiple missed occurrences do not create a historical backlog.                                |
| **Skip missed wake-ups**    | Skip an occurrence when it is **at least 60 seconds late**. A recurring rule advances to its next future occurrence; a one-time rule becomes **Missed** and is disabled. |

The 60-second grace allows ordinary polling delays. It applies before dispatch, not to time spent waiting for inference after a task is already queued. If this rule's previous task is still active, catch-up retains one pending wake-up; the skip policy expires it after the grace period. Saved due times survive restart.

An admission error, such as an unavailable model configuration, preserves the reservation and records an error with a bounded retry delay. A failure after admission remains a normal task failure; inspect or resume that task in its room.

## One-time reservations and editing

**Dispatched** (`scheduleStatus: "fired"`) means the task was queued, not that the bot finished its work. Loom disables the one-time reservation and records its consumption together with task admission. **Run now** consumes the same reservation, including a future one, so it will not run again at its original time.

To rearm a dispatched or missed reservation, choose a different future datetime and enable it. Relabeling the same instant in another time zone does not rearm it. An unconsumed, paused reservation whose time passed must move to a future datetime before enabling; it can instead be explicitly run now.

Editing a title, instructions or missed-run policy preserves an enabled rule's pending occurrence. It does not silently move that reservation forward. Changing the actual calendar trigger calculates a new occurrence. Pausing a rule does not cancel work already queued; stop that task separately in the room.

## Time zones and calendar limits

Inputs use minute precision, named IANA zones or UTC, and years **2000–9999**. Invalid dates and unsupported zones are rejected.

- If a local time does not exist during a clock change, a one-time reservation is rejected. A recurring schedule skips that local date.
- If a local time occurs twice, Loom uses only its first occurrence. The repeated clock hour cannot trigger a second wake-up that day.

Calendar rules preserve local clock time across offset changes. Arbitrary cron expressions, monthly patterns and holiday calendars are not implemented. Monday–Friday includes public holidays.

## Ask a bot to reserve a wake-up

After enabling the room policy below, ask a bot directly, for example: “Every weekday at 09:00 Asia/Tokyo, review open work in this room and notify me when action is needed.” Include the zone, especially for requests such as “tomorrow morning.” New one-time, daily and selected-weekday reservations use autonomous work without an approval card. Inspect the saved purpose, instructions, target, time zone and next occurrence under **Automations → Autonomous work**. Cancel an individual wake-up there, or pause/cancel its entire work item.

Bots use `list_wakeups` and `manage_wakeup` for these reservations. For compatibility, `manage_automation` with `operation: "create"` and `kind: "schedule"` uses the same work service, room scope, limits and stop rules, and returns work/wake-up identities instead of an ordinary automation ID. An off policy rejects creation; it does not fall back to a per-reservation approval. Disabled schedule drafts belong in the owner editor and are not automatically enabled by this route.

Existing ordinary rules remain owner-managed. A bot's edits to them still require approval, as do interval, URL-watch, webhook and incoming-mail rule creation. The `list_automations` and `manage_automation` tools remain restricted to direct root user conversations; scheduled tasks and bot-to-bot handoffs use the room-authorized work tools. Existing records and pending approval proposals are not automatically converted or approved.

## Enable autonomous work

Open the room editor, or choose its room-settings button under **Automations → Autonomous work**. Under **Autonomous wake-ups**, select **Their own wake-ups** or **Their own and room teammates' wake-ups**, review the limits, and save. Give the bot a purpose, an expected outcome and any relevant timing in the room. It can then create a durable work item and a reservation when a later continuation is useful. Enabling the policy does not itself start a task.

### 日本語：自律予約の始め方

1. ルームの編集画面で **ボットの自律予約 → 予約を任せる範囲** を開き、**自分自身の起床** または **自分自身と、このルームの参加ボット** を選んで保存します。既存のルームは無効のままです。
2. ルームで「何を任せるか」「どこまでできれば完了か」を伝えます。「毎朝9時に確認して」のように直接依頼した新しい予約も、許可範囲内なら予約ごとの承認なしで保存します。日時を指定するときは、`Asia/Tokyo` などのタイムゾーンも指定してください。
3. **自動化 → 自律予約の仕事**、またはルーム上部の **継続中の仕事** で、目的・進捗・次回時刻・担当を確認します。
4. 一つの予約を取り消すには、その予約の取消操作を使います。続きを保留するには **仕事を一時停止**、予約と関連する作業をまとめて終了するには **仕事を中止** を選びます。操作結果が不明な場合は、実際の結果を確認してから **確認して再開** で記録します。

予約ごとの承認待ちはありませんが、ファイル・シェル・ブラウザー・メールなどの実行権限は引き続き適用されます。サーバーが停止中の実行や、PCの電源投入・スリープ解除は行いません。

従来の自動化カードに保存済みのルールは、そのまま所有者が管理します。ボットに既存ルールの変更を頼む場合や、一定間隔・URL監視・Webhook・新着メールのルールを作らせる場合は、引き続き具体的な設定を承認します。

### Scope and limits

| Setting              | Default | Meaning                                                                                                                                                                               |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`               | `off`   | `self` permits the work's original creator to reserve its own return. `room` also permits reservations for enabled members of the same room. Cross-room reservations are unavailable. |
| `minIntervalMinutes` | `5`     | At least this many minutes before a newly saved next occurrence, and between autonomous scheduled dispatches across the room. Range: 1–1,440.                                         |
| `maxPendingWakeups`  | `24`    | Maximum pending autonomous reservations in the room; also bounds its unfinished work items. Range: 1–200.                                                                             |
| `maxRunsPerHour`     | `12`    | Rolling room-wide admission limit for work-linked nonlearning tasks, including continuations and handoffs. Range: 1–240. Explicit recovery of the same task is not a new admission.   |

These limits apply to autonomous work, not the owner's ordinary automation rules. They govern reservation counts and task starts; they are not a lifetime or cost limit. Waiting for a reservation uses no inference. Eligible manual conversations take priority over automation, which takes priority over background learning. An already running model request or tool is allowed to finish before a priority change takes effect; the same bot's room session remains exclusive. Busy work and capacity limits can delay the actual start.

### Work, occurrences and checkpoints

A **work item** retains its name, purpose, creator, source task, room, pinned workspace and checkpoint. Its kind is either an assignment (`task`) or a standing responsibility (`standing`). The checkpoint records the current state, verified completed steps, next step, references, completion condition, pending checks and actions with uncertain outcomes. Finishing one bot turn does not automatically complete the work.

**Pending checks** describe what to inspect later: service review after a confirmed submission, publication timing, service rules, missing user input or a teammate's work. They appear as ordinary progress and do not hold the next wake-up. **Attempted actions with unknown outcomes** describe already attempted external operations whose success or failure cannot be established, such as a submission with no reliable receipt. Those stop the whole work for owner review. A timer may trigger another check; it never proves a dependency finished or authorizes acting without required input.

**日本語:** 審査待ち・公開待ち・仕様調査・ユーザー入力待ち・他ボットの作業確認は **次回以降に確認すること** に記録します。この欄があっても起床予約は継続します。既に実行した送信や登録の成否が分からない場合は **成否が分からない実行済み操作** に記録され、仕事全体が **操作結果の確認待ち** になります。その他の失敗・中断等による停止は **再開待ち** と表示します。ボットへの説明と入力欄を分けるもので、保存された自由文の意味を自動判定する機能ではありません。既存の確認待ちは更新だけでは解除せず、実際の状態を確認したうえで再開します。

`workId` identifies the continuing purpose. `workRunId` identifies one occurrence of that purpose. A one-time continuation and its handoffs retain the run identity; a daily or weekly occurrence gets a new one. `wakeupId` links an admitted task to its reservation. With a finite handoff setting, assignment work counts continuation tasks against that occurrence's originating-task budget instead of resetting it at each wake-up. Standing work uses the room's rolling admission limit.

Bots use `list_wakeups`, `manage_wakeup` and `manage_work`. They cannot change the room policy, claim another room, switch an already bound task to another work item, or resume owner-paused work. A bot can edit only reservations it authored; only the work's creator can change its shared checkpoint or complete/cancel the whole work. Stable reservation keys and revision checks prevent an ordinary update from multiplying the same pending step or overwriting a newer record. The room purpose and bot role are captured from owner configuration; bot notes, schedules and other bots' messages are not new user authorization.

### Timing, stopping and review

Autonomous reservations reuse the once/daily/weekly calendar format and timezone behavior below. Only one set of tasks for a work item runs at a time; due reservations wait while that work is busy or held. Room-wide spacing and admission limits can also hold an occurrence. When it becomes eligible, `run_once` admits one catch-up occurrence, while `skip` can mark a late one-time reservation missed or advance a recurring one. A reservation marked dispatched means a task was admitted, not completed.

Eligible reservations are considered by their saved `nextRunAt`, then creation time and ID for equal times. A recurring reservation's next occurrence cannot continually overtake an older pending occurrence just because its record was created first. A held reservation does not prevent other eligible work from being considered; room spacing still limits actual admissions.

- **Cancel a wake-up** removes that reservation. It does not stop a task already admitted from it. Bots cannot rearm the same owner-cancelled reservation.
- **Pause work** holds future reservations and stops associated queued/running tasks. Unlike **Pause after current work** for a whole room, this is an explicit work stop; an in-progress external action may already have had effects.
- **Resume work** allows eligible future reservations again. Failed or interrupted tasks require their own explicit recovery in the room if another attempt is appropriate.
- **Mark complete** or **Cancel work** ends the work, cancels its future reservations, and stops its associated queued/running tasks. Completed and cancelled work cannot be resumed.

From a stopped, failed or interrupted task in chat or room activity, choose **Review work** to open that exact work alongside the task's saved original instruction. The instruction reflects task creation, while the work card shows current progress, next steps and reservations. Review those results before deciding whether the old task is still required. When its associated work is completed or cancelled and no approval or operation outcome needs review, a settled task moves to **Task history** automatically, including older records after startup recovery. Tasks in active, paused or blocked work remain visible. Use **Archive** for other obsolete tasks; explicitly restored tasks stay visible across later automatic checks and restarts. Archiving or restoring a task changes visibility only: it does not review or resume work, cancel a reservation, or execute a task. If the work itself should end, its completion/cancellation controls also affect its other reservations and queued/active tasks. After resuming held work, resume the individual task only if another attempt is still needed; the UI never chains these two actions. Completed, cancelled, unavailable or mismatched work does not offer task recovery.

Turning the room policy off, or narrowing `room` to `self`, pauses affected work. Re-enabling the policy does not automatically resume it. Changes to membership or workspace also require review; a continuation cannot silently move to another workspace.

Failed, stopped or interrupted work-linked tasks block automatic continuation. An uncertain checkpoint also blocks it. Inspect the actual result in the room and, when needed, the external system. **Review and resume** requires the owner to record a verified result and next step and explicitly confirm the outcomes. It appends the review to the previous summary and preserves other checkpoint fields; it does not rerun a failed action. Resume requires an enabled room policy, an unpaused room, the original workspace, an enabled creator and valid pending reservation authors/targets. Restore missing participants or cancel incompatible reservations before resuming; self mode cannot resume a teammate reservation.

Mail sending also has a server-derived guard: when the saved mail outcome is `unknown`, Loom adds the draft/operation reference to the work's uncertainty and blocks continuation even if the bot later describes the send as successful. An unknown send before the first work is created prevents that task lineage from binding new work. Review the actual mailbox/provider result; resuming with an explicitly reviewed checkpoint does not change the draft to sent or resend it. Definite preflight failures are not classified as unknown deliveries.

Completed exact side-effect receipts can carry across continuations by the same bot in the same work/run. Completed shell commands remain task-local so a later continuation can rerun inspection or tests after changes; failed or uncertain shell receipts still block automatic repeats across that run. Different arguments, another bot, or a new recurring occurrence are different operations. This does not establish semantic exactly-once effects or undo an external action.

## Schedule data

Owner-managed rules use `kind: "schedule"` with one of these nested `schedule` objects and the usual [rule fields](API.md). Autonomous wake-ups use the same `schedule` shape in `manage_wakeup`, with the work and reservation fields described in the [API contract](API.md#autonomous-work-and-wake-ups). Replace the example date with a future date that also satisfies the room's minimum lead time for autonomous work.

```json
{
  "type": "once",
  "dateTime": "2030-01-15T09:00",
  "timeZone": "Asia/Tokyo",
  "missedRunPolicy": "run_once"
}
```

```json
{
  "type": "daily",
  "time": "09:00",
  "timeZone": "Asia/Tokyo",
  "missedRunPolicy": "skip"
}
```

```json
{
  "type": "weekly",
  "time": "09:00",
  "weekdays": [1, 2, 3, 4, 5],
  "timeZone": "Asia/Tokyo",
  "missedRunPolicy": "run_once"
}
```

Weekdays use Sunday `0` through Saturday `6`. Runtime times and outcomes are managed by Loom: ordinary automation rules use `scheduleStatus`, while autonomous wake-ups use their own `status`. Implementation: [calendar calculations](../src/shared/schedules.ts), [ordinary rule validation](../src/server/automations.ts), [autonomous work](../src/server/work.ts), [scheduler](../src/server/scheduler.ts).
