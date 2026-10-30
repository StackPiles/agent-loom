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

Configure context and output limits to match what the server actually supports. Increasing the number in Loom does not enlarge the model server's context window or GPU memory. Requests for all bots share a single inference slot.

**Inference settings** offers powers of two with explicit counts: context choices range from `2^11` (2,048) through `2^21` (2,097,152), and output choices from `2^7` (128) through `2^17` (131,072). Existing custom values remain selectable without rounding. The API also accepts other integers within these bounds. Output must be strictly smaller than context. Lower the output setting first when a smaller context option is disabled.

**Reasoning mode** defaults to **Server default**, which does not send an additional reasoning-effort option. Choose **OpenAI-compatible** and Low, Medium, or High only when the server supports `reasoning_effort`. Loom displays plain-text reasoning actually returned by the model, separately from the answer; selecting this setting cannot make an unsupported model return reasoning. Reasoning is stored with the conversation, with explicit completion/interruption and truncation markers.

### Docker networking

From a container, `localhost` means that container. For inference on the host, replace it with `host.docker.internal`:

```text
http://host.docker.internal:1234/v1
```

The supplied Compose file adds the host-gateway mapping for Linux. Docker Desktop also supports this hostname. The inference server must listen on a host interface reachable from the container. Restrict its firewall rules to the intended clients; do not assume binding it only to host `127.0.0.1` will make it reachable from a Linux container.

For an inference server in another Compose service, use that service's name and container port on the shared Docker network. For another computer, use its LAN address and check the firewall.

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

Stop Loom and copy the **entire** data directory to back it up. Restore it as a unit. Losing `secret.key` prevents decrypting the stored credentials; copying the database alone is insufficient. Anyone who obtains both files can access those credentials, so protect the backup like the original data.

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

| Symptom                                             | Check                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Node fails on `node:sqlite`                         | Use Node 24 LTS, then reinstall with `npm ci`.                                                                            |
| App does not open                                   | Check the terminal error and listening port. Another process may already use 3210.                                        |
| Connection test fails                               | Confirm the server is running, the URL is reachable from the **backend**, `/v1` is correct, and credentials are accepted. |
| Model list works but messages fail                  | Match the model ID exactly; inspect the server log, chat template, streaming support, and context/output limits.          |
| Normal chat works but tools fail                    | Confirm model and server support OpenAI-style tool calls. Try a small explicit tool task before complex handoffs.         |
| Docker cannot reach a local model                   | Use `host.docker.internal` or the server's LAN address, and check the server listening interface/firewall.                |
| A task is waiting                                   | Inspect its specific state: model queue, tool, or approval. These waits are different from a stopped task.                |
| A task was interrupted by restart                   | Review its last activity and any external effects, then use the explicit resume action.                                   |
| Automation does not run while the browser is closed | The backend must still be running and the machine awake. Check whether the automation is enabled and its last error.      |
| Web search fails                                    | Check the selected provider; SearXNG must allow JSON output, while Brave needs a valid key.                               |
| IMAP login fails                                    | Check host/port/TLS, mailbox access, and whether the provider requires an app password.                                   |

For a bug report, include the app commit, OS, Node version, launch method, server/model name, and a sanitized error. Do not attach the data directory or credentials. See [CONTRIBUTING.md](../CONTRIBUTING.md).
