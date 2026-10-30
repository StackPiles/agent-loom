# Version 0.1.1 validation

Date: **2026-10-30**. Application version: **0.1.1**.

## Executed checks

The release source was checked on Linux with Node.js **24.22.1** and npm **11.9.0**.

| Check                                | Result                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Client and server TypeScript         | Passed                                                                                     |
| Automated tests                      | **64 named cases passed; 0 failures, skips, or cancellations**                             |
| Production build                     | Passed                                                                                     |
| Compiled production server over HTTP | Passed: health, HTML, all five referenced JS/CSS assets, authentication, and initial state |
| Prettier formatting                  | Passed                                                                                     |

`npm run check` runs type checking, tests, the production build, and the production HTTP smoke check. `npm run format:check` checks formatting. Tests use temporary data directories and synthetic credentials; they do not require a model download, paid provider, or real mailbox.

[GitHub CI](https://github.com/StackPiles/agent-loom/actions/workflows/ci.yml) runs `npm ci` and `npm run check` with Node 24 on Linux, Windows, and macOS, plus the Docker image build, container startup, and HTTP health check. Inspect the run for the commit being installed; cross-platform results are separate from the local results above. The local build environment did not have Docker.

## What the tests exercise

- **API and persistence — 17 cases:** clean initial state; authentication and session revocation; same-origin and host checks; secret encryption/redaction; partial edits; short mentions; stop/resume; exact approvals and stale-card rejection; handoff budgets; skill revisions and export; webhook identity; input validation; restart recovery; compiled-asset serving and encoded-route authorization; exclusive workspace ownership; token rotation; SSE revocation; atomic multi-recipient queue admission.
- **Integration settings — 4 cases:** model keys stay with their origin; model-discovery requests send the intended credentials; unchanged full settings forms can change live permissions; editing an automation source preserves its previous active-task guard.
- **Smart permissions — 7 cases:** new document approval and the recorded reason; manual review for overwrites and code; denial preserves the original file; a concurrently created target is never overwritten; changing permission to Deny during automatic assessment prevents execution; exact built-in inspections do not grant arbitrary shell execution; escaped and URL-encoded credentials, private paths, and size limits remain protected; redirect policy runs before a credential-bearing destination is contacted.
- **Progress and settings API — 4 cases:** reasoning is stored and streamed separately from answers; display bounds and message ownership; actual HTTP SSE delivers reasoning and provisional-message changes before completion; restart preserves partial reasoning and marks interruption; optional reasoning defaults do not count as a running-model change; token bounds and output/context relationships are enforced.
- **Pi runtime — 6 cases:** FIFO admission and cancellation; file/secret/symlink boundaries; durable side-effect replay and uncertainty handling; restricted learning; real Pi SDK calls against a synthetic OpenAI-compatible SSE endpoint; simultaneous requests serialize; an approval releases the model slot; persisted sessions resume; provider errors remain visible; cancellation and HTTP/shell timeouts are finite. The reasoning fixture additionally verifies live thinking, separate intermediate narration and final answers, duplicate-field handling, no invented reasoning for plain/encrypted-only/demo output, stop/resume ownership, explicit reasoning-effort opt-in, and Unicode-safe truncation.
- **Scheduler — 6 cases:** persisted intervals, coalescing, URL baselines, Allow/Auto/Ask/Deny network behavior and repeated errors, webhook deduplication/batching, read-only IMAP envelopes/UID cursors, and cancellation of overlapping polls. The IMAP transport is a deterministic fixture.
- **Settings interaction — 3 cases:** powers-of-two options, saved custom values and old/new maximum values, output strictly below context without silent adjustment, existing permission preservation, and explicit saving of automatic approval and reasoning controls.
- **Chat and application interaction — 16 cases:** room creation/discovery/selection, keyboard mentions and Japanese IME handling, exact approval decisions, stop/resume, SSE streaming/disconnects, isolated persistent drafts, command-palette/dialog behavior, stale HTTP responses versus newer SSE state, model-key guidance, and logout. Additional cases cover inline reasoning/tool updates, final-answer uniqueness, ownership after resume, approval cards attached to the relevant run, narrow-drawer dismissal, functional headings, approvals outside the loaded message window, and preserved reading position during reasoning streaming. These run against a virtual DOM.
- **Whole application workflow — 1 case:** the explicitly labelled demo uses the actual controller, queue, approval, file tool, handoff, notification, and candidate-skill implementations. It stops at approval, resumes with a fresh card, avoids duplicating the completed handoff, and completes the write.

## Verification limits

No user inference endpoint or real mailbox was available. The Pi adapter is tested against an actual HTTP streaming fixture using the real SDK, but model quality, tool-call quality, and learning usefulness must be evaluated with the operator's chosen model and serving template. Reasoning appears only when the provider actually returns supported plain-text reasoning.

The managed browser-preview environment denied binding its required local port. Browser layout, native dialog focus trapping, and visual animation behavior were therefore **not visually verified**. The layout changes address explicit shrinking/scrolling boundaries, long content, wrapping controls, narrow drawers, and short viewports. DOM tests establish interaction behavior, not pixel-level layout correctness.

Smart approval is an opt-in fixed-rule policy, not an LLM risk assessment or OS sandbox. Arbitrary commands still require review in Auto mode. Existing Allow/Ask/Deny settings remain unchanged when upgrading.

No claim of production hardening, full upstream feature parity, universal model compatibility, or automatic learning improvement follows from these checks. This release is intended for a trusted owner's initial local evaluation.
