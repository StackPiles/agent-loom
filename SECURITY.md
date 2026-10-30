# Security policy

## Intended deployment

Agent Loom 0.1 is a self-hosted, single-owner application. Its process can reach the configured model server, connected services, and files available to its operating-system account. Bot profiles are collaboration roles, not security isolation between mutually untrusted users.

Use the latest commit on `main` until versioned releases are established. The project does not currently offer a paid response SLA, formal security certification, or a multi-tenant hosting guarantee.

## Access and secrets

The local default is loopback (`127.0.0.1:3210`). Set a long, random `LOOM_API_TOKEN` before binding the application to another interface; the supplied Docker Compose configuration requires one and publishes the port only on host loopback. An application token is separate from the inference server's API key.

Keep the application behind a trusted network boundary. A remote deployment needs HTTPS and appropriate reverse-proxy access controls. A token alone does not make a public installation production hardened.

Treat the complete data directory as sensitive. It contains conversations, remembered facts, task history, and integration credentials or authentication material. Stored integration secrets use AES-256-GCM with a local `secret.key` file in the same directory. This protects a database copy without its key; it does not protect a machine or backup where an attacker can read both. General records are not encrypted by Loom. Use operating-system file permissions and encrypted storage/backups appropriate to the machine.

## Tool execution and external input

Approvals help the owner review a proposed action. They do not provide an operating-system sandbox. A permitted shell command can access everything its process user can access, including files outside the selected workspace. Run the app under a dedicated account or in a container when that separation is needed; mount only the directories you intend to make available.

Pages, email, tool results, webhook payloads, learned skills, and other bots' messages are untrusted inputs. Their contents can contain misleading instructions. Review consequential operations and skill candidates before granting access or activating reusable instructions. A strong local model may still make mistakes.

The Docker image runs as a non-root user, but this does not isolate it from intentionally mounted files or reachable services. Do not mount the Docker socket or broad host directories for routine use.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** workflow when that option is available. If private reporting is not enabled, open a minimal issue asking the maintainers for a private reporting channel; omit exploit steps, tokens, private URLs, and personal data until a confidential channel is established. No private contact address is promised by this repository.

Useful reports include the affected commit, deployment mode, prerequisites, a minimal reproduction using synthetic data, and the security impact. Do not test against other people's installations without their permission.

The maintainers will assess reports as capacity allows. Ordinary UI bugs and feature requests belong in GitHub Issues.
