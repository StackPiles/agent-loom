# Installation and operation

## Choose a launch method

Use the Node installation when you want straightforward access to a folder on your computer. Use Docker Compose when you prefer a container and explicit host mounts. Both methods run the same server and browser application. Neither method installs an inference server or downloads model weights.

### Node.js on Windows, macOS, or Linux

Install [Node.js 24 LTS](https://nodejs.org/en/download) and [Git](https://git-scm.com/downloads). Confirm the installed tools:

```sh
node --version
npm --version
git --version
```

Then:

```sh
git clone https://github.com/StackPiles/agent-loom.git
cd agent-loom
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:3210`. Keep the terminal running while using automations. Stop the process with **Ctrl+C**.

On Windows, use a normal terminal under your own account. If PowerShell's execution policy prevents `npm.ps1` from running, use `npm.cmd ci`, `npm.cmd run build`, and `npm.cmd start`. Changing the machine's execution policy is unnecessary.

An `.env` file is optional for the default local installation. To change process settings, copy `.env.example` to `.env`, edit it, and restart. The production start command reads this file automatically.

For unattended initial setup, `LOOM_MODEL_BASE_URL`, `LOOM_MODEL_ID`, and optional `LOOM_MODEL_API_KEY` can seed a **new** database. They do not override model settings already saved in a database; use Settings for later changes. The supplied Compose file passes only the application process variables, so use its UI for model configuration or explicitly add these bootstrap variables to your own Compose override.

### Docker Compose

Install Docker with the Compose plugin and clone the repository. Copy `.env.example` to `.env`; set `LOOM_API_TOKEN` to a long random value. The Compose configuration rejects an empty value.

Generate a token with a password manager, or use Node if already available:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Start:

```sh
docker compose up --build -d
docker compose logs -f loom
```

Open `http://127.0.0.1:3210` and enter the token. `docker compose stop` stops the service and retains its data. `docker compose start` starts it again. `docker compose down` also retains the named data volume; **`docker compose down --volumes` deletes that volume**.

The container runs as the `node` user and persists `/app/data`. Tools execute inside the container. To work with a host project, add a deliberate bind mount to your own Compose override, ensure the container user has appropriate access, and select the mounted path in Loom. A host path such as `C:\Users\you\project` is not automatically available inside the Linux container.

## Connect the inference server

The connection screen takes an **API base URL**, **model ID**, and optional **API key**. Supply the base URL including `/v1`, not the full `/chat/completions` route.

| Server                    | Typical native base URL     | Provider documentation                                                                           |
| ------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| LM Studio                 | `http://127.0.0.1:1234/v1`  | [OpenAI-compatible API](https://lmstudio.ai/docs/developer/openai-compat)                        |
| Ollama                    | `http://127.0.0.1:11434/v1` | [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)                         |
| llama.cpp                 | `http://127.0.0.1:8080/v1`  | [Server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) |
| Another compatible server | `http://SERVER:PORT/v1`     | Your server's own API documentation                                                              |

These are examples, not a certified model compatibility list. Port numbers can be changed by the server operator. Select a model and serving template with streaming chat-completion and tool-call support. A model that can chat but cannot emit valid tool calls will not reliably use tools, hand off to another bot, or save structured learning.

The connection check discovers the server's models without generating an answer. After saving, send a short message. Then test a small read-only task or a bot handoff and inspect the activity view. This separates connectivity, generation, and tool-call problems.

A saved model API key belongs to its configured origin: the URL's scheme, host, and port. Testing a different origin does not forward that saved key. Saving a different origin clears it unless you explicitly enter the credential to use there. Keeping the same origin preserves an omitted key; the clear-key control removes it explicitly.

Configure context and output limits to match what the server actually supports. Increasing the number in Loom does not enlarge the model server's context window or GPU memory. All bots share a configurable inference capacity, initially one request.

**Inference settings** offers powers of two with explicit counts: context choices range from `2^11` (2,048) through `2^21` (2,097,152), and output choices from `2^7` (128) through `2^20` (1,048,576). Existing custom values remain selectable without rounding. The API also accepts other integers within these bounds. Output must be strictly smaller than context, which includes input, history and output. A 1M context (1,048,576) allows power-of-two output limits through 512K (524,288); a 2M context allows 1M output. Lower the output setting first when a smaller context option is disabled. Saved limits and conservative defaults are not automatically increased.

**Reasoning mode** defaults to **Server default**, which omits `reasoning_effort`. Explicit **OpenAI-compatible** mode offers `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`, and sends the selected literal value. The endpoint must support that value; `ultra` is a server extension, not a universally supported OpenAI value. Loom does not silently downgrade the selection. The setting cannot make an unsupported model return reasoning text. Actual returned reasoning is stored separately from answers, with completion/interruption and truncation markers. See [reasoning compatibility](MODELS.md#reasoning-effort).

### Configure concurrent requests

Set **Maximum concurrent generations** from 1 to 16; the default remains 1. This setting can change during active work. Increasing capacity admits eligible waiting requests; decreasing it waits for existing requests to finish, without cancelling their streams. When evaluating a capable local server, begin with 2 and compare latency, aggregate throughput, and memory use with 1.

Each room also has a **Allow simultaneous responses in this room** setting, initially off. With it off, one model response request at a time can run in that room, while independent rooms can use other slots. A task waiting for an ordinary tool or approval does not block another bot's model request. This is request sequencing, not a guarantee that one bot's entire multi-step task finishes before the next begins. The same bot × room session is always exclusive. Parallel generation does not pass another bot's partially streaming text into a new prompt.

The queue reports active requests, capacity and wait reasons, including inference capacity, room order, the same session, and runtime workers. The inference server owns batching, prefill/decode scheduling and cache allocation; Loom does not turn these optimizations on or implement them itself. See [models and concurrency](MODELS.md#parallel-inference).

### Configure an image model

Enable **Image generation** in Settings and enter a separate Images API base URL, model ID and optional key. Supply the base URL, such as `http://IMAGE_SERVER:PORT/v1`; Loom appends `/images/generations`. The server must implement that OpenAI-compatible endpoint. Native ComfyUI workflows require a separate adapter and are not supported directly.

The default size is `1024x1024`, timeout 120 seconds and response format **Auto**. Auto omits the legacy `response_format` field; use explicit Base64 only when your server requires `b64_json`. Accepted settings, API details and provider compatibility are in [the image guide](MODELS.md#image-generation).

Image requests always run one at a time. Keep **Share generation slots with the language model** on when the image and text models contend for the same hardware. It makes image requests use the same global request limit. Disable sharing only when simultaneous image/text work suits your hardware. With a global limit above 1, sharing limits total requests but does not prohibit all overlap.

Bot-initiated image generation uses the network permission; Auto and Ask show the exact prompt, model, size and endpoint before submission. Outputs become authenticated PNG/JPEG/WebP chat attachments, stored in the app data directory rather than the room working folder. Download an attachment when you want a separate copy. Stop cancels the client's request but may not stop computation already running on the image server. Uncertain attempts are not automatically retried.

The same image connection also generates character avatars from **Bots → Profile**. The profile's **Generate** action authorizes that request directly; Network Deny still blocks it. Preview and select the result, then save the profile. The four bundled character choices work without configuring any image model. See [avatar usage, persistence and artwork](AVATARS.md).

### Docker networking

From a container, `localhost` means that container. For inference on the host, replace it with `host.docker.internal`:

```text
http://host.docker.internal:1234/v1
```

The supplied Compose file adds the host-gateway mapping for Linux. Docker Desktop also supports this hostname. The inference server must listen on a host interface reachable from the container. Restrict its firewall rules to the intended clients; do not assume binding it only to host `127.0.0.1` will make it reachable from a Linux container.

For an inference server in another Compose service, use that service's name and container port on the shared Docker network. For another computer, use its LAN address and check the firewall.

## Room workspaces and folder selection

One running Loom instance owns one application data directory (`LOOM_DATA_DIR`). There is no multi-workspace switcher in this release. A room's working folder is separate from that app identity and from its saved conversation/settings.

The **Create room / Edit room** dialog has a **Workspace** control. Choose a folder, then save the room. **Use default folder** removes the room override and follows the **Default workspace** in Settings. Existing rooms without an override keep using the default.

The selection button opens a native dialog on the computer running Node. It does not upload or copy the directory. A selected path is applied only when you save the room/settings form; cancelling retains the previous value.

| Environment                                    | Folder selection                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows, local Node installation               | Explorer-style Common Item Dialog in folder-selection mode through built-in Windows PowerShell.                                            |
| macOS, local Node installation                 | Native folder chooser through `osascript`.                                                                                                 |
| Linux desktop, local Node installation         | `zenity` or `kdialog`, when a graphical session and the utility are available.                                                             |
| Docker, headless server, remote/proxied access | Native desktop selection is unavailable. Use the explicit manual-path fallback for a directory on the Loom server or inside its container. |

Use `localhost` or a loopback IP on the same desktop for native selection. Set `LOOM_NATIVE_PICKER=0` and restart to disable native dialogs explicitly. A folder on your browser's computer cannot configure another server's filesystem. With Docker, mount the host directory deliberately and select its container path; entering a Windows host path does not create that mount.

Each task pins its folder at queue admission. Bot handoffs and learning inherit that folder; independent automated tasks use their destination room's current folder. Changing a room's folder is blocked while it has active work, without preventing edits to unrelated rooms. If a stopped task's original folder differs from the room's current folder, resume returns an error: restore the original folder or send a new request. Its operation journal is never replayed into a different root.

File tools use the task's folder boundary. An approved general shell command retains its operating-system privileges; separate room folders are not an OS sandbox. Back up custom room directories separately from application data.

## Configure web search

Reading a URL and searching the web are different operations. The built-in search tool needs either:

- Your SearXNG base URL, with JSON responses enabled in that instance.
- A Brave Search API key.

Choose the provider in Settings. No MCP connection is required for these integrations. They can contact external services; a local inference endpoint alone does not make a task that searches the web fully offline.

## Configure permissions

Shell commands, file writes, and network access each have four modes:

| Mode               | Behavior                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Ask each time      | Show the exact proposed operation for review.                                                                                                |
| Smart auto-approve | Apply fixed rules to the exact operation. A limited set of reads and new document writes run automatically; other operations request review. |
| Allow              | Permit operations in this category, subject to the tool's existing path, network, and execution limits.                                      |
| Deny               | Refuse operations in this category.                                                                                                          |

Smart auto-approve permits new `.md`, `.txt`, `.csv`, and `.tsv` files up to 64 KiB inside the workspace, excluding hidden/private paths. Existing-file overwrites, code files, and arbitrary shell commands require review. A few exact inspection commands such as `pwd`, `ls`, `dir`, `Get-Location`, `Get-ChildItem`, and `node --version` use bounded built-in equivalents without launching a shell. The full accepted forms are listed in [Architecture](ARCHITECTURE.md#approval-and-io-boundaries).

Public web reads and configured search can also run automatically. Credential-like URL parameters or arguments containing a known integration key fall back to review. Automatic decisions include their rule and reason in activity. This is a deterministic policy, not a second model that judges an operation's intent. Existing settings and defaults are retained until you change them.

Automatic web reads check redirect targets too. A redirect outside these rules stops before its destination is contacted. To review that request explicitly, change network permission to Ask and retry it. Public-address restrictions still apply after manual approval.

## Configure proactive work

Create an automation, choose its destination room and bot, and write the instruction it should carry out. The initial trigger types are intervals, URL changes, incoming webhooks, and IMAP mail. Use **Run now** to inspect the behavior before leaving an automation enabled.

The app server must stay running. Background work uses the same model queue as interactive conversations, and tool permissions still apply. A trigger does not mean an operation bypasses approval.

Archiving a destination room, disabling its assigned bot, or removing that bot from the room pauses affected automation rules. Restore a valid destination and enable the rules again when ready. Editing a source establishes a new baseline after any previous task for that rule has finished.

Unattended URL and IMAP polling requires **network permission: Allow or Smart auto-approve**. Auto permits the watcher's configured public URL read or read-only mailbox polling. With Ask or Deny, the watcher records a visible error instead of silently making the request. The resulting bot task still follows its normal tool permissions.

Intervals have a one-minute minimum. A rule's next due time survives restarts; missed intervals are coalesced rather than replayed as a large burst. A rule with an active prior task waits for a later poll. Watchers establish their baseline on the first successful check:

- URL watchers compare a hash of extracted readable text. Fetches are bounded to 2 MB and comparison text to 24,000 characters. They do not render JavaScript or compare every byte of a large page. Only public HTTP(S) targets are supported by the general URL watcher.
- IMAP watchers record UIDVALIDITY and a UID cursor. They read up to 20 new message envelopes per poll and retain the remaining cursor for later checks. Existing mail is not reported on first setup. A changed UIDVALIDITY creates a new baseline and a visible notification.
- Webhooks deduplicate repeated nonempty `eventId` values. While a task is active, the newest 20 events are kept in a persisted batch for a later task, with older arrivals counted as coalesced. Event text is capped at 1,000 characters. This is suitable for concise triggers, not a lossless event archive.

IMAP requires a mailbox account and server configuration. Where the provider requires it, use an app-specific password. The initial integration does not implement provider-specific OAuth enrollment. Avoid placing credentials in prompts; enter them in the integration fields.

The IMAP connection selects the mailbox read-only and requests envelopes/dates only. It does not fetch bodies or attachments, change flags, move messages, or send email. Importance detection is therefore limited to metadata such as sender and subject. Use direct TLS (usually port 993), or require STARTTLS when direct TLS is disabled (usually port 143). Cleartext authentication is not enabled by this connector.

Webhook credentials are separate from the app access token. Generate a webhook token for the chosen automation, retain the displayed token, and have the sender attach it as a Bearer token. Give repeated deliveries the same `eventId` when available so the receiver can deduplicate them. See [API.md](API.md) for the request shape.

## Data and backups

The native default data directory is `.loom` relative to the application directory. It includes:

- `loom.sqlite` and possible SQLite journal files: conversations, settings, bots, runs, activity, memories, skills, and automation state.
- `secret.key`: the local encryption key for stored integration secrets.
- `workspace/`: the default working directory for tools.

Stop Loom and copy the **entire** data directory to back it up, including `generated-images` for image attachments. Restore it as a unit. Losing `secret.key` prevents decrypting the stored credentials; copying the database alone is insufficient. Anyone who obtains both files can access those credentials, so protect the backup like the original data. General conversation records and generated image files are not encrypted by Loom.

If you change the workspace to a directory outside the data directory, back that directory up separately. For Docker, back up the named `loom-data` volume while the service is stopped, using your normal Docker volume backup procedure.

## Update

Stop the app and back up its data. For Node:

```sh
git pull --ff-only
npm ci
npm run build
npm start
```

For Docker:

```sh
git pull --ff-only
docker compose up --build -d
```

Read changes affecting storage before replacing an older release. Only one Loom process can own a data directory. The store obtains an exclusive database lock before seeding or restart recovery; a second process fails without cancelling the first process's work. The operating system releases that lock when its owning process exits or crashes.

## Troubleshooting

| Symptom                                             | Check                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node fails on `node:sqlite`                         | Use Node 24 LTS, then reinstall with `npm ci`.                                                                                                         |
| App does not open                                   | Check the terminal error and listening port. Another process may already use 3210.                                                                     |
| Connection test fails                               | Confirm the server is running, the URL is reachable from the **backend**, `/v1` is correct, and credentials are accepted.                              |
| Model list works but messages fail                  | Match the model ID exactly; inspect the server log, chat template, streaming support, and context/output limits.                                       |
| Normal chat works but tools fail                    | Confirm model and server support OpenAI-style tool calls. Try a small explicit tool task before complex handoffs.                                      |
| Docker cannot reach a local model                   | Use `host.docker.internal` or the server's LAN address, and check the server listening interface/firewall.                                             |
| A task is waiting                                   | Inspect its specific state: model queue, tool, or approval. These waits are different from a stopped task.                                             |
| Raising concurrency does not make one reply faster  | Check server-side batching/capacity, memory pressure, room parallel-response settings, and whether both tasks use the same bot × room session.         |
| The server rejects a reasoning level                | Return to Server default or select a literal value supported by that server. Loom does not translate `ultra` to a lower effort.                        |
| Image generation fails                              | Confirm the separate image URL/model/key, supported size and Images API protocol. Auto omits `response_format`; Base64 explicitly requests `b64_json`. |
| A task was interrupted by restart                   | Review its last activity and any external effects, then use the explicit resume action.                                                                |
| Automation does not run while the browser is closed | The backend must still be running and the machine awake. Check whether the automation is enabled and its last error.                                   |
| Web search fails                                    | Check the selected provider; SearXNG must allow JSON output, while Brave needs a valid key.                                                            |
| IMAP login fails                                    | Check host/port/TLS, mailbox access, and whether the provider requires an app password.                                                                |

For a bug report, include the app commit, OS, Node version, launch method, server/model name, and a sanitized error. Do not attach the data directory or credentials. See [CONTRIBUTING.md](../CONTRIBUTING.md).
