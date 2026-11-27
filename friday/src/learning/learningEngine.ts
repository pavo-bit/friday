// ============================================================
// FRIDAY — Continuous Learning Engine (Phase 13.5)
// Pipeline: COLLECT -> CLASSIFY -> EXTRACT -> VALIDATE -> STORE -> RETRIEVE -> EVALUATE
// Never autonomously modifies Qwen3:4B weights or bypasses approvals.
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { getPersonalIdentityService } from '../identity/identityService';
import {
  LearnedProcedureRecord,
  LearningIngestInput,
  LearningKind,
  LearningRecord,
} from './learningTypes';
import { validateLearningSource } from './sourceValidator';

export class ContinuousLearningEngine {
  /**
   * Run the full 7-stage learning pipeline for an approved input source.
   */
  async ingest(input: LearningIngestInput): Promise<{
    ingested: boolean;
    deduplicated: boolean;
    record?: LearningRecord;
    reason?: string;
  }> {
    // Respect user privacy setting
    const identity = await getPersonalIdentityService().getProfile(input.actorId);
    if (!identity.privacy.allowLearning) {
      return {
        ingested: false,
        deduplicated: false,
        reason: 'Continuous learning is disabled in user privacy settings.',
      };
    }

    // 1. COLLECT & 4. VALIDATE
    const validation = validateLearningSource({
      sourceType: input.sourceType,
      rawContent: input.rawContent,
      declaredQuality: input.declaredQuality,
      approvedSource: input.approvedSource,
    });
    if (!validation.allowed) {
      return {
        ingested: false,
        deduplicated: false,
        reason: validation.reason,
      };
    }

    // 2. CLASSIFY
    const kind = this.classify(input.explicitKind, input.sourceType, validation.sanitizedContent);

    // 3. EXTRACT concise normalized content
    const subject = input.subject.trim().slice(0, 140);
    const content = validation.sanitizedContent.slice(0, 2000);
    const projectName = (input.projectName || '').trim();

    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    // 5. STORE with duplicate & conflict detection
    const existing = db
      .prepare(
        `SELECT * FROM learning_records
         WHERE actor_id = ? AND learning_kind = ? AND LOWER(subject) = LOWER(?) AND LOWER(project_name) = LOWER(?)
         LIMIT 1`
      )
      .get(input.actorId, kind, subject, projectName) as Record<string, unknown> | undefined;

    if (existing) {
      const sameContent = String(existing.content) === content;
      if (sameContent) {
        return {
          ingested: true,
          deduplicated: true,
          record: this.mapRow(existing),
          reason: 'Duplicate knowledge record skipped.',
        };
      }

      // Conflict resolution: update with newer statement/outcome and updated timestamp
      db.prepare(
        `UPDATE learning_records
         SET content = ?, source_type = ?, source_ref = ?, source_quality = ?,
             verified = ?, untrusted_sanitized = ?, updated_at = datetime('now')
         WHERE id = ? AND actor_id = ?`
      ).run(
        content,
        input.sourceType,
        input.sourceRef,
        validation.resolvedQuality,
        validation.verified ? 1 : 0,
        validation.untrustedSanitized ? 1 : 0,
        String(existing.id),
        input.actorId
      );

      const updated = db
        .prepare(`SELECT * FROM learning_records WHERE id = ?`)
        .get(String(existing.id)) as Record<string, unknown>;
      return {
        ingested: true,
        deduplicated: false,
        record: this.mapRow(updated),
        reason: 'Conflicting record updated with latest approved input.',
      };
    }

    const id = uuidv4();
    const confidence = validation.verified ? 0.95 : validation.resolvedQuality === 'USER_STATEMENT' ? 0.8 : 0.65;
    db.prepare(
      `INSERT INTO learning_records (
         id, actor_id, learning_kind, source_type, source_ref, source_quality,
         subject, content, project_name, confidence, verified, untrusted_sanitized, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.actorId,
      kind,
      input.sourceType,
      input.sourceRef,
      validation.resolvedQuality,
      subject,
      content,
      projectName,
      confidence,
      validation.verified ? 1 : 0,
      validation.untrustedSanitized ? 1 : 0,
      input.expiresAt || null
    );

    const inserted = db.prepare(`SELECT * FROM learning_records WHERE id = ?`).get(id) as Record<string, unknown>;
    return {
      ingested: true,
      deduplicated: false,
      record: this.mapRow(inserted),
    };
  }

  /**
   * Process an explicit user correction, distinguishing temporary vs persistent preference.
   */
  async recordCorrection(params: {
    actorId: string;
    subject: string;
    correction: string;
    persistentPreference?: boolean;
    projectName?: string;
  }): Promise<{ storedInLearning: boolean; storedAsPersistentPreference: boolean; record?: LearningRecord }> {
    const res = await this.ingest({
      actorId: params.actorId,
      sourceType: 'conversation_correction',
      sourceRef: 'user_feedback',
      subject: params.subject,
      rawContent: params.correction,
      projectName: params.projectName,
      explicitKind: params.persistentPreference ? 'preference' : 'knowledge',
      declaredQuality: 'USER_STATEMENT',
    });

    if (params.persistentPreference && res.ingested) {
      const store = await getMemoryStore();
      store.storeIdentityMemory({
        actorId: params.actorId,
        type: 'preference',
        category: 'preference',
        key: params.subject,
        value: params.correction,
        provenance: 'conversation_correction',
      });
    }

    return {
      storedInLearning: res.ingested,
      storedAsPersistentPreference: Boolean(params.persistentPreference && res.ingested),
      record: res.record,
    };
  }

  /**
   * 6. RETRIEVE relevant learning records for an actor (optionally scoped by project).
   */
  async retrieve(params: {
    actorId: string;
    query?: string;
    projectName?: string;
    kind?: LearningKind;
    limit?: number;
  }): Promise<LearningRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];

    let sql = `SELECT * FROM learning_records WHERE actor_id = ? AND source_quality != 'OUTDATED'`;
    const args: unknown[] = [params.actorId];

    if (params.kind) {
      sql += ` AND learning_kind = ?`;
      args.push(params.kind);
    }
    if (params.projectName) {
      sql += ` AND (LOWER(project_name) = LOWER(?) OR project_name = '')`;
      args.push(params.projectName);
    }
    if (params.query && params.query.trim()) {
      const kws = params.query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .slice(0, 5);
      if (kws.length > 0) {
        sql += ` AND (${kws.map(() => '(LOWER(subject) LIKE ? OR LOWER(content) LIKE ?)').join(' OR ')})`;
        for (const kw of kws) {
          args.push(`%${kw}%`, `%${kw}%`);
        }
      }
    }

    sql += ` ORDER BY verified DESC, updated_at DESC LIMIT ?`;
    args.push(params.limit ?? 20);

    const rows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * 7. EVALUATE: mark expired or stale records as OUTDATED.
   */
  async markStaleRecords(actorId: string): Promise<number> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return 0;
    const info = db
      .prepare(
        `UPDATE learning_records
         SET source_quality = 'OUTDATED', updated_at = datetime('now')
         WHERE actor_id = ? AND expires_at IS NOT NULL AND datetime(expires_at) < datetime('now') AND source_quality != 'OUTDATED'`
      )
      .run(actorId);
    return info.changes;
  }

  /**
   * Propose a reusable procedure from a completed workflow.
   * Always requires explicit user approval before consequential execution.
   */
  async proposeProcedure(params: {
    actorId: string;
    name: string;
    description: string;
    steps: string[];
  }): Promise<LearnedProcedureRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const id = uuidv4();
    const name = params.name.trim();
    db.prepare(
      `INSERT INTO learned_procedures (
         id, actor_id, name, description, steps_json, requires_approval, approved_by_user
       ) VALUES (?, ?, ?, ?, ?, 1, 0)
       ON CONFLICT(actor_id, name) DO UPDATE SET
         description = excluded.description,
         steps_json = excluded.steps_json,
         approved_by_user = 0,
         approved_at = NULL,
         updated_at = datetime('now')`
    ).run(id, params.actorId, name, params.description.trim(), JSON.stringify(params.steps));

    const row = db
      .prepare(`SELECT * FROM learned_procedures WHERE actor_id = ? AND name = ?`)
      .get(params.actorId, name) as Record<string, unknown>;
    return this.mapProc(row);
  }

  async approveProcedure(actorId: string, procedureId: string, approvedByHuman: boolean): Promise<LearnedProcedureRecord> {
    if (!approvedByHuman) {
      throw new Error('Explicit human approval is required to approve a learned procedure.');
    }
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const info = db
      .prepare(
        `UPDATE learned_procedures
         SET approved_by_user = 1, approved_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND actor_id = ?`
      )
      .run(procedureId, actorId);
    if (info.changes === 0) {
      throw new Error('Procedure not found for this actor.');
    }
    const row = db.prepare(`SELECT * FROM learned_procedures WHERE id = ?`).get(procedureId) as Record<string, unknown>;
    return this.mapProc(row);
  }

  async listProcedures(actorId: string): Promise<LearnedProcedureRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    const rows = db
      .prepare(`SELECT * FROM learned_procedures WHERE actor_id = ? ORDER BY updated_at DESC`)
      .all(actorId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapProc(r));
  }

  /**
   * Extension point: export curated, verified records for future human-approved fine-tuning evaluation.
   * Never autonomously modifies Ollama Qwen3:4B weights.
   */
  async exportCuratedFineTuneCandidates(actorId: string): Promise<Array<{ prompt: string; completion: string; provenance: string }>> {
    const records = await this.retrieve({ actorId, limit: 50 });
    return records
      .filter((r) => r.verified && !r.untrustedSanitized)
      .map((r) => ({
        prompt: r.subject,
        completion: r.content,
        provenance: `${r.sourceType}:${r.sourceRef}`,
      }));
  }

  private classify(explicitKind: LearningKind | undefined, sourceType: string, content: string): LearningKind {
    if (explicitKind) return explicitKind;
    if (sourceType === 'conversation_correction' && /\b(prefer|always|never|address\s+me)\b/i.test(content)) {
      return 'preference';
    }
    if (/\b(step\s+1|workflow|procedure|checklist)\b/i.test(content)) {
      return 'procedure';
    }
    return 'knowledge';
  }

  private mapRow(row: Record<string, unknown>): LearningRecord {
    return {
      id: String(row.id),
      actorId: String(row.actor_id),
      learningKind: row.learning_kind as LearningKind,
      sourceType: row.source_type as LearningRecord['sourceType'],
      sourceRef: String(row.source_ref || ''),
      sourceQuality: row.source_quality as LearningRecord['sourceQuality'],
      subject: String(row.subject),
      content: String(row.content),
      projectName: String(row.project_name || ''),
      confidence: Number(row.confidence ?? 0.7),
      verified: Number(row.verified) === 1,
      untrustedSanitized: Number(row.untrusted_sanitized) === 1,
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapProc(row: Record<string, unknown>): LearnedProcedureRecord {
    return {
      id: String(row.id),
      actorId: String(row.actor_id),
      name: String(row.name),
      description: String(row.description),
      steps: JSON.parse(String(row.steps_json || '[]')),
      requiresApproval: Number(row.requires_approval) === 1,
      approvedByUser: Number(row.approved_by_user) === 1,
      approvedAt: row.approved_at ? String(row.approved_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

let _learningEngine: ContinuousLearningEngine | null = null;
export function getContinuousLearningEngine(): ContinuousLearningEngine {
  if (!_learningEngine) {
    _learningEngine = new ContinuousLearningEngine();
  }
  return _learningEngine;
}
