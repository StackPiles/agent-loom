# Research and design decisions

Research date: **2026-10-30**. Agent Loom is an independent StackPiles project. The references below informed its design; they do not imply affiliation, endorsement, runtime compatibility, or equal feature coverage.

## What we are building

A self-hosted workspace where people can see, direct, and review several agents using an existing model server. The first deployment is deliberately small: one owner, a few bots, persistent rooms, and one model request at a time. The UI and application server belong to Loom; the model server belongs to the operator.

The motivating problems are concrete:

- A permission request must identify the agent, task, operation, and actual arguments.
- A room must remain discoverable after navigation, refresh, and restart.
- Waiting for inference, running a tool, waiting for approval, stopping, and failing must have distinct states.
- People should address short bot handles with keyboard completion, without typing internal IDs.
- A bot should be able to ask another bot a question, receive an answer, and continue a bounded task.
- Useful experience should survive a session, with a visible record of what was learned.

## Sources and what we take from them

| Reference                 | Mechanisms adopted in Loom                                                                             | Deliberately outside the first version                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Pi                        | Embedded agent SDK, explicit tools, execution events, model adapter, persisted sessions.               | Automatic discovery of CLI extensions and all upstream command-line features.                            |
| Hermes Agent              | Separate memory and procedures, evidence-linked skill proposals, background review, visible revisions. | Full curator parity, automatic semantic validation of lessons, or guaranteed learning gains.             |
| OpenCode                  | Server-owned state, streamed events, exact permission requests, recoverable user controls.             | Its full IDE features, server protocol compatibility, and provider-specific subscription authentication. |
| Official DeepSeek Harness | Capability boundaries, typed contracts, explicit ownership and cleanup.                                | DSH/Cordis plugin compatibility, arbitrary hot reload, and a plugin marketplace.                         |

### Pi: use an agent library rather than rebuilding the model/tool loop

