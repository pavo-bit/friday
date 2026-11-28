// ============================================================
// FRIDAY — Voice Session Manager
// Coordinates end-to-end conversational voice turns with Executive Brain
// Lifecycle: STANDBY -> WAKE_DETECTED -> GREETING -> LISTENING -> PROCESSING -> SPEAKING -> LISTENING / STANDBY
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { createLayerLogger } from '../shared/logger';
import { getVoiceStateManager } from './voiceStateManager';
import { getMicrophoneManager } from './microphoneManager';
import { getSpeechRecognitionEngine } from './speechRecognition';
import { getSpeechSynthesisEngine } from './speechSynthesis';
import { getGreetingService } from './greetingService';
import { classifyConversationIntent, ConversationIntentType } from './conversationIntent';
import { getAssistantBrain } from '../orchestration/assistantBrain';
import { voiceEvents } from './voiceEvents';
import { getVoiceSettingsManager } from './voiceSettings';

const log = createLayerLogger('VoiceSession');

export interface VoiceTurnResult {
  sessionId: string;
  intent: ConversationIntentType;
  reply: string;
  voiceSummary: string;
  isFarewell: boolean;
  shouldListen: boolean;
  state: string;
}

export class VoiceSessionManager {
  private activeSessionId: string | null = null;
  private sessionTimeoutTimer: NodeJS.Timeout | null = null;
  private sessionGreeted = false;

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  hasActiveSession(): boolean {
    return this.activeSessionId !== null;
  }

  /**
   * Aborts any active session timer and clears session state (used by mute/sleep/stop).
   * Does NOT trigger a farewell or restart the microphone.
   */
  abortSession(): void {
    this.clearSessionTimeout();
    this.activeSessionId = null;
    this.sessionGreeted = false;
  }

  /**
   * Initiates a new voice session following wake-word detection or manual trigger.
   */
  async startSession(extractedCommand?: string): Promise<string> {
    const stateManager = getVoiceStateManager();
    const currentState = stateManager.getState();

    // If a session is already active and we receive a new wake without command, avoid duplicate greeting
    if (this.activeSessionId && (!extractedCommand || !extractedCommand.trim())) {
      if (currentState === 'LISTENING' || currentState === 'GREETING' || currentState === 'SPEAKING') {
        log.debug(`Voice session ${this.activeSessionId} already active in state ${currentState}`);
        return this.activeSessionId;
      }
    }

    this.clearSessionTimeout();
    const sessionId = `voice-${uuidv4().slice(0, 8)}`;
    this.activeSessionId = sessionId;
    this.sessionGreeted = false;

    log.info(`Starting voice session: ${sessionId}`, { extractedCommand });

    stateManager.transitionTo('WAKE_DETECTED', 'Wake phrase detected');
    voiceEvents.emitEvent('voice:session_start', { sessionId, timestamp: Date.now() });

    if (extractedCommand && extractedCommand.trim().length > 0) {
      // Compound wake command: "Hey FRIDAY, what time is it?" or "Hey FRIDAY, that's all for now"
      log.info(`Processing inline wake command: "${extractedCommand}"`);
      await this.processCommand(extractedCommand, sessionId);
      return sessionId;
    }

    // Wake greeting turn (only once per new session)
    this.sessionGreeted = true;
    const greeting = getGreetingService().generateWakeGreeting();
    stateManager.transitionTo('GREETING', 'Greeting Boss');

    const tts = getSpeechSynthesisEngine();
    tts.speak(greeting, (interrupted) => {
      if (interrupted) {
        log.info('Greeting interrupted');
      }
      // Do not restart microphone if session was aborted/muted/put to sleep/stopped
      const latestState = stateManager.getState();
      if (
        this.activeSessionId !== sessionId ||
        latestState === 'MUTED' ||
        latestState === 'SLEEPING' ||
        latestState === 'STOPPING' ||
        latestState === 'DISABLED'
      ) {
        return;
      }
      this.beginListening(sessionId);
    });

    return sessionId;
  }

