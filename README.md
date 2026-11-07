# Agent Loom

**A local-first workspace for AI teammates that can work, collaborate, and follow up.**

[日本語](docs/README.ja.md) · [Installation](docs/INSTALL.md) · [Models and concurrency](docs/MODELS.md) · [Architecture](docs/ARCHITECTURE.md) · [Research](docs/RESEARCH.md) · [Validation](docs/VALIDATION.md) · [Contributing](CONTRIBUTING.md)

Agent Loom brings persistent group conversations, a visible work queue, specific approval requests, proactive triggers, and reviewable learning into one self-hosted application. Connect your own OpenAI-compatible inference server and choose how many model requests it can receive at once.

The browser UI and application server run on your machine. Your inference server runs wherever you choose. No model weights or hosted model subscription are included. This is an independent, early **0.8.5** release built with TypeScript, React, Node.js, SQLite, and the Pi agent SDK.

## What you can do

| Capability              | Behavior                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Persistent rooms        | Keep conversations and bot membership across navigation and restarts. Use short `@handles` to address bots.                                                              |
| Multi-bot collaboration | Give bots distinct roles and prompts; direct work to another bot with an optional handoff limit. Configure 1–16 shared inference slots.                                  |
| Visible execution       | Follow queued work, generation, tools, approvals, failures, and interrupted tasks as distinct states. Stop and explicitly resume work.                                   |
| Specific approvals      | Review exact operations, or select Smart auto-approve for a limited set of low-risk operations. Automatic decisions include their reasons.                               |
| Model reasoning         | View reasoning returned by compatible models separately from their answers. Server defaults are preserved unless reasoning effort is configured.                         |
| Image generation        | Let a bot call a separately configured image model and display the saved image in chat, with open/download controls.                                                     |
| Image inspection        | Enable image input for a compatible conversation model so bots can inspect current-room attachments and workspace images with `view_image`.                              |
| Proactive work          | Wake a bot once, daily or on selected weekdays in an explicit time zone, or use intervals, URL changes, webhooks or new mail. Route their work to a chosen room and bot. |
| Bot email accounts      | Connect existing IMAP/SMTP, AgentMail or Resend Inboxes accounts. Assign bots, read and search mail, prepare drafts, and review exact outgoing messages.                 |
| Service registry        | Track each bot's service URLs, login names, registered email and setup status. Optional credentials stay encrypted on the backend.                                       |
| Notifications           | See each sender and original room in the inbox, and reply directly to that bot with the source context retained.                                                         |
| Memory and skills       | Let bots search and maintain their memories and automatically activate their own skills. Inspect changes, fix records, restore revisions, and export Markdown.           |
| Web access              | Read web pages and optionally search using your own SearXNG instance or Brave Search API key. No MCP server is required for these built-in tools.                        |
| Local model control     | Configure endpoint, model ID, context/output budgets, temperature, and optional reasoning effort. Token selectors preserve existing custom values.                       |

“Learning” means retained memory and reusable instructions. Loom does not train model weights or guarantee that an automatically proposed lesson is correct. See [memory and skill maintenance](docs/LEARNING.md) for automatic updates, owner controls, scopes, and task-pinned skill versions. The [research notes](docs/RESEARCH.md) explain what the upstream evidence supports and how it shaped the implementation.

## Quick start

Install **Node.js 24 LTS** and **Git**, then run:

```sh
git clone https://github.com/StackPiles/agent-loom.git
cd agent-loom
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:3210**. These commands work in a terminal on Windows, macOS, or Linux. If PowerShell blocks `npm.ps1`, use `npm.cmd` in the same commands. The interface supports Japanese and English; switch languages using **EN / 日本語** in the top bar.

In **Settings**, enter your inference endpoint and model. Typical base URLs are:

| Server location                  | Base URL example                |
| -------------------------------- | ------------------------------- |
| LM Studio on the same computer   | `http://127.0.0.1:1234/v1`      |
| Ollama on the same computer      | `http://127.0.0.1:11434/v1`     |
| llama.cpp server on port 8080    | `http://127.0.0.1:8080/v1`      |
| Another computer on your network | `http://YOUR_SERVER_IP:PORT/v1` |

