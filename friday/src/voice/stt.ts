// ============================================================
// FRIDAY — Voice Layer: Speech-to-Text
// Supports OpenAI Whisper API and local Whisper fallback
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLayerLogger } from '../shared/logger';
import { getConfig } from '../shared/config';
import { eventBus } from '../shared/events';

const log = createLayerLogger('STT');

/**
 * SpeechToText — converts audio data to text transcriptions.
 *
 * Supports:
 * - OpenAI Whisper API (cloud, high accuracy)
 * - Local whisper.cpp (future, for offline/privacy)
 * - Disabled mode (text-only interaction)
 */
export class SpeechToText {
  private engine: string;

  constructor() {
    this.engine = getConfig().sttEngine;
    log.info(`STT engine: ${this.engine}`);
  }

  /**
   * Transcribe audio data (WAV/WebM buffer) to text.
   */
  async transcribe(audioBuffer: Buffer, format = 'webm'): Promise<string> {
    if (this.engine === 'none') {
      log.warn('STT is disabled — cannot transcribe audio');
      return '';
    }

    try {
      if (this.engine === 'whisper_api') {
        return await this.transcribeWhisperApi(audioBuffer, format);
      }

      log.warn(`Unknown STT engine: ${this.engine}`);
      return '';
    } catch (error) {
      log.error('Transcription failed', { error: (error as Error).message });
      eventBus.emitEvent('voice:error', error as Error);
      return '';
    }
  }

  /**
   * Transcribe using OpenAI Whisper API.
   */
  private async transcribeWhisperApi(audioBuffer: Buffer, format: string): Promise<string> {
    const config = getConfig();
    if (!config.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is required for Whisper API');
    }

    // Dynamic import for node-fetch (CommonJS compat)
    const fetch = (await import('node-fetch')).default;
    const FormData = (await import('node-fetch')).default;

    // Create a temporary file for the audio (Whisper API requires file upload)
    const tempDir = path.resolve(__dirname, '..', '..', 'data', 'recordings');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempFile = path.join(tempDir, `stt_${Date.now()}.${format}`);
    fs.writeFileSync(tempFile, audioBuffer);

    try {
      // Build multipart form data manually for node-fetch
      const boundary = '----FridaySTTBoundary' + Date.now();
      const fileContent = fs.readFileSync(tempFile);

      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="audio.${format}"\r\n` +
            `Content-Type: audio/${format}\r\n\r\n`
        ),
        fileContent,
        Buffer.from(
          `\r\n--${boundary}\r\n` +
            `Content-Disposition: form-data; name="model"\r\n\r\n` +
            `whisper-1\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="language"\r\n\r\n` +
            `en\r\n` +
            `--${boundary}--\r\n`
        ),
      ]);

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Whisper API error: ${response.status} — ${errorText}`);
      }

      const result = (await response.json()) as { text: string };
      const transcript = result.text?.trim() || '';

      log.info(`Transcribed: "${transcript.substring(0, 100)}..."`, {
        chars: transcript.length,
      });

      eventBus.emitEvent('voice:transcript', transcript);
      return transcript;
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /** Check if STT is available and configured */
  isAvailable(): boolean {
    if (this.engine === 'none') return false;
    if (this.engine === 'whisper_api') return !!getConfig().openaiApiKey;
    return false;
  }
}

/** Singleton instance */
let _stt: SpeechToText | null = null;

export function getStt(): SpeechToText {
  if (!_stt) {
    _stt = new SpeechToText();
  }
  return _stt;
}
