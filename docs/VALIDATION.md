# Version 0.8.6 validation

Date: **2026-11-08 (JST)**. Application version: **0.8.6**.

- `npm run check`: **1,022 tests passed**, with zero failures, skips or cancellations; client/server TypeScript, the production build, supervised production HTTP smoke and the actual compiled update-verification handshake passed.
- Formatting and `git diff --check` passed. The focused image suite and all six targeted real-Pi cases also passed.
- Cross-platform, container and real Chrome results belong to the matching [GitHub CI run](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml), separately from local verification.

The previous image-step feature configured a saved default, but `generate_image` exposed only `prompt` and `size`. That missed the requested per-call bot control. A new regression first reproduced the defect with the saved count still at 40 and the call specifying `steps:17`: the actual HTTP prompt contained `sample_steps:40`. Two additional real-Pi regressions initially failed because the actual model request did not declare a `steps` argument. Earlier tests changed the saved default, so they could not detect this gap.

The bot tool now declares an optional integer count from 1 to 1,000. Resolution is the explicit per-call count, then the saved default, then the server default when neither supplies a count. An override stays in the normalized arguments passed from request preparation through generation; the owner-selected format remains fixed, and the call cannot mutate saved settings.

The focused image suite passes all 29 cases. Seven new cases inspect loopback HTTP bodies and request identity: all four formats are exercised with both a saved count of 40 and no saved count; an explicit 17 or 23 wins in each case. They also verify same-effective-count receipt reuse, different-count separation, omitted/undefined legacy identity, invalid direct/tool inputs rejected before approval or dispatch, and conflicting prompt-tag rejection.

Four real-Pi pause cases cover both approval and inference-queue waits, preserving the two existing saved-default cases and adding two per-call cases. A prepared 12-step call keeps its original count and format across a paused edit of the saved count from 40 to 20. The next explicit 7-step call uses the newly saved format. Approvals, operation records and HTTP bodies agree, saved defaults remain unchanged by the overrides, and repeating the completed 7-step call does not generate another image or request another approval.

Independent review found that Pi removes optional nulls and coerces integers before executing a tool. A narrowly scoped `prepareArguments` guard now validates raw image step inputs before that normalization; no other tool uses the new hook. Two additional real-Pi cases first reproduced a 40-step generation or pending approval for explicit `null`. After the guard, both Allow and Ask reject `null`, `"17"`, `true`, `1.5`, `0` and `1001`, returning an error for each call with no image HTTP request, approval or operation record. The complete six-case focused Pi run passed, and final independent review found no remaining blocker in the step-override change.

The production smoke confirms that the package, supervised server health, UI snapshot, update metadata and actual ready IPC all identify version 0.8.6. Verification mode retains its maintenance gate, and nonce activation succeeds. A stale UI-copy expectation found during the initial full check was resolved by preserving the blank/default guidance while explaining the new per-call precedence; the final full check passes.

No live DGX Spark, image model or user installation was accessed. These fixtures establish the declared tool interface, submitted count and lifecycle behavior. They do not establish whether a particular language model follows every natural-language step instruction or how an external image server applies its own provider-specific limits and sampling schedule.

## Historical validation: version 0.8.5

Date: **2026-11-08 (JST)**. Application version: **0.8.5**.

- Client/server TypeScript, **1,011 tests** with zero failures, skips or cancellations, and the production build passed. The corrected production HTTP and update-verification smoke passed through `npm run smoke`.
- Formatting and `git diff --check` passed. Focused version, update-service and update-UI suites also passed.
- Cross-platform, container and real Chrome results belong to the matching [GitHub CI run](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml), separately from local verification.

The v0.8.4 package and compiled runtime disagreed: the package identified `0.8.4`, while the server's duplicated constant identified `0.8.3`. Before applying the fix, a new assertion against the actual compiled v0.8.4 server reproduced that mismatch and failed. The previous smoke compared runtime surfaces with each other, and the updater fixture echoed the package version, so neither detected the release identity error.

Three new version cases verify source health/state/update metadata against `package.json`, production identity retained after a source-only package change, and rejection of missing or invalid build metadata without a package fallback. Three update-service cases cover rejecting an identical known SHA despite differing versions, accepting a newer corrective release at a distinct SHA, and preserving discovery and downgrade behavior when the installed revision is unknown. Five new UI cases cover Japanese/English mismatch guidance with both corrected and legacy availability responses, ordinary matching versions, a distinct corrective update, and existing receipt recovery.

The production smoke now checks the package version against the real supervised server's health, UI snapshot and update metadata. It then launches the actual compiled entry point through `spawnServer({ verify: true })`, validates ready IPC version/commit, and confirms that health and update metadata remain readable while normal state access returns `503 update_in_progress`. After nonce-based activation, health leaves verification and state access returns `200` with the release version. The initial new smoke incorrectly expected state access before activation; correcting that test expectation preserved the existing maintenance gate.

Independent review checked the source/compiled paths, build-stamp ordering, Docker's complete artifact copy, the existing launcher's strict target-version verification, the same-revision guard, and cleanup of the real verification process. The smoke's commit identity is a fixture; it does not perform a Git installation on a user checkout. CI's full check runs this production handshake alongside the existing launcher transaction and rollback regressions.

No user installation, data directory or DGX Spark was accessed. This fixes release identity and update selection; the separate inference-timeout investigation still requires the user's server logs.

## Historical validation: version 0.8.4

Date: **2026-11-08 (JST)**. Application version: **0.8.4**.

**Post-release finding:** These checks missed the package/runtime version mismatch described above. v0.8.5 adds a package-to-runtime assertion and actual production update handshake to cover that gap.

**Per-call scope finding:** The image-step checks below exercised saved defaults. They did not establish that bots could select a count for each call; v0.8.6 adds that missing tool argument and regressions with an unchanged saved default.

- `npm run check`: **1,000 tests passed**, with zero failures, skips or cancellations; client/server TypeScript, production build and supervised production HTTP smoke passed.
- Formatting and `git diff --check` passed. Focused image runtime, image tests, avatar, settings, archive and UI cases also passed.
- Cross-platform, container and real Chrome results belong to the matching [GitHub CI run](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml), separately from local verification.

Image settings now accept an optional 1–1,000-step count and an explicit sending format. Controlled HTTP tests inspect all four complete request shapes, including stable-diffusion.cpp's prompt-embedded `sample_params.sample_steps` extension. They verify that only the selected format is sent, original prompts remain in approval/journal/image metadata, conflicting embedded tags and invalid values fail before admission, and rejected extensions never trigger a second format or automatic generation retry. The stable-diffusion.cpp OpenAI-route behavior was checked against upstream source, including the previously used `b167b94` revision.

Operation tests preserve the exact legacy journal identity when the count is absent or null, distinguish explicit counts and formats, and reuse completed receipts without generating again. Existing real-Pi approval-waiting and queue-waiting scenarios were extended: an image prepared at 40 steps retains that configuration after a fully paused settings edit, while the next request uses the new 20-step format. An avatar API case verifies saved step forwarding, original-prompt retention and completed-request replay after the count changes.

Settings/API/archive tests cover partial-update preservation, explicit null reset, legacy nonmutation, integer bounds and transport choices, paused versus active edit locks, unsaved draft test settings, request-ID conflicts, and transfer validation/round trips. UI interaction tests cover entering and clearing counts, choosing formats, save/test payloads, preset preservation, invalid-value blocking, paused edits and stale test-preview invalidation. Independent read-only review found no additional defect in provider encoding, approval identity, null compatibility or prepared-request snapshots.

No live DGX Spark, image model or user browser profile was accessed. These checks establish Loom's request and persistence behavior, not the provider's actual generation quality, elapsed time or effective denoising schedule. The existing language-model timeout investigation remains separate from this image-step feature.

## Historical validation: version 0.8.3

Date: **2026-11-07 (JST)**. Application version: **0.8.3**.

- `npm run check`: **984 tests passed**, with zero failures, skips or cancellations; client/server TypeScript, production build and supervised production HTTP smoke passed.
- Formatting and `git diff --check` passed. Focused service, runtime and approval tests also passed.
- Cross-platform, container and real Chrome results belong to the matching [GitHub CI run](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml), separately from local verification.

Four new domain cases cover credential-only replacement and removal, exact whitespace retention, stale credential revisions and atomic rollback after a forced metadata-write failure. A fingerprint case verifies stable operation identity across Store restart, separation by installation and purpose, and no credential persistence from fingerprinting alone.

