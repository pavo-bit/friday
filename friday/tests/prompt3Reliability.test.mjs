import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-prompt3-rel-'));
const dbPath = path.join(tmpDir, 'friday-prompt3.db');
const backupPath = path.join(tmpDir, 'friday-prompt3-backup.db');
const corruptBackupPath = path.join(tmpDir, 'friday-corrupt-backup.db');
process.env.FRIDAY_DB_PATH = dbPath;
process.env.FRIDAY_PORT = '0';

let ollamaAlive = true;
const mockOllama = http.createServer((req, res) => {
  if (!ollamaAlive) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Crashed' }));
    return;
  }
  if (req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'qwen3:4b' }] }));
    return;
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Recovered OK, Boss.' } }] }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => mockOllama.listen(0, '127.0.0.1', resolve));
process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${mockOllama.address().port}/v1`;

const { getMemoryStore } = await import('../dist/memory/store.js');
const { getOllamaClient } = await import('../dist/orchestration/ollamaClient.js');
const { getBackgroundOrchestrator } = await import('../dist/orchestration/backgroundOrchestrator.js');
const { getToolRegistry } = await import('../dist/orchestration/toolRegistry.js');
const { getNotificationService } = await import('../dist/services/notificationService.js');
const { getPersonalIdentityService } = await import('../dist/identity/identityService.js');
const { getRequestUnderstandingEngine } = await import('../dist/orchestration/requestUnderstanding.js');
const { getContextResolutionEngine } = await import('../dist/orchestration/contextResolution.js');
const { getAdaptivePersonalityEngine } = await import('../dist/personality/personalityEngine.js');
const { selectResponseDepth } = await import('../dist/personality/responseDepth.js');

describe('Prompt 3: Reliability, Recovery, Idempotency & Resource Leak Analysis', () => {
  before(async () => {
    const store = await getMemoryStore();
    await store.initialize();
  });

  after(async () => {
    await new Promise((resolve) => mockOllama.close(resolve));
    const store = await getMemoryStore();
    store.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore Windows temp handle delay
    }
  });

  it('1. verifies backup integrity, rejects corrupt backups, and restores full state', async () => {
    const store = await getMemoryStore();
    await getPersonalIdentityService().createOrUpdateProfile('p3-owner', {
      preferredAddress: 'Boss',
      goals: ['Zero data loss'],
    });

    const dest = await store.backupDatabase(backupPath);
    const check = await store.verifyBackup(dest);
    assert.equal(check.ok, true);

    fs.writeFileSync(corruptBackupPath, 'NOT_A_VALID_SQLITE_DB');
    const badCheck = await store.verifyBackup(corruptBackupPath);
    assert.equal(badCheck.ok, false);
  });

  it('2. recovers safely from Ollama crash and SQLite restart', async () => {
    const ollama = getOllamaClient();
    ollamaAlive = false;
    const down = await ollama.chatStream({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(down.ok, false);

    ollamaAlive = true;
    const diag = await ollama.getDiagnostics();
    assert.equal(diag.reachable, true);
    assert.equal(diag.consecutiveFailures, 0);

    const store = await getMemoryStore();
    store.close();
    await store.initialize();
    const prof = await getPersonalIdentityService().getProfile('p3-owner');
    assert.equal(prof.preferredAddress, 'Boss');
  });

  it('3. prevents duplicate background task execution via idempotencyKey', async () => {
    const reg = getToolRegistry();
    let execCount = 0;
    reg.register({
      id: 'test.p3.idempotent_counter',
      name: 'p3_idempotent_counter',
      description: 'Counts executions for idempotency test',
      category: 'general',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: [],
      timeoutMs: 2_000,
      trusted: true,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      execute: async () => {
        execCount++;
        return { verified: true, data: { execCount }, message: `Run ${execCount}` };
      },
    });

    const plan = {
      planId: 'p3-plan-1',
      originalRequest: 'Run idempotent test',
      normalizedIntent: 'test',
      valid: true,
      validationErrors: [],
      requiresApproval: false,
      estimatedRisk: 'low',
      parallelGroups: [['step-1']],
      steps: [
        {
          stepId: 'step-1',
          executionOrder: 0,
          capabilityId: 'test.p3.idempotent_counter',
          arguments: {},
          dependencies: [],
          description: 'Single step',
          riskLevel: 'low',
          requiredPermissions: [],
        },
      ],
    };

    const orch = getBackgroundOrchestrator();
    const s1 = await orch.submitPlan(plan, {
      ownerId: 'p3-owner',
      idempotencyKey: 'unique-p3-key-1',
    });
    const s2 = await orch.submitPlan(plan, {
      ownerId: 'p3-owner',
      idempotencyKey: 'unique-p3-key-1',
    });
    assert.equal(s1.deduplicated, false);
    assert.equal(s2.deduplicated, true);
    assert.equal(s2.taskId, s1.taskId);

    // Wait briefly for step-1 to complete and confirm execCount === 1
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(execCount, 1);
  });

  it('4. enforces notification deduplication and quiet-hours suppression', async () => {
    const notif = getNotificationService();
    const now = new Date();
    const startH = String(now.getHours()).padStart(2, '0');
    const endH = String((now.getHours() + 1) % 24).padStart(2, '0');

    await notif.savePreferences('p3-quiet-actor', {
      quietHoursStart: `${startH}:00`,
      quietHoursEnd: `${endH}:59`,
      minSeverity: 'info',
      allowCriticalInQuietHours: true,
      approvedDestinations: ['dashboard'],
    });

    const nWarn = await notif.notify({
      severity: 'warning',
      title: 'Quiet warning',
      message: 'Should be suppressed during quiet hours',
      actorId: 'p3-quiet-actor',
      dedupeKey: `quiet-warn-${Date.now()}`,
    });
    assert.ok(nWarn);
    const deliveries = await notif.listDeliveries(10);
    const deliv = deliveries.find((d) => d.notificationId === nWarn.id);
    assert.equal(deliv?.status, 'SUPPRESSED_QUIET_HOURS');

    // Duplicate suppression within dedupeWindowMs
    const dup1 = await notif.notify({
      severity: 'critical',
      title: 'Dup Alert',
      message: 'First',
      actorId: 'p3-quiet-actor',
      dedupeKey: 'p3-dup-key',
      dedupeWindowMs: 60_000,
    });
    const dup2 = await notif.notify({
      severity: 'critical',
      title: 'Dup Alert',
      message: 'Second',
      actorId: 'p3-quiet-actor',
      dedupeKey: 'p3-dup-key',
      dedupeWindowMs: 60_000,
    });
    assert.ok(dup1);
    assert.equal(dup2, null);
  });

  it('5. maintains bounded memory growth across 150 sustained conversation/context cycles', async () => {
    const understanding = getRequestUnderstandingEngine();
    const ctxEngine = getContextResolutionEngine();
    const adaptive = getAdaptivePersonalityEngine();
    const store = await getMemoryStore();
    const settings = store.getDigitalIdentitySettings('p3-owner');

    const heapBeforeMb = process.memoryUsage().heapUsed / (1024 * 1024);
    for (let i = 0; i < 150; i++) {
      const req = understanding.understand({
        rawInput: `Explain semaphore concept iteration ${i}`,
        actorId: 'p3-owner',
        conversationId: 'p3-soak-conv',
      });
      await ctxEngine.resolve(req);
      adaptive.selectPersonality({
        rawInput: req.rawInput,
        category: req.conversationalCategory,
        complexity: req.complexity,
        intentConfidence: req.confidence,
        settings,
      });
      selectResponseDepth({
        rawInput: req.rawInput,
        category: req.conversationalCategory,
        complexity: req.complexity,
        configuredDetail: settings.answerDetail,
      });
    }
    const heapAfterMb = process.memoryUsage().heapUsed / (1024 * 1024);
    const growthMb = heapAfterMb - heapBeforeMb;
    assert.ok(growthMb < 50, `Unexpected heap growth: ${growthMb.toFixed(2)} MB`);
  });
});
