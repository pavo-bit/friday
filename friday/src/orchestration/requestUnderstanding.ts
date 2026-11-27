// ============================================================
// FRIDAY — Request Understanding Engine
// Converts natural-language input into structured AssistantRequest
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import {
  ConversationalCategory,
  PersonalityMode,
  ResponseDepthMode,
} from '../personality/personalityTypes';

export type ExecutiveIntentKind =
  | 'greeting'
  | 'farewell'
  | 'knowledge_question'
  | 'follow_up'
  | 'task_resume'
  | 'capability_action'
  | 'compound_action'
  | 'clarification_response';

export interface AssistantRequest {
  requestId: string;
  conversationId: string;
  actorId: string;
  rawInput: string;
  normalizedInput: string;
  intent: ExecutiveIntentKind;
  conversationalCategory: ConversationalCategory;
  complexity: 'simple' | 'moderate' | 'complex';
  explicitPersonalityOverride?: PersonalityMode;
  explicitDepthOverride?: ResponseDepthMode;
  persistOverride?: boolean;
  subIntents: string[];
  entities: {
    symbols: string[];
    urls: string[];
    timeReferences: string[];
    amounts: string[];
  };
  constraints: string[];
  references: string[];
  missingInformation: string[];
  ambiguity: string[];
  confidence: number;
  requiresExecution: boolean;
  createdAt: string;
}

const GREETING_RE =
  /^(?:(?:hi|hello|hey|good\s*(?:morning|afternoon|evening|night)|yo|greetings)(?:\s*,?\s*friday)?[!.,\s]*)(.*)$/i;

const FAREWELL_RE = /^(bye|goodbye|see\s*you|good\s*night)\b/i;

const KNOWLEDGE_RE =
  /^(?:explain|what\s+is|how\s+does|why\s+does|define|tell\s+me\s+about)\b/i;

const FOLLOW_UP_RE =
  /\b(do\s+that\s+again|show\s+me\s+more\s+details|compare\s+(?:it|that)|use\s+the\s+(?:first|second|third)\s+option|which\s+(?:category|setup)|what\s+happened\s+to\s+that)\b/i;

const RESUME_TASK_RE = /\b(continue\s+(?:the\s+)?previous\s+task|resume\s+(?:the\s+)?task)\b/i;