Fifteen additional mail/service tool cases cover successful metadata edits and write-only credential creation, replacement, retention and clearing. They exercise approval denial/cancellation, revision and assignment conflicts, actor/mail revocation after a room boundary, individual tool cancellation immediately before saving, value-free approval actions, credential-like URL rejection, and raw/escaped/long input removal from persisted failure diagnostics. A real Store/Controller restart reuses the completed operation receipt without creating another record or increasing its revision.

Eight dedicated input/runtime cases use bounded guards and actual Pi with localhost SSE fixtures. They verify encrypted storage after exact approval and the absence of the dedicated input from public snapshots, approvals, activities, operation records, saved JSONL and subsequent model requests, including nested JSON escaping. Invalid-schema echoes and malformed-JSON diagnostics are checked before SDK persistence. Stop/restart/resume rejects an unavailable placeholder rather than storing it. Short credentials such as `"1"` and `"true"` keep the public result valid JSON with its original ID, revision and configured flag.

Five UI cases cover Japanese and English credential actions, identity-change removal explanations, unknown/nonservice action handling, and existing approve/deny submission with shared duplicate-request prevention. These are DOM interaction tests, not a claim of new approval-card screenshot verification.

Independent review checked installed Pi's subscriber/persistence/validation ordering, scratch-buffer removal, bounded input retention and cleanup, fail-closed duplicate/missing call IDs, keyed operation identity, and preservation of ordinary tool inputs/results. Root review found and corrected substring redaction of short secrets corrupting successful JSON; a real-Pi regression now covers that case.

No live model endpoint, mailbox, external service account or user browser profile was accessed. Protection applies to the dedicated credential input; it does not retroactively erase independently supplied ordinary chat, reasoning, file, mail, memory or skill content. Stored credentials remain write-only, and the service registry does not perform remote account changes or browser sign-in.

## Historical validation: version 0.8.2

Date: **2026-11-07 (JST)**. Application version: **0.8.2**.

- `npm run check`: **951 tests passed**, with zero failures, skips or cancellations; client/server TypeScript, production build and supervised production HTTP smoke passed.
- Formatting, `git diff --check` and Chrome UI smoke-script syntax checks passed.
- Cross-platform, container and real Chrome results belong to the matching [GitHub CI run](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml), separately from local verification.

Twelve new model-timeout cases observe the actual Pi/OpenAI provider path. They cover known transport codes, unknown evidence, HTTP 408/504, body-stream failure with partial output and usage, cancellation/deadline priority, single terminal events and no retry. A real localhost TCP server that accepts a connection without completing TLS reaches the unchanged ten-second connection deadline. Body-observation cases verify pull backpressure, consumer cancellation and response metadata without retaining arbitrary transport errors or response bodies.

Eighteen new runtime-cancellation cases distinguish explicit owner stops from nine application shutdown causes and unexpected SDK cancellation. Five bots sharing two inference slots establish that one task's timeout does not stop unrelated or descendant work. Queued admission, shutdown/stop ordering, started and finished update checkpoints, retained paused queues, restart recovery and completed-operation receipts are covered. Additional assertions strengthen the existing update-checkpoint stop races.

Three application-lifecycle cases verify shutdown-cause propagation, early API admission closure, startup failure and data-lease release. One additional real-Pi regression holds owner-generation cleanup open during shutdown and confirms that a waiting task never makes a new model request. The existing encrypted data-transfer API round trip verifies distinct export and restore causes.

Ten UI cases cover known and unknown failure explanations, raw-error visibility, current task diagnostics, historical status errors after resume, selective copying, delayed clipboard completion, denied/unavailable clipboard fallback and narrow-width DOM behavior. Diagnostic copies label current application version and distinguish task-update time from activity-creation time. They omit prompt, answer, reasoning and unrelated tool outputs.

Independent reviews identified and corrected two shutdown races: runtime admission continuing during slower owner-job cleanup, and update-checkpoint cancellation losing its shutdown cause. Reviews also checked streaming backpressure/cancellation, partial-output preservation, error priority, allowed diagnostic evidence and lifecycle-cause propagation.

The real Chrome CI smoke now includes `scripts/task-diagnostics-ui-smoke.mjs`. Disposable timeout, supervisor-disconnection and legacy-stop records exercise desktop/mobile layout, original-error visibility, actual Clipboard API copying and selectable fallback. The **chat-ui-screenshots** artifact contains these views and their geometry metrics. Inspect the matching commit's CI for graphical execution results; no local Chrome execution is claimed.

No user inference server, mailbox, production task or browser profile was accessed. These regressions establish the corrected lifecycle and reporting behavior; they do not identify the cause of any particular failure on an external user installation. Saved concurrency/timeouts and explicit recovery remain unchanged.

## Historical validation: version 0.8.1

Date: **2026-11-06 (JST)**. Application version: **0.8.1**.

- `npm run check`: **907 tests passed**, with zero failures, skips or cancellations; client/server TypeScript, production build and supervised production HTTP smoke passed.
- `npm run format:check`, `git diff --check` and syntax checks for the Chrome UI scripts passed.
- Independent reviews checked sender provenance, recipient resolution, reply receipts, commit-before-dispatch ordering, quoted model context, transfer compatibility, and the real-browser fixture against the API and UI.
- Cross-platform, container and real Chrome results belong to the matching [GitHub CI run](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml), separately from local verification.

Twenty-eight new API/helper cases cover saved sender names across rename/deletion, legacy task-based attribution, different bots with the same notice text, server-selected single recipients despite mentions, complete original user-directed message context, paused-room queueing, and owner authentication/origin checks. Concurrent retry and process-restart fixtures reuse the original task/message receipt. Forced failures after each task/message/room/read/receipt write roll back the whole reply, and a synchronous fixture runtime observes committed message, read state and receipt before execution starts. System/unknown/unavailable senders, inconsistent sources, invalid bodies, maintenance, model setup and queue capacity all reject without partial work.

Six new runtime cases verify actual sender/message identity in notification tools, rejection of model-selected source fields, bounded and escaped reply context, and concise linkage in room history. Real Pi loopback fixtures inspect actual provider requests for new and legacy notifications outside recent history. One accepts a reply in a paused room, restarts the application and completes it with the full saved source, one recipient and a new user-requested task; the original automation task is not resumed. The transfer round trip preserves notification senders, source snapshots and reply receipts. Two new archive cases cover legacy/deleted references and invalid or contradictory explicit notification/reply metadata.

Seventeen new UI cases cover sender categories, rename/deletion, explicit recipient display, inline submission and navigation, source quotes, desktop notifications, stable UUID retries including HTTP LAN contexts, IME composition, duplicate submits, disconnection and paused rooms. Drafts survive SSE/read/filter changes and failures. A successful POST followed by a failed refresh stays accepted. Only one reply editor opens at a time, so sending one reply cannot discard a different in-progress reply.

The real Chrome CI smoke now also runs `scripts/inbox-ui-smoke.mjs` against the built application. Disposable notices exercise saved, legacy, system, unknown and removed senders. Desktop and mobile checks measure horizontal bounds, long Japanese sender/room labels, form access and source-quote visibility. A real inline submission is checked against persisted messages, tasks and their source context, including mentions that must not add recipients. The existing **chat-ui-screenshots** artifact includes inbox list, desktop/mobile reply forms and the accepted reply in mobile chat. Inspect the matching commit's CI for graphical execution results; no local browser execution is claimed under this environment's socket policy.

No real model endpoint, mailbox, user browser profile or external message recipient was used. Controlled model responses establish routing and context behavior, not the quality of a particular model's reply.

## Historical validation: version 0.8.0

Date: **2026-11-06 (JST)**. Application version: **0.8.0**.

- `npm run check`: **854 tests passed**, with zero failures, skips or cancellations; client/server TypeScript, production build and supervised production HTTP smoke passed.
- `npm run format:check` and `git diff --check` passed.
- Independent reviews checked bot authority, owner decisions, legacy normalization, scope overlap, revision conflicts, task version persistence, editor drafts, recovery quotas and the API/documentation contract.
- Cross-platform, container and real Chrome results belong to the matching [GitHub CI run](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml), separately from local verification.

