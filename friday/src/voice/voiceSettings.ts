// ============================================================
// FRIDAY — Voice Settings
// Configurable and validated voice runtime configuration
// ============================================================

import { getConfig } from '../shared/config';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('VoiceSettings');

export interface VoiceSettings {
  enabled: boolean;
  autostart: boolean;
  wakeWordEnabled: boolean;
  wakePhrases: string[];
  timezone: string;
  language: string;
  listenTimeoutSeconds: number;
  maxRecordingSeconds: number;
  ttsEnabled: boolean;
  localOnly: boolean;
  sensitivity: number;
  speechRate: number;
  speechPitch: number;
  voiceName: string;
  vadThreshold: number;
  silenceTimeoutMs: number;
}

export function isValidIanaTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function getDefaultVoiceSettings(): VoiceSettings {
  const envPhrases = process.env.FRIDAY_VOICE_WAKE_PHRASES
    ? process.env.FRIDAY_VOICE_WAKE_PHRASES.split(',').map((p) => p.trim().toLowerCase().replace(/_/g, ' ')).filter(Boolean)
    : ['hey friday', 'hello friday', 'wake up friday'];

  let systemTz = 'Asia/Kolkata';
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved && isValidIanaTimezone(resolved)) {
      systemTz = resolved;
    }
  } catch {
    // Fallback to Asia/Kolkata
  }

  const tz = process.env.FRIDAY_VOICE_TIMEZONE || systemTz;
  const validTz = isValidIanaTimezone(tz) ? tz : systemTz;

  return {
    enabled: process.env.FRIDAY_VOICE_ENABLED !== 'false',
    autostart: process.env.FRIDAY_VOICE_AUTOSTART === 'true',
    wakeWordEnabled: process.env.FRIDAY_VOICE_WAKE_WORD_ENABLED !== 'false',
    wakePhrases: envPhrases.length > 0 ? envPhrases : ['hey friday', 'hello friday', 'wake up friday'],
    timezone: validTz,
    language: process.env.FRIDAY_VOICE_DEFAULT_LANGUAGE || 'en',
    listenTimeoutSeconds: Math.max(3, Math.min(60, parseInt(process.env.FRIDAY_VOICE_LISTEN_TIMEOUT_SECONDS || '12', 10))),
    maxRecordingSeconds: Math.max(5, Math.min(120, parseInt(process.env.FRIDAY_VOICE_MAX_RECORDING_SECONDS || '30', 10))),
    ttsEnabled: process.env.FRIDAY_VOICE_TTS_ENABLED !== 'false',
    localOnly: process.env.FRIDAY_VOICE_LOCAL_ONLY !== 'false',
    sensitivity: 0.6,
    speechRate: 1.0,
    speechPitch: 1.0,
    voiceName: 'en-US-JennyNeural',
    vadThreshold: 0.015,
    silenceTimeoutMs: 2200,
  };
}

export class VoiceSettingsManager {
  private settings: VoiceSettings;

  constructor() {
    this.settings = getDefaultVoiceSettings();
  }

  getSettings(): VoiceSettings {
    return { ...this.settings, wakePhrases: [...this.settings.wakePhrases] };
  }

  updateSettings(partial: Partial<VoiceSettings>): VoiceSettings {
    if (partial.timezone !== undefined) {
      if (!isValidIanaTimezone(partial.timezone)) {
        throw new Error(`Invalid IANA timezone: ${partial.timezone}`);
      }
    }

    if (partial.sensitivity !== undefined) {
      if (partial.sensitivity < 0 || partial.sensitivity > 1) {
        throw new Error('Sensitivity must be between 0.0 and 1.0');
      }
    }

    if (partial.listenTimeoutSeconds !== undefined) {
      if (partial.listenTimeoutSeconds < 1 || partial.listenTimeoutSeconds > 120) {
        throw new Error('listenTimeoutSeconds must be between 1 and 120');
      }
    }

    if (partial.maxRecordingSeconds !== undefined) {
      if (partial.maxRecordingSeconds < 3 || partial.maxRecordingSeconds > 300) {
        throw new Error('maxRecordingSeconds must be between 3 and 300');
      }
    }

    if (partial.speechRate !== undefined) {
      if (partial.speechRate < 0.5 || partial.speechRate > 2.0) {
        throw new Error('speechRate must be between 0.5 and 2.0');
      }
    }

    if (partial.speechPitch !== undefined) {
      if (partial.speechPitch < 0.5 || partial.speechPitch > 1.5) {
        throw new Error('speechPitch must be between 0.5 and 1.5');
      }
    }

    if (partial.wakePhrases !== undefined) {
      const normalized = partial.wakePhrases
        .map((p) => p.trim().toLowerCase().replace(/_/g, ' '))
        .filter(Boolean);
      if (normalized.length === 0) {
        throw new Error('At least one wake phrase is required');
      }
      partial.wakePhrases = normalized;
    }

    this.settings = {
      ...this.settings,
      ...partial,
    };

    log.info('Voice settings updated', {
      enabled: this.settings.enabled,
      wakeWordEnabled: this.settings.wakeWordEnabled,
      timezone: this.settings.timezone,
      wakePhrases: this.settings.wakePhrases,
    });

    return this.getSettings();
  }
}

let _voiceSettingsManager: VoiceSettingsManager | null = null;

export function getVoiceSettingsManager(): VoiceSettingsManager {
  if (!_voiceSettingsManager) {
    _voiceSettingsManager = new VoiceSettingsManager();
  }
  return _voiceSettingsManager;
}