  /**
   * Enter LISTENING state for Boss's voice command.
   * Never speaks a greeting here (greetings only happen on new session activation).
   */
  beginListening(sessionId = this.activeSessionId || `voice-${uuidv4().slice(0, 8)}`): void {
    const stateManager = getVoiceStateManager();
    const mic = getMicrophoneManager();
    const settings = getVoiceSettingsManager().getSettings();
    const tts = getSpeechSynthesisEngine();

    // Prevent overlapping mic capture and TTS playback
    if (tts.isCurrentlySpeaking()) {
      tts.interrupt();
    }

    if (mic.isMuted() || stateManager.getState() === 'MUTED') {
      log.warn('Cannot listen: microphone is muted');
      if (stateManager.canTransitionTo('MUTED')) {
        stateManager.transitionTo('MUTED', 'Microphone muted');
      }
      return;
    }

    if (stateManager.getState() === 'SLEEPING' || stateManager.getState() === 'DISABLED') {
      log.warn(`Cannot listen while in state ${stateManager.getState()}`);
      return;
    }

    this.activeSessionId = sessionId;
    stateManager.transitionTo('LISTENING', 'Listening for command');
    mic.startCapture();

    const timeoutMs = settings.listenTimeoutSeconds * 1000;
    voiceEvents.emitEvent('voice:listening_start', { sessionId, timeoutMs });

    // Set listening timeout watchdog
    this.clearSessionTimeout();
    this.sessionTimeoutTimer = setTimeout(async () => {
      log.info(`Listening timeout reached for session ${sessionId}`);
      await this.finishListening(sessionId);
    }, timeoutMs);
  }

  /**
   * Finish audio capture and forward to speech recognition and Executive Brain.
   */
  async finishListening(sessionId = this.activeSessionId || 'default'): Promise<void> {
    this.clearSessionTimeout();
    const mic = getMicrophoneManager();
    const pcm = mic.stopCapture();

    const stateManager = getVoiceStateManager();
    if (stateManager.getState() !== 'LISTENING') {
      return;
    }

    stateManager.transitionTo('PROCESSING', 'Transcribing and processing input');

    const stt = getSpeechRecognitionEngine();
    const result = await stt.transcribe(pcm, sessionId);

    if (!result.text || result.text.trim().length === 0) {
      // Listening timeout without speech -> return to STANDBY silently (no false farewell)
      log.info('No speech detected during listening window — returning to STANDBY');
      stateManager.transitionTo('STANDBY', 'Listening timeout without speech');
      this.activeSessionId = null;
      this.sessionGreeted = false;
      return;
    }

    await this.processCommand(result.text, sessionId);
  }

  /**
   * Evaluates a voice turn via centralized conversation intent detection and Assistant Brain.
   * Returns structured VoiceTurnResult for both local TTS and remote/UI voice clients.
   */
  async evaluateVoiceTurn(
    commandText: string,
    sessionId: string,
    timezoneOverride?: string
  ): Promise<VoiceTurnResult> {
    const inSession = this.activeSessionId === sessionId || this.sessionGreeted;
    const classified = classifyConversationIntent(commandText, inSession);

    // 1. Explicit conversation-ending intent -> time-aware farewell, do NOT execute commands
    if (classified.intent === 'GOODBYE' || classified.intent === 'GOOD_NIGHT') {
      const farewell = getGreetingService().generateFarewell(new Date(), {
        explicitGoodNight: classified.intent === 'GOOD_NIGHT' || classified.explicitGoodNight,
        timezone: timezoneOverride,
      });
      return {
        sessionId,
        intent: classified.intent,
        reply: farewell,
        voiceSummary: farewell,
        isFarewell: true,
        shouldListen: false,
        state: 'SPEAKING',
      };
    }

    // 2. Explicit SLEEP
    if (classified.intent === 'SLEEP') {
      return {
        sessionId,
        intent: 'SLEEP',
        reply: 'Entering sleep mode, Boss.',
        voiceSummary: 'Entering sleep mode, Boss.',
        isFarewell: false,
        shouldListen: false,
        state: 'SLEEPING',
      };
    }

    // 3. Explicit CANCEL ("cancel that command") -> acknowledge and keep listening
    if (classified.intent === 'CANCEL') {
      const cancelReply = 'Understood, Boss. Cancelled.';
      return {
        sessionId,
        intent: 'CANCEL',
        reply: cancelReply,
        voiceSummary: cancelReply,
        isFarewell: false,
        shouldListen: true,
        state: 'SPEAKING',
      };
    }

    // 4. Pure mid-session GREETING (do not repeat full wake greeting)
    if (classified.intent === 'GREETING' && inSession) {
      const reply = 'Yes, Boss. How may I assist?';
      return {
        sessionId,
        intent: 'GREETING',
        reply,
        voiceSummary: reply,
        isFarewell: false,
        shouldListen: true,
        state: 'SPEAKING',
      };
    }

    // 5. Normal command, follow-up, or greeting+command
    const effectiveCommand = classified.extractedCommand || commandText;
    const brain = getAssistantBrain();
    const brainResponse = await brain.process(
      effectiveCommand,
      sessionId,
      false, // Voice alone never grants automatic high-risk approval
      { actorId: 'voice', channel: 'voice' }
    );

    if (brainResponse.executiveDecision === 'ASK_CLARIFICATION' || brainResponse.clarificationNeeded) {
      const question = brainResponse.output || 'I need one clarification before proceeding, Boss.';
      return {
        sessionId,
        intent: classified.intent,
        reply: question,
        voiceSummary: question,
        isFarewell: false,
        shouldListen: true,
        state: 'SPEAKING',
      };
    }

    if (brainResponse.executiveDecision === 'REQUEST_APPROVAL') {
      const approvalNotice =
        brainResponse.output || 'That action requires high-risk confirmation in your dashboard, Boss.';
      return {
        sessionId,
        intent: classified.intent,
        reply: approvalNotice,
        voiceSummary: approvalNotice,
        isFarewell: false,
        shouldListen: true,
        state: 'SPEAKING',
      };
    }

    const rawOutput = brainResponse.output || 'Done, Boss.';
    const voiceSummary = brainResponse.personalityMeta?.voiceSummary || rawOutput;

    return {
      sessionId,
      intent: classified.intent,
      reply: rawOutput,
      voiceSummary,
      isFarewell: false,
      shouldListen: true,
      state: 'SPEAKING',
    };
  }

