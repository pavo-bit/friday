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
  }): Promise<FridayNotification | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    const dedupeWindowMs = params.dedupeWindowMs ?? 5 * 60_000;

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
}

let _notifications: NotificationService | null = null;
export function getNotificationService(): NotificationService {
  if (!_notifications) {
    _notifications = new NotificationService();
  }
  return _notifications;
}
