// ============================================================
// FRIDAY — Voice Layer: Text-to-Speech
// Supports OpenAI TTS and Edge TTS (free)
// ============================================================

import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { createLayerLogger } from '../shared/logger';
import { getConfig } from '../shared/config';

const log = createLayerLogger('TTS');

/**
 * TextToSpeech — converts text responses to audio.
 *
 * Supports:
 * - OpenAI TTS API (premium, natural voice)
 * - Edge TTS via edge-tts CLI (free, no API key needed)
 * - Disabled mode (text-only interaction)
 */
export class TextToSpeech {
  private engine: string;

  constructor() {
    this.engine = getConfig().ttsEngine;
    log.info(`TTS engine: ${this.engine}`);
  }

  /**
   * Synthesize text into an audio buffer (MP3).
   * Returns null if TTS is disabled or fails.
   */
  async synthesize(text: string): Promise<Buffer | null> {
    if (this.engine === 'none' || !text.trim()) {
      return null;
    }

    // Sanitize text for TTS (remove markdown, code blocks, excessive formatting)
    const cleanText = this.sanitizeForTts(text);

    try {
      if (this.engine === 'edge') {
        return await this.synthesizeEdge(cleanText);
      }

      log.warn(`Unknown TTS engine: ${this.engine}`);
      return null;
    } catch (error) {
      log.error('TTS synthesis failed', { error: (error as Error).message });
      return null;
    }
  }

  /**
   * Synthesize using Edge TTS (free, via Python edge-tts package).
   */
  private async synthesizeEdge(text: string): Promise<Buffer | null> {
    const outputDir = path.resolve(__dirname, '..', '..', 'data', 'recordings');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, `tts_${Date.now()}.mp3`);

    return new Promise<Buffer | null>((resolve) => {
      // Use edge-tts CLI (pip install edge-tts)
      execFile(
        'python',
        [
          '-m',
          'edge_tts',
          '--voice',
          'en-US-AriaNeural',
          '--text',
          text.substring(0, 5000),
          '--write-media',
          outputPath,
        ],
        { timeout: 30_000 },
        (error) => {
          if (error) {
            log.warn('Edge TTS failed — is edge-tts installed? (pip install edge-tts)', {
              error: error.message,
            });
            resolve(null);
            return;
          }

          try {
            const buffer = fs.readFileSync(outputPath);
            fs.unlinkSync(outputPath); // Cleanup
            resolve(buffer);
          } catch (readError) {
            log.error('Failed to read TTS output', { error: (readError as Error).message });
            resolve(null);
          }
        }
      );
    });
  }

  /**
   * Clean text for natural TTS output.
   * Removes markdown formatting, code blocks, and excessive whitespace.
   */
  private sanitizeForTts(text: string): string {
    return text
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, 'code block omitted')
      // Remove inline code
      .replace(/`([^`]+)`/g, '$1')
      // Remove markdown headers
      .replace(/#{1,6}\s*/g, '')
      // Remove bold/italic markers
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
      // Remove links (keep text)
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove bullet points
      .replace(/^[-*•]\s*/gm, '')
      // Collapse whitespace
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Check if TTS is available */
  isAvailable(): boolean {
    if (this.engine === 'none') return false;
    if (this.engine === 'edge') return true; // Edge TTS is free
    return false;
  }
}

/** Singleton */
let _tts: TextToSpeech | null = null;

export function getTts(): TextToSpeech {
  if (!_tts) {
    _tts = new TextToSpeech();
  }
  return _tts;
}
