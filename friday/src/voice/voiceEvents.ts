// ============================================================
// FRIDAY — Voice Events
// Typed events emitted by the native voice subsystem
// ============================================================

import { EventEmitter } from 'events';
import { eventBus } from '../shared/events';
import { WsMessageType } from '../shared/types';

export type VoiceState =
  | 'DISABLED'
  | 'STARTING'
  | 'STANDBY'
  | 'WAKE_DETECTED'
  | 'LISTENING'
  | 'PROCESSING'
  | 'SPEAKING'
  | 'SLEEPING'
  | 'MUTED'
  | 'ERROR'
  | 'STOPPING';

export interface VoiceStateChangeEvent {
  from: VoiceState;
  to: VoiceState;
  reason?: string;
  timestamp: number;
}

export interface VoiceWakeDetectedEvent {
  phrase: string;
  confidence: number;
  extractedCommand?: string;
  timestamp: number;
}

export interface VoiceSessionEvent {
  sessionId: string;
  timestamp: number;
}

export interface VoiceTranscriptEvent {
  sessionId: string;
  text: string;
  isFinal: boolean;
  confidence?: number;
  durationMs?: number;
}

export interface VoiceSpeakingEvent {
  sessionId?: string;
  text: string;
  interrupted?: boolean;
}

export interface VoiceErrorEvent {
  state: VoiceState;
  error: string;
  recoverable: boolean;
  timestamp: number;
}

export interface VoiceEventMap {
  'voice:state_change': (event: VoiceStateChangeEvent) => void;
  'voice:wake_detected': (event: VoiceWakeDetectedEvent) => void;
  'voice:session_start': (event: VoiceSessionEvent) => void;
  'voice:listening_start': (event: { sessionId: string; timeoutMs: number }) => void;
  'voice:transcript': (event: VoiceTranscriptEvent) => void;
  'voice:processing': (event: { sessionId: string; text: string }) => void;
  'voice:speaking_start': (event: VoiceSpeakingEvent) => void;
  'voice:speaking_end': (event: VoiceSpeakingEvent) => void;
  'voice:error': (event: VoiceErrorEvent) => void;
}

class VoiceEventEmitter extends EventEmitter {
  emitEvent<K extends keyof VoiceEventMap>(
    event: K,
    ...args: Parameters<VoiceEventMap[K]>
  ): boolean {
    const payload = args[0];
    const timestamp = new Date().toISOString();

    if (event === 'voice:state_change') {
      eventBus.emitEvent('ws:broadcast', {
        type: WsMessageType.VOICE_STATE,
        payload,
        timestamp,
      });
    } else if (event === 'voice:wake_detected') {
      eventBus.emitEvent('ws:broadcast', {
        type: WsMessageType.VOICE_WAKE,
        payload,
        timestamp,
      });
    } else if (event === 'voice:transcript') {
      eventBus.emitEvent('ws:broadcast', {
        type: WsMessageType.VOICE_TRANSCRIPT,
        payload,
        timestamp,
      });
    }

    return this.emit(event, ...args);
  }

  onEvent<K extends keyof VoiceEventMap>(
    event: K,
    listener: VoiceEventMap[K]
  ): this {
    return this.on(event, listener as (...args: unknown[]) => void);
  }
}

export const voiceEvents = new VoiceEventEmitter();
