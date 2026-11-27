// ============================================================
// FRIDAY — Request Understanding Engine
// Converts natural-language input into structured AssistantRequest
// ============================================================

import { v4 as uuidv4 } from 'uuid';

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

    return {
      requestId: uuidv4(),
      conversationId,
      actorId: params.actorId,
      rawInput,
      normalizedInput,
      intent,
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
}

let _reqEngine: RequestUnderstandingEngine | null = null;
export function getRequestUnderstandingEngine(): RequestUnderstandingEngine {
  if (!_reqEngine) {
    _reqEngine = new RequestUnderstandingEngine();
  }
  return _reqEngine;
}
