# Changelog

## 0.14.4 — 2026-11-11

- Add nonblocking pending checks to work checkpoints so service-review waits, future research, missing input and teammate follow-ups can be carried to the next wake-up. Clarify the difference from already attempted external operations whose success or failure is unknown in tool descriptions, system instructions and current work context.
- Show pending checks as ordinary progress, and distinguish blocked work awaiting an outcome review from other work awaiting resumption. Preserve pending checks through review, older checkpoint updates and data transfers.
- Keep existing checkpoints compatible. Existing blocked work, actual unknown mail outcomes, owner stops and failed-task recovery retain their review requirements; no stored uncertainty is automatically reclassified.

## 0.14.3 — 2026-11-11

- Avoid repeated automatic summaries caused by counting reported reasoning tokens that the validated text-only OpenAI-compatible transport does not resend. Require a valid same-model usage anchor and unchanged input prefix; keep image-enabled requests, replayed reasoning and ambiguous usage conservative.
- Use the same reasoning projection for ordinary summary decisions, request output budgeting and summary-size comparisons. Preserve provider-reported usage, costs and original session entries, and keep the input safety margin and real context-overflow recovery.
- Keep an unchanged upcoming prompt/tool preview from invalidating usable response counts. Changed instructions and tools still require a fresh estimate.
- Create summary activities only when summary generation begins. An unnecessary threshold check no longer appears as an interrupted summary, while actual cancellation and failures remain visible.

## 0.14.2 — 2026-11-11

- Update Pi to 1.5.2 and Undici to 8.12.3. Adapt to Pi's schema exports and preserve sanitized timeout diagnostics when its newer provider errors include nested causes. The SDK update also brings incremental parsing of large tool arguments and session-persistence/lifecycle fixes.
- Reserve a proportional input-estimation margin, respect smaller per-request output ceilings, and avoid sending requests with no remaining output budget. Correct at most one explicitly rejected, pre-generation context HTTP 400 per task by lowering that request's output ceiling; rejoin the shared queue and preserve completed tool results. Ordinary errors, partial generations and timeouts are not retried by this correction.
- Validate a complete summary and the next projected input before saving compaction. Budget the visible summary separately from reasoning, include retained history, system/tool declarations and pending instructions, and reject ineffective or truncated summaries after bounded attempts.
- Recompress an oversized existing summary even when Pi has no additional old messages to compact. Append a new checkpoint while retaining the original session, recent-history boundary, operation evidence and owner instructions. Display the estimated reduction and preserve the prior checkpoint on failure.
- Mark additional owner instructions delivered only after the model server accepts the request. A context rejection keeps them pending, and a correction arriving during that rejection replaces the stale request before retry.

## 0.14.1 — 2026-11-11

- Dispatch autonomous wake-ups by their reserved time, with stable creation-time and ID ties. Previously, record creation order could let an older recurring reservation repeatedly take the room's next available slot while another overdue reservation never ran.
- Preserve room spacing, admission limits, missed-run policies and explicit work holds. Add regression coverage for reversed creation/time order, recurring starvation and eligible work behind a held reservation.

## 0.14.0 — 2026-11-11

- Add explicit instructions to one active task from the chat composer, preserving its conversation, workspace, work identity and operation history. Keep ordinary chat as a new request and show the selected task, optional immediate delivery, and accepted/delivered states.
- Persist ordered text and image inputs with idempotent acceptance. Preserve pending instructions across pauses, stops and restarts, include them in data transfer, and avoid silently retargeting a finished task.
- Reconsider unstarted tools and prepared model requests when new instructions arrive. Withdraw stale pending approvals with a distinct superseded reason, preserve issued operation receipts, and let started external operations finish.
- Add generation-only immediate delivery within the same task. Retain partial output and resume with the new input without treating the transition as an owner stop, resetting task budgets or restarting external tools.

## 0.13.0 — 2026-11-10

