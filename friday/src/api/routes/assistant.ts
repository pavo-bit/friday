// ============================================================
// FRIDAY — Extended Assistant API Routes
// Watchers, Reminders, Notifications, Locations, Personality,
// Tools, Audit Logs, Backups, and Device Pairing Auth
// ============================================================

import { Router, Request, Response } from 'express';
import * as path from 'path';
import { getMonitoringEngine, MonitorMethod } from '../../services/monitoringEngine';
import { getSchedulerService, RecurrenceType, ReminderStatus } from '../../services/schedulerService';
import { getLocationService } from '../../services/locationService';
import { getNotificationService } from '../../services/notificationService';
import { getAuthService } from '../../services/authService';
import { getMemoryStore } from '../../memory/store';
import { getToolRegistry } from '../../orchestration/toolRegistry';
import { getOllamaClient } from '../../orchestration/ollamaClient';
import { getConfig } from '../../shared/config';

export const assistantRoutes = Router();

// ---- Watchers (Phase 4) ----
assistantRoutes.get('/watchers', async (_req: Request, res: Response) => {
  const list = await getMonitoringEngine().listWatchers();
  res.json({ watchers: list });
});

assistantRoutes.get('/watchers/history', async (req: Request, res: Response) => {
  const watcherId = req.query.watcherId as string | undefined;
  const sinceIso = req.query.since as string | undefined;
  const limit = parseInt((req.query.limit as string) || '50', 10);
  const history = await getMonitoringEngine().getHistory(watcherId, sinceIso, limit);
  res.json({ history });
});

assistantRoutes.post('/watchers', async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      name?: string;
      targetUrl?: string;
      method?: MonitorMethod;
      intervalMs?: number;
      timeoutMs?: number;
      failureThreshold?: number;
      metricQuery?: string;
      metricThreshold?: number;
      isDefault?: boolean;
    };
    if (!body.targetUrl) {
      res.status(400).json({ error: 'targetUrl is required' });
      return;
    }
    const watcher = await getMonitoringEngine().createWatcher({
      name: body.name || body.targetUrl,
      targetUrl: body.targetUrl,
      method: body.method,
      intervalMs: body.intervalMs,
      timeoutMs: body.timeoutMs,
      failureThreshold: body.failureThreshold,
      metricQuery: body.metricQuery,
      metricThreshold: body.metricThreshold,
      isDefault: body.isDefault,
    });
    res.status(201).json({ watcher });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

assistantRoutes.post('/watchers/:id/pause', async (req: Request, res: Response) => {
  const ok = await getMonitoringEngine().pauseWatcher(String(req.params.id));
  res.status(ok ? 200 : 404).json({ paused: ok });
});

assistantRoutes.post('/watchers/:id/resume', async (req: Request, res: Response) => {
  const ok = await getMonitoringEngine().resumeWatcher(String(req.params.id));
  res.status(ok ? 200 : 404).json({ resumed: ok });
});

assistantRoutes.post('/watchers/:id/stop', async (req: Request, res: Response) => {
  const ok = await getMonitoringEngine().stopWatcher(String(req.params.id));
  res.status(ok ? 200 : 404).json({ stopped: ok });
});

assistantRoutes.delete('/watchers/:id', async (req: Request, res: Response) => {
  const ok = await getMonitoringEngine().deleteWatcher(String(req.params.id));
  res.status(ok ? 200 : 404).json({ deleted: ok });
});

// ---- Reminders & Alarms (Phase 5) ----
assistantRoutes.get('/reminders', async (req: Request, res: Response) => {
  const status = req.query.status as ReminderStatus | undefined;
  const reminders = await getSchedulerService().listReminders(status);
  res.json({ reminders });
});

