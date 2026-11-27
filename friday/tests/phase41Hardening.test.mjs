import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-phase41-'));
process.env.FRIDAY_DB_PATH = path.join(tmpDir, 'friday-phase41.db');
process.env.FRIDAY_PORT = '0';

let mockState = {
  scenario: 'multi_ok', // 'multi_ok' | 'first_fail_second_ok' | 'all_fail' | 'model_fail_after_tool' | 'max_iter' | 'duplicate' | 'approval' | 'unavailable_model' | '500' | '401'
  modelsCalls: 0,
  chatCalls: 0,
};

const mockServer = http.createServer((req, res) => {
  if (req.url === '/api/v1/models') {
    mockState.modelsCalls++;
    if (mockState.scenario === '401') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid API key' }));
      return;
    }
    if (mockState.scenario === '500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server error' }));
      return;
    }
    if (mockState.scenario === 'unavailable_model') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'anthropic/claude-3.5-sonnet' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'openai/gpt-4o-mini' }] }));
    return;
  }

  if (req.url === '/api/v1/chat/completions') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      mockState.chatCalls++;
      const body = JSON.parse(raw || '{}');
      const hasToolMsg = (body.messages || []).some((m) => m.role === 'tool');

      if (mockState.scenario === '500') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upstream 500' }));
        return;
      }

      if (mockState.scenario === 'multi_ok') {
        if (!hasToolMsg) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: '',
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'p41_ok_tool_a', arguments: '{}' } },
                  { id: 'c2', type: 'function', function: { name: 'p41_ok_tool_b', arguments: '{}' } },
                ],
              },
            }],
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Both tools succeeded.' } }] }));
        return;
      }

      if (mockState.scenario === 'first_fail_second_ok') {
        if (!hasToolMsg) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: '',
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'p41_fail_tool', arguments: '{}' } },
                  { id: 'c2', type: 'function', function: { name: 'p41_ok_tool_a', arguments: '{}' } },
                ],
              },
            }],
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Second tool succeeded.' } }] }));
        return;
      }

      if (mockState.scenario === 'all_fail') {
        if (!hasToolMsg) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: '',
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'p41_fail_tool', arguments: '{}' } },
                ],
              },
            }],
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Handled failure.' } }] }));
        return;
      }

      if (mockState.scenario === 'model_fail_after_tool') {
        if (!hasToolMsg) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: '',
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'p41_ok_tool_a', arguments: '{}' } },
                ],
              },
            }],
          }));
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Model crashed on follow-up' }));
        return;
      }

      if (mockState.scenario === 'max_iter') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [
                {
                  id: `iter_${mockState.chatCalls}`,
                  type: 'function',
                  function: { name: 'p41_ok_tool_a', arguments: JSON.stringify({ step: mockState.chatCalls }) },
                },
              ],
            },
          }],
        }));
        return;
      }

      if (mockState.scenario === 'duplicate') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: 'Duplicate summary',
              tool_calls: [
                { id: `dup_${mockState.chatCalls}`, type: 'function', function: { name: 'p41_ok_tool_a', arguments: '{"same":true}' } },
              ],
            },
          }],
        }));
        return;
      }

      if (mockState.scenario === 'approval') {
        if (!hasToolMsg) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: '',
                tool_calls: [
                  { id: 'hr_1', type: 'function', function: { name: 'p41_high_risk_tool', arguments: '{}' } },
                ],
              },
            }],
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Needs approval.' } }] }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
const port = mockServer.address().port;

