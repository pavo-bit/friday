// ============================================================
// FRIDAY — Persistent Scheduler, Alarms & Reminders
// Timezone-aware one-time, recurring, and geofence reminders
// with missed-event recovery and duplicate prevention.
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { getNotificationService } from './notificationService';
import { createLayerLogger } from '../shared/logger';
import { eventBus } from '../shared/events';
import { WsMessageType } from '../shared/types';

const log = createLayerLogger('Scheduler');

export type RecurrenceType = 'none' | 'daily' | 'weekly' | 'monthly';
export type ReminderStatus = 'pending' | 'triggered' | 'completed' | 'cancelled';
export type TriggerType = 'time' | 'enter' | 'exit';

export interface ReminderRecord {
  id: string;
  title: string;
  notes: string;
  dueAt: string | null;
  timezone: string;
  recurrence: RecurrenceType;
  weekday: number | null;
  locationId: string | null;
  triggerOn: TriggerType;
  status: ReminderStatus;
  isAlarm: boolean;
  lastTriggeredAt: string | null;
  createdAt: string;
}

export interface CreateReminderInput {
  title: string;
  notes?: string;
  dueAt?: string | null;
  timezone?: string;
  recurrence?: RecurrenceType;
  weekday?: number | null;
  locationId?: string | null;
  triggerOn?: TriggerType;
  isAlarm?: boolean;
}

export class SchedulerService {
  private ticker: NodeJS.Timeout | null = null;
  private running = false;

  /**
   * Start the periodic scheduler and recover any missed due reminders.
   */
  async start(pollIntervalMs = 15_000): Promise<void> {
    if (this.ticker) return;
    await this.processDueReminders();
    this.ticker = setInterval(() => {
      this.processDueReminders().catch((err) => {
        log.error('Scheduler tick failed', { error: (err as Error).message });
      });
    }, pollIntervalMs);
    this.ticker.unref?.();
    log.info('Scheduler started');
  }

  stop(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /**
   * Create and persist a reminder or alarm.
   */
  async createReminder(input: CreateReminderInput): Promise<ReminderRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) {
      throw new Error('Database unavailable; cannot persist reminder.');
    }

    const title = input.title.trim();
    if (!title) {
      throw new Error('Reminder title cannot be empty.');
    }

    const triggerOn: TriggerType = input.triggerOn || 'time';
    if (triggerOn === 'time' && input.dueAt) {
      const parsed = new Date(input.dueAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Ambiguous or invalid reminder date/time: "${input.dueAt}". Please provide a clear date/time.`);
      }
    }

    const id = uuidv4();
    const profile = store.getPersonalityProfile();
    const timezone = input.timezone || profile.timezone || 'UTC';
    const recurrence: RecurrenceType = input.recurrence || 'none';

    db.prepare(
      `INSERT INTO reminders (
        id, title, notes, due_at, timezone, recurrence, weekday,
        location_id, trigger_on, status, is_alarm
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      id,
      title,
      input.notes || '',
      input.dueAt ? new Date(input.dueAt).toISOString() : null,
      timezone,
      recurrence,
      input.weekday ?? null,
      input.locationId ?? null,
      triggerOn,
      input.isAlarm ? 1 : 0
    );

    const created = await this.getReminder(id);
    if (!created) throw new Error('Reminder creation failed verification.');
    return created;
  }

  /**
   * Check for all due time-based reminders (including missed events after restart).
   */
  async processDueReminders(now: Date = new Date()): Promise<ReminderRecord[]> {
    if (this.running) return [];
    this.running = true;

    try {
      const store = await getMemoryStore();
      const db = store.getDatabase();
      if (!db) return [];

      const nowIso = now.toISOString();
      const rows = db
        .prepare(
          `SELECT * FROM reminders
           WHERE status = 'pending' AND trigger_on = 'time' AND due_at IS NOT NULL AND due_at <= ?`
        )
        .all(nowIso) as Array<Record<string, unknown>>;

      const triggered: ReminderRecord[] = [];
      const notifications = getNotificationService();

      for (const row of rows) {
        const reminder = this.mapRow(row);

        // Duplicate prevention: skip if already triggered within last 60 seconds
        if (reminder.lastTriggeredAt) {
          const lastMs = new Date(reminder.lastTriggeredAt).getTime();
          if (!Number.isNaN(lastMs) && now.getTime() - lastMs < 60_000) {
            continue;
          }
        }

        const nextDue = this.computeNextDue(reminder.dueAt!, reminder.recurrence);
        const tx = db.transaction(() => {
          if (nextDue) {
            db.prepare(
              `UPDATE reminders SET due_at = ?, last_triggered_at = ?, updated_at = datetime('now') WHERE id = ?`
            ).run(nextDue.toISOString(), nowIso, reminder.id);
          } else {
            db.prepare(
              `UPDATE reminders SET status = 'triggered', last_triggered_at = ?, updated_at = datetime('now') WHERE id = ?`
            ).run(nowIso, reminder.id);
          }
        });
        tx();

        await notifications.notify({
          severity: reminder.isAlarm ? 'critical' : 'info',
          title: reminder.isAlarm ? `Alarm: ${reminder.title}` : `Reminder: ${reminder.title}`,
          message: reminder.notes || `Scheduled for ${reminder.dueAt} (${reminder.timezone})`,
          source: `scheduler:${reminder.id}`,
          dedupeKey: `reminder:${reminder.id}:${reminder.dueAt}`,
          dedupeWindowMs: 60_000,
        });

        eventBus.emitEvent('ws:broadcast', {
          type: WsMessageType.REMINDER_TRIGGERED,
          payload: reminder,
          timestamp: nowIso,
        });

        triggered.push(reminder);
      }

      return triggered;
    } finally {
      this.running = false;
    }
  }

  /**
   * Trigger pending location-based reminders when a geofence event occurs.
   */
  async triggerLocationReminders(locationId: string, eventType: 'enter' | 'exit'): Promise<ReminderRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];

