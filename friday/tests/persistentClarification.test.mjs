import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-phase10-1-test-'));
process.env.FRIDAY_DB_PATH = path.join(tmpDir, 'friday-phase10-1.db');

const { getMemoryStore } = await import('../dist/memory/store.js');
const { ClarificationEngine, getClarificationEngine } = await import(
  '../dist/orchestration/clarificationEngine.js'
);
const { getRequestUnderstandingEngine } = await import(
  '../dist/orchestration/requestUnderstanding.js'
);
const { getAssistantBrain } = await import('../dist/orchestration/assistantBrain.js');

describe('Phase 10.1: Persistent Clarification & Restart Recovery', () => {
  before(async () => {
    const store = await getMemoryStore();
    await store.initialize();
  });

  after(async () => {
    const store = await getMemoryStore();
    await store.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Ignore Windows temp file lock
    }
  });

  it('Persists across simulated backend restart and resumes safely without granting approval', async () => {
    const brain = getAssistantBrain();
    const res1 = await brain.process('Send him the report.', 'conv-restart', false, {
      actorId: 'actor-A',
    });
    assert.equal(res1.executiveDecision, 'ASK_CLARIFICATION');

    // Simulate backend restart: close and re-open DB + fresh ClarificationEngine instance
    const store = await getMemoryStore();
    store.close();
    await store.initialize();

    const freshEngine = new ClarificationEngine();
    const restored = await freshEngine.getPending('actor-A', 'conv-restart');
    assert.ok(restored !== null);
    assert.equal(restored.status, 'PENDING');
    assert.equal(restored.originalRequest, 'Send him the report.');

    // Wrong actor or wrong conversation cannot access it
    assert.equal(await freshEngine.getPending('actor-B', 'conv-restart'), null);
    assert.equal(await freshEngine.getPending('actor-A', 'conv-other'), null);

    // Concurrent duplicate answers: exactly ONE succeeds
    const [m1, m2] = await Promise.all([
      freshEngine.consumeAndMerge('actor-A', 'conv-restart', 'Rahul'),
      freshEngine.consumeAndMerge('actor-A', 'conv-restart', 'Rahul duplicate'),
    ]);
    assert.equal([Boolean(m1), Boolean(m2)].filter(Boolean).length, 1);
    assert.equal(await freshEngine.getPending('actor-A', 'conv-restart'), null);
  });

  it('Handles expiration, cancellation, multiple conversations, and malformed persisted records', async () => {
    const engine = getClarificationEngine();
    const reqA = getRequestUnderstandingEngine().understand({
      rawInput: 'Analyze that stock',
      actorId: 'actor-1',
      conversationId: 'conv-1',
    });
    const reqB = getRequestUnderstandingEngine().understand({
      rawInput: 'Move the meeting',
      actorId: 'actor-1',
      conversationId: 'conv-2',
    });

    // Separate conversations for same actor stay isolated
    const p1 = await engine.setPending({
      actorId: 'actor-1',
      conversationId: 'conv-1',
      originalRequestId: reqA.requestId,
      originalRequest: reqA.rawInput,
      structuredRequest: reqA,
      missingFields: ['symbol'],
      question: 'Which stock symbol?',
    });
    const p2 = await engine.setPending({
      actorId: 'actor-1',
      conversationId: 'conv-2',
      originalRequestId: reqB.requestId,
      originalRequest: reqB.rawInput,
      structuredRequest: reqB,
      missingFields: ['new_datetime'],
      question: 'To what date and time?',
    });

    assert.equal((await engine.getPending('actor-1', 'conv-1'))?.clarificationId, p1.clarificationId);
    assert.equal((await engine.getPending('actor-1', 'conv-2'))?.clarificationId, p2.clarificationId);

    // Cancellation
    assert.equal(await engine.cancel(p2.clarificationId, 'actor-2'), false); // Wrong actor rejected
    assert.equal(await engine.cancel(p2.clarificationId, 'actor-1'), true);
    assert.equal(await engine.getPending('actor-1', 'conv-2'), null);

    // Expiration
    const expired = await engine.setPending({
      actorId: 'actor-1',
      conversationId: 'conv-exp',
      originalRequest: 'Delete the old files',
      missingFields: ['target_path'],
      question: 'Which directory?',
      ttlMs: -5000,
    });
    assert.equal(await engine.getPending('actor-1', 'conv-exp'), null);
    const store = await getMemoryStore();
    const expRow = store
      .getDatabase()
      .prepare(`SELECT status FROM pending_clarifications WHERE clarification_id = ?`)
      .get(expired.clarificationId);
    assert.equal(expRow.status, 'EXPIRED');

    // Malformed persisted request_json is quarantined/cancelled safely
    const malformed = await engine.setPending({
      actorId: 'actor-1',
      conversationId: 'conv-bad',
      originalRequest: 'Analyze that stock',
      missingFields: ['symbol'],
      question: 'Which symbol?',
    });
    store
      .getDatabase()
      .prepare(`UPDATE pending_clarifications SET request_json = '{bad-json' WHERE clarification_id = ?`)
      .run(malformed.clarificationId);
    assert.equal(await engine.getPending('actor-1', 'conv-bad'), null);
  });
});
