// ============================================================
// FRIDAY — Memory Store
// SQLite-backed persistent memory, migrations, audit & context
// ============================================================

import * as path from 'path';
import * as fs from 'fs';
import { createLayerLogger } from '../shared/logger';
import { getConfig } from '../shared/config';
import { eventBus } from '../shared/events';
import { MemoryEntry, FridayId } from '../shared/types';
import { runMigrations } from './migrations';
import { redactSecrets, containsSensitiveCredential } from './redaction';
import {
  PersonalityProfile,
  DEFAULT_PERSONALITY_PROFILE,
} from '../intelligence/personality';
import {
  DigitalIdentitySettings,
  LOCKED_IDENTITY_DEFAULTS,
  PersonalityMode,
  CommunicationStyle,
  ResponseDepthMode,
} from '../personality/personalityTypes';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';

const log = createLayerLogger('Memory');

export class MemoryStore {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(customDbPath?: string) {
    this.dbPath = customDbPath || getConfig().dbPath;
  }

  /** Initialize the database connection and run versioned migrations */
  async initialize(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      const DatabaseCtor = (await import('better-sqlite3')).default;
      this.db = new DatabaseCtor(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      runMigrations(this.db);
      log.info('Memory database initialized', { path: this.dbPath });
    } catch (error) {
      log.error('Failed to initialize memory database', { error: (error as Error).message });
      log.warn('Memory will run in volatile (in-memory) mode');
    }
  }

  /** Expose underlying SQLite database for domain repositories */
  getDatabase(): Database.Database | null {
    return this.db;
  }

  /** Store a memory entry (redacting any accidental secrets) */
  store(
    type: MemoryEntry['type'],
    key: string,
    value: string,
    metadata: Record<string, string> = {}
  ): FridayId {
    if (containsSensitiveCredential(value)) {
      throw new Error('Refusing to store plaintext passwords, API keys, or auth tokens in memory.');
    }

    const id = uuidv4();
    const safeKey = redactSecrets(key);
    const safeValue = redactSecrets(value);

    if (this.db) {
      const stmt = this.db.prepare(
        `INSERT INTO memories (id, type, key, value, metadata) VALUES (?, ?, ?, ?, ?)`
      );
      stmt.run(id, type, safeKey, safeValue, JSON.stringify(metadata));
    }

    eventBus.emitEvent('memory:stored', safeKey, type);
    log.debug(`Stored memory: [${type}] ${safeKey}`, { id });
    return id;
  }

  /** Update an existing memory entry */
  updateMemory(id: string, value: string): boolean {
    if (!this.db) return false;
    if (containsSensitiveCredential(value)) {
      throw new Error('Refusing to store plaintext passwords, API keys, or auth tokens in memory.');
    }
    const safeValue = redactSecrets(value);
    const info = this.db
      .prepare(`UPDATE memories SET value = ?, last_accessed_at = datetime('now') WHERE id = ?`)
      .run(safeValue, id);
    return info.changes > 0;
  }

  /** Delete an individual memory entry */
  deleteMemory(id: string): boolean {
    if (!this.db) return false;
    const info = this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  /** Prune memories older than N days (configurable retention) */
  pruneMemories(retentionDays: number): number {
    if (!this.db || retentionDays <= 0) return 0;
    const info = this.db
      .prepare(
        `DELETE FROM memories WHERE type != 'preference' AND datetime(last_accessed_at) < datetime('now', ?)`
      )
      .run(`-${retentionDays} days`);
    return info.changes;
  }

  /** Retrieve memories by type and optional key pattern */
  retrieve(
    type?: MemoryEntry['type'],
    keyPattern?: string,
    limit = 20
  ): MemoryEntry[] {
    if (!this.db) return [];

    let sql = 'SELECT * FROM memories WHERE 1=1';
    const params: unknown[] = [];

    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    if (keyPattern) {
      sql += ' AND key LIKE ?';
      params.push(`%${keyPattern}%`);
    }

    sql += ' ORDER BY last_accessed_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      type: string;
      key: string;
      value: string;
      metadata: string;
      created_at: string;
      last_accessed_at: string;
      access_count: number;
    }>;

    const results = rows.map((row) => ({
      id: row.id,
      type: row.type as MemoryEntry['type'],
      key: row.key,
      value: row.value,
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
      accessCount: row.access_count,
    }));

    eventBus.emitEvent('memory:retrieved', keyPattern || '*', results.length);
    return results;
  }

