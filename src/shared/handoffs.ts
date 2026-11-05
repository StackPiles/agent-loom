/** null means unlimited; zero disables bot-to-bot requests. */
export type HandoffLimit = number | null;
export const DEFAULT_HANDOFF_LIMIT: HandoffLimit = null;
export const MAX_HANDOFF_LIMIT = 10_000;
