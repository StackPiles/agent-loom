# Process memory and conversation history

Version 0.23.0 keeps the active conversation separate from already summarized history and resumes tasks after shared memory pressure at a saved tool-batch boundary. Earlier controls store image pixels separately, admit conversations before loading their history, and send record changes to the browser. These controls are separate from **Settings → Concurrent generation → Maximum concurrent generations**, which controls requests to the model server.

## Active history and exact originals

A context summary changes the messages sent to the model, but Pi also retains older transcript entries in memory. Repeated summaries and large tool listings can therefore grow the resident history even when the model's next request stays short.

Before loading a supported session, Loom streams its JSONL and considers entries already excluded by its latest saved compaction. It retains the existing summary and active messages exactly; it does not generate another summary or shorten their text. It also retains system/tool-loadout records, custom state and pending additional instructions, entry references, model selection and thinking state. The candidate must produce exactly the same Pi model messages, model and thinking level before Loom publishes it. Entries still needed by that projection remain in the live file.

An actual reduction writes and synchronizes a replacement and an exact sibling `*.history-v1-<id>.bak`, then atomically replaces the live file at the same path and modification time. Session and retained entry IDs are preserved. Encrypted **Data transfer** includes these originals and restores them byte-for-byte; the live session header is rebased as usual. Backups are not alternative live sessions and are not automatically deleted. Back up the complete data directory. Replacing a current history with an older original would omit subsequent messages and is not an ordinary recovery step.

This conversion currently supports validated, linear Pi v3 histories. Unknown formats or roles, branching, missing references, insufficient working allowance, or a candidate whose projection changes are left untouched. A failed or cancelled conversion before publication leaves the live file unchanged. Each physical record and the retained working set have byte limits, so conversion does not load an entire large original into memory. A tiny reduction is skipped. Large active content or retained custom state can still exceed the allowance; the converter never deletes necessary context merely to meet a target.

### Bounded work and wake-up listings

The model's default `list_wakeups` response now returns a page of concise work and reservation summaries. It excludes finished history by default, reports totals and omissions, names shortened text as `*Excerpt`, and supplies a continuation cursor. Summary pages contain at most 20 records per collection and 32 KiB of serialized UTF-8 JSON. Filtering and pagination happen in SQLite before records are materialized in JavaScript.

`list_wakeups({workId})` returns the complete work record and checkpoint with paginated reservation summaries; `list_wakeups({wakeupId})` returns the complete reservation and its work. Full requested details are not truncated to fit the summary cap. Replacing a checkpoint or an existing reservation's prompt/reason requires a complete read of that record revision during the current execution. Unchanged fields should be omitted from reservation updates. See [model-tool arguments and completeness flags](API.md#model-tools). This avoids repeatedly storing every historical checkpoint while preserving a path to all details.

## Images in conversation history

Pi retains the entries in an open session, including entries preceding a context summary. Keeping base64 images in those entries can therefore retain much more memory than the next model request needs.

Loom now saves image bytes under `sessions/assets/` in its data directory. Each image part in the live agent state and JSONL transcript keeps its MIME type and a small, content-addressed reference. Identical pixels share one asset. A model request receives the original image bytes after model admission and a temporary memory reservation. Only images in that request's projected context are read; images excluded by an existing compaction remain on disk. The stored transcript stays compact during the request.

This does not resize images, change their quality, clear previous conversation messages, or repeat the operation that produced an image. The configured per-image and combined image-input limits continue to apply to new image use. Disabling model image input omits images from requests without loading their saved pixels.

### Existing histories

Before Pi opens a matching Bot × Room session, Loom scans its JSONL one physical line at a time and externalizes inline images. It preserves message identities, parent links, tool-call identities, compaction records and unknown entries. It selects the most recently modified session whose workspace matches the current room, as before.

When a conversion is needed, Loom writes and synchronizes the assets and replacement history, retains an exact original as a sibling `*.inline-images-v1-<id>.bak`, and atomically replaces the live JSONL. The original session modification time is preserved so conversion does not change session selection. Cancellation or a failed conversion leaves the original live history in place. A record larger than the available migration allowance is rejected with a task error before it is parsed; the original is retained.

The first continuation of a large older session can take additional disk time and space. Backups deliberately retain the old inline images, so migration reduces active history and memory use rather than promising a smaller data directory. Keep enough free space for both the original and extracted assets. Routine cleanup does not delete these recovery backups.

Back up the complete data directory. Encrypted **Data transfer** includes image assets and migration backups. References are portable across directories and machines; live Pi headers are rebased by the existing transfer process. Recovery backups remain byte-for-byte originals. Earlier Loom versions do not understand the new image references, so an in-place downgrade requires a reviewed recovery of the corresponding history as well; replacing a live file with its older backup would omit messages appended since conversion.

Assets are checked against their expected byte count and SHA-256 digest when read. A missing, changed or corrupt asset produces an explicit task error. Restore the matching asset from a complete backup before resuming that conversation.

## Conversation admission

Each Loom application runtime has a shared memory allowance and a maximum number of loaded conversations. Work waiting for these allowances does not load a Pi history and lends its execution worker so already loaded tasks can finish. A paused conversation keeps its compact session reservation. An unstarted reservation is withdrawn when its room is paused or its task is stopped. Completion, failure, cancellation and update checkpoint cleanup release the retained reservation.

Version 0.20.1 fixes a loop in which several waiting conversations repeatedly returned a newly available memory reservation without making progress. After receiving a reservation, a task can immediately reclaim an execution worker when the scheduler permits it; if it must wait for a worker, it first returns the memory reservation. Both retained-session and history-preparation admission follow this handoff, including the existing scheduling order and pause/cancel checks. The configured memory and loaded-conversation limits still apply. An older process already caught in the loop may require a restart through its launcher or service manager to run the updated build because its in-app controls can be unresponsive.