    const rows = db
      .prepare(
        `SELECT * FROM reminders WHERE status = 'pending' AND location_id = ? AND trigger_on = ?`
      )
      .all(locationId, eventType) as Array<Record<string, unknown>>;

    const triggered: ReminderRecord[] = [];
    const notifications = getNotificationService();
    const nowIso = new Date().toISOString();

    for (const row of rows) {
      const reminder = this.mapRow(row);
      db.prepare(
        `UPDATE reminders SET status = 'triggered', last_triggered_at = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(nowIso, reminder.id);

      await notifications.notify({
        severity: 'info',
        title: `Location Reminder: ${reminder.title}`,
        message: reminder.notes || `Triggered on geofence ${eventType}.`,
        source: `location:${locationId}`,
        dedupeKey: `loc-reminder:${reminder.id}`,
        dedupeWindowMs: 60_000,
      });

      triggered.push(reminder);
    }

    return triggered;
  }

  private computeNextDue(currentIso: string, recurrence: RecurrenceType): Date | null {
    if (recurrence === 'none') return null;
    const next = new Date(currentIso);
    if (recurrence === 'daily') {
      next.setUTCDate(next.getUTCDate() + 1);
      return next;
    }
    if (recurrence === 'weekly') {
      next.setUTCDate(next.getUTCDate() + 7);
      return next;
    }
    if (recurrence === 'monthly') {
      next.setUTCMonth(next.getUTCMonth() + 1);
      return next;
    }
    return null;
  }

  async listReminders(status?: ReminderStatus): Promise<ReminderRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    const rows = status
      ? (db.prepare(`SELECT * FROM reminders WHERE status = ? ORDER BY due_at ASC, created_at DESC`).all(status) as Array<Record<string, unknown>>)
      : (db.prepare(`SELECT * FROM reminders ORDER BY due_at ASC, created_at DESC`).all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapRow(r));
  }

  async getReminder(id: string): Promise<ReminderRecord | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;
    const row = db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async updateReminder(
    id: string,
    patch: Partial<{ title: string; notes: string; dueAt: string | null; status: ReminderStatus; recurrence: RecurrenceType }>
  ): Promise<ReminderRecord | null> {
    const existing = await this.getReminder(id);
    if (!existing) return null;

    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;

    const nextDue = patch.dueAt !== undefined ? (patch.dueAt ? new Date(patch.dueAt).toISOString() : null) : existing.dueAt;
    db.prepare(
      `UPDATE reminders SET title = ?, notes = ?, due_at = ?, status = ?, recurrence = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(
      patch.title ?? existing.title,
      patch.notes ?? existing.notes,
      nextDue,
      patch.status ?? existing.status,
      patch.recurrence ?? existing.recurrence,
      id
    );

    return this.getReminder(id);
  }

  async deleteReminder(id: string): Promise<boolean> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return false;
    const info = db.prepare(`DELETE FROM reminders WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): ReminderRecord {
    return {
      id: String(row.id),
      title: String(row.title),
      notes: String(row.notes || ''),
      dueAt: row.due_at ? String(row.due_at) : null,
      timezone: String(row.timezone || 'UTC'),
      recurrence: (row.recurrence as RecurrenceType) || 'none',
      weekday: row.weekday !== null && row.weekday !== undefined ? Number(row.weekday) : null,
      locationId: row.location_id ? String(row.location_id) : null,
      triggerOn: (row.trigger_on as TriggerType) || 'time',
      status: row.status as ReminderStatus,
      isAlarm: Number(row.is_alarm) === 1,
      lastTriggeredAt: row.last_triggered_at ? String(row.last_triggered_at) : null,
      createdAt: String(row.created_at),
    };
  }
}

let _scheduler: SchedulerService | null = null;
export function getSchedulerService(): SchedulerService {
  if (!_scheduler) {
    _scheduler = new SchedulerService();
  }
  return _scheduler;
}
