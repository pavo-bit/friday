// ============================================================
// FRIDAY — Notification Service
// Persistent alerts with deduplication and WebSocket broadcast
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { eventBus } from '../shared/events';
import { WsMessageType } from '../shared/types';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('Notifications');

export type NotificationSeverity = 'info' | 'warning' | 'critical';
export type DeliveryStatus = 'DELIVERED' | 'SUPPRESSED_QUIET_HOURS' | 'FAILED' | 'RETRYING';

export interface NotificationPreferences {
  actorId: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  minSeverity: NotificationSeverity;
  allowCriticalInQuietHours: boolean;
  approvedDestinations: string[];
}

export interface NotificationDeliveryRecord {
  id: string;
  notificationId: string;
  destination: string;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  createdAt: string;
}

const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export interface FridayNotification {
  id: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  source: string;
  dedupeKey?: string;
  isRead: boolean;
  createdAt: string;
}

export class NotificationService {
  /**
   * Create and persist a notification, suppressing duplicates within dedupeWindowMs.
   */
  async notify(params: {
    severity: NotificationSeverity;
    title: string;
    message: string;
    source?: string;
    dedupeKey?: string;
    dedupeWindowMs?: number;
    actorId?: string;
    destinations?: string[];
  }): Promise<FridayNotification | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    const dedupeWindowMs = params.dedupeWindowMs ?? 5 * 60_000;
    const actorId = params.actorId || 'local';
    const prefs = await this.getPreferences(actorId);

    if (SEVERITY_RANK[params.severity] < SEVERITY_RANK[prefs.minSeverity]) {
      return null;
    }

    const inQuietHours = this.isInQuietHours(prefs.quietHoursStart, prefs.quietHoursEnd);
    const suppressedByQuiet = inQuietHours && !(params.severity === 'critical' && prefs.allowCriticalInQuietHours);

    if (db && params.dedupeKey) {
      const cutoffIso = new Date(Date.now() - dedupeWindowMs).toISOString().replace('T', ' ').slice(0, 19);
      const existing = db
        .prepare(`SELECT id FROM notifications WHERE dedupe_key = ? AND created_at >= ? LIMIT 1`)
        .get(params.dedupeKey, cutoffIso) as { id: string } | undefined;

      if (existing) {
        log.debug(`Suppressed duplicate notification for ${params.dedupeKey}`);
        return null;
      }
    }

    const id = uuidv4();
    const nowIso = new Date().toISOString();
    const source = params.source || 'system';

