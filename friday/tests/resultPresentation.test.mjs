import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { WebSocket } from 'ws';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-phase5-test-'));
process.env.FRIDAY_DB_PATH = path.join(tmpDir, 'friday-phase5.db');
process.env.FRIDAY_PORT = '0';
process.env.FRIDAY_REQUIRE_WS_AUTH = 'true';

const { getMemoryStore } = await import('../dist/memory/store.js');
const { getResultVerifier } = await import('../dist/orchestration/resultVerifier.js');
const { validatePresentationContract } = await import('../dist/presentation/presentationTypes.js');
const { getDisplayManager } = await import('../dist/presentation/displayManager.js');
const { getCapabilityRegistry } = await import('../dist/orchestration/toolRegistry.js');
const { getToolPlanner } = await import('../dist/orchestration/toolPlanner.js');
const { getBackgroundOrchestrator } = await import('../dist/orchestration/backgroundOrchestrator.js');
const { getAuthService } = await import('../dist/services/authService.js');
const { FridayServer } = await import('../dist/api/server.js');
const { WsMessageType } = await import('../dist/shared/types.js');

let server;
let baseUrl;
let wsBaseUrl;
let deviceA;
let tokenA;
let deviceB;
let tokenB;

describe('Phase 5: Result Verifier, Presentation Contracts & JARVIS Display', () => {
  before(async () => {
    const store = await getMemoryStore();
    await store.initialize();

    const auth = getAuthService();
    const pA = await auth.pairDevice({
      code: auth.generatePairingCode().code,
      name: 'Display Device A',
      platform: 'android',
    });
    deviceA = pA.device;
    tokenA = pA.token;

    const pB = await auth.pairDevice({
      code: auth.generatePairingCode().code,
      name: 'Display Device B',
      platform: 'android',
    });
    deviceB = pB.device;
    tokenB = pB.token;

    server = new FridayServer();
    await server.start(0);
    const port = server.getPort();
    baseUrl = `http://127.0.0.1:${port}`;
    wsBaseUrl = `ws://127.0.0.1:${port}/friday/ws`;
  });

  after(async () => {
    await server?.stop();
    const store = await getMemoryStore();
    await store.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Ignore Windows file-lock cleanup race in temp dir
    }
  });

  it('Migration v5 created presentations table and indexes', async () => {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'presentations'`)
      .all();
    assert.equal(tables.length, 1);
  });

  it('ResultVerifier validates schemas, provenance, freshness, partial, unavailable, and task/step identity', () => {
    const registry = getCapabilityRegistry();
    registry.register({
      id: 'test.phase5.strict',
      name: 'Strict Output Tool',
      description: 'Requires count number',
      category: 'system',
      version: '1.0.0',
      trusted: true,
      riskLevel: 'low',
      permissions: [],
      inputSchema: { type: 'object', properties: {}, required: [] },
      outputSchema: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
      },
      timeoutMs: 5000,
      execute: async () => ({ success: true, verified: true, message: 'ok', data: { count: 1 } }),
    });

    const verifier = getResultVerifier();
    const fakeTask = {
      id: 'task-v1',
      ownerId: 'local',
      conversationId: 'conv-1',
      status: 'VERIFYING',
      originalRequest: 'Verify outputs',
    };

    // Valid output + missing freshness metadata -> VERIFIED with explicit unavailable freshness label
    const okRes = verifier.verifyTaskExecution(
      fakeTask,
      [
        {
          id: 'task-v1:s1',
          taskId: 'task-v1',
          stepId: 's1',
          capabilityId: 'test.phase5.strict',
          status: 'COMPLETED',
          result: { success: true, verified: true, message: 'Done', data: { count: 42 } },
          completedAt: new Date().toISOString(),
        },
      ],
      registry
    );
    assert.equal(okRes.status, 'VERIFIED');
    assert.match(okRes.provenance[0].freshnessLabel, /unavailable/i);

    // Invalid output schema -> UNVERIFIED
    const badSchema = verifier.verifyTaskExecution(
      fakeTask,
      [
        {
          id: 'task-v1:s1',
          taskId: 'task-v1',
          stepId: 's1',
          capabilityId: 'test.phase5.strict',
          status: 'COMPLETED',
          result: { success: true, verified: true, message: 'Bad', data: { count: 'not-a-number' } },
        },
      ],
      registry
    );
    assert.equal(badSchema.status, 'UNVERIFIED');

    // Stale/cached data -> STALE
    const staleRes = verifier.verifyTaskExecution(
      fakeTask,
      [
        {
          id: 'task-v1:s1',
          taskId: 'task-v1',
          stepId: 's1',
          capabilityId: 'test.phase5.strict',
          status: 'COMPLETED',
          result: {
            success: true,
            verified: true,
            message: 'Cached',
            data: { count: 10, sourceType: 'cached', freshnessSeconds: 600 },
          },
        },
      ],
      registry
    );
    assert.equal(staleRes.status, 'STALE');
    assert.equal(staleRes.provenance[0].stale, true);

    // Partial result (1 ok + 1 failed) -> PARTIALLY_VERIFIED
    const partialRes = verifier.verifyTaskExecution(
      fakeTask,
      [
        {
          id: 'task-v1:s1',
          taskId: 'task-v1',
          stepId: 's1',
          capabilityId: 'test.phase5.strict',
          status: 'COMPLETED',
          result: { success: true, verified: true, message: 'Ok', data: { count: 1 } },
        },
        {
          id: 'task-v1:s2',
          taskId: 'task-v1',
          stepId: 's2',
          capabilityId: 'test.phase5.strict',
          status: 'FAILED',
          errorMessage: 'Downstream error',
        },
      ],
      registry
    );
    assert.equal(partialRes.status, 'PARTIALLY_VERIFIED');
    assert.equal(partialRes.partial, true);

    // Unavailable capability -> UNAVAILABLE
    const unavailRes = verifier.verifyTaskExecution(
      fakeTask,
      [
        {
          id: 'task-v1:s1',
          taskId: 'task-v1',
          stepId: 's1',
          capabilityId: 'non.existent.cap',
          status: 'COMPLETED',
          result: { success: true, verified: true, message: 'Ok', data: {} },
        },
      ],
      registry
    );
    assert.equal(unavailRes.status, 'UNAVAILABLE');

    // Task ID mismatch -> UNVERIFIED
    const wrongTaskRes = verifier.verifyTaskExecution(
      fakeTask,
      [
        {
          id: 'other:s1',
          taskId: 'other-task',
          stepId: 's1',
          capabilityId: 'test.phase5.strict',
          status: 'COMPLETED',
          result: { success: true, verified: true, message: 'Ok', data: { count: 1 } },
        },
      ],
      registry
    );
    assert.equal(wrongTaskRes.status, 'UNVERIFIED');
  });

  it('Presentation contract rejects arbitrary HTML/JS payloads and invalid types', () => {
    const badHtml = validatePresentationContract({
      presentationId: 'p1',
      presentationType: 'summary',
      verificationStatus: 'VERIFIED',
      title: 'Report <script>alert(1)</script>',
      summary: 'Safe summary',
      data: { nested: { link: 'javascript:alert(2)' } },
      actions: [],
    });
    assert.equal(badHtml.valid, false);
    assert.ok(badHtml.errors.some((e) => /Unsafe HTML\/JS/i.test(e)));

    const badType = validatePresentationContract({
      presentationId: 'p2',
      presentationType: 'executable_widget',
      verificationStatus: 'VERIFIED',
      title: 'Valid title',
      summary: 'Valid summary',
      data: {},
    });
    assert.equal(badType.valid, false);
  });

  it('End-to-end BackgroundOrchestrator -> ResultVerifier -> DisplayManager -> REST & WS isolation', async () => {
    const registry = getCapabilityRegistry();
    registry.register({
      id: 'test.phase5.table',
      name: 'Table Generator',
      description: 'Generates structured table data',
      category: 'system',
      version: '1.0.0',
      trusted: true,
      riskLevel: 'low',
      permissions: [],
      inputSchema: { type: 'object', properties: {}, required: [] },
      outputSchema: {
        type: 'object',
        properties: { rows: { type: 'array' } },
        required: ['rows'],
      },
      timeoutMs: 5000,
      execute: async () => ({
        success: true,
        verified: true,
        message: 'Generated 2 rows',
        data: {
          sourceName: 'Local Metrics DB',
          sourceType: 'live',
          freshnessSeconds: 2,
          rows: [
            { service: 'api', latencyMs: 12 },
            { service: 'db', latencyMs: 4 },
          ],
        },
      }),
    });

    // Connect WS clients for Device A and Device B
    const wsA = new WebSocket(wsBaseUrl, { headers: { Authorization: `Bearer ${tokenA}` } });
    const wsB = new WebSocket(wsBaseUrl, { headers: { Authorization: `Bearer ${tokenB}` } });
    const eventsA = [];
    const eventsB = [];

    await Promise.all([
      new Promise((resolve, reject) => {
        wsA.on('open', resolve);
        wsA.on('error', reject);
      }),
      new Promise((resolve, reject) => {
        wsB.on('open', resolve);
        wsB.on('error', reject);
      }),
    ]);
    wsA.on('message', (d) => eventsA.push(JSON.parse(d.toString())));
    wsB.on('message', (d) => eventsB.push(JSON.parse(d.toString())));

    const plan = await getToolPlanner().validateProposedPlan({
      originalRequest: 'Show service latency table',
      conversationId: 'conv-phase5-1',
      steps: [{ stepId: 's1', capabilityId: 'test.phase5.table', arguments: {}, dependencies: [] }],
    });

    const orch = getBackgroundOrchestrator();
    const submitted = await orch.submitPlan(plan, {
      ownerId: `device:${deviceA.id}`,
      conversationId: 'conv-phase5-1',
    });

    let task;
    for (let i = 0; i < 40; i++) {
      task = await orch.getTask(submitted.taskId);
      if (task?.status === 'COMPLETED') break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(task?.status, 'COMPLETED');

    await new Promise((r) => setTimeout(r, 50));

    // Device A received presentation:event; Device B did NOT
    assert.ok(
      eventsA.some(
        (m) => m.type === WsMessageType.PRESENTATION_EVENT && m.payload?.presentation?.taskId === submitted.taskId
      ),
      'Device A must receive its presentation:event'
    );
    assert.ok(
      !eventsB.some(
        (m) => m.type === WsMessageType.PRESENTATION_EVENT && m.payload?.presentation?.taskId === submitted.taskId
      ),
      'Device B must NOT receive Device A presentation:event'
    );

    wsA.close();
    wsB.close();

    // REST API: GET /friday/tasks/:id/presentation
    const presTaskRes = await fetch(`${baseUrl}/friday/tasks/${submitted.taskId}/presentation`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(presTaskRes.status, 200);
    const { presentation } = await presTaskRes.json();
    assert.equal(presentation.presentationType, 'table');
    assert.equal(presentation.verificationStatus, 'VERIFIED');
    assert.equal(presentation.conversationId, 'conv-phase5-1');
    assert.equal(presentation.provenance[0].sourceName, 'Local Metrics DB');

    // Cross-device access -> 403
    const forbidTaskPres = await fetch(`${baseUrl}/friday/tasks/${submitted.taskId}/presentation`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(forbidTaskPres.status, 403);

    const forbidPres = await fetch(`${baseUrl}/friday/presentations/${presentation.presentationId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(forbidPres.status, 403);

    // Follow-up context preservation
    const ctx = await getDisplayManager().buildFollowUpContext(`device:${deviceA.id}`, 'conv-phase5-1');
    assert.equal(ctx.length, 1);
    assert.equal(ctx[0].presentationId, presentation.presentationId);
  });
});