- Add Chrome upload settings for file count, individual and combined file sizes, and shared temporary storage. Defaults are 10 files, 256 MiB per file, 512 MiB per upload and 2048 MiB of storage; configurable maxima are 100 files, 1024 MiB, 2048 MiB and 32768 MiB. Validate whole-number ranges and file ≤ total ≤ storage, preserve legacy omissions and transfer saved values with application data.
- Apply changed limits during active tasks, including immediately before an approved upload is issued. Preserve completed operation receipts without re-uploading. Give file selection a five-minute action timeout while retaining the distinction between selecting files and a website completing its submission.
- Keep one immutable private copy per uploaded file and bound storage across browser sessions, including retained copies. Track actual Chrome processes and exit evidence; reclaim proven-ended sessions on normal closure, startup and periodic checks without treating an MCP disconnect as proof that existing Chrome closed. Unknown, live, inaccessible and legacy sessions remain counted; refuse new attachments instead of deleting copies that a browser may still use.
- Explain the existing memory cost of pending approval buffers and the manual cleanup needed for older or unidentifiable copies after their submissions and browsers finish. Extend deterministic coverage and the real Chrome fixture to a 100 MiB file, exact streamed multipart bytes and delayed submission after source changes.

## 0.12.0 — 2026-11-10

- Add `browser_use` file uploads for observed file inputs and chooser buttons. Validate workspace-relative files, reject empty or missing sources, and show filenames, sizes and content fingerprints in the existing browser approval flow.
- Revalidate source files and workspace scope after approval, and give Chrome private immutable copies so a later form submission uses the reviewed bytes. Negotiate only the private upload directory with MCP and preserve operation receipts, page-state checks and no-retry behavior.
- Extend the real Chrome smoke with multiple binary files, Japanese filenames, hidden-input chooser buttons and actual multipart byte comparison after the original files change.
- Fix Japanese filenames disappearing from file selections in Loom-launched Chrome on Linux. Preserve the selected `LANG`, `LANGUAGE`, `LC_ALL` and `LC_CTYPE` values in the MCP child environment, and use `LANG=C.UTF-8` on Linux only when `LANG`, `LC_ALL` and `LC_CTYPE` are absent. Explicit locale choices remain unchanged; restart and reconnect dedicated Chrome after updating.

## 0.11.2 — 2026-11-10

- Render model reasoning, notification bodies, quoted notifications and sidebar progress updates with the same Markdown/GFM renderer as chat answers. Support headings, emphasis, lists, tables, links and fenced code while keeping stored source text intact.
- Preserve streamed reasoning updates, manual reading position and disclosure state. Scope notification and activity styles so Markdown headings, nested quotes and wide code/table content retain their intended layout. Exact tool logs, diagnostics and approval arguments remain literal text.

## 0.11.1 — 2026-11-10

- Create new bot calendar wake-ups without a separate user approval when the room's autonomous scheduling policy permits them. Route `manage_automation` calendar creation through the same durable work and reservation service as `manage_wakeup`, including room scope, lead time, count and admission limits, checkpoints and owner stops.
- Guide direct chat requests to the work tools, and return work/reservation IDs for subsequent changes. Preserve exact completed-operation receipts through upgrades and recovery. Existing owner-managed rules and interval, page, webhook and mail integrations retain their approval workflow.

## 0.11.0 — 2026-11-10

- Attach PNG, JPEG and WebP images to chat by pasting, dropping or choosing files. Preview and remove pending images, send images without text, and deliver the actual pixels to an image-capable conversation model when image input is enabled. Persist the attachments and their task references without putting image bytes in public snapshots or browser draft storage.
- Extend `generate_image` with optional reference images and add a separate `edit_image` tool with a required source image, optional references and mask. Use one image configuration and queue; send image-bearing requests to the OpenAI-compatible multipart editing endpoint. Keep existing text-only generation and sampling-step behavior.
- Preserve source dimensions by default for edits, save each result as a new image, and retain input identities and hashes. Pin image inputs before approval and preserve completed operation receipts through interruption and recovery.
- Include uploaded images, image task references and editing provenance in data transfers. Keep existing conversation-model input preferences, network/image permissions, room/workspace boundaries and queue limits in force.

## 0.10.0 — 2026-11-09

- Share inference capacity fairly between logical work groups, including their continuations, handoffs and context summaries. Account for recent slot occupancy and waiting time instead of indefinitely serving one task class first. Keep all available model slots usable by ready work.
- Add temporary owner priority for up to three model admissions within five minutes, and a bounded `request_priority` tool for one bot-requested admission in the same window. Share and persist the allowance across related tasks; repeated requests, cancellation, delegation and recovery do not refill it. Limit consecutive priority admissions when another work group is ready.
- Show all active and queued tasks, their waiting reasons, summary activity and shared priority allowance in the task queue. Let owners request and revoke temporary priority without stopping issued model requests or tools.

## 0.9.1 — 2026-11-09