The [Pi SDK](https://pi.dev/docs/latest/sdk) exposes agent sessions, model and tool configuration, resource loading, persistence, and execution events inside Node.js or Bun. [RPC mode](https://pi.dev/docs/latest/rpc) provides a process boundary for other hosts. [Skills](https://pi.dev/docs/latest/skills) are discovered as reusable instructions. Pi's [security guidance](https://pi.dev/docs/latest/security) makes clear that application-level tool controls do not create an operating-system sandbox.

**Loom decisions:** keep the Pi adapter separate from room and task management; provide a deliberate tool set; translate runtime events into durable application state. Do not confuse a low-level run ending with the complete application task being finished. Load only relevant task context and skills rather than placing every room transcript and skill into every prompt.

**Boundary:** importing the SDK does not automatically import every CLI extension. A plugin being available in Pi's CLI does not mean Loom has integrated it. SDK persistence also does not make arbitrary external side effects safely replayable.

### Hermes: retain experience, and make learning observable

Hermes distinguishes [persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) from [procedural skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills). Its background review can turn corrections and workflows into durable entries. The [curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator) tracks usage and maintains the skill collection. [Scheduled tasks](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron) demonstrate how reusable instructions and automatic triggers can work together.

**Loom decisions:** preserve compact bot-specific memory separately from task procedures; record the task that produced a skill proposal; expose learning changes in the UI; retain revisions so a bad change can be reversed. Run reflection with lower priority than a person's active request. A candidate is a proposal, not a certificate that a workflow is correct.

**Boundary:** skill loading counts are not successful-task counts. Shape checks, write approval, and a readable procedure cannot establish semantic correctness. The [reported wrong-target update issue](https://github.com/NousResearch/hermes-agent/issues/66350) and [cross-store correction request](https://github.com/NousResearch/hermes-agent/issues/143221) motivate explicit provenance and correction workflows. These reports are examples, not estimates of failure frequency.

### OpenCode: explicit permissions and an observable server

OpenCode's [server API](https://opencode.ai/docs/server/) separates client presentation from session execution and exposes events. Its [permission model](https://opencode.ai/docs/permissions/) distinguishes allowing, asking, and denying an operation. Its [skills interface](https://opencode.ai/docs/skills/) supports reusable instructions loaded when needed.

**Loom decisions:** the browser is a client of a persistent backend; tool activity and approval requests are first-class records; controls are tied to an exact run and operation. Show the actual requested action rather than a generic Allow/Deny card. Reconnect the UI to backend truth instead of using a spinner as the source of task state.

**Boundary:** Loom is not an OpenCode frontend and does not implement the OpenCode API. Editing files and approving tools are application capabilities; they do not constitute a full IDE, code-review platform, or security boundary.

### DeepSeek Harness: composable capabilities with lifecycle ownership

The official project is [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), linked from [DeepSeek's own product page](https://www.deepseek.com/en/harness/). Its [architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) and [plugin lifecycle documentation](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/) describe replaceable services, typed events, and cleanup tied to a component's lifetime. The project identifies its interfaces as preview software.

**Loom decisions:** give model access, tools, persistence, execution, automation, and presentation clear responsibilities. Stop timers, detach listeners, and cancel pending work when their owner is stopped. Keep user configuration separate from execution records. Make adding a capability possible without rewriting the chat UI.

**Boundary:** Loom does not load DSH/Cordis plugins or copy its runtime. A full plugin marketplace, arbitrary hot-reloaded extensions, and universal compatibility would add substantial installation and permission complexity; they are not implied by this design.

## Local-model scheduling

Distinct bot identities do not require distinct model processes. Each bot has a role, a task context, and memory; multiple bots can use one endpoint in turn. [llama.cpp's server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) also supports concurrent inference, but Loom's initial default is one active model request to make resource use predictable.

The scarce resource is the inference request, not the entire lifetime of a task. A tool waiting for approval must not occupy the model slot. Network and filesystem waits can coexist with another bot's model request. A request that is cancelled while waiting must be removed from the queue; a request that fails must release its slot.

Directed messages carry a recipient and a source task. A bot's response does not automatically wake every member of a room. Handoff limits and per-run budgets contain accidental back-and-forth loops. Reflection shares the same resource policy rather than silently launching a second unrestricted model workload.

These are Loom's design requirements, not claims that an upstream library supplies all of them automatically.

## State, interruption, and recovery

The application must distinguish conversation persistence from execution recovery. A saved chat can be opened again even when a process died halfway through a tool call. That tool's external outcome may still be unknown.

The recovery policy is therefore conservative:

1. Persist a task's identity, inputs, status, activities, and approvals.
2. Make queued work distinguishable from work that actually started.
3. After an unexpected restart, surface interrupted work explicitly.
4. Resume from the visible record; do not silently promise exactly-once execution of external effects.
5. Tie every approval to the originating operation, and invalidate an approval when its operation is cancelled.

Stable room IDs and durable message history solve a different problem from browser tabs. A room should be available in navigation even if no tab for it remains open.

## Learning quality: what the evidence establishes

[PAST-Bench](https://arxiv.org/abs/2608.04003) compares access to retained experience with a matched no-retention condition across fresh-session tasks. It reports positive aggregate differences for Hermes across seven evaluated models. This supports the usefulness of persistence under controlled conditions. The study uses a prior Hermes snapshot with benchmark adapters and synthetic task families; it does not prove that Loom, current stock Hermes, every local quantization, or indefinite multi-agent use will improve automatically.

For Loom, an evaluation should separately record:

- Whether the next task succeeded, using external checks where possible.
- Whether a saved lesson was retrieved and used.
- How many user corrections or repeated tool calls were needed.
- Total time and tokens, including the cost of reflection.
- Whether applying a lesson introduced a regression on another task.

Compare no retained experience, factual memory only, and factual memory plus procedures using the same model configuration and equivalent task variants. A larger skill library is not itself a success metric.

## UI and interaction principles

The interface should make system state easier to understand than raw logs without hiding the underlying evidence:

- Keep rooms and bot handles stable and searchable.
- Put progress, model-queue waits, tool results, errors, and approvals beside the relevant conversation.
- Preserve drafts and avoid moving the reader's scroll position when they are inspecting earlier messages.
- Use keyboard navigation, visible focus, labels, and reduced-motion support.
- Use short transitions to communicate a change of state; ongoing animations must not imply work is progressing when it is waiting.
- Give connection failures a useful next action: inspect the endpoint, retry a request, or resume a known interrupted task.
- Keep secrets on the server, and make connection configuration available before the first model request.

These are original product requirements derived from the use case. They are not a claim that Loom reproduces another product's appearance or complete feature set.

## License and implementation policy

The four reviewed projects published MIT licenses at the sources checked on the research date: [Pi](https://github.com/earendil-works/pi/blob/main/LICENSE), [Hermes](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE), [OpenCode](https://github.com/anomalyco/opencode/blob/dev/LICENSE), and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE). These links follow upstream branches; they are not immutable snapshots. Loom's direct Pi dependency is pinned to `@earendil-works/pi-coding-agent` 1.4.0 in its initial package manifest, with the complete resolved dependency versions in the lockfile.

Loom's application code is an original implementation. Pi is used as a software dependency; the other projects are design references. Any future copied or adapted source must retain the relevant copyright and license notices. Runtime dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Logos, brand assets, models, and service terms are separate from source-code licenses.

## Scope of the first release

The first release should be evaluated as a usable personal workspace, not as a drop-in replacement for all four reference products. The README is the authoritative list of implemented features and installation steps. Unimplemented integrations, external messaging channels, provider-specific authentication, multi-user administration, operating-system sandboxing, and automatic model training must be identified explicitly rather than represented by inactive controls.