Nineteen new domain/API cases cover memory revision, restoration, archiving and transactional merging; automatic activation and same-ID updates of bot-owned skills; strict actor/source validation; version conflicts; fixed/shared/inactive records; normalized duplicate protection across overlapping scopes; legacy histories and owner maintenance after a bot is removed. A failed merge persistence step rolls back both its target and sources. Restore retains the current owner, room, lock and activation state while recovering the historical content and source evidence.

Fourteen runtime cases cover bounded search/read results, records outside the initial prompt, maintenance inspection versus task-pinned skill reads, live revocation, persistence across restart, and background mutation limits. The real Pi loopback fixture completes seven model requests: memory search, read and update, skill search, inspection and update, then the final answer. It verifies both stored revisions and source-task evidence through the actual registered tools. Store/Controller restart fixtures cover the interval after a durable write but before its activity is marked successful, completed-result replay, uncertain-operation rejection and ordinary version-conflict retry. Reviews allow ten model requests while retaining one memory mutation and one skill mutation.

Sixteen UI interaction cases cover current-version editing, scope/fixed controls, history and restoration, explicit activation/archive actions, retained drafts through SSE changes and HTTP conflicts, failed reloads, disconnected state and duplicate submissions. The narrow-viewport fixture verifies DOM preservation; it does not measure browser layout. An encrypted data-transfer round trip preserves room-scoped archived/fixed memories, revision metadata and a task's older skill snapshot alongside the newer current skill.

No real model endpoint, mailbox or user browser profile was used. These controlled provider responses establish runtime behavior, not generated-lesson quality or improved task success. Local graphical inspection was unavailable: the local browser could not start under the environment's socket policy, and the separate browser could not reach the preview server. No screenshot verification of the new learning screen is claimed.

## Historical validation: version 0.7.9

Date: **2026-11-06 (JST)**. Application version: **0.7.9**.

- `npm run check`: **805 tests passed**, with zero failures, skips or cancellations; client/server TypeScript, production build and supervised production HTTP smoke passed.
- `npm run format:check` and `git diff --check` passed.
- Independent UI review found a canonical-equivalent URL save guard mismatch; matching server normalization and a regression now cover saving bot permissions after resume. Independent runtime review found no remaining blocker.
- Cross-platform, container and real Chrome results belong to the matching [GitHub CI run](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml), separately from local verification.

API cases now cover all image configuration fields and the preset in paused queued and runtime-suspended states, rejection while draining or another room remains active, unchanged tasks and credentials on rejection, owner-generation guards and same-origin/cross-origin credential handling. UI cases exercise the whole form, credential replacement and clearing, preset serialization, resume/disconnect re-locking, retained drafts and live permission-only saves.

New real-Pi loopback regressions verify that a tool not yet begun uses the complete image configuration saved at its pause boundary. Image calls already waiting for approval or inference retain their exact original endpoint, model, resolved size, response format, timeout budget and credential, including an originally empty key. Their subsequent calls use the new provider and saved values, with a new approval when required. Existing operation receipts remain intact, old/new credentials stay out of persisted records, and disabling image generation prevents a queued request from making any HTTP submission.

The image refresh test also checks fresh-copy isolation and missing-field defaults. These controlled fixtures use no real model endpoint, mailbox or user Chrome profile.

## Historical validation: version 0.7.8

Date: **2026-11-06 (JST)**. Application version: **0.7.8**.

- `npm run check`: **797 tests passed**, with zero failures, skips or cancellations; client/server TypeScript, production build and supervised production HTTP smoke passed.
- `npm run format:check` and `git diff --check` passed.
- Independent reviews checked server suspension authority, atomic settings rejection, actual Pi request projection, image queue admission, owner-test setting isolation and preservation of paused operations.
- Cross-platform, container and real Chrome execution are recorded on the matching [GitHub CI run](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml); they are separate from local verification.

New real-Pi loopback regressions pause requests that were already constructed and waiting for inference capacity. Enabling image input makes the resumed request advertise and execute `view_image`; disabling it removes the tool declaration and previously read pixels from the resumed provider request. A stale tool call is denied. Tests preserve the original task and continuation rather than cancelling and recovering them.

Image-queue regressions cover both shared-to-independent and independent-to-shared changes. Pending operation keys and approved arguments remain intact, a completed image receipt remains completed, an occupied LLM slot blocks only shared images, and each image is posted exactly once. Existing approval, room pause, update checkpoint and explicit-stop cases still pass. Owner tests and avatars retain their own settings snapshots.

API cases accept paused queued tasks and runtime-confirmed suspended tasks, reject draining work, stale display-only evidence and another active room, and retain the original settings and secrets on rejection. Other model/image connection fields and existing owner-generation guards remain locked. UI cases enable only the two requested switches, preserve drafts through resume, disconnect and failed save, and keep connection/preset controls locked while tasks remain active.

Projection tests use Pi's actual transcript helpers to verify system/tool deltas, original transcript and model immutability, normalized and shorthand contexts, compaction prompts and learning's restricted tools. Default tests verify `2048x2048`, 3,600 seconds and independent image capacity for new or missing fields while retaining explicit saved values and credentials. Controlled fixtures use no real model endpoint, mailbox or user Chrome profile.

## Historical validation: version 0.7.7

Date: **2026-11-06 (JST)**. Application version: **0.7.7**.

- `npm run check`: **780 tests passed**, with zero failures, skips or cancellations; client/server TypeScript, production build and supervised production HTTP smoke passed.
- `npm run format:check` and `git diff --check` passed.
- Independent reviews checked image deadline scope, transport and queue lifetimes, saved-setting preservation, preset consent and field isolation, same-machine concurrency wording, and archive validation.
- Cross-platform, container and real Chrome execution are recorded on the matching [GitHub CI run](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml); they are separate from local verification.

The new real-Pi fixture serves both image generation and chat completion on one loopback origin. With one text slot and independent image capacity, another bot completes its text response while the first image response is held. A second image waits until the first finishes, maximum active image requests remains one, operation receipts complete, and exact request counts show no duplicate generation. Holding the image beyond the fixture's short language-model response/idle budgets confirms those model timers do not span image tool execution.

Settings and API tests verify square 2K and 3,600-second fresh defaults, the 10–86,400-second range, atomic rejection of invalid values, and preservation of saved 1K/120-second choices, custom budgets and credentials. A missing legacy timeout inherits the new value without rewriting storage. An unsaved image test has no deadline while queued and receives its full 3,600,000 ms allowance after admission. Its exact outgoing body contains the selected size and no step override. Archive tests retain valid long image settings, reject invalid explicit timeouts and accept legacy omission.

UI cases check the preset's exact three draft changes, unchanged endpoint/model/credentials/response format/permissions, normal Save, disabled active-work controls, long-budget test eligibility and invalid fractional/non-finite values. Existing avatar checks now verify the new default size. Existing short-budget timeout, queue, cancellation and no-replay regressions remain in the full suite. Controlled response holding and deadline assertions avoid a real hour-long wait; no real model endpoint, mailbox or user Chrome profile was used, and these tests do not establish a specific provider's 2K image quality or generation speed.

## Historical validation: version 0.7.6

Date: **2026-11-06 (JST)**. Application version: **0.7.6**.

- `npm run check`: **772 tests passed**, with zero failures, skips or cancellations; client/server TypeScript, production build and supervised production HTTP smoke passed.
- `npm run format:check` and `git diff --check` passed.
- Independent reviews checked runtime suspension authority, Pi cleanup and persistence, operation-journal safety, update admission and failure handling, and explicit cancellation during checkpoint preparation.
- Cross-platform, container and real Chrome execution are recorded on the matching [GitHub CI run](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml); they are separate from local verification.

The real-Pi room-pause fixtures now cover saving a started task between two tool calls, preserving the completed command's exact result, restarting or retaining the original process after updater rejection, and resuming without executing that command again. Later queued work remains held behind the started task in these fixtures. A draining model or command refuses preparation without aborting either that action or an already-parked teammate. Pending approval is cancelled before checkpoint completion and renewed after restart when the configured permission policy requires it.

Cancellation cases cover both immediate owner stop and the narrower interval after the first of two paused tasks has fully left the runtime while the second task's approval cleanup remains held. The stopped task is not requeued or revived by room resume. A queued image fixture verifies that its failed operation journal survives recovery and blocks replay, even though no image HTTP request was dispatched. Recovery does not delete or reset uncertain operation records.

