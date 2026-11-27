import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-bg-test-'));
process.env.FRIDAY_DB_PATH = path.join(tempDir, 'bg-test.db');

const { CapabilityRegistry } = await import('../dist/orchestration/toolRegistry.js');
const { ToolPlanner } = await import('../dist/orchestration/toolPlanner.js');
const {
  BackgroundOrchestrator,
  TaskConflictError,
  getBackgroundOrchestrator,
} = await import('../dist/orchestration/backgroundOrchestrator.js');
const { getMemoryStore } = await import('../dist/memory/store.js');
const { eventBus } = await import('../dist/shared/events.js');
const { FridayServer } = await import('../dist/api/server.js');
const { getAuthService } = await import('../dist/services/authService.js');

const store = await getMemoryStore();

async function waitForTaskTerminal(orchestrator, taskId, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await orchestrator.getTask(taskId);
    if (t && ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'INTERRUPTED'].includes(t.status)) {
      return t;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return orchestrator.getTask(taskId);
}

test.after(() => {
  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('SQLite migration v3 applied and immediate taskId returned for async DAG execution', async () => {
  const db = store.getDatabase();
  const mig = db.prepare(`SELECT version FROM schema_migrations WHERE version = 3`).get();
  assert.equal(mig.version, 3);

  const registry = new CapabilityRegistry();
  const planner = new ToolPlanner(registry);
  const orchestrator = new BackgroundOrchestrator(registry);

  const events = [];
  eventBus.onEvent('task.created', (e) => events.push({ type: 'created', ...e }));
  eventBus.onEvent('task.completed', (e) => events.push({ type: 'completed', ...e }));

  const plan = await planner.validateProposedPlan({
    originalRequest: 'Check time and system status',
    steps: [
      { stepId: 's1', capabilityId: 'core.time.get_current_time', dependencies: [] },
      { stepId: 's2', capabilityId: 'core.system.get_system_status', dependencies: ['s1'] },
    ],
  });

  const submitted = await orchestrator.submitPlan(plan, { idempotencyKey: 'idem-1' });
  assert.ok(submitted.taskId);
  assert.equal(submitted.status, 'QUEUED');
  assert.equal(submitted.deduplicated, false);

  // Duplicate submission with same idempotencyKey returns existing task
  const dup = await orchestrator.submitPlan(plan, { idempotencyKey: 'idem-1' });
  assert.equal(dup.taskId, submitted.taskId);
  assert.equal(dup.deduplicated, true);

  const final = await waitForTaskTerminal(orchestrator, submitted.taskId);
  assert.equal(final.status, 'COMPLETED');
  assert.equal(final.progress, 100);

  const steps = await orchestrator.getTaskSteps(submitted.taskId);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].status, 'COMPLETED');
  assert.equal(steps[1].status, 'COMPLETED');

  assert.ok(events.some((e) => e.type === 'created' && e.taskId === submitted.taskId));
  assert.ok(events.some((e) => e.type === 'completed' && e.taskId === submitted.taskId));
});

test('Dependency failure propagation, idempotent retries, and no retry for side effects', async () => {
  const registry = new CapabilityRegistry();
  let flakeyAttempts = 0;
  let unsafeAttempts = 0;

  registry.register({
    id: 'test.flakey_read',
    name: 'flakey_read',
    description: 'Fails once then succeeds',
    riskLevel: 'low',
    trusted: true,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    execute: async () => {
      flakeyAttempts++;
      if (flakeyAttempts === 1) throw new Error('Transient read error');
      return { verified: true, data: { ok: true }, message: 'recovered' };
    },
  });

  registry.register({
    id: 'test.unsafe_write',
    name: 'unsafe_write',
    description: 'Non-idempotent write that fails',
    riskLevel: 'medium',
    trusted: true,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    execute: async () => {
      unsafeAttempts++;
      return { verified: false, message: 'Write failed' };
    },
  });

  registry.register({
    id: 'test.downstream',
    name: 'downstream',
    description: 'Depends on unsafe_write',
    riskLevel: 'low',
    trusted: true,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    execute: async () => ({ verified: true, message: 'should be skipped' }),
  });

  const planner = new ToolPlanner(registry);
  const orchestrator = new BackgroundOrchestrator(registry);

  const plan = await planner.validateProposedPlan({
    originalRequest: 'Retry then fail downstream',
    steps: [
      { stepId: 's1', capabilityId: 'test.flakey_read', dependencies: [] },
      { stepId: 's2', capabilityId: 'test.unsafe_write', dependencies: ['s1'] },
      { stepId: 's3', capabilityId: 'test.downstream', dependencies: ['s2'] },
    ],
  });

  const { taskId } = await orchestrator.submitPlan(plan, { maxStepAttempts: 2 });
  const final = await waitForTaskTerminal(orchestrator, taskId);

  assert.equal(final.status, 'FAILED');
  assert.equal(flakeyAttempts, 2); // retried once
  assert.equal(unsafeAttempts, 1); // never auto-retried

  const steps = await orchestrator.getTaskSteps(taskId);
  assert.equal(steps.find((s) => s.stepId === 's1').status, 'COMPLETED');
  assert.equal(steps.find((s) => s.stepId === 's2').status, 'FAILED');
  assert.equal(steps.find((s) => s.stepId === 's3').status, 'SKIPPED');
});

