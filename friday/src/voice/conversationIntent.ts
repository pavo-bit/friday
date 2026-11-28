// ============================================================
// FRIDAY — Centralized Conversation Intent Classifier
// Deterministic classification for greetings, wakes, farewells,
// cancellations, sleep/resume, and follow-up commands.
// ============================================================

export type ConversationIntentType =
  | 'GREETING'
  | 'WAKE'
  | 'NORMAL_COMMAND'
  | 'FOLLOW_UP'
  | 'GOODBYE'
  | 'GOOD_NIGHT'
  | 'CANCEL'
  | 'SLEEP'
  | 'RESUME';

export interface ConversationIntentResult {
  intent: ConversationIntentType;
  confidence: number;
  extractedCommand?: string;
  hasGreetingPrefix: boolean;
  explicitGoodNight: boolean;
  shouldEndConversation: boolean;
}

const GOOD_NIGHT_EXACT_PATTERNS: RegExp[] = [
  /^(?:ok(?:ay)?|alright|thanks|thank\s+you)?[,\s]*(?:good\s*night|goodnight)(?:\s*,?\s*(?:friday|boss))?[.!?\s]*$/i,
  /^(?:friday)[,\s]+(?:good\s*night|goodnight)[.!?\s]*$/i,
];

const GOODBYE_PATTERNS: RegExp[] = [
  /^(?:ok(?:ay)?|alright|well)?[,\s]*(?:goodbye|good\s*bye|bye(?:\s+bye)?|see\s+you(?:\s+later|\s+soon)?|later|ciao)(?:\s*,?\s*(?:friday|boss))?[.!?\s]*$/i,
  /^(?:friday)[,\s]+(?:goodbye|good\s*bye|bye)[.!?\s]*$/i,
  /^(?:thank\s+you|thanks)[,\s]+(?:that'?s\s+(?:all|everything)|you\s+can\s+go\s+to\s+standby)(?:\s+(?:for\s+now|today))?(?:\s*,?\s*friday)?[.!?\s]*$/i,
  /^(?:that'?s\s+all(?:\s+for\s+now)?|that'?s\s+everything(?:\s+for\s+now)?|i'?m\s+done(?:\s+for\s+now)?|end\s+(?:this\s+)?conversation|close\s+(?:this\s+)?conversation|you\s+(?:can|may)\s+go\s+to\s+standby|go\s+to\s+standby|stand\s*by(?:\s+now)?|nothing\s+else(?:\s+for\s+now)?)(?:\s*,?\s*friday)?[.!?\s]*$/i,
];

const CANCEL_PATTERNS: RegExp[] = [
  /^(?:cancel(?:\s+(?:that|this|the)\s+(?:command|request|action|task|operation))?|abort(?:\s+(?:that|this|the)\s+(?:command|request|action))?|never\s*mind|forget\s+it|stop\s+that)(?:\s*,?\s*friday)?[.!?\s]*$/i,
];

const SLEEP_PATTERNS: RegExp[] = [
  /^(?:go\s+to\s+sleep|sleep\s+mode|enter\s+sleep(?:\s+mode)?|friday[,\s]+(?:go\s+to\s+sleep|sleep))(?:\s*,?\s*friday)?[.!?\s]*$/i,
];

const RESUME_PATTERNS: RegExp[] = [
  /^(?:resume|continue|keep\s+going|go\s+ahead|carry\s+on)(?:\s*,?\s*friday)?[.!?\s]*$/i,
];

const WAKE_PREFIX_REGEX =
  /^(?:(?:hey|hello|hi|ok(?:ay)?|wake\s+up)\s*,?\s*friday|friday\s+(?:wake\s+up|listen))[!.,\s]*(.*)$/i;

const GREETING_PREFIX_REGEX =
  /^(?:(?:good\s*(?:morning|afternoon|evening)|hi|hello|hey|greetings|howdy)(?:\s*,?\s*friday)?)[!.,\s]*(.*)$/i;

function normalizeInput(raw: string): string {
  return (raw || '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Classifies a spoken or typed user utterance into a conversation lifecycle intent.
 * Guards against false positives (e.g. "tell Mom good night" or "cancel that command").
 */
export function classifyConversationIntent(
  rawText: string,
  inActiveSession = false
): ConversationIntentResult {
  const normalized = normalizeInput(rawText);
  if (!normalized) {
    return {
      intent: inActiveSession ? 'FOLLOW_UP' : 'NORMAL_COMMAND',
      confidence: 0,
      hasGreetingPrefix: false,
      explicitGoodNight: false,
      shouldEndConversation: false,
    };
  }

  // 1. Explicit CANCEL ("cancel that command", "never mind") — never end conversation
  for (const pattern of CANCEL_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        intent: 'CANCEL',
        confidence: 0.96,
        hasGreetingPrefix: false,
        explicitGoodNight: false,
        shouldEndConversation: false,
      };
    }
  }

  // 2. Explicit SLEEP
  for (const pattern of SLEEP_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        intent: 'SLEEP',
        confidence: 0.96,
        hasGreetingPrefix: false,
        explicitGoodNight: false,
        shouldEndConversation: false,
      };
    }
  }

  // 3. Explicit GOOD_NIGHT farewell (anchored, so "send a good night text to Mom" is NOT matched)
  for (const pattern of GOOD_NIGHT_EXACT_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        intent: 'GOOD_NIGHT',
        confidence: 0.98,
        hasGreetingPrefix: false,
        explicitGoodNight: true,
        shouldEndConversation: true,
      };
    }
  }

  // 4. Explicit GOODBYE / conversation-ending phrases
  for (const pattern of GOODBYE_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        intent: 'GOODBYE',
        confidence: 0.97,
        hasGreetingPrefix: false,
        explicitGoodNight: false,
        shouldEndConversation: true,
      };
    }
  }

  // 5. Explicit RESUME
  for (const pattern of RESUME_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        intent: 'RESUME',
        confidence: 0.92,
        hasGreetingPrefix: false,
        explicitGoodNight: false,
        shouldEndConversation: false,
      };
    }
  }

  // 6. Wake phrase (pure or compound with command)
  const wakeMatch = normalized.match(WAKE_PREFIX_REGEX);
  if (wakeMatch) {
    const remainder = (wakeMatch[1] || '').trim();
    if (!remainder) {
      return {
        intent: 'WAKE',
        confidence: 0.96,
        hasGreetingPrefix: false,
        explicitGoodNight: false,
        shouldEndConversation: false,
      };
    }
    // Check if the remainder itself is a goodbye/cancel/sleep
    const inner = classifyConversationIntent(remainder, inActiveSession);
    if (inner.shouldEndConversation || inner.intent === 'CANCEL' || inner.intent === 'SLEEP') {
      return inner;
    }
    return {
      intent: 'WAKE',
      confidence: 0.94,
      extractedCommand: remainder,
      hasGreetingPrefix: false,
      explicitGoodNight: false,
      shouldEndConversation: false,
    };
  }

  // 7. Greeting prefix (e.g. "Good morning, Friday. Check my reminders.")
  const greetMatch = normalized.match(GREETING_PREFIX_REGEX);
  if (greetMatch) {
    const remainder = (greetMatch[1] || '').trim();
    if (!remainder) {
      return {
        intent: 'GREETING',
        confidence: 0.95,
        hasGreetingPrefix: true,
        explicitGoodNight: false,
        shouldEndConversation: false,
      };
    }
    // Meaningful command follows greeting — do NOT let greeting consume it
    const inner = classifyConversationIntent(remainder, inActiveSession);
    if (inner.shouldEndConversation || inner.intent === 'CANCEL' || inner.intent === 'SLEEP') {
      return inner;
    }
    return {
      intent: inActiveSession ? 'FOLLOW_UP' : 'NORMAL_COMMAND',
      confidence: 0.92,
      extractedCommand: remainder,
      hasGreetingPrefix: true,
      explicitGoodNight: false,
      shouldEndConversation: false,
    };
  }

  // 8. Default: normal command or follow-up in active session
  return {
    intent: inActiveSession ? 'FOLLOW_UP' : 'NORMAL_COMMAND',
    confidence: 0.85,
    extractedCommand: normalized,
    hasGreetingPrefix: false,
    explicitGoodNight: false,
    shouldEndConversation: false,
  };
}