process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}/api/v1`;
process.env.OPENROUTER_API_KEY = 'sk-or-v1-phase41-test-key';
process.env.OPENROUTER_MODEL = 'openai/gpt-4o-mini';
process.env.OPENROUTER_MAX_RETRIES = '0';

const { getMemoryStore } = await import('../dist/memory/store.js');
const { getOpenRouterProvider, resetOpenRouterProvider } = await import('../dist/ai/providers/OpenRouterProvider.js');
const { validateAIConfig } = await import('../dist/ai/config/ai.config.js');
const { getAssistantBrain } = await import('../dist/orchestration/assistantBrain.js');
const { getToolRegistry } = await import('../dist/orchestration/toolRegistry.js');
const { getToolPlanner } = await import('../dist/orchestration/toolPlanner.js');
const { getBackgroundOrchestrator } = await import('../dist/orchestration/backgroundOrchestrator.js');

describe('Phase 4.1 Deep Reliability & Security Hardening', () => {
  before(async () => {
    const store = await getMemoryStore();
    await store.initialize();

    const reg = getToolRegistry();
    reg.register({
      id: 'p41.ok.a',
      name: 'p41_ok_tool_a',
      description: 'Test tool A',
      category: 'system',
      riskLevel: 'low',
      trusted: true,
      permissions: ['read:status'],
      inputSchema: { type: 'object', properties: { step: { type: 'number' }, same: { type: 'boolean' } } },
      outputSchema: { type: 'object' },
      execute: async () => ({ verified: true, message: 'Tool A OK' }),
    });
    reg.register({
      id: 'p41.ok.b',
      name: 'p41_ok_tool_b',
      description: 'Test tool B',
      category: 'system',
      riskLevel: 'low',
      trusted: true,
      permissions: ['read:status'],
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      execute: async () => ({ verified: true, message: 'Tool B OK' }),
    });
    reg.register({
      id: 'p41.fail',
      name: 'p41_fail_tool',
      description: 'Failing test tool',
      category: 'system',
      riskLevel: 'low',
      trusted: true,
      permissions: ['read:status'],
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      execute: async () => {
        throw new Error('Simulated tool failure');
      },
    });
    reg.register({
      id: 'p41.high_risk',
      name: 'p41_high_risk_tool',
      description: 'High risk test tool',
      category: 'system',
      riskLevel: 'high',
      permissions: ['admin:destructive'],
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      execute: async () => ({ verified: true, message: 'Should require approval' }),
    });
  });

  after(async () => {
    await new Promise((resolve) => mockServer.close(resolve));
    const store = await getMemoryStore();
    store.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore Windows temp handle delay
    }
  });

  it('1. aggregates multiple successful tool calls as COMPLETE with execution ledger', async () => {
    resetOpenRouterProvider();
    mockState = { scenario: 'multi_ok', modelsCalls: 0, chatCalls: 0 };
    const res = await getAssistantBrain().process('Handle custom multi ok workflow', 'p41-s1');
    assert.equal(res.success, true);
    assert.equal(res.taskOutcome, 'COMPLETE');
    assert.equal(res.executionLedger?.length, 2);
    assert.ok(res.executionLedger?.every((e) => e.executionStatus === 'success' && e.verificationStatus === 'verified'));
  });

  it('2. never hides first tool failure behind second tool success (PARTIALLY_COMPLETE)', async () => {
    resetOpenRouterProvider();
    mockState = { scenario: 'first_fail_second_ok', modelsCalls: 0, chatCalls: 0 };
    const res = await getAssistantBrain().process('Handle custom partial failure workflow', 'p41-s2');
    assert.equal(res.success, false);
    assert.equal(res.taskOutcome, 'PARTIALLY_COMPLETE');
    assert.equal(res.executionLedger?.[0].executionStatus, 'failed');
    assert.equal(res.executionLedger?.[1].executionStatus, 'success');
  });

  it('3. reports FAILED when all tools fail, and PARTIALLY_COMPLETE when model fails after tool execution', async () => {
    resetOpenRouterProvider();
    mockState = { scenario: 'all_fail', modelsCalls: 0, chatCalls: 0 };
    const failRes = await getAssistantBrain().process('Handle custom all fail workflow', 'p41-s3');
    assert.equal(failRes.success, false);
    assert.equal(failRes.taskOutcome, 'FAILED');

    resetOpenRouterProvider();
    mockState = { scenario: 'model_fail_after_tool', modelsCalls: 0, chatCalls: 0 };
    const modelFailRes = await getAssistantBrain().process('Handle custom model crash workflow', 'p41-s4');
    assert.equal(modelFailRes.success, false);
    assert.equal(modelFailRes.taskOutcome, 'PARTIALLY_COMPLETE');
  });

  it('4. reports MAX_ITERATIONS_REACHED, duplicate skipping, and WAITING_FOR_APPROVAL', async () => {
    resetOpenRouterProvider();
    mockState = { scenario: 'max_iter', modelsCalls: 0, chatCalls: 0 };
    const maxRes = await getAssistantBrain().process('Handle custom max iter workflow', 'p41-s5');
    assert.equal(maxRes.success, false);
    assert.equal(maxRes.taskOutcome, 'MAX_ITERATIONS_REACHED');

    resetOpenRouterProvider();
    mockState = { scenario: 'duplicate', modelsCalls: 0, chatCalls: 0 };
    const dupRes = await getAssistantBrain().process('Handle custom duplicate workflow', 'p41-s6');
    assert.ok(dupRes.executionLedger?.some((e) => e.executionStatus === 'duplicate_skipped'));

    resetOpenRouterProvider();
    mockState = { scenario: 'approval', modelsCalls: 0, chatCalls: 0 };
    const appRes = await getAssistantBrain().process('Handle custom approval workflow', 'p41-s7');
    assert.equal(appRes.success, false);
    assert.equal(appRes.taskOutcome, 'WAITING_FOR_APPROVAL');
    assert.equal(appRes.executiveDecision, 'REQUEST_APPROVAL');
  });

  it('5. enforces model availability, health caching, and circuit breaker', async () => {
    resetOpenRouterProvider();
    mockState = { scenario: 'multi_ok', modelsCalls: 0, chatCalls: 0 };
    const provider = getOpenRouterProvider();

    const s1 = await provider.checkStatus();
    const s2 = await provider.checkStatus();
    assert.equal(s1.reachable, true);
    assert.equal(s2.reachable, true);
    assert.equal(mockState.modelsCalls, 1, 'health check should be cached within TTL');

    resetOpenRouterProvider();
    mockState = { scenario: 'unavailable_model', modelsCalls: 0, chatCalls: 0 };
    const unavail = await getOpenRouterProvider().checkStatus();
    assert.equal(unavail.reachable, true);
    assert.equal(unavail.modelAvailable, false);
    assert.equal(unavail.errorCode, 'MODEL_OR_ENDPOINT_NOT_FOUND');

    // Circuit breaker opens after 3 consecutive 500 failures
    resetOpenRouterProvider();
    mockState = { scenario: '500', modelsCalls: 0, chatCalls: 0 };
    const cbProvider = getOpenRouterProvider();
    await cbProvider.chat({ messages: [{ role: 'user', content: '1' }] });
    await cbProvider.chat({ messages: [{ role: 'user', content: '2' }] });
    await cbProvider.chat({ messages: [{ role: 'user', content: '3' }] });
    assert.equal(cbProvider.getCircuitState(), 'OPEN');
    const blocked = await cbProvider.chat({ messages: [{ role: 'user', content: '4' }] });
    assert.equal(blocked.ok, false);
    assert.ok((blocked.error || '').includes('circuit breaker is OPEN'));
  });

  it('6. enforces HTTPS for non-loopback OpenRouter URLs and keeps frontend free of credentials', () => {
    const insecureErrors = validateAIConfig({
      apiKey: 'sk-or-v1-abc',
      model: 'openai/gpt-4o-mini',
      baseUrl: 'http://openrouter.ai/api/v1',
      siteUrl: '',
      appName: 'FRIDAY',
      timeoutMs: 60_000,
      maxRetries: 2,
    });
    assert.ok(insecureErrors.some((e) => e.includes('must use HTTPS')));

    const frontendFiles = [
      path.resolve('ui/app.js'),
      path.resolve('ui/index.html'),
      path.resolve('../web-ui/script.js'),
      path.resolve('../web-ui/index.html'),
    ];
    for (const file of frontendFiles) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!text.includes('sk-or-v1-'), `Credential leaked in ${file}`);
    }
  });

  it('7. recovers interrupted background tasks without re-executing completed steps', async () => {
    const orchestrator = getBackgroundOrchestrator();
    const store = await getMemoryStore();
    let step1Runs = 0;
    let step2Runs = 0;
    const reg = getToolRegistry();
    reg.register({
      id: 'p41.bg.step1',
      name: 'p41_bg_step1',
      description: 'BG step 1',
      category: 'system',
      riskLevel: 'low',
      trusted: true,
      permissions: ['read:status'],
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      execute: async () => {
        step1Runs++;
        return { verified: true, message: 'Step 1 done' };
      },
    });
    reg.register({
      id: 'p41.bg.step2',
      name: 'p41_bg_step2',
      description: 'BG step 2',
      category: 'system',
      riskLevel: 'low',
      trusted: true,
      permissions: ['read:status'],
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      execute: async () => {
        step2Runs++;
        return { verified: true, message: 'Step 2 done' };
      },
    });

    const plan = await getToolPlanner().validateProposedPlan({
      originalRequest: 'Run 2-step background plan',
      steps: [
        {
          stepId: 's1',
          capabilityId: 'p41.bg.step1',
          arguments: {},
          dependsOn: [],
        },
        {
          stepId: 's2',
          capabilityId: 'p41.bg.step2',
          arguments: {},
          dependsOn: ['s1'],
        },
      ],
    });

    const waitForCompletion = async (id) => {
      for (let i = 0; i < 100; i++) {
        const t = await orchestrator.getTask(id);
        if (t && (t.status === 'COMPLETED' || t.status === 'FAILED' || t.status === 'CANCELLED')) return t;
        await new Promise((r) => setTimeout(r, 30));
      }
      return orchestrator.getTask(id);
    };

    const { taskId } = await orchestrator.submitPlan(plan, { ownerId: 'local' });
    const doneTask = await waitForCompletion(taskId);
    assert.equal(doneTask?.status, 'COMPLETED');
    assert.equal(step1Runs, 1);
    assert.equal(step2Runs, 1);

    // Simulate interruption on step 2 only (step 1 already COMPLETED in SQLite)
    const db = store.getDatabase();
    db.prepare(`UPDATE task_steps SET status = 'INTERRUPTED', completed_at = NULL WHERE task_id = ? AND step_id = 's2'`).run(taskId);
    db.prepare(`UPDATE background_tasks SET status = 'RUNNING', completed_at = NULL WHERE id = ?`).run(taskId);
    await orchestrator.recoverOnBoot();
    const recovered = await waitForCompletion(taskId);
    assert.equal(recovered?.status, 'COMPLETED');
    assert.equal(step1Runs, 1, 'Completed step 1 must NOT re-execute on recovery');
    assert.equal(step2Runs, 2, 'Interrupted step 2 should execute on recovery');
  });
});