test('Step timeout, task timeout, cancellation, and invalid state transition', async () => {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'test.slow',
    name: 'slow_cap',
    description: 'Sleeps longer than timeout',
    riskLevel: 'low',
    trusted: true,
    timeoutMs: 500,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    execute: async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return { verified: true, message: 'too late' };
    },
  });

  const planner = new ToolPlanner(registry);
  const orchestrator = new BackgroundOrchestrator(registry, { maxConcurrentLightweight: 1 });

  // Timeout test
  const slowPlan = await planner.validateProposedPlan({
    originalRequest: 'Slow step',
    steps: [{ stepId: 's1', capabilityId: 'test.slow', dependencies: [] }],
  });
  const t1 = await orchestrator.submitPlan(slowPlan);
  const res1 = await waitForTaskTerminal(orchestrator, t1.taskId);
  assert.equal(res1.status, 'FAILED');
  const steps1 = await orchestrator.getTaskSteps(t1.taskId);
  assert.equal(steps1[0].status, 'TIMED_OUT');

  // Cannot cancel already-failed terminal task
  await assert.rejects(() => orchestrator.cancelTask(t1.taskId), TaskConflictError);

  // Cancellation while queued/running
  const quickPlan = await planner.validateProposedPlan({
    originalRequest: 'Cancel before complete',
    steps: [{ stepId: 's1', capabilityId: 'test.slow', dependencies: [] }],
  });
  const t2 = await orchestrator.submitPlan(quickPlan);
  const cancelled = await orchestrator.cancelTask(t2.taskId);
  assert.equal(cancelled.status, 'CANCELLED');
});

