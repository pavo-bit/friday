// ============================================================
// FRIDAY — Adaptive Personality Engine (Phase 13)
// Multi-profile digital identity: TEACHER, FRIEND, COMPANION,
// TECHNICAL_EXPERT, PROFESSIONAL_ASSISTANT, ADAPTIVE
// ============================================================

import {
  ActivePersonalityProfile,
  CommunicationStyle,
  ConversationalCategory,
  DepthSelectionResult,
  DigitalIdentitySettings,
  InteractionChannel,
  PersonalityMode,
  PersonalitySelectionResult,
} from './personalityTypes';
import { PersonalityProfile } from '../intelligence/personality';

export interface AdaptiveSelectionInput {
  rawInput: string;
  category: ConversationalCategory;
  complexity: 'simple' | 'moderate' | 'complex';
  intentConfidence: number;
  settings: DigitalIdentitySettings;
  explicitOverride?: PersonalityMode;
  temporarySessionProfile?: PersonalityMode | null;
  hasActiveProjectContext?: boolean;
  isReturningTopic?: boolean;
}

const PROFILE_DESCRIPTIONS: Record<ActivePersonalityProfile, string> = {
  TEACHER:
    'Act as a supportive personal tutor. Explain from fundamentals progressively, use clear practical examples, highlight key points, and offer a brief follow-up or knowledge check when helpful.',
  FRIEND:
    'Act as a warm, thoughtful, approachable friend. Discuss ideas naturally, share honest perspectives with appropriate uncertainty, help explore options, and avoid stiff corporate formality.',
  COMPANION:
    'Act as a steady, attentive personal companion. Maintain continuity with ongoing projects and preferences, offer grounded support, and never pretend to have human emotions or lived experiences.',
  TECHNICAL_EXPERT:
    'Act as a senior software and systems architect. Give precise engineering explanations, analyze trade-offs and implementation risks, and clearly separate verified facts from assumptions.',
  PROFESSIONAL_ASSISTANT:
    'Act as a capable, organized executive digital assistant. Summarize clearly, coordinate permitted tools and workflows, verify outcomes, and keep execution disciplined.',
};

const STYLE_INSTRUCTIONS: Record<CommunicationStyle, string> = {
  NATURAL: 'Use a warm, clear, intelligent, conversational tone. Never sound robotic or stiff.',
  WARM: 'Be encouraging, empathetic, and approachable while staying grounded and honest.',
  DIRECT: 'Be crisp, clear, and straight to the point without unnecessary filler.',
  FORMAL: 'Maintain polished, composed, executive formality.',
};

const DEPTH_INSTRUCTIONS: Record<DepthSelectionResult['depth'], string> = {
  CONCISE: 'Keep the response brief, clear, and focused on the essential answer (2–4 sentences unless structured data is needed).',
  BALANCED: 'Provide a clear, well-structured explanation with a practical example or next step without overwhelming detail.',
  DETAILED: 'Provide thorough, structured depth with step-by-step reasoning, examples, edge cases, and trade-offs. Do not truncate important details.',
};