export class RequestUnderstandingEngine {
  understand(params: {
    rawInput: string;
    actorId: string;
    conversationId?: string;
    hasPendingClarification?: boolean;
  }): AssistantRequest {
    const rawInput = params.rawInput.trim();
    const normalizedInput = rawInput.replace(/\s+/g, ' ').trim();
    const conversationId = params.conversationId || 'default';

    // Extract entities deterministically
    const urls = Array.from(normalizedInput.matchAll(/https?:\/\/\S+/gi)).map((m) => m[0]);
    const symbols = Array.from(normalizedInput.matchAll(/\b[A-Z]{2,12}\b/g))
      .map((m) => m[0])
      .filter((s) => !new Set(['FRIDAY', 'NSE', 'BSE', 'INR', 'USD', 'VWAP', 'RSI', 'MACD', 'EMA']).has(s));
    const timeReferences = Array.from(
      normalizedInput.matchAll(/\b(today|yesterday|this\s+month|last\s+month|this\s+week|5m|15m|1h)\b/gi)
    ).map((m) => m[0].toLowerCase());
    const amounts = Array.from(normalizedInput.matchAll(/(?:₹|rs\.?|inr|\$)\s*\d+(?:,\d+)*(?:\.\d+)?/gi)).map(
      (m) => m[0]
    );

    const references: string[] = [];
    const missingInformation: string[] = [];
    const ambiguity: string[] = [];
    const constraints: string[] = [];

    if (/\b(only|without|except|must\s+not|do\s+not)\b/i.test(normalizedInput)) {
      constraints.push(normalizedInput);
    }

    // Ambiguity / missing-info checks for underspecified references
    if (/\b(send|email|message)\s+(him|her|them)\b/i.test(normalizedInput)) {
      references.push('recipient_pronoun');
      missingInformation.push('recipient');
      ambiguity.push('Recipient pronoun ("him/her/them") is unresolved.');
    }
    if (/\b(the\s+report|that\s+report)\b/i.test(normalizedInput) && /\bsend\b/i.test(normalizedInput)) {
      references.push('report_reference');
      missingInformation.push('report');
    }
    if (/\b(analyze|check)\s+(that|this)\s+stock\b/i.test(normalizedInput) && symbols.length === 0) {
      references.push('stock_reference');
      missingInformation.push('symbol');
    }
    if (/\bdelete\s+(?:the\s+)?old\s+files\b/i.test(normalizedInput)) {
      missingInformation.push('target_path');
      ambiguity.push('Target directory and file criteria are unspecified.');
    }
    if (/\bmove\s+(?:the\s+)?meeting\b/i.test(normalizedInput)) {
      missingInformation.push('new_datetime');
    }

    let intent: ExecutiveIntentKind = 'capability_action';
    let requiresExecution = true;
    let confidence = 0.85;
    let subIntents: string[] = [normalizedInput];

    const greetMatch = normalizedInput.match(GREETING_RE);
    if (params.hasPendingClarification) {
      intent = 'clarification_response';
      confidence = 0.92;
    } else if (greetMatch && (!(greetMatch[1] || '').trim() || (greetMatch[1] || '').trim().length < 3)) {
      intent = 'greeting';
      requiresExecution = false;
      confidence = 0.98;
      subIntents = [];
    } else if (FAREWELL_RE.test(normalizedInput) && normalizedInput.length < 40) {
      intent = 'farewell';
      requiresExecution = false;
      confidence = 0.95;
      subIntents = [];
    } else if (RESUME_TASK_RE.test(normalizedInput)) {
      intent = 'task_resume';
      references.push('previous_task');
      confidence = 0.9;
    } else if (FOLLOW_UP_RE.test(normalizedInput)) {
      intent = 'follow_up';
      references.push('prior_result');
      confidence = 0.9;
    } else if (
      KNOWLEDGE_RE.test(normalizedInput) &&
      !/\b(my\s+|check\s+|show\s+my|analyze\s+my|spend|cash\s*flow|budget|portfolio|watchlist|server|reminder)\b/i.test(
        normalizedInput
      )
    ) {
      intent = 'knowledge_question';
      requiresExecution = false;
      confidence = 0.9;
    } else {
      const clauses = normalizedInput
        .split(/\s*(?:,|;|\band\s+then\b|\bthen\b|\band\b)\s*/i)
        .map((c) => c.trim())
        .filter((c) => c.length > 2);
      if (clauses.length > 1) {
        intent = 'compound_action';
        subIntents = clauses;
      }
    }

    // Phase 13: Explicit personality & depth override extraction + conversational classification
    const explicitPersonalityOverride = this.detectPersonalityOverride(normalizedInput);
    const explicitDepthOverride = this.detectDepthOverride(normalizedInput);
    const persistOverride = /\b(always|from\s+now\s+on|set\s+(?:as\s+)?my\s+default|permanently)\b/i.test(
      normalizedInput
    );

    const conversationalCategory = this.classifyConversationalCategory(
      normalizedInput,
      intent,
      urls.length > 0
    );

    // Non-execution conversational categories should route through conversational LLM / Digital Identity
    if (
      intent === 'capability_action' &&
      (conversationalCategory === 'personal_discussion' ||
        conversationalCategory === 'casual_conversation' ||
        conversationalCategory === 'emotional_support' ||
        conversationalCategory === 'creative_request' ||
        conversationalCategory === 'learning_request') &&
      !/\b(check|show|list|run|open|send|create|delete|analyze|scan|backtest|watch|monitor|remind|alarm)\b/i.test(
        normalizedInput
      )
    ) {
      intent = 'knowledge_question';
      requiresExecution = false;
    }

    const complexity = this.assessComplexity(normalizedInput, conversationalCategory);

    return {
      requestId: uuidv4(),
      conversationId,
      actorId: params.actorId,
      rawInput,
      normalizedInput,
      intent,
      conversationalCategory,
      complexity,
      explicitPersonalityOverride,
      explicitDepthOverride,
      persistOverride: explicitPersonalityOverride || explicitDepthOverride ? persistOverride : undefined,
      subIntents,
      entities: { symbols, urls, timeReferences, amounts },
      constraints,
      references,
      missingInformation,
      ambiguity,
      confidence,
      requiresExecution,
      createdAt: new Date().toISOString(),
    };
  }