assistantRoutes.post('/reminders', async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      title?: string;
      notes?: string;
      dueAt?: string;
      timezone?: string;
      recurrence?: RecurrenceType;
      locationId?: string;
      triggerOn?: 'time' | 'enter' | 'exit';
      isAlarm?: boolean;
    };
    if (!body.title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    const reminder = await getSchedulerService().createReminder({
      title: body.title,
      notes: body.notes,
      dueAt: body.dueAt,
      timezone: body.timezone,
      recurrence: body.recurrence,
      locationId: body.locationId,
      triggerOn: body.triggerOn,
      isAlarm: body.isAlarm,
    });
    res.status(201).json({ reminder });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

assistantRoutes.put('/reminders/:id', async (req: Request, res: Response) => {
  const updated = await getSchedulerService().updateReminder(String(req.params.id), req.body || {});
  if (!updated) {
    res.status(404).json({ error: 'Reminder not found' });
    return;
  }
  res.json({ reminder: updated });
});

assistantRoutes.delete('/reminders/:id', async (req: Request, res: Response) => {
  const deleted = await getSchedulerService().deleteReminder(String(req.params.id));
  res.status(deleted ? 200 : 404).json({ deleted });
});

// ---- Notifications (Phase 4/5/9) ----
assistantRoutes.get('/notifications', async (req: Request, res: Response) => {
  const unreadOnly = req.query.unread === 'true';
  const notifications = await getNotificationService().list(unreadOnly, 50);
  res.json({ notifications });
});

assistantRoutes.post('/notifications/:id/read', async (req: Request, res: Response) => {
  const ok = await getNotificationService().markRead(String(req.params.id));
  res.status(ok ? 200 : 404).json({ read: ok });
});

assistantRoutes.post('/notifications/read-all', async (_req: Request, res: Response) => {
  const count = await getNotificationService().markAllRead();
  res.json({ markedRead: count });
});

// ---- Locations & Geofencing (Phase 6) ----
assistantRoutes.get('/locations', async (_req: Request, res: Response) => {
  const locations = await getLocationService().listLocations();
  res.json({ locations });
});

assistantRoutes.post('/locations', async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      name?: string;
      latitude?: number;
      longitude?: number;
      radiusMeters?: number;
      address?: string;
    };
    if (!body.name || typeof body.latitude !== 'number' || typeof body.longitude !== 'number') {
      res.status(400).json({ error: 'name, latitude, and longitude are required' });
      return;
    }
    const location = await getLocationService().saveLocation({
      name: body.name,
      latitude: body.latitude,
      longitude: body.longitude,
      radiusMeters: body.radiusMeters,
      address: body.address,
    });
    res.status(201).json({ location });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

assistantRoutes.delete('/locations/:id', async (req: Request, res: Response) => {
  const deleted = await getLocationService().deleteLocation(String(req.params.id));
  res.status(deleted ? 200 : 404).json({ deleted });
});

assistantRoutes.post('/locations/geofence', async (req: Request, res: Response) => {
  try {
    const body = req.body as { deviceId?: string; location?: string; eventType?: 'enter' | 'exit' };
    if (!body.deviceId || !body.location || !body.eventType) {
      res.status(400).json({ error: 'deviceId, location, and eventType are required' });
      return;
    }
    const result = await getLocationService().handleGeofenceEvent({
      deviceId: body.deviceId,
      locationIdOrName: body.location,
      eventType: body.eventType,
    });
    res.json(result);
  } catch (err) {
    res.status(403).json({ error: (err as Error).message });
  }
});

// ---- Personality & Runtime Settings (Phase 1 / Phase 9) ----
assistantRoutes.get('/personality', async (_req: Request, res: Response) => {
  const store = await getMemoryStore();
  res.json({ profile: store.getPersonalityProfile() });
});

assistantRoutes.put('/personality', async (req: Request, res: Response) => {
  const store = await getMemoryStore();
  const updated = store.savePersonalityProfile(req.body || {});
  res.json({ profile: updated });
});

assistantRoutes.get('/ollama/status', async (_req: Request, res: Response) => {
  const status = await getOllamaClient().checkStatus();
  res.json(status);
});

assistantRoutes.get('/tools', (_req: Request, res: Response) => {
  const tools = getToolRegistry()
    .list()
    .map((t) => ({
      name: t.name,
      description: t.description,
      risk: t.risk,
      requiredPermissions: t.requiredPermissions,
      timeoutMs: t.timeoutMs,
      inputSchema: t.inputSchema,
    }));
  res.json({ tools });
});

// ---- Security, Audit Logs, Backups & Device Pairing (Phase 10) ----
assistantRoutes.get('/audit', async (req: Request, res: Response) => {
  const limit = parseInt((req.query.limit as string) || '50', 10);
  const store = await getMemoryStore();
  res.json({ logs: store.getAuditLogs(limit) });
});

assistantRoutes.post('/backup', async (_req: Request, res: Response) => {
  try {
    const store = await getMemoryStore();
    const config = getConfig();
    const backupDir = path.join(path.dirname(config.dbPath), 'backups');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = await store.backupDatabase(path.join(backupDir, `friday-backup-${stamp}.db`));
    store.logAudit('admin', 'db:backup', dest, 'low', true);
    res.json({ backedUp: true, path: dest });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRoutes.post('/auth/pair-code', (_req: Request, res: Response) => {
  const result = getAuthService().generatePairingCode();
  res.json(result);
});

assistantRoutes.post('/auth/pair', async (req: Request, res: Response) => {
  try {
    const body = req.body as { code?: string; name?: string; platform?: string; pushToken?: string };
    if (!body.code || !body.name) {
      res.status(400).json({ error: 'code and name are required' });
      return;
    }
    const result = await getAuthService().pairDevice({
      code: body.code,
      name: body.name,
      platform: body.platform,
      pushToken: body.pushToken,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(401).json({ error: (err as Error).message });
  }
});

assistantRoutes.get('/auth/devices', async (_req: Request, res: Response) => {
  const devices = await getAuthService().listDevices();
  res.json({ devices });
});

assistantRoutes.post('/auth/devices/:id/rotate', async (req: Request, res: Response) => {
  const token = await getAuthService().rotateToken(String(req.params.id));
  if (!token) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  res.json({ token });
});

assistantRoutes.delete('/auth/devices/:id', async (req: Request, res: Response) => {
  const revoked = await getAuthService().revokeDevice(String(req.params.id));
  res.status(revoked ? 200 : 404).json({ revoked });
});

assistantRoutes.post('/auth/devices/:id/location-opt-in', async (req: Request, res: Response) => {
  const { optIn } = req.body as { optIn?: boolean };
  if (typeof optIn !== 'boolean') {
    res.status(400).json({ error: 'optIn boolean is required' });
    return;
  }
  const ok = await getAuthService().setLocationOptIn(String(req.params.id), optIn);
  res.status(ok ? 200 : 404).json({ updated: ok, locationOptIn: optIn });
});
