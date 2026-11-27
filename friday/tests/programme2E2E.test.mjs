import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-prog2-e2e-'));
process.env.FRIDAY_DB_PATH = path.join(tmpDir, 'friday-prog2.db');
process.env.FRIDAY_PORT = '0';
process.env.FRIDAY_ALLOW_LOCALHOST_RESEARCH = 'true';

// Mock Ollama server so we can test live response, streaming, timeout, failure, and restart recovery
let ollamaOnline = true;
let ollamaSlow = false;
const mockOllama = http.createServer((req, res) => {
  if (!ollamaOnline) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Ollama service restarting' }));
    return;
  }
  if (req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'qwen3:4b' }] }));
    return;
  }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (ollamaSlow) {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'Delayed response' } }] }));
          }
        }, 1_500);
        return;
      }
      const parsed = JSON.parse(body || '{}');
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Boss!' } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Here is a clear, grounded answer for you, Boss.',
              },
            },
          ],
        })
      );
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => mockOllama.listen(0, '127.0.0.1', resolve));
const ollamaPort = mockOllama.address().port;
process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${ollamaPort}/v1`;
process.env.OLLAMA_MODEL = 'qwen3:4b';

const { getMemoryStore } = await import('../dist/memory/store.js');
const { getOllamaClient } = await import('../dist/orchestration/ollamaClient.js');
const { getAssistantBrain } = await import('../dist/orchestration/assistantBrain.js');
const { getPersonalIdentityService } = await import('../dist/identity/identityService.js');
const { getProjectContextService } = await import('../dist/identity/projectContextService.js');
const { getContinuousLearningEngine } = await import('../dist/learning/learningEngine.js');
const { getMonitoringEngine } = await import('../dist/services/monitoringEngine.js');
const { getToolRegistry } = await import('../dist/orchestration/toolRegistry.js');
const { getAuthService } = await import('../dist/services/authService.js');
const { enforceActorScope, ActorImpersonationError } = await import('../dist/api/authContext.js');
const { FridayServer } = await import('../dist/api/server.js');

let apiServer;
let apiUrl;
let tokenA;
let actorA;
let webMockServer;
let webMockUrl;
let monServer;
let monHealthy = true;
let monUrl;

describe('Programme 2 (Phases 17–19): Conversation, Cross-Device Identity, Security & E2E', () => {
  before(async () => {
    const store = await getMemoryStore();
    await store.initialize();

    const auth = getAuthService();
    const paired = await auth.pairDevice({
      code: auth.generatePairingCode().code,
      name: 'Pixel-Android',
      platform: 'android',
    });
    tokenA = paired.token;
    actorA = `device:${paired.device.id}`;

    webMockServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>E2E Target</title></head><body><h1>Cloud Platform</h1><p>Starter $19/month</p></body></html>');
    });
    await new Promise((resolve) => webMockServer.listen(0, '127.0.0.1', resolve));
    webMockUrl = `http://127.0.0.1:${webMockServer.address().port}`;

    monServer = http.createServer((_req, res) => {
      res.writeHead(monHealthy ? 200 : 503);
      res.end(monHealthy ? 'OK' : 'DOWN');
    });
    await new Promise((resolve) => monServer.listen(0, '127.0.0.1', resolve));
    monUrl = `http://127.0.0.1:${monServer.address().port}/health`;

    apiServer = new FridayServer();
    await apiServer.start(0);
    apiUrl = `http://127.0.0.1:${apiServer.getPort()}`;
  });

  after(async () => {
    getMonitoringEngine().stopAll();
    await apiServer?.stop();
    await new Promise((resolve) => mockOllama.close(resolve));
    await new Promise((resolve) => webMockServer.close(resolve));
    await new Promise((resolve) => monServer.close(resolve));
    const store = await getMemoryStore();
    store.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup timing
    }
  });

  describe('Phase 17: Live Ollama Validation, Streaming, Timeout & Offline Recovery', () => {
    it('validates Qwen3:4B availability, streaming, timeout, failure, and restart recovery', async () => {
      const ollama = getOllamaClient();
      const diag1 = await ollama.getDiagnostics();
      assert.equal(diag1.reachable, true);
      assert.equal(diag1.modelAvailable, true);
      assert.ok(diag1.processRssMb > 0);

      // Streaming test
      let streamedTokens = '';
      const streamRes = await ollama.chatStream({
        messages: [{ role: 'user', content: 'Say hi' }],
        onToken: (t) => (streamedTokens += t),
      });
      assert.equal(streamRes.ok, true);
      assert.equal(streamedTokens, 'Hello Boss!');

      // Timeout handling
      ollamaSlow = true;
      const timeoutRes = await ollama.chatStream({
        messages: [{ role: 'user', content: 'Slow query' }],
        timeoutMs: 250,
      });
      assert.equal(timeoutRes.ok, false);
      assert.ok(/timed out/i.test(timeoutRes.error || ''));
      ollamaSlow = false;

      // Unavailable & restart recovery
      ollamaOnline = false;
      const downDiag = await ollama.getDiagnostics();
      assert.equal(downDiag.reachable, false);

      ollamaOnline = true;
      const upDiag = await ollama.getDiagnostics();
      assert.equal(upDiag.reachable, true);
      assert.equal(upDiag.consecutiveFailures, 0);
    });
  });

  describe('Phase 18 & 19.2: Cross-Device Auth, Impersonation Prevention & Revocation', () => {
    it('prevents remote device impersonation and enforces revocation', async () => {
      const remoteCaller = {
        actorId: 'device:dev-1',
        deviceId: 'dev-1',
        isLocal: false,
        authenticated: true,
      };
      assert.equal(enforceActorScope(remoteCaller, 'device:dev-1'), 'device:dev-1');
      assert.throws(() => enforceActorScope(remoteCaller, 'victim-actor'), ActorImpersonationError);

      // Revocation invalidates bearer token on API
      const auth = getAuthService();
      const tempPair = await auth.pairDevice({
        code: auth.generatePairingCode().code,
        name: 'Temp-Android',
        platform: 'android',
      });
      assert.ok(await auth.verifyToken(tempPair.token));
      await auth.revokeDevice(tempPair.device.id);
      assert.equal(await auth.verifyToken(tempPair.token), null);
    });
  });

  describe('Phase 19.7: End-to-End Scenarios A–H', () => {
    it('Scenario A: Personal conversation, style override, and summary recovery', async () => {
      const brain = getAssistantBrain();
      const r1 = await brain.process('Explain what an API gateway is.', 'e2e-conv-a', false, {
        actorId: actorA,
        channel: 'text',
      });
      assert.equal(r1.personalityMeta?.activeProfile, 'TEACHER');

      const r2 = await brain.process('Talk casually like a friend: how are you?', 'e2e-conv-a', false, {
        actorId: actorA,
        channel: 'text',
      });
      assert.equal(r2.personalityMeta?.activeProfile, 'FRIEND');

      const sumRes = await fetch(`${apiUrl}/friday/conversations/summary?sessionId=e2e-conv-a`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.equal(sumRes.status, 200);
    });

    it('Scenario B: Cross-project context switching and return', async () => {
      const projSvc = getProjectContextService();
      await projSvc.upsertProject(actorA, {
        projectName: 'SSVM-ERP',
        techStack: ['TypeScript', 'PostgreSQL'],
        progressSummary: 'Module 4 active',
        setActive: true,
      });
      await projSvc.upsertProject(actorA, {
        projectName: 'TradingBot',
        techStack: ['Node.js'],
        progressSummary: 'Backtesting ready',
        setActive: false,
      });

      const sw1 = await getAssistantBrain().process('Switch to my TradingBot project', 'e2e-conv-b', false, {
        actorId: actorA,
      });
      assert.ok(sw1.output.includes('TradingBot'));
      assert.equal((await projSvc.getActiveProject(actorA))?.projectName, 'TradingBot');

      const sw2 = await getAssistantBrain().process('Switch to my SSVM-ERP project', 'e2e-conv-b', false, {
        actorId: actorA,
      });
      assert.ok(sw2.output.includes('SSVM-ERP'));
    });

    it('Scenario C: Web research -> evidence -> approved learning ingestion', async () => {
      const res = await fetch(`${apiUrl}/friday/research/analyze`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webMockUrl, maxDepth: 0 }),
      });
      assert.equal(res.status, 201);
      const { job } = await res.json();
      assert.equal(job.status, 'COMPLETED');

      const saveRes = await fetch(`${apiUrl}/friday/research/jobs/${job.id}/save-to-learning`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectName: 'SSVM-ERP' }),
      });
      assert.equal(saveRes.status, 201);
    });

    it('Scenario D: Monitoring outage -> VERIFIED_INCIDENT -> VERIFIED_RECOVERY', async () => {
      const mon = getMonitoringEngine();
      const w = await mon.createWatcher({
        name: 'E2E-Backend',
        targetUrl: monUrl,
        method: 'http_health',
        failureThreshold: 2,
        projectName: 'SSVM-ERP',
        actorId: actorA,
      });
      monHealthy = false;
      await mon.checkWatcherNow(w.id);
      await mon.checkWatcherNow(w.id);
      let incs = await mon.listIncidents({ actorId: actorA, projectName: 'SSVM-ERP' });
      assert.equal(incs[0].stage, 'VERIFIED_INCIDENT');

      monHealthy = true;
      await mon.checkWatcherNow(w.id);
      incs = await mon.listIncidents({ actorId: actorA, projectName: 'SSVM-ERP' });
      assert.equal(incs[0].stage, 'VERIFIED_RECOVERY');
    });

    it('Scenario E: Learning ingestion, correction, and retrieval of corrected fact', async () => {
      const learn = getContinuousLearningEngine();
      await learn.ingest({
        actorId: actorA,
        sourceType: 'user_file',
        sourceRef: 'notes.md',
        subject: 'Deployment target',
        rawContent: 'Deploy on port 3000',
        projectName: 'SSVM-ERP',
      });
      await learn.recordCorrection({
        actorId: actorA,
        subject: 'Deployment target',
        correction: 'Deploy on port 3141',
        projectName: 'SSVM-ERP',
      });
      const recs = await learn.retrieve({ actorId: actorA, projectName: 'SSVM-ERP', query: 'Deployment target' });
      assert.equal(recs[0].content, 'Deploy on port 3141');
    });

    it('Scenario F: Consequential action blocked without approval, executes after approval', async () => {
      const reg = getToolRegistry();
      const blocked = await reg.execute(
        'core.research.submit_web_action',
        { url: webMockUrl, actionType: 'publish' },
        { actor: actorA, approvedHighRisk: false, grantedPermissions: ['write:web'] }
      );
      assert.equal(blocked.success, false);

      const allowed = await reg.execute(
        'core.research.submit_web_action',
        { url: webMockUrl, actionType: 'publish' },
        { actor: actorA, approvedHighRisk: true, grantedPermissions: ['write:web'] }
      );
      assert.equal(allowed.success, true);
    });

    it('Scenario G & H: Cross-device continuity (Windows/Web/Android) & restart failure recovery', async () => {
      const idSvc = getPersonalIdentityService();
      await idSvc.createOrUpdateProfile(actorA, { preferredAddress: 'Boss' });

      // Simulate Windows/voice turn then Android turn with same actor & session
      await getAssistantBrain().process('Remember that I prefer concise summaries.', 'shared-e2e', false, {
        actorId: actorA,
        channel: 'voice',
      });
      const androidRes = await getAssistantBrain().process(
        'What is my active project?',
        'shared-e2e',
        false,
        { actorId: actorA, channel: 'android' }
      );
      assert.ok(androidRes.output);

      // Simulate Ollama offline + SQLite restart recovery
      ollamaOnline = false;
      const store = await getMemoryStore();
      store.close();
      await store.initialize();

      const recoveredProfile = await idSvc.getProfile(actorA);
      assert.equal(recoveredProfile.preferredAddress, 'Boss');
      const offlineRes = await getAssistantBrain().process('Tell me a story', 'shared-e2e', false, {
        actorId: actorA,
        channel: 'android',
      });
      assert.equal(offlineRes.success, false); // Honest failure, never fabricated
      ollamaOnline = true;
    });
  });
});
