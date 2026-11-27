// ============================================================
// FRIDAY — SQLite Schema Migrations
// Versioned, transactional schema evolution
// ============================================================

import type Database from 'better-sqlite3';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('Migrations');

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_memory_and_logs',
    sql: `
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
    `,
  },
  {
    version: 2,
    name: 'personality_monitoring_scheduler_locations_security',
    sql: `
      CREATE TABLE IF NOT EXISTS personality_profile (
        id TEXT PRIMARY KEY DEFAULT 'default',
        user_name TEXT NOT NULL DEFAULT 'User',
        formality TEXT NOT NULL DEFAULT 'balanced' CHECK(formality IN ('formal', 'balanced', 'casual')),
        humor TEXT NOT NULL DEFAULT 'subtle' CHECK(humor IN ('none', 'subtle', 'playful')),
        verbosity TEXT NOT NULL DEFAULT 'concise' CHECK(verbosity IN ('concise', 'balanced', 'detailed')),
        timezone TEXT NOT NULL DEFAULT 'UTC',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS locations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        radius_meters INTEGER NOT NULL DEFAULT 150,
        address TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT DEFAULT '',
        due_at TEXT,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        recurrence TEXT DEFAULT 'none' CHECK(recurrence IN ('none', 'daily', 'weekly', 'monthly')),
        weekday INTEGER,
        location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
        trigger_on TEXT DEFAULT 'time' CHECK(trigger_on IN ('time', 'enter', 'exit')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'triggered', 'completed', 'cancelled')),
        is_alarm INTEGER NOT NULL DEFAULT 0,
        last_triggered_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at);

      CREATE TABLE IF NOT EXISTS watchers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        target_url TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'http_health' CHECK(method IN ('http_health', 'prometheus', 'grafana', 'json_api', 'postgres', 'redis')),
        interval_ms INTEGER NOT NULL DEFAULT 60000,
        timeout_ms INTEGER NOT NULL DEFAULT 5000,
        failure_threshold INTEGER NOT NULL DEFAULT 2,
        metric_query TEXT DEFAULT '',
        metric_threshold REAL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'stopped')),
        health TEXT NOT NULL DEFAULT 'unknown' CHECK(health IN ('healthy', 'degraded', 'offline', 'unknown')),
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_check_at TEXT,
        last_success_at TEXT,
        last_failure_at TEXT,
        last_error TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_watchers_status ON watchers(status);

      CREATE TABLE IF NOT EXISTS monitoring_history (
        id TEXT PRIMARY KEY,
        watcher_id TEXT NOT NULL REFERENCES watchers(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('healthy', 'degraded', 'offline')),
        status_code INTEGER,
        latency_ms INTEGER,
        message TEXT DEFAULT '',
        alert_sent INTEGER NOT NULL DEFAULT 0,
        checked_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_monitoring_history_watcher ON monitoring_history(watcher_id);
      CREATE INDEX IF NOT EXISTS idx_monitoring_history_checked ON monitoring_history(checked_at);

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'critical')),
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'system',
        dedupe_key TEXT,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);
      CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'android',
        token_hash TEXT NOT NULL,
        push_token TEXT,
        location_opt_in INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL DEFAULT 'user',
        action TEXT NOT NULL,
        resource TEXT DEFAULT '',
        risk TEXT NOT NULL DEFAULT 'low',
        success INTEGER NOT NULL DEFAULT 1,
        details TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
    `,
  },
  {
    version: 3,
    name: 'background_orchestrator_tasks',
    sql: `
      CREATE TABLE IF NOT EXISTS background_tasks (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL DEFAULT 'local',
        conversation_id TEXT,
        idempotency_key TEXT UNIQUE,
        status TEXT NOT NULL CHECK(status IN (
          'RECEIVED','QUEUED','RUNNING','WAITING_FOR_APPROVAL',
          'VERIFYING','COMPLETED','FAILED','CANCELLED','TIMED_OUT','INTERRUPTED'
        )),
        task_class TEXT NOT NULL DEFAULT 'lightweight' CHECK(task_class IN ('lightweight','ai_intensive','llm_generation')),
        priority INTEGER NOT NULL DEFAULT 5,
        original_request TEXT NOT NULL,
        execution_plan_json TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT,
        error_code TEXT,
        error_message TEXT,
        timeout_ms INTEGER NOT NULL DEFAULT 60000,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_bg_tasks_status ON background_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_bg_tasks_owner ON background_tasks(owner_id);
      CREATE INDEX IF NOT EXISTS idx_bg_tasks_created ON background_tasks(created_at);

      CREATE TABLE IF NOT EXISTS task_steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES background_tasks(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'PENDING','QUEUED','RUNNING','WAITING_FOR_APPROVAL',
          'COMPLETED','FAILED','CANCELLED','TIMED_OUT','INTERRUPTED','SKIPPED'
        )),
        arguments_json TEXT NOT NULL DEFAULT '{}',
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        execution_order INTEGER NOT NULL DEFAULT 0,
        idempotent INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_steps_status ON task_steps(status);

      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES background_tasks(id) ON DELETE CASCADE,
        step_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_events_created ON task_events(created_at);
    `,
  },
  {
    version: 4,
    name: 'persistent_capability_approvals_and_device_revocation',
    sql: `
      ALTER TABLE devices ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE devices ADD COLUMN token_expires_at TEXT;

      CREATE TABLE IF NOT EXISTS capability_approvals (
        approval_id TEXT PRIMARY KEY,
        task_id TEXT,
        step_id TEXT,
        capability_id TEXT NOT NULL,
        action_hash TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        permission_scope TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        summary TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution TEXT,
        resolved_by TEXT,
        consumed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_task_step ON capability_approvals(task_id, step_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status_expires ON capability_approvals(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_actor ON capability_approvals(actor_id);
    `,
  },
  {
    version: 5,
    name: 'presentations_and_verification_state',
    sql: `
      CREATE TABLE IF NOT EXISTS presentations (
        presentation_id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES background_tasks(id) ON DELETE CASCADE,
        conversation_id TEXT,
        owner_id TEXT NOT NULL DEFAULT 'local',
        presentation_type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}',
        verification_status TEXT NOT NULL,
        provenance_json TEXT NOT NULL DEFAULT '[]',
        actions_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_presentations_task ON presentations(task_id);
      CREATE INDEX IF NOT EXISTS idx_presentations_owner ON presentations(owner_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_presentations_conv ON presentations(conversation_id);
    `,
  },
];

/**
 * Run all pending schema migrations inside transactions.
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    const applyTx = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name
      );
    });

    applyTx();
    log.info(`Applied migration v${migration.version}: ${migration.name}`);
  }
}
