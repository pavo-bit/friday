// ============================================================
// FRIDAY — Memory Store
// SQLite-backed persistent memory for conversations, prefs, contacts
// ============================================================

import * as path from 'path';
import * as fs from 'fs';
import { createLayerLogger } from '../shared/logger';
import { getConfig } from '../shared/config';
import { eventBus } from '../shared/events';
import { MemoryEntry, FridayId } from '../shared/types';
import { v4 as uuidv4 } from 'uuid';

const log = createLayerLogger('Memory');

/** SQL schema for the FRIDAY database */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('conversation', 'task', 'preference', 'contact', 'fact')),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
    access_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
  CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
  CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

  CREATE TABLE IF NOT EXISTS task_log (
    id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL,
    action TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT,
    success INTEGER NOT NULL DEFAULT 0,
    risk TEXT NOT NULL,
    executor TEXT NOT NULL,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_task_log_created ON task_log(created_at);

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    intent_action TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at);
`;

/**
 * MemoryStore — FRIDAY's persistent brain.
 *
 * Stores conversations, task history, user preferences, contacts,
 * and factual knowledge in a SQLite database. Supports simple
 * keyword-based retrieval (expandable to vector search later).
 */
export class MemoryStore {
  private db: import('better-sqlite3').Database | null = null;
  private dbPath: string;

  constructor() {
    this.dbPath = getConfig().dbPath;
  }

  /** Initialize the database connection and create schema */
  async initialize(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      // Dynamic import to handle the native module gracefully
      const Database = (await import('better-sqlite3')).default;
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.exec(SCHEMA);
      log.info('Memory database initialized', { path: this.dbPath });
    } catch (error) {
      log.error('Failed to initialize memory database', { error: (error as Error).message });
      log.warn('Memory will run in volatile (in-memory) mode');
      // Fall through — methods will check for null db
    }
  }

  /** Store a memory entry */
  store(
    type: MemoryEntry['type'],
    key: string,
    value: string,
    metadata: Record<string, string> = {}
  ): FridayId {
    const id = uuidv4();

    if (this.db) {
      const stmt = this.db.prepare(
        `INSERT INTO memories (id, type, key, value, metadata) VALUES (?, ?, ?, ?, ?)`
      );
      stmt.run(id, type, key, value, JSON.stringify(metadata));
    }

    eventBus.emitEvent('memory:stored', key, type);
    log.debug(`Stored memory: [${type}] ${key}`, { id });
    return id;
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

  /** Search memories using keyword matching (RAG-lite) */
  search(query: string, limit = 10): MemoryEntry[] {
    if (!this.db || !query.trim()) return [];

    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);

    if (keywords.length === 0) return [];

    // Build a LIKE-based search (upgradable to FTS5 later)
    const conditions = keywords.map(() => '(LOWER(key) LIKE ? OR LOWER(value) LIKE ?)');
    const params: string[] = [];
    for (const kw of keywords) {
      params.push(`%${kw}%`, `%${kw}%`);
    }

    const sql = `
      SELECT *, (${keywords.map(() => `(CASE WHEN LOWER(key) LIKE ? THEN 1 ELSE 0 END + CASE WHEN LOWER(value) LIKE ? THEN 1 ELSE 0 END)`).join(' + ')}) AS relevance
      FROM memories
      WHERE ${conditions.join(' OR ')}
      ORDER BY relevance DESC, last_accessed_at DESC
      LIMIT ?
    `;

    // Add relevance scoring params
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

  /** Log a conversation message */
  logConversation(
    role: 'user' | 'assistant' | 'system',
    content: string,
    intentAction?: string,
    sessionId?: string
  ): void {
    if (!this.db) return;

    const id = uuidv4();
    const stmt = this.db.prepare(
      `INSERT INTO conversations (id, role, content, intent_action, session_id) VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(id, role, content, intentAction || null, sessionId || null);
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
    const stmt = this.db.prepare(
      `INSERT INTO task_log (id, intent_id, action, input, output, success, risk, executor, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(id, intentId, action, input, output, success ? 1 : 0, risk, executor, durationMs);
  }

  /** Get recent conversation history */
  getRecentConversations(limit = 20, sessionId?: string): Array<{
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

    return rows.map((row) => ({
      role: row.role,
      content: row.content,
      action: row.intent_action || undefined,
      createdAt: row.created_at,
    })).reverse();
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