Update API cases require both runtime-confirmed suspension and a preparation hook, retain target and exact-CI validation before changing tasks, recheck activity after asynchronous preparation, prevent task and room resume during maintenance, and distinguish definitive launcher rejection from uncertain IPC receipt. UI cases verify Japanese and English busy-state guidance, retained error codes, and explicit retry without automatic task mutations or repeated installation requests. No real model endpoint, mailbox or user Chrome profile was used.

## Historical validation: version 0.7.5

Date: **2026-11-06 (JST)**. Application version: **0.7.5**.

- `npm run check`: **757 tests passed**, with zero failures, skips or cancellations; client/server TypeScript, production build and supervised production HTTP smoke passed.
- `npm run format:check` and `git diff --check` passed. The image-reader tests also passed with an aliased temporary directory after normalizing the mock paths for macOS.
- Independent implementation reviews checked model capability, settings migration and locks, current-room discovery, persisted-session replay, image byte budgets and filesystem portability.
- Cross-platform, container and real Chrome execution are recorded on the matching [GitHub CI run](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml); they are separate from local verification.

The new real-Pi loopback fixtures execute image generation followed by `view_image` and inspect the actual model requests: generation initially supplies metadata, then an explicit read supplies the exact PNG pixels. Another fixture discovers an image-only message from a different bot in the current room and reads it while excluding other-room references. Workspace inspection works with Chrome, image generation and agent network tools disabled. Restarting a persisted session and disabling general image input leaves its original JSONL intact while removing prior tool-image pixels and the viewing tool from subsequent provider requests.

Image-reader cases use temporary local files and check exact PNG/WebP bytes, current-room scope, invalid inputs, private/escaping paths, size/dimension limits, metadata revocation, file replacement, bounded growth and cancellation between read chunks. Runtime tests confirm that read results do not become image-generation journal entries, expose pixels in the application snapshot, or modify files. Chrome tests distinguish immediate screenshot inclusion from later explicit inspection, and verify that the global image-input switch blocks both. Byte-budget tests cover the exact 80 MiB boundary, rejected reservations and independent task executions without allocating oversized fixtures.

Settings/API/UI cases cover explicit and inherited image-input choices, image-capable model configuration without Chrome, active-work locks, credential retention and data-transfer validation. No real model endpoint, mailbox or user Chrome profile was used in local verification. The controlled provider fixtures establish the image transport and lifecycle behavior; they do not measure a particular model's visual accuracy.

## Historical validation: version 0.7.4

Date: **2026-11-05 (JST)**. Application version: **0.7.4**.

- `npm run check`: **730 tests passed**, with zero failures, skips or cancellations; client/server TypeScript, production build and supervised production HTTP smoke passed.
- The room-boundary and browser-lifetime changes received an independent implementation review. Approval-entry and capacity-grant races were corrected before the final check.
- Cross-platform, container and real Chrome execution are recorded on the matching [GitHub CI run](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml); these are separate from local verification.

Room pause regressions use held loopback SSE streams with the real Pi runtime, including multiple tool calls in one response and a held local command. They verify completion of the current action, suspension before the next tool/model request, preserved exact tool results and operation receipts, no replay on resume, parked inference waiters, independent-room progress, approval while paused, cancellation and restart handling. Scheduler tests cover 32 suspended tasks with bounded 16-worker readmission, concurrent checkpoint callers, cancellation and rapid resume/pause races.

Browser tests use the fake service boundary to verify current-action completion, preservation of pending approvals, lending idle profile capacity, revalidation of the original plan and explicit disconnect/disable/deny cancellation. Paused tasks stop their UI animations and show waiting-for-resume status; the room header distinguishes active draining from fully paused work.

Image permission regressions cover inherited legacy settings, independent Allow/Ask/Deny, the network Deny ceiling, live settings changes, owner-initiated test/avatar consent, stricter policy after queueing and exact-image restoration without another POST. Image queue tests verify that room pause releases both capacity reservations while an already-issued HTTP request finishes. API/UI and archive tests retain and validate the new preference. No real model endpoint, mailbox or user Chrome profile was used.

## Historical validation: version 0.7.3

Date: **2026-11-05 (JST)**. Application version: **0.7.3**.

- `npm run check`: **700 tests passed**, with zero failures, skips or cancellations; client/server TypeScript, production build and supervised production HTTP smoke passed.
- `npm run format:check` and `git diff --check` passed.
- An independent review identified and verified the prompt-job cleanup ordering correction before this final check.
- Cross-platform, container and real Chrome execution are recorded on the matching [GitHub CI run](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml); they are separate from local results.

The timeout regressions use Pi's actual OpenAI streaming adapter with loopback HTTP/SSE providers and deliberately short fixture budgets. They exercise delayed headers, early headers with role-only chunks, heartbeat-only connections, reasoning/text/tool progress, healthy streams longer than either budget, response and idle expiry, caller cancellation, partial output/usage preservation, late provider events and cleanup before the next request is admitted. An actual Pi/controller fixture waits in Loom's queue longer than its response budget and then succeeds; a cancelled queued request never reaches the provider. Global fetch and dispatcher identities remain unchanged.

Settings tests cover old configurations, exact custom values, whole-second bounds, saved credentials, equivalent-default edits during active work and blocking effective timeout changes. Archive tests preserve timeout settings and reject invalid imported values. Image-test API/UI cases verify a full generation budget after both local queues, no queued deadline, cancellation, active timeouts, stale browser deadlines and retrieving an already-completed result without another generation POST.

Prompt-assistance lifecycle checks require terminal job notifications to observe released inference capacity, including output-limit failure while the provider is still streaming. They complement the existing token/output caps, cancellation and no-replay cases. No real model endpoint, mailbox or user workspace is used. The shorter fixture budgets test the timing transitions without making the suite wait for production intervals of five or thirty minutes.

## Historical validation: version 0.7.2

Date: **2026-11-05 (JST)**. Application version: **0.7.2**.

- `npm run check`: **683 tests passed**, with zero failures, skips or cancellations; client/server TypeScript, production build and supervised production HTTP smoke passed.
- Formatting, smoke-script syntax and `git diff --check` passed.
- No user model, mailbox, existing browser profile or production workspace was accessed.

The new `send_user_message` regressions exercise separate owner-directed chat posts and in-app notifications during direct, handoff and automation work; no extra task admission; exact-operation replay suppression after resume; partial notification failure; bounded inputs; and exclusion from background learning. Model-context cases inspect the actual Pi SDK request to a loopback fixture and verify explicit audiences, task sources and valid bounded history JSON. Shared classification tests cover explicit recipients, root/parent identity, unknown legacy data and contradictory metadata.

UI regressions distinguish **→ You** from an ordinary answer to a user request, bot-directed work, handoff results, automation and shared history. They verify recipient/name/source changes and keep directed posts from taking over the live response's progress, stream cursor, task jump or controls. Archive cases preserve the new flag and reject invalid or conflicting recipient metadata.

The real Chrome CI smoke retains the one-row composer, mentions, `@all`, pause/resume and viewport checks. Six message-context fixtures add single-row header/overlap/visibility measurements, a long Japanese name, and desktop/mobile comparison screenshots showing **→ You** alongside ordinary and bot-request replies. Inspect the matching commit's CI run and `chat-ui-screenshots` artifact for graphical execution results; local Chrome remains unavailable under this execution environment's Unix-socket policy.

## Historical validation: version 0.7.1

Date: **2026-11-05 (JST)**. Application version: **0.7.1**.

- Client/server TypeScript checks passed.
- `npm test`: **664 tests passed**, with zero failures, skips or cancellations.
- Production build, supervised production HTTP smoke, formatting, smoke-script syntax and `git diff --check` passed.
- No user model, mailbox, existing browser profile or production workspace was accessed.

The inline composer cases cover individual/all completion, visible bot selection without hidden recipients, duplicate mention avoidance, IME, Shift+Enter during completion, draft preservation, popup dismissal and paused-room submission. API regressions cover enabled-room-only broadcasts, case and duplicate handling, explicit-ID precedence, reserved-handle compatibility and atomic queue capacity rejection.

The real Chrome CI smoke now checks that the idle form is at most 58px high, that the textarea and Send occupy one row on desktop/short-height/mobile screens, and that obsolete recipient/keyboard controls are absent. It also completes individual and `@all` mentions through real input and verifies exactly one task for each of five fixture bots. The `chat-ui-screenshots` artifact includes the All suggestion, layouts and geometry metrics. Inspect the matching commit's CI for graphical execution results; local Chrome remains unavailable under this execution environment's Unix-socket policy.

