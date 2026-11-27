import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-phase15-test-'));
process.env.FRIDAY_DB_PATH = path.join(tmpDir, 'friday-phase15.db');
process.env.FRIDAY_PORT = '0';

const { getMemoryStore } = await import('../dist/memory/store.js');
const { getMonitoringEngine } = await import('../dist/services/monitoringEngine.js');
const { getNotificationService } = await import('../dist/services/notificationService.js');
const { getAuthService } = await import('../dist/services/authService.js');
const { FridayServer } = await import('../dist/api/server.js');

let targetServer;
let targetPort;
let serverHealthy = true;
let serverSlow = false;
let apiServer;
let apiUrl;
let tokenA;
let actorA;
let logFilePath;

describe('Phase 15: Advanced Monitoring & Proactive Intelligence', () => {
  before(async () => {
    const store = await getMemoryStore();
    await store.initialize();

    const auth = getAuthService();
    const paired = await auth.pairDevice({
      code: auth.generatePairingCode().code,
      name: 'Phase15-Monitor',
      platform: 'windows',
    });
    tokenA = paired.token;
    actorA = paired.device.id;

    logFilePath = path.join(tmpDir, 'app.log');
    fs.writeFileSync(
      logFilePath,
      ['INFO Server started', 'ERROR DB timeout', 'FATAL Crash detected'].join('\n')
    );

    targetServer = http.createServer((_req, res) => {
      if (!serverHealthy) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Service Unavailable');
        return;
      }
      if (serverSlow) {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          }
        }, 250);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
    targetPort = targetServer.address().port;

    apiServer = new FridayServer();
    await apiServer.start(0);
    apiUrl = `http://127.0.0.1:${apiServer.getPort()}`;
  });

  after(async () => {
    getMonitoringEngine().stopAll();
    await apiServer?.stop();
    await new Promise((resolve) => targetServer.close(resolve));
    const store = await getMemoryStore();
    store.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore Windows temp handle delay
    }
  });

  it('1, 2 & 3. monitors healthy, unavailable, and slow HTTP endpoints', async () => {
    const mon = getMonitoringEngine();
    const w = await mon.createWatcher({
      name: 'ERP-API',
      targetUrl: `http://127.0.0.1:${targetPort}/health`,
      method: 'http_health',
      projectName: 'SSVM-ERP',
      environment: 'production',
      latencyThresholdMs: 120,
      failureThreshold: 2,
      actorId: actorA,
    });
    assert.equal(w.health, 'healthy');

    // Slow endpoint triggers degraded
    serverSlow = true;
    const slowRes = await mon.checkWatcherNow(w.id);
    assert.equal(slowRes?.status, 'degraded');
    assert.ok(slowRes?.message.includes('Slow endpoint'));
    serverSlow = false;

    // Unavailable service -> 1st failure is SUSPICION (not yet VERIFIED_INCIDENT)
    serverHealthy = false;
    await mon.checkWatcherNow(w.id);
    const incidents1 = await mon.listIncidents({ actorId: actorA, projectName: 'SSVM-ERP', activeOnly: true });
    assert.ok(incidents1.some((i) => i.stage === 'VERIFIED_INCIDENT' || i.stage === 'SUSPICION'));
    serverHealthy = true;
  });

  it('4 & 5. detects PostgreSQL and Redis outages on unreachable ports', async () => {
    const mon = getMonitoringEngine();
    const pg = await mon.createWatcher({
      name: 'ERP-Postgres',
      targetUrl: 'postgres://127.0.0.1:59991',
      method: 'postgres',
      timeoutMs: 1_000,
      projectName: 'SSVM-ERP',
      actorId: actorA,
    });
    assert.equal(pg.health, 'offline');

    const rd = await mon.createWatcher({
      name: 'ERP-Redis',
      targetUrl: 'redis://127.0.0.1:59992',
      method: 'redis',
      timeoutMs: 1_000,
      projectName: 'SSVM-ERP',
      actorId: actorA,
    });
    assert.equal(rd.health, 'offline');
  });

  it('6. monitors host CPU/RAM, disk usage, and application log errors', async () => {
    const mon = getMonitoringEngine();
    const cpu = await mon.createWatcher({
      name: 'Host-CPU-RAM',
      targetUrl: 'system://local',
      method: 'cpu_memory',
      metricThreshold: 99.9,
      actorId: actorA,
    });
    assert.equal(cpu.health, 'healthy');

    const disk = await mon.createWatcher({
      name: 'Host-Disk',
      targetUrl: `disk://${tmpDir}`,
      method: 'disk_usage',
      metricThreshold: 99.9,
      actorId: actorA,
    });
    assert.equal(disk.health, 'healthy');

    const logs = await mon.createWatcher({
      name: 'App-Logs-High-Error',
      targetUrl: `log://${logFilePath}`,
      method: 'app_logs',
      metricThreshold: 1, // 2 errors in logFilePath > 1 -> degraded
      actorId: actorA,
    });
    assert.equal(logs.health, 'degraded');
  });

  it('7 & 8. escalates repeated failures to VERIFIED_INCIDENT, deduplicates alerts, and verifies recovery', async () => {
    const mon = getMonitoringEngine();
    serverHealthy = true;
    const w = await mon.createWatcher({
      name: 'Recovery-Service',
      targetUrl: `http://127.0.0.1:${targetPort}/health`,
      method: 'http_health',
      failureThreshold: 2,
      projectName: 'RecoveryProj',
      actorId: actorA,
    });
    assert.equal(w.health, 'healthy');

    // 1st failure -> SUSPICION
    serverHealthy = false;
    await mon.checkWatcherNow(w.id);
    let incs = await mon.listIncidents({ actorId: actorA, projectName: 'RecoveryProj' });
    assert.equal(incs[0].stage, 'SUSPICION');

    // 2nd failure -> VERIFIED_INCIDENT
    await mon.checkWatcherNow(w.id);
    incs = await mon.listIncidents({ actorId: actorA, projectName: 'RecoveryProj' });
    assert.equal(incs[0].stage, 'VERIFIED_INCIDENT');
    assert.equal(incs[0].occurrenceCount, 2);

    // Human approval required for incident remediation
    await assert.rejects(
      () => mon.approveIncidentAction(incs[0].id, actorA, false),
      /Explicit human approval/
    );

    // Recovery -> VERIFIED_RECOVERY
    serverHealthy = true;
    await mon.checkWatcherNow(w.id);
    incs = await mon.listIncidents({ actorId: actorA, projectName: 'RecoveryProj' });
    assert.equal(incs[0].stage, 'VERIFIED_RECOVERY');
    assert.ok(incs[0].resolvedAt);
  });

  it('9. detects stale monitoring data when last_check_at is outdated', async () => {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    const mon = getMonitoringEngine();
    const w = await mon.createWatcher({
      name: 'Stale-Check-Service',
      targetUrl: `http://127.0.0.1:${targetPort}/health`,
      method: 'http_health',
      intervalMs: 5_000,
      actorId: actorA,
    });
    db.prepare(`UPDATE watchers SET last_check_at = '2020-01-01 00:00:00' WHERE id = ?`).run(w.id);
    const refreshed = await mon.getWatcher(w.id);
    assert.equal(refreshed?.stale, true);
  });

  it('10. records notification delivery failures with retry & supports acknowledgement', async () => {
    const notifSvc = getNotificationService();
    await notifSvc.savePreferences(actorA, {
      approvedDestinations: ['dashboard', 'http://127.0.0.1:59999/webhook'],
    });
    const n = await notifSvc.notify({
      severity: 'critical',
      title: 'Test Delivery Failure',
      message: 'Webhook unreachable test',
      actorId: actorA,
      dedupeKey: `fail-test-${Date.now()}`,
    });
    assert.ok(n);
    const deliveries = await notifSvc.listDeliveries(20);
    const failed = deliveries.find((d) => d.notificationId === n.id && d.status === 'FAILED');
    assert.ok(failed);
    assert.equal(failed.attempts, 2);

    const acked = await notifSvc.acknowledgeDelivery(n.id);
    assert.equal(acked, true);
  });

  it('11 & 12. supports monitoring cancellation, multi-project isolation, and REST APIs', async () => {
    const mon = getMonitoringEngine();
    const w = await mon.createWatcher({
      name: 'Cancel-Target',
      targetUrl: 'system://local',
      method: 'cpu_memory',
      projectName: 'IsolatedProjB',
      actorId: actorA,
    });
    const stopped = await mon.stopWatcher(w.id);
    assert.equal(stopped, true);
    const afterStop = await mon.getWatcher(w.id);
    assert.equal(afterStop?.status, 'stopped');
    assert.equal(afterStop?.workerRunning, false);

    // Project isolation via REST API
    const ovRes = await fetch(
      `${apiUrl}/friday/monitoring/overview?actorId=${encodeURIComponent(actorA)}&projectName=IsolatedProjB`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    assert.equal(ovRes.status, 200);
    const ovJson = await ovRes.json();
    assert.equal(ovJson.totalWatchers, 1);
    assert.equal(ovJson.watchers[0].projectName, 'IsolatedProjB');
  });
});