Use the model identifier reported by your server. The model and serving configuration must support OpenAI-compatible **streaming chat completions and tool calling** for tool use and bot handoffs. Successfully listing models verifies connectivity, not tool-calling quality. See the [installation guide](docs/INSTALL.md) for connection checks and Docker networking.

Start with a short conversation. Then try asking Aster to ask Nova for a second opinion. Use the activity view to inspect the handoff and queue before enabling automatic work.

## Follow work and approvals

The room header uses one compact row in both layouts. Open **Details** beside the title, or select the member avatars, to see the room purpose, all members, workspace folder and simultaneous-response setting. Bot status and task details are consolidated in **Activity**, keeping the conversation and composer free of a duplicate status strip.

Chat opens in **Focus view** on desktop: a compact navigation rail leaves more width for the conversation, and the activity panel opens when needed. Switch back to the full layout from the top bar. Room switching, unread notices and pending-approval badges remain accessible, and the view preference is remembered on this browser and included in data transfers. Narrow screens retain the menu drawer.

Scrolling up pauses automatic following immediately, including while another bot's earlier response is growing. The visible reading position is preserved as messages and images expand. Use **Latest** to return to the end and resume following; sending your own message or changing rooms also returns to the latest conversation.

The **Activity** panel shows each bot's current task: queued, waiting for a generation slot, preparing, generating reasoning/answers, running a tool, awaiting approval, stopped, interrupted, failed or completed. Select a state to inspect that run, or cancel/resume an individual task. Activity remains accessible when the panel is closed or the screen is narrow. The composer places the text field and Send on one row, growing only when the draft needs more lines. Type `@` to choose a teammate or **All teammates** (`@all`). Multiple handles address those teammates; `@all` addresses each enabled member of the current room once. Without a matching mention, the first enabled room member responds. Clicking a teammate adds a visible mention to the draft. Enter sends and Shift+Enter inserts a line break.

Bots can initiate a message to you during ongoing work or an automation: a useful discovery, proposal or question need not be part of an answer to your last request. Their `send_user_message` tool posts **→ You** in the room and creates an in-app notification. **Inbox** shows the sender's name, handle and room. Choose **Reply**, write directly below the notice, and send to that bot; Loom then opens the original room to continue the conversation. Replies remain visible in that shared room and include a collapsible quote of their source.

The reply uses the recorded bot ID, so mentions in the reply text do not add recipients. It starts one new user-requested task with the original notice as context; it does not automatically resume the task that sent the notice. A paused room holds the reply until resumed. New notifications retain the sender's name and handle at sending time. Older notices can identify a responsible bot through their saved task; unavailable or unknown senders cannot receive replies. Idle bots still need a task or configured automation to initiate a message.

Each message header distinguishes explicit **→ You** messages, recorded bot recipients and the source of ordinary work: your request, another bot's request, an automation, or general room sharing. These labels use saved routing and task records, not guesses from the text. A bot's ordinary text does not start another bot, even if it contains an `@handle`. Actual bot handoffs use `send_message`; their results appear in the room without automatically restarting the requesting bot. The separate `notify_user` tool remains available for a notification without a chat post.

A compact header badge opens **all pending approvals in the room**, even when their original messages are older or another bot is generating. The Activity panel's **Review** control shows every action's bot, target and exact arguments before approving or denying it. The dialog closes with its close button, Escape or an outside click without deciding any action. Decisions are shared with the original inline cards; a request already in flight cannot be sent again from the other view.

Room badges and the browser tab title show pending counts. A banner points to the oldest pending approval in another room, including while you are chatting elsewhere. Arriving approvals do not force the conversation to scroll. If the live connection is lost, active states become **Status unconfirmed** and processing animation stops until the connection is restored; a lost connection does not establish that a backend task stopped.

## Bot handoff limits

Bot handoffs default to **Unlimited** for new installations. Under **Settings → Learning and handoffs**, choose a finite limit of **1–10,000** or disable handoffs entirely. A → B uses one handoff; B → A uses a second. Branching requests share the originating task's budget when a limit is configured. Existing saved settings, including zero meaning disabled, are preserved. See [model and collaboration settings](docs/MODELS.md#bot-handoffs).

