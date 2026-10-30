# Changelog

## 0.1.1 — 2026-10-30

- Display provider reasoning, intermediate updates, tool activity, approvals, and stop/resume controls inside the relevant chat response. Reasoning streams independently from the answer, remains attached to its original run, and is preserved after interruption. Servers must actually return supported reasoning text.
- Add opt-in **Smart auto-approve** for public web reads, configured search, exact built-in workspace inspections, and new small text documents. Existing-file overwrites and arbitrary commands still request review. Automatic decisions record their reasons; new-file writes cannot overwrite a file created concurrently.
- Replace inference token number fields with powers-of-two selectors while preserving existing custom values. Context choices extend to 2,097,152 tokens and output choices to 131,072 tokens; output must remain smaller than context.
- Add optional OpenAI-compatible reasoning-effort settings while retaining server-default behavior for existing configurations.
- Remove promotional interface copy and adjust narrow-screen, dialog, approval, composer, and long-content layouts. Narrow windows no longer reopen the activity drawer automatically.

See [validation](docs/VALIDATION.md) for executed checks and verification limits, and [installation](docs/INSTALL.md#update) for update instructions.

## 0.1.0 — 2026-10-30

Initial public release with serial Pi inference, persistent rooms and bot sessions, explicit approvals, proactive automations, notifications, and reviewed candidate skills.