- Give ordinary chat, scheduled and delegated tasks more room to finish longer work: raise the per-execution model-request limit from 30 to 300 and the tool-call limit from 40 to 400. Keep automatic learning reviews at ten model requests and 40 tool calls.
- Document that context compaction counts toward model requests, explicit task recovery starts a new allowance, and a live room pause preserves the current counters.

## 0.9.0 — 2026-11-09

- Add owner-enabled autonomous wake-ups for a bot itself or enabled teammates in the same room. Keep all existing rooms off by default and ordinary `manage_automation` proposals under their existing exact approval. Actual tool permissions remain in force.
- Persist work purposes, task/standing kinds, creators, source tasks, pinned workspaces and progress checkpoints separately from reservations. Carry work/run identity through one-time continuations and handoffs; give recurring occurrences a fresh run. Require stable reservation keys and current revisions for edits.
- Bound autonomous work with room-wide defaults of five minutes between scheduled dispatches, 24 pending reservations and 12 work-linked task admissions per hour. Prioritize eligible chat over automation over learning, lend background workers at safe boundaries, and reserve one of the 16 task workers for chat without cancelling issued inference or tools.
- Show autonomous work and its next targets in Automations and the room. Add whole-work pause, completion and cancellation, individual reservation cancellation, and explicit owner review of uncertain outcomes. Policy revocation pauses work; re-enabling it does not silently resume it or retry failed actions.
- Block continuation from a server-recorded unknown mail-send outcome, including attempts to establish work after an unknown send. Retain the draft/operation reference for explicit owner review without trusting a model's success claim, relabeling the draft as sent or retrying it.
- Extend exact operation receipts across continuations by the same bot in the same work/run. Keep completed shell commands task-local so later tests and inspections can run again, while uncertain effects remain blocked. Preserve the limits of exact-argument deduplication rather than claiming semantic exactly-once execution.
- Include work and reservation records in data transfers, rebase their workspace references, retain receipt identities, set imported autonomous room policies off and pause unfinished imported work.

## 0.8.3 — 2026-11-07

- Let bots save, replace and explicitly clear a write-only credential while creating or editing their assigned service records, after the existing exact approval.
- Show the credential action in approval cards without displaying its value, including removal caused by a changed service origin or login.
- Withhold dedicated credential inputs from activities, approvals, operation arguments and persisted model tool-call history. Use keyed fingerprints for stable operation receipts, preserve encrypted storage and reject missing redacted inputs after interruption.
- Revalidate the acting bot, room, mailbox and reviewed service revision at the actual save boundary. Add credential persistence, approval, execution-history and update regression coverage.

## 0.8.2 — 2026-11-07

- Distinguish explicit task stops from server shutdown, process signals, supervisor disconnection, data transfer and unexpected model cancellation. Preserve the specific cause as an interruption and keep completed operation receipts and explicit recovery behavior.
- Capture known model connection, response-header and response-stream timeout codes before provider error normalization loses them. Report elapsed request time and HTTP 408/504 separately from Loom's response/idle budgets; retain an unknown-source category when evidence is missing.
- Add localized failure explanations and copyable diagnostics for current and historical status errors. Keep partial answers and original errors visible, and offer selectable diagnostic text when clipboard access is unavailable.
- Add five-bot/two-slot cancellation and failure-isolation checks, real TLS timeout coverage, lifecycle and UI regressions, and desktop/mobile Chrome diagnostic screenshots. Existing timeout values, concurrency settings and no-retry behavior are retained.

## 0.8.1 — 2026-11-06

- Identify notification senders by saved bot name and handle, show the originating room, and distinguish system notices and legacy task-based attribution. Keep known sender identities after rename or deletion.
- Add an inline reply form to the inbox. Route each reply to the recorded sender in the original room, preserve the source notification as quoted context, and open the room after sending.
- Persist reply receipts to prevent duplicate messages and tasks after retry or restart. Keep drafts through live updates and failures; reject unavailable or inconsistent reply targets without choosing another bot.
- Include sender information in desktop notifications and a collapsible source quote in chat replies. Add real Chrome desktop/mobile inbox and reply coverage.

## 0.8.0 — 2026-11-06