    if (db) {
      db.prepare(
        `INSERT INTO notifications (id, severity, title, message, source, dedupe_key, is_read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))`
      ).run(id, params.severity, params.title, params.message, source, params.dedupeKey || null);

      const dests = (params.destinations && params.destinations.length > 0
        ? params.destinations
        : prefs.approvedDestinations
      ).filter((d) => prefs.approvedDestinations.includes(d) || d === 'dashboard');

      for (const dest of dests.length > 0 ? dests : ['dashboard']) {
        const deliveryId = uuidv4();
        let status: DeliveryStatus = suppressedByQuiet ? 'SUPPRESSED_QUIET_HOURS' : 'DELIVERED';
        let attempts = 1;
        let lastError: string | null = null;

        if (!suppressedByQuiet && (dest.startsWith('http://') || dest.startsWith('https://'))) {
          const deliveryRes = await this.deliverWebhookWithRetry(dest, {
            id,
            severity: params.severity,
            title: params.title,
            message: params.message,
            source,
          });
          status = deliveryRes.ok ? 'DELIVERED' : 'FAILED';
          attempts = deliveryRes.attempts;
          lastError = deliveryRes.error;
        }

        db.prepare(
          `INSERT INTO notification_deliveries (id, notification_id, destination, status, attempts, last_error)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(deliveryId, id, dest, status, attempts, lastError);
      }
    }

    const notification: FridayNotification = {
      id,
      severity: params.severity,
      title: params.title,
      message: params.message,
      source,
      dedupeKey: params.dedupeKey,
      isRead: false,
      createdAt: nowIso,
    };

    eventBus.emitEvent('ws:broadcast', {
      type: WsMessageType.NOTIFICATION_NEW,
      payload: notification,
      timestamp: nowIso,
    });

    log.info(`Notification [${params.severity}]: ${params.title}`);
    return notification;
  }

  async list(unreadOnly = false, limit = 50): Promise<FridayNotification[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];

    const sql = unreadOnly
      ? `SELECT * FROM notifications WHERE is_read = 0 ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`;

    const rows = db.prepare(sql).all(limit) as Array<{
      id: string;
      severity: NotificationSeverity;
      title: string;
      message: string;
      source: string;
      dedupe_key: string | null;
      is_read: number;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      severity: r.severity,
      title: r.title,
      message: r.message,
      source: r.source,
      dedupeKey: r.dedupe_key || undefined,
      isRead: r.is_read === 1,
      createdAt: r.created_at,
    }));
  }

  async markRead(id: string): Promise<boolean> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return false;
    const info = db.prepare(`UPDATE notifications SET is_read = 1 WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  async markAllRead(): Promise<number> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return 0;
    const info = db.prepare(`UPDATE notifications SET is_read = 1 WHERE is_read = 0`).run();
    return info.changes;
  }

  async getPreferences(actorId = 'local'): Promise<NotificationPreferences> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    const defaults: NotificationPreferences = {
      actorId,
      quietHoursStart: '',
      quietHoursEnd: '',
      minSeverity: 'info',
      allowCriticalInQuietHours: true,
      approvedDestinations: ['dashboard'],
    };
    if (!db) return defaults;

    const row = db
      .prepare(`SELECT * FROM notification_preferences WHERE actor_id = ?`)
      .get(actorId) as Record<string, unknown> | undefined;
    if (!row) return defaults;

    return {
      actorId: String(row.actor_id),
      quietHoursStart: String(row.quiet_hours_start || ''),
      quietHoursEnd: String(row.quiet_hours_end || ''),
      minSeverity: (row.min_severity as NotificationSeverity) || 'info',
      allowCriticalInQuietHours: Number(row.allow_critical_in_quiet_hours) === 1,
      approvedDestinations: JSON.parse(String(row.approved_destinations_json || '["dashboard"]')),
    };
  }

  async savePreferences(
    actorId: string,
    patch: Partial<Omit<NotificationPreferences, 'actorId'>>
  ): Promise<NotificationPreferences> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    const current = await this.getPreferences(actorId);
    const next: NotificationPreferences = {
      actorId,
      quietHoursStart: patch.quietHoursStart ?? current.quietHoursStart,
      quietHoursEnd: patch.quietHoursEnd ?? current.quietHoursEnd,
      minSeverity: patch.minSeverity ?? current.minSeverity,
      allowCriticalInQuietHours: patch.allowCriticalInQuietHours ?? current.allowCriticalInQuietHours,
      approvedDestinations: patch.approvedDestinations ?? current.approvedDestinations,
    };
    if (db) {
      db.prepare(
        `INSERT INTO notification_preferences
         (actor_id, quiet_hours_start, quiet_hours_end, min_severity, allow_critical_in_quiet_hours, approved_destinations_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(actor_id) DO UPDATE SET
           quiet_hours_start = excluded.quiet_hours_start,
           quiet_hours_end = excluded.quiet_hours_end,
           min_severity = excluded.min_severity,
           allow_critical_in_quiet_hours = excluded.allow_critical_in_quiet_hours,
           approved_destinations_json = excluded.approved_destinations_json,
           updated_at = datetime('now')`
      ).run(
        actorId,
        next.quietHoursStart,
        next.quietHoursEnd,
        next.minSeverity,
        next.allowCriticalInQuietHours ? 1 : 0,
        JSON.stringify(next.approvedDestinations)
      );
    }
    return next;
  }

  async acknowledgeDelivery(notificationId: string): Promise<boolean> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return false;
    const info = db
      .prepare(
        `UPDATE notification_deliveries
         SET acknowledged = 1, acknowledged_at = datetime('now'), updated_at = datetime('now')
         WHERE notification_id = ?`
      )
      .run(notificationId);
    await this.markRead(notificationId);
    return info.changes > 0;
  }

  async listDeliveries(limit = 50): Promise<NotificationDeliveryRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    const rows = db
      .prepare(`SELECT * FROM notification_deliveries ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      notificationId: String(r.notification_id),
      destination: String(r.destination),
      status: r.status as DeliveryStatus,
      attempts: Number(r.attempts ?? 1),
      lastError: r.last_error ? String(r.last_error) : null,
      acknowledged: Number(r.acknowledged) === 1,
      acknowledgedAt: r.acknowledged_at ? String(r.acknowledged_at) : null,
      createdAt: String(r.created_at),
    }));
  }

  private async deliverWebhookWithRetry(
    url: string,
    payload: Record<string, unknown>
  ): Promise<{ ok: boolean; attempts: number; error: string | null }> {
    const maxAttempts = 2;
    let lastErr: string | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(3_000),
        });
        if (res.ok) return { ok: true, attempts: attempt, error: null };
        lastErr = `HTTP ${res.status}`;
      } catch (err) {
        lastErr = (err as Error).message;
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 150 * attempt));
      }
    }
    return { ok: false, attempts: maxAttempts, error: lastErr };
  }

  private isInQuietHours(start: string, end: string): boolean {
    if (!start || !end || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
      return false;
    }
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const sMin = sh * 60 + sm;
    const eMin = eh * 60 + em;
    if (sMin <= eMin) {
      return cur >= sMin && cur <= eMin;
    }
    return cur >= sMin || cur <= eMin;
  }
}

let _notifications: NotificationService | null = null;
export function getNotificationService(): NotificationService {
  if (!_notifications) {
    _notifications = new NotificationService();
  }
  return _notifications;
}
