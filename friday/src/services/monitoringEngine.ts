// ============================================================
// FRIDAY — Dashboard & Service Monitoring Engine
// Persistent watchers with real worker intervals, retries,
// threshold alerting, deduplication, and restart recovery.
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import * as net from 'net';
import { getMemoryStore } from '../memory/store';
import { getNotificationService } from './notificationService';
import { createLayerLogger } from '../shared/logger';
import { eventBus } from '../shared/events';
import { WsMessageType } from '../shared/types';

const log = createLayerLogger('Monitoring');

export type MonitorMethod = 'http_health' | 'prometheus' | 'grafana' | 'json_api' | 'postgres' | 'redis';
export type WatcherStatus = 'active' | 'paused' | 'stopped';
export type WatcherHealth = 'healthy' | 'degraded' | 'offline' | 'unknown';

export interface WatcherRecord {
  id: string;
  name: string;
  targetUrl: string;
  method: MonitorMethod;
  intervalMs: number;
  timeoutMs: number;
  failureThreshold: number;
  metricQuery: string;
  metricThreshold: number | null;
  status: WatcherStatus;
  health: WatcherHealth;
  consecutiveFailures: number;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  isDefault: boolean;
  workerRunning: boolean;
  createdAt: string;
}

export interface MonitoringCheckResult {
  watcherId: string;
  status: 'healthy' | 'degraded' | 'offline';
  statusCode: number | null;
  latencyMs: number;
  message: string;
  checkedAt: string;
}

export interface CreateWatcherInput {
  name: string;
  targetUrl: string;
  method?: MonitorMethod;
  intervalMs?: number;
  timeoutMs?: number;
  failureThreshold?: number;
  metricQuery?: string;
  metricThreshold?: number | null;
  isDefault?: boolean;
}

const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 24 * 60 * 60_000;

export class MonitoringEngine {
  private workers: Map<string, NodeJS.Timeout> = new Map();
  private inFlight: Set<string> = new Set();

  /**
   * Recover and start all active watchers persisted in SQLite.
   */
  async recoverOnBoot(): Promise<number> {
    const watchers = await this.listWatchers();
    let started = 0;
    for (const watcher of watchers) {
      if (watcher.status === 'active') {
        this.startWorker(watcher.id, watcher.intervalMs);
        started++;
      }
    }
    if (started > 0) {
      log.info(`Recovered ${started} active dashboard/service watcher(s)`);
    }
    return started;
  }