Use **Pause after current work** in the room header to let each running generation or tool finish, then hold its next tool or model request until **Resume room**. A response containing several tool calls pauses between individual calls. Capacity waiters and new work also wait; approving a pending action does not execute it while the room is paused. Resuming continues the existing conversation without repeating completed tools. The pause state and never-started queue persist across restarts; previously started tasks require explicit recovery after a restart. An individual task can still be interrupted immediately from Activity when needed.

## Browsers for individual bots

Enable **Settings → Chrome control**, then choose **Dedicated**, **Shared** or **Disabled** in each bot's settings. New bots get their own persistent profile; existing bots retain the shared browser until you change their choice. Open a bot's Chrome to sign in, or let it start on first use. Dedicated browsers have separate logins, tabs and operation queues, while a task keeps its page available between tool calls. A configurable pool (default 3, range 1–16) limits open browsers and closes only idle ones without deleting their profiles. See [Chrome setup and behavior](docs/BROWSER.md).

## App updates

A small top-bar notice links to **Settings → App updates** when the official `main` branch contains a newer version or commit. Checks are cached for six hours and can be requested manually. Installation requires successful CI for the exact commit and starts only when you select **Update and restart**. The chat header does not gain another notification row.

Web installation supports clean official Git clones on `main` launched with **`npm start`** on Windows, macOS and Linux. Version 0.5 and older first need one manual update to install the launcher. Docker, development mode, direct Node startup and linked Git worktrees show the applicable manual steps. Active work blocks installation; failed preparation, installation, build or pre-activation startup restores the previous generation when recovery is possible. Read [update requirements and recovery](docs/UPDATES.md).

From v0.7.6, tasks that have fully reached a paused boundary can be saved for an update, including tasks paused between tool calls. The room remains paused after restart; **Resume room** continues from saved conversation and operation records. Pending approvals are requested again when needed, and completed exact operations are not replayed. A room still finishing its current action must wait. To install this fix from v0.7.5 or earlier, interrupt the already-paused tasks once in Activity or normally restart Loom first; the old updater still applies its original busy check. See the [transition instructions](docs/UPDATES.md).

## Mail and service accounts

Open **Mail & services → Email → Connect email** to attach an existing mailbox. Mail hosting remains separate: Loom does not operate a mail server, register a domain, create an external mailbox, or manage provider billing. You can choose the provider later and keep the same room, bot and automation workflow.

| Connection     | What to configure                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IMAP / SMTP    | Email address, receiving host/port, TLS or required STARTTLS, username and password. Add SMTP separately to send. This covers compatible hosted accounts and your own mail server. |
| AgentMail      | An existing inbox ID, its address, and an API key that can access the inbox.                                                                                                       |
| Resend Inboxes | An existing Resend **Inbox** ID, its address, and an appropriate API key. A sending-only Resend domain is not an inbox.                                                            |

Choose the bots that may use each connection; these assignments apply across rooms. The default sending policy is **Review and approve each send**. You can allow assigned bots to send or disable sending for that account. Network permissions also apply. Start with review enabled, then adjust per account once you have checked the resulting work.

