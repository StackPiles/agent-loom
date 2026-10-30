# Changelog

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
