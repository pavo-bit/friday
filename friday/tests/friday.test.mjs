import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Use a temporary isolated SQLite database for tests
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-test-'));
const testDbPath = path.join(tempDir, 'friday-test.db');
process.env.FRIDAY_DB_PATH = testDbPath;

const { PersonalityEngine, DEFAULT_PERSONALITY_PROFILE } = await import('../dist/intelligence/personality.js');
const { redactSecrets, containsSensitiveCredential } = await import('../dist/memory/redaction.js');
const { getMemoryStore } = await import('../dist/memory/store.js');
const { getToolRegistry } = await import('../dist/orchestration/toolRegistry.js');
const { getMonitoringEngine, MonitoringEngine } = await import('../dist/services/monitoringEngine.js');
const { getSchedulerService } = await import('../dist/services/schedulerService.js');
const { getNotificationService } = await import('../dist/services/notificationService.js');
const { getLocationService } = await import('../dist/services/locationService.js');
const { getAuthService } = await import('../dist/services/authService.js');

const store = await getMemoryStore();

test.after(() => {
  getMonitoringEngine().stopAll();
  getSchedulerService().stop();
  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('PersonalityEngine: greetings, farewells, and no false success claims', () => {
  const engine = new PersonalityEngine();
  const morning = new Date('2026-11-27T08:00:00Z');
  const greeting = engine.buildGreeting(
    { ...DEFAULT_PERSONALITY_PROFILE, userName: 'Mayuresh', timezone: 'UTC' },
    { pendingRemindersCount: 2, unhealthyWatchersCount: 0, allSystemsHealthy: true, now: morning },
    true
  );

  assert.match(greeting, /Good morning, Mayuresh/i);
  assert.match(greeting, /2 pending reminders/i);
  assert.match(greeting, /systems are healthy/i);

  const farewell = engine.buildFarewell(DEFAULT_PERSONALITY_PROFILE, 'Good night FRIDAY');
  assert.match(farewell, /Good night/i);

  const unverified = engine.formatVerifiedSuccess('started watcher', false);
  assert.match(unverified, /could not verify/i);
});

test('MemoryStore & Redaction: CRUD, secret blocking, and bounded context', () => {
  assert.equal(containsSensitiveCredential('my password is secret123'), true);
  assert.equal(redactSecrets('Authorization: Bearer abc123xyz999'), 'Authorization: Bearer [REDACTED]');

  assert.throws(() => store.store('fact', 'pw', 'my password is supersecret'));

  const id = store.store('preference', 'default_editor', 'VS Code');
  assert.ok(id);
  const retrieved = store.retrieve('preference', 'default_editor');
  assert.equal(retrieved.length, 1);
  assert.equal(retrieved[0].value, 'VS Code');

  assert.equal(store.updateMemory(id, 'Antigravity IDE'), true);
  assert.equal(store.retrieve('preference', 'default_editor')[0].value, 'Antigravity IDE');

  const ctx = store.getRelevantContext('default_editor', 3);
  assert.match(ctx, /Antigravity IDE/);

  assert.equal(store.deleteMemory(id), true);
});

test('ToolRegistry: all required tools registered, validation, and execution', async () => {
  const registry = getToolRegistry();
  const requiredTools = [
    'get_current_time',
    'get_system_status',
    'check_ollama_status',
    'check_server_health',
    'create_reminder',
    'create_alarm',
    'list_reminders',
    'update_reminder',
    'delete_reminder',
    'start_dashboard_watch',
    'stop_dashboard_watch',
    'pause_dashboard_watch',
    'resume_dashboard_watch',
    'get_dashboard_watch_status',
    'list_dashboard_watchers',
    'get_monitoring_history',
    'get_location_status',
    'send_notification',
  ];

  for (const name of requiredTools) {
    assert.ok(registry.get(name), `Expected tool ${name} to be registered`);
  }

  const invalid = await registry.execute('check_server_health', { url: 'ftp://invalid' });
  assert.equal(invalid.success, false);
  assert.match(invalid.message, /Invalid arguments/i);

  const timeRes = await registry.execute('get_current_time', { timezone: 'UTC' });
  assert.equal(timeRes.success, true);
  assert.equal(timeRes.verified, true);
});

test('MonitoringEngine: watcher lifecycle, offline alert, deduplication, and restart recovery', async () => {
  let serverUp = true;
  const server = http.createServer((_req, res) => {
    if (serverUp) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.writeHead(503);
      res.end('Unavailable');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}/health`;

  const monitoring = getMonitoringEngine();
  const watcher = await monitoring.createWatcher({
    name: 'Test Dashboard',
    targetUrl: url,
    intervalMs: 60_000,
    failureThreshold: 1,
  });

  assert.equal(watcher.workerRunning, true);
  assert.equal(watcher.health, 'healthy');

  // Simulate endpoint going offline
  serverUp = false;
  await monitoring.checkWatcherNow(watcher.id);
  const afterFail = await monitoring.getWatcher(watcher.id);
  assert.equal(afterFail.health, 'offline');

  // Alert deduplication: second immediate failure shouldn't create duplicate notification
  await monitoring.checkWatcherNow(watcher.id);
  const notifs = await getNotificationService().list(false, 20);
  const matchingAlerts = notifs.filter((n) => n.source === `watcher:${watcher.id}` && n.severity !== 'info');
  assert.equal(matchingAlerts.length, 1);

  // Pause & resume
  assert.equal(await monitoring.pauseWatcher(watcher.id), true);
  assert.equal((await monitoring.getWatcher(watcher.id)).workerRunning, false);
  assert.equal(await monitoring.resumeWatcher(watcher.id), true);
  assert.equal((await monitoring.getWatcher(watcher.id)).workerRunning, true);

  // Restart recovery using a fresh MonitoringEngine instance
  monitoring.stopAll();
  const recoveredEngine = new MonitoringEngine();
  const recoveredCount = await recoveredEngine.recoverOnBoot();
  assert.ok(recoveredCount >= 1);
  recoveredEngine.stopAll();

  await new Promise((resolve) => server.close(resolve));
});

test('SchedulerService: one-time, recurring, missed-event recovery, and duplicate prevention', async () => {
  const scheduler = getSchedulerService();
  const pastDue = new Date(Date.now() - 120_000).toISOString();

  const oneTime = await scheduler.createReminder({
    title: 'Missed assignment',
    dueAt: pastDue,
    recurrence: 'none',
  });
  const recurring = await scheduler.createReminder({
    title: 'Weekly project check',
    dueAt: pastDue,
    recurrence: 'weekly',
  });

  const triggered = await scheduler.processDueReminders(new Date());
  assert.ok(triggered.some((r) => r.id === oneTime.id));
  assert.ok(triggered.some((r) => r.id === recurring.id));

  const updatedOneTime = await scheduler.getReminder(oneTime.id);
  assert.equal(updatedOneTime.status, 'triggered');

  const updatedRecurring = await scheduler.getReminder(recurring.id);
  assert.equal(updatedRecurring.status, 'pending');
  assert.ok(new Date(updatedRecurring.dueAt).getTime() > Date.now());

  // Duplicate prevention: immediate second run should not re-trigger
  const secondRun = await scheduler.processDueReminders(new Date());
  assert.equal(secondRun.some((r) => r.id === oneTime.id), false);
});

test('AuthService & LocationService: pairing, token rotation, opt-in privacy, and geofence trigger', async () => {
  const auth = getAuthService();
  const { code } = auth.generatePairingCode();
  const { device, token } = await auth.pairDevice({ code, name: 'Pixel Test', platform: 'android' });
  assert.ok(token.startsWith('frd_'));
  assert.ok(await auth.verifyToken(token));

  const rotated = await auth.rotateToken(device.id);
  assert.ok(rotated && rotated !== token);
  assert.equal(await auth.verifyToken(token), null);
  assert.ok(await auth.verifyToken(rotated));

  const locService = getLocationService();
  const college = await locService.saveLocation({
    name: 'college',
    latitude: 12.9716,
    longitude: 77.5946,
    radiusMeters: 150,
  });
  const rem = await getSchedulerService().createReminder({
    title: 'Collect documents',
    locationId: college.id,
    triggerOn: 'enter',
  });

  // Should fail when opt-in is disabled
  await assert.rejects(() =>
    locService.handleGeofenceEvent({ deviceId: device.id, locationIdOrName: 'college', eventType: 'enter' })
  );

  // Enable opt-in and trigger
  await auth.setLocationOptIn(device.id, true);
  const res = await locService.handleGeofenceEvent({
    deviceId: device.id,
    locationIdOrName: 'college',
    eventType: 'enter',
  });
  assert.equal(res.triggeredRemindersCount, 1);
  assert.equal((await getSchedulerService().getReminder(rem.id)).status, 'triggered');

  assert.equal(await auth.revokeDevice(device.id), true);
});
