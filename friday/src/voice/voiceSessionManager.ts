// ============================================================
// FRIDAY — Voice Session Manager
// Coordinates end-to-end conversational voice turns with Executive Brain
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { createLayerLogger } from '../shared/logger';
import { getVoiceStateManager } from './voiceStateManager';
import { getMicrophoneManager } from './microphoneManager';
import { getSpeechRecognitionEngine } from './speechRecognition';
import { getSpeechSynthesisEngine } from './speechSynthesis';
import { getGreetingService } from './greetingService';
import { getAssistantBrain } from '../orchestration/assistantBrain';
import { voiceEvents } from './voiceEvents';
import { getVoiceSettingsManager } from './voiceSettings';

const log = createLayerLogger('VoiceSession');

export class VoiceSessionManager {
  private activeSessionId: string | null = null;
  private sessionTimeoutTimer: NodeJS.Timeout | null = null;

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  /**
   * Initiates a new voice session following wake-word detection or manual trigger.
   */
  async startSession(extractedCommand?: string): Promise<string> {
    const stateManager = getVoiceStateManager();
    const sessionId = `voice-${uuidv4().slice(0, 8)}`;
    this.activeSessionId = sessionId;

    log.info(`Starting voice session: ${sessionId}`, { extractedCommand });

    stateManager.transitionTo('WAKE_DETECTED', 'Wake phrase detected');
    voiceEvents.emitEvent('voice:session_start', { sessionId, timestamp: Date.now() });

    if (extractedCommand && extractedCommand.trim().length > 0) {
      // Compound wake command: "Hey FRIDAY, what time is it?"
      // Skip greeting turn and process immediately
      log.info(`Processing inline wake command: "${extractedCommand}"`);
      await this.processCommand(extractedCommand, sessionId);
      return sessionId;
    }

    // Wake greeting turn
    const greeting = getGreetingService().generateWakeGreeting();
    stateManager.transitionTo('SPEAKING', 'Greeting user');

    const tts = getSpeechSynthesisEngine();
    tts.speak(greeting, (interrupted) => {
      if (interrupted) {
        log.info('Greeting interrupted by user');
      }
      this.beginListening(sessionId);
    });

    return sessionId;
  }

  /**
   * Enter LISTENING state for user's voice command.
   */
  beginListening(sessionId = this.activeSessionId || `voice-${uuidv4().slice(0, 8)}`): void {
    const stateManager = getVoiceStateManager();
    const mic = getMicrophoneManager();
    const settings = getVoiceSettingsManager().getSettings();

    if (mic.isMuted()) {
      log.warn('Cannot listen: microphone is muted');
      stateManager.transitionTo('MUTED', 'Microphone muted');
      return;
    }

    stateManager.transitionTo('LISTENING', 'Listening for user command');
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
      log.info('No speech detected during listening window');
      stateManager.transitionTo('STANDBY', 'No speech detected');
      this.activeSessionId = null;
      return;
    }

    await this.processCommand(result.text, sessionId);
  }

  /**
   * Passes transcribed command to Executive Brain and speaks result.
   */
  async processCommand(commandText: string, sessionId: string): Promise<void> {
    const stateManager = getVoiceStateManager();
    stateManager.transitionTo('PROCESSING', 'Executive Brain processing');
    voiceEvents.emitEvent('voice:processing', { sessionId, text: commandText });

    try {
      const brain = getAssistantBrain();
      const brainResponse = await brain.process(
        commandText,
        sessionId,
        false, // Voice alone does not grant automatic high-risk approval
        { actorId: 'voice', channel: 'voice' }
      );

      // Check for persistent clarification requirement
      if (brainResponse.executiveDecision === 'ASK_CLARIFICATION' || brainResponse.clarificationNeeded) {
        log.info('Assistant requires clarification for spoken command');
        const question = brainResponse.output || 'Could you please clarify that, Boss?';
        this.speakAndResumeListening(question, sessionId);
        return;
      }

      // Check for pending approval
      if (brainResponse.executiveDecision === 'REQUEST_APPROVAL') {
        const approvalNotice = brainResponse.output || 'That action requires high-risk confirmation in your dashboard, Boss.';
        this.speakAndReturnToStandby(approvalNotice);
        return;
      }

      const responseText =
        brainResponse.personalityMeta?.voiceSummary ||
        brainResponse.output ||
        "I've completed your request, Boss.";
      this.speakAndReturnToStandby(responseText);
    } catch (err) {
      log.error('Executive Brain failed on voice command', { error: (err as Error).message });
      this.speakAndReturnToStandby("I encountered an issue processing that request, Boss.");
    }
  }

  private speakAndResumeListening(text: string, sessionId: string): void {
    const stateManager = getVoiceStateManager();
    stateManager.transitionTo('SPEAKING', 'Asking clarification');
    const tts = getSpeechSynthesisEngine();

    tts.speak(text, () => {
      // Re-enter listening for the user's clarification answer
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
        stateManager.transitionTo('STANDBY', 'Finished speaking');
      }
      this.activeSessionId = null;
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
