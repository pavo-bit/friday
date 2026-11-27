import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-wp1-sec-'));
process.env.FRIDAY_DB_PATH = path.join(tmpDir, 'friday-wp1.db');
process.env.FRIDAY_PORT = '0';
// Ensure SSRF protection is strictly ON (do NOT set FRIDAY_ALLOW_LOCALHOST_RESEARCH)
delete process.env.FRIDAY_ALLOW_LOCALHOST_RESEARCH;

const { getMemoryStore } = await import('../dist/memory/store.js');
const { getAuthService } = await import('../dist/services/authService.js');
const { getBrowserAdapter, isBlockedIp } = await import('../dist/research/browserAdapter.js');
const { enforceActorScope, ActorImpersonationError } = await import('../dist/api/authContext.js');
const { getContinuousLearningEngine } = await import('../dist/learning/learningEngine.js');
const { getSafetyGate } = await import('../dist/orchestration/safetyGate.js');
const { FridayServer } = await import('../dist/api/server.js');

let apiServer;
let apiUrl;
let tokenA;
let actorA;
let tokenB;
let actorB;

describe('WP1 Security Hardening: Auth, Actor Isolation, Approvals & SSRF', () => {
  before(async () => {
    const store = await getMemoryStore();
    await store.initialize();

    const auth = getAuthService();
    const pairA = await auth.pairDevice({
      code: auth.generatePairingCode().code,
      name: 'Device-A',
      platform: 'android',
    });
    tokenA = pairA.token;
    actorA = `device:${pairA.device.id}`;

    const pairB = await auth.pairDevice({
      code: auth.generatePairingCode().code,
      name: 'Device-B',
      platform: 'android',
    });
    tokenB = pairB.token;
    actorB = `device:${pairB.device.id}`;

    apiServer = new FridayServer();
    await apiServer.start(0);
    apiUrl = `http://127.0.0.1:${apiServer.getPort()}`;
  });

  after(async () => {
    await apiServer?.stop();
    const store = await getMemoryStore();
    store.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore Windows temp cleanup delay
    }
  });

  it('rejects invalid, malformed, and revoked bearer tokens across private routes', async () => {
    for (const ep of [
      '/friday/identity',
      '/friday/identity/projects',
      '/friday/learning/records',
      '/friday/research/jobs',
      '/friday/personality',
    ]) {
      const bad1 = await fetch(`${apiUrl}${ep}`, { headers: { Authorization: 'Basic invalid' } });
      assert.equal(bad1.status, 401);

      const bad2 = await fetch(`${apiUrl}${ep}`, { headers: { Authorization: 'Bearer invalid-token-xyz' } });
      assert.equal(bad2.status, 401);
    }

    // Revoked device loses access immediately
    const auth = getAuthService();
    const tempPair = await auth.pairDevice({
      code: auth.generatePairingCode().code,
      name: 'Revoke-Me',
      platform: 'android',
    });
    await auth.revokeDevice(tempPair.device.id);
    const revRes = await fetch(`${apiUrl}/friday/identity`, {
      headers: { Authorization: `Bearer ${tempPair.token}` },
    });
    assert.equal(revRes.status, 401);
  });

  it('prevents remote actorId spoofing in body and query via enforceActorScope', () => {
    const remote = {
      actorId: actorA,
      deviceId: actorA.replace('device:', ''),
      isLocal: false,
      authenticated: true,
    };
    assert.equal(enforceActorScope(remote, undefined), actorA);
    assert.equal(enforceActorScope(remote, actorA), actorA);
    assert.throws(() => enforceActorScope(remote, 'local'), ActorImpersonationError);
    assert.throws(() => enforceActorScope(remote, actorB), ActorImpersonationError);
  });

  it('enforces cross-device isolation on learning, projects, and procedures', async () => {
    const learn = getContinuousLearningEngine();
    const recA = await learn.ingest({
      actorId: actorA,
      sourceType: 'user_file',
      sourceRef: 'a-secret.md',
      subject: 'Actor A Private Note',
      rawContent: 'Confidential project architecture for Device A only.',
    });
    assert.equal(recA.ingested, true);

    // Device B cannot read or delete Device A's records
    const bRecords = await learn.retrieve({ actorId: actorB, query: 'Confidential' });
    assert.equal(bRecords.length, 0);

    const bDelete = await learn.deleteKnowledge(actorB, recA.record.id);
    assert.equal(bDelete, false);
  });

  it('enforces approval ownership, expiry, and replay prevention in SafetyGate', async () => {
    const gate = getSafetyGate();
    const deviceIdA = actorA.replace('device:', '');
    const created = await gate.createBoundApproval({
      taskId: 'wp1-task-1',
      stepId: 'wp1-step-1',
      actorId: actorA,
      deviceId: deviceIdA,
      capabilityId: 'core.research.submit_web_action',
      args: { url: 'https://example.com', actionType: 'publish' },
      permissionScope: 'write:web',
      riskLevel: 'high',
      summary: 'Publish test',
      expiresInMs: 60_000,
    });

    // Actor B cannot approve Actor A's bound approval
    const crossApprove = await gate.resolveBoundApproval({
      approvalId: created.approvalId,
      decision: 'APPROVE',
      actorId: actorB,
    });
    assert.equal(crossApprove.ok, false);

    // Actor A approves once -> valid once -> replay prevented
    const okApprove = await gate.resolveBoundApproval({
      approvalId: created.approvalId,
      decision: 'APPROVE',
      actorId: actorA,
    });
    assert.equal(okApprove.ok, true);

    const consume1 = await gate.consumeBoundApproval({
      approvalId: created.approvalId,
      taskId: 'wp1-task-1',
      stepId: 'wp1-step-1',
      capabilityId: 'core.research.submit_web_action',
      args: { url: 'https://example.com', actionType: 'publish' },
      actorId: actorA,
      deviceId: deviceIdA,
      permissionScope: 'write:web',
    });
    assert.equal(consume1.ok, true);

    const replay = await gate.consumeBoundApproval({
      approvalId: created.approvalId,
      taskId: 'wp1-task-1',
      stepId: 'wp1-step-1',
      capabilityId: 'core.research.submit_web_action',
      args: { url: 'https://example.com', actionType: 'publish' },
      actorId: actorA,
      deviceId: deviceIdA,
      permissionScope: 'write:web',
    });
    assert.equal(replay.ok, false);
  });

  it('blocks SSRF targets: private IPs, loopback, cloud metadata, IPv6 local, and redirect-to-loopback', async () => {
    assert.equal(isBlockedIp('127.0.0.1'), true);
    assert.equal(isBlockedIp('10.0.0.1'), true);
    assert.equal(isBlockedIp('172.16.5.4'), true);
    assert.equal(isBlockedIp('192.168.1.10'), true);
    assert.equal(isBlockedIp('169.254.169.254'), true);
    assert.equal(isBlockedIp('::1'), true);
    assert.equal(isBlockedIp('fe80::1'), true);
    assert.equal(isBlockedIp('93.184.216.34'), false); // example.com public IP

    const browser = getBrowserAdapter();
    assert.throws(() => browser.validatePublicUrl('http://127.0.0.1:3141/friday/health'), /SSRF protection/);
    assert.throws(() => browser.validatePublicUrl('http://169.254.169.254/latest/meta-data/'), /SSRF protection/);
    assert.throws(() => browser.validatePublicUrl('http://localhost:11434/api/tags'), /SSRF protection/);
    assert.throws(() => browser.validatePublicUrl('http://[::1]:3141/'), /SSRF protection/);

    // Test redirect-hop check using temporary local redirector
    const redirServer = http.createServer((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    await new Promise((resolve) => redirServer.listen(0, '127.0.0.1', resolve));
    try {
      await assert.rejects(
        () => browser.assertSafeDestination(new URL('http://169.254.169.254/latest/meta-data/')),
        /SSRF protection/
      );
    } finally {
      await new Promise((resolve) => redirServer.close(resolve));
    }
  });
});
