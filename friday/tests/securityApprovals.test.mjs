import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { WebSocket } from 'ws';

// Isolated test DB & config
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-phase4-test-'));
process.env.FRIDAY_DB_PATH = path.join(tmpDir, 'friday-phase4.db');
process.env.FRIDAY_PORT = '0';
process.env.FRIDAY_REQUIRE_WS_AUTH = 'true';

const { getMemoryStore } = await import('../dist/memory/store.js');
const { getSafetyGate } = await import('../dist/orchestration/safetyGate.js');
const {
  canonicalizeJson,
  computeArgumentsHash,
  computeActionHash,
} = await import('../dist/orchestration/approvalStore.js');
const { getCapabilityRegistry } = await import('../dist/orchestration/toolRegistry.js');
const { getToolPlanner } = await import('../dist/orchestration/toolPlanner.js');
const { getBackgroundOrchestrator } = await import('../dist/orchestration/backgroundOrchestrator.js');
const { getAuthService } = await import('../dist/services/authService.js');
const { FridayServer } = await import('../dist/api/server.js');
const { eventBus } = await import('../dist/shared/events.js');
const { WsMessageType } = await import('../dist/shared/types.js');

let server;
let baseUrl;
let wsBaseUrl;
let deviceA;
let tokenA;
let deviceB;
let tokenB;

