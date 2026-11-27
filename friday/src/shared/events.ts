// ============================================================
// FRIDAY — Event Bus
// Typed pub/sub system for inter-layer communication
// ============================================================

import { EventEmitter } from 'events';
import {
  Intent,
  TaskResult,
  ApprovalRequest,
  WsMessage,
  WsMessageType,
} from './types';
import { createLayerLogger } from './logger';

const log = createLayerLogger('EventBus');

export interface TaskLifecycleEventPayload {
  taskId: string;
  conversationId?: string;
  stepId?: string;
  status: string;
  progress: number;
  timestamp: string;
  summary: string;
}

/** All events that flow through the FRIDAY system */
export interface FridayEvents {
  // Voice Layer events
  'voice:transcript': (text: string) => void;
  'voice:listening': (active: boolean) => void;
  'voice:error': (error: Error) => void;

  // Intelligence Layer events
  'intent:parsed': (intent: Intent) => void;
  'intent:error': (error: Error, rawInput: string) => void;

  // Orchestration events
  'task:started': (intent: Intent) => void;
  'task:progress': (intentId: string, message: string) => void;
  'task:completed': (result: TaskResult) => void;
  'task:failed': (result: TaskResult) => void;
  'task.created': (payload: TaskLifecycleEventPayload) => void;
  'task.queued': (payload: TaskLifecycleEventPayload) => void;
  'task.started': (payload: TaskLifecycleEventPayload) => void;
  'task.progress': (payload: TaskLifecycleEventPayload) => void;
  'task.step.started': (payload: TaskLifecycleEventPayload) => void;
  'task.step.completed': (payload: TaskLifecycleEventPayload) => void;
  'task.step.failed': (payload: TaskLifecycleEventPayload) => void;
  'task.waiting_approval': (payload: TaskLifecycleEventPayload) => void;
  'task.cancelled': (payload: TaskLifecycleEventPayload) => void;
  'task.completed': (payload: TaskLifecycleEventPayload) => void;
  'task.failed': (payload: TaskLifecycleEventPayload) => void;
  'task.timed_out': (payload: TaskLifecycleEventPayload) => void;
  'task.interrupted': (payload: TaskLifecycleEventPayload) => void;
  'task.verification.started': (payload: TaskLifecycleEventPayload) => void;
  'task.verification.completed': (payload: TaskLifecycleEventPayload) => void;
  'task.verification.failed': (payload: TaskLifecycleEventPayload) => void;

  // Presentation events
  'presentation.created': (payload: Record<string, unknown>) => void;
  'presentation.updated': (payload: Record<string, unknown>) => void;
  'presentation.ready': (payload: Record<string, unknown>) => void;
  'presentation.failed': (payload: Record<string, unknown>) => void;

  // Safety events
  'safety:approval_needed': (request: ApprovalRequest) => void;
  'safety:approved': (requestId: string) => void;
  'safety:denied': (requestId: string) => void;
  'safety:rate_limited': (action: string) => void;

  // Memory events
  'memory:stored': (key: string, type: string) => void;
  'memory:retrieved': (key: string, results: number) => void;

  // WebSocket broadcast events
  'ws:broadcast': (message: WsMessage) => void;

  // System events
  'system:ready': () => void;
  'system:shutdown': () => void;
  'system:error': (error: Error) => void;
}

/**
 * Type-safe event bus for FRIDAY.
 * 
 * All inter-layer communication flows through this bus,
 * keeping layers decoupled and independently testable.
 */
class FridayEventBus extends EventEmitter {
  private eventCounts: Map<string, number> = new Map();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /** Emit a typed event with full logging */
  emitEvent<K extends keyof FridayEvents>(
    event: K,
    ...args: Parameters<FridayEvents[K]>
  ): boolean {
    const count = (this.eventCounts.get(event) || 0) + 1;
    this.eventCounts.set(event, count);

    log.debug(`Event: ${event} (#${count})`, { event });
    return this.emit(event, ...args);
  }

  /** Listen for a typed event */
  onEvent<K extends keyof FridayEvents>(
    event: K,
    listener: FridayEvents[K]
  ): this {
    return this.on(event, listener as (...args: unknown[]) => void);
  }

  /** Listen for a typed event once */
  onceEvent<K extends keyof FridayEvents>(
    event: K,
    listener: FridayEvents[K]
  ): this {
    return this.once(event, listener as (...args: unknown[]) => void);
  }

  /** Get event statistics */
  getStats(): Record<string, number> {
    return Object.fromEntries(this.eventCounts);
  }
}

/** Singleton event bus instance */
export const eventBus = new FridayEventBus();
