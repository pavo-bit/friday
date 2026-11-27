// ============================================================
// FRIDAY — AI Context & Memory Window Manager
// Keeps SQLite as source of truth while bounding context tokens
// ============================================================

import { AIChatMessage } from '../providers/AIProvider';
import { redactSecrets } from '../../memory/redaction';

/**
 * Rough, deterministic token estimator (~4 chars per token + message overhead).
 */
export function estimateMessageTokens(msg: AIChatMessage): number {
  const contentLen = msg.content ? msg.content.length : 0;
  return Math.ceil(contentLen / 4) + 6;
}

/**
 * Bound conversation history to fit safely within a model's context budget
 * while always preserving the system prompt and the latest user message.
 */
export function buildBoundedChatMessages(params: {
  systemPrompt: string;
  history: Array<{ role: string; content: string }>;
  userMessage: string;
  maxContextTokens?: number;
  reserveResponseTokens?: number;
}): AIChatMessage[] {
  const maxTokens = params.maxContextTokens ?? 24_000;
  const reserve = params.reserveResponseTokens ?? 4_000;
  const budget = Math.max(2_000, maxTokens - reserve);

  const systemMsg: AIChatMessage = {
    role: 'system',
    content: redactSecrets(params.systemPrompt),
  };
  const latestUserMsg: AIChatMessage = {
    role: 'user',
    content: redactSecrets(params.userMessage),
  };

  let usedTokens = estimateMessageTokens(systemMsg) + estimateMessageTokens(latestUserMsg);
  const keptHistory: AIChatMessage[] = [];

  // Walk backwards from most recent historical turns so newest context is preserved
  for (let i = params.history.length - 1; i >= 0; i--) {
    const turn = params.history[i];
    const msg: AIChatMessage = {
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: redactSecrets(turn.content),
    };
    const cost = estimateMessageTokens(msg);
    if (usedTokens + cost > budget) {
      break;
    }
    usedTokens += cost;
    keptHistory.unshift(msg);
  }

  return [systemMsg, ...keptHistory, latestUserMsg];
}

/**
 * Reduce an existing message array after a CONTEXT_OVERFLOW error by dropping
 * the oldest non-system conversational turns.
 */
export function reduceMessagesForOverflow(messages: AIChatMessage[]): AIChatMessage[] {
  if (messages.length <= 2) return messages;
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const keepCount = Math.max(1, Math.ceil(nonSystem.length / 2));
  return [...systemMsgs, ...nonSystem.slice(-keepCount)];
}
