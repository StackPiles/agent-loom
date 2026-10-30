# Agent Loom

**A local-first workspace for AI teammates that can work, collaborate, and follow up.**

[日本語](docs/README.ja.md) · [Installation](docs/INSTALL.md) · [Architecture](docs/ARCHITECTURE.md) · [Research](docs/RESEARCH.md) · [Validation](docs/VALIDATION.md) · [Contributing](CONTRIBUTING.md)

Agent Loom brings persistent group conversations, a visible work queue, specific approval requests, proactive triggers, and reviewable learning into one self-hosted application. Connect your own OpenAI-compatible inference server and let several bot identities share it in turn.

The browser UI and application server run on your machine. Your inference server runs wherever you choose. No model weights or hosted model subscription are included. This is an independent, early **0.1.2** release built with TypeScript, React, Node.js, SQLite, and the Pi agent SDK.

## What you can do

| Capability              | Behavior                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistent rooms        | Keep conversations and bot membership across navigation and restarts. Use short `@handles` to address bots.                                        |
| Multi-bot collaboration | Give bots distinct roles and prompts; direct work to another bot with a bounded handoff chain. Model requests share one inference slot.            |
| Visible execution       | Follow queued work, generation, tools, approvals, failures, and interrupted tasks as distinct states. Stop and explicitly resume work.             |
| Specific approvals      | Review exact operations, or select Smart auto-approve for a limited set of low-risk operations. Automatic decisions include their reasons.         |
| Model reasoning         | View reasoning returned by compatible models separately from their answers. Server defaults are preserved unless reasoning effort is configured.   |
| Proactive work          | Trigger tasks on an interval, a watched URL change, an incoming webhook, or new IMAP mail. Route their work to a chosen room and bot.              |
| Notifications           | Keep follow-ups in the application inbox with links to the originating work.                                                                       |
| Memory and skills       | Keep durable notes and propose reusable skills. Review skill candidates, activate them, inspect revisions, restore, and export Markdown.           |
| Web access              | Read web pages and optionally search using your own SearXNG instance or Brave Search API key. No MCP server is required for these built-in tools.  |
| Local model control     | Configure endpoint, model ID, context/output budgets, temperature, and optional reasoning effort. Token selectors preserve existing custom values. |

“Learning” means retained memory and reusable instructions. Loom does not train model weights or guarantee that an automatically proposed lesson is correct. The [research notes](docs/RESEARCH.md) explain what the upstream evidence supports and how it shaped the implementation.

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

## Choose a room workspace

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

## A clear division of responsibilities

**Loom** manages people-facing conversations, bots, tasks, approvals, scheduling, memory, and skill review. **Pi** provides the embedded agent/model/tool loop. **Your inference server** loads the model and performs generation. The UI streams updates from the application server; it does not receive your model API key.

Only one model request is active at a time by default. A bot waiting for a tool or your approval does not need to reserve the inference slot. Several bots are therefore useful even with a single local GPU. This is an application scheduling choice; some inference servers can support multiple simultaneous requests.

The implementation and its limits are described in [ARCHITECTURE.md](docs/ARCHITECTURE.md). The [source research](docs/RESEARCH.md) covers Pi, Hermes Agent, OpenCode, and the official DeepSeek Harness. Their products and plugin APIs are not interchangeable with Loom.

## Configuration and data

Most settings are available in the browser. Optional process settings belong in `.env`:

| Variable         | Default           | Purpose                                                                                                |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| `LOOM_HOST`      | `127.0.0.1`       | Application listening address.                                                                         |
| `LOOM_PORT`      | `3210`            | Application port.                                                                                      |
| `LOOM_DATA_DIR`  | `.loom`           | Database, credential key, and default working directory.                                               |
| `LOOM_API_TOKEN` | Empty on loopback | Application access token; required for non-loopback deployment and the supplied Compose configuration. |

Keep the full data directory when moving or backing up Loom. Stop the process first so SQLite and its journal are consistent. Stored integration secrets are encrypted with a key in that same directory; keep the key with the database and protect both. Conversations and other records are not encrypted by Loom. A backup is sensitive.

The backend must remain running for scheduled work and mail checks. A closed browser does not stop the backend; a sleeping or powered-off computer does. The current notification destination is the application inbox, not a built-in Telegram, Discord, Slack, or mobile push gateway.

Unattended URL and IMAP polling requires the network permission to be **Allow** or **Smart auto-approve**. Their first check establishes a baseline. IMAP reads new-message envelopes such as sender and subject, at most 20 per poll; it does not fetch bodies or attachments, mark mail as read, or send mail. The same automation does not accumulate tasks while its previous task is active. See [trigger behavior and limits](docs/INSTALL.md#configure-proactive-work) before depending on a rule for important alerts.

## Development

```sh
npm ci
npm run dev
```

Open **http://localhost:5173**. The development frontend proxies the API on port 3211. Production serves both UI and API on port 3210.

```sh
npm run check
```

This runs type checking, deterministic tests, the production build, and a production HTTP smoke check. CI is configured for Node 24 on Linux, Windows, and macOS, plus a container build and health check. Live model compatibility depends on your selected server, model, and tool template; the automated suite uses controlled fixtures rather than downloading models or making paid API calls. See [the initial validation record](docs/VALIDATION.md) for executed checks and verification limits.

## Current boundaries

Loom is for one trusted owner. Bot roles are not separate security principals. Tool approvals are a review mechanism; shell access still has the permissions of the operating-system account running the app. Read [SECURITY.md](SECURITY.md) before remote access or mounting personal directories into a container.

This release does not provide an OS sandbox, multi-user administration, a plugin marketplace, general MCP-client compatibility, provider subscription/OAuth login, full IDE functionality, model training, or an external messaging bot gateway. Restart recovery preserves visible task history but cannot promise exactly-once effects for arbitrary external tools. Review interrupted work before resuming it.

## License and credits

Agent Loom is available under the [MIT license](LICENSE), copyright 2026 StackPiles. Runtime dependencies keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Thanks to the authors of [Pi](https://github.com/earendil-works/pi), [Hermes Agent](https://github.com/NousResearch/hermes-agent), [OpenCode](https://github.com/anomalyco/opencode), and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for publishing their work. Pi is a dependency. The other projects informed original product and architecture decisions. Loom is not affiliated with or endorsed by them.