  /** Search memories using keyword matching */
  search(query: string, limit = 10): MemoryEntry[] {
    if (!this.db || !query.trim()) return [];

    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);

    if (keywords.length === 0) return [];

    const conditions = keywords.map(() => '(LOWER(key) LIKE ? OR LOWER(value) LIKE ?)');
    const params: string[] = [];
    for (const kw of keywords) {
      params.push(`%${kw}%`, `%${kw}%`);
    }

    const sql = `
      SELECT *, (${keywords
        .map(() => `(CASE WHEN LOWER(key) LIKE ? THEN 1 ELSE 0 END + CASE WHEN LOWER(value) LIKE ? THEN 1 ELSE 0 END)`)
        .join(' + ')}) AS relevance
      FROM memories
      WHERE ${conditions.join(' OR ')}
      ORDER BY relevance DESC, last_accessed_at DESC
      LIMIT ?
    `;

    const allParams = [...params, ...params, limit];

    try {
      const rows = this.db.prepare(sql).all(...allParams) as Array<{
        id: string;
        type: string;
        key: string;
        value: string;
        metadata: string;
        created_at: string;
        last_accessed_at: string;
        access_count: number;
      }>;

      return rows.map((row) => ({
        id: row.id,
        type: row.type as MemoryEntry['type'],
        key: row.key,
        value: row.value,
        metadata: JSON.parse(row.metadata || '{}'),
        createdAt: row.created_at,
        lastAccessedAt: row.last_accessed_at,
        accessCount: row.access_count,
      }));
    } catch (error) {
      log.error('Memory search failed', { error: (error as Error).message });
      return [];
    }
  }

  /**
   * Build a bounded, relevant context string for LLM calls
   * without injecting the entire database.
   */
  getRelevantContext(query: string, maxItems = 6): string {
    if (!this.db) return '';
    const prefs = this.retrieve('preference', undefined, 4);
    const matched = this.search(query, maxItems);
    const seen = new Set<string>();
    const combined: MemoryEntry[] = [];
    for (const entry of [...prefs, ...matched]) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        combined.push(entry);
      }
      if (combined.length >= maxItems) break;
    }
    return combined.map((m) => `- [${m.type}] ${m.key}: ${m.value}`).join('\n');
  }

  /** Load or initialize personality profile */
  getPersonalityProfile(): PersonalityProfile {
    if (!this.db) return { ...DEFAULT_PERSONALITY_PROFILE };
    const row = this.db
      .prepare(`SELECT user_name, formality, humor, verbosity, timezone FROM personality_profile WHERE id = 'default'`)
      .get() as
      | {
          user_name: string;
          formality: PersonalityProfile['formality'];
          humor: PersonalityProfile['humor'];
          verbosity: PersonalityProfile['verbosity'];
          timezone: string;
        }
      | undefined;

    if (!row) {
      this.savePersonalityProfile(DEFAULT_PERSONALITY_PROFILE);
      return { ...DEFAULT_PERSONALITY_PROFILE };
    }

    return {
      userName: row.user_name,
      formality: row.formality,
      humor: row.humor,
      verbosity: row.verbosity,
      timezone: row.timezone,
    };
  }

  /** Save personality profile */
  savePersonalityProfile(profile: Partial<PersonalityProfile>): PersonalityProfile {
    const current = this.db
      ? (this.db
          .prepare(`SELECT user_name, formality, humor, verbosity, timezone FROM personality_profile WHERE id = 'default'`)
          .get() as
          | {
              user_name: string;
              formality: PersonalityProfile['formality'];
              humor: PersonalityProfile['humor'];
              verbosity: PersonalityProfile['verbosity'];
              timezone: string;
            }
          | undefined)
      : undefined;

    const merged: PersonalityProfile = {
      userName: profile.userName ?? current?.user_name ?? DEFAULT_PERSONALITY_PROFILE.userName,
      formality: profile.formality ?? current?.formality ?? DEFAULT_PERSONALITY_PROFILE.formality,
      humor: profile.humor ?? current?.humor ?? DEFAULT_PERSONALITY_PROFILE.humor,
      verbosity: profile.verbosity ?? current?.verbosity ?? DEFAULT_PERSONALITY_PROFILE.verbosity,
      timezone: profile.timezone ?? current?.timezone ?? DEFAULT_PERSONALITY_PROFILE.timezone,
    };

    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO personality_profile (id, user_name, formality, humor, verbosity, timezone, updated_at)
           VALUES ('default', ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             user_name = excluded.user_name,
             formality = excluded.formality,
             humor = excluded.humor,
             verbosity = excluded.verbosity,
             timezone = excluded.timezone,
             updated_at = datetime('now')`
        )
        .run(merged.userName, merged.formality, merged.humor, merged.verbosity, merged.timezone);
    }

    return merged;
  }

  /** Log a conversation message (with secret redaction, actor, and channel) */
  logConversation(
    role: 'user' | 'assistant' | 'system',
    content: string,
    intentAction?: string,
    sessionId?: string,
    actorId = 'local',
    channel = 'text'
  ): void {
    if (!this.db) return;

    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO conversations (id, role, content, intent_action, session_id, actor_id, channel)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, role, redactSecrets(content), intentAction || null, sessionId || null, actorId, channel);
  }

  /** Log a task execution result */
  logTask(
    intentId: string,
    action: string,
    input: string,
    output: string,
    success: boolean,
    risk: string,
    executor: string,
    durationMs: number
  ): void {
    if (!this.db) return;

    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO task_log (id, intent_id, action, input, output, success, risk, executor, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        intentId,
        action,
        redactSecrets(input),
        redactSecrets(output),
        success ? 1 : 0,
        risk,
        executor,
        durationMs
      );
  }

  /** Record a security/tool audit log entry */
  logAudit(
    actor: string,
    action: string,
    resource: string,
    risk: string,
    success: boolean,
    details = ''
  ): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO audit_logs (id, actor, action, resource, risk, success, details) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(uuidv4(), actor, action, resource, risk, success ? 1 : 0, redactSecrets(details));
  }

  /** Retrieve recent audit logs */
  getAuditLogs(limit = 50): Array<{
    id: string;
    actor: string;
    action: string;
    resource: string;
    risk: string;
    success: boolean;
    details: string;
    createdAt: string;
  }> {
    if (!this.db) return [];
    const rows = this.db
      .prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Array<{
      id: string;
      actor: string;
      action: string;
      resource: string;
      risk: string;
      success: number;
      details: string;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      action: r.action,
      resource: r.resource,
      risk: r.risk,
      success: r.success === 1,
      details: r.details,
      createdAt: r.created_at,
    }));
  }

  /** Get recent conversation history (optionally scoped by session and actor) */
  getRecentConversations(
    limit = 20,
    sessionId?: string,
    actorId?: string
  ): Array<{
    role: string;
    content: string;
    action?: string;
    channel?: string;
    createdAt: string;
  }> {
    if (!this.db) return [];

    let sql = 'SELECT role, content, intent_action, channel, created_at FROM conversations WHERE 1=1';
    const params: unknown[] = [];

    if (sessionId) {
      sql += ' AND session_id = ?';
      params.push(sessionId);
    }
    if (actorId) {
      sql += ' AND actor_id = ?';
      params.push(actorId);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      role: string;
      content: string;
      intent_action: string | null;
      channel: string | null;
      created_at: string;
    }>;

    return rows
      .map((row) => ({
        role: row.role,
        content: row.content,
        action: row.intent_action || undefined,
        channel: row.channel || undefined,
        createdAt: row.created_at,
      }))
      .reverse();
  }

  // ---- Phase 13: Digital Identity Settings & Actor-Isolated Categorized Memory ----

  getDigitalIdentitySettings(actorId = 'default'): DigitalIdentitySettings {
    if (!this.db) {
      return { actorId, ...LOCKED_IDENTITY_DEFAULTS };
    }
    const row = this.db
      .prepare(
        `SELECT actor_id, default_personality, communication_style, answer_detail,
                voice_concise_mode, conversation_continuity, memory_auto_learn, updated_at
         FROM digital_identity_settings WHERE actor_id = ?`
      )
      .get(actorId) as
      | {
          actor_id: string;
          default_personality: PersonalityMode;
          communication_style: CommunicationStyle;
          answer_detail: ResponseDepthMode;
          voice_concise_mode: number;
          conversation_continuity: number;
          memory_auto_learn: number;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      const defaults: DigitalIdentitySettings = { actorId, ...LOCKED_IDENTITY_DEFAULTS };
      this.saveDigitalIdentitySettings(actorId, defaults);
      return defaults;
    }

    return {
      actorId: row.actor_id,
      defaultPersonality: row.default_personality,
      communicationStyle: row.communication_style,
      answerDetail: row.answer_detail,
      voiceConciseMode: row.voice_concise_mode === 1,
      conversationContinuity: row.conversation_continuity === 1,
      memoryAutoLearn: row.memory_auto_learn === 1,
      updatedAt: row.updated_at,
    };
  }

  saveDigitalIdentitySettings(
    actorId = 'default',
    partial: Partial<Omit<DigitalIdentitySettings, 'actorId' | 'updatedAt'>>
  ): DigitalIdentitySettings {
    const current = this.db
      ? (this.db
          .prepare(`SELECT * FROM digital_identity_settings WHERE actor_id = ?`)
          .get(actorId) as Record<string, unknown> | undefined)
      : undefined;

    const merged: DigitalIdentitySettings = {
      actorId,
      defaultPersonality:
        partial.defaultPersonality ??
        (current?.default_personality as PersonalityMode) ??
        LOCKED_IDENTITY_DEFAULTS.defaultPersonality,
      communicationStyle:
        partial.communicationStyle ??
        (current?.communication_style as CommunicationStyle) ??
        LOCKED_IDENTITY_DEFAULTS.communicationStyle,
      answerDetail:
        partial.answerDetail ??
        (current?.answer_detail as ResponseDepthMode) ??
        LOCKED_IDENTITY_DEFAULTS.answerDetail,
      voiceConciseMode:
        partial.voiceConciseMode ??
        (current ? Number(current.voice_concise_mode) === 1 : LOCKED_IDENTITY_DEFAULTS.voiceConciseMode),
      conversationContinuity:
        partial.conversationContinuity ??
        (current ? Number(current.conversation_continuity) === 1 : LOCKED_IDENTITY_DEFAULTS.conversationContinuity),
      memoryAutoLearn:
        partial.memoryAutoLearn ??
        (current ? Number(current.memory_auto_learn) === 1 : LOCKED_IDENTITY_DEFAULTS.memoryAutoLearn),
    };

    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO digital_identity_settings (
             actor_id, default_personality, communication_style, answer_detail,
             voice_concise_mode, conversation_continuity, memory_auto_learn, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(actor_id) DO UPDATE SET
             default_personality = excluded.default_personality,
             communication_style = excluded.communication_style,
             answer_detail = excluded.answer_detail,
             voice_concise_mode = excluded.voice_concise_mode,
             conversation_continuity = excluded.conversation_continuity,
             memory_auto_learn = excluded.memory_auto_learn,
             updated_at = datetime('now')`
        )
        .run(
          actorId,
          merged.defaultPersonality,
          merged.communicationStyle,
          merged.answerDetail,
          merged.voiceConciseMode ? 1 : 0,
          merged.conversationContinuity ? 1 : 0,
          merged.memoryAutoLearn ? 1 : 0
        );
    }

    return merged;
  }

  getConversationContextState(
    actorId: string,
    conversationId: string
  ): {
    activeTopic: string;
    activePersonality: PersonalityMode;
    temporaryPersonality: PersonalityMode | null;
    temporaryDepth: ResponseDepthMode | null;
    updatedAt?: string;
  } {
    if (!this.db) {
      return {
        activeTopic: '',
        activePersonality: 'ADAPTIVE',
        temporaryPersonality: null,
        temporaryDepth: null,
      };
    }
    const row = this.db
      .prepare(
        `SELECT active_topic, active_personality, temporary_personality, temporary_depth, updated_at
         FROM conversation_context_state WHERE actor_id = ? AND conversation_id = ?`
      )
      .get(actorId, conversationId) as
      | {
          active_topic: string;
          active_personality: PersonalityMode;
          temporary_personality: PersonalityMode | null;
          temporary_depth: ResponseDepthMode | null;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return {
        activeTopic: '',
        activePersonality: 'ADAPTIVE',
        temporaryPersonality: null,
        temporaryDepth: null,
      };
    }

    return {
      activeTopic: row.active_topic || '',
      activePersonality: row.active_personality || 'ADAPTIVE',
      temporaryPersonality: row.temporary_personality || null,
      temporaryDepth: row.temporary_depth || null,
      updatedAt: row.updated_at,
    };
  }

  saveConversationContextState(
    actorId: string,
    conversationId: string,
    update: {
      activeTopic?: string;
      activePersonality?: PersonalityMode;
      temporaryPersonality?: PersonalityMode | null;
      temporaryDepth?: ResponseDepthMode | null;
    }
  ): void {
    if (!this.db) return;
    const current = this.getConversationContextState(actorId, conversationId);
    const nextTopic = update.activeTopic !== undefined ? update.activeTopic : current.activeTopic;
    const nextActive = update.activePersonality !== undefined ? update.activePersonality : current.activePersonality;
    const nextTempP =
      update.temporaryPersonality !== undefined ? update.temporaryPersonality : current.temporaryPersonality;
    const nextTempD = update.temporaryDepth !== undefined ? update.temporaryDepth : current.temporaryDepth;

    this.db
      .prepare(
        `INSERT INTO conversation_context_state (
           actor_id, conversation_id, active_topic, active_personality,
           temporary_personality, temporary_depth, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(actor_id, conversation_id) DO UPDATE SET
           active_topic = excluded.active_topic,
           active_personality = excluded.active_personality,
           temporary_personality = excluded.temporary_personality,
           temporary_depth = excluded.temporary_depth,
           updated_at = datetime('now')`
      )
      .run(actorId, conversationId, nextTopic, nextActive, nextTempP, nextTempD);
  }

  /**
   * Store categorized, actor-isolated memory with provenance & conflict resolution.
   * For preference, project, and knowledge categories, updating the same (actorId, category, key)
   * resolves conflicts cleanly rather than leaving stale duplicates.
   */
  storeIdentityMemory(params: {
    actorId: string;
    type: MemoryEntry['type'];
    category: 'conversation' | 'preference' | 'knowledge' | 'project' | 'task_temp';
    key: string;
    value: string;
    provenance?: string;
    confidence?: number;
    metadata?: Record<string, string>;
  }): FridayId {
    if (containsSensitiveCredential(params.value)) {
      throw new Error('Refusing to store plaintext passwords, API keys, or auth tokens in memory.');
    }

    const safeKey = redactSecrets(params.key.trim());
    const safeValue = redactSecrets(params.value.trim());
    const provenance = params.provenance || 'conversation';
    const confidence = Math.max(0, Math.min(1, params.confidence ?? 0.9));

    if (this.db) {
      if (params.category === 'preference' || params.category === 'project' || params.category === 'knowledge') {
        const existing = this.db
          .prepare(
            `SELECT id FROM memories WHERE actor_id = ? AND category = ? AND LOWER(key) = LOWER(?) LIMIT 1`
          )
          .get(params.actorId, params.category, safeKey) as { id: string } | undefined;

        if (existing) {
          this.db
            .prepare(
              `UPDATE memories
               SET value = ?, provenance = ?, confidence = ?, metadata = ?,
                   updated_at = datetime('now'), last_accessed_at = datetime('now'), access_count = access_count + 1
               WHERE id = ? AND actor_id = ?`
            )
            .run(
              safeValue,
              provenance,
              confidence,
              JSON.stringify(params.metadata || {}),
              existing.id,
              params.actorId
            );
          return existing.id;
        }
      }

      const id = uuidv4();
      this.db
        .prepare(
          `INSERT INTO memories (id, type, key, value, metadata, actor_id, category, provenance, confidence, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .run(
          id,
          params.type,
          safeKey,
          safeValue,
          JSON.stringify(params.metadata || {}),
          params.actorId,
          params.category,
          provenance,
          confidence
        );
      return id;
    }

    return uuidv4();
  }

  retrieveIdentityMemories(
    actorId: string,
    category?: 'conversation' | 'preference' | 'knowledge' | 'project' | 'task_temp',
    limit = 15
  ): Array<MemoryEntry & { actorId: string; category: string; provenance: string; confidence: number }> {
    if (!this.db) return [];
    let sql = 'SELECT * FROM memories WHERE actor_id = ?';
    const params: unknown[] = [actorId];
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    sql += ' ORDER BY last_accessed_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      type: String(row.type) as MemoryEntry['type'],
      key: String(row.key),
      value: String(row.value),
      metadata: JSON.parse(String(row.metadata || '{}')),
      createdAt: String(row.created_at),
      lastAccessedAt: String(row.last_accessed_at),
      accessCount: Number(row.access_count || 0),
      actorId: String(row.actor_id || 'local'),
      category: String(row.category || 'knowledge'),
      provenance: String(row.provenance || 'conversation'),
      confidence: Number(row.confidence ?? 0.9),
    }));
  }

  searchIdentityMemories(
    actorId: string,
    query: string,
    limit = 8
  ): Array<MemoryEntry & { actorId: string; category: string; provenance: string; confidence: number }> {
    if (!this.db || !query.trim()) return [];
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    if (keywords.length === 0) return [];

    const conditions = keywords.map(() => '(LOWER(key) LIKE ? OR LOWER(value) LIKE ?)');
    const kwParams: string[] = [];
    for (const kw of keywords) {
      kwParams.push(`%${kw}%`, `%${kw}%`);
    }

    const sql = `
      SELECT * FROM memories
      WHERE actor_id = ? AND (${conditions.join(' OR ')})
      ORDER BY last_accessed_at DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(actorId, ...kwParams, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      type: String(row.type) as MemoryEntry['type'],
      key: String(row.key),
      value: String(row.value),
      metadata: JSON.parse(String(row.metadata || '{}')),
      createdAt: String(row.created_at),
      lastAccessedAt: String(row.last_accessed_at),
      accessCount: Number(row.access_count || 0),
      actorId: String(row.actor_id || 'local'),
      category: String(row.category || 'knowledge'),
      provenance: String(row.provenance || 'conversation'),
      confidence: Number(row.confidence ?? 0.9),
    }));
  }

  updateMemoryForActor(actorId: string, id: string, value: string): boolean {
    if (!this.db) return false;
    if (containsSensitiveCredential(value)) {
      throw new Error('Refusing to store plaintext passwords, API keys, or auth tokens in memory.');
    }
    const info = this.db
      .prepare(
        `UPDATE memories SET value = ?, updated_at = datetime('now'), last_accessed_at = datetime('now')
         WHERE id = ? AND actor_id = ?`
      )
      .run(redactSecrets(value), id, actorId);
    return info.changes > 0;
  }

  deleteMemoryForActor(actorId: string, id: string): boolean {
    if (!this.db) return false;
    const info = this.db.prepare(`DELETE FROM memories WHERE id = ? AND actor_id = ?`).run(id, actorId);
    return info.changes > 0;
  }

  /** Get memory statistics */
  getStats(): { totalMemories: number; totalTasks: number; totalConversations: number } {
    if (!this.db) return { totalMemories: 0, totalTasks: 0, totalConversations: 0 };

    const memCount = this.db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number };
    const taskCount = this.db.prepare('SELECT COUNT(*) as c FROM task_log').get() as { c: number };
    const convCount = this.db.prepare('SELECT COUNT(*) as c FROM conversations').get() as { c: number };

    return {
      totalMemories: memCount.c,
      totalTasks: taskCount.c,
      totalConversations: convCount.c,
    };
  }

  /** Create a hot SQLite backup to a target path and verify its integrity */
  async backupDatabase(destPath: string): Promise<string> {
    if (!this.db) {
      throw new Error('Database is not initialized.');
    }
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await this.db.backup(destPath);
    const check = await this.verifyBackup(destPath);
    if (!check.ok) {
      throw new Error(`Backup verification failed: ${check.error}`);
    }
    return destPath;
  }

  /** Verify SQLite integrity of a backup file without mutating the live DB */
  async verifyBackup(backupPath: string): Promise<{ ok: boolean; error?: string }> {
    if (!fs.existsSync(backupPath)) {
      return { ok: false, error: 'Backup file does not exist' };
    }
    let testDb: Database.Database | null = null;
    try {
      const DatabaseCtor = (await import('better-sqlite3')).default;
      testDb = new DatabaseCtor(backupPath, { readonly: true, fileMustExist: true });
      const row = testDb.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
      if (row?.integrity_check !== 'ok') {
        return { ok: false, error: `Integrity check returned: ${row?.integrity_check}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      testDb?.close();
    }
  }

  /** Safely restore from a verified backup, saving a pre-restore snapshot first */
  async restoreDatabase(backupPath: string): Promise<{ restored: boolean; safetyBackupPath: string }> {
    const check = await this.verifyBackup(backupPath);
    if (!check.ok) {
      throw new Error(`Cannot restore corrupted or invalid backup: ${check.error}`);
    }
    const currentDbPath = this.dbPath;
    const safetyBackupPath = `${currentDbPath}.pre-restore-${Date.now()}.bak`;
    if (this.db) {
      await this.db.backup(safetyBackupPath);
      this.close();
    }
    fs.copyFileSync(backupPath, currentDbPath);
    await this.initialize();
    return { restored: true, safetyBackupPath };
  }

  /** Close the database connection */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      log.info('Memory database closed');
    }
  }
}

/** Singleton instance */
let _store: MemoryStore | null = null;

export async function getMemoryStore(): Promise<MemoryStore> {
  if (!_store) {
    _store = new MemoryStore();
    await _store.initialize();
  }
  return _store;
}
