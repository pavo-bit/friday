// ============================================================
// FRIDAY — Voice Service
// Central coordinator for Windows voice activation and interaction
// ============================================================

import { createLayerLogger } from '../shared/logger';
import { VoiceState, voiceEvents } from './voiceEvents';
import { getVoiceStateManager, VoiceStateManager } from './voiceStateManager';
import { getVoiceSettingsManager, VoiceSettings, VoiceSettingsManager } from './voiceSettings';
import { getVoiceHealthMonitor, VoiceHealthMonitor, VoiceHealthStatus } from './voiceHealth';
import { getMicrophoneManager, MicrophoneManager } from './microphoneManager';
import { getWakeWordEngine, WakeWordEngine } from './wakeWordEngine';
import { getSpeechRecognitionEngine, SpeechRecognitionEngine } from './speechRecognition';
import { getSpeechSynthesisEngine, SpeechSynthesisEngine } from './speechSynthesis';
import { getVoiceSessionManager, VoiceSessionManager } from './voiceSessionManager';
import { getGreetingService, GreetingService } from './greetingService';
import { getWindowsLifecycleManager, WindowsLifecycleManager } from './windowsLifecycle';

const log = createLayerLogger('VoiceService');

export class VoiceService {
  private stateManager: VoiceStateManager;
  private settingsManager: VoiceSettingsManager;
  private healthMonitor: VoiceHealthMonitor;
  private micManager: MicrophoneManager;
  private wakeEngine: WakeWordEngine;
  private sttEngine: SpeechRecognitionEngine;
  private ttsEngine: SpeechSynthesisEngine;
  private sessionManager: VoiceSessionManager;
  private greetingService: GreetingService;
  private windowsLifecycle: WindowsLifecycleManager;
  private isInitialized = false;

  constructor() {
    this.stateManager = getVoiceStateManager();
    this.settingsManager = getVoiceSettingsManager();
    this.healthMonitor = getVoiceHealthMonitor();
    this.micManager = getMicrophoneManager();
    this.wakeEngine = getWakeWordEngine();
    this.sttEngine = getSpeechRecognitionEngine();
    this.ttsEngine = getSpeechSynthesisEngine();
    this.sessionManager = getVoiceSessionManager();
    this.greetingService = getGreetingService();
    this.windowsLifecycle = getWindowsLifecycleManager();
  }

  getState(): VoiceState {
    return this.stateManager.getState();
  }

  getSettings(): VoiceSettings {
    return this.settingsManager.getSettings();
  }

  updateSettings(partial: Partial<VoiceSettings>): VoiceSettings {
    const updated = this.settingsManager.updateSettings(partial);
    if (partial.wakeWordEnabled !== undefined) {
      this.wakeEngine.setEnabled(partial.wakeWordEnabled);
    }
    return updated;
  }

  getHealth(): VoiceHealthStatus {
    return this.healthMonitor.getHealth(
      {
        available: !this.micManager.isMuted() && this.getState() !== 'DISABLED',
        muted: this.micManager.isMuted(),
      },
      {
        engine: this.sttEngine.getModelName(),
        ready: this.sttEngine.isReady(),
      },
      {
        speaking: this.ttsEngine.isCurrentlySpeaking(),
        queueLength: this.ttsEngine.getQueueLength(),
      }
    );
  }

  /**
   * Initializes and starts the voice service into STANDBY mode.
   */
  async start(): Promise<boolean> {
    const settings = this.getSettings();
    if (!settings.enabled) {
      log.info('Voice service is disabled via configuration');
      return false;
    }

    if (this.getState() !== 'DISABLED' && this.getState() !== 'ERROR') {
      log.debug('Voice service is already running or starting');
      return true;
    }

    try {
      this.stateManager.transitionTo('STARTING', 'Booting voice service');
      this.setupEventListeners();

      this.wakeEngine.setEnabled(settings.wakeWordEnabled);

      this.stateManager.transitionTo('STANDBY', 'Voice service ready in standby');
      this.isInitialized = true;
      log.info('FRIDAY Voice Service online in STANDBY mode', {
        timezone: settings.timezone,
        wakePhrases: settings.wakePhrases,
        autostart: settings.autostart,
      });

      return true;
    } catch (err) {
      const errorMsg = (err as Error).message;
      log.error('Failed to start voice service', { error: errorMsg });
      this.healthMonitor.recordError(errorMsg);
      if (this.stateManager.canTransitionTo('ERROR')) {
        this.stateManager.transitionTo('ERROR', errorMsg);
      }
      return false;
    }
  }

