# Changelog

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
