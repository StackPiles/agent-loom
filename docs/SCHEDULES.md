# Scheduled wake-ups

Scheduled wake-ups give a bot work at a specified local date or clock time. Each rule names a destination room, an enabled bot in that room, and instructions. It creates an ordinary bot task using the existing inference queue and tool permissions.

## Set up a wake-up

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

## Configure from a room

Ask a bot directly, for example: “Every weekday at 09:00 Asia/Tokyo, review open work in this room and notify me when action is needed.” Include the zone, especially for requests such as “tomorrow morning.” Review the resolved date/time, bot, instructions, recovery policy and next occurrence in the approval card before approving.

Bots can create, change, pause or resume that room's rules only through a direct user conversation. Scheduled tasks and bot-to-bot handoffs cannot create more schedules.

## Schedule data

Use `kind: "schedule"` with one of these nested `schedule` objects and the usual [rule fields](API.md). Replace the example date with a future date when enabling it.

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

Weekdays use Sunday `0` through Saturday `6`. `nextRunAt`, `lastRunAt` and `scheduleStatus` are managed by Loom. Implementation: [calendar calculations](../src/shared/schedules.ts), [rule validation](../src/server/automations.ts), [scheduler](../src/server/scheduler.ts).