## Historical validation: version 0.7.0

Date: **2026-11-05 (JST)**. Application version: **0.7.0**.

## Executed checks for this release

Linux, Node.js **24.22.1**, npm **11.9.0**:

- `npm run check`: **658 tests passed**, with zero failures, skips or cancellations; client/server TypeScript, production build and supervised production HTTP smoke passed.
- `npm run format:check` and `git diff --check`: passed.
- No user model, mailbox, browser profile or production workspace was used by these tests.

New regressions cover unlimited/finite/disabled handoffs and live policy changes; graceful multi-bot room pause, held child tasks, approvals, model-capacity waits, cancelled-queue admission races, restart persistence and scheduled work; per-bot Chrome routing, profile migration, independent operation queues, bounded browser capacity, task residency between tool calls, approval cancellation and UI save/connect lifetimes. The compact composer and consolidated activity controls have DOM interaction coverage, including mobile access, IME/drafts and room pause/resume.

The existing CI matrix still runs Linux, Windows, macOS, a container build/health check and the sandboxed real Chrome adapter smoke. The Chrome job additionally runs `scripts/chat-ui-smoke.mjs` against the built React application with a disposable fixture. It checks real message input/send, textarea growth/shrink, pause/resume, mobile Activity access and horizontal overflow, and publishes desktop/short-height/mobile PNGs plus geometry metrics as **chat-ui-screenshots**. Inspect the matching commit's CI run for execution results. Local graphical execution was unavailable because this environment denied Chrome's Unix socket creation; no local screenshot verification is claimed.

## Historical validation: version 0.6.0

The following records describe earlier releases and their original validation scope.

Date: **2026-11-04 (JST)**. Application version: **0.6.0**.

## Executed checks

The release source was checked on Linux with Node.js **24.22.1** and npm **11.9.0**.

| Check                                | Result                                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client and server TypeScript         | Passed                                                                                                                                                                        |
| Automated tests                      | **618 named cases passed; 0 failures, skips, or cancellations**                                                                                                               |
| Production build                     | Passed                                                                                                                                                                        |
| Compiled production server over HTTP | Passed: health, HTML, all five referenced JS/CSS assets, eight WebP character assets (101,512 bytes), authentication, initial state, and update status through the supervisor |
| Prettier formatting                  | Passed                                                                                                                                                                        |

`npm run check` runs type checking, tests, the production build, and the production HTTP smoke check. `npm run format:check` checks formatting. Tests use temporary data directories and synthetic credentials; they do not require a model download, paid provider, or real mailbox.

[GitHub CI](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml) runs `npm ci` and `npm run check` with Node 24 on Linux, Windows, and macOS, plus the Docker image build, container startup, and HTTP health check. Inspect the run for the commit being installed; cross-platform results are separate from the local results above. The local build environment did not have Docker.

The separate **Real Chrome / Ubuntu 24.04** CI job builds the actual server, runs `scripts/browser-smoke.mjs` through Xvfb using the runner's installed stable Chrome, and uses an isolated profile and synthetic loopback pages. It exercises the pinned MCP connection, tabs, real accessibility snapshots, fill/click results, screenshots, navigation, closing tabs, disconnect/reconnection and protected control-page behavior. The Chrome sandbox stays enabled. This job is separate from `npm run check`; its execution result is recorded on the matching GitHub run. The targeted local browser reviews below are separate headless Chromium checks of Loom itself.

## Compact room header and app update tests

The v0.6 room-header DOM cases cover room details in both layouts and narrow viewports, full room-purpose/workspace/member information, navigation into the existing editor, room switching, retained drafts and focus, room-scoped stopping and the activity-panel controls. The room metadata row has been removed; CSS defines a compact single-row header. These tests do not measure rendered pixel height.

Update discovery tests pin package metadata and CI to one official commit, distinguish same-version fixes, refuse unverified or incompatible targets, preserve offline uncertainty, cache checks and respect GitHub rate limits. HTTP tests cover authentication, same-origin controls, strict request IDs, active work, concurrent installation requests, an HTTP caller disconnecting while its handler still runs, verified-startup admission, activation surviving a later data export, and delayed preview metadata writes that must not expose premature readiness. IPC cases distinguish definite rejection from uncertain receipt loss and ensure no automatic replay.

The native launcher cases use disposable Git/data fixtures and injected install/build commands. They exercise source/target checks, install/build/verification failure, restoration of the previous artifacts and SQLite/key, interrupted journals, data-directory ownership and identity, activation as the no-data-rollback boundary, normal startup after later manual updates or directory changes, duplicate launchers, and shutdown during startup/preflight. A real child-process fixture exercises nonce-bound IPC activation and graceful shutdown. No test updates the working repository, downloads an upstream release, or operates on the user's running Loom data.

Update UI cases cover notices without a new chat row, exact commit/request receipts, same-version changes, CI waits, unsupported installations, unsaved settings, reconnects and separate browser tabs, stale POST/GET response ordering, explicit page reload, old update history after a manual update, and shorter checks while CI is pending. Tests use synthetic update responses; they do not install software through the user's browser.

The production HTTP smoke now starts the actual built app through `scripts/start.mjs`, reads update status without contacting GitHub, and shuts down the supervisor over IPC. Live downloading and installation of a newer real release remain distinct from this smoke and the isolated updater fixtures.

Graphical inspection was not available in this execution environment. No new desktop/mobile screenshot or pixel-level browser verification is claimed for v0.6. The interaction and source-layout checks above are separate from older graphical reviews below.

## Chat layout, scrolling and image settings tests

The v0.5.0 layout checks exercise default Focus view, restoration of the full layout and activity panel, room switching, retained drafts, approval indicators, navigation on other pages, saved preferences, and narrow-screen keyboard/Escape/resize behavior. Scroll regressions use synthetic element geometry to check reader intent and anchor correction during streamed content, prepended messages, resize and disclosure changes. They are interaction tests, not pixel-level browser measurements.

Image settings tests use synthetic HTTP image providers and temporary application data. They cover actual raster generation and preview retrieval from unsaved inputs, separate and origin-bound credentials, queue admission, cancellation, timeout, lost-response recovery and preventing duplicate POSTs. No user image endpoint, paid model or real mailbox is used.

A graphical review was attempted in this execution environment. The local browser extension could not attach to this chat, and the separate cloud browser could not connect to the temporary loopback development server. No new screenshot or desktop/mobile pixel-layout validation is claimed for v0.5.0. The older browser reviews below remain separate evidence for earlier changes.

## Earlier credential-editor verification

The v0.3.2 saved-password and API-key states are covered by the DOM interaction tests below and the production build. A temporary production server also returned public account state without its synthetic stored passwords. A graphical review was attempted but could not run in this execution environment: local Chromium was blocked by the permitted Unix-socket policy, and the separate cloud browser could not reach the temporary loopback server. No new screenshot, native Windows rendering or pixel-level layout claim is made for version 0.3.2.

## Earlier scheduled wake-up browser review

The v0.3.0 production application was opened in headless Chromium **155.0.8059.79** with the browser sandbox enabled, temporary application data, an isolated profile and a stubbed inference runtime. Checks covered **1440 × 1000** and **390 × 844** viewports. One-time, daily and weekday schedules were created through the UI; the saved Tokyo local time resolved to the expected UTC instant. Editing and reloading preserved a reservation, manual one-time execution admitted exactly one task and hid consumed controls, and the daily schedule stayed anchored to 09:10 in Asia/Tokyo. Weekday mouse and Space-key controls, persisted skip policy, outside-click dismissal and Escape dismissal passed. Desktop and mobile form/card screenshots were inspected. At the mobile width, the document and modal contents had no horizontal overflow, including the seven weekday buttons. No real model, mailbox or external action was used. These browser checks were separate from that release's 357 named automated cases. Version 0.3.1 changes server-side prompt context and does not add or change a UI flow.

## Earlier navigation browser review

