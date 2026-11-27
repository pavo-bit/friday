import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-openrouter-test-'));
process.env.FRIDAY_DB_PATH = path.join(tmpDir, 'friday-openrouter.db');
process.env.FRIDAY_PORT = '0';

let serverBehavior = {
  mode: 'ok', // 'ok' | '401' | '402' | '403' | '404' | '429_then_ok' | '500_then_ok' | 'malformed' | 'context_overflow_then_ok' | 'tool_loop' | 'multi_tool' | 'high_risk_tool' | 'bad_tool_args' | 'slow'
  attempts: 0,
  lastHeaders: {},
  lastBody: null,
};

const mockServer = http.createServer((req, res) => {
  serverBehavior.lastHeaders = req.headers;

  if (req.url === '/api/v1/models') {
    if (serverBehavior.mode === '401') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key sk-or-v1-secret123456' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'openai/gpt-4o-mini' }, { id: 'anthropic/claude-3.5-sonnet' }] }));
    return;
  }

  if (req.url === '/api/v1/chat/completions') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      serverBehavior.attempts++;
      serverBehavior.lastBody = JSON.parse(raw || '{}');

      if (serverBehavior.mode === '401') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized Bearer sk-or-v1-secret123456' } }));
        return;
      }
      if (serverBehavior.mode === '402') {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Insufficient credits' } }));
        return;
      }
      if (serverBehavior.mode === '403') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Model forbidden' } }));
        return;
      }
      if (serverBehavior.mode === '404') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Model not found' } }));
        return;
      }
      if (serverBehavior.mode === '429_then_ok') {
        if (serverBehavior.attempts === 1) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
          res.end(JSON.stringify({ error: { message: 'Rate limited' } }));
          return;
        }
      }
      if (serverBehavior.mode === '500_then_ok') {
        if (serverBehavior.attempts === 1) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Upstream 500' } }));
          return;
        }
      }
      if (serverBehavior.mode === 'malformed') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('NOT_VALID_JSON{{{');
        return;
      }
      if (serverBehavior.mode === 'slow') {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'Too late' } }] }));
          }
        }, 1_000);
        return;
      }
      if (serverBehavior.mode === 'context_overflow_then_ok') {
        if (serverBehavior.attempts === 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'maximum context length exceeded' } }));
          return;
        }
      }
      if (serverBehavior.mode === 'bad_tool_args') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '',
                  tool_calls: [
                    { id: 'call_bad', type: 'function', function: { name: 'get_current_time', arguments: '{broken_json' } },
                  ],
                },
              },
            ],
          })
        );
        return;
      }
      if (serverBehavior.mode === 'multi_tool') {
        const hasToolMsg = (serverBehavior.lastBody.messages || []).some((m) => m.role === 'tool');
        if (!hasToolMsg) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: '',
                    tool_calls: [
                      { id: 'c1', type: 'function', function: { name: 'get_current_time', arguments: '{"timezone":"UTC"}' } },
                      { id: 'c2', type: 'function', function: { name: 'list_reminders', arguments: '{}' } },
                    ],
                  },
                },
              ],
            })
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Checked time and reminders.' } }] }));
        return;
      }
      if (serverBehavior.mode === 'tool_loop') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'Looping summary.',
                  tool_calls: [
                    { id: `c_${serverBehavior.attempts}`, type: 'function', function: { name: 'get_current_time', arguments: '{"timezone":"UTC"}' } },
                  ],
                },
              },
            ],
          })
        );
        return;
      }
      if (serverBehavior.mode === 'high_risk_tool') {
        const hasToolMsg = (serverBehavior.lastBody.messages || []).some((m) => m.role === 'tool');
        if (!hasToolMsg) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: '',
                    tool_calls: [
                      { id: 'c_hr', type: 'function', function: { name: 'test_destructive_action', arguments: '{"target":"prod"}' } },
                    ],
                  },
                },
              ],
            })
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'High-risk action requires approval.' } }] }));
        return;
      }

      if (serverBehavior.lastBody.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Streamed ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OpenRouter!' } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'openai/gpt-4o-mini',
          choices: [{ finish_reason: 'stop', message: { content: 'OpenRouter completion OK.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      );
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
const mockPort = mockServer.address().port;
const baseUrl = `http://127.0.0.1:${mockPort}/api/v1`;

process.env.OPENROUTER_BASE_URL = baseUrl;
process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-key-999999';
process.env.OPENROUTER_MODEL = 'openai/gpt-4o-mini';
process.env.OPENROUTER_SITE_URL = 'https://friday.local';
process.env.OPENROUTER_APP_NAME = 'FRIDAY';
process.env.OPENROUTER_MAX_RETRIES = '1';

const { getOpenRouterProvider, resetOpenRouterProvider } = await import('../dist/ai/providers/OpenRouterProvider.js');
const { loadAIConfig, validateAIConfig } = await import('../dist/ai/config/ai.config.js');
const { buildBoundedChatMessages, reduceMessagesForOverflow } = await import('../dist/ai/memory/MemoryManager.js');
const { redactSecrets } = await import('../dist/memory/redaction.js');
const { getMemoryStore } = await import('../dist/memory/store.js');
const { getAssistantBrain } = await import('../dist/orchestration/assistantBrain.js');
const { getToolRegistry } = await import('../dist/orchestration/toolRegistry.js');

describe('OpenRouter Provider, Security & Agent Integration', () => {
  before(async () => {
    const store = await getMemoryStore();
    await store.initialize();
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

  it('validates missing API key and missing model configuration', () => {
    const missingKeyErrors = validateAIConfig({
      apiKey: '',
      model: 'openai/gpt-4o-mini',
      baseUrl: 'https://openrouter.ai/api/v1',
      siteUrl: '',
      appName: 'FRIDAY',
      timeoutMs: 60_000,
      maxRetries: 2,
    });
    assert.ok(missingKeyErrors.some((e) => e.includes('OPENROUTER_API_KEY')));

    const missingModelErrors = validateAIConfig({
      apiKey: 'sk-or-v1-abc',
      model: '',
      baseUrl: 'https://openrouter.ai/api/v1',
      siteUrl: '',
      appName: 'FRIDAY',
      timeoutMs: 60_000,
      maxRetries: 2,
    });
    assert.ok(missingModelErrors.some((e) => e.includes('OPENROUTER_MODEL')));
  });

  it('sends Bearer auth, attribution headers, and correlation ID without exposing secrets', async () => {
    resetOpenRouterProvider();
    serverBehavior = { mode: 'ok', attempts: 0, lastHeaders: {}, lastBody: null };
    const provider = getOpenRouterProvider();

    const res = await provider.chat({
      messages: [{ role: 'user', content: 'Hello OpenRouter' }],
    });

    assert.equal(res.ok, true);
    assert.equal(res.content, 'OpenRouter completion OK.');
    assert.equal(res.usage?.totalTokens, 15);
    assert.equal(serverBehavior.lastHeaders.authorization, 'Bearer sk-or-v1-test-key-999999');
    assert.equal(serverBehavior.lastHeaders['http-referer'], 'https://friday.local');
    assert.equal(serverBehavior.lastHeaders['x-title'], 'FRIDAY');
    assert.ok(serverBehavior.lastHeaders['x-correlation-id']);
  });

  it('handles 401, 402, 403, 404 and redacts any leaked key in error strings', async () => {
    const provider = getOpenRouterProvider();
    for (const [mode, code] of [
      ['401', 'INVALID_CREDENTIALS'],
      ['402', 'INSUFFICIENT_CREDITS'],
      ['403', 'PERMISSION_DENIED'],
      ['404', 'MODEL_OR_ENDPOINT_NOT_FOUND'],
    ]) {
      serverBehavior = { mode, attempts: 0, lastHeaders: {}, lastBody: null };
      const res = await provider.chat({ messages: [{ role: 'user', content: 'test' }] });
      assert.equal(res.ok, false);
      assert.equal(res.errorCode, code);
      assert.ok(!String(res.error).includes('sk-or-v1-secret123456'));
    }
  });

  it('retries 429 and 5xx with bounded backoff and succeeds', async () => {
    const provider = getOpenRouterProvider();
    for (const mode of ['429_then_ok', '500_then_ok']) {
      serverBehavior = { mode, attempts: 0, lastHeaders: {}, lastBody: null };
      const res = await provider.chat({ messages: [{ role: 'user', content: 'retry test' }] });
      assert.equal(res.ok, true);
      assert.equal(serverBehavior.attempts, 2);
    }
  });

  it('rejects malformed JSON, handles timeouts, and supports AbortSignal cancellation', async () => {
    const provider = getOpenRouterProvider();

    serverBehavior = { mode: 'malformed', attempts: 0, lastHeaders: {}, lastBody: null };
    const bad = await provider.chat({ messages: [{ role: 'user', content: 'bad json' }] });
    assert.equal(bad.ok, false);
    assert.equal(bad.errorCode, 'MALFORMED_RESPONSE');

    serverBehavior = { mode: 'slow', attempts: 0, lastHeaders: {}, lastBody: null };
    const timedOut = await provider.chat({ messages: [{ role: 'user', content: 'slow' }], timeoutMs: 120 });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.errorCode, 'TIMEOUT');

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const cancelled = await provider.chat({ messages: [{ role: 'user', content: 'cancel' }], signal: ac.signal });
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.errorCode, 'CANCELLED');
  });

  it('streams SSE tokens and rejects malformed tool call arguments safely', async () => {
    const provider = getOpenRouterProvider();
    serverBehavior = { mode: 'ok', attempts: 0, lastHeaders: {}, lastBody: null };
    let tokens = '';
    const streamRes = await provider.chatStream({
      messages: [{ role: 'user', content: 'stream' }],
      onToken: (t) => (tokens += t),
    });
    assert.equal(streamRes.ok, true);
    assert.equal(tokens, 'Streamed OpenRouter!');

    serverBehavior = { mode: 'bad_tool_args', attempts: 0, lastHeaders: {}, lastBody: null };
    const toolRes = await provider.chat({ messages: [{ role: 'user', content: 'time' }] });
    assert.equal(toolRes.ok, true);
    assert.equal(toolRes.toolCalls.length, 0);
  });

  it('executes multi-tool calls, prevents infinite tool loops, and blocks unapproved high-risk tools', async () => {
    const brain = getAssistantBrain();

    serverBehavior = { mode: 'multi_tool', attempts: 0, lastHeaders: {}, lastBody: null };
    const multiRes = await brain.process('Can you help me organize my afternoon schedule?', 'or-session-1');
    assert.equal(multiRes.success, true);
    assert.equal(multiRes.output, 'Checked time and reminders.');

    serverBehavior = { mode: 'tool_loop', attempts: 0, lastHeaders: {}, lastBody: null };
    const loopRes = await brain.process('Keep checking the time', 'or-session-2');
    assert.equal(loopRes.success, true);
    assert.ok(serverBehavior.attempts <= 3, 'loop detector should stop repeated identical tool calls');

    getToolRegistry().register({
      id: 'test.destructive.action',
      name: 'test_destructive_action',
      description: 'Test high-risk destructive action requiring approval',
      category: 'system',
      riskLevel: 'high',
      permissions: ['admin:destructive'],
      inputSchema: { type: 'object', properties: { target: { type: 'string' } } },
      outputSchema: { type: 'object' },
      execute: async () => ({ verified: true, message: 'Executed' }),
    });

    serverBehavior = { mode: 'high_risk_tool', attempts: 0, lastHeaders: {}, lastBody: null };
    const hrRes = await brain.process('Please handle this custom request for me', 'or-session-3');
    assert.equal(hrRes.toolResult?.requiresApproval, true);
    assert.equal(hrRes.toolResult?.success, false);
  });

  it('bounds context window and redacts OpenRouter secrets from memory/logs', () => {
    const redacted = redactSecrets('Authorization: Bearer sk-or-v1-mysecretkey12345');
    assert.ok(!redacted.includes('sk-or-v1-mysecretkey12345'));

    const bounded = buildBoundedChatMessages({
      systemPrompt: 'System prompt',
      history: Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `Turn ${i} ` + 'x'.repeat(300) })),
      userMessage: 'Latest message',
      maxContextTokens: 2_500,
      reserveResponseTokens: 500,
    });
    assert.equal(bounded[0].role, 'system');
    assert.equal(bounded[bounded.length - 1].content, 'Latest message');
    assert.ok(bounded.length < 32);

    const reduced = reduceMessagesForOverflow(bounded);
    assert.ok(reduced.length < bounded.length);
  });
});