  /**
   * Create a persistent watcher, start its worker, and verify it is running.
   */
  async createWatcher(input: CreateWatcherInput): Promise<WatcherRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) {
      throw new Error('SQLite database is unavailable; cannot persist watcher.');
    }

    const validatedUrl = this.validateTargetUrl(input.targetUrl, input.method || 'http_health');
    const intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, input.intervalMs ?? 60_000));
    const timeoutMs = Math.min(30_000, Math.max(1_000, input.timeoutMs ?? 5_000));
    const failureThreshold = Math.max(1, input.failureThreshold ?? 2);
    const method: MonitorMethod = input.method || 'http_health';
    const id = uuidv4();

    const tx = db.transaction(() => {
      if (input.isDefault) {
        db.prepare(`UPDATE watchers SET is_default = 0`).run();
      }
      db.prepare(
        `INSERT INTO watchers (
          id, name, target_url, method, interval_ms, timeout_ms, failure_threshold,
          metric_query, metric_threshold, status, health, is_default
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'unknown', ?)`
      ).run(
        id,
        input.name.trim(),
        validatedUrl,
        method,
        intervalMs,
        timeoutMs,
        failureThreshold,
        input.metricQuery || '',
        input.metricThreshold ?? null,
        input.isDefault ? 1 : 0
      );
    });
    tx();

    this.startWorker(id, intervalMs);
    if (!this.workers.has(id)) {
      throw new Error('Failed to start monitoring worker.');
    }

    // Run immediate initial verification probe
    await this.checkWatcherNow(id);

    const created = await this.getWatcher(id);
    if (!created) {
      throw new Error('Watcher created but could not be verified.');
    }
    return created;
  }

  /**
   * Validate target URL or host:port for safe bounded monitoring.
   */
  private validateTargetUrl(raw: string, method: MonitorMethod): string {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error('Target URL cannot be empty.');
    }

    if (method === 'postgres' || method === 'redis') {
      const normalized = trimmed.includes('://') ? trimmed : `${method}://${trimmed}`;
      const parsed = new URL(normalized);
      if (!parsed.hostname) {
        throw new Error(`Invalid ${method} host.`);
      }
      return normalized;
    }

    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http:// and https:// targets are allowed for HTTP monitoring.');
    }
    return parsed.toString();
  }

  private startWorker(watcherId: string, intervalMs: number): void {
    this.stopWorker(watcherId);
    const timer = setInterval(() => {
      this.checkWatcherNow(watcherId).catch((err) => {
        log.error(`Worker check failed for ${watcherId}`, { error: (err as Error).message });
      });
    }, intervalMs);
    timer.unref?.();
    this.workers.set(watcherId, timer);
  }

  private stopWorker(watcherId: string): void {
    const existing = this.workers.get(watcherId);
    if (existing) {
      clearInterval(existing);
      this.workers.delete(watcherId);
    }
  }

  /**
   * Perform a single real probe against the watcher's target.
   */
  async checkWatcherNow(watcherId: string): Promise<MonitoringCheckResult | null> {
    if (this.inFlight.has(watcherId)) return null;
    this.inFlight.add(watcherId);

    try {
      const watcher = await this.getWatcher(watcherId);
      if (!watcher || watcher.status !== 'active') return null;

      const result = await this.probeWithRetry(watcher);
      await this.recordCheckResult(watcher, result);
      return result;
    } finally {
      this.inFlight.delete(watcherId);
    }
  }

  private async probeWithRetry(watcher: WatcherRecord): Promise<MonitoringCheckResult> {
    const maxAttempts = 2;
    let lastResult: MonitoringCheckResult | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastResult = await this.executeProbe(watcher);
      if (lastResult.status === 'healthy') {
        return lastResult;
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }

    return lastResult!;
  }

  private async executeProbe(watcher: WatcherRecord): Promise<MonitoringCheckResult> {
    const started = Date.now();
    const checkedAt = new Date().toISOString();

    if (watcher.method === 'postgres' || watcher.method === 'redis') {
      const parsed = new URL(watcher.targetUrl);
      const port = parseInt(parsed.port || (watcher.method === 'postgres' ? '5432' : '6379'), 10);
      const ok = await this.tcpCheck(parsed.hostname, port, watcher.timeoutMs);
      const latencyMs = Date.now() - started;
      return {
        watcherId: watcher.id,
        status: ok ? 'healthy' : 'offline',
        statusCode: ok ? 200 : null,
        latencyMs,
        message: ok ? `${watcher.method} reachable on ${parsed.hostname}:${port}` : `${watcher.method} unreachable on ${parsed.hostname}:${port}`,
        checkedAt,
      };
    }

    try {
      const response = await fetch(watcher.targetUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(watcher.timeoutMs),
        headers: { Accept: 'application/json, text/plain, text/html' },
      });
      const latencyMs = Date.now() - started;

      if (!response.ok) {
        return {
          watcherId: watcher.id,
          status: response.status >= 500 ? 'offline' : 'degraded',
          statusCode: response.status,
          latencyMs,
          message: `HTTP ${response.status} ${response.statusText}`,
          checkedAt,
        };
      }

      if (watcher.method === 'prometheus' || watcher.method === 'json_api' || watcher.method === 'grafana') {
        const bodyText = await response.text();
        if (watcher.metricThreshold !== null && watcher.metricQuery) {
          const metricVal = this.extractNumericMetric(bodyText, watcher.metricQuery);
          if (metricVal !== null && metricVal > watcher.metricThreshold) {
            return {
              watcherId: watcher.id,
              status: 'degraded',
              statusCode: response.status,
              latencyMs,
              message: `Metric "${watcher.metricQuery}" = ${metricVal} exceeded threshold ${watcher.metricThreshold}`,
              checkedAt,
            };
          }
        }
      }

      return {
        watcherId: watcher.id,
        status: 'healthy',
        statusCode: response.status,
        latencyMs,
        message: `HTTP ${response.status} OK (${latencyMs}ms)`,
        checkedAt,
      };
    } catch (error) {
      const latencyMs = Date.now() - started;
      return {
        watcherId: watcher.id,
        status: 'offline',
        statusCode: null,
        latencyMs,
        message: (error as Error).message || 'Connection failed',
        checkedAt,
      };
    }
  }

  private extractNumericMetric(body: string, queryKey: string): number | null {
    try {
      const json = JSON.parse(body);
      const parts = queryKey.split('.');
      let cur: unknown = json;
      for (const part of parts) {
        if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[part];
        } else {
          cur = undefined;
          break;
        }
      }
      if (typeof cur === 'number') return cur;
    } catch {
      // Prometheus text exposition fallback: metric_name 42
      const regex = new RegExp(`^${queryKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\{[^}]*\\})?\\s+([0-9.]+)`, 'm');
      const match = body.match(regex);
      if (match) return parseFloat(match[1]);
    }
    return null;
  }

  private tcpCheck(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, host);
    });
  }

  private async recordCheckResult(watcher: WatcherRecord, result: MonitoringCheckResult): Promise<void> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return;

    const isHealthy = result.status === 'healthy';
    const nextFailures = isHealthy ? 0 : watcher.consecutiveFailures + 1;
    const shouldAlert = !isHealthy && nextFailures >= watcher.failureThreshold;
    const recovered = isHealthy && (watcher.health === 'offline' || watcher.health === 'degraded');

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO monitoring_history (id, watcher_id, status, status_code, latency_ms, message, alert_sent, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(
        uuidv4(),
        watcher.id,
        result.status,
        result.statusCode,
        result.latencyMs,
        result.message,
        shouldAlert ? 1 : 0
      );

      db.prepare(
        `UPDATE watchers SET
          health = ?,
          consecutive_failures = ?,
          last_check_at = datetime('now'),
          last_success_at = CASE WHEN ? = 1 THEN datetime('now') ELSE last_success_at END,
          last_failure_at = CASE WHEN ? = 0 THEN datetime('now') ELSE last_failure_at END,
          last_error = CASE WHEN ? = 0 THEN ? ELSE NULL END,
          updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        result.status,
        nextFailures,
        isHealthy ? 1 : 0,
        isHealthy ? 1 : 0,
        isHealthy ? 1 : 0,
        result.message,
        watcher.id
      );
    });
    tx();

    const notifications = getNotificationService();
    if (shouldAlert) {
      await notifications.notify({
        severity: result.status === 'offline' ? 'critical' : 'warning',
        title: `Watcher Alert: ${watcher.name}`,
        message: `${watcher.targetUrl} is ${result.status.toUpperCase()} — ${result.message}`,
        source: `watcher:${watcher.id}`,
        dedupeKey: `watcher-down:${watcher.id}:${result.status}`,
        dedupeWindowMs: 5 * 60_000,
      });
    } else if (recovered) {
      await notifications.notify({
        severity: 'info',
        title: `Watcher Recovered: ${watcher.name}`,
        message: `${watcher.targetUrl} is back to HEALTHY (${result.latencyMs}ms).`,
        source: `watcher:${watcher.id}`,
        dedupeKey: `watcher-recovered:${watcher.id}`,
        dedupeWindowMs: 60_000,
      });
    }

    eventBus.emitEvent('ws:broadcast', {
      type: WsMessageType.WATCHER_UPDATED,
      payload: { watcherId: watcher.id, health: result.status, latencyMs: result.latencyMs },
      timestamp: result.checkedAt,
    });
  }

  async pauseWatcher(id: string): Promise<boolean> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return false;
    this.stopWorker(id);
    const info = db
      .prepare(`UPDATE watchers SET status = 'paused', updated_at = datetime('now') WHERE id = ?`)
      .run(id);
    return info.changes > 0;
  }

  async resumeWatcher(id: string): Promise<boolean> {
    const watcher = await this.getWatcher(id);
    if (!watcher) return false;
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return false;
    db.prepare(`UPDATE watchers SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(id);
    this.startWorker(id, watcher.intervalMs);
    await this.checkWatcherNow(id);
    return true;
  }

  async stopWatcher(id: string): Promise<boolean> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return false;
    this.stopWorker(id);
    const info = db
      .prepare(`UPDATE watchers SET status = 'stopped', updated_at = datetime('now') WHERE id = ?`)
      .run(id);
    return info.changes > 0;
  }

  async deleteWatcher(id: string): Promise<boolean> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return false;
    this.stopWorker(id);
    const info = db.prepare(`DELETE FROM watchers WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  async getWatcher(idOrName: string): Promise<WatcherRecord | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;

    const row = db
      .prepare(`SELECT * FROM watchers WHERE id = ? OR LOWER(name) = LOWER(?) LIMIT 1`)
      .get(idOrName, idOrName) as Record<string, unknown> | undefined;

    return row ? this.mapRow(row) : null;
  }

  async getDefaultWatcher(): Promise<WatcherRecord | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;
    const row = db
      .prepare(`SELECT * FROM watchers ORDER BY is_default DESC, created_at ASC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async listWatchers(): Promise<WatcherRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    const rows = db.prepare(`SELECT * FROM watchers ORDER BY is_default DESC, created_at DESC`).all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => this.mapRow(r));
  }

  async getHistory(watcherId?: string, sinceIso?: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];

    let sql = `SELECT h.*, w.name as watcher_name, w.target_url FROM monitoring_history h JOIN watchers w ON w.id = h.watcher_id WHERE 1=1`;
    const params: unknown[] = [];
    if (watcherId) {
      sql += ` AND h.watcher_id = ?`;
      params.push(watcherId);
    }
    if (sinceIso) {
      sql += ` AND h.checked_at >= ?`;
      params.push(sinceIso);
    }
    sql += ` ORDER BY h.checked_at DESC LIMIT ?`;
    params.push(limit);

    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  }

  stopAll(): void {
    for (const id of this.workers.keys()) {
      this.stopWorker(id);
    }
  }

  private mapRow(row: Record<string, unknown>): WatcherRecord {
    const id = String(row.id);
    return {
      id,
      name: String(row.name),
      targetUrl: String(row.target_url),
      method: row.method as MonitorMethod,
      intervalMs: Number(row.interval_ms),
      timeoutMs: Number(row.timeout_ms),
      failureThreshold: Number(row.failure_threshold),
      metricQuery: String(row.metric_query || ''),
      metricThreshold: row.metric_threshold !== null && row.metric_threshold !== undefined ? Number(row.metric_threshold) : null,
      status: row.status as WatcherStatus,
      health: row.health as WatcherHealth,
      consecutiveFailures: Number(row.consecutive_failures || 0),
      lastCheckAt: row.last_check_at ? String(row.last_check_at) : null,
      lastSuccessAt: row.last_success_at ? String(row.last_success_at) : null,
      lastFailureAt: row.last_failure_at ? String(row.last_failure_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      isDefault: Number(row.is_default) === 1,
      workerRunning: this.workers.has(id),
      createdAt: String(row.created_at),
    };
  }
}

let _monitoring: MonitoringEngine | null = null;
export function getMonitoringEngine(): MonitoringEngine {
  if (!_monitoring) {
    _monitoring = new MonitoringEngine();
  }
  return _monitoring;
}
