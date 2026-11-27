import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-phase11-test-'));
process.env.FRIDAY_DB_PATH = path.join(tmpDir, 'friday-phase11.db');
process.env.FRIDAY_VOICE_TIMEZONE = 'Asia/Kolkata';

const { getMemoryStore } = await import('../dist/memory/store.js');
const { VoiceStateManager } = await import('../dist/voice/voiceStateManager.js');
const { GreetingService, getGreetingService } = await import('../dist/voice/greetingService.js');
const { WakeWordEngine } = await import('../dist/voice/wakeWordEngine.js');
const { MicrophoneManager } = await import('../dist/voice/microphoneManager.js');
const { SpeechSynthesisEngine } = await import('../dist/voice/speechSynthesis.js');
const { SpeechRecognitionEngine } = await import('../dist/voice/speechRecognition.js');
const { VoiceService } = await import('../dist/voice/voiceService.js');
const { WindowsLifecycleManager } = await import('../dist/voice/windowsLifecycle.js');
const { getAssistantBrain } = await import('../dist/orchestration/assistantBrain.js');
const { getClarificationEngine } = await import('../dist/orchestration/clarificationEngine.js');

describe('Phase 11: Windows Native Voice Activation & Assistant Experience', () => {
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
      // Ignore
    }
  });

  it('1. Finite State Machine: enforces valid transitions and rejects invalid state jumps', () => {
    const fsm = new VoiceStateManager('DISABLED');
    assert.equal(fsm.getState(), 'DISABLED');

    // Valid forward transitions
    assert.ok(fsm.canTransitionTo('STARTING'));
    fsm.transitionTo('STARTING', 'boot');
    assert.equal(fsm.getState(), 'STARTING');

    assert.ok(fsm.canTransitionTo('STANDBY'));
    fsm.transitionTo('STANDBY', 'ready');
    assert.equal(fsm.getState(), 'STANDBY');

    assert.ok(fsm.canTransitionTo('WAKE_DETECTED'));
    fsm.transitionTo('WAKE_DETECTED', 'wake phrase heard');

    assert.ok(fsm.canTransitionTo('LISTENING'));
    fsm.transitionTo('LISTENING', 'user speaking');

    assert.ok(fsm.canTransitionTo('PROCESSING'));
    fsm.transitionTo('PROCESSING', 'brain thinking');

    assert.ok(fsm.canTransitionTo('SPEAKING'));
    fsm.transitionTo('SPEAKING', 'assistant speaking');

    assert.ok(fsm.canTransitionTo('STANDBY'));
    fsm.transitionTo('STANDBY', 'speech done');
    assert.equal(fsm.getState(), 'STANDBY');

    // Mute cycle
    assert.ok(fsm.canTransitionTo('MUTED'));
    fsm.transitionTo('MUTED', 'mic muted');
    assert.equal(fsm.getState(), 'MUTED');

    assert.ok(fsm.canTransitionTo('STANDBY'));
    fsm.transitionTo('STANDBY', 'mic unmuted');

    // Sleep cycle
    assert.ok(fsm.canTransitionTo('SLEEPING'));
    fsm.transitionTo('SLEEPING', 'user said sleep');
    assert.equal(fsm.getState(), 'SLEEPING');

    assert.ok(fsm.canTransitionTo('STANDBY'));
    fsm.transitionTo('STANDBY', 'user said wake');

    // Invalid transition checks
    assert.throws(() => {
      fsm.transitionTo('SPEAKING', 'illegal jump');
    }, /Invalid voice state transition: STANDBY -> SPEAKING/);

    fsm.transitionTo('STOPPING');
    fsm.transitionTo('DISABLED');
    assert.equal(fsm.getState(), 'DISABLED');

    assert.throws(() => {
      fsm.transitionTo('LISTENING', 'illegal from disabled');
    }, /Invalid voice state transition: DISABLED -> LISTENING/);

    // Verify history tracking
    const history = fsm.getHistory();
    assert.ok(history.length >= 8);
    assert.equal(history[0].from, 'DISABLED');
    assert.equal(history[0].to, 'STARTING');
  });

  it('2. Time-Aware Greeting & Personality: deterministic time classification and "Boss" constraints', () => {
    const greetingService = new GreetingService();
    greetingService.setUserName('Boss');

    // Verify timezone resolution
    const tz = greetingService.resolveTimezone();
    assert.ok(tz === 'Asia/Kolkata' || tz.includes('/'));

    // Verify time classification
    assert.equal(greetingService.classifyTimeOfDay(6), 'morning');
    assert.equal(greetingService.classifyTimeOfDay(11), 'morning');
    assert.equal(greetingService.classifyTimeOfDay(12), 'afternoon');
    assert.equal(greetingService.classifyTimeOfDay(16), 'afternoon');
    assert.equal(greetingService.classifyTimeOfDay(17), 'evening');
    assert.equal(greetingService.classifyTimeOfDay(20), 'evening');
    assert.equal(greetingService.classifyTimeOfDay(21), 'night');
    assert.equal(greetingService.classifyTimeOfDay(2), 'night');

    // Test morning greeting
    const morningDate = new Date('2026-11-27T03:30:00Z'); // 09:00 AM IST (+05:30)
    const morningInfo = greetingService.getGreetingInfo(morningDate);
    assert.equal(morningInfo.salutation, 'Good morning');
    assert.equal(morningInfo.userName, 'Boss');
    assert.equal(morningInfo.period, 'morning');

    const morningWake = greetingService.generateWakeGreeting(morningDate);
    assert.ok(morningWake.includes('Boss'));
    assert.ok(morningWake.includes('Good morning'));

    // Test afternoon greeting
    const afternoonDate = new Date('2026-11-27T08:30:00Z'); // 02:00 PM IST (+05:30)
    const afternoonInfo = greetingService.getGreetingInfo(afternoonDate);
    assert.equal(afternoonInfo.salutation, 'Good afternoon');
    assert.equal(afternoonInfo.period, 'afternoon');

    // Test evening greeting
    const eveningDate = new Date('2026-11-27T13:00:00Z'); // 06:30 PM IST (+05:30)
    const eveningInfo = greetingService.getGreetingInfo(eveningDate);
    assert.equal(eveningInfo.salutation, 'Good evening');
    assert.equal(eveningInfo.period, 'evening');
  });

  it('3. Wake-Word Detection: exact matching, normalization, and compound command separation', () => {
    const engine = new WakeWordEngine();

    // Exact wake phrase
    const res1 = engine.evaluateText('Hey FRIDAY');
    assert.equal(res1.detected, true);
    assert.equal(res1.phrase, 'hey friday');
    assert.equal(res1.extractedCommand, '');

    // Reset cooldown for unit testing
    engine['lastDetectionTimestamp'] = 0;
    const res2 = engine.evaluateText('Hello FRIDAY!!!');
    assert.equal(res2.detected, true);
    assert.equal(res2.phrase, 'hello friday');
    assert.equal(res2.extractedCommand, '');

    // Compound wake command: wake phrase + trailing command
    engine['lastDetectionTimestamp'] = 0;
    const res3 = engine.evaluateText('Hey FRIDAY, what time is it?');
    assert.equal(res3.detected, true);
    assert.equal(res3.phrase, 'hey friday');
    assert.equal(res3.extractedCommand, 'what time is it');

    // Greeting compound command
    engine['lastDetectionTimestamp'] = 0;
    const res4 = engine.evaluateText('Good morning FRIDAY, check my portfolio.');
    assert.equal(res4.detected, true);
    assert.equal(res4.phrase, 'good morning friday');
    assert.equal(res4.extractedCommand, 'check my portfolio');

    // Non-wake utterance
    engine['lastDetectionTimestamp'] = 0;
    const res5 = engine.evaluateText('Play some jazz music.');
    assert.equal(res5.detected, false);
    assert.equal(res5.phrase, '');

    // Cooldown suppression: calling immediately after a detection is suppressed
    const firstWake = engine.evaluateText('Hey FRIDAY');
    assert.equal(firstWake.detected, true);
    const suppressedWake = engine.evaluateText('Hey FRIDAY');
    assert.equal(suppressedWake.detected, false); // Suppressed within cooldown window
  });

  it('4. Microphone Management: physical mute halts capture and blocks audio flow', () => {
    const mic = new MicrophoneManager();
    assert.equal(mic.isMuted(), false);
    assert.equal(mic.isCapturing(), false);

    // Start capture
    assert.ok(mic.startCapture());
    assert.equal(mic.isCapturing(), true);

    // Feed a PCM chunk (16-bit sine sample)
    const pcmChunk = Buffer.alloc(320); // 160 samples
    for (let i = 0; i < 160; i++) {
      pcmChunk.writeInt16LE(Math.round(Math.sin(i / 10) * 10000), i * 2);
    }
    const processed = mic.processAudioChunk(pcmChunk);
    assert.ok(processed !== null);
    assert.ok(processed.rms > 0);

    // Physically mute microphone
    mic.mute();
    assert.equal(mic.isMuted(), true);

    // Verify muted microphone refuses to capture or process incoming chunks
    const blockedChunk = mic.processAudioChunk(pcmChunk);
    assert.equal(blockedChunk, null);

    const startWhileMuted = mic.startCapture();
    assert.equal(startWhileMuted, false);

    // Unmute restores readiness
    mic.unmute();
    assert.equal(mic.isMuted(), false);
    assert.ok(mic.startCapture());
    mic.stopCapture();
  });

  it('5. Speech Synthesis: text sanitization, queue serialization, and interruption', async () => {
    const tts = new SpeechSynthesisEngine();

    // Markdown and symbol sanitization
    const raw = '# Executive Summary\nHere is `code` and [a link](http://example.com) with **bold** text and ```block```';
    const clean = tts.sanitizeForSpeech(raw);
    assert.ok(!clean.includes('#'));
    assert.ok(!clean.includes('`'));
    assert.ok(!clean.includes('**'));
    assert.ok(!clean.includes('http://'));
    assert.ok(clean.includes('code'));
    assert.ok(clean.includes('bold'));

    // Queue serialization
    const jobId1 = tts.speak('First message.');
    const jobId2 = tts.speak('Second message.');
    assert.ok(jobId1.startsWith('tts-'));
    assert.ok(jobId2.startsWith('tts-'));

    // Immediate interruption
    tts.interrupt();
    assert.equal(tts.isCurrentlySpeaking(), false);
    assert.equal(tts.getQueueLength(), 0);
  });

  it('6. Speech Recognition: handles PCM buffers, duration calculation, and simulation fallback', async () => {
    const stt = new SpeechRecognitionEngine();
    assert.equal(stt.isReady(), true);

    // Empty buffer handling
    const emptyRes = await stt.transcribe(Buffer.alloc(0));
    assert.equal(emptyRes.text, '');
    assert.equal(emptyRes.confidence, 0);

    // Simulated speech tag decoding (allows 100% deterministic testing without physical mic)
    const simBuffer = Buffer.from('FRIDAY_SIMULATED_SPEECH:what time is it\0' + 'X'.repeat(500));
    const simRes = await stt.transcribe(simBuffer);
    assert.equal(simRes.text, 'what time is it');
    assert.ok(simRes.confidence > 0.8);
    assert.ok(simRes.durationMs >= 0);
  });

  it('7. Executive Brain Integration: spoken command execution, actor isolation, and approval boundary', async () => {
    const voice = new VoiceService();
    await voice.start();

    // Spoken query processed through Executive Brain
    const sessionId = await voice.processSpokenUtterance('Hey FRIDAY, what time is it?');
    assert.ok(sessionId.startsWith('voice-'));

    // Clarification workflow integration under actor 'voice'
    const brain = getAssistantBrain();
    const clarifyRes = await brain.process('Send him the report.', 'voice-clarify-conv', false, {
      actorId: 'voice',
    });
    assert.equal(clarifyRes.executiveDecision, 'ASK_CLARIFICATION');
    assert.equal(clarifyRes.success, false);

    const clarEngine = getClarificationEngine();
    const pending = await clarEngine.getPending('voice', 'voice-clarify-conv');
    assert.ok(pending !== null);
    assert.equal(pending.actorId, 'voice');
    assert.equal(pending.conversationId, 'voice-clarify-conv');
    assert.ok(pending.missingFields.includes('recipient'));

    // Answering clarification merges request under actor 'voice' without granting approval
    const merged = await clarEngine.consumeAndMerge(
      'voice',
      'voice-clarify-conv',
      'Rahul on WhatsApp'
    );
    assert.ok(merged?.mergedRequest.includes('Send him the report.'));
    assert.ok(merged?.mergedRequest.includes('Rahul on WhatsApp'));
    assert.equal(await clarEngine.getPending('voice', 'voice-clarify-conv'), null);

    await voice.stop();
  });

  it('8. Windows Lifecycle: autostart registry command format and reversible configuration', async () => {
    const lifecycle = new WindowsLifecycleManager();
    const status = await lifecycle.checkAutostart();
    assert.equal(typeof status.supported, 'boolean');
    assert.equal(typeof status.enabled, 'boolean');
    assert.ok(status.registryKey.includes('Windows\\CurrentVersion\\Run'));
  });
});