The v0.2.2 production application was opened in headless Chromium **155.0.8059.79** with the browser sandbox enabled, temporary application data and an isolated profile. Checks covered **1440 × 900**, **1024 × 560**, and **390 × 844** viewports, including 24 additional synthetic rooms. Sidebar wheel scrolling, keyboard access to the last room, account-tab ArrowRight/Home/End navigation, focus visibility, and automatic reveal in a deliberately constrained 150px tab strip all passed. Sidebar and tab scrollbars were hidden while ordinary content retained its scrollbar style. Desktop, mobile-menu and mobile-tabs screenshots were inspected; the mobile page had no horizontal document overflow. No real mailbox, model request or external action was used. This targeted review was separate from that release's 318 named automated cases and does not establish all-page or native Windows rendering coverage.

## What the tests exercise

- **Chat layout — 5 cases:** default/persisted Focus view, restoring activity and navigation, room switching and draft retention, current/outside-room approval indicators, full navigation on other pages, and narrow-screen focus trapping, Escape and resize recovery.
- **Chat scrolling — 13 cases:** immediate upward-gesture detachment, upstream bot growth, visible paragraph/character anchors, prepending history, viewport reflow, pending native scroll and repeated scrollbar dragging, explicit return to the end, nested reasoning, image/disclosure observers, task jumps retained across repeated updates, room reset and a late send response that must not reclaim the reader's position. Layout geometry is synthetic.
- **Image settings test API — 10 cases:** actual fake-provider HTTP generation from unsaved inputs, temporary authenticated raster previews, same-origin/edited/cleared/keyless credential snapshots, serialization with avatar generation, shared inference admission, cancellation and permission checks, generation-only timeouts that exclude local queue waiting, idempotent receipts and cancelled-ID tombstones, shutdown/restart without replay, expiry and error redaction.
- **Image settings test UI — 8 cases:** unsaved fields and credential modes, double-click prevention, cancellation before a delayed POST settles, input-change/unmount cleanup, stale-result suppression, GET-only recovery of unknown results, queued/generating/timeout states, stale deadlines that do not hide completed results, preview/download and network-denial guidance.

- **Portable data archive — 23 cases:** encrypted export/import with the original credential key; preserved IDs, receipts, deduplication and operation arguments; internal and external workspace mappings; Pi header and modification-time preservation; Windows drive/UNC and case handling; parent workspaces containing the data directory; internal symbolic links; wrong passwords, tampering, schema/key mismatch, unsafe or colliding paths, incompatible versions, model timeout validation and bounded record/manifest/file/workspace expansion. These use synthetic data and do not transfer a real account.
- **Data directory ownership and replacement — 55 cases:** stable process exclusion across Store recreation; constructor cleanup; per-entry backups with a fixed root; failed startup rollback; real child-process termination and I/O failure at replacement, rollback and commit boundaries; durable result recovery; preserved synthetic send receipts, operations and credentials. Mountpoint behavior is simulated by prohibiting root rename; actual Docker validation is covered separately by CI.
- **Managed transfer API — 4 cases:** two live HTTP servers performing export, upload, preview and replacement; destination-login retention; credential/file/history continuity; persistent automation disablement; stale-preview refusal; authoritative completed results despite final job-metadata write failure and after restart; auth/origin/upload limits; initialization cleanup; and shutdown after a response disconnects during reservation.
- **Data transfer UI — 13 cases:** unsaved-setting guards, password confirmation, portable browser-state allowlist, bounded chunk offsets, validation without applying, invalidated previews, password-only retries, failed-replacement retries with a new job, retained job rediscovery, transient restart disconnections and lost-response recovery. These are DOM interaction checks, not graphical browser inspection.

- **Real IMAP metadata and message reads — 19 cases:** the actual ImapFlow client over certificate-verified loopback TLS handles EXAMINE responses without UIDNEXT, UIDVALIDITY or EXISTS by obtaining and validating STATUS metadata. Tests exercise connection verification, bounded numeric UID ranges, pagination, text search, body retrieval, first-poll cutoff filtering and later arrivals. An empty historical mailbox is checkpointed without SEARCH/FETCH and its first new arrival is delivered once. Failed/incomplete/conflicting STATUS responses stop before searching; complete EXAMINE metadata requires no STATUS request. The fixture uses synthetic mail and restricts retrieval to read-only operations, with SELECT permitted only in the explicit Courier initialization cases. Message-read regressions cover same-UID, other-UID and UID-less flag notifications before the body, split metadata, a message removed after listing, a present message without a body, and rejection of advertised oversize before a bounded BODY.PEEK request.
- **Courier namespace initialization — included above:** an added real-client TLS case fails against the unchanged v0.3.4 source with a successful list followed by IMAP `not_found`, then succeeds with this fix. The server changes UIDVALIDITY on every EXAMINE until SELECT persists it. Additional cases cover repeated reads with cached initialization, SELECT denial that deselects the folder before EXAMINE fallback, real UID reuse after a namespace reset, unchanged EXAMINE-only behavior for generic servers, and conflicting SELECT/EXAMINE identities that are not cached. Every SEARCH/FETCH follows EXAMINE, body reads use bounded BODY.PEEK, and STORE/CLOSE/EXPUNGE are not issued. Provider tests also cover source/account/folder isolation, the 128-entry bound, transport failure versus refusal, and cancellation or permission revocation during SELECT, EXAMINE and their STATUS recovery. A live Sakura mailbox has not been used for this verification.

- **IMAP metadata checks — included in the provider cases below:** single bounded recovery, invalid numeric metadata, namespace changes including mutation of the library's live object, permission revocation and cancellation during STATUS, unchanged query text, empty-mailbox checkpoints and stale message locators. Missing UID values are never used in arithmetic or invented.

- **Real SMTP transport — 6 cases:** actual loopback implicit TLS and mandatory STARTTLS verification and submission with the pinned Nodemailer adapter; authentication stays encrypted; untrusted certificates fail before credentials are sent; abort closes the actual server connection and does not deliver a message. Fresh subprocesses trust only the public fixture certificate through a test-only extra CA setting; production TLS validation is unchanged. IMAP is injected for these SMTP-focused cases, and no mail leaves the loopback server.
- **Safe mail diagnostics — 5 cases:** structured DNS/refused/TLS/timeout classification, preservation of original error codes and definite-no-send flags, stage propagation through the client API, both localized receive/send prefixes and suppression of raw provider responses. Incomplete message reads have a separate fixed, localized error from missing or oversized messages. A changed mailbox identity is a separate sanitized HTTP 409 with Japanese and English list-refresh guidance. Additional provider and HTTP regressions distinguish successful connections followed by failed message searches, verify receive failures stop before SMTP, sending failures follow successful receiving checks, and API responses contain only fixed safe metadata.

- **Automatic mail context — 6 cases:** enabled/assigned account filtering; inactive actor and learning exclusions; exact identity and credential-free field selection; current settings rather than cached task policy; read/send configuration and permission combinations; current-bot/current-room incoming-rule status; stable ordering; bounded hostile or oversized metadata and explicit omission counts. Only local configuration is read.
- **Mail context through real Pi — 2 cases:** the first HTTP model request already contains the bot's assigned mail identity; same-session follow-up tasks replace changed addresses and permissions while retaining conversation history; disabling or unassigning accounts clears the current context, including on explicit resume of a failed task. No discovery tool, mail-provider operation or extra inference request is required. These use the real Pi SDK and a synthetic loopback inference endpoint.

- **Calendar scheduling — 12 cases:** explicit Tokyo/UTC/date-line time zones, strict field validation, leap dates, weekday/month/year boundaries, strictly future occurrences, DST gaps and folds, half-hour changes, a skipped date, supported year limits and localized summaries.
- **Scheduled wake-up runtime — 9 cases:** persisted single dispatch after database reopen, overdue coalescing, exact 60-second skip threshold, calendar anchoring, busy-task deferral, retry backoff across restart, atomic rollback, manual once consumption, disabled recurring rules and fold deduplication.
- **Scheduled wake-up HTTP — 5 cases:** timezone/next-date round trips, runtime-owned field protection, partial-edit preservation of overdue times, invalid input before persistence, one-time consume/rearm and failed admission recovery.
- **Scheduled wake-up UI — 9 cases:** exact one-time payload, weekday validation, room-change preservation, mode-specific fields, past dates and submit-time expiry, nonexistent DST times, consumed/missed display, rearming, overdue edits and existing interval compatibility. These are DOM behavior checks.

