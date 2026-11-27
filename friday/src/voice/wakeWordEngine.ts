// ============================================================
// FRIDAY — Wake Word Engine
// Local, low-latency wake phrase and acoustic pattern matcher
// ============================================================

import { EventEmitter } from 'events';
import { createLayerLogger } from '../shared/logger';
import { getVoiceSettingsManager } from './voiceSettings';
import { voiceEvents } from './voiceEvents';

const log = createLayerLogger('WakeWord');

export interface WakeDetectionResult {
  detected: boolean;
  phrase: string;
  confidence: number;
  extractedCommand?: string;
}

export class WakeWordEngine extends EventEmitter {
  private enabled = true;
  private lastDetectionTimestamp = 0;
  private readonly cooldownMs = 2500; // Prevent duplicate rapid wake fires

  constructor() {
    super();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    log.info(`Wake-word detection ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Normalizes audio/transcript text by removing punctuation, extra spaces,
   * and standardizing common wake variations.
   */
  normalizeText(text: string): string {
    return text
      .toLowerCase()
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?'"“”—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Inspects a text utterance for configured wake phrases.
   * Separates the wake phrase from any compound command that followed.
   */
  evaluateText(rawText: string): WakeDetectionResult {
    if (!this.enabled) {
      return { detected: false, phrase: '', confidence: 0 };
    }

    const settings = getVoiceSettingsManager().getSettings();
    if (!settings.wakeWordEnabled) {
      return { detected: false, phrase: '', confidence: 0 };
    }

    const normalized = this.normalizeText(rawText);
    if (!normalized) {
      return { detected: false, phrase: '', confidence: 0 };
    }

    const now = Date.now();
    if (now - this.lastDetectionTimestamp < this.cooldownMs) {
      log.debug('Wake word detection in cooldown period');
      return { detected: false, phrase: '', confidence: 0 };
    }

    const wakePhrases = settings.wakePhrases;
    for (const phrase of wakePhrases) {
      const normPhrase = this.normalizeText(phrase);
      if (!normPhrase) continue;

      // Exact match or prefix match
      if (normalized === normPhrase) {
        this.lastDetectionTimestamp = now;
        const result: WakeDetectionResult = {
          detected: true,
          phrase: normPhrase,
          confidence: 0.95,
          extractedCommand: '',
        };
        this.emitDetection(result);
        return result;
      }

      if (normalized.startsWith(normPhrase + ' ')) {
        const command = normalized.slice(normPhrase.length).trim();
        this.lastDetectionTimestamp = now;
        const result: WakeDetectionResult = {
          detected: true,
          phrase: normPhrase,
          confidence: 0.95,
          extractedCommand: command,
        };
        this.emitDetection(result);
        return result;
      }
    }

    // Secondary check: common greeting patterns if enabled
    const greetingMatches = [
      'good morning friday',
      'good afternoon friday',
      'good evening friday',
      'friday wake up',
      'friday listen',
    ];

    for (const greeting of greetingMatches) {
      if (normalized === greeting || normalized.startsWith(greeting + ' ')) {
        const command = normalized.startsWith(greeting + ' ')
          ? normalized.slice(greeting.length).trim()
          : '';
        this.lastDetectionTimestamp = now;
        const result: WakeDetectionResult = {
          detected: true,
          phrase: greeting,
          confidence: 0.9,
          extractedCommand: command,
        };
        this.emitDetection(result);
        return result;
      }
    }

    return { detected: false, phrase: '', confidence: 0 };
  }

  private emitDetection(result: WakeDetectionResult): void {
    log.info(`Wake word detected: "${result.phrase}"`, {
      extractedCommand: result.extractedCommand,
      confidence: result.confidence,
    });

    voiceEvents.emitEvent('voice:wake_detected', {
      phrase: result.phrase,
      confidence: result.confidence,
      extractedCommand: result.extractedCommand,
      timestamp: Date.now(),
    });

    this.emit('wake', result);
  }
}

let _wakeWordEngine: WakeWordEngine | null = null;

export function getWakeWordEngine(): WakeWordEngine {
  if (!_wakeWordEngine) {
    _wakeWordEngine = new WakeWordEngine();
  }
  return _wakeWordEngine;
}
