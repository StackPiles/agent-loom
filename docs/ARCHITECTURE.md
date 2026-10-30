# Agent Loom architecture

This document describes the initial implementation. [RESEARCH.md](RESEARCH.md) explains the upstream references; [API.md](API.md) describes the browser-facing endpoints.

## Process boundaries

Loom runs as one Node.js process with a React browser client. The operator supplies the inference server. The production process serves the built frontend and API on the same origin; development uses Vite and an API proxy.

```mermaid
flowchart TD
    Browser["Browser UI"] -->|"Commands"| App["API and controller"]
    App -->|"Snapshots and deltas"| Browser
    Scheduler["Timers and event triggers"] -->|"Tasks"| App
    App <--> Store["SQLite and local files"]
    App --> Runtime["Pi sessions"]
    Runtime --> Gate["One inference slot"]
    Gate --> Model["Operator's model server"]
    Runtime --> Tools["Explicit Loom tools"]
    Tools -->|"Approvals and activity"| App
```

The inference slot covers a model request, including a context-compaction request. It does not cover the entire task. A session awaiting approval or a tool can leave the model slot available to another bot.

## Code ownership

| Area                    | Main files                                      | Responsibility                                                                                                                     |
| ----------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Browser                 | `src/client/`                                   | Rooms, chat composition, mentions, activity, approvals, bots, automation, learning, inbox, settings, and English/Japanese display. |
| Shared contract         | `src/shared/types.ts`                           | Serializable application entities and event shapes.                                                                                |
| HTTP process            | `src/server/index.ts`, `app.ts`                 | Listening address, authentication, same-origin checks, static files, SSE, startup and shutdown.                                    |
| Application state       | `src/server/controller.ts`                      | Durable task identities, room membership, status transitions, approval resolution, memory/skill records, and UI events.            |
| Routes and integrations | `src/server/routes.ts`, `integrations.ts`       | Validated CRUD, model discovery, settings, webhook authentication, and automation configuration.                                   |
| Store                   | `src/server/store.ts`                           | SQLite objects, encrypted secrets, deduplication records, initial data, and encryption-key storage.                                |
| Agent runtime           | `src/server/runtime/index.ts`                   | Pi embedding, bot-by-room sessions, model provider configuration, streaming, usage, compaction, cancellation, and learning tasks.  |
| Inference queue         | `src/server/runtime/gate.ts`                    | Abortable single-slot acquisition; foreground work precedes waiting learning work.                                                 |
| Tools                   | `src/server/runtime/tools.ts`                   | Deliberate tool registry, permission checks, operation journal, handoff limits, and notifications.                                 |
| I/O boundaries          | `src/server/runtime/network.ts`, `workspace.ts` | Bounded network responses, public-address checks, text extraction, workspace file resolution, and file limits.                     |
| Scheduler               | `src/server/scheduler.ts`                       | Interval checks, URL baselines, IMAP cursors, persisted/coalesced webhook events, and per-rule overlap prevention.                 |

## State and event delivery

SQLite is the source of truth for application records. The initial schema uses a typed object collection (`kind`, `id`, JSON `data`), plus tables for encrypted secrets, deduplication, and event records. SQLite runs in WAL mode. Pi's own session transcripts live in separate files under the same data directory.

The store obtains a connection-lifetime exclusive database lock before schema setup, seeding, or controller recovery. A second owner of the same directory fails before it can mark live tasks interrupted or cancel approvals. The operating system releases the lock when the owning process exits, including a crash.

`GET /api/state` returns a complete snapshot. Server-sent events send incremental message text and fresh snapshots. The controller coalesces snapshot notifications over an 80 ms window; a reconnected client receives a current snapshot rather than trying to reconstruct truth from a missing browser tab. Room IDs and membership are database records. The selected room, drafts, and display preferences can remain in browser storage.

This first version returns unpaginated snapshots and retains history. It is intended for a small personal workspace, not a large deployment with many simultaneous users or an unlimited audit archive. Pagination, retention controls, and explicit migration tooling are future scaling work. There is no browser-side inference or authoritative browser-only task queue.

## Model requests and sessions

The runtime registers the configured endpoint with Pi as an OpenAI-compatible chat-completion provider. The initial adapter is text-only and uses streaming responses. Credentials remain in the backend. Pi's model catalog does not automatically fetch cloud catalogs, and Loom does not discover arbitrary CLI extensions or workspace instruction files.