describe('Phase 4: Persistent Security, Bound Approvals & WebSocket Auth', () => {
  before(async () => {
    const store = await getMemoryStore();
    await store.initialize();

    const auth = getAuthService();
    const codeA = auth.generatePairingCode().code;
    const pairedA = await auth.pairDevice({ code: codeA, name: 'Device A', platform: 'android' });
    deviceA = pairedA.device;
    tokenA = pairedA.token;

    const codeB = auth.generatePairingCode().code;
    const pairedB = await auth.pairDevice({ code: codeB, name: 'Device B', platform: 'android' });
    deviceB = pairedB.device;
    tokenB = pairedB.token;

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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Migration v4 created capability_approvals table and device revocation/expiry columns', async () => {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'capability_approvals'`)
      .all();
    assert.equal(tables.length, 1);

    const cols = db.prepare(`PRAGMA table_info(devices)`).all().map((c) => c.name);
    assert.ok(cols.includes('revoked'));
    assert.ok(cols.includes('token_expires_at'));
  });

  it('Deterministic canonical JSON and SHA-256 binding detect any argument or context tampering', () => {
    const a1 = computeArgumentsHash({ b: 2, a: 1, nested: { y: 'y', x: 'x' } });
    const a2 = computeArgumentsHash({ nested: { x: 'x', y: 'y' }, a: 1, b: 2 });
    assert.equal(a1, a2);
    assert.equal(
      canonicalizeJson({ z: 1, a: [3, 2] }),
      '{"a":[3,2],"z":1}'
    );

    const hBase = computeActionHash({
      taskId: 't1',
      stepId: 's1',
      capabilityId: 'cap.a',
      argumentsHash: a1,
      actorId: 'device:d1',
      deviceId: 'd1',
      permissionScope: 'fs:write',
    });
    const hDiffScope = computeActionHash({
      taskId: 't1',
      stepId: 's1',
      capabilityId: 'cap.a',
      argumentsHash: a1,
      actorId: 'device:d1',
      deviceId: 'd1',
      permissionScope: 'fs:delete',
    });
    assert.notEqual(hBase, hDiffScope);
  });

  it('Bound approval enforces single-use consumption, rejects replay and argument tampering', async () => {
    const gate = getSafetyGate();
    const approval = await gate.createBoundApproval({
      taskId: 'task-bind-1',
      stepId: 'step-1',
      capabilityId: 'cap.secure',
      args: { path: '/safe/file.txt', mode: 'write' },
      actorId: `device:${deviceA.id}`,
      deviceId: deviceA.id,
      permissionScope: 'fs:write',
      riskLevel: 'high',
      summary: 'Write file',
    });
    assert.equal(approval.status, 'PENDING');

    // Unauthorized actor cannot approve
    const unauth = await gate.resolveBoundApproval({
      approvalId: approval.approvalId,
      decision: 'APPROVE',
      actorId: `device:${deviceB.id}`,
    });
    assert.equal(unauth.ok, false);
    assert.equal(unauth.httpStatus, 403);

    // Owner approves
    const approved = await gate.resolveBoundApproval({
      approvalId: approval.approvalId,
      decision: 'APPROVE',
      actorId: `device:${deviceA.id}`,
    });
    assert.equal(approved.ok, true);
    assert.equal(approved.status, 'APPROVED');

    // Tampered arguments must fail consumption
    const tampered = await gate.consumeBoundApproval({
      approvalId: approval.approvalId,
      taskId: 'task-bind-1',
      stepId: 'step-1',
      capabilityId: 'cap.secure',
      args: { path: '/etc/passwd', mode: 'write' },
      actorId: `device:${deviceA.id}`,
      deviceId: deviceA.id,
      permissionScope: 'fs:write',
    });
    assert.equal(tampered.ok, false);

    // Exact match consumes atomically
    const consumed = await gate.consumeBoundApproval({
      approvalId: approval.approvalId,
      taskId: 'task-bind-1',
      stepId: 'step-1',
      capabilityId: 'cap.secure',
      args: { mode: 'write', path: '/safe/file.txt' },
      actorId: `device:${deviceA.id}`,
      deviceId: deviceA.id,
      permissionScope: 'fs:write',
    });
    assert.equal(consumed.ok, true);
    assert.equal(consumed.approval?.status, 'CONSUMED');

    // Replay must fail
    const replay = await gate.consumeBoundApproval({
      approvalId: approval.approvalId,
      taskId: 'task-bind-1',
      stepId: 'step-1',
      capabilityId: 'cap.secure',
      args: { path: '/safe/file.txt', mode: 'write' },
      actorId: `device:${deviceA.id}`,
      deviceId: deviceA.id,
      permissionScope: 'fs:write',
    });
    assert.equal(replay.ok, false);
  });

  it('Expired approvals cannot be resolved or consumed', async () => {
    const gate = getSafetyGate();
    const expired = await gate.createBoundApproval({
      taskId: 'task-exp-1',
      stepId: 'step-1',
      capabilityId: 'cap.exp',
      args: { x: 1 },
      actorId: `device:${deviceA.id}`,
      deviceId: deviceA.id,
      permissionScope: 'default',
      riskLevel: 'high',
      ttlMs: -1000,
    });

    const loaded = await gate.getBoundApproval(expired.approvalId);
    assert.equal(loaded?.status, 'EXPIRED');

    const res = await gate.resolveBoundApproval({
      approvalId: expired.approvalId,
      decision: 'APPROVE',
      actorId: `device:${deviceA.id}`,
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 'EXPIRED');
    assert.equal(res.httpStatus, 410);
  });

  it('BackgroundOrchestrator pauses high-risk step, resumes on HTTP approval without rerunning completed steps', async () => {
    const registry = getCapabilityRegistry();
    let step1Calls = 0;
    let step2Calls = 0;
    let step3Calls = 0;

    registry.register({
      id: 'test.phase4.step1',
      name: 'Phase4 Step 1',
      description: 'Low-risk step 1',
      category: 'system',
      version: '1.0.0',
      trusted: true,
      riskLevel: 'low',
      permissions: [],
      inputSchema: { type: 'object', properties: {}, required: [] },
      outputSchema: { type: 'object', properties: {}, required: [] },
      timeoutMs: 5000,
      execute: async () => {
        step1Calls++;
        return { success: true, verified: true, message: 'step1-ok', data: { step1Calls } };
      },
    });

    registry.register({
      id: 'test.phase4.step2.highrisk',
      name: 'Phase4 High Risk Step 2',
      description: 'High-risk step requiring approval',
      category: 'system',
      version: '1.0.0',
      trusted: true,
      riskLevel: 'high',
      permissions: ['system:exec'],
      inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
      outputSchema: { type: 'object', properties: {}, required: [] },
      timeoutMs: 5000,
      execute: async (args) => {
        step2Calls++;
        return { success: true, verified: true, message: `step2-ok:${args.target}` };
      },
    });

    registry.register({
      id: 'test.phase4.step3',
      name: 'Phase4 Step 3',
      description: 'Downstream step 3',
      category: 'system',
      version: '1.0.0',
      trusted: true,
      riskLevel: 'low',
      permissions: [],
      inputSchema: { type: 'object', properties: {}, required: [] },
      outputSchema: { type: 'object', properties: {}, required: [] },
      timeoutMs: 5000,
      execute: async () => {
        step3Calls++;
        return { success: true, verified: true, message: 'step3-ok' };
      },
    });

    const orch = getBackgroundOrchestrator();
    const plan = await getToolPlanner().validateProposedPlan({
      originalRequest: 'Run 3-step gated workflow',
      steps: [
        {
          stepId: 's1',
          capabilityId: 'test.phase4.step1',
          arguments: {},
          dependencies: [],
        },
        {
          stepId: 's2',
          capabilityId: 'test.phase4.step2.highrisk',
          arguments: { target: 'prod-cache' },
          dependencies: ['s1'],
        },
        {
          stepId: 's3',
          capabilityId: 'test.phase4.step3',
          arguments: {},
          dependencies: ['s2'],
        },
      ],
    });

    const submit = await orch.submitPlan(plan, {
      ownerId: `device:${deviceA.id}`,
      approvedHighRisk: false,
      grantedPermissions: ['system:exec'],
    });

    // Wait for task to reach WAITING_FOR_APPROVAL
    let task;
    for (let i = 0; i < 40; i++) {
      task = await orch.getTask(submit.taskId);
      if (task?.status === 'WAITING_FOR_APPROVAL') break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(task?.status, 'WAITING_FOR_APPROVAL');
    assert.equal(step1Calls, 1);
    assert.equal(step2Calls, 0);
    assert.equal(step3Calls, 0);

    // Device B cannot list or approve Device A's approval
    const listBRes = await fetch(`${baseUrl}/friday/approvals?taskId=${submit.taskId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(listBRes.status, 200);
    const listB = await listBRes.json();
    assert.equal(listB.approvals.length, 0);

    // Device A lists its pending approval
    const listARes = await fetch(`${baseUrl}/friday/approvals?taskId=${submit.taskId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(listARes.status, 200);
    const listA = await listARes.json();
    assert.equal(listA.approvals.length, 1);
    const approvalId = listA.approvals[0].approvalId;

    // Device B gets 403 on direct approve attempt
    const approveBRes = await fetch(`${baseUrl}/friday/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(approveBRes.status, 403);

    // Invalid bearer token gets 401
    const badAuthRes = await fetch(`${baseUrl}/friday/approvals/${approvalId}`, {
      headers: { Authorization: 'Bearer frd_invalid_token_123' },
    });
    assert.equal(badAuthRes.status, 401);

    // Device A approves -> task resumes and completes
    const approveARes = await fetch(`${baseUrl}/friday/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: 'Confirmed by Boss' }),
    });
    assert.equal(approveARes.status, 200);
    const approveBody = await approveARes.json();
    assert.equal(approveBody.resumed, true);

    for (let i = 0; i < 40; i++) {
      task = await orch.getTask(submit.taskId);
      if (task?.status === 'COMPLETED') break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(task?.status, 'COMPLETED');
    assert.equal(step1Calls, 1, 'Completed step 1 must NOT re-run');
    assert.equal(step2Calls, 1, 'Approved step 2 must run once');
    assert.equal(step3Calls, 1, 'Downstream step 3 must run once');

    const finalApproval = await getSafetyGate().getBoundApproval(approvalId);
    assert.equal(finalApproval?.status, 'CONSUMED');
  });

  it('BackgroundOrchestrator fails cleanly when bound approval is rejected', async () => {
    const orch = getBackgroundOrchestrator();
    const plan = await getToolPlanner().validateProposedPlan({
      originalRequest: 'Reject gated workflow',
      steps: [
        {
          stepId: 's1',
          capabilityId: 'test.phase4.step2.highrisk',
          arguments: { target: 'staging' },
          dependencies: [],
        },
        {
          stepId: 's2',
          capabilityId: 'test.phase4.step3',
          arguments: {},
          dependencies: ['s1'],
        },
      ],
    });

    const submit = await orch.submitPlan(plan, {
      ownerId: `device:${deviceA.id}`,
      approvedHighRisk: false,
      grantedPermissions: ['system:exec'],
    });

    let task;
    for (let i = 0; i < 40; i++) {
      task = await orch.getTask(submit.taskId);
      if (task?.status === 'WAITING_FOR_APPROVAL') break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(task?.status, 'WAITING_FOR_APPROVAL');

    const listRes = await fetch(`${baseUrl}/friday/approvals?taskId=${submit.taskId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const { approvals } = await listRes.json();
    assert.equal(approvals.length, 1);

    const rejectRes = await fetch(`${baseUrl}/friday/approvals/${approvals[0].approvalId}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Not now' }),
    });
    assert.equal(rejectRes.status, 200);

    const failedTask = await orch.getTask(submit.taskId);
    assert.equal(failedTask?.status, 'FAILED');
    const steps = await orch.getTaskSteps(submit.taskId);
    assert.equal(steps[0].status, 'FAILED');
    assert.equal(steps[1].status, 'SKIPPED');
  });

  it('WebSocket /friday/ws enforces Bearer auth, rejects query-string tokens and bad origins, and isolates task events', async () => {
    // 1. No token when FRIDAY_REQUIRE_WS_AUTH=true -> 401
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(wsBaseUrl);
          ws.on('open', () => {
            ws.close();
            resolve();
          });
          ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
          ws.on('error', reject);
        }),
      /401/
    );

    // 2. Query-string token -> 401 (never allowed in URL)
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`${wsBaseUrl}?token=${tokenA}`);
          ws.on('open', () => {
            ws.close();
            resolve();
          });
          ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
          ws.on('error', reject);
        }),
      /401/
    );

    // 3. Cross-origin -> 403
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(wsBaseUrl, {
            headers: {
              Authorization: `Bearer ${tokenA}`,
              Origin: 'https://evil.example.com',
            },
          });
          ws.on('open', () => {
            ws.close();
            resolve();
          });
          ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
          ws.on('error', reject);
        }),
      /403/
    );

    // 4. Valid Bearer auth for Device A (header) & Device B (Sec-WebSocket-Protocol) + event isolation
    const wsA = new WebSocket(wsBaseUrl, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const wsB = new WebSocket(wsBaseUrl, [`bearer.${tokenB}`]);

    const msgsA = [];
    const msgsB = [];

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

    wsA.on('message', (d) => msgsA.push(JSON.parse(d.toString())));
    wsB.on('message', (d) => msgsB.push(JSON.parse(d.toString())));

    // Emit private task event owned by Device A
    eventBus.emitEvent('ws:broadcast', {
      type: WsMessageType.TASK_EVENT,
      payload: {
        eventType: 'task.progress',
        ownerId: `device:${deviceA.id}`,
        taskId: 'private-task-a',
        summary: 'Secret for A',
      },
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 80));

    assert.ok(
      msgsA.some((m) => m.type === WsMessageType.TASK_EVENT && m.payload?.taskId === 'private-task-a'),
      'Device A must receive its own task event'
    );
    assert.ok(
      !msgsB.some((m) => m.type === WsMessageType.TASK_EVENT && m.payload?.taskId === 'private-task-a'),
      'Device B must NOT receive Device A private task event'
    );

    wsA.close();
    wsB.close();

    // 5. Revoked device token is rejected
    const revoked = await getAuthService().revokeDevice(deviceB.id);
    assert.equal(revoked, true);

    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(wsBaseUrl, {
            headers: { Authorization: `Bearer ${tokenB}` },
          });
          ws.on('open', () => {
            ws.close();
            resolve();
          });
          ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
          ws.on('error', reject);
        }),
      /401/
    );
  });
});