test('Restart recovery: preserves completed steps, resumes idempotent, interrupts unsafe side effects', async () => {
  const registry = new CapabilityRegistry();
  let safeCalls = 0;
  let unsafeCalls = 0;

  registry.register({
    id: 'test.safe_step',
    name: 'safe_step',
    description: 'Idempotent step',
    riskLevel: 'low',
    trusted: true,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    execute: async () => {
      safeCalls++;
      return { verified: true, data: { safeCalls }, message: 'safe ok' };
    },
  });

  registry.register({
    id: 'test.unsafe_step',
    name: 'unsafe_step',
    description: 'Non-idempotent step',
    riskLevel: 'medium',
    trusted: true,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    execute: async () => {
      unsafeCalls++;
      return { verified: true, message: 'unsafe ok' };
    },
  });

  const planner = new ToolPlanner(registry);
  const plan = await planner.validateProposedPlan({
    originalRequest: 'Simulate crash mid-execution',
    steps: [
      { stepId: 's1', capabilityId: 'test.safe_step', dependencies: [] },
      { stepId: 's2', capabilityId: 'test.unsafe_step', dependencies: ['s1'] },
    ],
  });

  const db = store.getDatabase();
  // Insert simulated mid-crash task where s1 is COMPLETED and s2 (non-idempotent) was RUNNING
  const crashUnsafeId = 'crash-unsafe-1';
  db.prepare(
    `INSERT INTO background_tasks (id, owner_id, status, task_class, original_request, execution_plan_json, progress)
     VALUES (?, 'local', 'RUNNING', 'lightweight', 'crash', ?, 50)`
  ).run(crashUnsafeId, JSON.stringify(plan));
  db.prepare(
    `INSERT INTO task_steps (id, task_id, step_id, capability_id, status, idempotent, result_json)
     VALUES (?, ?, 's1', 'test.safe_step', 'COMPLETED', 1, '{"success":true,"verified":true,"message":"done"}')`
  ).run(`${crashUnsafeId}:s1`, crashUnsafeId);
  db.prepare(
    `INSERT INTO task_steps (id, task_id, step_id, capability_id, status, idempotent)
     VALUES (?, ?, 's2', 'test.unsafe_step', 'RUNNING', 0)`
  ).run(`${crashUnsafeId}:s2`, crashUnsafeId);

  // Insert simulated mid-crash task where idempotent s1 was RUNNING
  const crashSafeId = 'crash-safe-1';
  const safeOnlyPlan = await planner.validateProposedPlan({
    originalRequest: 'Safe crash',
    steps: [{ stepId: 's1', capabilityId: 'test.safe_step', dependencies: [] }],
  });
  db.prepare(
    `INSERT INTO background_tasks (id, owner_id, status, task_class, original_request, execution_plan_json, progress)
     VALUES (?, 'local', 'RUNNING', 'lightweight', 'safe crash', ?, 10)`
  ).run(crashSafeId, JSON.stringify(safeOnlyPlan));
  db.prepare(
    `INSERT INTO task_steps (id, task_id, step_id, capability_id, status, idempotent)
     VALUES (?, ?, 's1', 'test.safe_step', 'RUNNING', 1)`
  ).run(`${crashSafeId}:s1`, crashSafeId);

  const recoveredOrchestrator = new BackgroundOrchestrator(registry);
  const recovery = await recoveredOrchestrator.recoverOnBoot();

  assert.equal(recovery.interrupted, 1);
  assert.equal(recovery.resumed, 1);
  assert.equal(unsafeCalls, 0); // unsafe step was NEVER re-run

  const unsafeTask = await recoveredOrchestrator.getTask(crashUnsafeId);
  assert.equal(unsafeTask.status, 'INTERRUPTED');

  const safeTaskFinal = await waitForTaskTerminal(recoveredOrchestrator, crashSafeId);
  assert.equal(safeTaskFinal.status, 'COMPLETED');
  assert.equal(safeCalls, 1);
});

test('HTTP /friday/tasks API integration: auth, ownership, submission, steps, events, and cancellation', async () => {
  const server = new FridayServer();
  await server.start(0);
  const port = server.getPort();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Pair a device for ownership verification
    const auth = getAuthService();
    const { code } = auth.generatePairingCode();
    const { device, token } = await auth.pairDevice({ code, name: 'API Test Device' });

    // Submit task via POST /friday/tasks as paired device
    const submitRes = await fetch(`${baseUrl}/friday/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ text: 'Check my laptop health and current time.' }),
    });
    assert.equal(submitRes.status, 202);
    const submitJson = await submitRes.json();
    assert.ok(submitJson.taskId);

    // Ownership check: 'local' owner cannot access paired device's task -> 404
    const wrongOwnerRes = await fetch(`${baseUrl}/friday/tasks/${submitJson.taskId}`, {
      headers: { 'x-friday-owner': 'other-owner' },
    });
    assert.equal(wrongOwnerRes.status, 404);

    // Wait for completion via polling GET /friday/tasks/:id/result
    const resultData = await (async () => {
      for (let i = 0; i < 40; i++) {
        const r = await fetch(`${baseUrl}/friday/tasks/${submitJson.taskId}/result`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const j = await r.json();
        if (j.status === 'COMPLETED' || j.status === 'FAILED') return j;
        await new Promise((res) => setTimeout(res, 25));
      }
      return null;
    })();

    assert.equal(resultData.status, 'COMPLETED');
    assert.equal(resultData.steps.length, 2);

    // Events endpoint returns lifecycle events
    const eventsRes = await fetch(`${baseUrl}/friday/tasks/${submitJson.taskId}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(eventsRes.status, 200);
    const eventsJson = await eventsRes.json();
    assert.ok(eventsJson.events.some((e) => e.eventType === 'task.completed'));

    // Cancelling completed task returns 409 Conflict
    const cancelRes = await fetch(`${baseUrl}/friday/tasks/${submitJson.taskId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(cancelRes.status, 409);

    await auth.revokeDevice(device.id);
  } finally {
    getBackgroundOrchestrator();
    await server.stop();
  }
});
