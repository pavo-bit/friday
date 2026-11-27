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

  /** Log a conversation message (with secret redaction) */
  logConversation(
    role: 'user' | 'assistant' | 'system',
    content: string,
    intentAction?: string,
    sessionId?: string
  ): void {
    if (!this.db) return;

    const id = uuidv4();
    this.db
      .prepare(`INSERT INTO conversations (id, role, content, intent_action, session_id) VALUES (?, ?, ?, ?, ?)`)
      .run(id, role, redactSecrets(content), intentAction || null, sessionId || null);
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

  /** Get recent conversation history */
  getRecentConversations(
    limit = 20,
    sessionId?: string
  ): Array<{
    role: string;
    content: string;
    action?: string;
    createdAt: string;
  }> {
    if (!this.db) return [];

    let sql = 'SELECT role, content, intent_action, created_at FROM conversations';
    const params: unknown[] = [];

    if (sessionId) {
      sql += ' WHERE session_id = ?';
      params.push(sessionId);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      role: string;
      content: string;
      intent_action: string | null;
      created_at: string;
    }>;

    return rows
      .map((row) => ({
        role: row.role,
        content: row.content,
        action: row.intent_action || undefined,
        createdAt: row.created_at,
      }))
      .reverse();
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