| Environment setting       | Default                                                                                       | Meaning                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `LOOM_SESSION_MEMORY_MB`  | The smaller of 1,536 MiB and half the V8 heap limit, rounded down to whole MiB; minimum 3 MiB | Total estimated session and temporary memory allowance. Accepted values are integers from 3 through 65,536. |
| `LOOM_SESSION_MAX_LOADED` | `4`                                                                                           | Maximum retained sessions, including paused sessions. Accepted values are integers from 1 through 64.       |
| `LOOM_MEMORY_DIAGNOSTICS` | Off                                                                                           | Set to `1` for detailed numeric samples; capacity transitions always emit bounded numeric evidence.         |

Leave the memory setting absent to retain its heap-dependent default. An explicit value replaces that calculation. Restart Loom after changing these environment settings. A very small configured allowance may be insufficient even for an empty session and will fail admission rather than waiting forever.

The allowance has two fixed parts:

- **One third for retained sessions.** Each session reserves 16 MiB plus four times its active serialized history size. The estimate grows as new messages are retained; archived originals are not loaded or charged as resident history.
- **Two thirds for temporary work.** History preparation reserves bounded space before parsing. A request with images reserves four times the decoded image bytes before hydration and holds that reservation until the request finishes. Bounded growth headroom can also complete the current tool batch before a memory checkpoint. Keeping this space separate prevents loaded sessions from consuming all the space they need to finish.

When growth no longer fits the shared resident allowance, Loom tries to reserve temporary growth headroom, capped at the smaller of 64 MiB and one quarter of the temporary allowance. After every result of the current tool batch is persisted, it ends that low-level agent loop, releases the loaded transcript and execution worker, prepares the saved history, and waits for admission. The UI shows **Waiting for conversation memory**. The same task then continues from its recorded tool results without inserting a new request or replaying completed tool calls. Its operation receipts, counters and Chrome ownership remain attached to the task. Pause, stop, update and additional owner instructions retain their existing boundaries. A successful final answer does not need another model turn solely to recover capacity.

This is cooperative capacity recovery, not a promise to continue every oversized workload. An individually oversized active history, unavailable growth headroom, an excessive single result, or a storage failure can still produce an explicit task error with its persisted history intact. Already failed tasks from an earlier version are not automatically replayed. Review and resume them through the normal work/task controls after updating.

Requests that fit individually can wait for one another. A single history or image request that exceeds its entire allowance fails with the estimated size and configuration name instead of waiting indefinitely. Its saved history remains available. Existing context summaries may already exclude older images; increasing the allowance can be appropriate when the machine has enough memory for the actual request. Merely raising the model concurrency setting does not increase this allowance.

These are conservative admission estimates, not a hard heap or RSS cap. JavaScript objects, tool outputs, new image ingestion, HTTP transport, database reads and garbage collection have additional costs. Other Loom processes have their own allowances. Chrome, the inference server and other applications also use host memory. Increasing Node's heap limit alone does not remove retained data or bound any of those other consumers.

## Browser state delivery

The bundled client uses `/api/events?protocol=2`. Each stream starts with a complete `snapshot`, followed by `state_patch` events containing changed public records and removed IDs. Message text and reasoning continue to use their existing incremental events. Store changes are collected as IDs and read from committed state when the controller flushes, with the same public projections as full snapshots. With no subscribers, UI notification flushes do not build a complete snapshot.

The initial `GET /api/state` and the stream's initial snapshot remain for compatibility with the current loading and reconnect behavior. `/api/state`, legacy `/api/events` clients, and internal snapshot consumers retain the complete state contract. Conversation history is not paginated at the API boundary by this release. Large initial snapshots and retained browser history can still use substantial memory; the repeated full-state reconstruction during normal modern-client updates is removed.

Broadcast events are encoded once and shared across subscribers. Each connection writes chunks of at most 64 KiB, respects `write()` backpressure, and keeps at most one in-progress event plus 4 MiB of pending events. The initial full snapshot can exceed that pending limit. Small changes can queue while it is delivered, so a busy workspace can finish its initial synchronization. A stalled socket is disconnected after 15 seconds without a drain, and an overflowing pending queue is also disconnected. EventSource reconnects and obtains current durable state.

For a blocked legacy subscriber, repeated full-state invalidations are coalesced into one request for a fresh snapshot after the connection catches up. Revoked sessions are disconnected with their queued output discarded. These limits bound a connection's backlog, not the size of an individual initial snapshot or the number of open browser tabs.

## Memory diagnostics

With `LOOM_MEMORY_DIAGNOSTICS=1`, stderr receives JSON lines whose `event` is `loom_memory`. They include the phase, UTC timestamp, RSS, heap used/total, V8 heap limit, external memory, ArrayBuffer bytes and numeric phase metrics. Phases cover history preparation/loading, image hydration, reservation release, full snapshot encoding, and SSE queue or stall limits. Capacity pressure, checkpoint, resume and failure transitions emit the same bounded numeric diagnostics even when verbose sampling is off, so a future admission failure has direct evidence.

Measurements contain no prompts, reasoning, image pixels, file paths, task identifiers or credentials. Logging is limited to one sample per phase per second and skips a backed-up stderr stream. It does not force garbage collection or claim to identify every allocation.

For an investigation, retain the failure timestamp and compare these measurements with operating-system OOM records and the memory of Chrome and the model server. A V8 heap exhaustion and an operating-system OOM kill are different observations; neither is established merely by seeing a disconnected browser tab. A process killed by the operating system cannot emit a final application measurement.
