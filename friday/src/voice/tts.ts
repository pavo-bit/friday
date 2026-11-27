// ============================================================
// FRIDAY — Text-to-Speech Compatibility Wrapper
// Delegates to native SpeechSynthesisEngine
// ============================================================

import { getSpeechSynthesisEngine } from './speechSynthesis';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('TTS');

export class TextToSpeech {
  isAvailable(): boolean {
    return true;
  }

  async synthesize(text: string): Promise<Buffer | null> {
    const engine = getSpeechSynthesisEngine();
    engine.speak(text);
    return null;
  }

  stop(): void {
    getSpeechSynthesisEngine().interrupt();
  }
}

let _tts: TextToSpeech | null = null;

export function getTts(): TextToSpeech {
  if (!_tts) _tts = new TextToSpeech();
  return _tts;
}
