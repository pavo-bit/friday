// ============================================================
// FRIDAY — Voice State Manager
// Enforces strict finite-state machine transitions for voice
// ============================================================

import { VoiceState, voiceEvents } from './voiceEvents';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('VoiceState');

export interface StateTransitionRecord {
  from: VoiceState;
  to: VoiceState;
  reason?: string;
  timestamp: number;
}

/**
 * Valid transitions mapping for the 11-state voice FSM.
 */
const VALID_TRANSITIONS: Record<VoiceState, ReadonlySet<VoiceState>> = {
  DISABLED: new Set(['STARTING']),
  STARTING: new Set(['STANDBY', 'ERROR', 'DISABLED']),
  STANDBY: new Set(['WAKE_DETECTED', 'SLEEPING', 'MUTED', 'STOPPING', 'ERROR']),
  WAKE_DETECTED: new Set(['LISTENING', 'PROCESSING', 'STANDBY', 'ERROR']),
  LISTENING: new Set(['PROCESSING', 'STANDBY', 'MUTED', 'STOPPING', 'ERROR']),
  PROCESSING: new Set(['SPEAKING', 'LISTENING', 'STANDBY', 'ERROR']),
  SPEAKING: new Set(['STANDBY', 'LISTENING', 'MUTED', 'STOPPING', 'ERROR']),
  SLEEPING: new Set(['STANDBY', 'MUTED', 'STOPPING', 'ERROR']),
  MUTED: new Set(['STANDBY', 'SLEEPING', 'STOPPING', 'ERROR']),
  ERROR: new Set(['STARTING', 'STOPPING', 'DISABLED', 'STANDBY']),
  STOPPING: new Set(['DISABLED']),
};

export class VoiceStateManager {
  private currentState: VoiceState = 'DISABLED';
  private history: StateTransitionRecord[] = [];
  private readonly maxHistory = 100;

  constructor(initialState: VoiceState = 'DISABLED') {
    this.currentState = initialState;
  }

  getState(): VoiceState {
    return this.currentState;
  }

  canTransitionTo(nextState: VoiceState): boolean {
    if (this.currentState === nextState) return false;
    const allowed = VALID_TRANSITIONS[this.currentState];
    return allowed ? allowed.has(nextState) : false;
  }

  transitionTo(nextState: VoiceState, reason?: string): boolean {
    if (this.currentState === nextState) {
      log.debug(`Ignoring redundant voice state transition: ${nextState}`);
      return true;
    }

    if (!this.canTransitionTo(nextState)) {
      const msg = `Invalid voice state transition: ${this.currentState} -> ${nextState} (reason: ${reason || 'unspecified'})`;
      log.warn(msg);
      throw new Error(msg);
    }

    const from = this.currentState;
    this.currentState = nextState;
    const record: StateTransitionRecord = {
      from,
      to: nextState,
      reason,
      timestamp: Date.now(),
    };

    this.history.push(record);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    log.info(`Voice state: ${from} -> ${nextState}`, { reason });
    voiceEvents.emitEvent('voice:state_change', record);
    return true;
  }

  getHistory(): readonly StateTransitionRecord[] {
    return [...this.history];
  }

  reset(state: VoiceState = 'DISABLED'): void {
    const from = this.currentState;
    this.currentState = state;
    this.history.push({
      from,
      to: state,
      reason: 'reset',
      timestamp: Date.now(),
    });
  }
}

let _voiceStateManager: VoiceStateManager | null = null;

export function getVoiceStateManager(): VoiceStateManager {
  if (!_voiceStateManager) {
    _voiceStateManager = new VoiceStateManager();
  }
  return _voiceStateManager;
}
