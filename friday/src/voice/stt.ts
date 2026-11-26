// ============================================================
// FRIDAY — Browser-native speech input
// Microphone transcription is handled by the dashboard Web Speech API.
// This server class remains as a safe compatibility boundary for audio routes.
// ============================================================

import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('STT');

export class SpeechToText {
  constructor() {
    log.info('STT engine: browser');
  }

  async transcribe(_audioBuffer: Buffer, _format = 'webm'): Promise<string> {
    log.warn('Server-side STT is disabled; use browser microphone transcription.');
    return '';
  }

  isAvailable(): boolean {
    return false;
  }
}

let _stt: SpeechToText | null = null;

export function getStt(): SpeechToText {
  if (!_stt) _stt = new SpeechToText();
  return _stt;
}
