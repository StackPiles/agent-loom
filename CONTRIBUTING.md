# Contributing to Agent Loom

Agent Loom is an early, independent open-source project. Improvements that make local model collaboration clearer, more reliable, or easier to install are welcome.

## Development

Install Git and Node.js 24 LTS, then:

```sh
git clone https://github.com/StackPiles/agent-loom.git
cd agent-loom
npm ci
npm run dev
```

The development UI is at `http://localhost:5173`; it proxies `/api` to the backend on `127.0.0.1:3211`. Production uses a single server on port 3210. The project deliberately uses the same package manager on Windows, macOS, and Linux.

```sh
npm run typecheck
npm test
npm run build
```

`npm run check` runs all three checks. Tests must use isolated temporary data and deterministic model fixtures. They must not require a paid API, download a model, send messages to other people, or modify a developer's actual workspace.

## Before a pull request

- Describe the user-visible problem, the change, and how you checked it.
- Keep shared API types in sync with server and client behavior. Update installation and API documentation when behavior changes.
- Add a focused regression test for a consequential runtime change. Avoid tests that merely restate a constant or duplicate the implementation.
- For UI changes, check keyboard navigation, small screens, loading and error states, and reduced motion. Include a screenshot when it helps review.
- Preserve existing rooms and task records through upgrades. Document data migrations and recovery behavior.
- Keep secrets, model conversations, local database files, and personal workspace files out of commits.

## Runtime invariants

Changes to the runtime should preserve these product promises:

1. Model requests share the bounded inference queue, including scheduled work and learning.
2. Every action belongs to a durable task and a visible room. Pending approvals display the actual operation and arguments.
3. Approving one operation does not silently approve a different operation or a later retry.
4. A stopped or interrupted task has an honest state and an explicit recovery path. External side effects are never described as exactly-once unless the connector can prove it.
5. Bot handoffs are bounded. Private bot context and shared room context are distinct.
6. Learned skills have visible provenance and an approval/review path. Loading a skill is not evidence that it helped.
7. Credentials do not appear in API snapshots or client bundles.

See [the architecture](docs/ARCHITECTURE.md) and [research notes](docs/RESEARCH.md) for the reasoning behind these boundaries.

## Dependencies and licensing

Use the lockfile and explain new runtime dependencies. Prefer small, maintained packages with compatible licenses. Do not copy code, assets, prompts, or documentation from another project without checking its license and retaining the required notices. Research references are not a claim of upstream affiliation or compatibility.

By submitting a contribution, you agree that your contribution may be distributed under this repository's [MIT license](LICENSE). You must have the right to contribute it.

## Bug reports

Include the application version or commit, OS, Node version, launch method, and reproduction steps. For inference issues, include the server/model name, whether tool calling and streaming are enabled, and a sanitized error. Do not attach `.loom`, `.env`, tokens, full email content, or private conversations.

For vulnerabilities, follow [SECURITY.md](SECURITY.md).