- **Mail account service and providers — 49 cases:** encrypted write-only credentials; identity-bound reuse; atomic revisions/secrets; assigned enabled bots; durable exact-draft receipts; replay and restart behavior; unknown and partial delivery; timeout/late-result protection; bounded reads/polling; IMAP initial arrivals and UIDVALIDITY reset; MIME size and inert text; SMTP envelope pinning; AgentMail v0 identity/search/ingestion-time pagination; Resend Inboxes thread resolution, exact replies and draft submission. Message-read tests also verify command draining, exact UID selection, field merging, absent-target rejection, invalid size metadata, unusable sources and actual source overflow. Provider tests inject synthetic transports; they do not authenticate to a real mailbox or send external mail.
- **Mail/service HTTP routes, migration and registry — 21 cases:** authentication/same-origin guards; network denial; secret-free snapshots/errors; connection tests without persistence; Gmail SMTP password spacing; source cutoff/cursor resets; HTTP request replay; deletion/disconnection preserving drafts and external identity while clearing compatibility credentials; compatible legacy grouping and UID markers; restart idempotency; non-email legacy usernames; reconfigured legacy rules cannot overwrite an earlier account; encrypted service credentials; stale edits; URL/login identity changes; bot/mail association validation.
- **Mail and service bot tools — 7 cases:** assigned-account discovery; untrusted read content; Auto/Ask/Deny reads; full-content send review and denial; live revision/assignment checks; accepted receipt recovery after a tool-journal gap; uncertain replay refusal; metadata-only service proposals and learning-run exclusion.
- **Independent mail intake — 8 cases:** first-poll arrivals; ongoing intake during busy bot work; overlap deduplication and restart; 100-event backpressure without cursor advancement; atomic task admission and event acknowledgement; source-edit cancellation/cutoffs; legacy marker preservation after editing; permissions/assignment/shutdown; an owner notification and no historical replay on UIDVALIDITY reset.
- **Mail and service UI — 17 cases:** explicit saved/unsaved/re-entry/missing credential states, empty-input secret reuse without returning a password, replacement test/save behavior, identity-scoped credential clearing, connection-test cancellation/stale suppression, outside dismissal, stale inbox response suppression, exact saved-draft review, duplicate-send protection, HTTP LAN UUID fallback, unknown-response recovery, inert message rendering, assignment validation, immutable terminal send attempts, editor-instance isolation after delayed saves, revision-bound removals and pagination invalidation after connection edits. These are DOM interaction checks, not graphical browser inspection.

- **Room automation tools — 15 cases:** exact create/change approvals regardless of unrelated Allow permissions; denial and cancellation; completed-operation replay; room filtering and credential exclusion; invalid credential fields rejected before persistence; configuration conflicts versus harmless polling timestamps; source baseline/overlap preservation; invalidated membership; disabled Gmail draft completion; credential retargeting and no tools in background/learning/handoff tasks; connected-account selection without returning credentials; explicit calendar/timezone/recovery approvals, current-time listings, invalid/past/expired approval rejection, consumed-once protection and normalized replay.
- **Mail connection test — 10 cases:** read-only mailbox open without message reads, saved credentials, rule changes, baselines or bot work; endpoint/account-bound credential reuse; invalid/empty inputs; explicit Ask versus Deny; fixed categorized errors; logout/timeout/concurrent-test cleanup; live permission revocation and STARTTLS. The scheduler also has a regression case for redacting legacy Gmail passwords in both stored and whitespace-normalized forms.
- **Gmail/automation setup UI — 10 cases:** preset values and app-password normalization; test-only submission; saved-credential identity scope; clearing entered credentials when targets change; stale response and duplicate-click protection; modal dismissal/reopen; localized errors; disabled drafts and activation requirements; Network Deny; selecting a connected account assigned to the target bot; selectable empty account option, explicit clearing preserved across bot/room changes, and save validation until an account is selected. These are DOM behavior tests with synthetic transport, not a live Gmail login.

- **Room attention — 11 cases:** an earlier bot's approval outside the 100-message window while another generates; complete ordered review cards with exact per-ID approve/deny; shared in-flight decisions across inline/dialog copies; preserved reading position during approval arrival and streaming; direct bot-to-approval focus and outside/Escape dismissal; stop/resume/queue/completion transitions; approval/active priority over settled history; room isolation and scroll reset after reading older work; disconnected state; completed/idle/disabled distinctions.
- **Run status presentation — 7 cases:** authoritative task and queue state over stale message flags; preparation/reasoning/answer/tool distinctions; real generation-slot waiting; current-run ownership after resume; stopped/interrupted/failed/completed states without processing animation; connection-loss uncertainty and preserved terminal history. Existing UI/generation suites also exercise the updated shared components.
- **Global approval attention — 6 cases:** room approval-count badges during parallel work; cross-room and non-chat navigation to the oldest request; deterministic ordering; streamed resolution and document-title cleanup; disconnected indicators; Japanese labels and narrow-screen navigation. UI checks use a virtual DOM, not pixel-level browser rendering.

- **Chrome service — 14 cases:** actual installed MCP initialization/tool discovery without launching Chrome; fixed launch/environment options; connection lifecycle and explicit-disconnect pause; global serialization, cancellation and timeout cleanup; stale connection/URL/element/focus/dialog checks; protected control origins and loopback aliases; bounded screenshots and snapshot formats.
- **Chrome tools and API — 12 cases:** enabled/learning tool availability, independent read/mutation permissions and exact approvals, live revocation while queued, completed/uncertain mutation replay, authenticated screenshot persistence, API authentication and settings locks. A real Pi HTTP roundtrip verifies both image-input settings: text-only mode sends no screenshot pixels, enabled mode sends exactly one image, and browser status/connect/disconnect consume no model requests.
- **Chrome settings UI — 7 cases:** saved defaults and modes, enabling and connection guidance, browser-only partial saving without losing unrelated edits, duplicate action prevention, cancellation, task/connection locks, screenshot consent, polling cleanup and visible errors. These run against a virtual DOM.

- **Outside dismissal — 6 cases:** dialog backdrop bounds, border/interior clicks, drag origin, nested Escape handling, room-menu action/outside/focus dismissal, and mention dismissal without losing the draft or completion behavior. Existing mobile sidebar/activity backdrop tests remain in the UI suite.
- **System-prompt generation API — 8 cases:** real Pi HTTP streaming payloads and partial output, explicit profile saving, shared chat inference capacity, same-ID replay/conflicts, queued and active cancellation, both settings/demo-route locks, restart/shutdown recovery, bad/empty/truncated/tool-only/oversized outputs, error redaction, all eight reasoning values, keyless servers, authenticated routes and bounded history.
- **System-prompt assistance UI — 8 cases:** input/current-prompt selection, duplicate-click locking, editable preview and explicit apply/Undo/save, switching saved and active drafts, queued/partial/completed states, close/reopen without cancel, stopping, uncertain same-ID replay, model/demo guidance, and incomplete-output protection. These run against a virtual DOM.