At each task start or explicit resume, the bot receives its current enabled mail identities, effective read/send policy and incoming-mail automation status for that room. It can use these account IDs without an extra discovery call. This compact context comes from local settings without fetching messages or contacting the provider; live tools still check current permissions. See [automatic mail context](docs/MAIL.md#automatic-mail-context).

**Test connection** uses the form's current settings without saving or sending a message. IMAP verifies mailbox access and, when configured, SMTP authentication; API providers verify access to the selected inbox. Identified Courier servers may need [mailbox identity initialization](docs/MAIL.md#sakura-hosted-mailboxes) before returning to read-only access. A successful test does not establish final delivery or every provider-side sending permission. Passwords and API keys are entered in the settings form, encrypted on the backend, and omitted from public account data and bot tool responses. Changing an account, host or inbox clears the relevant entered credential rather than reusing it for another identity.

Select a connection to browse or search mail. Opening a message displays plain text and attachment metadata; remote images and email HTML do not execute in the UI. Attachment upload/download and mailbox actions such as archive, delete and marking as read are not included. **Compose email** and **Reply** first save a local draft, then show the exact sender, To/Cc/Bcc, subject and body for review. Bots use the same draft and send service. With the default policy, their approval card contains the complete message. If either the draft or its account settings change while approval is pending, the old approval cannot send the changed message.

**Send history** records sends initiated through Loom. “Sent” means the provider accepted the message, not that it reached or was read by the recipient. If the outcome is uncertain, the UI offers **Check status** and does not resend automatically. Check the provider's history before deciding to create another message. Closing the dialog or losing the browser connection is not proof that a submitted email was cancelled.

In **Automations**, choose **Incoming email** and an account assigned to the selected bot. The rule chooses the room, interval and instructions; the connection stays independent of the rule. For example: “Read new invoices, save a summary, and notify me when action is needed.” The incoming event supplies message identifiers so the bot can request a bounded plain-text body. Checks can continue while that automation's previous bot task is working; pending arrivals wait for their turn. Disabling, disconnecting or removing the bot's account assignment pauses affected rules. Disconnecting in Loom leaves the external mailbox intact.

Use **Mail & services → Services** to register a service name, URL, login, assigned bot, registered email, status and notes. An email linked to a bot's service must also be assigned to that bot. You can optionally store a password or API key in the dedicated credential field; it is not returned to the UI or the model. Bots can read and edit their assigned service records after exact approval. They can also save, replace or clear a credential through the dedicated `manage_service_account.credential` field; approvals describe the credential action without showing its value. The credential input is omitted from activities, operation arguments and persisted model tool-call history, and stored values remain write-only. This registry does not automatically register external accounts, log in to services, inject saved credentials into Chrome, or create a browser profile per bot. Existing Chrome control and its permissions remain separate.

Existing IMAP watcher configurations with an email-shaped login migrate to shared read-only connections on startup; SMTP is not enabled automatically. Legacy configurations remain available where migration cannot safely identify a sending address. Live provider behavior depends on your account, provider API and permissions; automated tests use controlled fixtures.

## Chrome control

Open **Settings → Chrome control** to connect the bots to installed Chrome on the Loom server computer. Use **Existing Chrome** (Chrome 144+, with remote debugging and Chrome's connection consent), or **Dedicated Chrome** with its own persistent profile. Choose **Save and connect**. The official Chrome DevTools MCP adapter is bundled with `npm ci`; no Python service or manual MCP configuration is required.

Bots can list/open tabs, read page snapshots, click, fill, send page keys, scroll and capture screenshots. A text-only local model can operate the accessibility tree. Screenshots appear in chat. Immediate image input requires both **Enable image input** in the model settings and **Send screenshots to the model when captured** in Chrome settings. With general image input enabled, a bot can also inspect a saved screenshot later using `view_image`. Smart auto-approve permits tab lists, snapshots and screenshots; other operations show their exact targets for approval. Operations are serialized within each browser; different dedicated browsers can progress in parallel.

Chrome and Loom must share the same desktop computer; the inference server can be remote. The supplied Docker image does not include Chrome or a desktop. See [connection steps, permissions and limits](docs/BROWSER.md).

## System prompt assistance

Open **Bots → Edit / Add bot → Help write** beside the system prompt. Describe the work and communication style you want; the current role is filled in as a starting point. When a prompt already exists, **Improve the current prompt** includes it in the request. Turn that option off to start fresh.

Choose **Generate draft** to use the language model configured in Settings. Follow queued/generating status and partial text, then review or edit the completed draft and choose **Use this draft**. This changes the editor only. **Undo replacement** restores the previous text, and **Save teammate** applies the final prompt to the bot.

Generation shares the configured inference capacity with chats, can be stopped, and continues if the editor is closed. Reopen Help write to find recent results. Demo mode cannot generate a real prompt; configure the model and turn demo off first. See [model limits](docs/MODELS.md#system-prompt-assistance).

Dialogs, room action menus and mention suggestions close when clicking outside. Closing a profile discards unsaved local edits; generated results remain in the server's history. Clicking inside a dialog or dragging a text selection from inside to outside does not dismiss it. Escape closes the current popup layer.

## Character avatars

Open **Bots → Profile** to choose Aster, Nova, Orbit, Moss, Luna, Pip, Sage or Bram. The eight character portraits are bundled with the app and work without an image server. The original Aster/Nova icon choices upgrade once; existing personalized avatars remain unchanged.

Choose **Accent color** to change the visible frame around a portrait, including generated images. The profile previews the selected character and accent immediately; choose **Save** to apply them to the bot throughout chat, member lists and cards.

After configuring the separate image model in Settings, describe a character in the profile's image-generation panel and choose **Generate**. The panel shows waiting/generation progress and cancellation. Preview the result, choose it for the profile, then **Save** to apply it. Recent generated results remain available if you close the profile or restart Loom. Generation does not require a language-model request.

Avatar generation follows the same image limits and inference-sharing option as chat images. The Generate button explicitly authorizes that request; Network Deny still prevents it. Cancelled, failed or interrupted jobs are not replayed automatically. See [avatar usage and artwork](docs/AVATARS.md).

## Choose a room workspace

One Loom instance stores its rooms, bots, settings, and history in one application data directory. The sidebar identifies that instance; it is not a switcher between multiple workspaces. A room's **working folder** is a separate setting for its file tools and execution context.

Open the room menu → **Edit room** → **Workspace** → **Choose folder**. Each room can override the default folder in Settings; **Use default folder** clears the override. The selected folder applies to that room's bots, tools, and automatic tasks.

On a local Node installation, the button opens the operating system's folder chooser on the computer running Loom. Docker, headless environments, and remote/proxied access cannot use that desktop chooser; an explicit server-path fallback is available. See [room workspace setup](docs/INSTALL.md#room-workspaces-and-folder-selection).

Stop the room's active tasks before changing its folder. Existing tasks retain their original working directory: start a new task in the new folder, or restore the previous folder before resuming old work.

## Docker

Docker Compose builds the app locally; a prebuilt registry image is not required. Copy `.env.example` to `.env`, generate a random token, and set `LOOM_API_TOKEN` to it:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

You can also use your password manager to generate a long random value if Node is not installed on the Docker host.

```sh
docker compose up --build -d
docker compose logs -f loom
```

Open **http://127.0.0.1:3210** and unlock the application with that token. The provided configuration publishes the app only on host loopback, runs as a non-root user, and keeps data in the `loom-data` volume.

When the model server runs on the Docker host, configure its base URL using **`host.docker.internal`**, for example `http://host.docker.internal:1234/v1`. Inside a container, `127.0.0.1` refers to that container. The inference server must listen on an interface reachable from Docker and permit that connection.

## Failure and interruption diagnostics

Each task retains a specific interruption or timeout explanation when its cause is known. Explicit stops are distinguished from server shutdown, process signals, supervisor disconnection and data-transfer restarts. Model transport timeouts include elapsed request time and a recognized stage/code; HTTP 408/504 and unknown provider timeouts remain separate categories. **Copy diagnostics** in the task's error panel or historical status-error log copies the selected record's identifiers, timestamps, state and error without the prompt or reasoning. Selectable text is available when clipboard access fails. See [diagnosing interruptions and timeouts](docs/MODELS.md#identifying-a-failed-or-interrupted-request).

## A clear division of responsibilities

**Loom** manages people-facing conversations, bots, tasks, approvals, scheduling, memory, and skill review. **Pi** provides the embedded agent/model/tool loop. **Your inference server** loads the model and performs generation. The UI streams updates from the application server; it does not receive your model API key.

The default is one model request at a time. **Settings → Concurrent generation → Maximum concurrent generations** accepts 1–16; it can change while work runs. Lowering it lets existing requests finish and delays new admissions. A bot waiting for an ordinary tool or your approval leaves model capacity available. Each room defaults to one response request at a time; enable parallel responses for that room if several bots should generate together. The same bot × room session always stays exclusive.

Loom controls request admission. Continuous batching, prefill/decode scheduling, KV-cache allocation, and GPU execution remain the inference server's responsibility. Start with a limit of **2** when evaluating a server configured for concurrent requests, then compare latency, total throughput, memory use, and cancellation. A larger limit is not a promise of faster individual replies. See [models and concurrency](docs/MODELS.md).

To generate images, enable **Image generation** in Settings and supply a separate OpenAI-compatible Images base URL, model ID, and optional key. The bot's `generate_image` tool saves PNG/JPEG/WebP attachments in chat. New image settings default to square **2K (`2048x2048`)**, a **60-minute** generation timeout and **parallel image/text inference** (shared inference slots off). Existing settings are retained; the **2K / 60 min / parallel LLM** preset updates those fields and disables shared inference slots after you save it. Images remain one at a time while text can run alongside them, including on the same machine when the models support coexistence. Optional **Sampling steps** accepts 1–1,000; leave it empty for the image server default. Choose the matching step sending format, including stable-diffusion.cpp, then save. The count applies to bot images and avatars, and the settings test uses the draft count. See [sampling steps and provider formats](docs/MODELS.md#sampling-steps). All image-model fields and the preset can be edited after every active room task is fully paused. Changes apply to new image requests; already prepared requests keep their original settings and credentials. Native ComfyUI workflows are not an implemented adapter.

To let bots inspect images, use an image-capable conversation model and inference server, enable **Settings → Model connection → Enable image input**, and save. Bots gain `view_image` for images attached in the current room, including another bot's generated images and saved screenshots, and PNG/JPEG/WebP files inside their workspace. For example, ask a bot to inspect the image it just generated or `design/banner.png`. Chrome and the image-generation integration can both be disabled when reading an existing file.

Generation returns a saved-image ID and metadata; the bot explicitly reads the image before judging its appearance or text. Image references in room history do not automatically send every image to the model. Reading does not generate another image or require image-generation approval. Each image is limited to 20 MiB, 8,192 pixels per side and 16,777,216 pixels in total. Explicit reads and immediate screenshots share an 80 MiB budget for new image bytes per task execution. See [image-input configuration and limits](docs/MODELS.md).

**Bot image generation** offers **Follow network permission** (the default), **Allow without approval**, **Ask every time**, and **Deny**. Inherited network Auto or Ask requires approval of each exact image request; Network Deny always blocks generation. Explicit image Allow applies only to bot image generation, leaving other network tools unchanged. The owner's image-test and avatar Generate buttons retain their direct consent behavior.

The bot image permission can change during active work, while connection settings remain locked. Waiting requests recheck the current policy before dispatch; a newly stricter policy blocks them. Selecting Allow does not automatically approve a card that is already pending.

The image settings also offer a **one-image test** using the current unsaved configuration, a short fixed prompt and the selected size. Preview the actual result before saving. Testing does not save settings or create a chat message. Editing the connection invalidates the result; cancellation or a lost connection never automatically starts another generation. A paid provider can charge for this real image request.

The implementation and its limits are described in [ARCHITECTURE.md](docs/ARCHITECTURE.md). The [source research](docs/RESEARCH.md) covers Pi, Hermes Agent, OpenCode, and the official DeepSeek Harness. Their products and plugin APIs are not interchangeable with Loom.

## Scheduled wake-ups

Open **Automations → New automation → Scheduled wake-up**. Choose **Once**, **Every day**, or **Selected weekdays**, then set the local date/time, time zone, target bot, room and instructions. The editor previews the next wake-up; cards retain the configured time zone even when viewed from another computer. The initial time zone follows the browser and can be changed explicitly.

Choose **Run once when available** to combine missed occurrences into one task when Loom is available, or **Skip missed wake-ups** to skip an occurrence at least one minute late. The scheduler normally checks every five seconds. A one-time reservation becomes **Dispatched** when the bot task is queued; its actual progress remains visible in the room. **Run now** consumes a one-time reservation, so it does not also run at its original future time. Set a new future date to schedule it again.

Calendar schedules preserve local clock times across daylight-saving changes. A nonexistent one-time local datetime is rejected; a recurring occurrence in a missing clock interval is skipped. If a local time occurs twice, the first occurrence is used. The Loom server must remain running; this feature does not power on or wake the computer. See [scheduled wake-up details](docs/SCHEDULES.md).

## Configuration and data

Use **Settings → Data transfer** to copy settings, conversations, saved credentials, sessions, images and workspaces to another running Loom through a password-protected file. The destination previews the copy, backs up its existing data, replaces it and restarts. Imported automations stay disabled until you choose to enable them. See the [copy and recovery guide](docs/DATA_TRANSFER.md) for scope, limits and machine-specific settings.

Most settings are available in the browser. Optional process settings belong in `.env`:

| Variable         | Default           | Purpose                                                                                                |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| `LOOM_HOST`      | `127.0.0.1`       | Application listening address.                                                                         |
| `LOOM_PORT`      | `3210`            | Application port.                                                                                      |
| `LOOM_DATA_DIR`  | `.loom`           | Database, credential key, and default working directory.                                               |
| `LOOM_API_TOKEN` | Empty on loopback | Application access token; required for non-loopback deployment and the supplied Compose configuration. |

Keep the full data directory when moving or backing up Loom, including `generated-images` for chat attachments. Stop the process first so SQLite and its journal are consistent. Stored integration secrets are encrypted with a key in that same directory; keep the key with the database and protect both. Conversations, generated images, and other records are not encrypted by Loom. A backup is sensitive.

The backend must remain running for scheduled work and mail checks. A closed browser does not stop the backend; a sleeping or powered-off computer does. The current notification destination is the application inbox, not a built-in Telegram, Discord, Slack, or mobile push gateway.

You can also ask a bot directly in a room: “Every 30 minutes, check this release page and notify me about important changes.” The bot can list that room's rules and create, edit, pause or resume one. Each change shows its exact trigger, calendar schedule or interval, time zone, recovery policy, teammate and instructions for approval before saving. These tools are available only to direct user chat tasks; a scheduled task or a teammate handoff cannot create more schedules. For a fixed time, ask for a scheduled wake-up with the time zone, for example: “Every weekday at 09:00 Asia/Tokyo, review the open work in this room.” Relative intervals still start from saving; use a daily/weekday schedule for fixed local clock times.

For Gmail, open **Mail & services → Connect email**, enter the address, choose **Use Gmail connection settings**, and enter a Google **app password** in the IMAP and SMTP password fields. Disable SMTP if you need only receiving. Test and save the connection, assign a bot, then select it in an **Incoming email** automation. The legacy Gmail preset remains available in the automation editor. This version uses app passwords, not Google OAuth sign-in. See [Gmail setup and account requirements](docs/INSTALL.md#gmail-setup).

Unattended URL and mail polling requires the network permission to be **Allow** or **Smart auto-approve**. Checks use bounded batches and persistent checkpoints instead of importing the entire mailbox. Connected-account rules include arrivals since rule creation, even before their first successful poll; legacy inline IMAP rules keep their original first-check baseline behavior. Polling itself does not send mail or mark messages as read. A bot can separately read a message body from a connected account and prepare a reply under its mail permissions. See [mail setup, buffering and recovery](docs/MAIL.md) and [trigger behavior](docs/INSTALL.md#configure-proactive-work).

## Development

```sh
npm ci
npm run dev
```

Open **http://localhost:5173**. The development frontend proxies the API on port 3211. Production serves both UI and API on port 3210.

```sh
npm run check
```

This runs type checking, deterministic tests, the production build, and a production HTTP smoke check. CI is configured for Node 24 on Linux, Windows, and macOS, plus a container build and health check. Live model compatibility depends on your selected server, model, and tool template; the automated suite uses controlled fixtures rather than downloading models or making paid API calls. See [the validation record](docs/VALIDATION.md) for executed checks and verification limits.

## Current boundaries

Loom is for one trusted owner. Bot roles are not separate security principals. Tool approvals are a review mechanism; shell access still has the permissions of the operating-system account running the app. Read [SECURITY.md](SECURITY.md) before remote access or mounting personal directories into a container.

This release does not provide an OS sandbox, multi-user administration, a plugin marketplace, general MCP-client compatibility, provider subscription/OAuth login, full IDE functionality, model training, or an external messaging bot gateway. Restart recovery preserves visible task history but cannot promise exactly-once effects for arbitrary external tools. Review interrupted work before resuming it.

## License and credits

Agent Loom is available under the [MIT license](LICENSE), copyright 2026 StackPiles. Runtime dependencies keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Thanks to the authors of [Pi](https://github.com/earendil-works/pi), [Hermes Agent](https://github.com/NousResearch/hermes-agent), [OpenCode](https://github.com/anomalyco/opencode), and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for publishing their work. Pi is a dependency. The other projects informed original product and architecture decisions. Loom is not affiliated with or endorsed by them.