  /**
   * Passes transcribed command to centralized intent classifier + Executive Brain and speaks result.
   */
  async processCommand(commandText: string, sessionId: string): Promise<VoiceTurnResult> {
    const stateManager = getVoiceStateManager();
    if (stateManager.getState() !== 'PROCESSING') {
      stateManager.transitionTo('PROCESSING', 'Executive Brain processing');
    }
    voiceEvents.emitEvent('voice:processing', { sessionId, text: commandText });

    try {
      const turn = await this.evaluateVoiceTurn(commandText, sessionId);

      if (turn.intent === 'SLEEP') {
        this.abortSession();
        if (stateManager.canTransitionTo('SLEEPING')) {
          stateManager.transitionTo('SLEEPING', 'Boss requested sleep mode');
        }
        return { ...turn, state: stateManager.getState() };
      }

      if (turn.isFarewell) {
        this.speakAndReturnToStandby(turn.voiceSummary);
        return { ...turn, state: stateManager.getState() };
      }

      if (turn.shouldListen) {
        this.speakAndResumeListening(turn.voiceSummary, sessionId);
      } else {
        this.speakAndReturnToStandby(turn.voiceSummary);
      }

      return { ...turn, state: stateManager.getState() };
    } catch (err) {
      log.error('Executive Brain failed on voice command', { error: (err as Error).message });
      const fallback = "I'm unable to complete that operation at the moment, Boss.";
      this.speakAndResumeListening(fallback, sessionId);
      return {
        sessionId,
        intent: 'NORMAL_COMMAND',
        reply: fallback,
        voiceSummary: fallback,
        isFarewell: false,
        shouldListen: true,
        state: stateManager.getState(),
      };
    }
  }

  private speakAndResumeListening(text: string, sessionId: string): void {
    const stateManager = getVoiceStateManager();
    stateManager.transitionTo('SPEAKING', 'Speaking response');
    const tts = getSpeechSynthesisEngine();

    tts.speak(text, (interrupted) => {
      const current = stateManager.getState();
      if (
        interrupted ||
        this.activeSessionId !== sessionId ||
        current === 'MUTED' ||
        current === 'SLEEPING' ||
        current === 'STOPPING' ||
        current === 'DISABLED'
      ) {
        return;
      }
      // Resume listening for natural multi-turn follow-up commands
      this.beginListening(sessionId);
    });
  }

  private speakAndReturnToStandby(text: string): void {
    const stateManager = getVoiceStateManager();
    stateManager.transitionTo('SPEAKING', 'Speaking response');
    const tts = getSpeechSynthesisEngine();

    tts.speak(text, () => {
      const current = stateManager.getState();
      if (current === 'SPEAKING') {
        stateManager.transitionTo('STANDBY', 'Conversation ended — returning to standby');
      }
      this.activeSessionId = null;
      this.sessionGreeted = false;
    });
  }

  private clearSessionTimeout(): void {
    if (this.sessionTimeoutTimer) {
      clearTimeout(this.sessionTimeoutTimer);
      this.sessionTimeoutTimer = null;
    }
  }
}

let _voiceSessionManager: VoiceSessionManager | null = null;

export function getVoiceSessionManager(): VoiceSessionManager {
  if (!_voiceSessionManager) {
    _voiceSessionManager = new VoiceSessionManager();
  }
  return _voiceSessionManager;
}