- **Character avatar defaults — 5 cases:** initial portraits, one-time upgrades of original icons, preservation of custom profile fields and avatars, no deleted-bot resurrection, and persistence when an owner deliberately returns to a legacy icon.
- **Avatar generation API — 7 cases:** direct image generation without an LLM request or chat approval, draft-only assignment, authenticated durable images, actual global inference admission, cancellation before/during I/O, one-job limit, request-ID idempotency, separate hardware, provider-setting guards, shutdown/restart without replay, rejected image references, and persisted error redaction.
- **Avatar interface — 8 cases:** safe bundled/managed sources across all eight presets, image fallback and source recovery, preset/symbol selection, immediate accent-color preview, custom-color restoration and explicit profile saving, no implicit profile save, model disclosure, duplicate-click protection, preview/select/save, same-UUID uncertain retry, close/reopen/poll/cancel, unavailable integrations, permission denial, and failed/interrupted jobs. These run against a virtual DOM.
- **Large token budgets — 1 case:** newly supported 262K/512K/1M output limits reach an actual HTTP fixture through the real Pi runtime; settings persist exactly; invalid budgets reject atomically; compaction reserves room for selected output.
- **Concurrent generation — 5 cases:** configurable FIFO admission, request-level room isolation, independent-room progress, per-session exclusivity, cancellation, and live capacity increases/decreases. Real Pi HTTP streams overlap when enabled while reasoning and answers stay attached to their own tasks. Incomplete peer output is excluded from prompts.
- **Image generation — 8 cases:** separate provider credentials, exact approval/denial, shared and independent inference capacity, a single image request at a time, queue cancellation, permission revocation, timeout, bounded/validated raster responses, private-address and redirect protection, and symlink rejection. A real Pi fixture calls a separate image HTTP endpoint, receives its tool result, produces an answer, persists the image, and serves it through the authenticated route. Completed images are restored after resume without another POST.
- **Model configuration — 4 cases:** conservative legacy defaults and atomic invalid-setting rejection; encrypted/redacted and origin-bound image keys; live capacity changes versus active model/image/room-policy guards. Actual Pi HTTP payloads preserve all eight selected reasoning values, omit effort in server-default mode, and report an unsupported Ultra value without a downgrade or extra request.
- **Generation interface — 7 cases:** truthful sidebar identity, separate image credentials, all effort values, live inference limits and appropriate configuration locks, room policy, concurrent response/reasoning/approval ownership, task-specific queue reasons and stop controls, and authenticated image previews/downloads. These run against a virtual DOM.
- **API and persistence — 17 cases:** clean initial state; authentication and session revocation; same-origin and host checks; secret encryption/redaction; partial edits; short mentions; stop/resume; exact approvals and stale-card rejection; handoff budgets; skill revisions and export; webhook identity; input validation; restart recovery; compiled-asset serving and encoded-route authorization; exclusive workspace ownership; token rotation; SSE revocation; atomic multi-recipient queue admission.
- **Integration settings — 4 cases:** model keys stay with their origin; model-discovery requests send the intended credentials; unchanged full settings forms can change live permissions; editing an automation source preserves its previous active-task guard.
- **Smart permissions — 7 cases:** new document approval and the recorded reason; manual review for overwrites and code; denial preserves the original file; a concurrently created target is never overwritten; changing permission to Deny during automatic assessment prevents execution; exact built-in inspections do not grant arbitrary shell execution; escaped and URL-encoded credentials, private paths, and size limits remain protected; redirect policy runs before a credential-bearing destination is contacted.
- **Progress and settings API — 4 cases:** reasoning is stored and streamed separately from answers; display bounds and message ownership; actual HTTP SSE delivers reasoning and provisional-message changes before completion; restart preserves partial reasoning and marks interruption; optional reasoning defaults do not count as a running-model change; token bounds and output/context relationships are enforced.
- **Pi runtime — 6 cases:** FIFO admission and cancellation; file/secret/symlink boundaries; durable side-effect replay and uncertainty handling; restricted learning; real Pi SDK calls against a synthetic OpenAI-compatible SSE endpoint; simultaneous requests serialize; an approval releases the model slot; persisted sessions resume; provider errors remain visible; cancellation and HTTP/shell timeouts are finite. The reasoning fixture additionally verifies live thinking, separate intermediate narration and final answers, duplicate-field handling, no invented reasoning for plain/encrypted-only/demo output, stop/resume ownership, explicit reasoning-effort opt-in, and Unicode-safe truncation.
- **Scheduler — 6 cases:** persisted intervals, coalescing, URL baselines, Allow/Auto/Ask/Deny network behavior and repeated errors, webhook deduplication/batching, read-only IMAP envelopes/UID cursors, and cancellation of overlapping polls. The IMAP transport is a deterministic fixture.
- **Settings interaction — 4 cases:** powers-of-two options, saved custom values and old/new maximum values, output strictly below context without silent adjustment, existing permission preservation, and explicit saving of automatic approval and reasoning controls.
- **Chat and application interaction — 16 cases:** room creation/discovery/selection, keyboard mentions and Japanese IME handling, exact approval decisions, stop/resume, SSE streaming/disconnects, isolated persistent drafts, command-palette/dialog behavior, stale HTTP responses versus newer SSE state, model-key guidance, and logout. Additional cases cover inline reasoning/tool updates, final-answer uniqueness, ownership after resume, approval cards attached to the relevant run, narrow-drawer dismissal, functional headings, approvals outside the loaded message window, and preserved reading position during reasoning streaming. These run against a virtual DOM.
- **Room workspaces — 6 cases:** independent folder overrides and default reset; exact Unicode/space preservation; active-task guards without creating rejected directories; pinned roots for queueing, handoffs, learning, and automations; resume mismatch protection and restart persistence. A real Pi HTTP fixture writes the same relative filename into two different room folders, verifies absolute approval targets and system-prompt roots, and switches/restores the matching working-directory sessions.
- **Native folder picker — 9 cases:** static native command construction without path interpolation; headless/disabled/unsupported environments; parsing, Unicode, spaces, and cancellation; existing absolute-directory validation; one-dialog locking, timeout, shutdown, and actual child termination/output limits; authenticated local-only routes; real HTTP disconnect cancellation; platform-native validation. The Windows-specific branch compiles C# and exercises real COM setup and Japanese/spaced filesystem-item marshalling without showing a dialog. The macOS-specific branch validates JXA through `osascript` without showing a dialog; these branches run on their respective CI platforms.
- **Workspace/avatar interaction — 7 cases:** legacy SVG icons at every avatar size; custom graphemes and safe fallback; room-folder selection, cancellation, save, inherited default, and reset; unchanged-field preservation and trailing-space paths; active-room/default-folder locking; unsupported picker guidance and explicit server-path fallback; cancellation on UI unmount; effective and pinned folder displays. These run against a virtual DOM.
- **Whole application workflow — 1 case:** the explicitly labelled demo uses the actual controller, queue, approval, file tool, handoff, notification, and candidate-skill implementations. It stops at approval, resumes with a fresh card, avoids duplicating the completed handoff, and completes the write.

## Verification limits

These release checks used no user inference endpoint or real mailbox. Prompt-assistance request handling is verified against streaming HTTP fixtures; the quality and usefulness of generated instructions must be assessed with the operator’s chosen language model. The Pi adapter is tested against an actual HTTP streaming fixture using the real SDK, but model quality, tool-call quality, and learning usefulness must be evaluated with the operator's chosen model and serving template. Reasoning appears only when the provider actually returns supported plain-text reasoning.

The image endpoint is also a deterministic HTTP fixture. No user image model, GPU batching behavior, memory fit, image quality, or throughput improvement was measured. The adapter targets the documented OpenAI Images protocol; it does not establish compatibility with every local image server or native ComfyUI workflow. The eight selectable reasoning values are transmitted literally; the actual endpoint remains responsible for accepting them.

The browser reviews above verify the targeted scheduled wake-up forms/cards and earlier sidebar/page-tab changes on Linux Chromium. Other application screens and real Windows/macOS browser rendering have not received comprehensive visual QA. The mail workflows also have static responsiveness/accessibility review and DOM interaction tests, without live provider login or mail delivery. The separate Chrome CI job tests the dedicated browser adapter against synthetic pages; it is not a visual inspection of Loom's React UI or a test of Chrome's existing-profile consent prompt on Windows/macOS. The eight bundled character illustrations were visually inspected as image assets in their original release and their deployed WebP files were checked over production HTTP. Avatar interactions and bounded rendering are covered by DOM assertions, which do not establish pixel-level browser layout correctness. No user image model was used to assess generated-avatar quality. Native Windows/macOS dialog appearance, focus/z-order, and manual user selection also remain unverified; compilation and no-dialog COM/JXA checks are not graphical tests.

Mail-provider fixtures establish local protocol mapping, bounds, cancellation and recovery behavior, not real-provider authentication, deliverability or universal mail-server compatibility. API connection tests verify inbox identity/read access and do not verify a particular future send. An IMAP UIDVALIDITY change cannot safely map old processed UIDs to new ones; the current mailbox becomes a new baseline and the owner is notified, so mail already present at that reset needs direct inspection. Polling depends on Loom staying running and on provider retention/rate limits. Service-account records and protected credentials do not implement automatic sign-in, remote provisioning or per-bot browser-profile isolation.

Legacy tasks are pinned to the effective folder known at upgrade time. Earlier versions did not record historical folder changes, so that older information cannot be reconstructed. Room folders scope file tools and execution context; they do not isolate shared room conversation, bot memories, or the operating-system account.

Smart approval is an opt-in fixed-rule policy, not an LLM risk assessment or OS sandbox. Arbitrary commands still require review in Auto mode. Existing Allow/Ask/Deny settings remain unchanged when upgrading.

No claim of production hardening, full upstream feature parity, universal model compatibility, or automatic learning improvement follows from these checks. This release is intended for a trusted owner's initial local evaluation.
