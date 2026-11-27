// ============================================================
// FRIDAY — Voice Health
// Health metrics, device diagnostics and availability checks
// ============================================================

import { VoiceState } from './voiceEvents';
import { getVoiceStateManager } from './voiceStateManager';
import { getVoiceSettingsManager } from './voiceSettings';

export interface MicrophoneHealth {
  available: boolean;
  muted: boolean;
  deviceName?: string;
  sampleRate: number;
  channels: number;
  hardwareAttached: boolean;
}

export interface WakeWordHealth {
  enabled: boolean;
  engine: string;
  activePhrases: string[];
  sensitivity: number;
  ready: boolean;
}

export interface SttHealth {
  engine: string;
  model: string;
  offline: boolean;
  ready: boolean;
  lastTranscriptDurationMs?: number;
}

export interface TtsHealth {
  engine: string;
  voice: string;
  offline: boolean;
  ready: boolean;
  speaking: boolean;
  queueLength: number;
}

export interface VoiceHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'disabled';
  state: VoiceState;
  microphone: MicrophoneHealth;
  wakeWord: WakeWordHealth;
  stt: SttHealth;
  tts: TtsHealth;
  autostartEnabled: boolean;
  lastActiveTimestamp: number;
  errorCount: number;
  lastError?: string;
}

export class VoiceHealthMonitor {
  private lastActiveTimestamp = Date.now();
  private errorCount = 0;
  private lastError?: string;

  recordActive(): void {
    this.lastActiveTimestamp = Date.now();
  }

  recordError(error: string): void {
    this.errorCount++;
    this.lastError = error;
    this.lastActiveTimestamp = Date.now();
  }

  clearError(): void {
    this.lastError = undefined;
  }

  getHealth(
    micHealth?: Partial<MicrophoneHealth>,
    sttHealth?: Partial<SttHealth>,
    ttsHealth?: Partial<TtsHealth>
  ): VoiceHealthStatus {
    const state = getVoiceStateManager().getState();
    const settings = getVoiceSettingsManager().getSettings();

    const mic: MicrophoneHealth = {
      available: micHealth?.available ?? (state !== 'DISABLED' && state !== 'MUTED'),
      muted: state === 'MUTED',
      deviceName: micHealth?.deviceName || 'Default System Microphone',
      sampleRate: micHealth?.sampleRate || 16000,
      channels: micHealth?.channels || 1,
      hardwareAttached: micHealth?.hardwareAttached ?? true,
    };

    const wake: WakeWordHealth = {
      enabled: settings.wakeWordEnabled,
      engine: 'friday-acoustic-phrase-matcher',
      activePhrases: settings.wakePhrases,
      sensitivity: settings.sensitivity,
      ready: settings.wakeWordEnabled && state !== 'DISABLED' && state !== 'MUTED' && state !== 'SLEEPING',
    };

    const stt: SttHealth = {
      engine: sttHealth?.engine || 'whisper-offline',
      model: sttHealth?.model || 'tiny.en',
      offline: true,
      ready: sttHealth?.ready ?? true,
      lastTranscriptDurationMs: sttHealth?.lastTranscriptDurationMs,
    };

    const tts: TtsHealth = {
      engine: ttsHealth?.engine || 'windows-sapi-local',
      voice: ttsHealth?.voice || settings.voiceName,
      offline: true,
      ready: ttsHealth?.ready ?? true,
      speaking: state === 'SPEAKING',
      queueLength: ttsHealth?.queueLength ?? 0,
    };

    let status: VoiceHealthStatus['status'] = 'healthy';
    if (!settings.enabled || state === 'DISABLED') {
      status = 'disabled';
    } else if (state === 'ERROR' || this.errorCount > 10) {
      status = 'unhealthy';
    } else if (state === 'MUTED' || state === 'SLEEPING' || !mic.available) {
      status = 'degraded';
    }

    return {
      status,
      state,
      microphone: mic,
      wakeWord: wake,
      stt,
      tts,
      autostartEnabled: settings.autostart,
      lastActiveTimestamp: this.lastActiveTimestamp,
      errorCount: this.errorCount,
      lastError: this.lastError,
    };
  }
}

let _voiceHealthMonitor: VoiceHealthMonitor | null = null;

export function getVoiceHealthMonitor(): VoiceHealthMonitor {
  if (!_voiceHealthMonitor) {
    _voiceHealthMonitor = new VoiceHealthMonitor();
  }
  return _voiceHealthMonitor;
}
