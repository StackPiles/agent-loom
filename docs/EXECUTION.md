# Task scheduling / タスクの実行順

Version 0.10.0 adds fair sharing between jobs and temporary priority. Loom's scheduler is ordinary program logic: it does not call an LLM to choose the next request. Bots still decide how to do their work and which teammate to ask for help.

## Shared capacity

The configured concurrent-inference limit applies to model requests, including context summaries and image requests configured to share text-model capacity. No model slot is permanently reserved for summaries, chat or learning. When a ready job can use a free slot, it can be admitted even if no other class of work is waiting.

Fairness is measured between logical jobs. Tasks belonging to the same autonomous Work share a group; other tasks and their descendants share their originating task's group. A handoff or context summary does not receive an independent allocation merely because it uses another bot or another model call. Binding a running task to Work retains its accumulated scheduling history.

Recent model-slot occupancy and time waiting for an eligible turn affect the next selection. Slot occupancy is an application-side measure, not an assertion about exact GPU time. A minimum charge for each admitted request also accounts for very short calls. These measurements are used to share service rather than to charge a fee or end a job. Ordinary tasks retain the separate 300-model-request and 400-tool-call limits per execution.

The scheduler re-evaluates ready work at safe boundaries and before granting model capacity. Started model requests and tools finish normally. Waiting for an approval or a tool does not hold a language-model slot.

## 先に実行 / Run sooner

Open the task queue from the top bar to see active and queued work, including a second request waiting behind the same bot. **先に実行 / Run sooner** grants that job a temporary preference for the next available model slots.

| Source                        | Maximum preferred model admissions | Window                           |
| ----------------------------- | ---------------------------------: | -------------------------------- |
| Owner's Run sooner action     |                                  3 | 5 minutes from the initial grant |
| Bot's `request_priority` tool |                                  1 | 5 minutes from the initial grant |

These are preferences within a shared queue. They do not interrupt an issued request, create extra capacity, bypass an approval or force a paused job to resume. A summary required by the selected job uses the same allowance. Related handoffs also share the balance.

Only actual preferred model admissions consume the allowance. Moving through the task queue, waiting for a slot or inspecting status does not consume it. A failed or cancelled request that was already admitted does not refund the preferred turn.

Expiry or exhaustion removes the temporary preference. The task continues through ordinary fair scheduling; this allowance does not stop the job or replace its separate execution limits.

Repeating a request in the same window returns the existing allowance without extending or refilling it. An owner may upgrade a bot's grant to three total admissions, subtracting any already used, while keeping its original expiry. **優先を解除 / Remove priority** exhausts that grant and retains its window; it cannot immediately be recreated to obtain more preferred turns. After the window expires, a new request can establish another allowance.

When another job is ready, a bounded sequence of priority admissions is followed by an ordinary fair selection. Jobs whose own priority windows are active still participate in that fair selection. Marking every job as urgent does not turn off fair sharing.

Fair waiting time belongs to the work group. A group receives one aging opportunity after a long wait, even if it has many old child tasks. Receiving model service resets that group's aging clock; another child cannot immediately claim a second long-wait turn using the same interval. Individual task wait times remain visible in queue diagnostics.

## Bot requests and reasons

Non-learning tasks can call `request_priority` with a concise reason and, optionally, a deadline hint. The tool applies only to the calling task's job. It cannot choose another bot's job, claim owner authority, set a permanent priority, change the allowance or stop somebody else's work.

The reason and deadline are advisory task information. Loom does not verify the business urgency of prose, promise completion by that deadline, or create a timed automation from the hint. The server applies the same bounded bot allowance regardless of how strongly the request is worded. The UI distinguishes a bot request from an owner action.

## What the queue shows

The queue identifies the task, bot and room, the current request purpose, the effective shared priority window, and why a task is waiting or was selected. A task may be waiting for model capacity, its room's response order, the same bot's previous task, a task worker or a paused room.

Expired, exhausted and revoked grants are not active priority. The remaining balance is the job's shared balance, not a separate allowance for every row. Disconnected clients cannot change priority until they reconnect.

## Limits of changing the order

Two long model requests can occupy both slots before an urgent request arrives. Without interrupting them, the urgent request must wait for a slot to become free. Fair sharing prevents repeated admission from indefinitely favoring the same ready job; it is not a bound on provider generation time or a guarantee of an immediate answer.

The same bot × room still has one active conversation session. Its next task waits for the current task to finish even when the next task has priority. Room response ordering and actual inference-server capacity also remain independent constraints. Use the displayed waiting reason to distinguish these cases.

Context summaries share the normal model's configuration and the same scheduling path. This release identifies and schedules them separately as a request purpose; it does not introduce a dedicated summary model, a smaller output cap, or automatic cancellation and regeneration of in-flight summaries.

Temporary grants and their consumed balances are persisted with task metadata and survive explicit recovery. Recent occupancy measurements belong to the live scheduler and restart with the process. Data transfer preserves the grant's original window and balance; it does not resume imported tasks or renew priority.

See [MODELS.md](MODELS.md) for model concurrency, room response order and response timeouts; [SCHEDULES.md](SCHEDULES.md) for waking a bot at a future time.
