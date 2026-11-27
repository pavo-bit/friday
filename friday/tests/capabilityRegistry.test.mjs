import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-cap-test-'));
process.env.FRIDAY_DB_PATH = path.join(tempDir, 'cap-test.db');

const {
  CapabilityRegistry,
  getToolRegistry,
  validateAgainstSchema,
} = await import('../dist/orchestration/toolRegistry.js');
const { getMemoryStore } = await import('../dist/memory/store.js');

const store = await getMemoryStore();

test.after(() => {
  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('All 18 existing built-in tools are registered, enabled, and discoverable', async () => {
  const registry = getToolRegistry();
  const expectedTools = [
    'get_current_time',
    'get_system_status',
    'check_ai_provider_status',
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

  assert.equal(registry.listEnabled().length >= 18, true);

  for (const name of expectedTools) {
    const cap = registry.get(name);
    assert.ok(cap, `Expected capability "${name}" to be registered`);
    assert.ok(cap.id.startsWith('core.'), `Expected stable id for "${name}"`);
    assert.equal(cap.version, '1.0.0');
    assert.equal(cap.enabled, true);
    assert.ok(cap.inputSchema);
    assert.ok(cap.outputSchema);
    assert.ok(Array.isArray(cap.permissions));
    assert.ok(registry.getById(cap.id));
  }

  const monitoringCaps = await registry.discover({ category: 'monitoring', onlyAvailable: true });
  assert.ok(monitoringCaps.some((c) => c.name === 'start_dashboard_watch'));

  const timeCaps = await registry.discover({ query: 'current date timezone' });
  assert.ok(timeCaps.some((c) => c.name === 'get_current_time'));
});

test('Prevents duplicate registration and supports safe unregister and enable/disable', async () => {
  const registry = new CapabilityRegistry();
  const cap = registry.register({
    id: 'test.echo',
    name: 'test_echo',
    description: 'Echoes text',
    category: 'general',
    version: '1.0.0',
    riskLevel: 'low',
    trusted: true,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (args) => ({ verified: true, data: { text: args.text }, message: String(args.text) }),
  });

  assert.equal(cap.id, 'test.echo');

  // Duplicate ID and duplicate name must throw
  assert.throws(() =>
    registry.register({
      id: 'test.echo',
      name: 'other_name',
      description: 'dup id',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      execute: async () => ({ verified: true, message: 'ok' }),
    })
  );
  assert.throws(() =>
    registry.register({
      id: 'test.echo2',
      name: 'test_echo',
      description: 'dup name',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      execute: async () => ({ verified: true, message: 'ok' }),
    })
  );

  // Disable blocks execution and hides from default discovery
  assert.equal(registry.disable('test.echo'), true);
  const disabledDiscover = await registry.discover({ query: 'echo' });
  assert.equal(disabledDiscover.length, 0);

  const disabledExec = await registry.execute('test.echo', { text: 'hi' });
  assert.equal(disabledExec.success, false);
  assert.match(disabledExec.message, /disabled/i);

  // Re-enable works
  assert.equal(registry.enable('test.echo'), true);
  const okExec = await registry.execute('test.echo', { text: 'hello' });
  assert.equal(okExec.success, true);
  assert.equal(okExec.verified, true);
  assert.equal(okExec.capabilityId, 'test.echo');

  // Unregister cleans up both ID and name lookups
  assert.equal(registry.unregister('test.echo'), true);
  assert.equal(registry.get('test.echo'), undefined);
  assert.equal(registry.get('test_echo'), undefined);
});

test('Validates input and output schemas deterministically', async () => {
  const schemaCheck = validateAgainstSchema(
    { severity: 'invalid_enum', title: 'Alert' },
    {
      type: 'object',
      properties: {
        title: { type: 'string' },
        severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
      },
      required: ['title', 'message'],
    }
  );
  assert.equal(schemaCheck.valid, false);
  assert.ok(schemaCheck.errors.length >= 2);

  const registry = new CapabilityRegistry();
  registry.register({
    id: 'test.bad_output',
    name: 'bad_output',
    description: 'Returns invalid output schema',
    category: 'general',
    riskLevel: 'low',
    trusted: true,
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
    execute: async () => ({ verified: true, data: { count: 'not-a-number' }, message: 'done' }),
  });

  const res = await registry.execute('test.bad_output', {});
  assert.equal(res.success, false);
  assert.equal(res.verified, false);
  assert.match(res.error || '', /Output schema validation failed/i);
});

test('Security: untrusted capabilities cannot bypass SafetyGate and permission checks are enforced', async () => {
  const registry = new CapabilityRegistry();

  // Untrusted capability tries to declare riskLevel: 'low' -> must be forced to 'high'
  const untrusted = registry.register({
    id: 'untrusted.action',
    name: 'untrusted_action',
    description: 'Untrusted plugin action',
    riskLevel: 'low',
    trusted: false,
    permissions: ['write:system'],
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object' },
    execute: async () => ({ verified: true, message: 'executed' }),
  });

  assert.equal(untrusted.riskLevel, 'high');

  // Calling without approval must require approval
  const needsApproval = await registry.execute('untrusted.action', {}, { actor: 'planner' });
  assert.equal(needsApproval.success, false);
  assert.equal(needsApproval.requiresApproval, true);

  // Calling with grantedPermissions missing 'write:system' must be denied even if approvedHighRisk is true
  const denied = await registry.execute(
    'untrusted.action',
    {},
    { actor: 'planner', approvedHighRisk: true, grantedPermissions: ['read:time'] }
  );
  assert.equal(denied.success, false);
  assert.match(denied.message, /Permission denied/i);

  // Unavailable capability is blocked cleanly
  registry.register({
    id: 'test.unavailable',
    name: 'unavailable_cap',
    description: 'Offline capability',
    riskLevel: 'low',
    trusted: true,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    isAvailable: async () => ({ available: false, reason: 'Dependency offline' }),
    execute: async () => ({ verified: true, message: 'should not run' }),
  });

  const availDiscover = await registry.discover({ query: 'offline', onlyAvailable: true });
  assert.equal(availDiscover.some((c) => c.id === 'test.unavailable'), false);

  const unavailExec = await registry.execute('test.unavailable', {});
  assert.equal(unavailExec.success, false);
  assert.match(unavailExec.message, /Dependency offline/);
});
