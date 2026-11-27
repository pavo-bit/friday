// ============================================================
// FRIDAY — Clarification Engine
// Tracks missing-information requests per (actorId, conversationId)
// Clarification NEVER grants permission or approval
// ============================================================

import { v4 as uuidv4 } from 'uuid';

export interface PendingClarification {
  clarificationId: string;
  actorId: string;
  conversationId: string;
  originalRequest: string;
  missingFields: string[];
  question: string;
  createdAt: string;
  expiresAt: number;
}

export class ClarificationEngine {
  private pending = new Map<string, PendingClarification>();

  private key(actorId: string, conversationId: string): string {
    return `${actorId}::${conversationId || 'default'}`;
  }

  setPending(params: {
    actorId: string;
    conversationId: string;
    originalRequest: string;
    missingFields: string[];
    question: string;
    ttlMs?: number;
  }): PendingClarification {
    const entry: PendingClarification = {
      clarificationId: uuidv4(),
      actorId: params.actorId,
      conversationId: params.conversationId || 'default',
      originalRequest: params.originalRequest,
      missingFields: params.missingFields,
      question: params.question,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + (params.ttlMs ?? 15 * 60_000),
    };
    this.pending.set(this.key(params.actorId, entry.conversationId), entry);
    return entry;
  }

  getPending(actorId: string, conversationId: string): PendingClarification | null {
    const k = this.key(actorId, conversationId);
    const entry = this.pending.get(k);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.pending.delete(k);
      return null;
    }
    return entry;
  }

  consumeAndMerge(
    actorId: string,
    conversationId: string,
    userAnswer: string
  ): { mergedRequest: string; original: PendingClarification } | null {
    const entry = this.getPending(actorId, conversationId);
    if (!entry) return null;
    this.pending.delete(this.key(actorId, conversationId));
    // Reconstruct clarified request without granting any approval/permission
    const mergedRequest = `${entry.originalRequest} (${entry.missingFields.join(', ')}: ${userAnswer.trim()})`;
    return { mergedRequest, original: entry };
  }

  clear(actorId: string, conversationId: string): void {
    this.pending.delete(this.key(actorId, conversationId));
  }
}

let _clarificationEngine: ClarificationEngine | null = null;
export function getClarificationEngine(): ClarificationEngine {
  if (!_clarificationEngine) {
    _clarificationEngine = new ClarificationEngine();
  }
  return _clarificationEngine;
}