- Let bots search, read, revise, merge and archive their own unlocked memories, with room scope, evidence and recoverable version history. Keep shared and fixed records under owner control.
- Automatically activate newly created bot skills and let bots revise their existing active skills in place. Preserve existing candidates, archives and owner deactivation; retain progressive skill loading and current tool permissions.
- Record revision authors, reasons and source evidence, reject stale-version writes, and retain drafts through editor conflicts. Add memory history, change inspection, fixed-content controls and reversible archiving to the learning screen.
- Persist the exact skill version first read by each task across pause/restart, while checking live availability. New tasks use the current version. Keep background reviews bounded and at lower queue priority.

## 0.7.9 — 2026-11-06

- Allow the complete image-model form, including enablement, endpoint, credentials, model, size, response format, timeout and the 2K/60-minute/parallel preset, to be saved when every active room task is fully paused. Re-lock edits and saves if work resumes, is still draining or the UI disconnects.
- Refresh the full image configuration for subsequent bot image calls after resume. Preserve each already prepared request with its original settings, credential, approval and operation receipt; queued sharing remains live, and disabling generation prevents undispatched bot requests.
- Keep the existing 2K, 60-minute and parallel defaults, explicit saved settings, credential-origin handling and active owner-generation guards.

## 0.7.8 — 2026-11-06

- Allow the image-input and image/text slot-sharing switches to change when all active room tasks are fully paused. Continue blocking changes while an action is still finishing or another room is active, and validate actual suspension on the server.
- Apply the new image capability and slot-sharing choice when work resumes, including requests already waiting for capacity. Preserve parked sessions, pending approvals, queued image requests and operation receipts without cancelling or replaying them.
- Default new or missing image settings to square 2K, a 60-minute deadline and independent image/text capacity. Retain explicit saved settings; the existing preset remains available for idle installations.

## 0.5.0 — 2026-11-04

- Make desktop chat the main workspace with a default Focus view, compact navigation, on-demand activity details and denser headers/composer controls. Retain room switching, notifications, approval indicators and the full-layout toggle; include the display preference in encrypted data transfers.
- Pause automatic scrolling on upward reading gestures and keep the visible content anchored while other bot messages, reasoning and images grow. Resume through Latest, an intentional return to the end, a user send or a room change.
- Add a one-image test directly to image settings using the current unsaved configuration, an actual generation request and a temporary raster preview. Reuse image validation, network policy, cancellation, timeout, inference admission and origin-bound credentials; keep test results out of chat and saved model settings.
- Clarify the existing handoff budget: 6 by default, configurable from 0–20, counted as total directed requests and depth per originating task. Preserve existing saved limits.

## 0.4.0 — 2026-11-04

- Add **Settings → Data transfer** with password-protected export, chunked upload, validation preview, automatic destination backup, replacement and same-process restart. Preserve saved credentials, full application history, Pi sessions, generated files and workspace contents.
- Rebase workspace and session references for the destination while retaining IDs, modification times, operation receipts, mail outcomes and deduplication state. Keep destination login and process configuration local, and disable imported automations to prevent immediate duplicate work.
- Keep an OS-backed data-directory lease across restart and journal the per-entry replacement for crash recovery, including Docker volume roots. Reject damaged archives, unsafe paths, unsupported schemas, capacity overruns and stale destination previews before replacement.
- Document migration scope, machine-specific connections, retained backups and recovery. Add synthetic archive, lifecycle, API and UI regression coverage.

## 0.3.5 — 2026-11-04

- Initialize new mailbox UID namespaces on servers identifying themselves as Courier-IMAP, then return to read-only EXAMINE before retrieval. A bounded process-local source/namespace cache avoids repeating successful initialization on normal reconnects; other IMAP servers retain EXAMINE-only access.
- Keep UIDVALIDITY checks across connections and report a stale mailbox identity separately from a missing message. Refused SELECT can fall back to EXAMINE for stable read-only mailboxes; interruption and transport failures do not continue into reads.
- Document SELECT's transient Recent-flag effect. No message is marked Seen, moved or deleted, and the adapter does not issue STORE, CLOSE or EXPUNGE.
- Add real TLS regressions that reproduce the v0.3.4 list-success/read-not-found failure with an ephemeral Courier namespace, plus namespace reset, failed initialization and read-only access coverage.

## 0.3.4 — 2026-11-04

- Read all responses to a single-message IMAP FETCH and merge only the requested UID. A preceding flag update for the same or another message no longer hides the actual metadata or body and produces a false missing-message error.
- Preserve read-only EXAMINE/BODY.PEEK, mailbox identity checks and bounded source retrieval. A deleted message still reports not found; a matching message with incomplete metadata or no usable body has a separate, sanitized read error.
- Add real TLS protocol regressions for unsolicited updates, split metadata, disappearance between listing and reading, missing bodies and oversize rejection before body retrieval.

