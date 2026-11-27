import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-disc-test-'));
process.env.FRIDAY_DB_PATH = path.join(tempDir, 'disc-test.db');

const { CapabilityRegistry } = await import('../dist/orchestration/toolRegistry.js');
const { CapabilityDiscoveryEngine } = await import('../dist/orchestration/capabilityDiscovery.js');
const { getAssistantBrain } = await import('../dist/orchestration/assistantBrain.js');
const { getMemoryStore } = await import('../dist/memory/store.js');

const store = await getMemoryStore();

test.after(() => {
  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Scenario A & B: Single-tool and multi-tool deterministic discovery', async () => {
  const registry = new CapabilityRegistry();
  const discovery = new CapabilityDiscoveryEngine(registry);

  const single = await discovery.discover({ request: 'Check my system status.', useLlmFallback: false });
  assert.equal(single.requiresTools, true);
  assert.equal(single.matched.length, 1);
  assert.equal(single.matched[0].capability.id, 'core.system.get_system_status');

  const multi = await discovery.discover({
    request: 'Check my laptop health and current time.',
    timezone: 'Asia/Kolkata',
    useLlmFallback: false,
  });
  assert.equal(multi.matched.length, 2);
  const ids = multi.matched.map((m) => m.capability.id);
  assert.ok(ids.includes('core.system.get_system_status'));
  assert.ok(ids.includes('core.time.get_current_time'));
});

test('Scenario D & E: Missing input detection and follow-up context resolution', async () => {
  const registry = new CapabilityRegistry();
  const discovery = new CapabilityDiscoveryEngine(registry);

  const missing = await discovery.discover({
    request: 'Remind me to pay my bill.',
    useLlmFallback: false,
  });
  assert.equal(missing.ambiguous, true);
  assert.equal(missing.missingInputs.length, 1);
  assert.deepEqual(missing.missingInputs[0].fields, ['dueAt']);
  assert.match(missing.clarificationNeeded || '', /When should I remind you/i);

  const noCtxFollowUp = await discovery.discover({
    request: 'Now compare that with last month.',
    useLlmFallback: false,
  });
  assert.equal(noCtxFollowUp.ambiguous, true);
  assert.match(noCtxFollowUp.clarificationNeeded || '', /previous result/i);
});

test('Scenario F, G, H: Unavailable capability, pure greeting, and compound greeting+command', async () => {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'test.offline_cap',
    name: 'offline_cap',
    description: 'An unavailable capability',
    riskLevel: 'low',
    trusted: true,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    isAvailable: async () => ({ available: false, reason: 'Service offline' }),
    execute: async () => ({ verified: true, message: 'ok' }),
  });

  const discovery = new CapabilityDiscoveryEngine(registry);

  const unavail = await discovery.discover({
    request: 'Run offline_cap now',
    useLlmFallback: false,
  });
  assert.equal(unavail.matched.length, 0);
  assert.equal(unavail.unavailable.length, 1);
  assert.equal(unavail.unavailable[0].name, 'offline_cap');

  const greeting = await discovery.discover({ request: 'Good morning.', useLlmFallback: false });
  assert.equal(greeting.isPureGreeting, true);
  assert.equal(greeting.requiresTools, false);

  const compound = await discovery.discover({
    request: 'Good morning, check my laptop health.',
    useLlmFallback: false,
  });
  assert.equal(compound.hasCompoundGreeting, true);
  assert.equal(compound.matched.length, 1);
  assert.equal(compound.matched[0].capability.id, 'core.system.get_system_status');
});

test('AssistantBrain regression: greeting, multi-tool execution, and missing-input clarification', async () => {
  const brain = getAssistantBrain();

  const greetRes = await brain.process('Good morning.');
  assert.equal(greetRes.success, true);
  assert.match(greetRes.output, /Boss/i);

  const multiRes = await brain.process('Check my laptop health and current time.');
  assert.equal(multiRes.success, true);
  assert.ok(multiRes.plan);
  assert.ok(multiRes.backgroundTaskId);
  assert.equal(multiRes.plan.steps.length, 2);
  assert.equal(multiRes.plan.parallelGroups.length, 1);
  assert.match(multiRes.output, /started that in the background/i);

  const clarifyRes = await brain.process('Remind me to pay my bill.');
  assert.equal(clarifyRes.success, false);
  assert.match(clarifyRes.output, /When should I remind you/i);
});
