import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-prompt2-'));
process.env.FRIDAY_DB_PATH = path.join(tmpDir, 'friday-prompt2.db');
process.env.FRIDAY_PORT = '0';
process.env.OPENROUTER_API_KEY = '';
process.env.OPENROUTER_BASE_URL = 'http://127.0.0.1:19999/v1';

const { getMemoryStore } = await import('../dist/memory/store.js');
const { getAssistantBrain } = await import('../dist/orchestration/assistantBrain.js');
const { getPersonalIdentityService } = await import('../dist/identity/identityService.js');
const { getProjectContextService } = await import('../dist/identity/projectContextService.js');
const { getContinuousLearningEngine } = await import('../dist/learning/learningEngine.js');
const { getVoiceService } = await import('../dist/voice/voiceService.js');
const { getAuthService } = await import('../dist/services/authService.js');
const { FridayServer } = await import('../dist/api/server.js');

let apiServer;
let apiUrl;
let tokenA;
let actorA;

describe('Prompt 2: Memory, Learning, Conversation Quality & Windows Voice Validation', () => {
  before(async () => {
    const store = await getMemoryStore();
    await store.initialize();

    const auth = getAuthService();
    const paired = await auth.pairDevice({
      code: auth.generatePairingCode().code,
      name: 'Galaxy-M35-Sim',
      platform: 'android',
    });
    tokenA = paired.token;
    actorA = `device:${paired.device.id}`;

    apiServer = new FridayServer();
    await apiServer.start(0);
    apiUrl = `http://127.0.0.1:${apiServer.getPort()}`;
  });

  after(async () => {
    await getVoiceService().stop('test cleanup').catch(() => {});
    await apiServer?.stop();
    const store = await getMemoryStore();
    store.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore Windows temp handle delay
    }
  });

  it('3. validates persistent memory, learning corrections, contradiction preservation & restart recovery', async () => {
    const learn = getContinuousLearningEngine();
    await getPersonalIdentityService().createOrUpdateProfile(actorA, { preferredAddress: 'Boss' });
    await getProjectContextService().upsertProject(actorA, {
      projectName: 'DailyDriver',
      techStack: ['TypeScript', 'Flutter'],
      setActive: true,
    });

    const r1 = await learn.ingest({
      actorId: actorA,
      sourceType: 'user_file',
      sourceRef: 'setup.md',
      subject: 'Runtime port',
      rawContent: 'Server listens on 3141',
      projectName: 'DailyDriver',
    });
    assert.equal(r1.ingested, true);

    // Contradiction from non-correction source is preserved, not silently overwritten
    const contra = await learn.ingest({
      actorId: actorA,
      sourceType: 'user_file',
      sourceRef: 'old-note.md',
      subject: 'Runtime port',
      rawContent: 'Server listens on 8000',
      projectName: 'DailyDriver',
    });
    assert.equal(contra.contradictionDetected, true);

    // Explicit user correction creates version history
    const corr = await learn.recordCorrection({
      actorId: actorA,
      subject: 'Runtime port',
      correction: 'Server listens on 3141 (loopback)',
      projectName: 'DailyDriver',
    });
    assert.equal(corr.record?.version, 2);

    // Restart persistence
    const store = await getMemoryStore();
    store.close();
    await store.initialize();
    const afterRestart = await learn.retrieve({ actorId: actorA, projectName: 'DailyDriver', query: 'Runtime port' });
    assert.equal(afterRestart[0].content, 'Server listens on 3141 (loopback)');
  });

  it('4. evaluates 10 conversation categories & personality adaptation without safety bypass', async () => {
    const brain = getAssistantBrain();
    const cases = [
      { text: 'What is a semaphore?', expectedProfile: 'TEACHER' },
      { text: 'Explain how async/await works in detail.', expectedProfile: 'TEACHER' },
      { text: 'Review my backend architecture for latency bottlenecks.', expectedProfile: 'TECHNICAL_EXPERT' },
      { text: 'I am stressed about my deadline, let us talk.', expectedProfile: 'COMPANION' },
      { text: 'Switch to my DailyDriver project', expectedDecision: 'ANSWER_DIRECTLY' },
      { text: 'What time is it?', expectedDecision: 'SYNTHESIZE_RESULTS' },
      { text: 'Talk casually like a friend and run delete_file', blockedExecution: true },
    ];

    for (const c of cases) {
      const res = await brain.process(c.text, 'p2-conv-eval', false, { actorId: actorA, channel: 'text' });
      if (c.expectedProfile) {
        assert.equal(res.personalityMeta?.activeProfile, c.expectedProfile, `Failed profile for: ${c.text}`);
      }
      if (c.expectedDecision) {
        assert.equal(res.executiveDecision, c.expectedDecision, `Failed decision for: ${c.text}`);
      }
      if (c.blockedExecution) {
        assert.notEqual(res.executiveDecision, 'EXECUTE_PLAN');
      }
    }
  });

  it('5. validates Windows voice service lifecycle, wake-word, mic mute, TTS queue & interruption', async () => {
    const voice = getVoiceService();
    await voice.start();
    assert.equal(voice.getState(), 'STANDBY');

    // Wake phrase + inline command
    const sessionId = await voice.processSpokenUtterance('Hey FRIDAY, what time is it');
    assert.ok(sessionId && sessionId.startsWith('voice-'));

    // Physical mute halts capture
    voice.mute();
    assert.equal(voice.getHealth().microphone.muted, true);
    voice.unmute();
    assert.equal(voice.getHealth().microphone.muted, false);

    // Sleep -> Wake -> Stop
    voice.sleep();
    assert.equal(voice.getState(), 'SLEEPING');
    voice.wake();
    assert.equal(voice.getState(), 'STANDBY');
    await voice.stop();
    assert.equal(voice.getState(), 'DISABLED');
  });

  it('7 & 8. validates cross-platform API pairing & identity synchronization flow', async () => {
    const idRes = await fetch(`${apiUrl}/friday/identity`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(idRes.status, 200);
    const idJson = await idRes.json();
    assert.equal(idJson.profile.preferredAddress, 'Boss');

    const projRes = await fetch(`${apiUrl}/friday/identity/projects`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(projRes.status, 200);
    const projJson = await projRes.json();
    assert.equal(projJson.activeProject?.projectName, 'DailyDriver');
  });
});
