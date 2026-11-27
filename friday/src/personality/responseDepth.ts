// ============================================================
// FRIDAY — Adaptive Response Depth Selector
// Determines CONCISE | BALANCED | DETAILED response depth
// ============================================================

import {
  ConversationalCategory,
  DepthSelectionResult,
  InteractionChannel,
  ResponseDepthMode,
} from './personalityTypes';

export interface DepthSelectionInput {
  rawInput: string;
  category: ConversationalCategory;
  complexity: 'simple' | 'moderate' | 'complex';
  configuredDetail: ResponseDepthMode;
  explicitDepthOverride?: ResponseDepthMode;
  temporarySessionDepth?: ResponseDepthMode | null;
  channel?: InteractionChannel;
}

export function selectResponseDepth(input: DepthSelectionInput): DepthSelectionResult {
  // 1. Explicit per-turn instruction always takes top priority
  if (input.explicitDepthOverride && input.explicitDepthOverride !== 'ADAPTIVE') {
    return {
      depth: input.explicitDepthOverride,
      configuredMode: input.configuredDetail,
      isTemporaryOverride: true,
      reason: `Explicit user instruction requested ${input.explicitDepthOverride} detail.`,
      maxVoiceSentences: input.explicitDepthOverride === 'CONCISE' ? 2 : 4,
    };
  }

  // 2. Temporary session override
  if (input.temporarySessionDepth && input.temporarySessionDepth !== 'ADAPTIVE') {
    return {
      depth: input.temporarySessionDepth,
      configuredMode: input.configuredDetail,
      isTemporaryOverride: true,
      reason: `Active session depth override (${input.temporarySessionDepth}).`,
      maxVoiceSentences: input.temporarySessionDepth === 'CONCISE' ? 2 : 4,
    };
  }

  // 3. Explicit persistent user setting (when not ADAPTIVE)
  if (input.configuredDetail !== 'ADAPTIVE') {
    return {
      depth: input.configuredDetail,
      configuredMode: input.configuredDetail,
      isTemporaryOverride: false,
      reason: `User configured default answer detail (${input.configuredDetail}).`,
      maxVoiceSentences: input.configuredDetail === 'CONCISE' ? 2 : 4,
    };
  }

  // 4. Adaptive selection based on intent, complexity, and cues
  const lower = input.rawInput.toLowerCase();

  // Explicit depth phrases in natural text
  if (
    /\b(in\s+detail|deep\s+dive|step\s+by\s+step|comprehensive|thorough|architecture|implementation|edge\s+cases|for\s+my\s+exam(?:ination)?|pseudocode)\b/i.test(
      lower
    )
  ) {
    return {
      depth: 'DETAILED',
      configuredMode: 'ADAPTIVE',
      isTemporaryOverride: false,
      reason: 'Detailed depth inferred from deep-dive / exam / implementation cues.',
      maxVoiceSentences: 4,
    };
  }

  if (
    /\b(briefly|in\s+short|tldr|tl;dr|quick\s+summary|one\s+line|short\s+answer)\b/i.test(lower)
  ) {
    return {
      depth: 'CONCISE',
      configuredMode: 'ADAPTIVE',
      isTemporaryOverride: false,
      reason: 'Concise depth inferred from brevity cues.',
      maxVoiceSentences: 2,
    };
  }

  // Voice channel prefers concise responses for casual/simple queries unless detailed was asked
  if (input.channel === 'voice' && input.complexity === 'simple') {
    return {
      depth: 'CONCISE',
      configuredMode: 'ADAPTIVE',
      isTemporaryOverride: false,
      reason: 'Voice channel simple query adapted to concise conversational delivery.',
      maxVoiceSentences: 2,
    };
  }

  if (input.complexity === 'complex' || input.category === 'technical_problem') {
    return {
      depth: 'DETAILED',
      configuredMode: 'ADAPTIVE',
      isTemporaryOverride: false,
      reason: 'Detailed depth selected for complex / technical inquiry.',
      maxVoiceSentences: 4,
    };
  }

  if (
    input.category === 'learning_request' ||
    input.category === 'research_request' ||
    input.category === 'personal_discussion'
  ) {
    return {
      depth: 'BALANCED',
      configuredMode: 'ADAPTIVE',
      isTemporaryOverride: false,
      reason: `Balanced depth selected for ${input.category.replace('_', ' ')}.`,
      maxVoiceSentences: 3,
    };
  }

  if (input.category === 'casual_conversation' || input.category === 'task_execution') {
    return {
      depth: 'CONCISE',
      configuredMode: 'ADAPTIVE',
      isTemporaryOverride: false,
      reason: `Concise depth selected for ${input.category.replace('_', ' ')}.`,
      maxVoiceSentences: 2,
    };
  }

  return {
    depth: 'BALANCED',
    configuredMode: 'ADAPTIVE',
    isTemporaryOverride: false,
    reason: 'Default adaptive balanced depth.',
    maxVoiceSentences: 3,
  };
}