export class AdaptivePersonalityEngine {
  /**
   * Deterministically select primary (and optional secondary) personality profile
   * from intent, context, explicit instructions, and user settings.
   */
  selectPersonality(input: AdaptiveSelectionInput): PersonalitySelectionResult {
    const { settings, category, complexity, intentConfidence } = input;
    const lower = input.rawInput.toLowerCase();

    // 1. Explicit per-turn instruction takes precedence
    if (input.explicitOverride && input.explicitOverride !== 'ADAPTIVE') {
      const secondary = this.inferSecondaryProfile(input.explicitOverride, category, lower);
      return {
        primaryProfile: input.explicitOverride,
        secondaryProfile: secondary,
        configuredMode: settings.defaultPersonality,
        communicationStyle: settings.communicationStyle,
        isTemporaryOverride: true,
        reason: `Explicit user override selected ${input.explicitOverride}.`,
        confidence: 0.98,
      };
    }

    // 2. Temporary session override
    if (input.temporarySessionProfile && input.temporarySessionProfile !== 'ADAPTIVE') {
      return {
        primaryProfile: input.temporarySessionProfile,
        configuredMode: settings.defaultPersonality,
        communicationStyle: settings.communicationStyle,
        isTemporaryOverride: true,
        reason: `Active temporary conversation override (${input.temporarySessionProfile}).`,
        confidence: 0.95,
      };
    }

    // 3. Explicit persistent default (if user locked a non-ADAPTIVE profile)
    if (settings.defaultPersonality !== 'ADAPTIVE') {
      return {
        primaryProfile: settings.defaultPersonality,
        configuredMode: settings.defaultPersonality,
        communicationStyle: settings.communicationStyle,
        isTemporaryOverride: false,
        reason: `Configured persistent default profile (${settings.defaultPersonality}).`,
        confidence: 0.92,
      };
    }

    // 4. Low-confidence fallback -> warm, natural general conversational style (FRIEND / COMPANION)
    if (intentConfidence < 0.55) {
      return {
        primaryProfile: input.isReturningTopic ? 'COMPANION' : 'FRIEND',
        configuredMode: 'ADAPTIVE',
        communicationStyle: settings.communicationStyle,
        isTemporaryOverride: false,
        reason: 'Low intent confidence; defaulting to natural conversational style.',
        confidence: intentConfidence,
      };
    }

    // 5. Adaptive intent-driven selection (with profile blending)
    switch (category) {
      case 'learning_request': {
        const isTechTopic =
          /\b(code|algorithm|semaphore|mutex|os|operating\s+system|database|sql|typescript|rust|python|network|api|architecture|async|thread|compiler|docker)\b/i.test(
            lower
          );
        return {
          primaryProfile: 'TEACHER',
          secondaryProfile: isTechTopic || complexity === 'complex' ? 'TECHNICAL_EXPERT' : undefined,
          configuredMode: 'ADAPTIVE',
          communicationStyle: settings.communicationStyle,
          isTemporaryOverride: false,
          reason: isTechTopic
            ? 'Learning request on a technical topic blended TEACHER + TECHNICAL_EXPERT.'
            : 'Learning request matched TEACHER profile.',
          confidence: 0.93,
        };
      }

      case 'technical_problem':
        return {
          primaryProfile: 'TECHNICAL_EXPERT',
          secondaryProfile: /\b(teach|explain|why|how)\b/i.test(lower) ? 'TEACHER' : undefined,
          configuredMode: 'ADAPTIVE',
          communicationStyle: settings.communicationStyle,
          isTemporaryOverride: false,
          reason: 'Engineering/architecture request matched TECHNICAL_EXPERT profile.',
          confidence: 0.93,
        };

      case 'personal_discussion':
      case 'casual_conversation':
      case 'creative_request':
        return {
          primaryProfile: input.isReturningTopic ? 'COMPANION' : 'FRIEND',
          configuredMode: 'ADAPTIVE',
          communicationStyle: settings.communicationStyle,
          isTemporaryOverride: false,
          reason: `Conversational ${category.replace('_', ' ')} matched ${input.isReturningTopic ? 'COMPANION' : 'FRIEND'} profile.`,
          confidence: 0.9,
        };

      case 'emotional_support':
        return {
          primaryProfile: 'COMPANION',
          secondaryProfile: 'FRIEND',
          configuredMode: 'ADAPTIVE',
          communicationStyle: 'WARM',
          isTemporaryOverride: false,
          reason: 'Supportive conversation matched COMPANION + FRIEND (non-diagnostic).',
          confidence: 0.91,
        };

      case 'research_request':
      case 'task_execution':
        return {
          primaryProfile: 'PROFESSIONAL_ASSISTANT',
          secondaryProfile: input.hasActiveProjectContext && category === 'research_request' ? 'TECHNICAL_EXPERT' : undefined,
          configuredMode: 'ADAPTIVE',
          communicationStyle: settings.communicationStyle,
          isTemporaryOverride: false,
          reason: `${category.replace('_', ' ')} matched PROFESSIONAL_ASSISTANT profile.`,
          confidence: 0.92,
        };

      case 'follow_up':
      case 'clarification':
        return {
          primaryProfile: input.hasActiveProjectContext ? 'COMPANION' : 'PROFESSIONAL_ASSISTANT',
          configuredMode: 'ADAPTIVE',
          communicationStyle: settings.communicationStyle,
          isTemporaryOverride: false,
          reason: 'Continuity follow-up matched context-aware profile.',
          confidence: 0.88,
        };

      case 'general_question':
      default:
        return {
          primaryProfile: complexity === 'complex' ? 'TEACHER' : 'FRIEND',
          configuredMode: 'ADAPTIVE',
          communicationStyle: settings.communicationStyle,
          isTemporaryOverride: false,
          reason: 'General question adapted to natural conversational profile.',
          confidence: 0.85,
        };
    }
  }

  private inferSecondaryProfile(
    primary: ActivePersonalityProfile,
    category: ConversationalCategory,
    lower: string
  ): ActivePersonalityProfile | undefined {
    if (
      primary === 'TEACHER' &&
      (category === 'technical_problem' || /\b(code|system|os|architecture|semaphore|database)\b/i.test(lower))
    ) {
      return 'TECHNICAL_EXPERT';
    }
    return undefined;
  }