  private detectPersonalityOverride(text: string): PersonalityMode | undefined {
    const lower = text.toLowerCase();
    if (/\b(reset\s+personality|adaptive\s+mode|back\s+to\s+adaptive)\b/i.test(lower)) return 'ADAPTIVE';
    if (/\b(like\s+a\s+teacher|teach\s+me|tutor\s+me|be\s+my\s+teacher|teacher\s+mode)\b/i.test(lower)) {
      return 'TEACHER';
    }
    if (/\b(like\s+a\s+friend|talk\s+casually|be\s+casual|be\s+brutally\s+honest|friend\s+mode)\b/i.test(lower)) {
      return 'FRIEND';
    }
    if (/\b(be\s+more\s+professional|professional\s+mode|formal\s+assistant)\b/i.test(lower)) {
      return 'PROFESSIONAL_ASSISTANT';
    }
    if (/\b(expert[\s-]level|like\s+an\s+expert|technical\s+expert|like\s+a\s+senior\s+engineer)\b/i.test(lower)) {
      return 'TECHNICAL_EXPERT';
    }
    if (/\b(let'?s\s+just\s+talk|just\s+chat|companion\s+mode)\b/i.test(lower)) {
      return 'COMPANION';
    }
    return undefined;
  }

  private detectDepthOverride(text: string): ResponseDepthMode | undefined {
    const lower = text.toLowerCase();
    if (/\b(keep\s+it\s+short|be\s+concise|in\s+short|briefly|tldr|tl;dr|one\s+line)\b/i.test(lower)) {
      return 'CONCISE';
    }
    if (/\b(explain\s+everything\s+step\s+by\s+step|step\s+by\s+step|in\s+detail|deep\s+dive|comprehensive|for\s+my\s+exam(?:ination)?)\b/i.test(lower)) {
      return 'DETAILED';
    }
    if (/\b(balanced\s+detail|moderate\s+detail)\b/i.test(lower)) {
      return 'BALANCED';
    }
    return undefined;
  }

  private classifyConversationalCategory(
    text: string,
    intent: ExecutiveIntentKind,
    hasUrl: boolean
  ): ConversationalCategory {
    const lower = text.toLowerCase();
    if (intent === 'follow_up') return 'follow_up';
    if (intent === 'clarification_response') return 'clarification';

    if (/\b(stressed|overwhelmed|anxious|burned\s+out|feeling\s+down|frustrated|exhausted)\b/i.test(lower)) {
      return 'emotional_support';
    }
    if (/\b(let'?s\s+talk|how\s+are\s+you|just\s+chatting|what'?s\s+up|tell\s+me\s+a\s+joke)\b/i.test(lower)) {
      return 'casual_conversation';
    }
    if (
      /\b(career\s+path|confused\s+about|which\s+path|should\s+i\s+choose|life\s+decision|what\s+do\s+you\s+think\s+i\s+should|personal\s+advice)\b/i.test(
        lower
      )
    ) {
      return 'personal_discussion';
    }
    if (
      /\b(review\s+my\s+backend|architecture|code\s+review|refactor|trade[\s-]offs?|implementation\s+in\s+detail|bug|stack\s+trace|memory\s+leak|latency|concurrency|deadlock)\b/i.test(
        lower
      )
    ) {
      return 'technical_problem';
    }
    if (
      /\b(teach\s+me|explain|what\s+is\s+|how\s+does|learn|study|for\s+my\s+exam|practice\s+questions|beginner)\b/i.test(
        lower
      )
    ) {
      return 'learning_request';
    }
    if (hasUrl || /\b(inspect\s+this\s+website|research|investigate|compare\s+options)\b/i.test(lower)) {
      return 'research_request';
    }
    if (/\b(brainstorm|write\s+a\s+|creative|poem|story|tagline|slogan)\b/i.test(lower)) {
      return 'creative_request';
    }
    if (intent === 'knowledge_question') {
      return 'general_question';
    }
    return 'task_execution';
  }

  private assessComplexity(
    text: string,
    category: ConversationalCategory
  ): 'simple' | 'moderate' | 'complex' {
    const wordCount = text.split(/\s+/).length;
    if (
      category === 'technical_problem' ||
      /\b(in\s+detail|architecture|implementation|trade[\s-]offs?|step\s+by\s+step|comprehensive|compare)\b/i.test(
        text
      ) ||
      wordCount >= 18
    ) {
      return 'complex';
    }
    if (wordCount <= 6 && (category === 'casual_conversation' || category === 'general_question')) {
      return 'simple';
    }
    return 'moderate';
  }
}

let _reqEngine: RequestUnderstandingEngine | null = null;
export function getRequestUnderstandingEngine(): RequestUnderstandingEngine {
  if (!_reqEngine) {
    _reqEngine = new RequestUnderstandingEngine();
  }
  return _reqEngine;
}
