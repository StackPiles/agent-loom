import {
  getCurrentSystemMessage,
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
  return normalizeContext({
    messages: [
      {
        role: 'system',
        // Pi replaces named prompt sections, but preserves legacy/raw system
        // content. Adding another normalized system prompt would duplicate the
        // old sections instead of reflecting that replacement.
        content: current?.content ?? '',
        sections: { loom_upcoming_prompt: session.systemPrompt },
        ...(tools.length ? { toolsAdded: tools } : {}),
        timestamp,
      },
      // Loom's OpenAI-compatible transport collapses system updates and uses
      // only current declarations. Historical tool calls/results remain intact.
      ...messages.filter((message) => message.role !== 'system'),
    ],
  });
}