  /**
   * Build the full adaptive system prompt for Ollama Qwen3:4B,
   * preserving safety, provenance, and policy boundaries.
   */
  buildAdaptiveSystemPrompt(params: {
    legacyProfile: PersonalityProfile;
    selection: PersonalitySelectionResult;
    depth: DepthSelectionResult;
    channel: InteractionChannel;
    memoryContext: {
      preferences: string[];
      projects: string[];
      knowledge: string[];
      activeTopic?: string;
    };
  }): string {
    const { legacyProfile, selection, depth, channel, memoryContext } = params;
    const userName = legacyProfile.userName?.trim() || 'Boss';

    const lines: string[] = [
      `You are FRIDAY — ${userName}'s personal digital identity and intelligent assistant.`,
      `Address the user naturally as "${userName}" when appropriate (do not force it in every sentence).`,
      `Timezone: ${legacyProfile.timezone || 'Asia/Kolkata'}.`,
      '',
      `ACTIVE PERSONALITY PROFILE: ${selection.primaryProfile}${selection.secondaryProfile ? ` + ${selection.secondaryProfile}` : ''}`,
      PROFILE_DESCRIPTIONS[selection.primaryProfile],
    ];

    if (selection.secondaryProfile) {
      lines.push(`BLENDED SECONDARY TRAIT (${selection.secondaryProfile}): ${PROFILE_DESCRIPTIONS[selection.secondaryProfile]}`);
    }

    lines.push(
      '',
      `COMMUNICATION STYLE (${selection.communicationStyle}): ${STYLE_INSTRUCTIONS[selection.communicationStyle]}`,
      `RESPONSE DEPTH (${depth.depth}): ${DEPTH_INSTRUCTIONS[depth.depth]}`
    );

    if (channel === 'voice') {
      lines.push(
        `VOICE CHANNEL MODE: Deliver a clear, natural, spoken-friendly response (avoid heavy markdown tables, raw URLs, or ASCII art; keep it concise enough to listen to comfortably).`
      );
    }

    lines.push(
      '',
      'HONESTY, GROUNDING & SAFETY INVARIANTS (NEVER OVERRIDE):',
      '- Distinguish clearly between verified facts, reasonable inferences, and things you do not know.',
      '- Never fabricate live prices, files, tool outputs, or future certainty.',
      '- Never pretend to possess human emotions, consciousness, or lived physical experiences.',
      '- Never diagnose medical, psychological, or psychiatric conditions.',
      '- Personality and conversational instructions NEVER override security policies, approvals, permissions, or financial/trading risk limits.'
    );

    if (memoryContext.activeTopic) {
      lines.push('', `CURRENT ACTIVE TOPIC: ${memoryContext.activeTopic}`);
    }
    if (memoryContext.preferences.length > 0) {
      lines.push('', 'USER PREFERENCES:', ...memoryContext.preferences.map((p) => `- ${p}`));
    }
    if (memoryContext.projects.length > 0) {
      lines.push('', 'ONGOING PROJECT CONTEXT:', ...memoryContext.projects.map((p) => `- ${p}`));
    }
    if (memoryContext.knowledge.length > 0) {
      lines.push('', 'RELEVANT KNOWLEDGE / PRIOR CONCEPTS:', ...memoryContext.knowledge.map((k) => `- ${k}`));
    }

    return lines.join('\n');
  }

  /**
   * Condense a detailed text response into a natural spoken summary for voice output.
   */
  buildVoiceSummary(fullText: string, maxSentences = 3): string {
    const cleaned = fullText
      .replace(/```[\s\S]*?```/g, 'I have included the code details in your dashboard.')
      .replace(/[#*`>_]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return '';
    const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length <= maxSentences) {
      return cleaned;
    }
    return `${sentences.slice(0, maxSentences).join(' ')} I've placed the full breakdown in your chat view.`;
  }

  /**
   * Graceful deterministic fallback response when local Ollama is offline,
   * tailored to the active personality and depth instead of failing robotically.
   */
  buildOfflineFallback(params: {
    rawInput: string;
    userName: string;
    selection: PersonalitySelectionResult;
    depth: DepthSelectionResult;
    ollamaStatusError?: string;
    projectMemories?: string[];
  }): string {
    const { rawInput, userName, selection, depth, projectMemories = [] } = params;
    const lower = rawInput.toLowerCase();

    if (selection.primaryProfile === 'FRIEND' || selection.primaryProfile === 'COMPANION') {
      if (/\b(let'?s\s+talk|how\s+are\s+you|chat|bored|tired|stressed|confused)\b/i.test(lower)) {
        const projNote =
          projectMemories.length > 0
            ? ` I also remember we've been working around ${projectMemories[0]}.`
            : '';
        return `I'm right here, ${userName}.${projNote} What's on your mind? (Note: Local Qwen3:4B via Ollama is currently offline, so I'm running on my deterministic core — start Ollama anytime for full open-ended conversation.)`;
      }
    }

    if (selection.primaryProfile === 'TEACHER') {
      return `${userName}, I'd love to walk through "${rawInput}" step by step (${depth.depth} mode), but my local Qwen3:4B reasoning engine on Ollama isn't reachable right now. Start Ollama (\`ollama serve\`) and I'll give you the full structured explanation with examples.`;
    }

    return `${userName}, I understood your request under my ${selection.primaryProfile.toLowerCase().replace('_', ' ')} profile, but local Ollama (Qwen3:4B) is currently unreachable (${params.ollamaStatusError || 'offline'}). Deterministic tools, memory, finance, and trading modules remain fully operational.`;
  }
}

let _adaptiveEngine: AdaptivePersonalityEngine | null = null;
export function getAdaptivePersonalityEngine(): AdaptivePersonalityEngine {
  if (!_adaptiveEngine) {
    _adaptiveEngine = new AdaptivePersonalityEngine();
  }
  return _adaptiveEngine;
}