## 0.3.3 — 2026-11-04

- Recover missing IMAP mailbox metadata with one read-only STATUS request after EXAMINE. Courier-style responses that omit UIDNEXT no longer produce an invalid NaN UID search range after a successful connection test.
- Validate message counts, UIDNEXT and UIDVALIDITY before listing, reading or polling; reject incomplete or conflicting identity metadata with a specific safe error rather than guessing a mailbox namespace or advancing a receive cursor.
- Handle empty mailboxes with historical UID numbers without searching old gaps, preserving the boundary for the next arrival. Keep existing paging, text search, first-poll arrival cutoffs and read-only behavior.

## 0.3.2 — 2026-11-04

- Make saved mail credentials explicit in the editor: Saved, Not saved, Re-entry needed and Not configured states, with optional-replacement guidance. Stored passwords and API keys remain write-only, and testing does not imply saving.
- Identify receiving (IMAP) and sending (SMTP) connection failures separately and classify known DNS, refused-connection, TLS and timeout errors using fixed, credential-free messages. Keep certificate validation and existing send/retry protections.
- Report IMAP search failures after a successful mailbox open as message search/list failures instead of the generic secure-connection error. Connection tests do not fetch or search messages.
- Document Sakura mailbox setup, initial-domain TLS requirements, independent receive/send credentials and connection-test troubleshooting.

## 0.3.1 — 2026-11-02

- Give bots a compact current mail context at each task start or explicit resume: assigned enabled addresses, effective read/send policy and incoming-mail automation status for the current room. Bots can use the supplied account IDs directly instead of discovering their own address through an extra tool call.
- Rebuild this context from local configuration, including account removal and permission changes, without contacting a provider or adding a model request. Bound the metadata, omit credentials and other bots' identities, and retain live tool checks and explicit account refresh when needed.

## 0.3.0 — 2026-11-02

- Add **Scheduled wake-ups**: one-time local datetimes, daily times and selected weekdays, with explicit IANA time zones, next-occurrence previews, weekday shortcuts and visible one-time outcomes.
- Persist calendar occurrences and consume one-time reservations atomically with task admission. Coalesce missed wake-ups into one recovery task or skip occurrences at least one minute late, preserve pending times across unrelated edits, and keep busy/admission failures from multiplying or losing reservations.
- Extend room automation tools and approval cards with exact schedules, time zones and recovery behavior. Supply current task/server time for relative-date interpretation while preserving explicit approval, room restrictions and operation replay protection.
- Keep recurring local clock times across timezone transitions, reject nonexistent one-time datetimes, skip missing recurring times and use only the first occurrence of repeated local times. Document setup and limits in [docs/SCHEDULES.md](docs/SCHEDULES.md).

## 0.2.2 — 2026-11-02

- Hide navigation scrollbars in the sidebar and page tabs while retaining scrolling. Keep the tab selection underline inside its bounds and the keyboard focus ring visible, and reveal focused tabs when space is limited. Content and conversation scrollbars remain available.

## 0.2.1 — 2026-11-02

- Make **Select a mail account** selectable in incoming-mail automations so the owner can return to an unselected state. Keep an explicitly empty choice when changing the target bot or room; saving still requires a valid account or the legacy IMAP configuration.

## 0.2.0 — 2026-11-01

- Add **Mail & services** with external email connections, bot assignments, connection testing, paginated message search, inert plain-text reading, local drafts and exact send review. Connect an existing IMAP/SMTP mailbox, AgentMail inbox or Resend Inbox; hosting, domains, mailbox provisioning and provider choice remain external.
- Give assigned bots provider-neutral mail tools and a service-account registry. Keep credentials encrypted and write-only, separate from bot profiles and rooms. Registry metadata can be proposed by a bot with exact approval; stored service credentials are not yet used for automatic sign-in.
- Keep mail intake independent of LLM availability. Persist up to 100 pending events per watcher, submit batches of up to 20 when its prior task finishes, deduplicate overlapping API pages, and stop advancing the cursor when the buffer fills. Newly created account watchers retain arrivals between creation and their first poll.
- Add independent Ask/Allow/Deny sending policy, revision-bound draft approval, durable request receipts and terminal unknown-send states. Stop, disconnect and restart never automatically resend an uncertain attempt; provider acceptance does not imply delivery.
- Migrate compatible legacy IMAP watchers to read-only connections, preserving their processed UID and prior task. Keep non-email IMAP usernames on the legacy path. Account changes clear obsolete cursors, and deleting a bot or disconnecting an account preserves external accounts and service identity records.
- Add provider transport, mail-tool, scheduler, API, migration and UI regression coverage. Document setup, extension contracts and current limits in [docs/MAIL.md](docs/MAIL.md).

