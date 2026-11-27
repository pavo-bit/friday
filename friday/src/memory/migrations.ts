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
  {
    version: 6,
    name: 'financial_intelligence_foundation',
    sql: `
      CREATE TABLE IF NOT EXISTS financial_profiles (
        owner_id TEXT PRIMARY KEY,
        default_currency TEXT NOT NULL DEFAULT 'INR',
        monthly_income_target_minor INTEGER NOT NULL DEFAULT 0,
        emergency_fund_months INTEGER NOT NULL DEFAULT 6,
        risk_profile TEXT NOT NULL DEFAULT 'moderate',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS financial_accounts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        account_type TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'INR',
        balance_minor INTEGER NOT NULL DEFAULT 0,
        source_classification TEXT NOT NULL DEFAULT 'USER_ENTERED',
        source_name TEXT NOT NULL DEFAULT 'User Input',
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_fin_accounts_owner ON financial_accounts(owner_id);

      CREATE TABLE IF NOT EXISTS financial_account_snapshots (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        balance_minor INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'INR',
        source_classification TEXT NOT NULL,
        source_name TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_fin_acc_snap_owner ON financial_account_snapshots(owner_id, account_id, recorded_at);

      CREATE TABLE IF NOT EXISTS financial_transactions (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        account_id TEXT REFERENCES financial_accounts(id) ON DELETE SET NULL,
        tx_type TEXT NOT NULL CHECK(tx_type IN ('income', 'expense')),
        category TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'INR',
        description TEXT NOT NULL DEFAULT '',
        occurred_at TEXT NOT NULL,
        source_classification TEXT NOT NULL DEFAULT 'USER_ENTERED',
        source_name TEXT NOT NULL DEFAULT 'User Input',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_fin_tx_owner_date ON financial_transactions(owner_id, occurred_at);

      CREATE TABLE IF NOT EXISTS financial_budgets (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        category TEXT NOT NULL,
        period TEXT NOT NULL,
        limit_minor INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'INR',
        source_classification TEXT NOT NULL DEFAULT 'USER_ENTERED',
        source_name TEXT NOT NULL DEFAULT 'User Input',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(owner_id, category, period)
      );
      CREATE INDEX IF NOT EXISTS idx_fin_budgets_owner ON financial_budgets(owner_id, period);

      CREATE TABLE IF NOT EXISTS financial_goals (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        target_minor INTEGER NOT NULL,
        current_minor INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'INR',
        target_date TEXT,
        monthly_contribution_minor INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        source_classification TEXT NOT NULL DEFAULT 'USER_ENTERED',
        source_name TEXT NOT NULL DEFAULT 'User Input',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_fin_goals_owner ON financial_goals(owner_id);

      CREATE TABLE IF NOT EXISTS financial_debts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        lender TEXT NOT NULL DEFAULT '',
        principal_minor INTEGER NOT NULL,
        remaining_minor INTEGER NOT NULL,
        apr_bps INTEGER NOT NULL DEFAULT 0,
        min_payment_minor INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'INR',
        status TEXT NOT NULL DEFAULT 'active',
        source_classification TEXT NOT NULL DEFAULT 'USER_ENTERED',
        source_name TEXT NOT NULL DEFAULT 'User Input',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_fin_debts_owner ON financial_debts(owner_id);

      CREATE TABLE IF NOT EXISTS financial_holdings (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        asset_class TEXT NOT NULL,
        quantity_milli INTEGER NOT NULL,
        avg_cost_minor INTEGER NOT NULL DEFAULT 0,
        current_value_minor INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'INR',
        source_classification TEXT NOT NULL DEFAULT 'USER_ENTERED',
        source_name TEXT NOT NULL DEFAULT 'User Input',
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_fin_holdings_owner ON financial_holdings(owner_id);

      CREATE TABLE IF NOT EXISTS financial_portfolio_snapshots (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        total_value_minor INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'INR',
        allocation_json TEXT NOT NULL DEFAULT '{}',
        source_classification TEXT NOT NULL DEFAULT 'USER_ENTERED',
        recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_fin_port_snap_owner ON financial_portfolio_snapshots(owner_id, recorded_at);

      CREATE TABLE IF NOT EXISTS financial_trading_capital_allocations (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        allocated_capital_minor INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'INR',
        confirmed_by_user INTEGER NOT NULL DEFAULT 0,
        confirmation_note TEXT NOT NULL DEFAULT '',
        source_classification TEXT NOT NULL DEFAULT 'USER_ENTERED',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_fin_trading_cap_owner ON financial_trading_capital_allocations(owner_id, created_at);
    `,
  },
  {
    version: 7,
    name: 'trading_copilot_deterministic_foundation',
    sql: `
      CREATE TABLE IF NOT EXISTS trading_capital_sessions (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_date TEXT NOT NULL,
        total_equity_minor INTEGER NOT NULL,
        available_cash_minor INTEGER NOT NULL,
        allocated_capital_minor INTEGER NOT NULL,
        reserved_capital_minor INTEGER NOT NULL DEFAULT 0,
        realized_pnl_minor INTEGER NOT NULL DEFAULT 0,
        unrealized_pnl_minor INTEGER NOT NULL DEFAULT 0,
        daily_risk_budget_minor INTEGER NOT NULL DEFAULT 0,
        remaining_daily_risk_minor INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'INR',
        confirmed_by_user INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(owner_id, session_date)
      );
      CREATE INDEX IF NOT EXISTS idx_trd_cap_owner ON trading_capital_sessions(owner_id, session_date);

      CREATE TABLE IF NOT EXISTS trading_capital_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES trading_capital_sessions(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        allocated_capital_minor INTEGER NOT NULL,
        available_cash_minor INTEGER NOT NULL,
        reserved_capital_minor INTEGER NOT NULL,
        realized_pnl_minor INTEGER NOT NULL,
        remaining_daily_risk_minor INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_trd_cap_snap_owner ON trading_capital_snapshots(owner_id, recorded_at);

      CREATE TABLE IF NOT EXISTS trading_risk_configs (
        owner_id TEXT PRIMARY KEY,
        max_risk_per_trade_bps INTEGER NOT NULL,
        max_daily_loss_bps INTEGER NOT NULL,
        max_open_positions INTEGER NOT NULL,
        max_capital_allocation_bps INTEGER NOT NULL,
        max_concentration_bps INTEGER NOT NULL,
        max_consecutive_losses INTEGER NOT NULL,
        min_reward_risk_bps INTEGER NOT NULL,
        allowed_exchanges_json TEXT NOT NULL DEFAULT '["NSE","BSE"]',
        allowed_instruments_json TEXT NOT NULL DEFAULT '["CASH_EQUITY"]',
        session_start_ist TEXT NOT NULL DEFAULT '09:15',
        session_end_ist TEXT NOT NULL DEFAULT '15:30',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS trading_watchlists (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        exchange TEXT NOT NULL CHECK(exchange IN ('NSE', 'BSE')),
        symbol TEXT NOT NULL,
        instrument_type TEXT NOT NULL DEFAULT 'CASH_EQUITY',
        sector TEXT NOT NULL DEFAULT 'GENERAL',
        lot_size INTEGER NOT NULL DEFAULT 1,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(owner_id, exchange, symbol)
      );
      CREATE INDEX IF NOT EXISTS idx_trd_watch_owner ON trading_watchlists(owner_id);

      CREATE TABLE IF NOT EXISTS trading_journal_entries (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        exchange TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('LONG', 'SHORT')),
        quantity INTEGER NOT NULL,
        entry_price_minor INTEGER NOT NULL,
        exit_price_minor INTEGER,
        stop_loss_minor INTEGER NOT NULL,
        target_minor INTEGER NOT NULL,
        strategy_id TEXT NOT NULL DEFAULT 'manual',
        entry_at TEXT NOT NULL,
        exit_at TEXT,
        charges_minor INTEGER NOT NULL DEFAULT 0,
        slippage_minor INTEGER NOT NULL DEFAULT 0,
        realized_pnl_minor INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'CLOSED')),
        notes TEXT NOT NULL DEFAULT '',
        source_classification TEXT NOT NULL DEFAULT 'USER_ENTERED',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_trd_journal_owner ON trading_journal_entries(owner_id, entry_at);

      CREATE TABLE IF NOT EXISTS trading_backtest_runs (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        strategy_version TEXT NOT NULL,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        trades_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_trd_bt_owner ON trading_backtest_runs(owner_id, created_at);
    `,
  },
  {
    version: 8,
    name: 'persistent_clarifications',
    sql: `
      CREATE TABLE IF NOT EXISTS pending_clarifications (
        clarification_id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        original_request_id TEXT NOT NULL,
        original_input TEXT NOT NULL,
        request_json TEXT NOT NULL,
        missing_fields_json TEXT NOT NULL DEFAULT '[]',
        collected_info_json TEXT NOT NULL DEFAULT '[]',
        question TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'RESUMED', 'EXPIRED', 'CANCELLED')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_clarif_actor_conv
        ON pending_clarifications(actor_id, conversation_id, status);
      CREATE INDEX IF NOT EXISTS idx_clarif_expires
        ON pending_clarifications(status, expires_at);
    `,
  },
  {
    version: 9,
    name: 'digital_identity_and_adaptive_personality',
    sql: `
      CREATE TABLE IF NOT EXISTS digital_identity_settings (
        actor_id TEXT PRIMARY KEY,
        default_personality TEXT NOT NULL DEFAULT 'ADAPTIVE'
          CHECK(default_personality IN ('ADAPTIVE', 'TEACHER', 'FRIEND', 'COMPANION', 'TECHNICAL_EXPERT', 'PROFESSIONAL_ASSISTANT')),
        communication_style TEXT NOT NULL DEFAULT 'NATURAL'
          CHECK(communication_style IN ('NATURAL', 'WARM', 'DIRECT', 'FORMAL')),
        answer_detail TEXT NOT NULL DEFAULT 'ADAPTIVE'
          CHECK(answer_detail IN ('ADAPTIVE', 'CONCISE', 'BALANCED', 'DETAILED')),
        voice_concise_mode INTEGER NOT NULL DEFAULT 1,
        conversation_continuity INTEGER NOT NULL DEFAULT 1,
        memory_auto_learn INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS conversation_context_state (
        actor_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        active_topic TEXT DEFAULT '',
        active_personality TEXT DEFAULT 'ADAPTIVE',
        temporary_personality TEXT,
        temporary_depth TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (actor_id, conversation_id)
      );

      ALTER TABLE memories ADD COLUMN actor_id TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT 'knowledge';
      ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT 'conversation';
      ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 0.9;
      ALTER TABLE memories ADD COLUMN updated_at TEXT;

      CREATE INDEX IF NOT EXISTS idx_memories_actor_cat ON memories(actor_id, category);
      CREATE INDEX IF NOT EXISTS idx_memories_actor_key ON memories(actor_id, key);

      ALTER TABLE conversations ADD COLUMN actor_id TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE conversations ADD COLUMN channel TEXT NOT NULL DEFAULT 'text';
      CREATE INDEX IF NOT EXISTS idx_conversations_actor_session ON conversations(actor_id, session_id);
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
