// ============================================================
// FRIDAY — Speech-to-Text Compatibility Wrapper
// Delegates to native SpeechRecognitionEngine
// ============================================================

import { getSpeechRecognitionEngine } from './speechRecognition';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('STT');

export class SpeechToText {
  async transcribe(audioBuffer: Buffer, _format = 'webm'): Promise<string> {
    const engine = getSpeechRecognitionEngine();
    const result = await engine.transcribe(audioBuffer);
    return result.text;
  }

  isAvailable(): boolean {
    return getSpeechRecognitionEngine().isReady();
  }
}

let _stt: SpeechToText | null = null;

export function getStt(): SpeechToText {
  if (!_stt) _stt = new SpeechToText();
  return _stt;
}
