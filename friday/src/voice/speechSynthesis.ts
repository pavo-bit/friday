// ============================================================
// FRIDAY — Speech Synthesis (TTS)
// Local text-to-speech with serialized queue and immediate interruption
// ============================================================

import { EventEmitter } from 'events';
import { ChildProcess, execFile } from 'child_process';
import { createLayerLogger } from '../shared/logger';
import { getVoiceSettingsManager } from './voiceSettings';
import { voiceEvents } from './voiceEvents';

const log = createLayerLogger('TTS');

export interface SpeechJob {
  id: string;
  text: string;
  sanitizedText: string;
  onComplete?: (interrupted: boolean) => void;
}

export class SpeechSynthesisEngine extends EventEmitter {
  private queue: SpeechJob[] = [];
  private currentJob: SpeechJob | null = null;
  private currentProcess: ChildProcess | null = null;
  private isSpeaking = false;

  constructor() {
    super();
  }

  isCurrentlySpeaking(): boolean {
    return this.isSpeaking;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Enqueue a text string to be spoken locally.
   * Execution is strictly serialized to prevent overlapping speech.
   */
  speak(text: string, onComplete?: (interrupted: boolean) => void): string {
    const sanitized = this.sanitizeForSpeech(text);
    if (!sanitized) {
      if (onComplete) onComplete(false);
      return '';
    }

    const id = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const job: SpeechJob = {
      id,
      text,
      sanitizedText: sanitized,
      onComplete,
    };

    this.queue.push(job);
    log.info(`Enqueued speech job (${sanitized.length} chars): "${sanitized.slice(0, 40)}..."`);
    this.processQueue();
    return id;
  }

  /**
   * Interrupt and stop any ongoing speech and flush the pending queue.
   */
  interrupt(): void {
    if (!this.isSpeaking && this.queue.length === 0) return;

    log.info('Interrupting speech synthesis — draining queue');
    if (this.currentProcess) {
      try {
        this.currentProcess.kill('SIGKILL');
      } catch {
        // Ignore
      }
      this.currentProcess = null;
    }

    if (this.currentJob && this.currentJob.onComplete) {
      this.currentJob.onComplete(true);
    }

    // Drain remaining jobs and notify them as interrupted
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      if (job && job.onComplete) {
        job.onComplete(true);
      }
    }

    const wasSpeaking = this.isSpeaking;
    this.isSpeaking = false;
    this.currentJob = null;

    if (wasSpeaking) {
      voiceEvents.emitEvent('voice:speaking_end', {
        text: '',
        interrupted: true,
      });
      this.emit('interrupted');
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isSpeaking || this.queue.length === 0) {
      return;
    }

    const job = this.queue.shift();
    if (!job) return;

    this.currentJob = job;
    this.isSpeaking = true;

    voiceEvents.emitEvent('voice:speaking_start', {
      text: job.sanitizedText,
    });
    this.emit('start', job);

    let interrupted = false;
    try {
      await this.synthesizeLocal(job.sanitizedText);
    } catch (err) {
      log.warn('TTS playback completed or halted', { error: (err as Error).message });
    } finally {
      this.isSpeaking = false;
      this.currentProcess = null;
      const completedJob = this.currentJob;
      this.currentJob = null;

      voiceEvents.emitEvent('voice:speaking_end', {
        text: job.sanitizedText,
        interrupted,
      });
      this.emit('end', { job: completedJob, interrupted });

      if (completedJob && completedJob.onComplete) {
        completedJob.onComplete(interrupted);
      }

      // Next in queue
      if (this.queue.length > 0) {
        setImmediate(() => this.processQueue());
      }
    }
  }

  /**
   * Synthesizes and plays audio using Windows native SAPI or fallback.
   */
  private synthesizeLocal(text: string): Promise<void> {
    return new Promise((resolve) => {
      const settings = getVoiceSettingsManager().getSettings();
      if (!settings.ttsEnabled) {
        resolve();
        return;
      }

      // Clean string for PowerShell command
      const escapedText = text.replace(/["'`$\\]/g, ' ');
      const psCommand = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; try { $s.Speak('${escapedText}') } catch {}`;

      const proc = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psCommand],
        { timeout: 30000 },
        () => {
          this.currentProcess = null;
          resolve();
        }
      );

      this.currentProcess = proc;
    });
  }

  /**
   * Sanitizes markdown, code snippets, symbols, and links for natural human speech.
   */
  sanitizeForSpeech(text: string): string {
    if (!text) return '';
    return text
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, ' code block omitted ')
      // Remove inline code
      .replace(/`([^`]+)`/g, '$1')
      // Remove URLs
      .replace(/https?:\/\/[^\s]+/g, 'link')
      // Remove markdown links [text](url) -> text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove markdown headings
      .replace(/^#{1,6}\s+/gm, '')
      // Remove bullet points / numbering
      .replace(/^[\*\-+]\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      // Remove bold and italic markers
      .replace(/[\*_]{1,3}([^*_]+)[\*_]{1,3}/g, '$1')
      // Remove HTML tags
      .replace(/<[^>]+>/g, '')
      // Remove excessive special characters
      .replace(/[~^_|\\{}[\]]/g, ' ')
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }
}

let _speechSynthesisEngine: SpeechSynthesisEngine | null = null;

export function getSpeechSynthesisEngine(): SpeechSynthesisEngine {
  if (!_speechSynthesisEngine) {
    _speechSynthesisEngine = new SpeechSynthesisEngine();
  }
  return _speechSynthesisEngine;
}
