// ============================================================
// FRIDAY — Persistent SQLite-Backed Clarification Engine
// Survives restarts, enforces actor/conversation ownership,
// atomic resumption, expiry, and malformed-record validation.
// Clarification NEVER grants permission or approval.
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { redactSecrets } from '../memory/redaction';
import { AssistantRequest } from './requestUnderstanding';

export type ClarificationStatus = 'PENDING' | 'RESUMED' | 'EXPIRED' | 'CANCELLED';

export interface PendingClarification {
  clarificationId: string;
  actorId: string;
  conversationId: string;
  originalRequestId: string;
  originalRequest: string;
  structuredRequest: AssistantRequest | null;
  missingFields: string[];
  collectedInfo: string[];
  question: string;
  status: ClarificationStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

function validateStructuredRequest(rawJson: string, expectedActorId: string): AssistantRequest | null {
  try {
    const parsed = JSON.parse(rawJson) as Partial<AssistantRequest>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.requestId !== 'string' ||
      typeof parsed.rawInput !== 'string' ||
      parsed.actorId !== expectedActorId
    ) {
      return null;
    }
    return parsed as AssistantRequest;
  } catch {
    return null;
  }
}

function safeParseStringArray(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

export class ClarificationEngine {
  async setPending(params: {
    actorId: string;
    conversationId: string;
    originalRequestId?: string;
    originalRequest: string;
    structuredRequest?: AssistantRequest;
    missingFields: string[];
    question: string;
    ttlMs?: number;
  }): Promise<PendingClarification> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable for clarification persistence');

    const clarificationId = uuidv4();
    const convId = params.conversationId || 'default';
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + (params.ttlMs ?? 15 * 60_000)).toISOString();
    const safeInput = redactSecrets(params.originalRequest);
    const safeQuestion = redactSecrets(params.question);
    const reqJson = JSON.stringify(
      params.structuredRequest || {
        requestId: params.originalRequestId || uuidv4(),
        conversationId: convId,
        actorId: params.actorId,
        rawInput: safeInput,
      }
    );

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE pending_clarifications
         SET status = 'CANCELLED', updated_at = ?
         WHERE actor_id = ? AND conversation_id = ? AND status = 'PENDING'`
      ).run(now, params.actorId, convId);

      db.prepare(
        `INSERT INTO pending_clarifications (
          clarification_id, actor_id, conversation_id, original_request_id,
          original_input, request_json, missing_fields_json, collected_info_json,
          question, status, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, 'PENDING', ?, ?, ?)`
      ).run(
        clarificationId,
        params.actorId,
        convId,
        params.originalRequestId || uuidv4(),
        safeInput,
        reqJson,
        JSON.stringify(params.missingFields),
        safeQuestion,
        now,
        now,
        expiresAt
      );
    });
    tx();

    return (await this.getById(clarificationId, params.actorId))!;
  }

  async getById(clarificationId: string, actorId: string): Promise<PendingClarification | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;

    const row = db
      .prepare(`SELECT * FROM pending_clarifications WHERE clarification_id = ? AND actor_id = ? LIMIT 1`)
      .get(clarificationId, actorId) as Record<string, unknown> | undefined;
    if (!row) return null;

    return this.hydrateAndValidateRow(row);
  }

  async getPending(actorId: string, conversationId: string): Promise<PendingClarification | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;

    const convId = conversationId || 'default';
    const row = db
      .prepare(
        `SELECT * FROM pending_clarifications
         WHERE actor_id = ? AND conversation_id = ? AND status = 'PENDING'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(actorId, convId) as Record<string, unknown> | undefined;

    if (!row) return null;
    const hydrated = await this.hydrateAndValidateRow(row);
    if (!hydrated || hydrated.status !== 'PENDING') {
      return null;
    }
    return hydrated;
  }

  async consumeAndMerge(
    actorId: string,
    conversationId: string,
    userAnswer: string
  ): Promise<{ mergedRequest: string; original: PendingClarification } | null> {
    const entry = await this.getPending(actorId, conversationId);
    if (!entry) return null;

    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;

    const now = new Date().toISOString();
    const safeAnswer = redactSecrets(userAnswer.trim());
    const collected = [...entry.collectedInfo, safeAnswer];

    const info = db
      .prepare(
        `UPDATE pending_clarifications
         SET status = 'RESUMED', collected_info_json = ?, updated_at = ?
         WHERE clarification_id = ? AND actor_id = ? AND conversation_id = ? AND status = 'PENDING'`
      )
      .run(JSON.stringify(collected), now, entry.clarificationId, actorId, entry.conversationId);

    if (info.changes !== 1) {
      return null;
    }

    const mergedRequest = `${entry.originalRequest} (${entry.missingFields.join(', ')}: ${safeAnswer})`;
    return {
      mergedRequest,
      original: {
        ...entry,
        status: 'RESUMED',
        collectedInfo: collected,
        updatedAt: now,
      },
    };
  }

  async cancel(clarificationId: string, actorId: string): Promise<boolean> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return false;

    const info = db
      .prepare(
        `UPDATE pending_clarifications
         SET status = 'CANCELLED', updated_at = ?
         WHERE clarification_id = ? AND actor_id = ? AND status = 'PENDING'`
      )
      .run(new Date().toISOString(), clarificationId, actorId);

    return info.changes === 1;
  }

  async clear(actorId: string, conversationId: string): Promise<void> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return;

    db.prepare(
      `UPDATE pending_clarifications
       SET status = 'CANCELLED', updated_at = ?
       WHERE actor_id = ? AND conversation_id = ? AND status = 'PENDING'`
    ).run(new Date().toISOString(), actorId, conversationId || 'default');
  }

  private async hydrateAndValidateRow(
    row: Record<string, unknown>
  ): Promise<PendingClarification | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    const id = String(row.clarification_id);
    const actorId = String(row.actor_id);
    const status = String(row.status) as ClarificationStatus;
    const expiresAt = String(row.expires_at);

    if (status === 'PENDING' && !Number.isNaN(Date.parse(expiresAt)) && Date.now() > Date.parse(expiresAt)) {
      const now = new Date().toISOString();
      db?.prepare(
        `UPDATE pending_clarifications SET status = 'EXPIRED', updated_at = ? WHERE clarification_id = ? AND status = 'PENDING'`
      ).run(now, id);
      return {
        clarificationId: id,
        actorId,
        conversationId: String(row.conversation_id),
        originalRequestId: String(row.original_request_id),
        originalRequest: String(row.original_input),
        structuredRequest: validateStructuredRequest(String(row.request_json || '{}'), actorId),
        missingFields: safeParseStringArray(row.missing_fields_json),
        collectedInfo: safeParseStringArray(row.collected_info_json),
        question: String(row.question),
        status: 'EXPIRED',
        createdAt: String(row.created_at),
        updatedAt: now,
        expiresAt,
      };
    }

    const structured = validateStructuredRequest(String(row.request_json || '{}'), actorId);
    if (!structured) {
      // Malformed or tampered persisted record: quarantine/cancel safely
      db?.prepare(
        `UPDATE pending_clarifications SET status = 'CANCELLED', updated_at = ? WHERE clarification_id = ? AND status = 'PENDING'`
      ).run(new Date().toISOString(), id);
      return null;
    }

    return {
      clarificationId: id,
      actorId,
      conversationId: String(row.conversation_id),
      originalRequestId: String(row.original_request_id),
      originalRequest: String(row.original_input),
      structuredRequest: structured,
      missingFields: safeParseStringArray(row.missing_fields_json),
      collectedInfo: safeParseStringArray(row.collected_info_json),
      question: String(row.question),
      status,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      expiresAt,
    };
  }
}

let _clarificationEngine: ClarificationEngine | null = null;
export function getClarificationEngine(): ClarificationEngine {
  if (!_clarificationEngine) {
    _clarificationEngine = new ClarificationEngine();
  }
  return _clarificationEngine;
}
