// ============================================================
// FRIDAY — Intent Parser
// Converts raw user text into structured Intent objects.
// Uses pattern matching for fast common cases + LLM fallback.
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { createLayerLogger } from '../shared/logger';
import { getConfig } from '../shared/config';
import { Intent, ActionType, RiskLevel } from '../shared/types';

const log = createLayerLogger('IntentParser');

/** A pattern rule for fast intent classification */
interface PatternRule {
  action: ActionType;
  patterns: RegExp[];
  /** Named groups to extract from the regex match */
  extractParams?: (match: RegExpMatchArray, fullText: string) => Record<string, string>;
  confidence: number;
}

/**
 * Pattern-based rules for fast classification.
 * These handle the most common intents without an LLM call.
 */
const PATTERN_RULES: PatternRule[] = [
  // Greetings
  {
    action: ActionType.GREETING,
    patterns: [
      /^(hi|hello|hey|good\s*(morning|afternoon|evening)|what'?s?\s*up|yo|howdy|greetings)\b/i,
    ],
    confidence: 0.95,
  },

  // Farewells
  {
    action: ActionType.FAREWELL,
    patterns: [
      /^(bye|goodbye|see\s*you|good\s*night|later|ciao|exit|quit)\b/i,
    ],
    confidence: 0.95,
  },

  // Time/Date
  {
    action: ActionType.TIME_DATE,
    patterns: [
      /\b(what\s*(time|day|date)|current\s*(time|date)|time\s*right\s*now)\b/i,
    ],
    confidence: 0.9,
  },

  // System status
  {
    action: ActionType.SYSTEM_STATUS,
    patterns: [
      /\b(system\s*status|how\s*are\s*you|are\s*you\s*(working|online|alive)|status\s*check|health\s*check)\b/i,
    ],
    confidence: 0.9,
  },

  // WhatsApp messaging
  {
    action: ActionType.SEND_WHATSAPP,
    patterns: [
      /\b(send|message|text|whatsapp)\b.*\b(whatsapp|message|text)\b.*\b(to|saying)\b/i,
      /\bwhatsapp\b.*\b(send|message)\b/i,
      /\bsend\s+(?:a\s+)?(?:whatsapp\s+)?message\s+to\s+(\w+)/i,
    ],
    extractParams: (_match, fullText) => {
      // Extract contact: look for "to <Name>" but skip "to send", "to say" etc.
      const contactMatch = fullText.match(/\bto\s+([A-Z][a-zA-Z]+)/);
      // Also try: "message <Name>"
      const contactFallback = fullText.match(/\bmessage\s+([A-Z][a-zA-Z]+)/);
      const contact = contactMatch?.[1] || contactFallback?.[1] || '';

      // Extract message content: after "saying", "that says", or quoted text
      const sayingMatch = fullText.match(/\bsaying\s+(.+)/i);
      const quotedMatch = fullText.match(/["']([^"']+)["']/);
      const message = sayingMatch?.[1]?.replace(/["']/g, '').trim()
        || quotedMatch?.[1]?.trim()
        || '';

      return { contact, message };
    },
    confidence: 0.85,
  },

  // Open browser / website
  {
    action: ActionType.OPEN_BROWSER,
    patterns: [
      /\b(open|launch|start|go\s+to)\b.*\b(browser|chrome|firefox|edge)\b/i,
      /\b(open|go\s+to|navigate\s+to|visit)\b.*\b(https?:\/\/|www\.)\S+/i,
      /\b(open|go\s+to)\b.*\.(com|org|net|io|dev|ai)\b/i,
    ],
    extractParams: (_match, fullText) => {
      const urlMatch = fullText.match(/(https?:\/\/\S+|www\.\S+|\w+\.\w{2,})/i);
      return { url: urlMatch?.[1] || '' };
    },
    confidence: 0.85,
  },

  // Open application
  {
    action: ActionType.OPEN_APP,
    patterns: [
      /\b(open|launch|start|run)\s+(notepad|calculator|terminal|paint|explorer|vscode|code|spotify|discord|slack|teams)\b/i,
    ],
    extractParams: (_match, fullText) => {
      const appMatch = fullText.match(/\b(open|launch|start|run)\s+(\w+)/i);
      return { app: appMatch?.[2] || '' };
    },
    confidence: 0.85,
  },

  // Close application
  {
    action: ActionType.CLOSE_APP,
    patterns: [
      /\b(close|kill|stop|end|quit)\s+(notepad|calculator|terminal|chrome|firefox|edge|explorer|vscode|code|spotify|discord|slack|teams)\b/i,
    ],
    extractParams: (_match, fullText) => {
      const appMatch = fullText.match(/\b(close|kill|stop|end|quit)\s+(\w+)/i);
      return { app: appMatch?.[2] || '' };
    },
    confidence: 0.85,
  },

  // Screenshot
  {
    action: ActionType.TAKE_SCREENSHOT,
    patterns: [
      /\b(take|capture|grab|snap)\s+(a\s+)?screenshot/i,
      /\bscreenshot\b/i,
    ],
    confidence: 0.9,
  },

  // File read
  {
    action: ActionType.FILE_READ,
    patterns: [
      /\b(read|show|display|cat|view|open)\s+(the\s+)?(file|content)\b/i,
      /\b(what'?s?\s+in|show\s+me)\s+(the\s+)?file\b/i,
    ],
    extractParams: (_match, fullText) => {
      const pathMatch = fullText.match(/(?:file|read|show|view|open)\s+(.+\.\w+)/i);
      return { path: pathMatch?.[1]?.trim() || '' };
    },
    confidence: 0.8,
  },

  // File delete
  {
    action: ActionType.FILE_DELETE,
    patterns: [
      /\b(delete|remove|rm)\s+(the\s+)?file\b/i,
    ],
    extractParams: (_match, fullText) => {
      const pathMatch = fullText.match(/(?:delete|remove|rm)\s+(?:the\s+)?(?:file\s+)?(.+)/i);
      return { path: pathMatch?.[1]?.trim() || '' };
    },
    confidence: 0.85,
  },

  // Terminal command
  {
    action: ActionType.TERMINAL_COMMAND,
    patterns: [
      /\b(run|execute)\s+(the\s+)?(command|terminal|cmd|shell|bash)\b/i,
      /\b(run|execute)\s+[`"](.+)[`"]/i,
    ],
    extractParams: (_match, fullText) => {
      const cmdMatch = fullText.match(/(?:run|execute)\s+[`"]?(.+?)[`"]?\s*$/i);
      return { command: cmdMatch?.[1]?.trim() || '' };
    },
    confidence: 0.85,
  },

  // Git operations
  {
    action: ActionType.GIT_OPERATION,
    patterns: [
      /\b(git\s+(status|log|diff|commit|push|pull|branch|checkout|merge|stash))\b/i,
      /\b(commit|push|pull|merge|stash)\s+(the\s+)?(changes|code)\b/i,
    ],
    confidence: 0.85,
  },

  // Web search
  {
    action: ActionType.WEB_SEARCH,
    patterns: [
      /\b(search|google|look\s+up|find\s+(?:me|information|info)\s+(?:about|on))\b/i,
    ],
    extractParams: (_match, fullText) => {
      const queryMatch = fullText.match(/(?:search|google|look\s+up|find\s+(?:me\s+)?(?:info\s+)?(?:about|on|for)?)\s+(.+)/i);
      return { query: queryMatch?.[1]?.trim() || '' };
    },
    confidence: 0.8,
  },

  // Summarize
  {
    action: ActionType.SUMMARIZE,
    patterns: [
      /\b(summarize|summary|tldr|sum\s+up|give\s+me\s+(?:a\s+)?summary)\b/i,
    ],
    extractParams: (_match, fullText) => {
      const targetMatch = fullText.match(/(?:summarize|summary\s+of)\s+(.+)/i);
      return { target: targetMatch?.[1]?.trim() || '' };
    },
    confidence: 0.8,
  },

  // Remember / Memory store
  {
    action: ActionType.MEMORY_STORE,
    patterns: [
      /\b(remember|save|store|note|jot\s+down)\b.*\b(that|this)\b/i,
    ],
    extractParams: (_match, fullText) => {
      const contentMatch = fullText.match(/(?:remember|save|store|note)\s+(?:that\s+)?(.+)/i);
      return { content: contentMatch?.[1]?.trim() || '' };
    },
    confidence: 0.8,
  },

  // Recall / Memory retrieve
  {
    action: ActionType.MEMORY_RECALL,
    patterns: [
      /\b(do\s+you\s+remember|recall|what\s+did\s+I\s+(?:say|tell)|my\s+(?:notes|preferences|contacts))\b/i,
    ],
    extractParams: (_match, fullText) => {
      const queryMatch = fullText.match(/(?:remember|recall)\s+(.+)/i);
      return { query: queryMatch?.[1]?.trim() || '' };
    },
    confidence: 0.75,
  },

  // ── Communication Department ──────────────────────────────

  // Draft email
  {
    action: ActionType.DRAFT_EMAIL,
    patterns: [
      /\b(draft|compose|write)\s+(?:an?\s+)?email\b/i,
      /\bemail\b.*\b(draft|compose|write)\b/i,
    ],
    extractParams: (_match, fullText) => {
      const toMatch = fullText.match(/\bto\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?|[\w.+-]+@[\w.-]+)/i);
      const subjectMatch = fullText.match(/\b(?:subject|about|regarding)\s+[:\-]?\s*(.+?)(?:\s+(?:saying|body|content|message)|$)/i);
      const bodyMatch = fullText.match(/\b(?:saying|body|content|message)\s+[:\-]?\s*(.+)/i);
      return {
        to: toMatch?.[1]?.trim() || '',
        subject: subjectMatch?.[1]?.trim() || '',
        body: bodyMatch?.[1]?.trim() || '',
      };
    },
    confidence: 0.85,
  },

  // Send email
  {
    action: ActionType.SEND_EMAIL,
    patterns: [
      /\bsend\s+(?:an?\s+)?email\b.*\bto\b/i,
      /\bemail\b.*\bsend\b.*\bto\b/i,
      /\bsend\s+(?:an?\s+)?email\b/i,
    ],
    extractParams: (_match, fullText) => {
      const toMatch = fullText.match(/\bto\s+([\w.+-]+@[\w.-]+|[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i);
      const subjectMatch = fullText.match(/\b(?:subject|about|regarding)\s+[:\-]?\s*(.+?)(?:\s+(?:saying|body|content|message)|$)/i);
      const bodyMatch = fullText.match(/\b(?:saying|body|content|message)\s+[:\-]?\s*(.+)/i);
      const quotedMatch = fullText.match(/["']([^"']+)["']/);
      return {
        to: toMatch?.[1]?.trim() || '',
        subject: subjectMatch?.[1]?.trim() || '',
        body: bodyMatch?.[1]?.trim() || quotedMatch?.[1]?.trim() || '',
      };
    },
    confidence: 0.85,
  },

  // Read email
  {
    action: ActionType.READ_EMAIL,
    patterns: [
      /\b(read|check|show|fetch|get)\s+(?:my\s+)?(?:latest\s+|new\s+|unread\s+)?emails?\b/i,
      /\b(inbox|mailbox)\b/i,
      /\bshow\s+(?:me\s+)?(?:my\s+)?(?:latest\s+|recent\s+)?emails?\b/i,
    ],
    extractParams: (_match, fullText) => {
      const fromMatch = fullText.match(/\bfrom\s+([\w.+-]+@[\w.-]+|[A-Z][a-zA-Z]+)/i);
      const queryMatch = fullText.match(/\b(?:about|regarding|containing)\s+(.+)/i);
      return {
        from: fromMatch?.[1]?.trim() || '',
        query: queryMatch?.[1]?.trim() || '',
      };
    },
    confidence: 0.85,
  },

  // Summarize email thread
  {
    action: ActionType.SUMMARIZE_THREAD,
    patterns: [
      /\bsummarize\s+(?:the\s+)?(?:email\s+)?thread\b/i,
      /\b(?:email\s+)?thread\s+summary\b/i,
      /\bsummarize\s+(?:the\s+)?emails?\s+(?:from|about|with)\b/i,
    ],
    extractParams: (_match, fullText) => {
      const threadMatch = fullText.match(/\bthread\s+(.+)/i);
      const aboutMatch = fullText.match(/\b(?:about|from|with|regarding)\s+(.+)/i);
      return { query: threadMatch?.[1]?.trim() || aboutMatch?.[1]?.trim() || '' };
    },
    confidence: 0.85,
  },

  // Translate message
  {
    action: ActionType.TRANSLATE_MESSAGE,
    patterns: [
      /\btranslate\s+(?:this\s+|the\s+)?(?:message|email|text)\b/i,
      /\btranslate\b.*\b(?:to|into)\s+\w+/i,
    ],
    extractParams: (_match, fullText) => {
      const langMatch = fullText.match(/\b(?:to|into)\s+([A-Za-z]+)$/i);
      const contentMatch = fullText.match(/\btranslate\s+(?:this\s+|the\s+)?(?:message|email|text)\s*[:\-]?\s*(.+?)(?:\s+(?:to|into)\s+\w+)?$/i);
      return {
        language: langMatch?.[1]?.trim() || '',
        body: contentMatch?.[1]?.trim() || '',
      };
    },
    confidence: 0.80,
  },
];

/**
 * IntentParser — converts raw user text into structured Intent objects.
 *
 * Strategy:
 * 1. Try fast pattern matching first (no API call needed)
 * 2. If no pattern matches with high confidence, classify as CODE_TASK
 *    (since Claw is primarily a coding agent, this is the best fallback)
 * 3. Future: LLM-based classification for ambiguous inputs
 */
export class IntentParser {
  /**
   * Parse raw text into a structured Intent.
   */
  async parse(rawInput: string): Promise<Intent> {
    const startTime = Date.now();
    const trimmed = rawInput.trim();

    if (!trimmed) {
      return this.createIntent(trimmed, ActionType.UNKNOWN, {}, 0);
    }

    // Step 1: Try pattern-based classification
    const patternResult = this.tryPatternMatch(trimmed);
    if (patternResult) {
      log.info(`Pattern match: ${patternResult.action} (${patternResult.confidence})`, {
        durationMs: Date.now() - startTime,
      });
      return patternResult;
    }

    // Step 2: Fall back to code task (Claw's primary purpose)
    log.info('No pattern match — defaulting to CODE_TASK', {
      inputLength: trimmed.length,
      durationMs: Date.now() - startTime,
    });

    return this.createIntent(trimmed, ActionType.CODE_TASK, {}, 0.6);
  }

  /**
   * Try to match input against pattern rules.
   */
  private tryPatternMatch(text: string): Intent | null {
    let bestMatch: { rule: PatternRule; match: RegExpMatchArray } | null = null;
    let bestConfidence = 0;

    for (const rule of PATTERN_RULES) {
      for (const pattern of rule.patterns) {
        const match = text.match(pattern);
        if (match && rule.confidence > bestConfidence) {
          bestMatch = { rule, match };
          bestConfidence = rule.confidence;
        }
      }
    }

    if (!bestMatch) return null;

    const params = bestMatch.rule.extractParams
      ? bestMatch.rule.extractParams(bestMatch.match, text)
      : {};

    return this.createIntent(text, bestMatch.rule.action, params, bestConfidence);
  }

  /**
   * Create an Intent object with all required fields.
   */
  private createIntent(
    rawInput: string,
    action: ActionType,
    params: Record<string, string>,
    confidence: number
  ): Intent {
    return {
      id: uuidv4(),
      rawInput,
      action,
      params,
      confidence,
      risk: RiskLevel.LOW, // Will be reclassified by SafetyGate
      timestamp: new Date().toISOString(),
    };
  }
}

/** Singleton instance */
let _parser: IntentParser | null = null;

export function getIntentParser(): IntentParser {
  if (!_parser) {
    _parser = new IntentParser();
  }
  return _parser;
}
