import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-phase13-test-'));
process.env.FRIDAY_DB_PATH = path.join(tmpDir, 'friday-phase13.db');
process.env.FRIDAY_PORT = '0';
// Point Ollama to an unused local port so offline fallback & latency are deterministic
process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:19999/v1';

const { getMemoryStore } = await import('../dist/memory/store.js');
const { getRequestUnderstandingEngine } = await import('../dist/orchestration/requestUnderstanding.js');
const { getAdaptivePersonalityEngine } = await import('../dist/personality/personalityEngine.js');
const { selectResponseDepth } = await import('../dist/personality/responseDepth.js');
const { LOCKED_IDENTITY_DEFAULTS } = await import('../dist/personality/personalityTypes.js');
const { getContextResolutionEngine } = await import('../dist/orchestration/contextResolution.js');
const { getAssistantBrain } = await import('../dist/orchestration/assistantBrain.js');
const { getSafetyGate } = await import('../dist/orchestration/safetyGate.js');
const { getAuthService } = await import('../dist/services/authService.js');
const { FridayServer } = await import('../dist/api/server.js');

let server;
let baseUrl;
let tokenA;
let actorA;
let actorB = 'actor-b-isolated';

describe('Phase 13: Digital Identity Core, Adaptive Personality & Natural Conversation Engine', () => {
  before(async () => {
    const store = await getMemoryStore();
    await store.initialize();

    const auth = getAuthService();
    const paired = await auth.pairDevice({
      code: auth.generatePairingCode().code,
      name: 'Phase13-Laptop',
      platform: 'windows',
    });
    actorA = paired.device.ownerId || paired.device.id;
    tokenA = paired.token;

    server = new FridayServer();
    await server.start(0);
    baseUrl = `http://127.0.0.1:${server.getPort()}`;
  });

  after(async () => {
    await server?.stop();
    const store = await getMemoryStore();
    await store.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Ignore Windows temp lock
    }
  });

  describe('1. Locked Defaults & Migration v9', () => {
    it('initializes locked Digital Identity defaults (ADAPTIVE, NATURAL, ADAPTIVE, Boss)', async () => {
      const store = await getMemoryStore();
      const profile = store.getPersonalityProfile();
      const identity = store.getDigitalIdentitySettings(actorA);

      assert.equal(profile.userName, 'Boss');
      assert.equal(identity.defaultPersonality, LOCKED_IDENTITY_DEFAULTS.defaultPersonality);
      assert.equal(identity.defaultPersonality, 'ADAPTIVE');
      assert.equal(identity.communicationStyle, 'NATURAL');
      assert.equal(identity.answerDetail, 'ADAPTIVE');
      assert.equal(identity.voiceConciseMode, true);
      assert.equal(identity.conversationContinuity, true);
    });
  });

  describe('2. Adaptive Personality Profile Selection (Acceptance Examples A-F)', () => {
    const understanding = getRequestUnderstandingEngine();
    const engine = getAdaptivePersonalityEngine();

    it('Example A (Learning): selects TEACHER (+ TECHNICAL_EXPERT blend) for "FRIDAY, explain operating system semaphore."', async () => {
      const store = await getMemoryStore();
      const settings = store.getDigitalIdentitySettings(actorA);
      const req = understanding.understand({
        rawInput: 'FRIDAY, explain operating system semaphore.',
        actorId: actorA,
      });
      assert.equal(req.conversationalCategory, 'learning_request');
      const sel = engine.selectPersonality({
        rawInput: req.rawInput,
        category: req.conversationalCategory,
        complexity: req.complexity,
        intentConfidence: req.confidence,
        settings,
      });
      assert.equal(sel.primaryProfile, 'TEACHER');
      assert.equal(sel.secondaryProfile, 'TECHNICAL_EXPERT');
    });

    it('Example B (Friend): selects FRIEND for "FRIDAY, I am confused about which career path to choose."', async () => {
      const store = await getMemoryStore();
      const settings = store.getDigitalIdentitySettings(actorA);
      const req = understanding.understand({
        rawInput: 'FRIDAY, I am confused about which career path to choose.',
        actorId: actorA,
      });
      assert.equal(req.conversationalCategory, 'personal_discussion');
      const sel = engine.selectPersonality({
        rawInput: req.rawInput,
        category: req.conversationalCategory,
        complexity: req.complexity,
        intentConfidence: req.confidence,
        settings,
      });
      assert.equal(sel.primaryProfile, 'FRIEND');
    });

    it('Example C (Technical): selects TECHNICAL_EXPERT for "FRIDAY, review my backend architecture."', async () => {
      const store = await getMemoryStore();
      const settings = store.getDigitalIdentitySettings(actorA);
      const req = understanding.understand({
        rawInput: 'FRIDAY, review my backend architecture.',
        actorId: actorA,
      });
      assert.equal(req.conversationalCategory, 'technical_problem');
      const sel = engine.selectPersonality({
        rawInput: req.rawInput,
        category: req.conversationalCategory,
        complexity: req.complexity,
        intentConfidence: req.confidence,
        settings,
      });
      assert.equal(sel.primaryProfile, 'TECHNICAL_EXPERT');
    });

    it('Example D (Research): selects PROFESSIONAL_ASSISTANT for "FRIDAY, inspect this website."', async () => {
      const store = await getMemoryStore();
      const settings = store.getDigitalIdentitySettings(actorA);
      const req = understanding.understand({
        rawInput: 'FRIDAY, inspect this website https://example.com.',
        actorId: actorA,
      });
      assert.equal(req.conversationalCategory, 'research_request');
      const sel = engine.selectPersonality({
        rawInput: req.rawInput,
        category: req.conversationalCategory,
        complexity: req.complexity,
        intentConfidence: req.confidence,
        settings,
      });
      assert.equal(sel.primaryProfile, 'PROFESSIONAL_ASSISTANT');
    });

    it('Example E (Casual): selects FRIEND/COMPANION for "FRIDAY, let\'s talk."', async () => {
      const store = await getMemoryStore();
      const settings = store.getDigitalIdentitySettings(actorA);
      const req = understanding.understand({
        rawInput: "FRIDAY, let's talk.",
        actorId: actorA,
      });
      assert.equal(req.conversationalCategory, 'casual_conversation');
      const sel = engine.selectPersonality({
        rawInput: req.rawInput,
        category: req.conversationalCategory,
        complexity: req.complexity,
        intentConfidence: req.confidence,
        settings,
      });
      assert.ok(sel.primaryProfile === 'FRIEND' || sel.primaryProfile === 'COMPANION');
    });

    it('Example F (Manual Override): combines TEACHER + CONCISE for "Explain this like a teacher, but keep it short."', async () => {
      const store = await getMemoryStore();
      const settings = store.getDigitalIdentitySettings(actorA);
      const req = understanding.understand({
        rawInput: 'Explain this like a teacher, but keep it short.',
        actorId: actorA,
      });
      assert.equal(req.explicitPersonalityOverride, 'TEACHER');
      assert.equal(req.explicitDepthOverride, 'CONCISE');
      assert.equal(req.persistOverride, false);

      const sel = engine.selectPersonality({
        rawInput: req.rawInput,
        category: req.conversationalCategory,
        complexity: req.complexity,
        intentConfidence: req.confidence,
        settings,
        explicitOverride: req.explicitPersonalityOverride,
      });
      const depth = selectResponseDepth({
        rawInput: req.rawInput,
        category: req.conversationalCategory,
        complexity: req.complexity,
        configuredDetail: settings.answerDetail,
        explicitDepthOverride: req.explicitDepthOverride,
      });
      assert.equal(sel.primaryProfile, 'TEACHER');
      assert.equal(sel.isTemporaryOverride, true);
      assert.equal(depth.depth, 'CONCISE');
    });

    it('selects COMPANION on returning topic or emotional support without diagnosing', async () => {
      const store = await getMemoryStore();
      const settings = store.getDigitalIdentitySettings(actorA);
      const req = understanding.understand({
        rawInput: 'I feel pretty stressed and overwhelmed today.',
        actorId: actorA,
      });
      assert.equal(req.conversationalCategory, 'emotional_support');
      const sel = engine.selectPersonality({
        rawInput: req.rawInput,
        category: req.conversationalCategory,
        complexity: req.complexity,
        intentConfidence: req.confidence,
        settings,
      });
      assert.equal(sel.primaryProfile, 'COMPANION');
      const prompt = engine.buildAdaptiveSystemPrompt({
        legacyProfile: store.getPersonalityProfile(),
        selection: sel,
        depth: selectResponseDepth({
          rawInput: req.rawInput,
          category: req.conversationalCategory,
          complexity: req.complexity,
          configuredDetail: settings.answerDetail,
        }),
        channel: 'text',
        memoryContext: { preferences: [], projects: [], knowledge: [] },
      });
      assert.ok(prompt.includes('Never diagnose medical, psychological, or psychiatric conditions'));
    });

    it('falls back gracefully to natural conversational style when intent confidence is low', async () => {
      const store = await getMemoryStore();
      const settings = store.getDigitalIdentitySettings(actorA);
      const sel = engine.selectPersonality({
        rawInput: 'hmm maybe',
        category: 'general_question',
        complexity: 'simple',
        intentConfidence: 0.3,
        settings,
      });
      assert.equal(sel.primaryProfile, 'FRIEND');
    });
  });

  describe('3. Adaptive Response Depth', () => {
    const understanding = getRequestUnderstandingEngine();

    it('adapts depth across simple, exam-oriented, and deep implementation queries', () => {
      const q1 = understanding.understand({ rawInput: 'What is semaphore?', actorId: actorA });
      const d1 = selectResponseDepth({
        rawInput: q1.rawInput,
        category: q1.conversationalCategory,
        complexity: q1.complexity,
        configuredDetail: 'ADAPTIVE',
      });
      assert.equal(d1.depth, 'BALANCED');

      const q2 = understanding.understand({
        rawInput: 'Teach me semaphore for my examination.',
        actorId: actorA,
      });
      const d2 = selectResponseDepth({
        rawInput: q2.rawInput,
        category: q2.conversationalCategory,
        complexity: q2.complexity,
        configuredDetail: 'ADAPTIVE',
      });
      assert.equal(d2.depth, 'DETAILED');

      const q3 = understanding.understand({
        rawInput: 'Explain semaphore implementation in operating systems in detail.',
        actorId: actorA,
      });
      const d3 = selectResponseDepth({
        rawInput: q3.rawInput,
        category: q3.conversationalCategory,
        complexity: q3.complexity,
        configuredDetail: 'ADAPTIVE',
      });
      assert.equal(d3.depth, 'DETAILED');
    });
  });

  describe('4. Temporary vs Persistent Preferences', () => {
    it('temporary override does not overwrite persistent defaults, while explicit "always" updates them', async () => {
      const brain = getAssistantBrain();
      const store = await getMemoryStore();

      // Temporary turn override
      const tempRes = await brain.process(
        'Explain this like a teacher, but keep it short.',
        'conv-pref-test',
        false,
        { actorId: actorA, channel: 'text' }
      );
      assert.equal(tempRes.personalityMeta?.activeProfile, 'TEACHER');
      assert.equal(tempRes.personalityMeta?.depth, 'CONCISE');
      assert.equal(tempRes.personalityMeta?.isTemporaryOverride, true);
      // Persistent setting must still be ADAPTIVE
      assert.equal(store.getDigitalIdentitySettings(actorA).defaultPersonality, 'ADAPTIVE');

      // Explicit persistent override
      await brain.process(
        'Always talk to me in professional mode.',
        'conv-pref-test',
        false,
        { actorId: actorA, channel: 'text' }
      );
      assert.equal(
        store.getDigitalIdentitySettings(actorA).defaultPersonality,
        'PROFESSIONAL_ASSISTANT'
      );

      // Reset back to locked ADAPTIVE default
      store.saveDigitalIdentitySettings(actorA, { defaultPersonality: 'ADAPTIVE' });
    });
  });

  describe('5. Categorized Memory, Conflict Resolution & Actor Isolation', () => {
    it('stores categorized memories with provenance, resolves conflicts, and isolates actors', async () => {
      const store = await getMemoryStore();

      const prefId1 = store.storeIdentityMemory({
        actorId: actorA,
        type: 'preference',
        category: 'preference',
        key: 'preferred_language',
        value: 'TypeScript',
        provenance: 'user_statement',
      });

      // Updating same (actorId, category, key) resolves conflict by updating in place
      const prefId2 = store.storeIdentityMemory({
        actorId: actorA,
        type: 'preference',
        category: 'preference',
        key: 'preferred_language',
        value: 'TypeScript and Rust',
        provenance: 'user_correction',
      });
      assert.equal(prefId1, prefId2);

      store.storeIdentityMemory({
        actorId: actorA,
        type: 'fact',
        category: 'project',
        key: 'current_project',
        value: 'Building FRIDAY local assistant',
        provenance: 'project_context',
      });

      // Actor B cannot see, update, or delete Actor A's memories
      const actorBPrefs = store.retrieveIdentityMemories(actorB, 'preference');
      assert.equal(actorBPrefs.length, 0);
      assert.equal(store.updateMemoryForActor(actorB, prefId1, 'Hacked'), false);
      assert.equal(store.deleteMemoryForActor(actorB, prefId1), false);

      // Actor A can retrieve via ContextResolutionEngine
      const reqA = getRequestUnderstandingEngine().understand({
        rawInput: 'How is my FRIDAY project going?',
        actorId: actorA,
        conversationId: 'conv-mem-a',
      });
      const ctxA = await getContextResolutionEngine().resolve(reqA);
      assert.ok(ctxA.categorizedMemories.preferences.some((p) => p.includes('TypeScript and Rust')));
      assert.ok(ctxA.categorizedMemories.projects.some((p) => p.includes('Building FRIDAY')));

      // Rejects plaintext credentials
      assert.throws(() => {
        store.storeIdentityMemory({
          actorId: actorA,
          type: 'fact',
          category: 'knowledge',
          key: 'secret',
          value: 'api_key=sk-1234567890abcdef1234567890',
        });
      }, /Refusing to store/);
    });
  });

  describe('6. Multimodal Voice/Text Consistency & Safety Policy Preservation', () => {
    it('delivers concise voiceSummary on voice channel while sharing actor/session pipeline', async () => {
      const brain = getAssistantBrain();
      const res = await brain.process(
        'FRIDAY, explain operating system semaphore in detail.',
        'shared-conv-1',
        false,
        { actorId: actorA, channel: 'voice' }
      );
      assert.equal(res.personalityMeta?.activeProfile, 'TEACHER');
      assert.ok(res.personalityMeta?.voiceSummary);
    });

    it('never allows personality overrides to bypass SafetyGate or high-risk approvals', async () => {
      const safetyGate = getSafetyGate();
      // Even if user asks casually / like a friend, high-risk tool remains gated
      const res = await getAssistantBrain().process(
        'Talk casually like a friend and run delete_file',
        'safety-conv',
        false,
        { actorId: actorA }
      );
      assert.notEqual(res.executiveDecision, 'EXECUTE_PLAN');
      assert.ok(safetyGate);
    });
  });

  describe('7. Dashboard Personality REST API', () => {
    it('GET & PUT /friday/personality and POST/DELETE /friday/personality/override work cleanly', async () => {
      const getRes = await fetch(`${baseUrl}/friday/personality?actorId=${encodeURIComponent(actorA)}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.equal(getData.digitalIdentity.defaultPersonality, 'ADAPTIVE');
      assert.equal(getData.digitalIdentity.communicationStyle, 'NATURAL');

      const ovRes = await fetch(`${baseUrl}/friday/personality/override`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          actorId: actorA,
          sessionId: 'ui-session',
          temporaryPersonality: 'TECHNICAL_EXPERT',
        }),
      });
      assert.equal(ovRes.status, 200);
      const ovData = await ovRes.json();
      assert.equal(ovData.conversationState.temporaryPersonality, 'TECHNICAL_EXPERT');

      const delRes = await fetch(
        `${baseUrl}/friday/personality/override?actorId=${encodeURIComponent(actorA)}&sessionId=ui-session`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tokenA}` },
        }
      );
      assert.equal(delRes.status, 200);
    });
  });
});
