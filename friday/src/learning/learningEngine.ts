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
  LearningContradictionRecord,
  LearningIngestInput,
  LearningKind,
  LearningRecord,
  LearningVersionRecord,
  ProcedureExecutionRecord,
} from './learningTypes';
import { validateLearningSource } from './sourceValidator';

export class ContinuousLearningEngine {
  /**
   * Run the full 7-stage learning pipeline for an approved input source.
   */
  async ingest(input: LearningIngestInput): Promise<{
    ingested: boolean;
    deduplicated: boolean;
    contradictionDetected?: boolean;
    contradictionId?: string;
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

      // Explicit user correction updates with version history;
      // other sources record a contradiction instead of silently overwriting!
      if (input.sourceType !== 'conversation_correction') {
        const contraId = uuidv4();
        db.prepare(
          `INSERT INTO learning_contradictions
           (id, actor_id, existing_record_id, conflicting_content, conflicting_source_type, conflicting_source_ref, project_name, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN')`
        ).run(
          contraId,
          input.actorId,
          String(existing.id),
          content,
          input.sourceType,
          input.sourceRef,
          projectName
        );
        return {
          ingested: false,
          deduplicated: false,
          contradictionDetected: true,
          contradictionId: contraId,
          record: this.mapRow(existing),
          reason: 'Contradictory knowledge detected; preserved existing record and recorded contradiction for review.',
        };
      }

      const nextVer = Number(existing.version ?? 1) + 1;
      db.prepare(
        `INSERT INTO learning_versions (id, record_id, actor_id, version, previous_content, new_content, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        uuidv4(),
        String(existing.id),
        input.actorId,
        nextVer,
        String(existing.content),
        content,
        'Explicit user correction'
      );

      db.prepare(
        `UPDATE learning_records
         SET content = ?, source_type = ?, source_ref = ?, source_quality = ?,
             verified = ?, untrusted_sanitized = ?, version = ?, updated_at = datetime('now')
         WHERE id = ? AND actor_id = ?`
      ).run(
        content,
        input.sourceType,
        input.sourceRef,
        validation.resolvedQuality,
        validation.verified ? 1 : 0,
        validation.untrustedSanitized ? 1 : 0,
        nextVer,
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
        reason: 'Updated with explicit user correction and version history recorded.',
      };
    }

    const id = uuidv4();
    const confidence = validation.verified ? 0.95 : validation.resolvedQuality === 'USER_STATEMENT' ? 0.8 : 0.65;
    const evidenceJson = JSON.stringify(input.evidence || []);
    db.prepare(
      `INSERT INTO learning_records (
         id, actor_id, learning_kind, source_type, source_ref, source_quality,
         subject, content, project_name, confidence, verified, evidence_json, untrusted_sanitized, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      evidenceJson,
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

  async approveKnowledge(actorId: string, recordId: string, approvedByHuman: boolean): Promise<LearningRecord> {
    if (!approvedByHuman) {
      throw new Error('Explicit human approval is required to approve knowledge.');
    }
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');
    const info = db
      .prepare(
        `UPDATE learning_records
         SET approved_by_user = 1, verified = 1, source_quality = 'VERIFIED_FACT', updated_at = datetime('now')
         WHERE id = ? AND actor_id = ?`
      )
      .run(recordId, actorId);
    if (info.changes === 0) throw new Error('Knowledge record not found for this actor.');
    const row = db.prepare(`SELECT * FROM learning_records WHERE id = ?`).get(recordId) as Record<string, unknown>;
    return this.mapRow(row);
  }

  async deleteKnowledge(actorId: string, recordId: string): Promise<boolean> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return false;
    const info = db.prepare(`DELETE FROM learning_records WHERE id = ? AND actor_id = ?`).run(recordId, actorId);
    return info.changes > 0;
  }

  async listContradictions(actorId: string, status?: LearningContradictionRecord['status']): Promise<LearningContradictionRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    const sql = status
      ? `SELECT * FROM learning_contradictions WHERE actor_id = ? AND status = ? ORDER BY created_at DESC`
      : `SELECT * FROM learning_contradictions WHERE actor_id = ? ORDER BY created_at DESC`;
    const rows = (status ? db.prepare(sql).all(actorId, status) : db.prepare(sql).all(actorId)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      actorId: String(r.actor_id),
      existingRecordId: String(r.existing_record_id),
      conflictingContent: String(r.conflicting_content),
      conflictingSourceType: String(r.conflicting_source_type),
      conflictingSourceRef: String(r.conflicting_source_ref || ''),
      projectName: String(r.project_name || ''),
      status: r.status as LearningContradictionRecord['status'],
      createdAt: String(r.created_at),
      resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
    }));
  }

  async resolveContradiction(
    actorId: string,
    contradictionId: string,
    resolution: 'KEEP_EXISTING' | 'USE_NEW'
  ): Promise<LearningContradictionRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');
    const cRow = db
      .prepare(`SELECT * FROM learning_contradictions WHERE id = ? AND actor_id = ?`)
      .get(contradictionId, actorId) as Record<string, unknown> | undefined;
    if (!cRow) throw new Error('Contradiction not found for this actor.');

    const nextStatus = resolution === 'KEEP_EXISTING' ? 'RESOLVED_KEEP_EXISTING' : 'RESOLVED_USE_NEW';
    const tx = db.transaction(() => {
      if (resolution === 'USE_NEW') {
        const existing = db
          .prepare(`SELECT * FROM learning_records WHERE id = ? AND actor_id = ?`)
          .get(String(cRow.existing_record_id), actorId) as Record<string, unknown> | undefined;
        if (existing) {
          const nextVer = Number(existing.version ?? 1) + 1;
          db.prepare(
            `INSERT INTO learning_versions (id, record_id, actor_id, version, previous_content, new_content, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(
            uuidv4(),
            String(existing.id),
            actorId,
            nextVer,
            String(existing.content),
            String(cRow.conflicting_content),
            `Contradiction ${contradictionId} resolved as USE_NEW`
          );
          db.prepare(
            `UPDATE learning_records
             SET content = ?, source_type = ?, source_ref = ?, version = ?, updated_at = datetime('now')
             WHERE id = ? AND actor_id = ?`
          ).run(
            String(cRow.conflicting_content),
            String(cRow.conflicting_source_type),
            String(cRow.conflicting_source_ref || ''),
            nextVer,
            String(existing.id),
            actorId
          );
        }
      }
      db.prepare(
        `UPDATE learning_contradictions SET status = ?, resolved_at = datetime('now') WHERE id = ? AND actor_id = ?`
      ).run(nextStatus, contradictionId, actorId);
    });
    tx();

    const updated = db
      .prepare(`SELECT * FROM learning_contradictions WHERE id = ?`)
      .get(contradictionId) as Record<string, unknown>;
    return {
      id: String(updated.id),
      actorId: String(updated.actor_id),
      existingRecordId: String(updated.existing_record_id),
      conflictingContent: String(updated.conflicting_content),
      conflictingSourceType: String(updated.conflicting_source_type),
      conflictingSourceRef: String(updated.conflicting_source_ref || ''),
      projectName: String(updated.project_name || ''),
      status: updated.status as LearningContradictionRecord['status'],
      createdAt: String(updated.created_at),
      resolvedAt: updated.resolved_at ? String(updated.resolved_at) : null,
    };
  }

  async getVersionHistory(actorId: string, recordId: string): Promise<LearningVersionRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    const rows = db
      .prepare(`SELECT * FROM learning_versions WHERE record_id = ? AND actor_id = ? ORDER BY version DESC`)
      .all(recordId, actorId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      recordId: String(r.record_id),
      actorId: String(r.actor_id),
      version: Number(r.version),
      previousContent: String(r.previous_content),
      newContent: String(r.new_content),
      reason: String(r.reason || ''),
      changedAt: String(r.changed_at),
    }));
  }

  async listStaleRecords(actorId: string): Promise<LearningRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    const rows = db
      .prepare(`SELECT * FROM learning_records WHERE actor_id = ? AND source_quality = 'OUTDATED' ORDER BY updated_at DESC`)
      .all(actorId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
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
    sourceRef?: string;
    scope?: string;
    requiredPermissions?: string[];
  }): Promise<LearnedProcedureRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const id = uuidv4();
    const name = params.name.trim();
    db.prepare(
      `INSERT INTO learned_procedures (
         id, actor_id, name, description, steps_json, source_ref, scope, required_permissions_json, version, requires_approval, approved_by_user
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0)
       ON CONFLICT(actor_id, name) DO UPDATE SET
         description = excluded.description,
         steps_json = excluded.steps_json,
         source_ref = excluded.source_ref,
         scope = excluded.scope,
         required_permissions_json = excluded.required_permissions_json,
         version = learned_procedures.version + 1,
         approved_by_user = 0,
         approved_at = NULL,
         updated_at = datetime('now')`
    ).run(
      id,
      params.actorId,
      name,
      params.description.trim(),
      JSON.stringify(params.steps),
      params.sourceRef || 'workflow',
      params.scope || 'actor',
      JSON.stringify(params.requiredPermissions || [])
    );

    const row = db
      .prepare(`SELECT * FROM learned_procedures WHERE actor_id = ? AND name = ?`)
      .get(params.actorId, name) as Record<string, unknown>;
    return this.mapProc(row);
  }

  async executeProcedure(
    actorId: string,
    procedureId: string,
    options: { approvedByHuman?: boolean; grantedPermissions?: string[] } = {}
  ): Promise<ProcedureExecutionRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const row = db
      .prepare(`SELECT * FROM learned_procedures WHERE id = ? AND actor_id = ?`)
      .get(procedureId, actorId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Procedure not found for this actor.');
    const proc = this.mapProc(row);

    const granted = new Set(options.grantedPermissions || []);
    const missingPerms = proc.requiredPermissions.filter((p) => !granted.has(p));

    if (!proc.approvedByUser || !options.approvedByHuman || missingPerms.length > 0) {
      const reason = !proc.approvedByUser
        ? 'Procedure is not approved by user.'
        : !options.approvedByHuman
          ? 'Explicit human execution approval is required.'
          : `Missing required permissions: ${missingPerms.join(', ')}`;
      const execId = uuidv4();
      db.prepare(
        `INSERT INTO procedure_executions (id, procedure_id, actor_id, authorized, status, output)
         VALUES (?, ?, ?, 0, 'BLOCKED', ?)`
      ).run(execId, proc.id, actorId, reason);
      const execRow = db.prepare(`SELECT * FROM procedure_executions WHERE id = ?`).get(execId) as Record<string, unknown>;
      return this.mapExec(execRow);
    }

    const execId = uuidv4();
    const output = `Executed approved procedure "${proc.name}" v${proc.version} (${proc.steps.length} steps).`;
    db.prepare(
      `INSERT INTO procedure_executions (id, procedure_id, actor_id, authorized, status, output)
       VALUES (?, ?, ?, 1, 'COMPLETED', ?)`
    ).run(execId, proc.id, actorId, output);
    const execRow = db.prepare(`SELECT * FROM procedure_executions WHERE id = ?`).get(execId) as Record<string, unknown>;
    return this.mapExec(execRow);
  }

  async listProcedureExecutions(actorId: string, procedureId?: string): Promise<ProcedureExecutionRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    const sql = procedureId
      ? `SELECT * FROM procedure_executions WHERE actor_id = ? AND procedure_id = ? ORDER BY executed_at DESC LIMIT 30`
      : `SELECT * FROM procedure_executions WHERE actor_id = ? ORDER BY executed_at DESC LIMIT 30`;
    const rows = (procedureId ? db.prepare(sql).all(actorId, procedureId) : db.prepare(sql).all(actorId)) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapExec(r));
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
   * Never autonomously modifies underlying LLM weights.
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
      approvedByUser: Number(row.approved_by_user ?? 0) === 1,
      evidence: JSON.parse(String(row.evidence_json || '[]')),
      version: Number(row.version ?? 1),
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
      sourceRef: String(row.source_ref || 'workflow'),
      scope: String(row.scope || 'actor'),
      requiredPermissions: JSON.parse(String(row.required_permissions_json || '[]')),
      version: Number(row.version ?? 1),
      requiresApproval: Number(row.requires_approval) === 1,
      approvedByUser: Number(row.approved_by_user) === 1,
      approvedAt: row.approved_at ? String(row.approved_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapExec(row: Record<string, unknown>): ProcedureExecutionRecord {
    return {
      id: String(row.id),
      procedureId: String(row.procedure_id),
      actorId: String(row.actor_id),
      authorized: Number(row.authorized) === 1,
      status: row.status as ProcedureExecutionRecord['status'],
      output: String(row.output || ''),
      executedAt: String(row.executed_at),
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