Saved model credentials are reused only within the saved URL origin. Connection tests against another origin require an explicitly supplied credential; changing the saved origin clears an omitted key. The settings route compares normalized values before blocking execution-sensitive edits during active work, so submitting an unchanged model/workspace alongside a permission or learning change is allowed.

A separate Pi session directory is selected for each **bot × room** pair. Several bots may share the same model but keep distinct session transcripts and instructions. The current room's recent public messages are supplied as bounded context. Shared memories and that bot's own memories are included; other bots' private session transcripts are not copied into the prompt.

There is a second queue above the inference gate. It keeps a bot-by-room session exclusive while allowing up to 16 tasks to reach a model/tool boundary. At most one model request is active. Queued foreground tasks take priority over waiting background learning; an already-running model request is not preempted. The task queue is bounded to 200 active/queued tasks. A normal task is bounded to 30 model requests and 40 tool calls; a learning task gets at most six model requests. These are termination limits, not a task-success guarantee.

## Task states and recovery

| State               | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `queued`            | Accepted and recorded; waiting for a session/runtime slot.            |
| `waiting_model`     | Waiting for the shared inference slot.                                |
| `running`           | The agent is generating or advancing its loop.                        |
| `waiting_tool`      | A tool is executing.                                                  |
| `awaiting_approval` | An exact proposed operation is waiting for the owner.                 |
| `completed`         | This task's agent loop completed.                                     |
| `stopped`           | The owner or orderly shutdown cancelled execution.                    |
| `interrupted`       | Work was found active after restart or never started before shutdown. |
| `failed`            | The runtime reported an error that needs inspection.                  |

Only stopped, interrupted, or failed tasks can be resumed explicitly. The existing task ID is retained. Startup converts formerly active tasks to interrupted, cancels stale approvals, and marks unfinished message/activity records accordingly. Saved conversations remain available regardless of execution state.

Side-effecting tools journal a key derived from the task ID, tool name, and canonical arguments. A completed exact operation returns its saved result on replay. An operation recorded as started or failed is refused on automatic retry because its external outcome may be uncertain. The owner can inspect the target and start a new task when another attempt is appropriate.

This prevents a particular class of accidental repeats; it is not a distributed exactly-once protocol. A semantically similar command with different arguments has a different key, a stopped external process may already have produced effects, and an external service may have completed work just before a crash. Recovery must preserve and expose those limits.

## Approval and I/O boundaries

Shell, file writes, and network access each have Allow, Ask, or Deny policies. Defaults are Ask for shell/file writes and Allow for network. A tool reads the current permission when it requests an operation. Ask records the bot, room, task, tool name, description, target, and exact arguments. The UI renders those details. The decision applies to that operation; a pending approval is cancelled on stop or restart and expires after one hour.

Built-in file tools resolve paths inside the configured workspace, reject selected credential/application paths and symlink escapes, and bound text sizes. General web fetches accept public HTTP(S) destinations, validate resolved addresses and redirects, and pin DNS lookup results for the request. Configured local model and SearXNG integrations are deliberate exceptions to the public-web boundary. SearXNG and credential-bearing search calls reject cross-origin redirects.

Shell commands execute with the operating-system user's permissions. They can access files and networks outside the workspace boundary of the file tools. Their output and execution time are bounded and cancellation is attempted, but an approval card does not create an OS sandbox. The [security policy](../SECURITY.md) states the supported deployment assumptions.

## Bot-to-bot collaboration

`send_message` targets an enabled member of the current room by short handle. It records a public handoff message and creates a child task tied to the same root task. Self-handoffs, cross-room handoffs, excessive depth, and excessive total handoff count are rejected. The configurable initial budget is six handoffs.

The sending tool returns a queued-task receipt; it does not synchronously wait for another model answer. The recipient's answer appears in the room. Another handoff can explicitly return a concrete question or result to the first bot. Ordinary bot messages do not automatically wake every other room member, and completion does not automatically create a new synthesis task. This keeps multi-bot work predictable on a single inference slot and avoids acknowledgement loops.

## Proactive execution

The scheduler scans due rules every five seconds without occupying model capacity. Per-rule jobs do not overlap. Before a new trigger creates work, the scheduler checks the previous task recorded in `automationState`; if it remains active, polling is deferred to a later interval. All triggered tasks go through the same controller, target validation, runtime queue, and tool permissions as chat tasks.