## 0.1.9 — 2026-11-01

- Let bots in direct user room conversations list, create, edit, pause and resume room automations. Review the exact trigger, interval, teammate and instructions before saving; reject conflicting edits and suppress completed-operation replay. Scheduled work and handoffs cannot create more schedules.
- Allow bots to prepare disabled email drafts without credentials. Complete them from the automation card's connection setup; never pass mail passwords or webhook tokens to the configuration tools.
- Add a Gmail preset with automatic server/TLS/inbox settings, Google app-password setup links and a separate read-only connection test. Localize connection errors, cancel stale tests and keep testing separate from saving, polling baselines and bot work. Google OAuth sign-in is not included.
- Bind saved mail credentials to their original server/account, clear them on retargeting, and normalize grouped app-password whitespace only for Gmail. Retain the existing envelope-only monitoring behavior and first-poll baseline.

## 0.1.8 — 2026-11-01

- Keep each room's bot states and pending approval count above the composer, visible while other bots stream or older messages are off screen. Open a focused review dialog containing every pending action and its exact target/arguments; retain approvals in their original messages and share in-flight decisions across both views.
- Add per-room approval badges, cross-room approval navigation and a pending count in the browser title. Reviewing or dismissing an approval list preserves the conversation's reading position; closing the dialog does not approve or reject anything.
- Distinguish queued work, generation-slot waits, response preparation, streamed reasoning, streamed answers, tool execution, approvals, stopped/interrupted work, errors and completion. Expose per-bot stop/resume controls and explicit navigation to the corresponding run.
- Derive live indicators from task state, the current run and connection state. Stop stale cursors, reasoning indicators and old tool-log animations after termination or resume; label disconnected active work as unconfirmed instead of pretending it is running or stopped. Respect reduced motion.

## 0.1.7 — 2026-10-31

- Add optional Chrome control through the pinned official Chrome DevTools MCP adapter, embedded in Pi's existing tool loop. Connect to existing Chrome with its consent flow, or launch installed Chrome using a separate persistent profile. No Python agent, runtime package installation or additional language-model endpoint is required.
- Expose tab discovery, navigation, accessibility snapshots, element actions, page keys, scrolling, dialogs and screenshots. Save screenshots as authenticated chat attachments; pass image pixels to the model only when explicitly enabled for a vision-capable endpoint.
- Add dedicated Chrome settings with connection state, tab summaries, cancellation/disconnect and separate permissions. Save-and-connect preserves unrelated unsaved settings. Automatic approval covers only tab lists, snapshots and screenshots; other actions show exact targets and arguments.
- Serialize browser actions across bots, recheck observed page/element state before effects, protect Loom control pages, and journal mutations to avoid automatic replay. Explicit disconnect pauses reconnection. Bound child lifecycle, timeouts, page content and images; disable adapter telemetry, update checks and configuration discovery.
- Add service, API, real Pi HTTP and settings interaction coverage, plus a separate CI smoke check using installed Chrome against synthetic pages.

## 0.1.6 — 2026-10-31

- Dismiss dialogs, room action menus and mention suggestions when clicking outside. Keep interior clicks and text-selection drags safe, close menus after actions, and handle Escape at the topmost open layer. Native mobile sidebar/activity backdrops retain their existing dismissal behavior.
- Add system-prompt assistance in the bot editor using the configured language model. Describe a role, optionally improve the current prompt, watch partial output, edit a completed draft, and explicitly apply it before saving the profile. Restore the previous editor text with Undo replacement.
- Keep prompt generation separate from bot tasks and tools, while sharing the global inference limit. Persist request IDs, progress and recent drafts across navigation; support cancellation, retry confirmation without duplicate generation, and restart interruption without automatic replay. Incomplete or failed output cannot be applied as a completed draft.

## 0.1.5 — 2026-10-31

