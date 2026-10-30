import type { ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';
import type { ModelSettings } from '../../shared/types.js';

/** Preserve the selected provider value. Never silently lower xhigh/max to high. */
export function reasoningConfiguration(settings: ModelSettings): {
  enabled: boolean;
  thinkingLevel: ModelThinkingLevel;
  thinkingLevelMap?: ThinkingLevelMap;
} {
  if (settings.reasoningMode !== 'openai') return { enabled: false, thinkingLevel: 'off' };
  const effort = settings.reasoningEffort ?? 'medium';
  return {
    enabled: true,
    thinkingLevel: effort === 'none' ? 'off' : effort === 'ultra' ? 'max' : effort,
    thinkingLevelMap: {
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      // Ultra is an explicit server extension, not a universal OpenAI API value.
      max: effort === 'ultra' ? 'ultra' : 'max',
    },
  };
}