- **Interval:** the next due time is persisted. The minimum is one minute. A restart coalesces missed intervals rather than replaying a historical backlog.
- **URL watcher:** the first successful fetch establishes a source/hash baseline. Later changes in bounded, extracted readable text queue a task containing the current excerpt. This is not a browser renderer or an arbitrary page-diff engine.
- **IMAP:** a read-only mailbox selection records UIDVALIDITY and a UID cursor. The first check does not process old mail. Later checks fetch at most 20 new envelopes/dates, retain the remaining cursor, and never request bodies, attachments, flag changes, or sending. A UIDVALIDITY change creates a new baseline and notification.
- **Webhook:** the HTTP route authenticates a rule-specific token. Nonempty event IDs are persisted for deduplication. While the previous task is active, the newest 20 events are stored for a later batch; event text is capped at 1,000 characters, and overflow is reported as coalesced. Pending batches survive restarts. This is a bounded trigger buffer, not a lossless event bus.

URL and IMAP polling require network permission **Allow**. Ask or Deny produces an automation error; unattended polling does not silently grant itself permission. Errors are visible in rule records and repeated identical failures do not generate an inbox notification on every poll. Shutdown aborts in-flight transports and stops timers.

Source edits invalidate source-specific hashes or mailbox cursors while retaining the prior task ID, so editing a rule cannot bypass its overlap guard. Disabling an assigned bot, removing it from the destination room, or archiving that room pauses affected enabled rules. Re-enabling a valid rule is an explicit owner action.

The app server must stay running for any of these triggers to work. The notification tool writes to the application inbox. External messaging platforms, mobile push, and provider-specific mail OAuth are not implemented in this version.

## Memory and learning

Memory is a concise fact or preference; a skill is a reusable procedure. Both can be scoped to one bot or shared. Bots can write their own memories and propose skill candidates. Only the owner-facing API activates a skill. The prompt lists active skill metadata; the bot uses `read_skill` to retrieve relevant instructions. A use count records reads, not successful outcomes.

With automatic learning enabled, a completed root task can queue a separate review when it used at least two tools and produced a substantive answer. The review gets bounded task/tool evidence, an isolated session, lower queue priority, and only memory/skill tools. It cannot use the normal shell, web, handoff, or notification tools. The review is instructed to prefer no change over unsupported or redundant lessons. Skill candidates retain the source task and evidence; user edits and restores retain revisions.

This is experience retention, not weight training. Memory writes can still be incorrect, and a convincing skill is not necessarily a correct procedure. The UI supports inspection and correction; the research document proposes outcome-based evaluation rather than treating skill count as a quality score.

## Credentials and deployment

The native server defaults to loopback. Binding elsewhere requires an application token of at least 24 characters. The browser exchanges it for an HttpOnly, SameSite cookie; API clients can use Bearer authentication. API snapshots expose only whether model/search/mail secrets are configured. Same-origin checks and local-mode Host checks restrict browser requests; these measures do not turn the app into a multi-tenant service.

Sessions are bound to the current access-token fingerprint, so rotating that token invalidates old cookies. Event streams recheck authentication before sending and close when their session is revoked; logout also closes streams associated with the revoked session.

Stored integration secrets use AES-256-GCM, with the encryption key stored as `secret.key` alongside SQLite. The full directory must be backed up and protected. General conversation/task records and Pi session transcripts are not encrypted by Loom. A compromise of the process account or both database and key defeats this local encryption boundary.

The supplied Docker image runs as a non-root user, persists `/app/data`, and is published on host loopback by Compose. Docker provides a deployment boundary only to the extent its mounts, networks, and host permissions are configured appropriately. It does not provide separate sandboxes for individual bots.

## Validation boundary

The test suite uses temporary stores, deterministic model/transport fixtures, and local application requests. It covers consequential state, queue, approval, recovery, path/network checks, automation baselines, webhook deduplication/coalescing, and IMAP envelope limits. The repository includes cross-platform CI and a container build/health workflow.

Those tests establish application behavior under their fixtures. They do not measure the accuracy of a local model, authenticate to a real mailbox, certify an inference server's tool-call template, or establish long-term learning gains. Verify the actual model/server combination with a small conversation and tool task before depending on more complex workflows.