- Make the selected bot color visible as an accent frame around image avatars in chat, member lists, cards and profiles. Label the control **Accent color**, show its selection clearly, and preview changes before saving the profile.
- Add Luna, Pip, Sage and Bram to the bundled portraits, expanding the standard character picker from four to eight while preserving existing selections and the image-generation workflow.
- Drive production avatar smoke checks from the shared character catalog so every bundled WebP is checked for successful HTTP delivery, media type, complete container and bounded asset size.

## 0.1.4 — 2026-10-31

- Expand output token choices through 1,048,576 (1M), retaining context choices through 2,097,152 (2M). Label million-scale options with exact counts, preserve saved/custom/default budgets, and keep output below the combined context budget. Reserve output space before compacting history.
- Add four bundled character portraits and a character-first bot profile picker. Upgrade only the original Aster/Nova avatar choices once, without replacing customized avatars or recreating deleted bots. Keep legacy symbols available and image failures bounded by an initial fallback.
- Generate character avatars directly from the configured image model, preview results, select an image for the profile draft, and apply it when saving. Retain recent results and visible queued/generating/cancelled/failed/interrupted states across navigation and restarts.
- Give avatar jobs durable request IDs, one active job at a time, cancellation and shutdown cleanup, authenticated image storage, and the same optional global inference capacity as chat images. Explicit generation never silently replays after a restart or changes a bot profile.

## 0.1.3 — 2026-10-31

- Clarify the sidebar's single application identity and Settings navigation. Application data and each room's working folder are distinct; the sidebar no longer suggests an unimplemented workspace switcher.
- Add a separately configured OpenAI-compatible image-generation model and encrypted credential. Bots can call `generate_image`, retain images as authenticated chat attachments, and restore completed images after resume without regenerating them. Display and download PNG/JPEG/WebP outputs with bounded size and validated storage paths.
- Add reasoning-effort values `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. Explicit mode sends the selected literal value; server-default mode omits it. Unsupported values remain a provider compatibility issue, with no silent downgrade.
- Make global inference capacity configurable from 1 to 16, retaining 1 as the default. Changes apply during work; capacity reductions drain existing streams. Keep the same bot × room session exclusive and allow eligible independent requests to use available slots.
- Add per-room parallel responses, request-scoped room admission, queue capacity and wait reasons, and task-specific progress/stop controls for simultaneous replies. Peer context includes completed messages rather than partially streaming responses.
- Serialize image generations and share model capacity by default. Permit image/text overlap when the owner selects independent hardware. The inference server continues to own batching, prefill, caching, and GPU scheduling.

## 0.1.2 — 2026-10-30

- Add per-room workspaces with native folder selection, a default-folder reset, and the effective folder visible in chat. Settings distinguishes the default workspace from room overrides.
- Pin task workspaces for tools, sessions, handoffs, and learning. Prevent an active room's folder from changing and a stopped task from resuming into a different root.
- Add local desktop selection through the Windows Explorer-style folder dialog, macOS native dialog, or an available Linux desktop picker. Explain Docker/headless/remote limits and retain an explicit server-path fallback.
- Fix avatar identifiers such as `sparkles` and `compass` appearing as oversized text. Render known icons as SVG and bound custom avatar content in chat, member stacks, and bot cards.

## 0.1.1 — 2026-10-30

- Display provider reasoning, intermediate updates, tool activity, approvals, and stop/resume controls inside the relevant chat response. Reasoning streams independently from the answer, remains attached to its original run, and is preserved after interruption. Servers must actually return supported reasoning text.
- Add opt-in **Smart auto-approve** for public web reads, configured search, exact built-in workspace inspections, and new small text documents. Existing-file overwrites and arbitrary commands still request review. Automatic decisions record their reasons; new-file writes cannot overwrite a file created concurrently.
- Replace inference token number fields with powers-of-two selectors while preserving existing custom values. Context choices extend to 2,097,152 tokens and output choices to 131,072 tokens; output must remain smaller than context.
- Add optional OpenAI-compatible reasoning-effort settings while retaining server-default behavior for existing configurations.
- Remove promotional interface copy and adjust narrow-screen, dialog, approval, composer, and long-content layouts. Narrow windows no longer reopen the activity drawer automatically.

See [validation](docs/VALIDATION.md) for executed checks and verification limits, and [installation](docs/INSTALL.md#update) for update instructions.

## 0.1.0 — 2026-10-30

Initial public release with serial Pi inference, persistent rooms and bot sessions, explicit approvals, proactive automations, notifications, and reviewed candidate skills.
