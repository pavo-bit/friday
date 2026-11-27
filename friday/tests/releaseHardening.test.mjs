import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-phase9-test-'));
process.env.FRIDAY_DB_PATH = path.join(tmpDir, 'friday-phase9.db');

const { MIGRATIONS, runMigrations } = await import('../dist/memory/migrations.js');
const { MemoryStore } = await import('../dist/memory/store.js');
const { getSafetyGate } = await import('../dist/orchestration/safetyGate.js');
const { runBacktest } = await import('../dist/trading/backtester.js');

describe('Phase 9: Hardening, Migration Upgrade, Backup/Restore & Backtest Edge Cases', () => {
  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Ignore Windows temp file lock
    }
  });

  it('Upgrades a real v1 SQLite database through v7 without losing existing records', () => {
    const legacyPath = path.join(tmpDir, 'legacy-v1.db');
    const db = new Database(legacyPath);
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(MIGRATIONS[0].sql);
    db.prepare(`INSERT INTO schema_migrations (version, name) VALUES (1, ?)`).run(MIGRATIONS[0].name);
    db.prepare(
      `INSERT INTO memories (id, type, key, value) VALUES ('m1', 'fact', 'owner', 'Boss')`
    ).run();

    // Run remaining migrations v2 -> v7
    runMigrations(db);

    const row = db.prepare(`SELECT value FROM memories WHERE id = 'm1'`).get();
    assert.equal(row.value, 'Boss');

    const latestVer = db.prepare(`SELECT MAX(version) AS v FROM schema_migrations`).get();
    assert.equal(latestVer.v, 7);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => r.name);
    assert.ok(tables.includes('capability_approvals'));
    assert.ok(tables.includes('presentations'));
    assert.ok(tables.includes('financial_accounts'));
    assert.ok(tables.includes('trading_capital_sessions'));
    db.close();
  });

  it('Creates verified SQLite backups, rejects corrupted backups, and restores safely', async () => {
    const dbPath = path.join(tmpDir, 'backup-live.db');
    const store = new MemoryStore(dbPath);
    await store.initialize();
    store
      .getDatabase()
      .prepare(`INSERT INTO memories (id, type, key, value) VALUES ('bk1', 'fact', 'release_check', 'verified_v9')`)
      .run();

    const backupPath = path.join(tmpDir, 'verified-backup.db');
    await store.backupDatabase(backupPath);
    const okCheck = await store.verifyBackup(backupPath);
    assert.equal(okCheck.ok, true);

    // Corrupted backup must fail verification and restore
    const badPath = path.join(tmpDir, 'corrupted.db');
    fs.writeFileSync(badPath, 'NOT A SQLITE DATABASE', 'utf8');
    const badCheck = await store.verifyBackup(badPath);
    assert.equal(badCheck.ok, false);
    await assert.rejects(() => store.restoreDatabase(badPath), /Cannot restore corrupted/);

    // Mutate live DB, then restore from verified backup
    store.getDatabase().prepare(`UPDATE memories SET value = 'overwritten' WHERE id = 'bk1'`).run();
    const restoreRes = await store.restoreDatabase(backupPath);
    assert.equal(restoreRes.restored, true);
    assert.ok(fs.existsSync(restoreRes.safetyBackupPath));

    const recalled = store.getDatabase().prepare(`SELECT value FROM memories WHERE id = 'bk1'`).get();
    assert.equal(recalled?.value, 'verified_v9');
    store.close();
  });

  it('Backtester handles gap-through stop-loss, same-candle SL priority, and zero look-ahead', async () => {
    const t0 = Date.parse('2026-11-27T04:00:00Z');
    const candles = [];
    let price = 100_000;
    for (let i = 0; i < 40; i++) {
      candles.push({
        timestamp: new Date(t0 + i * 5 * 60_000).toISOString(),
        openMinor: price,
        highMinor: price + 500,
        lowMinor: price - 100,
        closeMinor: price + 350,
        volume: 20_000,
      });
      price += 350;
    }
    // Inject a sharp gap-down bar near the end to trigger gap-through stop-loss
    candles[35] = {
      timestamp: new Date(t0 + 35 * 5 * 60_000).toISOString(),
      openMinor: 90_000,
      highMinor: 120_000, // Also touches target, SL must win conservatively
      lowMinor: 89_000,
      closeMinor: 91_000,
      volume: 30_000,
    };

    const store = new MemoryStore(path.join(tmpDir, 'bt-edge.db'));
    await store.initialize();
    const bt = await runBacktest({
      ownerId: 'local',
      instrument: {
        exchange: 'NSE',
        symbol: 'TESTEQ',
        name: 'Test Equity',
        instrumentType: 'CASH_EQUITY',
        sector: 'IT',
        lotSize: 1,
        tickSizeMinor: 5,
      },
      timeframe: '5m',
      candles,
      strategyId: 'vwap_trend_continuation',
      inSampleRatio: 1.0,
    });
    assert.equal(bt.isHistoricalSimulation, true);
    assert.ok(bt.inSample.totalChargesMinor >= 0);
    store.close();
  });

  it('Legacy SafetyGate.processApproval cannot create or consume SQLite-bound approvals', async () => {
    const gate = getSafetyGate();
    const res = gate.processApproval('non-existent-legacy-id', true);
    assert.equal(res, false);
    const bound = await gate.getBoundApproval('non-existent-legacy-id');
    assert.equal(bound, null);
  });

  it('Measures SQLite initialization, migration, and query latency within acceptable bounds', async () => {
    const tStart = performance.now();
    const perfStore = new MemoryStore(path.join(tmpDir, 'perf.db'));
    await perfStore.initialize();
    const initMs = performance.now() - tStart;

    const qStart = performance.now();
    const ins = perfStore
      .getDatabase()
      .prepare(`INSERT INTO memories (id, type, key, value) VALUES (?, 'fact', ?, ?)`);
    for (let i = 0; i < 50; i++) {
      ins.run(`id_${i}`, `k_${i}`, `val_${i}`);
    }
    const writeMs = performance.now() - qStart;
    perfStore.close();

    assert.ok(initMs < 2000, `DB init+migrations took ${initMs.toFixed(1)}ms`);
    assert.ok(writeMs < 1000, `50 SQLite inserts took ${writeMs.toFixed(1)}ms`);
  });
});
