import {
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  getToolStateChanges,
  normalizeContext,
  toToolDeclaration,
  type Message,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

type UpcomingSession = Pick<
  AgentSession,
  'systemPrompt' | 'getActiveToolNames' | 'getToolDefinition'
>;

/**
 * Preview Loom's next prompt for compaction measurement before Pi has persisted
 * its prompt/tool update. This is never written to the session or sent instead
 * of Pi's canonical transcript.
 */
export function projectUpcomingSessionContext(
  session: UpcomingSession,
  messages: Message[],
): TranscriptContext {
  const current = getCurrentSystemMessage(messages);
  const declared = session.getActiveToolNames().map((name) => {
    const definition = session.getToolDefinition(name);
    if (!definition)
      throw new Error(
        'An active tool definition is missing; the upcoming context cannot be measured.',
      );
    return toToolDeclaration(definition);
  });
  // Pi applies removals/redefinitions to the existing declaration map. Replaying
  // that same delta keeps unchanged-tool ordering as well as the latest schemas.
  const changes = getToolStateChanges(current?.toolsAdded ?? [], declared);
  const timestamp = Date.now();
  const toolUpdate: Message = { role: 'system', content: '', ...changes, timestamp };
  const tools = getCurrentTools([...(current ? [current] : []), toolUpdate]);
  const upcoming: Message = {
    role: 'system',
    // Pi replaces named prompt sections, but preserves legacy/raw system
    // content. Adding another normalized system prompt would duplicate the
    // old sections instead of reflecting that replacement.
    content: current?.content ?? '',
    sections: { loom_upcoming_prompt: session.systemPrompt },
    ...(tools.length ? { toolsAdded: tools } : {}),
    timestamp,
  };
  if (
    current &&
    getCurrentSystemPrompt([upcoming]) === getCurrentSystemPrompt([current]) &&
    JSON.stringify(tools) === JSON.stringify(current.toolsAdded ?? [])
  ) {
    // A preview alone must not invalidate the preceding response's usage.
    // Keep the newest real delta's time: getCurrentSystemMessage itself uses
    // the first system message's timestamp, which could hide a later change.
    upcoming.timestamp = messages.reduce(
      (latest, message) =>
        message.role === 'system' ? Math.max(latest, message.timestamp) : latest,
      current.timestamp,
    );
  }
  return normalizeContext({
    messages: [
      upcoming,
      // Loom's OpenAI-compatible transport collapses system updates and uses
      // only current declarations. Historical tool calls/results remain intact.
      ...messages.filter((message) => message.role !== 'system'),
    ],
  });
}
