// ============================================================
// FRIDAY — Microphone Manager
// Audio capture engine with single owner, hardware mute and VAD
// ============================================================

import { EventEmitter } from 'events';
import { createLayerLogger } from '../shared/logger';
import { getVoiceSettingsManager } from './voiceSettings';

const log = createLayerLogger('Microphone');

export interface AudioChunk {
  pcm: Buffer;
  rms: number;
  isSpeech: boolean;
  timestamp: number;
}

export interface VadState {
  isSpeaking: boolean;
  silenceDurationMs: number;
  speechDurationMs: number;
  lastSpeechTimestamp: number;
}

export class MicrophoneManager extends EventEmitter {
  private capturing = false;
  private muted = false;
  private vadState: VadState = {
    isSpeaking: false,
    silenceDurationMs: 0,
    speechDurationMs: 0,
    lastSpeechTimestamp: 0,
  };
  private audioBuffer: Buffer[] = [];
  private recordingStartTimestamp = 0;
  private captureInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
  }

  isCapturing(): boolean {
    return this.capturing;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /**
   * Hardware mute physically halts audio capture.
   * While muted, no audio buffers are collected or emitted.
   */
  mute(): void {
    if (this.muted) return;
    this.muted = true;
    log.info('Microphone muted — physical capture halted');
    this.clearCaptureBuffer();
    this.emit('muted', true);
  }

  unmute(): void {
    if (!this.muted) return;
    this.muted = false;
    log.info('Microphone unmuted — ready for capture');
    this.emit('muted', false);
  }

  /**
   * Start capturing audio for a speech turn or standby listening.
   */
  startCapture(): boolean {
    if (this.muted) {
      log.warn('Cannot start capture: microphone is MUTED');
      return false;
    }

    if (this.capturing) {
      log.debug('Microphone is already capturing');
      return true;
    }

    this.capturing = true;
    this.clearCaptureBuffer();
    this.recordingStartTimestamp = Date.now();
    this.vadState = {
      isSpeaking: false,
      silenceDurationMs: 0,
      speechDurationMs: 0,
      lastSpeechTimestamp: Date.now(),
    };

    log.info('Microphone capture started');
    this.emit('capture:start');
    return true;
  }

  stopCapture(): Buffer {
    if (!this.capturing) {
      return Buffer.concat(this.audioBuffer);
    }

    this.capturing = false;
    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }

    const completePcm = Buffer.concat(this.audioBuffer);
    log.info('Microphone capture stopped', {
      totalBytes: completePcm.length,
      durationMs: Date.now() - this.recordingStartTimestamp,
    });

    this.emit('capture:stop', completePcm);
    return completePcm;
  }

  clearCaptureBuffer(): void {
    this.audioBuffer = [];
  }

  getBufferedAudio(): Buffer {
    return Buffer.concat(this.audioBuffer);
  }

  /**
   * Process a chunk of 16-bit PCM mono audio (e.g. 16kHz).
   * Calculates RMS energy for Voice Activity Detection (VAD).
   */
  processAudioChunk(chunk: Buffer, sampleRate = 16000): AudioChunk | null {
    if (this.muted || !this.capturing) {
      return null;
    }

    const settings = getVoiceSettingsManager().getSettings();
    const rms = this.calculateRms(chunk);
    const isSpeech = rms >= settings.vadThreshold;
    const now = Date.now();

    if (isSpeech) {
      this.vadState.isSpeaking = true;
      this.vadState.speechDurationMs += (chunk.length / (sampleRate * 2)) * 1000;
      this.vadState.silenceDurationMs = 0;
      this.vadState.lastSpeechTimestamp = now;
    } else {
      if (this.vadState.isSpeaking) {
        this.vadState.silenceDurationMs = now - this.vadState.lastSpeechTimestamp;
      }
    }

    this.audioBuffer.push(chunk);

    const audioChunk: AudioChunk = {
      pcm: chunk,
      rms,
      isSpeech,
      timestamp: now,
    };

    this.emit('chunk', audioChunk);

    // Watchdog: Maximum recording duration check
    const totalDurationSec = (now - this.recordingStartTimestamp) / 1000;
    if (totalDurationSec >= settings.maxRecordingSeconds) {
      log.info('Microphone reached maximum recording duration limit', {
        seconds: totalDurationSec,
      });
      this.emit('max_duration_reached');
    }

    // Silence detection check after user has spoken
    if (
      this.vadState.isSpeaking &&
      this.vadState.silenceDurationMs >= settings.silenceTimeoutMs
    ) {
      log.info('Microphone detected end of utterance (silence)', {
        silenceDurationMs: this.vadState.silenceDurationMs,
      });
      this.emit('silence_detected');
    }

    return audioChunk;
  }

  /**
   * Compute Root-Mean-Square (RMS) amplitude for 16-bit PCM buffer.
   */
  calculateRms(buffer: Buffer): number {
    if (buffer.length < 2) return 0;
    let sumSquares = 0;
    const sampleCount = Math.floor(buffer.length / 2);

    for (let i = 0; i < sampleCount; i++) {
      const sample = buffer.readInt16LE(i * 2) / 32768.0;
      sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / sampleCount);
  }
}

let _microphoneManager: MicrophoneManager | null = null;

export function getMicrophoneManager(): MicrophoneManager {
  if (!_microphoneManager) {
    _microphoneManager = new MicrophoneManager();
  }
  return _microphoneManager;
}
