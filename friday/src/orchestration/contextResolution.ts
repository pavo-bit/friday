// ============================================================
// FRIDAY — Context Resolution Engine & Memory-Write Policy
// Bounded context retrieval, follow-up resolution & injection guard
// ============================================================

import { getMemoryStore } from '../memory/store';
import { containsSensitiveCredential, redactSecrets } from '../memory/redaction';
import { getBackgroundOrchestrator, BackgroundTaskRecord } from './backgroundOrchestrator';
import { getSafetyGate } from './safetyGate';
import { BoundApprovalRecord } from './approvalStore';
import { getDisplayManager } from '../presentation/displayManager';
import { PresentationContract } from '../presentation/presentationTypes';
import { AssistantRequest } from './requestUnderstanding';

export interface ContextLimits {
  maxHistory: number;
  maxMemories: number;
  maxTasks: number;
  maxPresentations: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  maxHistory: 6,
  maxMemories: 5,
  maxTasks: 5,
  maxPresentations: 4,
};

export interface BoundedContextPackage {
  actorId: string;
  conversationId: string;
  recentMessages: Array<{ role: string; content: string; timestamp: string }>;
  relevantMemories: Array<{ key: string; value: string; source: 'sqlite_memory' }>;
  activeTasks: Array<{ id: string; status: string; request: string; updatedAt: string }>;
  pendingApprovals: Array<{ approvalId: string; capabilityId: string; summary: string | null }>;
  recentPresentations: Array<{
    presentationId: string;
    taskId: string | null;
    title: string;
    summary: string;
    verificationStatus: string;
    createdAt: string;
  }>;
  injectionFilteredCount: number;
}

const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /override\s+(?:safety|security|permissions)/i,
  /new\s+system\s+prompt/i,
  /bypass\s+(?:safety|approval)/i,
];

/**
 * Quarantine/sanitize retrieved content so stored memory or external text
 * can never inject instructions into executive prompts.
 */
export function sanitizeRetrievedText(text: string): { safe: string; flagged: boolean } {
  const redacted = redactSecrets(text);
  const flagged = INJECTION_PATTERNS.some((re) => re.test(redacted));
  if (flagged) {
    return {
      safe: '[QUARANTINED_UNTRUSTED_TEXT: potential instruction override removed]',
      flagged: true,
    };
  }
  return { safe: redacted, flagged: false };
}

/**
 * Explicit memory-write policy:
 * Never persist credentials, secrets, raw financial balances/P&L, or trivial greetings.
 */
export function shouldPersistConversationToMemory(text: string): { allow: boolean; reason: string } {
  if (
    containsSensitiveCredential(text) ||
    /\b(password|passphrase|secret|api[_\s-]?key|bearer\s+\S+|token\s+(?:is|=|:)\s*\S+)\b/i.test(text)
  ) {
    return { allow: false, reason: 'Contains credential/secret pattern' };
  }
  if (/\b(balance|net\s*worth|salary|income|expense|account\s*number|pan|aadhaar|portfolio|pnl|p&l)\b/i.test(text)) {
    return { allow: false, reason: 'Sensitive financial data must remain in isolated finance/trading tables' };
  }
  if (text.trim().length < 10 || /^(hi|hello|hey|bye|ok|thanks)\b/i.test(text.trim())) {
    return { allow: false, reason: 'Trivial conversational turn' };
  }
  return { allow: true, reason: 'Safe operational summary' };
}

export class ContextResolutionEngine {
  async resolve(
    req: AssistantRequest,
    limits: ContextLimits = DEFAULT_CONTEXT_LIMITS
  ): Promise<BoundedContextPackage> {
    const store = await getMemoryStore();
    let injectionFilteredCount = 0;

    const rawHistory = store.getRecentConversations(limits.maxHistory, req.conversationId);
    const recentMessages = rawHistory.map((h) => {
      const s = sanitizeRetrievedText(h.content);
      if (s.flagged) injectionFilteredCount++;
      return { role: h.role, content: s.safe, timestamp: h.createdAt };
    });

    const rawMem = store.getRelevantContext(req.normalizedInput, limits.maxMemories);
    const relevantMemories: BoundedContextPackage['relevantMemories'] = [];
    for (const line of rawMem.split('\n').filter(Boolean).slice(0, limits.maxMemories)) {
      const s = sanitizeRetrievedText(line);
      if (s.flagged) {
        injectionFilteredCount++;
        continue;
      }
      relevantMemories.push({ key: 'memory', value: s.safe, source: 'sqlite_memory' });
    }

    const tasks = await getBackgroundOrchestrator().listTasks(req.actorId, limits.maxTasks);
    const activeTasks = tasks.map((t: BackgroundTaskRecord) => ({
      id: t.id,
      status: t.status,
      request: redactSecrets(t.originalRequest),
      updatedAt: t.updatedAt,
    }));

    const approvals = await getSafetyGate().listBoundApprovals({
      actorId: req.actorId,
      status: 'PENDING',
      limit: 10,
    });
    const pendingApprovals = approvals.map((a: BoundApprovalRecord) => ({
      approvalId: a.approvalId,
      capabilityId: a.capabilityId,
      summary: a.summary,
    }));

    const presentations = await getDisplayManager().listPresentations(req.actorId, {
      conversationId: req.conversationId !== 'default' ? req.conversationId : undefined,
      limit: limits.maxPresentations,
    });
    const recentPresentations = presentations.map((p: PresentationContract) => ({
      presentationId: p.presentationId,
      taskId: p.taskId,
      title: p.title,
      summary: p.summary,
      verificationStatus: p.verificationStatus,
      createdAt: p.createdAt,
    }));

    return {
      actorId: req.actorId,
      conversationId: req.conversationId,
      recentMessages,
      relevantMemories,
      activeTasks,
      pendingApprovals,
      recentPresentations,
      injectionFilteredCount,
    };
  }

  /**
   * Resolve follow-up task/presentation references safely without guessing across multiple candidates.
   */
  resolveFollowUpTask(
    ctx: BoundedContextPackage,
    preference: 'active_or_waiting' | 'latest' = 'latest'
  ): { resolved: boolean; taskId?: string; ambiguous?: boolean; clarification?: string } {
    if (preference === 'active_or_waiting') {
      const waiting = ctx.activeTasks.filter(
        (t) => t.status === 'WAITING_FOR_APPROVAL' || t.status === 'RUNNING' || t.status === 'QUEUED'
      );
      if (waiting.length === 1) {
        return { resolved: true, taskId: waiting[0].id };
      }
      if (waiting.length > 1) {
        return {
          resolved: false,
          ambiguous: true,
          clarification: `You have ${waiting.length} active/waiting tasks (${waiting.map((t) => `"${t.request}"`).join(', ')}). Which one would you like to continue?`,
        };
      }
      return {
        resolved: false,
        clarification: 'There is no active or paused task to continue.',
      };
    }

    if (ctx.activeTasks.length === 0) {
      return { resolved: false, clarification: 'No previous task found in your history.' };
    }
    return { resolved: true, taskId: ctx.activeTasks[0].id };
  }
}

let _ctxEngine: ContextResolutionEngine | null = null;
export function getContextResolutionEngine(): ContextResolutionEngine {
  if (!_ctxEngine) {
    _ctxEngine = new ContextResolutionEngine();
  }
  return _ctxEngine;
}