  /**
   * Graceful shutdown of the voice service.
   */
  async stop(): Promise<void> {
    const current = this.getState();
    if (current === 'DISABLED') return;

    log.info('Stopping FRIDAY Voice Service...');
    try {
      this.sessionManager.abortSession();
      if (this.stateManager.canTransitionTo('STOPPING')) {
        this.stateManager.transitionTo('STOPPING', 'User requested shutdown');
      }

      this.ttsEngine.interrupt();
      this.micManager.stopCapture();
      this.stateManager.transitionTo('DISABLED', 'Service stopped');
      log.info('FRIDAY Voice Service disabled');
    } catch (err) {
      log.warn('Error during voice service shutdown', { error: (err as Error).message });
      this.stateManager.reset('DISABLED');
    }
  }

  /**
   * Mute microphone capture physically.
   */
  mute(): boolean {
    this.sessionManager.abortSession();
    this.micManager.mute();
    this.ttsEngine.interrupt();
    if (this.stateManager.canTransitionTo('MUTED')) {
      this.stateManager.transitionTo('MUTED', 'User muted microphone');
    }
    return true;
  }

  /**
   * Unmute microphone capture.
   */
  unmute(): boolean {
    this.micManager.unmute();
    if (this.getState() === 'MUTED') {
      this.stateManager.transitionTo('STANDBY', 'User unmuted microphone');
    }
    return true;
  }

  /**
   * Put voice service into sleeping state (wake listening paused).
   */
  sleep(): boolean {
    this.sessionManager.abortSession();
    this.ttsEngine.interrupt();
    this.micManager.stopCapture();
    if (this.stateManager.canTransitionTo('SLEEPING')) {
      this.stateManager.transitionTo('SLEEPING', 'User put voice to sleep');
      return true;
    }
    return false;
  }

  /**
   * Wake voice service from sleeping state.
   */
  wake(): boolean {
    if (this.getState() === 'SLEEPING') {
      this.stateManager.transitionTo('STANDBY', 'User woke voice service');
      return true;
    }
    return false;
  }

  /**
   * Process a spoken utterance or simulated voice command directly.
   * Useful for testing and direct voice turns.
   */
  async processSpokenUtterance(rawUtterance: string): Promise<string> {
    const detection = this.wakeEngine.evaluateText(rawUtterance);
    if (detection.detected) {
      const sessionId = await this.sessionManager.startSession(detection.extractedCommand);
      return sessionId;
    }

    // Direct command execution turn if service is active and not sleeping/muted
    const state = this.getState();
    if (state === 'MUTED' || state === 'SLEEPING' || state === 'DISABLED') {
      throw new Error(`Cannot process utterance while in state ${state}`);
    }

    const sessionId = `voice-${Date.now()}`;
    await this.sessionManager.processCommand(rawUtterance, sessionId);
    return sessionId;
  }

  private setupEventListeners(): void {
    if (this.isInitialized) return;

    this.micManager.on('silence_detected', async () => {
      if (this.getState() === 'LISTENING') {
        log.info('Microphone detected silence — finalizing turn');
        await this.sessionManager.finishListening();
      }
    });

    this.micManager.on('max_duration_reached', async () => {
      if (this.getState() === 'LISTENING') {
        log.info('Microphone reached maximum duration — finalizing turn');
        await this.sessionManager.finishListening();
      }
    });
  }
}

let _voiceService: VoiceService | null = null;

export function getVoiceService(): VoiceService {
  if (!_voiceService) {
    _voiceService = new VoiceService();
  }
  return _voiceService;
}
