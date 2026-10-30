# Initial release validation

Date: **2026-10-30**. Application version: **0.1.0**.

## Executed checks

The release source was checked on Linux with Node.js **24.22.1** and npm **11.9.0**.

| Check                                             | Result                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Client and server TypeScript                      | Passed                                                                                     |
| Automated tests                                   | **43 named cases passed; 0 failures, skips, or cancellations**                             |
| Production build                                  | Passed                                                                                     |
| Compiled production server over HTTP              | Passed: health, HTML, all five referenced JS/CSS assets, authentication, and initial state |
| Prettier formatting                               | Passed                                                                                     |
| Runtime dependency audit (`npm audit --omit=dev`) | No known vulnerabilities reported at the time of the check                                 |

`npm run check` runs type checking, tests, the production build, and the production HTTP smoke check. `npm run format:check` checks formatting. Tests use temporary data directories and synthetic credentials; they do not require a model download, paid provider, or real mailbox.

## What the tests exercise

- **API and persistence — 17 cases:** clean initial state; authentication and session revocation; same-origin and host checks; secret encryption/redaction; partial edits; short mentions; stop/resume; exact approvals and stale-card rejection; handoff budgets; skill revisions and export; webhook identity; input validation; restart recovery; compiled-asset serving and encoded-route authorization; exclusive workspace ownership; token rotation; SSE revocation; atomic multi-recipient queue admission.
- **Integration settings — 4 cases:** model keys stay with their origin; model-discovery requests send the intended credentials; unchanged full settings forms can change live permissions; editing an automation source preserves its previous active-task guard.
- **Pi runtime — 5 cases:** FIFO admission and cancellation; file/secret/symlink boundaries; durable side-effect replay and uncertainty handling; restricted learning; real Pi SDK calls against a synthetic OpenAI-compatible SSE endpoint; simultaneous requests serialize; an approval releases the model slot; persisted sessions resume; provider errors remain visible; cancellation and HTTP/shell timeouts are finite.
- **Scheduler — 6 cases:** persisted intervals, coalescing, URL baselines, permission checks and repeated errors, webhook deduplication/batching, read-only IMAP envelopes/UID cursors, and cancellation of overlapping polls. The IMAP transport is a deterministic fixture.
- **React interaction — 10 cases:** room creation/discovery/selection, keyboard mentions and Japanese IME handling, exact approval decisions, stop/resume, SSE streaming/disconnects, isolated persistent drafts, command-palette/dialog behavior, stale HTTP responses versus newer SSE state, model-key guidance, and logout. These run against a virtual DOM.
- **Whole application workflow — 1 case:** the explicitly labelled demo uses the actual controller, queue, approval, file tool, handoff, notification, and candidate-skill implementations. It stops at approval, resumes with a fresh card, avoids duplicating the completed handoff, and completes the write.

## Verification limits

No user inference endpoint or real mailbox was available. The Pi adapter is tested against an actual HTTP streaming fixture using the real SDK, but model quality, tool-call quality, and learning usefulness must be evaluated with the operator's chosen model and serving template.

The managed browser-preview environment denied binding its required local port. Browser layout, native dialog focus trapping, and visual animation behavior were therefore **not visually verified**. DOM tests establish interaction behavior, not pixel-level layout correctness.

Docker was not available in the build environment, so the container was not run locally. Windows and macOS were not run locally either. The repository provides CI jobs for Node 24 on Linux, Windows, and macOS, plus Docker build and health checks; their remote results should be checked after publication.

No claim of production hardening, full upstream feature parity, universal model compatibility, or automatic learning improvement follows from these checks. This release is intended for a trusted owner's initial local evaluation.
