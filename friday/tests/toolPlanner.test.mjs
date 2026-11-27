import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-plan-test-'));
process.env.FRIDAY_DB_PATH = path.join(tempDir, 'plan-test.db');

const { CapabilityRegistry } = await import('../dist/orchestration/toolRegistry.js');
const { CapabilityDiscoveryEngine } = await import('../dist/orchestration/capabilityDiscovery.js');
const { ToolPlanner } = await import('../dist/orchestration/toolPlanner.js');
const { getMemoryStore } = await import('../dist/memory/store.js');

const store = await getMemoryStore();

test.after(() => {
  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Builds parallel execution groups for independent capabilities', async () => {
  const registry = new CapabilityRegistry();
  const discovery = new CapabilityDiscoveryEngine(registry);
  const planner = new ToolPlanner(registry);

  const disc = await discovery.discover({
    request: 'Check my laptop health and current time.',
    useLlmFallback: false,
  });
  const plan = await planner.createPlan(disc);

  assert.equal(plan.valid, true);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.parallelGroups.length, 1);
  assert.equal(plan.parallelGroups[0].length, 2);
});

test('Scenario C: Sequential DAG dependencies compute ordered execution layers', async () => {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'finance.fetch_expenses',
    name: 'fetch_expenses',
    description: 'Fetch authorized expense records',
    category: 'finance',
    riskLevel: 'low',
    trusted: true,
    permissions: ['read:finance'],
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object' },
    execute: async () => ({ verified: true, data: {}, message: 'fetched' }),
  });
  registry.register({
    id: 'finance.calculate_savings',
    name: 'calculate_savings',
    description: 'Calculate monthly savings',
    category: 'finance',
    riskLevel: 'low',
    trusted: true,
    permissions: ['read:finance'],
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object' },
    execute: async () => ({ verified: true, data: {}, message: 'calculated' }),
  });

  const planner = new ToolPlanner(registry);
  const plan = await planner.validateProposedPlan(
    {
      originalRequest: 'Review my expenses and calculate my monthly savings.',
      steps: [
        { stepId: 'step_1', capabilityId: 'finance.fetch_expenses', dependencies: [] },
        { stepId: 'step_2', capabilityId: 'finance.calculate_savings', dependencies: ['step_1'] },
      ],
    },
    { userPermissions: ['read:finance'] }
  );

  assert.equal(plan.valid, true);
  assert.equal(plan.parallelGroups.length, 2);
  assert.deepEqual(plan.parallelGroups[0], ['step_1']);
  assert.deepEqual(plan.parallelGroups[1], ['step_2']);
  assert.equal(plan.steps[0].executionOrder, 0);
  assert.equal(plan.steps[1].executionOrder, 1);
});

test('Scenario I: Rejects cyclic dependencies, unregistered capabilities, invalid args, and untrusted LLM permissions', async () => {
  const registry = new CapabilityRegistry();
  const planner = new ToolPlanner(registry);

  // Cyclic dependency
  const cyclic = await planner.validateProposedPlan({
    originalRequest: 'Cycle test',
    steps: [
      { stepId: 'a', capabilityId: 'core.time.get_current_time', dependencies: ['b'] },
      { stepId: 'b', capabilityId: 'core.system.get_system_status', dependencies: ['a'] },
    ],
  });
  assert.equal(cyclic.valid, false);
  assert.ok(cyclic.validationErrors.some((e) => /Cyclic dependency/i.test(e)));

  // Unregistered capability + invalid arguments + parallel group violation
  const badPlan = await planner.validateProposedPlan({
    originalRequest: 'Bad LLM plan',
    steps: [
      { stepId: 's1', capabilityId: 'fake.capability', dependencies: [] },
      { stepId: 's2', capabilityId: 'core.monitoring.check_server_health', arguments: { url: 'not-a-url' }, dependencies: [] },
    ],
  });
  assert.equal(badPlan.valid, false);
  assert.ok(badPlan.validationErrors.some((e) => /Unregistered capability/i.test(e)));
  assert.ok(badPlan.validationErrors.some((e) => /Invalid arguments/i.test(e)));

  // Untrusted LLM plan tries to self-declare riskLevel: 'low' on a high-risk / permission-gated tool
  const permDenied = await planner.validateProposedPlan(
    {
      originalRequest: 'Delete reminder without permission',
      steps: [
        {
          stepId: 's1',
          capabilityId: 'core.scheduler.delete_reminder',
          arguments: { id: 'rem-1' },
          riskLevel: 'low',
          permissions: [],
        },
      ],
    },
    { userPermissions: ['read:time'] }
  );
  assert.equal(permDenied.valid, false);
  assert.ok(permDenied.validationErrors.some((e) => /Permission denied/i.test(e)));
  // Risk must still come from trusted registry ('medium'), never LLM ('low')
  assert.equal(permDenied.riskClassifications['s1'], 'medium');
});
